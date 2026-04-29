/**
 * fetch-network.js
 *
 * Run by GitHub Actions once daily (and manually on first setup).
 * Fetches all Melbourne metro train routes and their stop sequences
 * from the PTV API, and writes data/network.json.
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

const OUT_PATH = path.resolve(__dirname, '../../data/network.json');

const ROUTE_CONFIG = {
  1:  { name: 'Alamein',       color: '#094FA3', totalMinutes: 30  },
  2:  { name: 'Belgrave',      color: '#094FA3', totalMinutes: 70  },
  3:  { name: 'Craigieburn',   color: '#F7A500', totalMinutes: 58  },
  4:  { name: 'Cranbourne',    color: '#16B4E8', totalMinutes: 65  },
  5:  { name: 'Frankston',     color: '#008B50', totalMinutes: 67  },
  6:  { name: 'Glen Waverley', color: '#094FA3', totalMinutes: 47  },
  7:  { name: 'Hurstbridge',   color: '#E4222B', totalMinutes: 65  },
  8:  { name: 'Lilydale',      color: '#094FA3', totalMinutes: 66  },
  9:  { name: 'Mernda',        color: '#E4222B', totalMinutes: 70  },
  11: { name: 'Pakenham',      color: '#16B4E8', totalMinutes: 75  },
  12: { name: 'Sandringham',   color: '#F0A0C8', totalMinutes: 35  },
  14: { name: 'Stony Point',   color: '#888888', totalMinutes: 90  },
  15: { name: 'Sunbury',       color: '#F7A500', totalMinutes: 65  },
  16: { name: 'Upfield',       color: '#F7A500', totalMinutes: 45  },
  17: { name: 'Werribee',      color: '#008B50', totalMinutes: 55  },
  18: { name: 'Williamstown',  color: '#008B50', totalMinutes: 40  },
};

// V/Line route name -> config (matched by name since IDs vary)
const VLINE_CONFIG = {
  'Geelong':        { color: '#00B2A9', totalMinutes: 75  },
  'Geelong Fast':   { color: '#00B2A9', totalMinutes: 55  },
  'Warrnambool':    { color: '#00B2A9', totalMinutes: 195 },
  'Ballarat':       { color: '#7B2D8B', totalMinutes: 105 },
  'Ararat':         { color: '#7B2D8B', totalMinutes: 150 },
  'Maryborough':    { color: '#7B2D8B', totalMinutes: 155 },
  'Bendigo':        { color: '#D4006A', totalMinutes: 120 },
  'Swan Hill':      { color: '#D4006A', totalMinutes: 235 },
  'Echuca':         { color: '#D4006A', totalMinutes: 200 },
  'Traralgon':      { color: '#E57200', totalMinutes: 135 },
  'Bairnsdale':     { color: '#E57200', totalMinutes: 200 },
  'Seymour':        { color: '#00629B', totalMinutes: 90  },
  'Shepparton':     { color: '#00629B', totalMinutes: 165 },
  'Albury':         { color: '#00629B', totalMinutes: 190 },
};

function vlineConfig(routeName) {
  for (const [key, cfg] of Object.entries(VLINE_CONFIG)) {
    if (routeName.toLowerCase().includes(key.toLowerCase())) return cfg;
  }
  return { color: '#888888', totalMinutes: 120 };
}

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

function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cumDistKm(stops) {
  const d = [0];
  for (let i = 1; i < stops.length; i++) {
    const p = stops[i - 1], c = stops[i];
    d.push(d[i - 1] + haversineKm(p.stop_latitude, p.stop_longitude, c.stop_latitude, c.stop_longitude));
  }
  return d;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const network = { updated_at: new Date().toISOString(), routes: {}, stops: {} };

  // ── Metro (route_type=0) ──────────────────────────────────────────────────
  console.log('Fetching metro routes...');
  const metroData   = await fetchJSON(signedUrl('/v3/routes?route_types=0'));
  const metroRoutes = (metroData.routes || []).filter(r => ROUTE_CONFIG[r.route_id]);
  console.log(`Found ${metroRoutes.length} metro routes`);

  for (const route of metroRoutes) {
    const cfg = ROUTE_CONFIG[route.route_id];
    console.log(`  Fetching stops for ${cfg.name} (route ${route.route_id})...`);
    await sleep(400);
    try {
      const stopsData = await fetchJSON(
        signedUrl(`/v3/stops/route/${route.route_id}/route_type/0?direction_id=0`)
      );
      const stops = (stopsData.stops || [])
        .filter(s => s.stop_latitude && s.stop_longitude)
        .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));

      network.routes[route.route_id] = {
        id: route.route_id, name: cfg.name, color: cfg.color,
        totalMinutes: cfg.totalMinutes,
        stopIds:   stops.map(s => s.stop_id),
        stopDists: cumDistKm(stops),
      };
      stops.forEach(s => {
        if (!network.stops[s.stop_id]) {
          network.stops[s.stop_id] = {
            id: s.stop_id,
            name: (s.stop_name || '').replace(/ Station$/, ''),
            lat: s.stop_latitude, lng: s.stop_longitude,
          };
        }
      });
      console.log(`    ${stops.length} stops`);
    } catch (err) {
      console.error(`    Failed for route ${route.route_id}: ${err.message}`);
    }
  }

  // ── V/Line (route_type=3) ─────────────────────────────────────────────────
  console.log('\nFetching V/Line routes...');
  await sleep(400);
  const vlineData   = await fetchJSON(signedUrl('/v3/routes?route_types=3'));
  const vlineRoutes = (vlineData.routes || []);
  console.log(`Found ${vlineRoutes.length} V/Line routes`);

  for (const route of vlineRoutes) {
    const cfg = vlineConfig(route.route_name || '');
    const name = (route.route_name || '').replace(/^V\/Line /, '').trim();
    console.log(`  Fetching stops for ${name} (route ${route.route_id})...`);
    await sleep(400);
    try {
      const stopsData = await fetchJSON(
        signedUrl(`/v3/stops/route/${route.route_id}/route_type/3?direction_id=0`)
      );
      const stops = (stopsData.stops || [])
        .filter(s => s.stop_latitude && s.stop_longitude)
        .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));

      network.routes[route.route_id] = {
        id: route.route_id, name, color: cfg.color,
        totalMinutes: cfg.totalMinutes,
        stopIds:   stops.map(s => s.stop_id),
        stopDists: cumDistKm(stops),
      };
      stops.forEach(s => {
        if (!network.stops[s.stop_id]) {
          network.stops[s.stop_id] = {
            id: s.stop_id,
            name: (s.stop_name || '').replace(/ Station$/, ''),
            lat: s.stop_latitude, lng: s.stop_longitude,
          };
        }
      });
      console.log(`    ${stops.length} stops`);
    } catch (err) {
      console.error(`    Failed for V/Line route ${route.route_id}: ${err.message}`);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(network));

  const routeCount = Object.keys(network.routes).length;
  const stopCount  = Object.keys(network.stops).length;
  console.log(`\nWrote ${routeCount} routes and ${stopCount} stops to data/network.json`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
