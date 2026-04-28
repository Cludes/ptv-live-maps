/**
 * fetch-trains.js
 *
 * Run by GitHub Actions every 5 minutes.
 * Fetches current metro train departures from Flinders Street via PTV API,
 * signs the request with HMAC-SHA1, and writes data/live.json.
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

const OUT_PATH = path.resolve(__dirname, '../../data/live.json');

// Melbourne metro route IDs
const METRO_ROUTE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18];

// ── Helpers ───────────────────────────────────────────────────────────────────

function signedUrl(apiPath) {
  if (!DEV_ID || !API_KEY) throw new Error('PTV_DEV_ID or PTV_API_KEY not set');
  const sep       = apiPath.includes('?') ? '&' : '?';
  const withDevId = `${apiPath}${sep}devid=${DEV_ID}`;
  const signature = crypto.createHmac('sha1', API_KEY).update(withDevId).digest('hex').toUpperCase();
  return `https://timetableapi.ptv.vic.gov.au${withDevId}&signature=${signature}`;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const allDepartures = [];
  const allRuns       = {};

  // Fetch departures from Flinders Street (stop 1071) for all metro routes
  // The ?expand=run parameter inlines run details so we don't need extra calls
  const path1 =
    `/v3/departures/route_type/0/stop/1071` +
    `?expand=run&max_results=150&look_backwards=false`;

  console.log('Fetching departures from Flinders Street...');
  try {
    const data = await fetchJSON(signedUrl(path1));
    const deps = (data.departures || []).filter(d => METRO_ROUTE_IDS.includes(d.route_id));
    allDepartures.push(...deps);
    Object.assign(allRuns, data.runs || {});
    console.log(`  Got ${deps.length} metro departures`);
  } catch (err) {
    console.error(`  Flinders Street fetch failed: ${err.message}`);
  }

  // Also fetch from a few outer terminuses to capture trains that don't stop at Flinders St
  const outerStops = [
    { id: 1080, name: 'Hurstbridge'   },
    { id: 1109, name: 'Lilydale'      },
    { id: 1008, name: 'Belgrave'      },
    { id: 1025, name: 'Frankston'     },
    { id: 1037, name: 'Dandenong'     },
    { id: 1178, name: 'Sunbury'       },
    { id: 1038, name: 'Werribee'      },
  ];

  for (const stop of outerStops) {
    await sleep(300); // small pause to avoid burst rate limiting
    const p = `/v3/departures/route_type/0/stop/${stop.id}?expand=run&max_results=20&look_backwards=false`;
    try {
      const data = await fetchJSON(signedUrl(p));
      const deps = (data.departures || []).filter(d => METRO_ROUTE_IDS.includes(d.route_id));
      // Only add runs not already captured from Flinders St
      const newDeps = deps.filter(d => !allRuns[d.run_id]);
      allDepartures.push(...newDeps);
      Object.assign(allRuns, data.runs || {});
      if (newDeps.length) console.log(`  ${stop.name}: +${newDeps.length} additional runs`);
    } catch (err) {
      console.warn(`  ${stop.name} fetch failed (non-fatal): ${err.message}`);
    }
  }

  // Deduplicate by run_id + stop_id
  const seen    = new Set();
  const unique  = allDepartures.filter(d => {
    const key = `${d.run_id}:${d.stop_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const output = {
    fetched_at:  new Date().toISOString(),
    departures:  unique,
    runs:        allRuns,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));

  console.log(`\nWrote ${unique.length} departures across ${Object.keys(allRuns).length} runs to data/live.json`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
