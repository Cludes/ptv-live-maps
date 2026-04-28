/**
 * PTV Live Maps - Netlify Function Proxy (alternative to Cloudflare Worker)
 *
 * Deploy by pushing to a Netlify-linked repo. Set environment variables:
 *   PTV_DEV_ID  - your PTV developer ID
 *   PTV_API_KEY - your PTV API key
 *
 * Then set PROXY_URL in config.js to:
 *   '/.netlify/functions/ptv-proxy'
 */

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  const path = event.queryStringParameters?.path || '';

  if (!path.startsWith('/v3/')) {
    return { statusCode: 400, headers: CORS, body: 'Invalid path' };
  }

  if (path.includes('..')) {
    return { statusCode: 400, headers: CORS, body: 'Invalid path' };
  }

  const devId  = process.env.PTV_DEV_ID;
  const apiKey = process.env.PTV_API_KEY;

  if (!devId || !apiKey) {
    return {
      statusCode: 503,
      headers: CORS,
      body: JSON.stringify({ error: 'PTV_DEV_ID and PTV_API_KEY environment variables not set' }),
    };
  }

  const separator = path.includes('?') ? '&' : '?';
  const withDevId = `${path}${separator}devid=${devId}`;
  const signature = crypto
    .createHmac('sha1', apiKey)
    .update(withDevId)
    .digest('hex')
    .toUpperCase();

  const signedUrl = `https://timetableapi.ptv.vic.gov.au${withDevId}&signature=${signature}`;

  try {
    const res  = await fetch(signedUrl, { headers: { 'Accept': 'application/json' } });
    const body = await res.text();

    return {
      statusCode: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Upstream error', detail: err.message }),
    };
  }
};
