/**
 * fetch-disruptions.js
 *
 * Fetches current PTV service disruptions for metro and regional rail,
 * writes data/disruptions.json. Run once per workflow invocation.
 *
 * Required env vars: PTV_DEV_ID, PTV_API_KEY
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const DEV_ID  = process.env.PTV_DEV_ID;
const API_KEY = process.env.PTV_API_KEY;

const OUT_PATH = path.resolve(__dirname, '../../data/disruptions.json');

function signedUrl(apiPath) {
  if (!DEV_ID || !API_KEY) throw new Error('PTV_DEV_ID or PTV_API_KEY not set');
  const sep       = apiPath.includes('?') ? '&' : '?';
  const withDevId = `${apiPath}${sep}devid=${DEV_ID}`;
  const signature = crypto.createHmac('sha1', API_KEY).update(withDevId).digest('hex').toUpperCase();
  return `https://timetableapi.ptv.vic.gov.au${withDevId}&signature=${signature}`;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching disruptions...');
  const data = await fetchJSON(signedUrl('/v3/disruptions?route_types=0&route_types=3'));

  const now    = Date.now();
  const active = [];

  const all = [
    ...(data.disruptions?.metro_train    || []),
    ...(data.disruptions?.regional_train || []),
  ];

  for (const d of all) {
    if (d.disruption_status !== 'Current') continue;
    if (d.to_date && Date.parse(d.to_date) < now) continue;

    active.push({
      id:     d.disruption_id,
      title:  d.title,
      type:   d.disruption_type  || 'Disruption',
      url:    d.url              || null,
      routes: (d.routes || []).map(r => r.route_id),
    });
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    fetched_at:   new Date().toISOString(),
    disruptions:  active,
  }));

  console.log(`Wrote ${active.length} active disruptions to data/disruptions.json`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
