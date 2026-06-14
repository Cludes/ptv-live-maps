/**
 * PTV GTFS-Realtime proxy (Cloudflare Worker)
 *
 * Fetches the Transport Victoria GTFS-Realtime "Metro Train Vehicle Positions"
 * feed (Protocol Buffers), decodes it, and returns clean JSON to the browser.
 *
 * Why a Worker: the GTFS-R feed needs a KeyID header (which must stay secret) and
 * does not send CORS headers, so the browser can't call it directly. The Worker
 * holds the key, adds CORS, and caches the upstream response so many visitors
 * polling at once don't blow the feed's rate limit (~24 calls / 60s).
 *
 * Env (set via wrangler):
 *   FEED_URL  - exact Metro Train Vehicle Positions endpoint from your portal account ([vars] in wrangler.toml)
 *   PTV_KEYID - your API key  (wrangler secret put PTV_KEYID)
 */

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const CACHE_TTL = 20; // seconds the Worker serves a cached feed before refetching upstream

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (request.method !== 'GET') return cors(json({ error: 'method not allowed' }, 405));

    if (!env.FEED_URL || !env.PTV_KEYID) {
      return cors(json({ error: 'Worker not configured: set FEED_URL ([vars]) and PTV_KEYID (secret)' }, 500));
    }

    // Serve from edge cache if fresh, so all clients share one upstream fetch.
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + '/__vehicles', { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cors(cached);

    let upstream;
    try {
      upstream = await fetch(env.FEED_URL, { headers: { KeyID: env.PTV_KEYID } });
    } catch (e) {
      return cors(json({ error: 'upstream fetch failed', detail: String(e) }, 502));
    }
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return cors(json({ error: `upstream HTTP ${upstream.status}`, detail: body.slice(0, 200) }, 502));
    }

    let feed;
    try {
      const buf = new Uint8Array(await upstream.arrayBuffer());
      feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
    } catch (e) {
      return cors(json({ error: 'protobuf decode failed', detail: String(e) }, 502));
    }

    const vehicles = [];
    for (const entity of feed.entity || []) {
      const v = entity.vehicle;
      if (!v || !v.position) continue;
      vehicles.push({
        id: (v.vehicle && v.vehicle.id) || entity.id,
        trip_id: (v.trip && v.trip.tripId) || null,
        route_id: (v.trip && v.trip.routeId) || null,
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing ?? null,
        speed: v.position.speed ?? null,
        timestamp: toNum(v.timestamp),
      });
    }

    const resp = json({ fetched_at: new Date().toISOString(), count: vehicles.length, vehicles });
    resp.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return cors(resp);
  },
};

// protobufjs returns Long objects for 64-bit ints; normalise to a JS number.
function toNum(x) {
  if (x == null) return null;
  if (typeof x === 'object' && typeof x.toNumber === 'function') return x.toNumber();
  return Number(x);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return new Response(resp.body, { status: resp.status, headers: h });
}
