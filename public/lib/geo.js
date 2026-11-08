(function (root, factory) {
  // Works in both places: Node (require) and the browser (<script> tag -> window.PenangLib.<name>).
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PenangLib = root.PenangLib || {}; root.PenangLib.geo = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/**
 * geo.js - small geometry helpers for latitude/longitude maths.
 *
 * KEY IDEA: a bus route is stored as a "polyline" = a list of points joined by straight segments.
 * To answer "how far along its route is this bus?" we find the nearest point on the polyline
 * ("projection") and add up the length of all segments before it.
 */

const EARTH_RADIUS_METERS = 6371000;
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Straight-line ("as the crow flies") distance in metres between two lat/lon points,
 * using the haversine formula, which accounts for the Earth being a sphere.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const deltaLat = (lat2 - lat1) * DEGREES_TO_RADIANS;
  const deltaLon = (lon2 - lon1) * DEGREES_TO_RADIANS;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1 * DEGREES_TO_RADIANS) * Math.cos(lat2 * DEGREES_TO_RADIANS) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

/**
 * Wraps a list of [lat, lon] points with a "running total" of distance.
 * cumulativeMeters[i] = distance in metres from the first point to point i.
 */
function buildPolyline(points) {
  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i++) {
    const [prevLat, prevLon] = points[i - 1];
    const [lat, lon] = points[i];
    cumulativeMeters[i] = cumulativeMeters[i - 1] + haversineMeters(prevLat, prevLon, lat, lon);
  }
  return { points, cumulativeMeters };
}

/**
 * For every segment from `firstSegmentIndex` onwards, works out how close the given point is to it.
 * Returns [{ segmentIndex, fraction, distanceToPointMeters }] where `fraction` (0..1) says how far
 * along that segment the closest spot is.
 *
 * To keep the maths simple we convert degrees to metres around the point (a flat "local" map).
 * Over a few hundred metres the error is negligible.
 */
function measureDistanceToSegments(polyline, lat, lon, firstSegmentIndex = 0) {
  const metersPerDegreeLon = Math.cos(lat * DEGREES_TO_RADIANS) * EARTH_RADIUS_METERS * DEGREES_TO_RADIANS;
  const metersPerDegreeLat = EARTH_RADIUS_METERS * DEGREES_TO_RADIANS;
  const results = [];

  for (let i = firstSegmentIndex; i < polyline.points.length - 1; i++) {
    const [startLat, startLon] = polyline.points[i];
    const [endLat, endLon] = polyline.points[i + 1];

    // Put the origin at the query point; (x, y) are metres east / north of it.
    const startX = (startLon - lon) * metersPerDegreeLon, startY = (startLat - lat) * metersPerDegreeLat;
    const endX = (endLon - lon) * metersPerDegreeLon, endY = (endLat - lat) * metersPerDegreeLat;

    const segmentX = endX - startX, segmentY = endY - startY;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

    // Where along the segment is the closest point? (dot-product projection, clamped to the segment ends)
    let fraction = segmentLengthSquared ? -(startX * segmentX + startY * segmentY) / segmentLengthSquared : 0;
    fraction = Math.max(0, Math.min(1, fraction));

    const closestX = startX + fraction * segmentX, closestY = startY + fraction * segmentY;
    results.push({ segmentIndex: i, fraction, distanceToPointMeters: Math.hypot(closestX, closestY) });
  }
  return results;
}

/** Converts a chosen segment + fraction into the final projection result. */
function buildProjectionResult(polyline, hit) {
  const [startLat, startLon] = polyline.points[hit.segmentIndex];
  const [endLat, endLon] = polyline.points[hit.segmentIndex + 1];
  const segmentLengthMeters = polyline.cumulativeMeters[hit.segmentIndex + 1] - polyline.cumulativeMeters[hit.segmentIndex];

  // Compass heading of this segment (0 = north, 90 = east), used to tell which direction a bus is travelling.
  const headingDegrees =
    ((Math.atan2((endLon - startLon) * Math.cos(startLat * DEGREES_TO_RADIANS), endLat - startLat) / DEGREES_TO_RADIANS) + 360) % 360;

  return {
    segmentIndex: hit.segmentIndex,
    distanceAlongMeters: polyline.cumulativeMeters[hit.segmentIndex] + hit.fraction * segmentLengthMeters, // progress along the route
    offsetFromLineMeters: hit.distanceToPointMeters, // how far the point is from the route line
    headingDegrees,
  };
}

/** Finds the nearest point on the whole polyline to the given position. */
function projectOntoPolyline(polyline, lat, lon) {
  const hits = measureDistanceToSegments(polyline, lat, lon);
  if (!hits.length) return { segmentIndex: 0, distanceAlongMeters: 0, offsetFromLineMeters: Infinity, headingDegrees: 0 };
  let best = hits[0];
  for (const hit of hits) if (hit.distanceToPointMeters < best.distanceToPointMeters) best = hit;
  return buildProjectionResult(polyline, best);
}

/**
 * Like projectOntoPolyline, but never looks before `minSegmentIndex`. Used when placing a route's
 * stops one after another, so stop #5 can never be placed before stop #4.
 * If a route passes the same spot twice (a loop), we choose the earliest pass that is close enough
 * (within `toleranceMeters` of the best match) instead of jumping to the later one.
 */
function projectOntoPolylineForward(polyline, lat, lon, minSegmentIndex, toleranceMeters = 25) {
  const hits = measureDistanceToSegments(polyline, lat, lon, minSegmentIndex);
  if (!hits.length) {
    return { segmentIndex: polyline.points.length - 2, distanceAlongMeters: polyline.cumulativeMeters[polyline.cumulativeMeters.length - 1], offsetFromLineMeters: Infinity, headingDegrees: 0 };
  }
  const smallestDistance = Math.min(...hits.map((hit) => hit.distanceToPointMeters));
  const chosen = hits.find((hit) => hit.distanceToPointMeters <= smallestDistance + toleranceMeters);
  return buildProjectionResult(polyline, chosen);
}

/** Smallest angle (0-180) between two compass headings, e.g. 350 vs 10 -> 20. */
function angleDifferenceDegrees(headingA, headingB) {
  const difference = Math.abs(headingA - headingB) % 360;
  return difference > 180 ? 360 - difference : difference;
}

return { haversineMeters, buildPolyline, projectOntoPolyline, projectOntoPolylineForward, angleDifferenceDegrees };
});
