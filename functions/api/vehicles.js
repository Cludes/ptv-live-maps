/**
 * Cloudflare Pages Function - GET /api/vehicles
 *
 * Same job as the standalone Worker: fetches the Transport Victoria GTFS-Realtime
 * "Metro Train Vehicle Positions" feed (protobuf), decodes it, and returns clean
 * JSON. Because it lives in the same Pages project as the site, it's served from
 * ptv-live-maps.pages.dev/api/vehicles - same origin, no CORS headaches.
 *
 * Env (Pages project -> Settings -> Variables and Secrets):
 *   PTV_KEYID  - the Subscription Key (add as an encrypted secret). Until it's set
 *                this endpoint returns a "not configured" 500.
 *   FEED_URL   - optional override; defaults to the confirmed Metro endpoint below.
 */

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const DEFAULT_FEED_URL =
  'https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/metro/vehicle-positions';
const CACHE_TTL = 20; // seconds the edge serves a cached feed before refetching upstream

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const feedUrl = env.FEED_URL || DEFAULT_FEED_URL;

  if (!env.PTV_KEYID) {
    return cors(json({ error: 'Worker not configured: set PTV_KEYID (Pages secret)' }, 500));
  }

  // Serve from edge cache if fresh, so all clients share one upstream fetch.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + '/__vehicles', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  let upstream;
  try {
    upstream = await fetch(feedUrl, { headers: { KeyID: env.PTV_KEYID } });
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
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return cors(resp);
}

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
