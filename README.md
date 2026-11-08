# Rapid Penang bus tracker (no dependencies)

**No Node?** Upload the `public/` folder to any static host (Netlify Drop, GitHub Pages...) - see DEPLOY.md, option A.

## With Node

    node server.js            # open http://localhost:3000

Node 18+ (built-in fetch). `public/data.json` is prebuilt from your GTFS (valid ~7 Nov - 20 Dec 2026).
To refresh the timetable, run `npm run update-data` (downloads the zip from data.gov.my, unzips it, rebuilds `public/data.json`; nothing to unzip by hand).

## Directions tab (like a journey-planner app)
Pick a start and a destination and it lists the ways to get there: walk to a stop, ride, change bus if it is worth it (up to 2 changes), walk to the destination.
- **Start / destination:** type a stop name (instant, no internet needed), press Enter to search for a place (Nominatim, one request per search), tap 📍 for your GPS, or tap 🗺 and then the map.
- **Each option shows:** total time, when to leave, arrival time, walking, the bus(es), the next few departures, and live buses heading to your first stop.
- **Assumptions:** you leave now; walking is 4.8 km/h along a straight line made 30% longer; up to 900 m to a stop and 400 m between stops.
- GPS only works on https:// pages (or localhost).

## Checking data usage
Open the **Data usage** panel in the sidebar. It shows what the last 30-second refresh downloaded, an hourly estimate, running totals per kind, map-tile counts, and (with the Node server) what the server itself downloads from the internet. "Reset counters" starts again from zero.

## Endpoints
- `/api/vehicles` - all buses (decoded realtime feed, cached 20 s). Never touches Nominatim.
- `/api/bus?key=<bus key>` - one bus: matched route/direction, its current stop (the last stop it went past), next stops + ETA, stops left to terminal, nearest stops.
- `/api/plan?fromLat=&fromLon=&fromName=&toLat=&toLon=&toName=` - directions between two points (walk + buses + changes).
- `/api/search?q=` - place search via Nominatim (explicit searches only).
- `/api/journey?shapeId=&from=&to=` - trip planner: stops/distance/scheduled time between two stops, the next scheduled departures from the timetable, and live buses approaching the boarding stop.
- `/api/usage` - how much internet the server itself has used since it started (live feed + address lookups), per kind.
- `/api/config` - map tile settings for the page.
- `/api/geocode?lat=&lon=` - Nominatim reverse lookup, used only for the selected bus.
- `/api/debug`    - raw decoded sample + how many buses matched the timetable (check this first if buses show "?")

Phone use, rate limits and settings: see DEPLOY.md.
See ARCHITECTURE.md for a walkthrough of how everything fits together.

## Nominatim policy handling (server side)
- one request queue, at least 1.2 s between upstream calls, max 3 waiting
- results cached 24 h on a ~11 m grid; the page only asks again after the selected bus moves 150 m
- backs off 5 min on HTTP 429/403
- set an identifying contact before real use:  `NOMINATIM_EMAIL=you@example.com node server.js`
  (optionally `NOMINATIM_UA="my-app/1.0 (you@example.com)"`)
