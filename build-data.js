'use strict';
/**
 * build-data.js - turns the raw GTFS text files into ONE compact JSON file the app loads.
 *
 * USAGE
 *   Normally you don't run this directly: `npm run update-data` downloads the zip, unzips it and calls this file.
 *   Manual use: put the unzipped GTFS .txt files in a folder (default ./gtfs) and run:  node build-data.js [folder]
 *   Either way it writes public/data.json
 *
 * WHAT THE GTFS FILES ARE (all are CSV files with a header row)
 *   routes.txt      one row per bus route (e.g. route "101")
 *   trips.txt       one row per scheduled trip; links a trip to its route and its shape
 *   shapes.txt      the drawn path of a route: many lat/lon points per shape_id
 *   stops.txt       one row per bus stop with its coordinates
 *   stop_times.txt  for every trip: which stops it visits, in order, and at what time
 *
 * WHAT WE PRODUCE (public/data.json)
 *   routes    : { "101": { routeId, variants: [{ shapeId, directionId, headsign }] } }
 *   shapes    : { shapeId: [[lat, lon], ...] }                       (kept as bare arrays to stay small)
 *   patterns  : { shapeId: { routeName, directionId, headsign,
 *                            stops: [{ stopId, distanceAlongRouteMeters, scheduledOffsetSeconds }],
 *                            schedule: { profiles: [[offsetSeconds per stop, -1 = trip skips it], ...],
 *                                        trips: [[serviceIdIndex, startSeconds, profileIndex], ...] } } }
 *   services  : { serviceId: { days: [mon..sun as 0/1], startDate, endDate } }    (from calendar.txt)
 *   serviceExceptions : { serviceId: { added: [yyyymmdd...], removed: [yyyymmdd...] } }   (from calendar_dates.txt, if the zip has it: public holidays etc.)
 *   serviceIds: [serviceId, ...]    (trips refer to a service by its index in this list, to keep the file small)
 *   stops     : [{ stopId, stopCode, stopName, lat, lon, routeNames: [...] }]
 *   trips     : { tripId: { routeName, headsign, directionId, shapeId } }
 *   routeIdToName : { "30000001": "101", ... }
 *
 * A "pattern" is the ordered list of stops for one direction of one route. We pick one representative
 * trip per shape and use it as the template, which is what lets the server say "37 stops left" and estimate ETAs.
 */
const fs = require('fs');
const path = require('path');
const { buildPolyline, projectOntoPolylineForward } = require('./public/lib/geo');

const GTFS_FOLDER = process.argv[2] || path.join(__dirname, 'gtfs');
if (!fs.existsSync(GTFS_FOLDER)) {
  console.error(`Folder not found: ${GTFS_FOLDER}\nEasiest fix: run  npm run update-data  (it downloads and unzips the timetable for you).`);
  process.exit(1);
}

// ---------- tiny CSV reader ----------

/** Splits one CSV line into cells. Handles "quoted, cells" and "" (an escaped quote). */
function parseCsvLine(line) {
  const cells = [];
  let currentCell = '';
  let insideQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (insideQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { currentCell += '"'; i++; } // "" inside quotes = a literal quote
        else insideQuotes = false;
      } else currentCell += char;
    } else if (char === '"') insideQuotes = true;
    else if (char === ',') { cells.push(currentCell); currentCell = ''; }
    else currentCell += char;
  }
  cells.push(currentCell);
  return cells;
}

/** Reads a GTFS .txt file and returns an array of objects keyed by the header names. */
function readCsvFile(fileName) {
  const text = fs.readFileSync(path.join(GTFS_FOLDER, fileName), 'utf8').replace(/^\uFEFF/, ''); // strip BOM if present
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, i) => (row[header] = cells[i]));
    return row;
  });
}

