# How it works

## The big picture
```
 data.gov.my static zip ──update-data.js──► build-data.js ──► public/data.json ─┐
 (timetable, shapes, stops)  (download+unzip)   (one-off, offline)                 │
                                                      ▼
 data.gov.my realtime feed ──► server.js ──► /api/vehicles, /api/bus, /api/geocode ──► public/index.html (browser)
   (protobuf, every 30 s)        │   ▲
                                 │   └── public/lib/gtfsrt.js  decodes the protobuf bytes
                                 └────── public/lib/geo.js     distance / "how far along the route" maths
                                         Nominatim ◄── /api/geocode (queued, cached, 1 request / 1.2 s)
```

## Two ways to run it (same code)
All the real logic lives in `public/lib/*.js` and has no Node-only code, so it runs in BOTH places:
- `core.js` (matching, ETAs, trip planner), `feed.js` (polite live-feed download + cache + back-off), `geocoder.js` (Nominatim queue + cache),
  `gtfsrt.js` (protobuf decoder), `geo.js` (distance maths), `usage.js` (the data meter behind the Data usage panel).
- **Server mode:** `server.js` is a thin HTTP layer that uses those files and exposes `/api/...`.
- **Browser mode:** `public/backend.js` uses the same files directly inside the page - no server needed.
`backend.js` picks the mode by asking for `api/config`: JSON back = server mode, anything else = browser mode.

## The two kinds of data
- **Static** (the timetable): where routes run, where stops are, scheduled times. Rarely changes. Turned into `data.json` by `build-data.js`.
- **Realtime**: where each bus is *right now*. Comes from the feed every ~30 s. It only says "bus X is at lat/lon, running trip T".
Everything clever in this project is joining the two: "trip T" -> its route and stop list -> how far along the bus is.

## Step by step

### 1. update-data.js -> build-data.js (run whenever you want a fresh timetable: `npm run update-data`)
`update-data.js` downloads the zip, unzips it (Node reads the zip format itself, so no wget/tar needed) into a temporary folder, runs `build-data.js` on it, and deletes the temporary files.
- Reads the CSV files and joins them by id (route_id, trip_id, shape_id, stop_id).
- For each **shape** (a route's drawn line) it picks the trip with the most stops as a template and builds a **pattern**:
  the ordered stops, each with
  - `distanceAlongRouteMeters`: how far along the line the stop is (found by snapping the stop's coordinates onto the line, going forward only), and
  - `scheduledOffsetSeconds`: minutes after the first stop the timetable says the bus arrives.

### 2. public/lib/gtfsrt.js
The feed is protobuf (compact binary). The file reads it byte by byte: every field starts with a tag
(field number + type), then the value. Nested messages are decoded the same way. Output: plain JS objects.

### 3. public/lib/core.js `describeVehicle`
Finds each bus's route. The feed's trip ids don't always match the timetable (data.gov.my documents this), so it tries
four strategies in order (exact id, id without service prefix, route/shape parts inside the id, the feed's route_id) and records which worked in `matchMethod`.

### 4. public/lib/core.js `analyseVehicle` (the "one bus" answer)
1. **Which direction?** If the trip matched, use its shape. Otherwise try each of the route's shapes and pick the nearest one to the bus, penalising a shape that runs opposite to the bus's compass heading.
2. **How far along?** Snap the bus onto the route line -> `busDistanceAlong` metres from the start.
3. **Stops passed / left:** stops whose distance-along is behind the bus are "passed"; the rest are "upcoming". Stops left to terminal = number of upcoming stops (the terminal is the last one in that direction).
4. **ETA:** timetable time at the stop minus timetable time at the bus's position (interpolated between its two neighbouring stops). This is *scheduled running time*, not live traffic.
5. **Nearest stops:** plain straight-line distance to every stop.

### 4b. Trip planner (`planJourney` in public/lib/core.js, "Trip planner" tab)
Pick a route, a direction, a boarding stop and a destination stop. Because every pattern stores each stop's distance along the route and its scheduled time offset,
the journey is just subtraction: stops = index difference, distance = distance difference, time = scheduled-offset difference.
The server also lists live buses of that route and direction that have not yet reached the boarding stop (same snapping maths as step 4),
with their ETA to the boarding stop and to your destination (ETA to destination = bus ETA to boarding + journey time, in practice
`destination offset - bus offset`).

### 4c. Scheduled departures ("Next scheduled buses" in the Trip planner)
Live positions only show buses that are already driving. The timetable also knows trips that haven't left yet, so `listScheduledDepartures` (public/lib/core.js) reads them:
- `build-data.js` stores, for every route direction, each trip's **service id** (which days it runs, from `calendar.txt`), its **start time**, and its **exact time at every stop**
  (identical timing patterns are shared, which keeps the file small: 7,866 trips -> 1,429 patterns).
- At request time it takes the current **Malaysia time**, checks which services run today (and yesterday/tomorrow, for trips past midnight), adds each trip's start time to its offset at your boarding stop,
  and lists the next ones that haven't left yet, with the arrival time at your destination.
- It is the timetable only: no delays, no cancellations, and public holidays are not in the data (there is no `calendar_dates.txt`).

### 4d. Directions: any place A -> any place B (`planTrip` in public/lib/core.js)
1. **Stops near each end:** a grid lookup finds stops within 900 m of A and of B; walking time = distance x 1.3 / 4.8 km/h.
2. **Today's trips:** for every route direction we list the trips running now or soon (using the calendar, so weekday/weekend/holiday services are right), each with its exact times at every stop.
3. **One bus:** for every route direction we find the earliest trip you can catch from a stop near A and the best stop to get off near B. Each route gets its own best answer, so slower routes are shown too.
4. **Changes:** a round-based search (like the RAPTOR algorithm): round 1 = where one bus can take you, then walk <= 400 m to a nearby stop (+1 min), round 2 = where a second bus takes you, and so on up to 3 buses.
   A change is only suggested if it saves at least 5 minutes over a journey with fewer changes.
5. **Ranking:** by arrival time, with each change counted as 5 minutes slower. For one-bus options we add the next departures and any live bus heading to your boarding stop.
I checked it against a brute-force search done independently from the raw timetable files (same best arrival times) and checked 107 journeys for real trips, valid change times and consistent arrival times.

### 5. Nominatim (address lookup)
Only the selected bus is looked up, only after it moves 150 m (browser side). The server adds a one-lane queue with at least 1.2 s between real
calls, a 24 h cache, a limit on waiting requests, and a 5-minute back-off on 429/403.

### 6. public/index.html
Loads `data.json` once, polls `/api/vehicles` every 30 s, shows the list and map dots, and calls `/api/bus` and `/api/geocode` for the selected bus.
Leaflet draws the map; "layers" are groups of drawings that can be cleared and redrawn independently.

## Glossary
- **GTFS**: standard file format for transit timetables. **GTFS-realtime**: standard format for live vehicle data.
- **Shape / polyline**: a route's drawn line (many lat/lon points). **Projection / snapping**: finding the nearest point on that line.
- **Pattern**: ordered stops for one direction of a route. **Terminal**: last stop in the bus's direction of travel.
- **Haversine**: formula for straight-line distance between two lat/lon points on a sphere.
- **Reverse geocoding**: coordinates -> street address.
