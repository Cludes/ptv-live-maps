/**
 * Cloudflare Pages Function - GET /api/departures
 *
 * Replaces the old GitHub Actions job that committed data/live.json. Signs the
 * PTV Timetable API request server-side (HMAC-SHA1 over the path + devid), fetches
 * current metro + V/Line departures, and returns the same JSON shape the frontend
 * already consumes: { fetched_at, departures, runs }.
 *
 * The credentials never leave the edge: the browser only ever calls this
 * same-origin endpoint. The signature is computed here from the Pages secrets.
 *
 * Env (Pages project -> Settings -> Variables and Secrets):
 *   PTV_DEV_ID   - the PTV Timetable API User ID (devid), add as an encrypted secret
 *   PTV_API_KEY  - the PTV Timetable API key (HMAC secret), add as an encrypted secret
 * Until both are set this endpoint returns the empty placeholder shape (200) so the
 * frontend falls back to demo mode exactly as it did with the old empty live.json.
 */

const API_BASE = 'https://timetableapi.ptv.vic.gov.au';
const CACHE_TTL = 60; // seconds the edge serves a cached response before refetching PTV

// Melbourne metro route IDs (route_type 0)
const METRO_ROUTE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18];

// Metro stops to poll: Flinders St is the base (covers most routes); the outer
// termini catch runs that never reach Flinders St.
const FLINDERS_ST = 1071;
const OUTER_METRO_STOPS = [1080, 1109, 1008, 1025, 1037, 1178, 1038];

// V/Line hub (Southern Cross) + regional termini
const VLINE_HUB_STOP = 1068;
const VLINE_TERMINUS_STOPS = [1094, 1061, 1062, 1080, 1082, 1085, 1086];

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const { request, env } = context;

  // Not configured yet: return the empty placeholder so the app runs in demo mode.
  if (!env.PTV_DEV_ID || !env.PTV_API_KEY) {
    return cors(json({ fetched_at: null, departures: [], runs: {} }));
  }

  // Serve from edge cache if fresh, so all visitors share one upstream fetch cycle.
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + '/__departures', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  // Build the poll list. The first (base) entry keeps all its metro departures;
  // later stops only contribute runs not already seen (keeps one departure per run).
  const polls = [
    { path: `/v3/departures/route_type/0/stop/${FLINDERS_ST}?expand=run&max_results=150&look_backwards=false`, metroOnly: true, base: true },
    ...OUTER_METRO_STOPS.map(id => ({
      path: `/v3/departures/route_type/0/stop/${id}?expand=run&max_results=20&look_backwards=false`, metroOnly: true, base: false,
    })),
    { path: `/v3/departures/route_type/3/stop/${VLINE_HUB_STOP}?expand=run&max_results=100&look_backwards=false`, metroOnly: false, base: false },
    ...VLINE_TERMINUS_STOPS.map(id => ({
      path: `/v3/departures/route_type/3/stop/${id}?expand=run&max_results=10&look_backwards=false`, metroOnly: false, base: false,
    })),
  ];

  // Each stop is fetched independently; one failing stop is non-fatal (returns null).
  const results = await Promise.all(
    polls.map(async p => {
      try {
        const url = await signedUrl(p.path, env.PTV_DEV_ID, env.PTV_API_KEY);
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    })
  );

  // If every stop failed (e.g. bad credentials), surface an error rather than caching an empty result.
  if (results.every(r => r === null)) {
    return cors(json({ error: 'all upstream PTV requests failed' }, 502));
  }

  const allRuns = {};
  const allDepartures = [];
  // Merge in poll order so the "new runs only" filter is deterministic.
  polls.forEach((p, i) => {
    const data = results[i];
    if (!data) return;
    let deps = data.departures || [];
    if (p.metroOnly) deps = deps.filter(d => METRO_ROUTE_IDS.includes(d.route_id));
    if (!p.base) deps = deps.filter(d => !allRuns[d.run_id]);
    allDepartures.push(...deps);
    Object.assign(allRuns, data.runs || {});
  });

  // Deduplicate by run_id + stop_id
  const seen = new Set();
  const departures = allDepartures.filter(d => {
    const key = `${d.run_id}:${d.stop_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const resp = json({ fetched_at: new Date().toISOString(), departures, runs: allRuns });
  resp.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return cors(resp);
}

// HMAC-SHA1 sign the request the way the PTV Timetable API requires, using Web Crypto.
async function signedUrl(apiPath, devId, apiKey) {
  const sep = apiPath.includes('?') ? '&' : '?';
  const withDevId = `${apiPath}${sep}devid=${devId}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(apiKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(withDevId));
  const signature = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${API_BASE}${withDevId}&signature=${signature}`;
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