const routeRows = readCsvFile('routes.txt');
const tripRows = readCsvFile('trips.txt');
const shapePointRows = readCsvFile('shapes.txt');
const stopRows = readCsvFile('stops.txt');
const stopTimeRows = readCsvFile('stop_times.txt');
const calendarRows = readCsvFile('calendar.txt');
// calendar_dates.txt is optional in GTFS: it lists exceptions such as public holidays (date added or removed for a service).
const calendarDateRows = fs.existsSync(path.join(GTFS_FOLDER, 'calendar_dates.txt')) ? readCsvFile('calendar_dates.txt') : [];

// routeId ("30000001") -> short name ("101")
const routeIdToName = {};
routeRows.forEach((route) => (routeIdToName[route.route_id] = route.route_short_name));

// ---------- 1. shapes: ordered lat/lon points per shape ----------
const rawShapePoints = {}; // shapeId -> [[sequenceNumber, lat, lon], ...]
for (const row of shapePointRows) {
  (rawShapePoints[row.shape_id] ||= []).push([+row.shape_pt_sequence, +row.shape_pt_lat, +row.shape_pt_lon]);
}
const shapes = {}; // shapeId -> [[lat, lon], ...] in travel order
for (const [shapeId, points] of Object.entries(rawShapePoints)) {
  points.sort((a, b) => a[0] - b[0]); // order by shape_pt_sequence
  const cleaned = [];
  for (const [, lat, lon] of points) {
    const rounded = [+lat.toFixed(5), +lon.toFixed(5)]; // 5 decimals = ~1 m, plenty, and smaller files
    const previous = cleaned[cleaned.length - 1];
    if (!previous || previous[0] !== rounded[0] || previous[1] !== rounded[1]) cleaned.push(rounded); // skip duplicate points
  }
  shapes[shapeId] = cleaned;
}

// ---------- 2. routes: which shapes (directions/variants) each route has ----------
const routes = {};
const alreadyAdded = new Set();
for (const trip of tripRows) {
  const routeName = routeIdToName[trip.route_id];
  if (!routeName || !shapes[trip.shape_id]) continue;
  const uniqueKey = routeName + '|' + trip.shape_id;
  if (alreadyAdded.has(uniqueKey)) continue; // many trips share one shape - list it once
  alreadyAdded.add(uniqueKey);
  (routes[routeName] ||= { routeId: trip.route_id, variants: [] }).variants.push({
    shapeId: trip.shape_id,
    directionId: +trip.direction_id,
    headsign: trip.trip_headsign,
  });
}
// Several shape ids can draw the identical line; keep one per route so the map isn't drawn twice.
for (const route of Object.values(routes)) {
  const seenGeometry = new Set();
  route.variants = route.variants.filter((variant) => {
    const points = shapes[variant.shapeId];
    const geometryKey = [variant.directionId, points.length, points[0], points[points.length - 1]].join('|');
    if (seenGeometry.has(geometryKey)) return false;
    seenGeometry.add(geometryKey);
    return true;
  });
}

// ---------- 3. stops, and which routes serve each ----------
const tripIdToRouteId = {};
tripRows.forEach((trip) => (tripIdToRouteId[trip.trip_id] = trip.route_id));
const routeNamesByStopId = {}; // stopId -> Set of route names
for (const stopTime of stopTimeRows) {
  const routeName = routeIdToName[tripIdToRouteId[stopTime.trip_id]];
  if (routeName) (routeNamesByStopId[stopTime.stop_id] ||= new Set()).add(routeName);
}
const stops = stopRows.map((stop) => ({
  stopId: stop.stop_id,
  stopCode: stop.stop_code,
  stopName: stop.stop_name,
  lat: +(+stop.stop_lat).toFixed(5),
  lon: +(+stop.stop_lon).toFixed(5),
  routeNames: [...(routeNamesByStopId[stop.stop_id] || [])].sort(),
}));

// ---------- 4. trips lookup (lets the server resolve a trip id from the realtime feed) ----------
const trips = {};
tripRows.forEach((trip) => {
  trips[trip.trip_id] = {
    routeName: routeIdToName[trip.route_id],
    headsign: trip.trip_headsign,
    directionId: +trip.direction_id,
    shapeId: trip.shape_id,
  };
});

