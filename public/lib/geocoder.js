/**
 * geocoder.js - Nominatim lookups, policy-friendly:
 *   reverseGeocode(lat, lon)  coordinates -> street address
 *   searchPlaces(text)        place name -> coordinates (only when the user explicitly asks; never as-you-type)
 * Used by the Node server AND by the browser-only version of the app.
 *
 * Nominatim's usage policy: max 1 request per second, identify your app (User-Agent / Referer / email),
 * cache results, no bulk use. All of that is enforced here:
 *   - one-lane queue with a minimum gap between real calls
 *   - answers cached (on a ~11 m grid) for 24 hours
 *   - a limit on how many requests may wait in line
 *   - a 5-minute back-off if Nominatim answers 429/403
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PenangLib = root.PenangLib || {}; root.PenangLib.geocoder = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/** Builds a short, readable address ("Jalan X, Gelugor, George Town") from Nominatim's detailed answer. */
function buildShortAddress(nominatimResponse) {
  const address = nominatimResponse.address || {};
  const road = address.road || address.pedestrian || address.footway || address.path || address.residential;
  const area = address.suburb || address.neighbourhood || address.quarter || address.village || address.hamlet;
  const city = address.city || address.town || address.municipality || address.county || address.state_district;
  return [road, area, city].filter(Boolean).join(', ') || nominatimResponse.display_name || null;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl          Nominatim reverse endpoint
 * @param {string} [options.searchUrl]      Nominatim search endpoint (default: the public one)
 * @param {number[]} [options.searchCenter] [lat, lon] to prefer results near (default: Penang)
 * @param {Function} [options.fetchImpl]    fetch function (defaults to the global fetch)
 * @param {object} [options.headers]        extra request headers (the Node server sets a User-Agent here)
 * @param {Function} [options.getEmail]     returns the contact email to send along (may change at runtime)
 * @param {Function} [options.onResponseBytes] (bytes) -> void   called with the size of each real Nominatim answer (data meter)
 */
function createGeocoder(options) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const getEmail = options.getEmail || (() => '');
  const minGapMs = options.minGapMs || 1200;            // a little over 1 s for safety
  const maxWaiting = options.maxWaiting || 3;           // if more pile up, refuse instead of queueing forever
  const cacheLifetimeMs = options.cacheLifetimeMs || 24 * 3600 * 1000;
  const backoffAfterBlockMs = options.backoffAfterBlockMs || 5 * 60 * 1000;

  const cache = new Map(); // "lat,lon" rounded to 4 decimals -> { storedAtMs, value }
  let queueTail = Promise.resolve(); // each lookup waits for the previous one: a one-lane queue
  let waiting = 0;
  let lastCallMs = 0;
  let blockedUntilMs = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rejectWith = (message) => Promise.reject(Object.assign(new Error(message), { statusCode: 429 }));

  /**
   * Runs one Nominatim request politely: cache -> back-off check -> queue -> minimum gap -> request -> cache.
   * @param {string} cacheKey   identifies the question (so a repeat is answered from the cache)
   * @param {Function} buildUrl () => URL to request
   * @param {Function} toValue  (parsed JSON) => the answer to cache and return
   */
  function lookup(cacheKey, buildUrl, toValue) {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.storedAtMs < cacheLifetimeMs) return Promise.resolve({ ...cached.value, cached: true });

    if (Date.now() < blockedUntilMs) return rejectWith('Nominatim rate-limited us; backing off');
    if (waiting >= maxWaiting) return rejectWith('Geocoder busy');

    waiting++;
    const job = queueTail
      .then(async () => {
        // Another request for the same question may have filled the cache while we waited in line.
        const nowCached = cache.get(cacheKey);
        if (nowCached && Date.now() - nowCached.storedAtMs < cacheLifetimeMs) return { ...nowCached.value, cached: true };

        // Enforce the minimum gap since the previous real call to Nominatim.
        const msToWait = lastCallMs + minGapMs - Date.now();
        if (msToWait > 0) await sleep(msToWait);
        lastCallMs = Date.now();

        const response = await fetchImpl(buildUrl(), { headers: { 'accept-language': 'en', ...(options.headers || {}) } });
        if (response.status === 429 || response.status === 403) {
          blockedUntilMs = Date.now() + backoffAfterBlockMs;
          throw Object.assign(new Error('Nominatim HTTP ' + response.status), { statusCode: 429 });
        }
        if (!response.ok) throw new Error('Nominatim HTTP ' + response.status);

        const text = await response.text(); // read as text first so we can count the bytes
        if (options.onResponseBytes) options.onResponseBytes(new TextEncoder().encode(text).length);
        const value = toValue(JSON.parse(text));
        cache.set(cacheKey, { storedAtMs: Date.now(), value });
        if (cache.size > 500) cache.delete(cache.keys().next().value); // drop the oldest entry
        return { ...value, cached: false };
      })
      .finally(() => { waiting--; });

    queueTail = job.catch(() => {}); // a failed lookup must not block the ones behind it
    return job;
  }

  /** Builds a request URL; `extra` are the query parameters. */
  function makeUrl(base, extra) {
    const email = getEmail();
    const url = new URL(base, typeof location !== 'undefined' ? location.href : undefined);
    url.search = new URLSearchParams({ format: 'jsonv2', ...extra, ...(email ? { email } : {}) });
    return url;
  }

  /** Coordinates -> street address. */
  function reverseGeocode(lat, lon) {
    return lookup(
      lat.toFixed(4) + ',' + lon.toFixed(4), // ~11 m grid
      () => makeUrl(options.baseUrl, { lat: String(lat), lon: String(lon), zoom: '18', addressdetails: '1' }),
      (json) => ({ address: buildShortAddress(json), displayName: json.display_name || null }),
    );
  }

  /** Place name -> up to 6 matching places in Malaysia: { places: [{ kind: 'place', name, detail, lat, lon }] }. */
  function searchPlaces(query) {
    const text = String(query || '').trim();
    if (text.length < 3) return Promise.resolve({ places: [] });
    const [centerLat, centerLon] = options.searchCenter || [5.395, 100.332]; // prefer results around Penang
    return lookup(
      'search:' + text.toLowerCase(),
      () => makeUrl(options.searchUrl || 'https://nominatim.openstreetmap.org/search', {
        q: text, countrycodes: 'my', limit: '6', 'accept-language': 'en',
        viewbox: [centerLon - 0.6, centerLat + 0.6, centerLon + 0.6, centerLat - 0.6].join(','), // left,top,right,bottom
      }),
      (json) => ({
        places: json.map((item) => ({
          kind: 'place',
          name: item.name || String(item.display_name || '').split(',')[0],
          detail: String(item.display_name || '').split(',').slice(1, 3).join(',').trim(),
          lat: +item.lat, lon: +item.lon,
        })),
      }),
    );
  }

  return { reverseGeocode, searchPlaces };
}

return { createGeocoder, buildShortAddress };
});
