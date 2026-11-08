'use strict';
/**
 * server.js - the optional Node backend. It is a thin layer: all the real logic lives in public/lib/*.js,
 * which the browser can also run by itself (see DEPLOY.md for the no-Node option).
 *
 * Jobs:
 *   1. Serves the web page (everything in ./public).
 *   2. /api/vehicles -> live buses (downloads + caches the realtime feed, 3 calls/minute at most)
 *   3. /api/bus      -> one bus in detail (progress, next stops, ETAs, stops left)
 *   4. /api/journey  -> trip planner (stop A -> stop B on one route direction)
 *   5. /api/geocode  -> street address via Nominatim (queued, cached, 1 request / 1.2 s)
 *   6. /api/plan     -> directions from point A to point B (walking + buses + changes)
 *      /api/search   -> place search via Nominatim (explicit searches only)
 *   7. /api/usage    -> how much internet the server itself has used (data meter)
 *   8. /api/config, /api/debug
 *
 * Run:  node server.js     (Node 18+)
 * Optional environment variables: PORT, NOMINATIM_EMAIL, NOMINATIM_UA, TILE_URL, TILE_ATTRIBUTION
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseFeed } = require('./public/lib/gtfsrt');
const { createCore } = require('./public/lib/core');
const { createFeedClient } = require('./public/lib/feed');
const { createGeocoder } = require('./public/lib/geocoder');
const { createUsageTracker } = require('./public/lib/usage');

const PORT = process.env.PORT || 3000;
const REALTIME_URL = 'https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-penang';
const PUBLIC_FOLDER = path.join(__dirname, 'public');

// Map tiles: OpenStreetMap's own tile server is fine for light personal use (see its tile usage policy).
// To use another provider (e.g. one that needs an API key) set TILE_URL without editing any code.
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = process.env.TILE_ATTRIBUTION || '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// ---------- timetable data + logic ----------
const dataFilePath = path.join(PUBLIC_FOLDER, 'data.json');
if (!fs.existsSync(dataFilePath)) {
  console.error('public/data.json is missing. Put the GTFS .txt files in ./gtfs and run: npm run build-data');
  process.exit(1);
}
const core = createCore(JSON.parse(fs.readFileSync(dataFilePath, 'utf8')));

// ---------- data meter: how much internet the SERVER itself uses (see /api/usage) ----------
const serverUsage = createUsageTracker();

// ---------- live feed (rate-limit friendly: see public/lib/feed.js) ----------
const feedClient = createFeedClient({
  onDownload: (bytes) => serverUsage.record('realtimeFeed', bytes),
  getUrl: () => REALTIME_URL,
  requestInit: { headers: { 'user-agent': 'penang-bus-map/1.0' } },
  parseFeed,
  describeVehicle: core.describeVehicle,
});

// ---------- Nominatim (policy-friendly: see public/lib/geocoder.js) ----------
const geocoder = createGeocoder({
  baseUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse',
  searchUrl: process.env.NOMINATIM_SEARCH_URL || undefined, // defaults to the public Nominatim search endpoint
  headers: { 'user-agent': process.env.NOMINATIM_UA || 'penang-bus-map/1.0 (personal project; set NOMINATIM_EMAIL)' },
  getEmail: () => process.env.NOMINATIM_EMAIL || '',
  onResponseBytes: (bytes) => serverUsage.record('nominatim', bytes),
});

// ---------- HTTP ----------
const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    // ---- how much internet this server has used since it started (feed + addresses) ----
    if (url.pathname === '/api/usage') return sendJson(response, 200, serverUsage.snapshot());

    if (url.pathname === '/api/config') return sendJson(response, 200, { tileUrl: TILE_URL, tileAttribution: TILE_ATTRIBUTION });

    // ---- all buses (used for the list and the map dots) ----
    if (url.pathname === '/api/vehicles') {
      const feed = await feedClient.getLiveFeed();
      return sendJson(response, 200, { fetchedAtMs: feed.fetchedAtMs, feedTimestamp: feed.feedTimestamp, stale: !!feed.stale, staleReason: feed.staleReason || null, vehicles: feed.vehicles });
    }

    // ---- one bus in detail ----
    if (url.pathname === '/api/bus') {
      const feed = await feedClient.getLiveFeed();
      const vehicle = feed.vehicles.find((v) => v.key === url.searchParams.get('key'));
      if (!vehicle) return sendJson(response, 404, { error: 'Bus not in the current feed' });
      return sendJson(response, 200, { feedTimestamp: feed.feedTimestamp, ...core.analyseVehicle(vehicle) });
    }

    // ---- trip planner (stop A -> stop B on one route direction) ----
    if (url.pathname === '/api/journey') {
      // The stop-to-stop numbers come from the timetable, so they still work if the live feed is down.
      let liveVehicles = [], liveFeedError = null;
      try { liveVehicles = (await feedClient.getLiveFeed()).vehicles; } catch (error) { liveFeedError = error.message; }
      const planned = core.planJourney(url.searchParams.get('shapeId'), url.searchParams.get('from'), url.searchParams.get('to'), liveVehicles);
      if (planned.result) planned.result.liveFeedError = liveFeedError;
      return sendJson(response, planned.statusCode, planned.result || { error: planned.error });
    }

    // ---- directions from point A to point B (walk + buses + changes) ----
    if (url.pathname === '/api/plan') {
      const point = (prefix) => ({ lat: parseFloat(url.searchParams.get(prefix + 'Lat')), lon: parseFloat(url.searchParams.get(prefix + 'Lon')), name: url.searchParams.get(prefix + 'Name') || prefix });
      const origin = point('from'), destination = point('to');
      if (![origin.lat, origin.lon, destination.lat, destination.lon].every(isFinite)) return sendJson(response, 400, { error: 'bad coordinates' });
      let liveVehicles = [], liveFeedError = null; // times come from the timetable, so planning still works if the live feed is down
      try { liveVehicles = (await feedClient.getLiveFeed()).vehicles; } catch (error) { liveFeedError = error.message; }
      return sendJson(response, 200, { ...core.planTrip(origin, destination, liveVehicles), liveFeedError });
    }

    // ---- place search (only when the user explicitly asks - never as-you-type, per Nominatim's policy) ----
    if (url.pathname === '/api/search') {
      try {
        return sendJson(response, 200, await geocoder.searchPlaces(url.searchParams.get('q') || ''));
      } catch (error) {
        return sendJson(response, error.statusCode === 429 ? 429 : 502, { error: error.message });
      }
    }

    // ---- address for a coordinate (only the web page's selected bus ever calls this) ----
    if (url.pathname === '/api/geocode') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(response, 400, { error: 'bad lat/lon' });
      try {
        return sendJson(response, 200, await geocoder.reverseGeocode(lat, lon));
      } catch (error) {
        return sendJson(response, error.statusCode === 429 ? 429 : 502, { error: error.message });
      }
    }

    // ---- debugging helper: raw decoded buses and how many matched the timetable ----
    if (url.pathname === '/api/debug') {
      const feed = await feedClient.getLiveFeed();
      const matchCounts = {};
      feed.vehicles.forEach((v) => (matchCounts[v.matchMethod] = (matchCounts[v.matchMethod] || 0) + 1));
      return sendJson(response, 200, { total: feed.vehicles.length, matchCounts, sampleRaw: feed.rawVehicles.slice(0, 5), sampleDescribed: feed.vehicles.slice(0, 5) });
    }

    // ---- static files (index.html, data.json, lib/*.js, icons...) ----
    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(PUBLIC_FOLDER, requestedPath));
    if (!filePath.startsWith(PUBLIC_FOLDER)) { response.writeHead(403); return response.end(); } // block ../ path tricks
    fs.readFile(filePath, (error, contents) => {
      if (error) { response.writeHead(404); return response.end('Not found'); }
      response.writeHead(200, { 'content-type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      response.end(contents);
    });
  } catch (error) {
    sendJson(response, 502, { error: error.message });
  }
}).listen(PORT, () => console.log(`Rapid Penang map: http://localhost:${PORT}`));