// ---------- 5. patterns: ordered stops per shape, with distance along the route and scheduled time ----------
/** "HH:MM:SS" -> seconds (GTFS allows hours >= 24 for trips running past midnight). */
function timeToSeconds(timeText) {
  const [hours, minutes, seconds] = timeText.split(':').map(Number);
  return hours * 3600 + minutes * 60 + (seconds || 0);
}

const stopTimesByTripId = {};
for (const stopTime of stopTimeRows) (stopTimesByTripId[stopTime.trip_id] ||= []).push(stopTime);

// For each shape, use the trip that visits the MOST stops as the template (avoids short/partial trips).
const templateTripByShapeId = {};
for (const trip of tripRows) {
  const stopCount = (stopTimesByTripId[trip.trip_id] || []).length;
  const current = templateTripByShapeId[trip.shape_id];
  if (stopCount && (!current || stopCount > current.stopCount)) templateTripByShapeId[trip.shape_id] = { stopCount, trip };
}

const stopLocationById = {};
stopRows.forEach((stop) => (stopLocationById[stop.stop_id] = [+stop.stop_lat, +stop.stop_lon]));

const patterns = {};
let stopsFarFromShape = 0, totalStopsPlaced = 0; // quality check printed at the end
for (const [shapeId, { trip }] of Object.entries(templateTripByShapeId)) {
  if (!shapes[shapeId] || shapes[shapeId].length < 2) continue;
  const polyline = buildPolyline(shapes[shapeId]);
  const stopTimesInOrder = stopTimesByTripId[trip.trip_id].slice().sort((a, b) => +a.stop_sequence - +b.stop_sequence);
  const firstStopTimeSeconds = timeToSeconds(stopTimesInOrder[0].arrival_time || stopTimesInOrder[0].departure_time);

  let minSegmentIndex = 0; // each stop must come at/after the previous one along the line
  let previousDistance = 0;
  const patternStops = [];
  for (const stopTime of stopTimesInOrder) {
    const location = stopLocationById[stopTime.stop_id];
    if (!location) continue;
    const projection = projectOntoPolylineForward(polyline, location[0], location[1], minSegmentIndex);
    minSegmentIndex = projection.segmentIndex;
    const distanceAlongRouteMeters = Math.max(previousDistance, Math.round(projection.distanceAlongMeters)); // never go backwards
    previousDistance = distanceAlongRouteMeters;
    totalStopsPlaced++;
    if (projection.offsetFromLineMeters > 80) stopsFarFromShape++;
    patternStops.push({
      stopId: stopTime.stop_id,
      distanceAlongRouteMeters,
      // seconds after the trip's first stop - used later to estimate travel time between any two stops
      scheduledOffsetSeconds: timeToSeconds(stopTime.arrival_time || stopTime.departure_time) - firstStopTimeSeconds,
    });
  }
  patterns[shapeId] = { routeName: routeIdToName[trip.route_id], directionId: +trip.direction_id, headsign: trip.trip_headsign, stops: patternStops };
}
console.log(`patterns: ${Object.keys(patterns).length}, stops >80 m from their route line: ${stopsFarFromShape}/${totalStopsPlaced}`);

// ---- 6. schedules: every trip's start time and exact time at each stop ----
// Which days each service runs on (calendar.txt: columns monday..sunday, start_date, end_date).
const services = {};
const serviceIds = calendarRows.map((row) => row.service_id);
const serviceExceptions = {};
calendarRows.forEach((row) => {
  services[row.service_id] = {
    days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => +row[day]),
    startDate: +row.start_date, // e.g. 20261107
    endDate: +row.end_date,
  };
});

