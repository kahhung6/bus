/**
 * feed.js - downloads the live bus feed politely and turns it into described vehicles.
 * Used by the Node server AND by the browser-only version of the app.
 *
 * data.gov.my allows only 4 requests per minute for GTFS-Realtime, so:
 *   - results are cached for `cacheMs` (20 s => at most 3 calls a minute)
 *   - after a 429 we leave the API alone for `backoffMs`
 *   - if the API fails, we keep showing the last good data, flagged `stale: true`
 *   - in the browser, several tabs share one cache (via loadShared / saveShared) so they don't multiply the calls
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PenangLib = root.PenangLib || {}; root.PenangLib.feed = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * @param {object} options
 * @param {Function} options.getUrl           returns the URL to download (can change at runtime)
 * @param {Function} options.parseFeed        bytes -> { feedTimestamp, vehicles }
 * @param {Function} options.describeVehicle  decoded bus -> described bus (route, headsign, ...)
 * @param {Function} [options.fetchImpl]      fetch function (defaults to the global fetch)
 * @param {object}   [options.requestInit]    extra fetch options (the Node server sets a User-Agent)
 * @param {string|Function} [options.networkErrorHint] extra text for network errors (e.g. a CORS explanation in the browser)
 * @param {Function} [options.loadShared]     () -> { fetchedAtMs, feedTimestamp, rawVehicles } | null   (browser tabs)
 * @param {Function} [options.saveShared]     (snapshot) -> void
 * @param {Function} [options.onDownload]     (bytes) -> void   called after every real download (for the data-usage meter)
 */
function createFeedClient(options) {
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const cacheMs = options.cacheMs || 20000;
  const backoffMs = options.backoffMs || 60000;

  let cache = { fetchedAtMs: 0, result: null };
  let requestInFlight = null; // simultaneous callers share one download
  let blockedUntilMs = 0;     // set after a 429

  function buildResult(snapshot) {
    return {
      fetchedAtMs: snapshot.fetchedAtMs,
      feedTimestamp: snapshot.feedTimestamp,
      rawVehicles: snapshot.rawVehicles,
      vehicles: snapshot.rawVehicles.map(options.describeVehicle),
      stale: false,
    };
  }

  /** The last good data, flagged as stale, or an error if we have nothing at all yet. */
  function staleOrThrow(reason) {
    if (cache.result) return { ...cache.result, stale: true, staleReason: reason };
    throw Object.assign(new Error(reason), { isFeedError: true }); // flagged so the catch below doesn't re-wrap it
  }

  async function getLiveFeed() {
    if (cache.result && Date.now() - cache.fetchedAtMs < cacheMs) return cache.result;

    // Another tab may have fetched very recently - reuse its data instead of calling the API again.
    if (options.loadShared) {
      try {
        const shared = options.loadShared();
        if (shared && Date.now() - shared.fetchedAtMs < cacheMs) {
          cache = { fetchedAtMs: shared.fetchedAtMs, result: buildResult(shared) };
          return cache.result;
        }
      } catch (error) { /* ignore a broken shared cache */ }
    }

    if (Date.now() < blockedUntilMs) return staleOrThrow('Realtime API rate limit reached; retrying shortly');
    if (requestInFlight) return requestInFlight;

    requestInFlight = (async () => {
      try {
        const response = await fetchImpl(options.getUrl(), options.requestInit || {});
        if (response.status === 429) {
          blockedUntilMs = Date.now() + backoffMs;
          return staleOrThrow('Realtime API rate limit reached (4 requests/minute)');
        }
        if (!response.ok) return staleOrThrow('Realtime API HTTP ' + response.status);

        const body = new Uint8Array(await response.arrayBuffer());
        if (options.onDownload) options.onDownload(body.length); // tell the data meter how many bytes this download used
        const decoded = options.parseFeed(body);
        const snapshot = { fetchedAtMs: Date.now(), feedTimestamp: decoded.feedTimestamp, rawVehicles: decoded.vehicles };
        cache = { fetchedAtMs: snapshot.fetchedAtMs, result: buildResult(snapshot) };
        if (options.saveShared) { try { options.saveShared(snapshot); } catch (error) { /* storage full/blocked: fine */ } }
        return cache.result;
      } catch (error) {
        if (error.isFeedError) throw error;
        return staleOrThrow('Realtime API unreachable: ' + error.message + (typeof options.networkErrorHint === 'function' ? options.networkErrorHint() : options.networkErrorHint || ''));
      } finally {
        requestInFlight = null;
      }
    })();
    return requestInFlight;
  }

  return { getLiveFeed };
}

return { createFeedClient };
});
