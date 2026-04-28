/**
 * PTV Live Maps - Cloudflare Worker API Proxy
 *
 * This worker sits between the browser and the PTV Timetable API.
 * It handles HMAC-SHA1 request signing and adds CORS headers so
 * the GitHub Pages frontend can call the PTV API safely.
 *
 * Deploy steps (see README.md for full instructions):
 *   1. Install Wrangler: npm install -g wrangler
 *   2. Login: wrangler login
 *   3. Add secrets:
 *        wrangler secret put PTV_DEV_ID
 *        wrangler secret put PTV_API_KEY
 *   4. Deploy: wrangler deploy
 *   5. Copy the worker URL into config.js → PROXY_URL
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(request, env) {

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // ── Validate path parameter ──
    const url  = new URL(request.url);
    const path = url.searchParams.get('path') || '';

    if (!path.startsWith('/v3/')) {
      return json({ error: 'Invalid path - must start with /v3/' }, 400);
    }

    // Prevent path traversal
    if (path.includes('..') || path.includes('%2e%2e')) {
      return json({ error: 'Invalid path' }, 400);
    }

    // ── Check secrets are configured ──
    if (!env.PTV_DEV_ID || !env.PTV_API_KEY) {
      console.error('[ptv-proxy] PTV_DEV_ID or PTV_API_KEY not set');
      return json({ error: 'Worker not configured - add PTV_DEV_ID and PTV_API_KEY secrets' }, 503);
    }

    // ── Sign and proxy to PTV API ──
    try {
      const signedUrl = await buildSignedUrl(path, env.PTV_DEV_ID, env.PTV_API_KEY);

      const ptvRes = await fetch(signedUrl, {
        headers: { 'Accept': 'application/json' },
      });

      const body = await ptvRes.text();

      return new Response(body, {
        status: ptvRes.status,
        headers: {
          ...CORS,
          'Content-Type':  'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });

    } catch (err) {
      console.error('[ptv-proxy] Fetch error:', err.message);
      return json({ error: 'Upstream fetch failed', detail: err.message }, 502);
    }
  },
};

// ──────────────────────────────────────────────────────────────
//  Build a PTV-signed URL using HMAC-SHA-1 (Web Crypto API)
// ──────────────────────────────────────────────────────────────
async function buildSignedUrl(path, devId, apiKey) {
  // Append devid before signing (PTV requirement)
  const separator = path.includes('?') ? '&' : '?';
  const withDevId = `${path}${separator}devid=${devId}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(apiKey);
  const msgData = encoder.encode(withDevId);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const signature = hexEncode(new Uint8Array(sigBuffer)).toUpperCase();

  return `https://timetableapi.ptv.vic.gov.au${withDevId}&signature=${signature}`;
}

function hexEncode(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
