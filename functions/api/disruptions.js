/**
 * Cloudflare Pages Function - GET /api/disruptions
 *
 * Replaces the old GitHub Actions job that committed data/disruptions.json. Signs
 * the PTV Timetable API request server-side and returns current metro + regional
 * rail disruptions in the shape the frontend already consumes:
 * { fetched_at, disruptions:[{ id, title, type, url, routes }] }.
 *
 * Env (Pages project -> Settings -> Variables and Secrets):
 *   PTV_DEV_ID   - the PTV Timetable API User ID (devid), encrypted secret
 *   PTV_API_KEY  - the PTV Timetable API key (HMAC secret), encrypted secret
 */

const API_BASE = 'https://timetableapi.ptv.vic.gov.au';
const CACHE_TTL = 300; // disruptions change slowly; 5-minute edge cache is plenty

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.PTV_DEV_ID || !env.PTV_API_KEY) {
    return cors(json({ fetched_at: null, disruptions: [] }));
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + '/__disruptions', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  let data;
  try {
    const url = await signedUrl('/v3/disruptions?route_types=0&route_types=3', env.PTV_DEV_ID, env.PTV_API_KEY);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return cors(json({ error: `upstream HTTP ${res.status}` }, 502));
    data = await res.json();
  } catch (e) {
    return cors(json({ error: 'upstream fetch failed', detail: String(e) }, 502));
  }

  const now = Date.now();
  const all = [
    ...(data.disruptions?.metro_train || []),
    ...(data.disruptions?.regional_train || []),
  ];

  const disruptions = [];
  for (const d of all) {
    if (d.disruption_status !== 'Current') continue;
    if (d.to_date && Date.parse(d.to_date) < now) continue;
    disruptions.push({
      id: d.disruption_id,
      title: d.title,
      type: d.disruption_type || 'Disruption',
      url: d.url || null,
      routes: (d.routes || []).map(r => r.route_id),
    });
  }

  const resp = json({ fetched_at: new Date().toISOString(), disruptions });
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
