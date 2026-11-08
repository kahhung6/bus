'use strict';
/**
 * update-data.js - one command to refresh the timetable:   npm run update-data
 *
 * It does what you used to do by hand:
 *   1. downloads the Rapid Penang GTFS zip from data.gov.my
 *   2. unzips it into a temporary folder (no wget / tar / unzip needed - Node reads the zip itself)
 *   3. runs build-data.js to produce public/data.json
 *   4. deletes the temporary files
 *
 * Usage:
 *   node update-data.js                    download the latest timetable
 *   node update-data.js path/to/file.zip   use a zip you already downloaded
 * Optional environment variables: GTFS_URL (one address) or GTFS_URLS (comma-separated list, tried in order) - e.g. for testing
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// Where to download from, in order. The public storage bucket behind the API is tried first: another project reads its timetables
// from there and notes it does not use up data.gov.my's 4-requests-a-minute allowance (I could not verify that from here).
// If it fails for any reason we fall back to the official API address.
const DEFAULT_DOWNLOAD_URLS = [
  'https://openapi-malaysia-transport.s3.ap-southeast-1.amazonaws.com/prasarana/gtfs_rapid_bus_penang.zip',
  'https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-penang',
];
// GTFS_URLS="url1,url2" overrides the list (handy for testing).
const DOWNLOAD_URLS = process.env.GTFS_URLS ? process.env.GTFS_URLS.split(',') : process.env.GTFS_URL ? [process.env.GTFS_URL] : DEFAULT_DOWNLOAD_URLS;
const REQUIRED_FILES = ['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt'];

// ---------- 1. download ----------
/** Downloads one address and checks it really is a zip file (they start with the letters "PK"). */
async function downloadOne(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'penang-bus-map/1.0' } });
  if (response.status === 429) throw new Error('rate limit reached (429)');
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('the answer is not a zip file');
  return bytes;
}

/** Tries each address in turn and returns the first zip that downloads properly. */
async function downloadZip(urls) {
  const problems = [];
  for (const url of urls) {
    console.log('Downloading timetable from ' + new URL(url).host + ' ...');
    try {
      const bytes = await downloadOne(url);
      console.log(`Downloaded ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
      return bytes;
    } catch (error) {
      console.log(`  failed (${error.message})` + (url === urls[urls.length - 1] ? '' : ', trying the next address'));
      problems.push(`${new URL(url).host}: ${error.message}`);
    }
  }
  throw new Error('Could not download the timetable. ' + problems.join(' | '));
}

// ---------- 2. a small zip reader ----------
// A zip file ends with a "central directory": a table listing every file inside, where it starts,
// and how it is compressed. We read that table, then inflate each file we want. Numbers are little-endian.
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

function listZipEntries(zipBytes) {
  // The "end of central directory" record is within the last ~64 KB of the file; search backwards for it.
  let endRecordOffset = -1;
  for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 22 - 65535); i--) {
    if (zipBytes.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) { endRecordOffset = i; break; }
  }
  if (endRecordOffset === -1) throw new Error('This is not a valid zip file (is the download an error page instead?)');

  const entryCount = zipBytes.readUInt16LE(endRecordOffset + 10);
  let cursor = zipBytes.readUInt32LE(endRecordOffset + 16); // where the central directory starts
  const entries = [];
  for (let n = 0; n < entryCount; n++) {
    if (zipBytes.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) throw new Error('Corrupt zip file');
    const compressionMethod = zipBytes.readUInt16LE(cursor + 10); // 0 = stored, 8 = deflate
    const compressedSize = zipBytes.readUInt32LE(cursor + 20);
    const fileNameLength = zipBytes.readUInt16LE(cursor + 28);
    const extraFieldLength = zipBytes.readUInt16LE(cursor + 30);
    const commentLength = zipBytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBytes.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) throw new Error('Zip64 archives are not supported');
    entries.push({ name: zipBytes.toString('utf8', cursor + 46, cursor + 46 + fileNameLength), compressionMethod, compressedSize, localHeaderOffset });
    cursor += 46 + fileNameLength + extraFieldLength + commentLength; // jump to the next entry
  }
  return entries;
}

function extractZipEntry(zipBytes, entry) {
  const offset = entry.localHeaderOffset;
  if (zipBytes.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE) throw new Error('Corrupt zip file');
  // The file's data starts after its local header (30 bytes + file name + extra field).
  const dataStart = offset + 30 + zipBytes.readUInt16LE(offset + 26) + zipBytes.readUInt16LE(offset + 28);
  const compressed = zipBytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed;                      // stored as-is
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed); // deflate
  throw new Error('Unsupported zip compression method ' + entry.compressionMethod);
}

/** Writes every .txt file of the zip into `folder` (flat; path.basename also blocks "../" tricks). */
function unzipTextFiles(zipBytes, folder) {
  const written = [];
  for (const entry of listZipEntries(zipBytes)) {
    const fileName = path.basename(entry.name);
    if (!fileName.endsWith('.txt')) continue; // skip folders and anything that isn't a GTFS text file
    fs.writeFileSync(path.join(folder, fileName), extractZipEntry(zipBytes, entry));
    written.push(fileName);
  }
  return written;
}

// ---------- main ----------
async function main() {
  const localZipPath = process.argv[2];
  const zipBytes = localZipPath ? fs.readFileSync(localZipPath) : await downloadZip(DOWNLOAD_URLS);

  const temporaryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'penang-gtfs-'));
  try {
    const files = unzipTextFiles(zipBytes, temporaryFolder);
    console.log('Extracted: ' + files.join(', '));
    const missing = REQUIRED_FILES.filter((name) => !files.includes(name));
    if (missing.length) throw new Error('The zip is missing required file(s): ' + missing.join(', '));

    console.log('Building public/data.json ...');
    execFileSync(process.execPath, [path.join(__dirname, 'build-data.js'), temporaryFolder], { stdio: 'inherit' });
  } finally {
    fs.rmSync(temporaryFolder, { recursive: true, force: true }); // always clean up
  }

  // Tell the user how long this timetable is valid for.
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data.json'), 'utf8'));
  const dates = Object.values(data.services).filter((s) => s.startDate > 0); // ignore services made only of exception dates
  const formatDate = (n) => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
  console.log(`\nDone. Timetable covers ${formatDate(Math.min(...dates.map((s) => s.startDate)))} to ${formatDate(Math.max(...dates.map((s) => s.endDate)))}.`);
  console.log('Restart the server if it is running, or re-upload public/ if you host it as a website.');
}

main().catch((error) => {
  console.error('\nUpdate failed: ' + error.message);
  process.exit(1);
});
