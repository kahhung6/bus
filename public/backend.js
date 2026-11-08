/**
 * backend.js - gives the page ONE simple interface for getting data, whichever way it is hosted:
 *
 *   SERVER mode   the page was opened from the Node server, so it asks /api/... (the server does the work)
 *   BROWSER mode  there is no server (e.g. the files are on GitHub Pages / Netlify), so the browser does everything
 *                 itself using the same shared code in lib/ (decoder, matching, ETAs, trip planner, geocoder)
 *
 * Either way the page just calls:  backend.getVehicles()  getBus(key)  getJourney(shapeId, from, to)  geocode(lat, lon)
 */

const DIRECT_REALTIME_URL = 'https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-penang';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const SETTINGS_STORAGE_KEY = 'penangBus.settings';
const SHARED_FEED_STORAGE_KEY = 'penangBus.sharedFeed';

const DEFAULT_MAP_CONFIG = {
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

/** Picks server mode if a Node server answers /api/config with JSON, otherwise browser mode. */
async function createBackend(gtfs) {
  // The "data meter" for THIS device: every download made on its behalf is counted here (shown in the Data usage panel).
  const usage = self.PenangLib.usage.createUsageTracker();
  // The shared logic ("core") runs in the page in BOTH modes: it is needed for instant stop-name search and, in browser mode, for everything.
  const core = self.PenangLib.core.createCore(gtfs);
  try {
    const response = await fetch('api/config', { cache: 'no-store' });
    if (response.ok && (response.headers.get('content-type') || '').includes('application/json')) {
      return createServerBackend(await response.json(), usage, core);
    }
  } catch (error) { /* no server: fall through to browser mode */ }
  return createBrowserBackend(gtfs, usage, core);
}

// ---------------------------------------------------------------------------------------
// SERVER mode: every call is just a request to the Node server.
// ---------------------------------------------------------------------------------------
function createServerBackend(config, usage, core) {
  async function getJson(path, countInUsage = true) {
    const response = await fetch(path, { cache: 'no-store' });
    const text = await response.text(); // read as text first so we can count the bytes
    if (countInUsage) usage.record('appData', new TextEncoder().encode(text).length);
    let json = {};
    try { json = JSON.parse(text); } catch (error) { /* not JSON: leave empty */ }
    if (!response.ok) throw new Error(json.error || 'HTTP ' + response.status);
    return json;
  }
  return {
    mode: 'server',
    config,
    usage,
    getServerUsage: () => getJson('api/usage', false), // what the Node server itself has downloaded (not this device's usage)
    getVehicles: () => getJson('api/vehicles'),
    getBus: (key) => getJson('api/bus?key=' + encodeURIComponent(key)),
    getJourney: (shapeId, from, to) => getJson('api/journey?' + new URLSearchParams({ shapeId, from, to })),
    planTrip: (from, to) => getJson('api/plan?' + new URLSearchParams({ fromLat: from.lat, fromLon: from.lon, fromName: from.name, toLat: to.lat, toLon: to.lon, toName: to.name })),
    searchPlaces: (query) => getJson('api/search?q=' + encodeURIComponent(query)),
    searchStops: (query) => core.searchStops(query),        // instant, from the timetable data in the page (no network)
    nearestStop: (lat, lon) => core.nearestStop(lat, lon),
    geocode: (lat, lon) => getJson(`api/geocode?lat=${lat}&lon=${lon}`),
  };
}

// ---------------------------------------------------------------------------------------
// BROWSER mode: no server. Same logic, running inside the page.
// ---------------------------------------------------------------------------------------
function createBrowserBackend(gtfs, usage, core = self.PenangLib.core.createCore(gtfs)) {
  const lib = self.PenangLib;

  // User settings (saved in this browser only): contact email for Nominatim, optional proxy for the realtime feed.
  let settings = { email: '', proxyUrl: '' };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') }; } catch (error) { /* ignore */ }

  const feedClient = lib.feed.createFeedClient({
    // Use the proxy if one is set, otherwise call data.gov.my directly (works only if it allows browser requests / CORS).
    getUrl: () => settings.proxyUrl || DIRECT_REALTIME_URL,
    parseFeed: lib.gtfsrt.parseFeed,
    describeVehicle: core.describeVehicle,
    onDownload: (bytes) => usage.record('realtimeFeed', bytes), // count every live-feed download
    networkErrorHint: () => settings.proxyUrl ? '' : ' - the browser may be blocked by CORS; set a proxy URL under Settings (see DEPLOY.md)',
    // Tabs of this browser share one cache, so two open tabs don't double the number of API calls.
    loadShared: () => JSON.parse(localStorage.getItem(SHARED_FEED_STORAGE_KEY) || 'null'),
    saveShared: (snapshot) => localStorage.setItem(SHARED_FEED_STORAGE_KEY, JSON.stringify(snapshot)),
  });

  const geocoder = lib.geocoder.createGeocoder({
    baseUrl: NOMINATIM_REVERSE_URL,
    onResponseBytes: (bytes) => usage.record('addresses', bytes), // count every address lookup
    getEmail: () => settings.email, // browsers send a Referer automatically; the email is an extra way for OSM to reach you
  });

  return {
    mode: 'browser',
    config: DEFAULT_MAP_CONFIG,
    usage,
    getServerUsage: null, // there is no server in this mode
    getSettings: () => ({ ...settings }),
    saveSettings(newSettings) {
      settings = { email: (newSettings.email || '').trim(), proxyUrl: (newSettings.proxyUrl || '').trim() };
      try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch (error) { /* ignore */ }
    },

    async getVehicles() {
      const feed = await feedClient.getLiveFeed();
      return { fetchedAtMs: feed.fetchedAtMs, feedTimestamp: feed.feedTimestamp, stale: !!feed.stale, staleReason: feed.staleReason || null, vehicles: feed.vehicles };
    },
    async getBus(key) {
      const feed = await feedClient.getLiveFeed();
      const vehicle = feed.vehicles.find((v) => v.key === key);
      if (!vehicle) throw new Error('Bus not in the current feed');
      return { feedTimestamp: feed.feedTimestamp, ...core.analyseVehicle(vehicle) };
    },
    async getJourney(shapeId, from, to) {
      // The stop-to-stop numbers come from the timetable, so they still work if the live feed is down.
      let liveVehicles = [], liveFeedError = null;
      try { liveVehicles = (await feedClient.getLiveFeed()).vehicles; } catch (error) { liveFeedError = error.message; }
      const planned = core.planJourney(shapeId, from, to, liveVehicles);
      if (!planned.result) throw new Error(planned.error);
      planned.result.liveFeedError = liveFeedError;
      return planned.result;
    },
    async planTrip(from, to) {
      let liveVehicles = [], liveFeedError = null; // times come from the timetable, so planning still works if the live feed is down
      try { liveVehicles = (await feedClient.getLiveFeed()).vehicles; } catch (error) { liveFeedError = error.message; }
      return { ...core.planTrip(from, to, liveVehicles), liveFeedError };
    },
    searchPlaces: (query) => geocoder.searchPlaces(query),
    searchStops: (query) => core.searchStops(query),
    nearestStop: (lat, lon) => core.nearestStop(lat, lon),
    geocode: (lat, lon) => geocoder.reverseGeocode(lat, lon),
  };
}
