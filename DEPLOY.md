# Using it on your phone

You can run it in two ways. They use the same page and the same logic (public/lib/*.js):

| | Needs Node? | How it works |
|---|---|---|
| **A. Website only** (recommended if you have no server) | **No** | Upload the `public/` folder to any free static host. The page does everything itself in your browser. |
| **B. With the Node server** | Yes | `node server.js`. The server talks to data.gov.my and Nominatim for you. |

The page detects which one it is running under, so nothing needs changing.

---
## A. Website only (no Node, no server)

### 1. Put the files online (free, no command line)
Upload the contents of the **`public/`** folder (`penang-bus-website.zip` has exactly that) to a static host:
- **Netlify Drop**: drag the unzipped folder onto the Netlify "drop" page. You get an https address instantly.
- **GitHub Pages**: make a repository, upload the files, Settings -> Pages -> deploy from the main branch.
- **Cloudflare Pages**: create a project and upload the folder.

Open the address on your phone. In Chrome: menu -> **Install app / Add to Home screen** (needs https, which these hosts give you).

### 2. Does the live feed load?
The page calls `api.data.gov.my` straight from your browser. **I could not confirm that this API allows that** (browsers need the server to send a
"CORS" header). Two outcomes:
- It works: you'll see "NN buses in feed". Nothing more to do.
- It doesn't: the status shows *"Realtime API unreachable ... blocked by CORS"*. Use the free proxy below.

### 3. Only if blocked: the 2-minute proxy (still no Node)
1. Create a free Cloudflare account -> Workers & Pages -> Create -> Worker.
2. Paste in `extras/cloudflare-worker.js`, Deploy, and copy the worker's URL.
3. In the app open **Settings** (top of the sidebar), paste it into "Realtime proxy URL", Save.
The proxy also caches the feed for 20 s, which keeps you well under the 4-requests-a-minute limit even with several devices.
(I could not test the worker from here; if it misbehaves tell me what you see.)

### Settings (stored only in your browser)
- **Email**: sent to Nominatim with address lookups so OSM can contact you if there is a problem. Please set it.
- **Proxy URL**: only if step 3 was needed.

### Limits of the website-only version
- Each browser/device makes its own calls. data.gov.my's 4/min limit is per IP address: one device polling every 30 s uses 2/min, so
  **two devices on the same Wi-Fi without the proxy would sit right at the limit**. Tabs in the same browser share one cache, so extra tabs are free.
- The timetable (`data.json`) is a snapshot (check the end date: `npm run update-data` prints it, or the app warns when today is outside it).
  To refresh it, run **`npm run update-data`** once on any computer with Node (it downloads and unzips everything itself), then upload the new
  `public/data.json` to your host. No Node anywhere? Download the zip from the data.gov.my link and send it to me - I'll rebuild `data.json` for you.
---
## B. With the Node server
Refresh the timetable any time with `npm run update-data`.
    NOMINATIM_EMAIL=you@example.com node server.js      # open http://localhost:3000
Options: `PORT`, `NOMINATIM_EMAIL`, `NOMINATIM_UA`, `TILE_URL`, `TILE_ATTRIBUTION`.
- Home Wi-Fi: open `http://<PC-IP>:3000` on the phone. Anywhere: install Tailscale on both. Always-on: a Raspberry Pi or small VPS behind https.
- A public server lets anyone spend your Nominatim quota - keep it private or add a login.
- Here the server makes ONE realtime call every 20 s however many devices connect, and one Nominatim queue for all of them.

---
## Data usage
The **Data usage** panel in the app shows the size of each 30-second refresh and an hourly estimate. In Node mode your phone downloads the app server's JSON (larger than the raw feed), while the server downloads the raw feed;
in website-only mode the phone downloads the raw feed directly (smaller). Map tiles are counted but their size isn't visible to the browser, so that figure is a rough range.

## Rate limits and policies (both modes)
| Service | Limit / rule | What the app does |
|---|---|---|
| data.gov.my GTFS-Realtime | 4 requests/minute (per IP) | 20 s cache (max 3/min), 60 s back-off on a 429, shows last good data meanwhile |
| Nominatim (addresses) | max 1 request/s, identify the app, cache, no bulk | one-lane queue, 1.2 s gaps, 24 h cache, only the selected bus after it moves 150 m |
| OSM map tiles | identifying User-Agent/Referer, attribution, caching, light use, **no offline/bulk download** | browser sends its normal headers, attribution shown, tiles are never stored by the app. Switch provider with `TILE_URL` (server mode) |

Making it a phone app does not change these rules; they apply to apps as much as websites. Light personal use like this stays within them.

## GPS ("use my location")
Browsers only allow GPS on https:// pages (or localhost). Hosted on Netlify/GitHub Pages you get https automatically. On the Node server over plain http://192.168.x.x the GPS button
explains this; you can still type a stop, search a place or tap the map.

## A real Android/iOS app (APK)?
Possible with Capacitor, but not built here (needs Android Studio / Xcode and testing on a device). Since the page now already runs without a server,
wrapping it would be much simpler than before - ask if you want it.
