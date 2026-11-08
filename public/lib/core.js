/**
 * core.js - the "brain": everything that turns timetable data + live bus positions into answers.
 * It has NO network or file access, so the same file runs inside the Node server AND directly in the browser.
 *
 *   const core = createCore(gtfsData);
 *   core.describeVehicle(feedVehicle)          -> route, headsign, direction ... for one live bus
 *   core.analyseVehicle(vehicle)               -> progress, next stops, ETAs, stops left, nearest stops
 *   core.planJourney(shapeId, fromId, toId, v) -> stop A to stop B on one route direction + approaching buses
 *   core.planTrip(origin, destination, v)      -> directions from ANY point A to ANY point B (walking, buses, changes)
 *   core.searchStops(text)                     -> bus stops whose name contains the text
 */
(function (root, factory) {
  // Works in both places: Node (require) and the browser (<script> tag -> window.PenangLib.<name>).
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./geo'));
  else { root.PenangLib = root.PenangLib || {}; root.PenangLib.core = factory(root.PenangLib.geo); }
})(typeof self !== 'undefined' ? self : this, function (geo) {
'use strict';
const { haversineMeters, buildPolyline, projectOntoPolyline, angleDifferenceDegrees } = geo;

/** @param {object} GTFS the contents of data.json */
function createCore(GTFS) {

// Quick lookups, built once at startup.
const stopById = new Map(GTFS.stops.map((stop) => [stop.stopId, stop]));

// shapeId -> info about that shape (which route, which direction, where it goes)
const variantByShapeId = {};
for (const [routeName, route] of Object.entries(GTFS.routes)) {
  for (const variant of route.variants) variantByShapeId[variant.shapeId] = { routeName, directionId: variant.directionId, headsign: variant.headsign };
}

// route name -> all of its shapeIds (usually one per direction)
const shapeIdsByRouteName = {};
for (const [shapeId, pattern] of Object.entries(GTFS.patterns)) (shapeIdsByRouteName[pattern.routeName] ||= []).push(shapeId);

// Polylines (lines with running distance totals) are built lazily and cached.
const polylineCache = new Map();
function getPolyline(shapeId) {
  if (!polylineCache.has(shapeId)) polylineCache.set(shapeId, buildPolyline(GTFS.shapes[shapeId]));
  return polylineCache.get(shapeId);
}

// =====================================================================================
// 2. MATCH A REALTIME BUS TO THE TIMETABLE
// =====================================================================================
// data.gov.my notes that realtime trip ids (e.g. "30000001_1000000855_053000_02") only match the
// static ones after a prefix is removed ("weekday_30000001_1000000855_053000_02"). So we also index
// static trip ids by their LAST FOUR underscore-separated parts and compare those.
function lastFourParts(tripId) {
  const parts = tripId.split('_');
  return parts.length >= 4 ? parts.slice(-4).join('_') : null;
}
const tripByLastFourParts = new Map();
for (const [tripId, trip] of Object.entries(GTFS.trips)) {
  const key = lastFourParts(tripId);
  if (key) tripByLastFourParts.set(key, trip);
}

/**
 * Takes one decoded bus from the feed and works out its route, headsign and direction.
 * We try several strategies, most reliable first, and record which one worked in `matchMethod`.
 */
function describeVehicle(feedVehicle) {
  const tripId = feedVehicle.trip && feedVehicle.trip.tripId;
  const feedRouteId = feedVehicle.trip && feedVehicle.trip.routeId;
  let routeName, headsign, directionId, shapeId;
  let matchMethod = 'none';

  if (tripId && GTFS.trips[tripId]) {
    // Strategy 1: the trip id exists exactly in the timetable.
    ({ routeName, headsign, directionId, shapeId } = GTFS.trips[tripId]);
    matchMethod = 'trip_id';
  } else if (tripId && lastFourParts(tripId) && tripByLastFourParts.has(lastFourParts(tripId))) {
    // Strategy 2: matches after removing the service prefix (the workaround from the data.gov.my notes).
    ({ routeName, headsign, directionId, shapeId } = tripByLastFourParts.get(lastFourParts(tripId)));
    matchMethod = 'trip_id_suffix';
  } else if (tripId && tripId.split('_').length >= 4) {
    // Strategy 3: the realtime id itself is shaped like <route_id>_<shape_id>_<start time>_<sequence>.
    const [routeIdPart, shapeIdPart] = tripId.split('_');
    if (GTFS.routeIdToName[routeIdPart]) routeName = GTFS.routeIdToName[routeIdPart];
    if (variantByShapeId[shapeIdPart]) {
      const variant = variantByShapeId[shapeIdPart];
      routeName = routeName || variant.routeName;
      headsign = variant.headsign;
      directionId = variant.directionId;
      shapeId = shapeIdPart;
    }
    if (routeName) matchMethod = 'trip_id_parts';
  }
  if (!routeName && feedRouteId) {
    // Strategy 4: the feed's own route_id field.
    routeName = GTFS.routeIdToName[feedRouteId] || (GTFS.routes[feedRouteId] ? feedRouteId : undefined);
    if (routeName) matchMethod = 'route_id';
  }
  if (directionId == null && feedVehicle.trip && feedVehicle.trip.directionId != null) directionId = feedVehicle.trip.directionId;

  const currentStop = feedVehicle.stopId && stopById.get(feedVehicle.stopId);
  const vehicleInfo = feedVehicle.vehicle || {};
  return {
    // `key` is what the web page uses to say "this bus". Prefer the vehicle id, then plate/label, then trip id.
    key: vehicleInfo.id || vehicleInfo.licensePlate || vehicleInfo.label || tripId || null,
    id: vehicleInfo.id || null,
    plate: vehicleInfo.licensePlate || vehicleInfo.label || null,
    routeName: routeName || null,
    headsign: headsign || null,
    directionId: directionId ?? null,
    shapeId: shapeId || null,
    tripId: tripId || null,
    feedRouteId: feedRouteId || null,
    matchMethod,
    lat: feedVehicle.lat,
    lon: feedVehicle.lon,
    bearingDegrees: feedVehicle.bearingDegrees ?? null,
    // The GTFS-realtime spec says speed is metres/second, but this feed's values (30-50 for moving buses)
    // are already km/h, so we use the number as-is. (Multiplying by 3.6 gave impossible 115-165 km/h.)
    speedKmPerHour: feedVehicle.speedMetersPerSecond != null ? Math.round(feedVehicle.speedMetersPerSecond) : null,
    timestamp: feedVehicle.timestamp || null, // when the bus last reported (unix seconds)
    status: feedVehicle.currentStatus ?? null,
    stopId: feedVehicle.stopId || null,
    stopName: currentStop ? currentStop.stopName : null,
  };
}


// =====================================================================================
// 4. ANALYSE ONE BUS: where is it on its route, what's next, how far to the terminal?
// =====================================================================================
const FALLBACK_SPEED_METERS_PER_SECOND = 20 / 3.6; // 20 km/h, used only if the timetable can't give travel times
const STOP_REACHED_TOLERANCE_METERS = 15; // a stop up to 15 m behind the bus still counts as "arriving now"
const MIN_SPEED_TO_TRUST_HEADING_KMH = 4; // a stationary bus's compass heading is meaningless
const WRONG_DIRECTION_PENALTY_METERS = 400; // added to a candidate route's score if the bus heads the opposite way

/**
 * Decides which shape (route direction) the bus is on.
 *  - If the trip matched the timetable, we already know the shape: confidence "exact".
 *  - Otherwise, take the route's shapes (one per direction) and pick the one the bus is closest to,
 *    penalising a shape whose travel direction is opposite to the bus's heading.
 *  - If we don't even know the route, give up (null).
 */
function chooseShapeForVehicle(vehicle) {
  if (vehicle.shapeId && GTFS.patterns[vehicle.shapeId]) return { shapeId: vehicle.shapeId, confidence: 'exact' };

  let candidateShapeIds = vehicle.routeName ? shapeIdsByRouteName[vehicle.routeName] || [] : [];
  if (!candidateShapeIds.length) return null;

  // If the feed told us the direction, only consider shapes going that way.
  if (vehicle.directionId != null) {
    const sameDirection = candidateShapeIds.filter((id) => GTFS.patterns[id].directionId === vehicle.directionId);
    if (sameDirection.length) candidateShapeIds = sameDirection;
  }

  const canTrustHeading = vehicle.bearingDegrees != null && (vehicle.speedKmPerHour || 0) >= MIN_SPEED_TO_TRUST_HEADING_KMH;
  let best = null;
  for (const shapeId of candidateShapeIds) {
    const projection = projectOntoPolyline(getPolyline(shapeId), vehicle.lat, vehicle.lon);
    const goingWrongWay = canTrustHeading && angleDifferenceDegrees(projection.headingDegrees, vehicle.bearingDegrees) > 90;
    const score = projection.offsetFromLineMeters + (goingWrongWay ? WRONG_DIRECTION_PENALTY_METERS : 0); // lower = better
    if (!best || score < best.score) best = { shapeId, score };
  }
  return { shapeId: best.shapeId, confidence: candidateShapeIds.length === 1 ? 'route' : 'inferred' };
}

/**
 * Estimates the scheduled time (seconds since the trip's first stop) at which a bus standing
 * `distanceAlongMeters` along the route would be. We interpolate between the two surrounding stops.
 */
function scheduledOffsetAtDistance(patternStops, distanceAlongMeters) {
  const first = patternStops[0];
  const last = patternStops[patternStops.length - 1];
  if (distanceAlongMeters <= first.distanceAlongRouteMeters) {
    // Before the first stop: extrapolate backwards at the fallback speed.
    return first.scheduledOffsetSeconds - (first.distanceAlongRouteMeters - distanceAlongMeters) / FALLBACK_SPEED_METERS_PER_SECOND;
  }
  if (distanceAlongMeters >= last.distanceAlongRouteMeters) return last.scheduledOffsetSeconds;

  let i = 0;
  while (i < patternStops.length - 2 && patternStops[i + 1].distanceAlongRouteMeters <= distanceAlongMeters) i++;
  const before = patternStops[i], after = patternStops[i + 1];
  const gapMeters = after.distanceAlongRouteMeters - before.distanceAlongRouteMeters;
  const fractionBetween = gapMeters ? (distanceAlongMeters - before.distanceAlongRouteMeters) / gapMeters : 0;
  return before.scheduledOffsetSeconds + fractionBetween * (after.scheduledOffsetSeconds - before.scheduledOffsetSeconds);
}

function analyseVehicle(vehicle) {
  const nowSeconds = Date.now() / 1000;

  // Part of the answer that needs no route knowledge: the 3 closest stops by straight-line distance.
  const nearestStops = GTFS.stops
    .map((stop) => ({
      stopId: stop.stopId, code: stop.stopCode, name: stop.stopName, lat: stop.lat, lon: stop.lon, routeNames: stop.routeNames,
      distanceMeters: Math.round(haversineMeters(vehicle.lat, vehicle.lon, stop.lat, stop.lon)),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 3);

  const analysis = {
    vehicle: {
      key: vehicle.key, id: vehicle.id, plate: vehicle.plate, routeName: vehicle.routeName, headsign: vehicle.headsign,
      lat: vehicle.lat, lon: vehicle.lon, bearingDegrees: vehicle.bearingDegrees, speedKmPerHour: vehicle.speedKmPerHour,
      timestamp: vehicle.timestamp, ageSeconds: vehicle.timestamp ? Math.round(nowSeconds - vehicle.timestamp) : null,
      status: vehicle.status, tripId: vehicle.tripId, matchMethod: vehicle.matchMethod,
    },
    trip: null, terminal: null, progress: null, position: null, nextStops: [], routeStops: [], shapeId: null, nearestStops,
  };

  const chosen = chooseShapeForVehicle(vehicle);
  if (!chosen) return analysis; // route unknown: we can still show location + nearest stops

  const pattern = GTFS.patterns[chosen.shapeId];
  const patternStops = pattern.stops;
  const projection = projectOntoPolyline(getPolyline(chosen.shapeId), vehicle.lat, vehicle.lon);
  const busDistanceAlong = projection.distanceAlongMeters; // how many metres the bus has travelled along the route

  // ETA to a stop = (scheduled time at that stop) - (scheduled time at the bus's current position).
  const busScheduledOffset = scheduledOffsetAtDistance(patternStops, busDistanceAlong);
  const lastStop = patternStops[patternStops.length - 1];
  const timetableIsUsable = lastStop.scheduledOffsetSeconds - patternStops[0].scheduledOffsetSeconds > 0;
  const estimateSecondsTo = (patternStop) =>
    Math.max(0, Math.round(timetableIsUsable
      ? patternStop.scheduledOffsetSeconds - busScheduledOffset
      : (patternStop.distanceAlongRouteMeters - busDistanceAlong) / FALLBACK_SPEED_METERS_PER_SECOND));

  // Describe every stop on the route relative to the bus.
  const routeStops = patternStops.map((patternStop, index) => {
    const stop = stopById.get(patternStop.stopId);
    const hasPassed = patternStop.distanceAlongRouteMeters < busDistanceAlong - STOP_REACHED_TOLERANCE_METERS;
    return {
      sequence: index + 1,
      stopId: patternStop.stopId,
      code: stop ? stop.stopCode : null,
      name: stop ? stop.stopName : patternStop.stopId,
      lat: stop ? stop.lat : null,
      lon: stop ? stop.lon : null,
      distanceMeters: Math.round(patternStop.distanceAlongRouteMeters - busDistanceAlong), // negative once passed
      etaSeconds: hasPassed ? null : estimateSecondsTo(patternStop),
      hasPassed,
    };
  });

  const upcomingStops = routeStops.filter((stop) => !stop.hasPassed);
  const terminalStop = routeStops[routeStops.length - 1]; // the final stop in the direction the bus is heading

  analysis.shapeId = chosen.shapeId;
  analysis.trip = {
    confidence: chosen.confidence, directionId: pattern.directionId, headsign: pattern.headsign, routeName: pattern.routeName,
    offRouteMeters: Math.round(projection.offsetFromLineMeters), // how far the GPS is from the expected line
    etaBasis: timetableIsUsable ? 'schedule' : 'distance',
  };
  analysis.progress = { stopsPassed: routeStops.length - upcomingStops.length, totalStops: routeStops.length };
  analysis.terminal = {
    name: terminalStop.name, stopId: terminalStop.stopId,
    stopsLeft: upcomingStops.length, // includes the terminal itself
    distanceMeters: terminalStop.distanceMeters,
    etaSeconds: terminalStop.hasPassed ? 0 : terminalStop.etaSeconds,
  };
  analysis.nextStops = upcomingStops.slice(0, 5);

  // Where is the bus in terms of STOP NAMES? The "current stop" is simply the stop it most recently went past,
  // i.e. the stop just BEFORE the next one (the next stops are listed separately).
  const passedStops = routeStops.filter((stop) => stop.hasPassed);
  const currentStop = passedStops.length ? passedStops[passedStops.length - 1] : null; // null = hasn't passed the first stop yet
  const nextStop = upcomingStops.length ? upcomingStops[0] : null;                      // null = it has passed the terminal
  analysis.position = {
    currentStop: currentStop ? { name: currentStop.name, code: currentStop.code, metersPast: -currentStop.distanceMeters } : null,
    nextStop: nextStop ? { name: nextStop.name, code: nextStop.code, metersAhead: Math.max(0, nextStop.distanceMeters) } : null,
  };
  analysis.routeStops = routeStops.map((s) => ({ sequence: s.sequence, name: s.name, lat: s.lat, lon: s.lon, hasPassed: s.hasPassed }));

  const stopIdsOnRoute = new Set(routeStops.map((s) => s.stopId));
  nearestStops.forEach((stop) => (stop.isOnThisRoute = stopIdsOnRoute.has(stop.stopId)));
  return analysis;
}

// =====================================================================================
// 4b. TRIP PLANNER: "how long from stop A to stop B on route X (this direction)?"
// =====================================================================================
const MAX_BUSES_IN_JOURNEY_RESULT = 5;
const MAX_DISTANCE_FROM_ROUTE_FOR_JOURNEY_BUS_METERS = 200; // a bus further than this from the line is on a different variant

/** Returns the part of a route line between two distances-along-the-route, as [[lat, lon], ...]. */
function slicePolylineBetweenDistances(polyline, fromMeters, toMeters) {
  const insidePoints = polyline.points.filter((_, i) => polyline.cumulativeMeters[i] >= fromMeters && polyline.cumulativeMeters[i] <= toMeters);
  return insidePoints.length >= 2 ? insidePoints : [];
}

// ---------- scheduled departures (the timetable: buses that have NOT left yet) ----------
const SECONDS_PER_DAY = 86400;
const MAX_SCHEDULED_DEPARTURES = 8;

/**
 * The current date/time in Malaysia, whatever timezone this computer/phone is set to.
 * Returns { dateNumber: 20261107, dayIndex: 0..6 (Monday = 0), secondsSinceMidnight }.
 */
function getMalaysiaClock(nowMs) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs)).forEach((part) => (parts[part.type] = part.value));
  const year = +parts.year, month = +parts.month, day = +parts.day;
  return {
    year, month, day,
    dateNumber: year * 10000 + month * 100 + day,
    dayIndex: (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7, // JS: Sunday = 0 -> we want Monday = 0
    secondsSinceMidnight: +parts.hour * 3600 + +parts.minute * 60 + +parts.second,
  };
}

/** The same calendar day shifted by whole days (-1 = yesterday, +1 = tomorrow). */
function shiftClockByDays(clock, dayOffset) {
  const shifted = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + dayOffset));
  return {
    dateNumber: shifted.getUTCFullYear() * 10000 + (shifted.getUTCMonth() + 1) * 100 + shifted.getUTCDate(),
    dayIndex: (shifted.getUTCDay() + 6) % 7,
  };
}

/** Does this timetable "service" (a weekday pattern with a start and end date) run on that date? */
function serviceRunsOn(serviceId, dateNumber, dayIndex) {
  const service = GTFS.services && GTFS.services[serviceId];
  if (!service) return false;
  // Exceptions (calendar_dates.txt, e.g. public holidays) beat the weekly pattern: a date can be removed or added for a service.
  const exceptions = GTFS.serviceExceptions && GTFS.serviceExceptions[serviceId];
  if (exceptions && exceptions.removed.includes(dateNumber)) return false;
  if (exceptions && exceptions.added.includes(dateNumber)) return true;
  return dateNumber >= service.startDate && dateNumber <= service.endDate && service.days[dayIndex] === 1;
}

/** First and last date covered by the timetable (services made only of added dates have startDate 0 and are ignored here). */
function getTimetableCoverage() {
  const dated = Object.values(GTFS.services || {}).filter((service) => service.startDate > 0);
  return dated.length ? { from: Math.min(...dated.map((s) => s.startDate)), to: Math.max(...dated.map((s) => s.endDate)) } : null;
}

/** 38400 -> "10:40"   (hours wrap after 24, because GTFS times can go past midnight) */
function formatClock(secondsSinceMidnight) {
  const wrapped = ((Math.round(secondsSinceMidnight) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return String(Math.floor(wrapped / 3600)).padStart(2, '0') + ':' + String(Math.floor((wrapped % 3600) / 60)).padStart(2, '0');
}

/**
 * Lists the next scheduled buses leaving the boarding stop, from the timetable (NOT live positions).
 * Every trip has its own exact times at each stop, so travel times (peak vs off-peak) are accurate.
 * We look at yesterday's service (for trips running past midnight), today's, and tomorrow's.
 */
function listScheduledDepartures(pattern, fromIndex, toIndex, nowMs) {
  const schedule = pattern.schedule;
  if (!schedule) return { available: false };

  const clock = getMalaysiaClock(nowMs);
  const nowSeconds = clock.secondsSinceMidnight; // "today at 00:00" is the zero point for all times below
  const found = [];
  let servicesToday = 0;

  for (const dayOffset of [-1, 0, 1]) {
    const day = dayOffset === 0 ? clock : shiftClockByDays(clock, dayOffset);
    for (const [serviceIndex, startSeconds, profileIndex] of schedule.trips) {
      if (!serviceRunsOn(GTFS.serviceIds[serviceIndex], day.dateNumber, day.dayIndex)) continue;
      if (dayOffset === 0) servicesToday++;
      const offsets = schedule.profiles[profileIndex];
      if (offsets[fromIndex] < 0 || offsets[toIndex] < 0) continue; // this trip doesn't serve one of the two stops
      const departureSeconds = dayOffset * SECONDS_PER_DAY + startSeconds + offsets[fromIndex]; // relative to today 00:00
      if (departureSeconds < nowSeconds) continue; // already left
      found.push({
        dayOffset: dayOffset === 1 ? 1 : 0, // 1 = tomorrow
        departureSeconds,
        arrivalSeconds: dayOffset * SECONDS_PER_DAY + startSeconds + offsets[toIndex],
      });
    }
  }
  found.sort((a, b) => a.departureSeconds - b.departureSeconds);

  const coverage = getTimetableCoverage();
  return {
    available: true,
    nowClock: formatClock(nowSeconds),
    dateNumber: clock.dateNumber,
    timetableCoversToday: !!coverage && clock.dateNumber >= coverage.from && clock.dateNumber <= coverage.to,
    coverage,
    servicesToday: servicesToday > 0,
    departures: found.slice(0, MAX_SCHEDULED_DEPARTURES).map((d) => ({
      isTomorrow: d.departureSeconds >= SECONDS_PER_DAY,
      departureClock: formatClock(d.departureSeconds),
      arrivalClock: formatClock(d.arrivalSeconds),
      minutesFromNow: Math.max(0, Math.round((d.departureSeconds - nowSeconds) / 60)),
      travelSeconds: d.arrivalSeconds - d.departureSeconds,
    })),
  };
}

/**
 * Live buses of one route direction (shapeId) that have NOT yet reached the stop at `fromIndex`, nearest first.
 * For each: how far it is from that stop and the scheduled-running-time estimate to it and to the stop at `toIndex`.
 */
function findApproachingBuses(shapeId, fromIndex, toIndex, liveVehicles) {
  const pattern = GTFS.patterns[shapeId];
  const patternStops = pattern.stops;
  const fromStop = patternStops[fromIndex], toStop = patternStops[toIndex];
  const timetableIsUsable = patternStops[patternStops.length - 1].scheduledOffsetSeconds - patternStops[0].scheduledOffsetSeconds > 0;
  const polyline = getPolyline(shapeId);
  const buses = [];
  for (const vehicle of liveVehicles) {
    if (vehicle.routeName !== pattern.routeName) continue;
    const chosen = chooseShapeForVehicle(vehicle);
    if (!chosen || GTFS.patterns[chosen.shapeId].directionId !== pattern.directionId) continue; // other direction
    const projection = projectOntoPolyline(polyline, vehicle.lat, vehicle.lon);
    if (projection.offsetFromLineMeters > MAX_DISTANCE_FROM_ROUTE_FOR_JOURNEY_BUS_METERS) continue; // not on this line
    if (projection.distanceAlongMeters > fromStop.distanceAlongRouteMeters + STOP_REACHED_TOLERANCE_METERS) continue; // already past boarding

    const busOffset = scheduledOffsetAtDistance(patternStops, projection.distanceAlongMeters);
    const secondsTo = (patternStop) => Math.max(0, Math.round(timetableIsUsable
      ? patternStop.scheduledOffsetSeconds - busOffset
      : (patternStop.distanceAlongRouteMeters - projection.distanceAlongMeters) / FALLBACK_SPEED_METERS_PER_SECOND));
    buses.push({
      key: vehicle.key, plate: vehicle.plate || vehicle.id, lat: vehicle.lat, lon: vehicle.lon, speedKmPerHour: vehicle.speedKmPerHour,
      ageSeconds: vehicle.timestamp ? Math.round(Date.now() / 1000 - vehicle.timestamp) : null,
      distanceToBoardingMeters: Math.max(0, Math.round(fromStop.distanceAlongRouteMeters - projection.distanceAlongMeters)),
      secondsToBoarding: secondsTo(fromStop),
      secondsToDestination: secondsTo(toStop), // when this bus would reach the stop at toIndex
    });
  }
  return buses.sort((x, y) => x.secondsToBoarding - y.secondsToBoarding);
}

/**
 * Works out the journey from one stop to another along ONE direction of a route (identified by shapeId).
 * Returns the stop count, distance, scheduled time, every stop on the way with its cumulative time,
 * and the live buses that are still on their way to the boarding stop.
 */
function planJourney(shapeId, fromStopId, toStopId, liveVehicles, nowMs = Date.now()) {
  const pattern = GTFS.patterns[shapeId];
  if (!pattern) return { statusCode: 404, error: 'Unknown route direction' };
  const patternStops = pattern.stops;

  const fromIndex = patternStops.findIndex((s) => s.stopId === fromStopId);
  if (fromIndex === -1) return { statusCode: 400, error: 'Boarding stop is not on this route direction' };
  // Some loop routes visit the same stop twice, so look for the destination AFTER the boarding stop.
  const toIndex = patternStops.findIndex((s, i) => i > fromIndex && s.stopId === toStopId);
  if (toIndex === -1) return { statusCode: 400, error: 'That destination comes before the boarding stop in this direction (or is not on it). Try the other direction.' };

  const fromStop = patternStops[fromIndex], toStop = patternStops[toIndex];
  const timetableIsUsable = patternStops[patternStops.length - 1].scheduledOffsetSeconds - patternStops[0].scheduledOffsetSeconds > 0;
  const travelSecondsBetween = (distanceMeters, offsetSeconds) => timetableIsUsable ? offsetSeconds : distanceMeters / FALLBACK_SPEED_METERS_PER_SECOND;

  // Every stop from boarding to destination, with distance/time counted from the boarding stop.
  const stopsOnJourney = patternStops.slice(fromIndex, toIndex + 1).map((patternStop, i) => {
    const stop = stopById.get(patternStop.stopId);
    const distanceFromBoardingMeters = patternStop.distanceAlongRouteMeters - fromStop.distanceAlongRouteMeters;
    return {
      sequence: fromIndex + i + 1,
      name: stop ? stop.stopName : patternStop.stopId,
      code: stop ? stop.stopCode : null,
      lat: stop ? stop.lat : null,
      lon: stop ? stop.lon : null,
      distanceFromBoardingMeters: Math.round(distanceFromBoardingMeters),
      secondsFromBoarding: Math.round(travelSecondsBetween(distanceFromBoardingMeters, patternStop.scheduledOffsetSeconds - fromStop.scheduledOffsetSeconds)),
    };
  });

  const result = {
    routeName: pattern.routeName, headsign: pattern.headsign, directionId: pattern.directionId, etaBasis: timetableIsUsable ? 'schedule' : 'distance',
    from: stopsOnJourney[0], to: stopsOnJourney[stopsOnJourney.length - 1],
    stopsToTravel: toIndex - fromIndex, // e.g. boarding at stop 6 and getting off at stop 9 = 3 stops
    distanceMeters: Math.round(toStop.distanceAlongRouteMeters - fromStop.distanceAlongRouteMeters),
    scheduledSeconds: stopsOnJourney[stopsOnJourney.length - 1].secondsFromBoarding,
    stops: stopsOnJourney,
    routeLine: slicePolylineBetweenDistances(getPolyline(shapeId), fromStop.distanceAlongRouteMeters, toStop.distanceAlongRouteMeters),
    approachingBuses: [],
    scheduled: listScheduledDepartures(pattern, fromIndex, toIndex, nowMs), // timetable: buses that haven't left yet
  };

  // Live buses of this route + direction that have NOT yet reached the boarding stop.
  result.approachingBuses = findApproachingBuses(shapeId, fromIndex, toIndex, liveVehicles).slice(0, MAX_BUSES_IN_JOURNEY_RESULT);
  return { statusCode: 200, result };
}


// =====================================================================================
// DIRECTIONS: from point A to point B  (walk -> bus -> [change -> bus ...] -> walk)
//
// HOW IT WORKS (a "round-based" search, similar in spirit to the RAPTOR algorithm):
//   Round 1 = every way to get somewhere using ONE bus.   Round 2 = using two buses (one change).  Round 3 = three buses.
//   - We start with the bus stops near A, and the time we could be standing at each (now + the walk there).
//   - For every route direction ("pattern") we ride along its stops in order. At a stop we are "ready" at, we catch
//     the earliest trip that has not left yet and note when that trip reaches each later stop.
//   - That gives the earliest arrival time at every stop. Next round: walk a little (<= 400 m) to nearby stops, add a
//     minute for changing, and repeat.
//   - Finally, stops near B + the walk to B give the arrival time at B. We keep each distinct combination of routes.
// Times come from every trip's EXACT scheduled times (not a single template), for today's service days only.
// =====================================================================================
const WALK_SPEED_KMH = 4.8;                 // walking speed
const WALK_DETOUR_FACTOR = 1.3;             // streets are longer than a straight line
const MAX_WALK_TO_STOP_KM = 0.9;            // how far we'll send you to the first / last stop (straight line)
const MAX_WALK_BETWEEN_STOPS_KM = 0.4;      // how far between two stops when changing bus
const CHANGE_BUFFER_SECONDS = 60;           // spare time added when changing bus
const CHANGE_PENALTY_SECONDS = 300;         // when ranking, each change counts as 5 minutes slower
const MAX_BUSES_PER_JOURNEY = 3;            // up to 2 changes
const WALK_ONLY_MAX_KM = 1.5;               // offer "just walk" when A and B are this close
const PLANNING_WINDOW_SECONDS = 12 * 3600;  // only consider trips leaving within the next 12 hours
const MAX_DIRECTIONS_RESULTS = 5;
const LATER_DEPARTURES_SHOWN = 3;
const MAX_LIVE_BUSES_PER_LEG = 2;
const STOP_GRID_DEGREES = 0.005;            // grid cell size for finding nearby stops quickly (~550 m)

const walkSecondsFor = (km) => Math.round(km * WALK_DETOUR_FACTOR / WALK_SPEED_KMH * 3600);

// ---- finding stops near a point (a simple grid, so we don't measure all 1,933 stops every time) ----
const stopGrid = new Map();
const gridKey = (lat, lon) => Math.floor(lat / STOP_GRID_DEGREES) + ',' + Math.floor(lon / STOP_GRID_DEGREES);
for (const stop of GTFS.stops) {
  if (!stop.routeNames.length) continue; // a stop no bus uses is useless for planning
  const key = gridKey(stop.lat, stop.lon);
  if (!stopGrid.has(key)) stopGrid.set(key, []);
  stopGrid.get(key).push(stop);
}

/** Stops within radiusKm of a point, nearest first: [{ stop, distanceKm }] */
function stopsNear(lat, lon, radiusKm) {
  const centerRow = Math.floor(lat / STOP_GRID_DEGREES), centerColumn = Math.floor(lon / STOP_GRID_DEGREES);
  const span = Math.ceil(radiusKm / 0.5) + 1;
  const found = [];
  for (let row = centerRow - span; row <= centerRow + span; row++) {
    for (let column = centerColumn - span; column <= centerColumn + span; column++) {
      for (const stop of stopGrid.get(row + ',' + column) || []) {
        const distanceKm = haversineMeters(lat, lon, stop.lat, stop.lon) / 1000;
        if (distanceKm <= radiusKm) found.push({ stop, distanceKm });
      }
    }
  }
  return found.sort((a, b) => a.distanceKm - b.distanceKm);
}

// ---- route directions ("patterns") and today's trips on each ----
const planningPatterns = Object.entries(GTFS.patterns)
  .filter(([, pattern]) => pattern.schedule && pattern.stops.length >= 2)
  .map(([shapeId, pattern]) => ({ shapeId, routeName: pattern.routeName, directionId: pattern.directionId, headsign: pattern.headsign, stops: pattern.stops, schedule: pattern.schedule }));

const biggestOffsetCache = new WeakMap(); // a timing profile -> its largest offset (the trip's total duration)
function biggestOffset(profile) {
  if (!biggestOffsetCache.has(profile)) biggestOffsetCache.set(profile, Math.max(...profile));
  return biggestOffsetCache.get(profile);
}

/**
 * For every pattern: the trips that are running or about to run, as [{ start, profile }] sorted by start time.
 * Times are seconds since TODAY 00:00 Malaysia time (yesterday's late trips are negative, tomorrow's are > 86400).
 */
function buildPlanningTrips(clock, nowSeconds) {
  const activeServiceIndexes = {}; // dayOffset -> Set of service indexes running that day
  for (const dayOffset of [-1, 0, 1]) {
    const day = dayOffset === 0 ? clock : shiftClockByDays(clock, dayOffset);
    activeServiceIndexes[dayOffset] = new Set(GTFS.serviceIds.map((id, index) => (serviceRunsOn(id, day.dateNumber, day.dayIndex) ? index : -1)).filter((index) => index >= 0));
  }
  return planningPatterns.map((pattern) => {
    const trips = [];
    for (const dayOffset of [-1, 0, 1]) {
      for (const [serviceIndex, startSeconds, profileIndex] of pattern.schedule.trips) {
        if (!activeServiceIndexes[dayOffset].has(serviceIndex)) continue;
        const profile = pattern.schedule.profiles[profileIndex];
        const start = dayOffset * SECONDS_PER_DAY + startSeconds;
        if (start + biggestOffset(profile) < nowSeconds - 300) continue; // already finished
        if (start > nowSeconds + PLANNING_WINDOW_SECONDS) continue;       // too far ahead
        trips.push({ start, profile });
      }
    }
    return trips.sort((a, b) => a.start - b.start);
  });
}

/** The trip that leaves the stop at `stopIndex` at or after `time`: { trip, departure } or null. */
function firstTripAtOrAfter(trips, stopIndex, time) {
  const approximateDeparture = (trip) => trip.start + Math.max(0, trip.profile[stopIndex]);
  let low = 0, high = trips.length;
  while (low < high) { const middle = (low + high) >> 1; if (approximateDeparture(trips[middle]) < time) low = middle + 1; else high = middle; }
  let best = null;
  // Trips can overtake each other slightly (rush hour is slower), so look a few trips either side of the binary-search hit.
  for (let i = Math.max(0, low - 5); i < trips.length && i < low + 15; i++) {
    const offset = trips[i].profile[stopIndex];
    if (offset < 0) continue; // this trip skips that stop
    const departure = trips[i].start + offset;
    if (departure >= time && (!best || departure < best.departure)) best = { trip: trips[i], departure };
    if (best && trips[i].start > best.departure) break; // later trips can't leave earlier than this
  }
  return best;
}

/** A stop as the small object we send to the page. */
function describeStop(stopId) {
  const stop = stopById.get(stopId);
  return { stopId, name: stop ? stop.stopName : stopId, code: stop ? stop.stopCode : null, lat: stop ? stop.lat : null, lon: stop ? stop.lon : null };
}

function makeWalkLeg(from, to, straightKm, isChange) {
  return {
    kind: 'walk', isChange: !!isChange,
    from: { name: from.name, lat: from.lat, lon: from.lon }, to: { name: to.name, lat: to.lat, lon: to.lon },
    distanceMeters: Math.round(straightKm * WALK_DETOUR_FACTOR * 1000), seconds: walkSecondsFor(straightKm),
  };
}

/**
 * Finds ways to get from `origin` to `destination` (each { lat, lon, name }), leaving now.
 * @returns {{ options: object[], reason?: string, nowClock: string, ... }}
 */
function planTrip(origin, destination, liveVehicles = [], nowMs = Date.now()) {
  const clock = getMalaysiaClock(nowMs);
  const nowSeconds = clock.secondsSinceMidnight;
  const coverage = getTimetableCoverage();
  const base = { nowClock: formatClock(nowSeconds), dateNumber: clock.dateNumber, coverage, timetableCoversToday: !!coverage && clock.dateNumber >= coverage.from && clock.dateNumber <= coverage.to };

  const options = [];
  const straightKm = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon) / 1000;
  if (straightKm <= WALK_ONLY_MAX_KM) {
    const leg = makeWalkLeg(origin, destination, straightKm);
    options.push({ kind: 'walk-only', legs: [leg], changes: 0, routeNames: [], key: 'walk', leaveSeconds: nowSeconds, leaveClock: formatClock(nowSeconds), leaveInMinutes: 0,
      arriveSeconds: nowSeconds + leg.seconds, arriveClock: formatClock(nowSeconds + leg.seconds), durationSeconds: leg.seconds, score: nowSeconds + leg.seconds });
  }

  const originStops = stopsNear(origin.lat, origin.lon, MAX_WALK_TO_STOP_KM);
  const destinationStops = stopsNear(destination.lat, destination.lon, MAX_WALK_TO_STOP_KM);
  if (!originStops.length || !destinationStops.length) {
    const where = !originStops.length ? 'your start' : 'your destination';
    return { ...base, options, reason: `No bus stop within ${MAX_WALK_TO_STOP_KM * 1000} m of ${where}.` };
  }
  if (!base.timetableCoversToday) return { ...base, options, reason: 'Today is outside the timetable data, so no bus times can be planned. Update data.json with a newer GTFS download.' };

  const tripsByPattern = buildPlanningTrips(clock, nowSeconds);

  // ---- ONE-BUS journeys, worked out exhaustively for every route direction ----
  // (The round-based search below only keeps the earliest route per stop, so slower-but-valid routes would get
  //  worse times than they really have. Here every route gets its own best board/alight pair.)
  const originDistanceByStop = new Map(originStops.map(({ stop, distanceKm }) => [stop.stopId, distanceKm]));
  const destinationDistanceByStop = new Map(destinationStops.map(({ stop, distanceKm }) => [stop.stopId, distanceKm]));
  const journeys = [];
  planningPatterns.forEach((pattern, patternIndex) => {
    const trips = tripsByPattern[patternIndex];
    if (!trips.length) return;
    let best = null; // earliest arrival at the destination for this route direction
    pattern.stops.forEach((boardStop, boardIndex) => {
      const walkToStopKm = originDistanceByStop.get(boardStop.stopId);
      if (walkToStopKm === undefined || boardIndex === pattern.stops.length - 1) return;
      const found = firstTripAtOrAfter(trips, boardIndex, nowSeconds + walkSecondsFor(walkToStopKm));
      if (!found) return;
      for (let alightIndex = boardIndex + 1; alightIndex < pattern.stops.length; alightIndex++) {
        const walkFromStopKm = destinationDistanceByStop.get(pattern.stops[alightIndex].stopId);
        const offset = found.trip.profile[alightIndex];
        if (walkFromStopKm === undefined || offset < 0) continue;
        const arrival = found.trip.start + offset + walkSecondsFor(walkFromStopKm);
        if (!best || arrival < best.arrival) {
          best = { arrival, walkFromStopKm, label: { time: found.trip.start + offset, patternIndex, trip: found.trip, boardIndex, alightIndex, ready: { kind: 'origin', stopId: boardStop.stopId, distanceKm: walkToStopKm } } };
        }
      }
    });
    if (best) journeys.push(assembleJourney(best.label, destination, best.walkFromStopKm));
  });

  // ---- ROUND 1 start: we can be at each nearby stop after walking there ----
  let ready = new Map(); // stopId -> { time, kind, routeName, ... }  "earliest we can be standing here, ready to board"
  for (const { stop, distanceKm } of originStops) {
    ready.set(stop.stopId, { time: nowSeconds + walkSecondsFor(distanceKm), kind: 'origin', stopId: stop.stopId, distanceKm, routeName: null });
  }

  const bestArrival = new Map(); // stopId -> earliest arrival found in ANY round (later rounds only keep improvements)
  const rounds = [];             // rounds[k] = Map stopId -> arrival label using exactly k+1 buses

  for (let round = 0; round < MAX_BUSES_PER_JOURNEY && ready.size; round++) {
    const arrivals = new Map();
    planningPatterns.forEach((pattern, patternIndex) => {
      const trips = tripsByPattern[patternIndex];
      if (!trips.length) return;
      let current = null; // the trip we are "riding" while we scan down this pattern: { trip, boardIndex, ready }
      for (let j = 0; j < pattern.stops.length; j++) {
        const stopId = pattern.stops[j].stopId;
        // 1. riding the current trip: when does it reach this stop?
        if (current) {
          const offset = current.trip.profile[j];
          if (offset >= 0) {
            const time = current.trip.start + offset;
            const existing = arrivals.get(stopId), overall = bestArrival.get(stopId);
            if ((!existing || time < existing.time) && (overall === undefined || time < overall)) {
              arrivals.set(stopId, { time, patternIndex, trip: current.trip, boardIndex: current.boardIndex, alightIndex: j, ready: current.ready });
            }
          }
        }
        // 2. could we board here (earlier than the trip we are already on)?
        const readyHere = ready.get(stopId);
        if (readyHere && j < pattern.stops.length - 1 && !(round > 0 && readyHere.routeName === pattern.routeName)) { // never "change" onto the same route
          const currentOffset = current ? current.trip.profile[j] : -1;
          const currentDeparture = current && currentOffset >= 0 ? current.trip.start + currentOffset : Infinity;
          if (readyHere.time < currentDeparture) {
            const found = firstTripAtOrAfter(trips, j, readyHere.time);
            if (found && found.departure < currentDeparture) current = { trip: found.trip, boardIndex: j, ready: readyHere };
          }
        }
      }
    });
    if (!arrivals.size) break;
    rounds.push(arrivals);
    arrivals.forEach((label, stopId) => bestArrival.set(stopId, Math.min(bestArrival.get(stopId) ?? Infinity, label.time)));

    // ---- next round: from every stop we reached, walk (a little) to nearby stops and be ready to change ----
    const nextReady = new Map();
    arrivals.forEach((label) => {
      const arrivedStop = stopById.get(planningPatterns[label.patternIndex].stops[label.alightIndex].stopId);
      for (const { stop, distanceKm } of stopsNear(arrivedStop.lat, arrivedStop.lon, MAX_WALK_BETWEEN_STOPS_KM)) {
        const time = label.time + walkSecondsFor(distanceKm) + CHANGE_BUFFER_SECONDS;
        const existing = nextReady.get(stop.stopId);
        if (!existing || time < existing.time) nextReady.set(stop.stopId, { time, kind: 'change', from: label, stopId: stop.stopId, distanceKm, routeName: planningPatterns[label.patternIndex].routeName });
      }
    });
    ready = nextReady;
  }

  // ---- turn the best arrivals near the destination into journeys ----
  for (const { stop, distanceKm: walkEndKm } of destinationStops) {
    let bestTime = Infinity; // a journey with more changes is only kept if it gets there earlier
    rounds.forEach((arrivals, roundIndex) => {
      const label = arrivals.get(stop.stopId);
      if (label && label.time < bestTime) { bestTime = label.time; if (roundIndex > 0) journeys.push(assembleJourney(label, destination, walkEndKm)); } // round 0 = one bus: handled above
    });
  }

  // best per distinct sequence of routes, ranked by arrival time with a penalty for each change
  const bestPerRoutes = new Map();
  for (const option of journeys) {
    const score = option.arriveSeconds + option.changes * CHANGE_PENALTY_SECONDS;
    if (!bestPerRoutes.has(option.key) || score < bestPerRoutes.get(option.key).score) bestPerRoutes.set(option.key, { ...option, score });
  }
  const distinct = [...bestPerRoutes.values()];
  // drop a journey if one with fewer changes gets there nearly as fast (a change must save at least 5 minutes to be worth suggesting)
  const kept = distinct.filter((o) => !distinct.some((x) => x.changes < o.changes && x.arriveSeconds <= o.arriveSeconds + CHANGE_PENALTY_SECONDS * (o.changes - x.changes)));
  const busOptions = kept.sort((a, b) => a.score - b.score).slice(0, MAX_DIRECTIONS_RESULTS);

  // ---- extras: later departures for one-bus journeys, and live buses heading to the first stop ----
  busOptions.forEach((option) => {
    const firstBus = option.legs.find((leg) => leg.kind === 'bus');
    if (option.changes === 0) option.laterDepartures = findLaterDepartures(firstBus, tripsByPattern[firstBus.patternIndex]);
    option.liveBuses = findApproachingBuses(firstBus.shapeId, firstBus.boardIndex, firstBus.alightIndex, liveVehicles)
      .slice(0, MAX_LIVE_BUSES_PER_LEG)
      .map((bus) => ({ plate: bus.plate, lat: bus.lat, lon: bus.lon, minutesAway: Math.round(bus.secondsToBoarding / 60), distanceMeters: bus.distanceToBoardingMeters, speedKmPerHour: bus.speedKmPerHour, ageSeconds: bus.ageSeconds }));
  });
  // The pattern's internal index is for our own use; don't send it on.
  const allOptions = [...options, ...busOptions].sort((a, b) => a.score - b.score).slice(0, MAX_DIRECTIONS_RESULTS);
  allOptions.forEach((o) => o.legs.forEach((leg) => { delete leg.patternIndex; })); // boardIndex/alightIndex stay: positions of the two stops in that route direction
  return { ...base, options: allOptions, reason: allOptions.length ? null : 'No bus journey found in the next 12 hours between those places.' };

  // ----- helpers that need this search's variables -----
  /** Follows the "came from" links back to the start and writes the journey as a list of walk/bus legs. */
  function assembleJourney(finalLabel, destinationPoint, walkEndKm) {
    const steps = [];
    for (let label = finalLabel; label; label = label.ready.kind === 'change' ? label.ready.from : null) steps.unshift(label);

    const legs = [];
    const firstReady = steps[0].ready;
    legs.push(makeWalkLeg(origin, describeStop(firstReady.stopId), firstReady.distanceKm));
    steps.forEach((step, index) => {
      const pattern = planningPatterns[step.patternIndex];
      const board = describeStop(pattern.stops[step.boardIndex].stopId), alight = describeStop(pattern.stops[step.alightIndex].stopId);
      const departureSeconds = step.trip.start + step.trip.profile[step.boardIndex];
      const arrivalSeconds = step.trip.start + step.trip.profile[step.alightIndex];
      legs.push({
        kind: 'bus', routeName: pattern.routeName, headsign: pattern.headsign, directionId: pattern.directionId, shapeId: pattern.shapeId,
        board, alight, stopsCount: step.alightIndex - step.boardIndex,
        departSeconds: departureSeconds, departClock: formatClock(departureSeconds), departsTomorrow: departureSeconds >= SECONDS_PER_DAY,
        arriveSeconds: arrivalSeconds, arriveClock: formatClock(arrivalSeconds), rideSeconds: arrivalSeconds - departureSeconds,
        patternIndex: step.patternIndex, boardIndex: step.boardIndex, alightIndex: step.alightIndex,
      });
      const nextReady = steps[index + 1] && steps[index + 1].ready;
      if (nextReady && nextReady.distanceKm > 0.02) legs.push(makeWalkLeg(alight, describeStop(nextReady.stopId), nextReady.distanceKm, true));
    });
    const lastLeg = legs[legs.length - 1];
    legs.push(makeWalkLeg(lastLeg.kind === 'bus' ? lastLeg.alight : lastLeg.to, destinationPoint, walkEndKm));

    // Waiting time before each bus, and the latest moment you must leave to catch the first one.
    const busLegs = legs.filter((leg) => leg.kind === 'bus');
    const leaveSeconds = busLegs[0].departSeconds - legs[0].seconds;
    let clockTime = leaveSeconds;
    legs.forEach((leg) => {
      if (leg.kind === 'walk') clockTime += leg.seconds + (leg.isChange ? CHANGE_BUFFER_SECONDS : 0);
      else { leg.waitSeconds = Math.max(0, leg.departSeconds - clockTime); clockTime = leg.arriveSeconds; }
    });
    const arriveSeconds = finalLabel.time + walkSecondsFor(walkEndKm);
    return {
      kind: 'bus', legs, changes: busLegs.length - 1, routeNames: busLegs.map((leg) => leg.routeName), key: busLegs.map((leg) => leg.routeName + '>' + leg.headsign).join(' + '),
      leaveSeconds, leaveClock: formatClock(leaveSeconds), leaveInMinutes: Math.max(0, Math.round((leaveSeconds - nowSeconds) / 60)),
      arriveSeconds, arriveClock: formatClock(arriveSeconds), arrivesTomorrow: arriveSeconds >= SECONDS_PER_DAY, durationSeconds: arriveSeconds - leaveSeconds,
    };
  }
}

/** The next few trips of the same route direction after the one chosen, from the same boarding stop. */
function findLaterDepartures(busLeg, trips) {
  const later = [];
  for (const trip of trips) {
    const boardOffset = trip.profile[busLeg.boardIndex], alightOffset = trip.profile[busLeg.alightIndex];
    if (boardOffset < 0 || alightOffset < 0) continue;
    const departure = trip.start + boardOffset;
    if (departure <= busLeg.departSeconds) continue;
    later.push({ departSeconds: departure, departClock: formatClock(departure), arriveClock: formatClock(trip.start + alightOffset) });
  }
  return later.sort((a, b) => a.departSeconds - b.departSeconds).slice(0, LATER_DEPARTURES_SHOWN);
}

/** The closest bus stop to a point (within maxKm): { name, distanceMeters } or null. Used to name a spot picked on the map. */
function nearestStop(lat, lon, maxKm = 0.6) {
  const [closest] = stopsNear(lat, lon, maxKm);
  return closest ? { name: closest.stop.stopName, distanceMeters: Math.round(closest.distanceKm * 1000) } : null;
}

/** Stops whose name contains the text (e.g. "komtar"), same-named stops merged (both sides of the road). */
function searchStops(query, limit = 8) {
  const text = String(query || '').trim().toLowerCase();
  if (text.length < 2) return [];
  const byName = new Map();
  for (const stop of GTFS.stops) {
    if (!stop.routeNames.length) continue;
    const lowerName = stop.stopName.toLowerCase();
    const codeMatches = (stop.stopCode || '').toLowerCase() === text;
    if (!lowerName.includes(text) && !codeMatches) continue;
    const entry = byName.get(lowerName) || { name: stop.stopName, latSum: 0, lonSum: 0, count: 0, routeNames: new Set(), startsWith: lowerName.startsWith(text) };
    entry.latSum += stop.lat; entry.lonSum += stop.lon; entry.count++;
    stop.routeNames.forEach((name) => entry.routeNames.add(name));
    byName.set(lowerName, entry);
  }
  return [...byName.values()]
    .sort((a, b) => (b.startsWith - a.startsWith) || (b.routeNames.size - a.routeNames.size) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => ({ kind: 'stop', name: entry.name, lat: entry.latSum / entry.count, lon: entry.lonSum / entry.count, routeNames: [...entry.routeNames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }));
}

return { describeVehicle, chooseShapeForVehicle, analyseVehicle, planJourney, planTrip, searchStops, nearestStop, stopById, getMalaysiaClock, formatClock };
}

return { createCore };
});