// Exceptions: exception_type 1 = service runs on that date (added), 2 = service does NOT run that date (removed).
for (const row of calendarDateRows) {
  if (!services[row.service_id]) { // a service that exists only as "added dates" (no weekly pattern)
    services[row.service_id] = { days: [0, 0, 0, 0, 0, 0, 0], startDate: 0, endDate: 0 };
    serviceIds.push(row.service_id);
  }
  const entry = (serviceExceptions[row.service_id] ||= { added: [], removed: [] });
  (row.exception_type === '2' ? entry.removed : entry.added).push(+row.date);
}
console.log(`calendar exceptions: ${calendarDateRows.length} rows for ${Object.keys(serviceExceptions).length} services${calendarDateRows.length ? '' : ' (no calendar_dates.txt in this timetable)'}`);

/**
 * Lines a trip's stop times up with the pattern's stop list.
 * Returns { startSeconds, offsets } where offsets[i] = seconds after the trip's first stop at pattern stop i
 * (or -1 if this trip doesn't stop there), or null if the trip's stops don't fit the pattern.
 */
function alignTripToPattern(stopTimesInOrder, patternStops) {
  const offsets = new Array(patternStops.length).fill(-1);
  const startSeconds = timeToSeconds(stopTimesInOrder[0].arrival_time || stopTimesInOrder[0].departure_time);
  let searchFrom = 0;
  for (const stopTime of stopTimesInOrder) {
    let index = -1;
    for (let i = searchFrom; i < patternStops.length; i++) if (patternStops[i].stopId === stopTime.stop_id) { index = i; break; }
    if (index === -1) return null;
    offsets[index] = timeToSeconds(stopTime.arrival_time || stopTime.departure_time) - startSeconds;
    searchFrom = index + 1;
  }
  return { startSeconds, offsets };
}

const scheduleBuilders = {}; // shapeId -> { profiles, profileIndexByKey, trips }
let tripsAligned = 0, tripsMisaligned = 0;
for (const trip of tripRows) {
  const pattern = patterns[trip.shape_id];
  const stopTimes = stopTimesByTripId[trip.trip_id];
  if (!pattern || !stopTimes || !stopTimes.length || !services[trip.service_id]) continue;
  const aligned = alignTripToPattern(stopTimes.slice().sort((a, b) => +a.stop_sequence - +b.stop_sequence), pattern.stops);
  if (!aligned) { tripsMisaligned++; continue; }
  tripsAligned++;
  const builder = (scheduleBuilders[trip.shape_id] ||= { profiles: [], profileIndexByKey: new Map(), trips: [] });
  const key = aligned.offsets.join(',');
  if (!builder.profileIndexByKey.has(key)) { builder.profileIndexByKey.set(key, builder.profiles.length); builder.profiles.push(aligned.offsets); }
  builder.trips.push([serviceIds.indexOf(trip.service_id), aligned.startSeconds, builder.profileIndexByKey.get(key)]);
}
let totalProfiles = 0;
for (const [shapeId, builder] of Object.entries(scheduleBuilders)) {
  builder.trips.sort((a, b) => a[1] - b[1]); // by start time
  patterns[shapeId].schedule = { profiles: builder.profiles, trips: builder.trips };
  totalProfiles += builder.profiles.length;
}
console.log(`schedules: ${tripsAligned} trips aligned (${tripsMisaligned} skipped), ${totalProfiles} distinct timing profiles`);

// Only ship the shapes that something uses (drawn variants + patterns).
const shapesToShip = {};
for (const route of Object.values(routes)) route.variants.forEach((v) => (shapesToShip[v.shapeId] = shapes[v.shapeId]));
for (const shapeId of Object.keys(patterns)) shapesToShip[shapeId] = shapes[shapeId];

// ---------- write the output ----------
const output = { routes, shapes: shapesToShip, patterns, stops, trips, routeIdToName, services, serviceIds, serviceExceptions };
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'public', 'data.json'), JSON.stringify(output));
console.log(`routes: ${Object.keys(routes).length}, stops: ${stops.length}, trips: ${tripRows.length}`);
