/**
 * cloudflare-worker.js - OPTIONAL tiny proxy for the realtime bus feed. You only need it if the browser
 * is blocked from calling api.data.gov.my directly (a "CORS" error shown in the app).
 *
 * What it does:
 *   - fetches the Rapid Penang realtime feed on your behalf
 *   - adds the "CORS" header so your web page is allowed to read the answer
 *   - lets Cloudflare cache the answer for 20 s, so however many people/devices use it, data.gov.my sees
 *     at most ~3 requests a minute (its limit is 4/minute)
 *
 * No Node needed: in the Cloudflare dashboard create a Worker, paste this file in, deploy, and copy the
 * worker's URL into the app under Settings -> "Realtime proxy URL". (Not tested by the author - see DEPLOY.md.)
 */
const UPSTREAM = 'https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-penang';

// '*' lets any website use your proxy. For tighter control put your own site's address here,
// e.g. 'https://your-name.github.io'
const ALLOWED_ORIGIN = '*';

const CORS_HEADERS = { 'access-control-allow-origin': ALLOWED_ORIGIN, 'access-control-allow-methods': 'GET, OPTIONS' };

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS }); // browser "pre-check"

    const upstream = await fetch(UPSTREAM, {
      headers: { 'user-agent': 'penang-bus-proxy/1.0' },
      cf: { cacheTtl: 20, cacheEverything: true }, // let Cloudflare reuse the answer for 20 s
    });
    if (!upstream.ok) {
      // Pass a 429 through so the app knows to back off.
      return new Response('Upstream HTTP ' + upstream.status, { status: upstream.status === 429 ? 429 : 502, headers: CORS_HEADERS });
    }
    return new Response(upstream.body, {
      headers: { ...CORS_HEADERS, 'content-type': 'application/x-protobuf', 'cache-control': 'public, max-age=20' },
    });
  },
};
