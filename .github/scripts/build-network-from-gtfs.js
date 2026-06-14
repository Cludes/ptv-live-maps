/**
 * build-network-from-gtfs.js
 *
 * Builds data/network.json (and data/gtfs-routes.json) from the static
 * Transport Victoria GTFS Schedule feed - no PTV Timetable API key required.
 *
 * Input: the two extracted GTFS feeds (Metro Train = mode 2, V/Line = mode 1).
 * Get them by downloading the "GTFS Schedule" ZIP from the Open Data Portal,
 * extracting 2/google_transit.zip and 1/google_transit.zip, and extracting those.
 *
 * Usage:
 *   node build-network-from-gtfs.js <metroDir> <vlineDir>
 *   (defaults: C:\tmp\gtfs_metro  C:\tmp\gtfs_vline)
 *
 * Output (../../data, the app's expected schema):
 *   network.json     - { updated_at, routes:{ id,name,color,totalMinutes,stopIds,stopDists,shape }, stops:{ id,name,lat,lng } }
 *   gtfs-routes.json - { <gtfs_route_id>: { name, color, appRouteId } }  (for colouring the live GPS layer)
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const METRO_DIR = process.argv[2] || 'C:\\tmp\\gtfs_metro';
const VLINE_DIR = process.argv[3] || 'C:\\tmp\\gtfs_vline';
const OUT_DIR   = path.resolve(__dirname, '../../data');

// App line metadata (matches config.js ROUTES so legend/colours stay consistent).
const APP = {
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
  3001: { name: 'Geelong / Warrnambool', color: '#00B2A9', totalMinutes: 195 },
  3002: { name: 'Ballarat',              color: '#7B2D8B', totalMinutes: 105 },
  3003: { name: 'Bendigo',               color: '#D4006A', totalMinutes: 120 },
  3004: { name: 'Gippsland',             color: '#E57200', totalMinutes: 200 },
  3005: { name: 'Seymour / Albury',      color: '#00629B', totalMinutes: 190 },
};

// GTFS route code (from route_id, e.g. ALM in "aus:vic:vic-02-ALM:") -> app line id.
const METRO_CODE = { ALM:1, BEG:2, CGB:3, CBE:4, FKN:5, GWY:6, HBE:7, LIL:8, MDD:9, PKM:11, SHM:12, STY:14, SUY:15, UFD:16, WER:17, WIL:18 };
const VLINE_CODE = { GEL:3001, WBL:3001, ART:3002, BAT:3002, MBY:3002, BGO:3003, ECH:3003, SWL:3003, BDE:3004, TRN:3004, ABY:3005, SER:3005, SNH:3005 };

// ── CSV + geo helpers ──────────────────────────────────────────────────────────
function parseCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readRows(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const header = parseCsv(lines[0]);
  return lines.slice(1).map(l => {
    const c = parseCsv(l); const o = {};
    header.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}

function streamRows(file, onRow) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let header = null;
    rl.on('line', line => {
      if (!line.length) return;
      if (!header) { header = parseCsv(line.replace(/^﻿/, '')); return; }
      const c = parseCsv(line);
      const o = {}; header.forEach((h, i) => { o[h] = c[i]; });
      onRow(o);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

function haversineKm(a, b) {
  const R = 6371, dLat = (b[0]-a[0])*Math.PI/180, dLng = (b[1]-a[1])*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function cumDist(coords) {
  const d = [0];
  for (let i = 1; i < coords.length; i++) d.push(d[i-1] + haversineKm(coords[i-1], coords[i]));
  return d.map(v => +v.toFixed(3));
}
function decimate(points, max = 500) {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length-1] !== points[points.length-1]) out.push(points[points.length-1]);
  return out;
}
function routeCode(routeId) {
  const m = routeId.match(/vic-0\d-([A-Z]+)(-R)?:/);
  if (!m) return null;
  return m[2] ? null : m[1]; // skip Replacement Bus (-R)
}

// ── Process one feed (metro or vline) ───────────────────────────────────────────
async function processFeed(dir, codeMap) {
  // routes.txt -> gtfs route_id : appId
  const routeToApp = {};
  for (const r of readRows(path.join(dir, 'routes.txt'))) {
    const code = routeCode(r.route_id);
    const appId = code && codeMap[code];
    if (appId) routeToApp[r.route_id] = appId;
  }

  // trips.txt -> trip_id : { appId, shapeId }
  const tripInfo = {};
  for (const t of readRows(path.join(dir, 'trips.txt'))) {
    const appId = routeToApp[t.route_id];
    if (appId) tripInfo[t.trip_id] = { appId, shapeId: t.shape_id };
  }

  // stop_times pass A: count stops per relevant trip
  const stFile = path.join(dir, 'stop_times.txt');
  const tripCount = {};
  await streamRows(stFile, row => {
    if (tripInfo[row.trip_id]) tripCount[row.trip_id] = (tripCount[row.trip_id] || 0) + 1;
  });

  // pick the longest (most stops) trip per app line = representative full run
  const repTrip = {}, repCount = {};
  for (const [tid, n] of Object.entries(tripCount)) {
    const appId = tripInfo[tid].appId;
    if (n > (repCount[appId] || 0)) { repCount[appId] = n; repTrip[appId] = tid; }
  }
  const chosenTrips  = new Set(Object.values(repTrip));
  const chosenShapes = new Set(Object.values(repTrip).map(t => tripInfo[t].shapeId));

  // stop_times pass B: ordered stop list for chosen trips
  const tripStops = {};
  await streamRows(stFile, row => {
    if (!chosenTrips.has(row.trip_id)) return;
    (tripStops[row.trip_id] = tripStops[row.trip_id] || []).push({ seq: +row.stop_sequence, stop: row.stop_id });
  });

  // shapes pass: ordered points for chosen shapes
  const shapePts = {};
  await streamRows(path.join(dir, 'shapes.txt'), row => {
    if (!chosenShapes.has(row.shape_id)) return;
    (shapePts[row.shape_id] = shapePts[row.shape_id] || []).push({
      seq: +row.shape_pt_sequence, lat: +row.shape_pt_lat, lon: +row.shape_pt_lon,
    });
  });

  // stops.txt: platform -> info, and station aggregation by parent_station
  const platform = {};
  const stationAgg = {};
  for (const s of readRows(path.join(dir, 'stops.txt'))) {
    const lat = +s.stop_lat, lon = +s.stop_lon;
    if (!lat || !lon) continue;
    const name = (s.stop_name || '').replace(/ Station$/, '').trim();
    platform[s.stop_id] = { name, lat, lon, parent: s.parent_station || '' };
    const key = s.parent_station || s.stop_id;
    const agg = stationAgg[key] || (stationAgg[key] = { name, latSum: 0, lonSum: 0, n: 0 });
    agg.latSum += lat; agg.lonSum += lon; agg.n++;
  }
  const stationCoord = key => {
    const a = stationAgg[key];
    return a ? [+(a.latSum/a.n).toFixed(6), +(a.lonSum/a.n).toFixed(6)] : null;
  };

  // build route + stop records
  const routes = {}, stops = {};
  for (const [appIdStr, tid] of Object.entries(repTrip)) {
    const appId = +appIdStr;
    const ordered = (tripStops[tid] || []).sort((a, b) => a.seq - b.seq);
    const stationIds = [];
    for (const { stop } of ordered) {
      const p = platform[stop];
      const key = (p && p.parent) || stop;
      if (stationIds[stationIds.length - 1] !== key) stationIds.push(key);
    }
    const coords = [];
    const keptIds = [];
    for (const key of stationIds) {
      const c = stationCoord(key);
      if (!c) continue;
      keptIds.push(key);
      coords.push(c);
      if (!stops[key]) {
        const nm = (stationAgg[key] && stationAgg[key].name) || (platform[key] && platform[key].name) || key;
        stops[key] = { id: key, name: nm, lat: c[0], lng: c[1] };
      }
    }
    if (keptIds.length < 2) continue;

    const rawShape = (shapePts[tripInfo[tid].shapeId] || []).sort((a, b) => a.seq - b.seq);
    const shape = decimate(rawShape.map(p => [+p.lat.toFixed(5), +p.lon.toFixed(5)]));

    routes[appId] = {
      id: appId,
      name: APP[appId].name,
      color: APP[appId].color,
      totalMinutes: APP[appId].totalMinutes,
      stopIds: keptIds,
      stopDists: cumDist(coords),
      shape,
    };
  }

  return { routes, stops, routeToApp };
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Building network from GTFS...');
  const metro = await processFeed(METRO_DIR, METRO_CODE);
  console.log(`  Metro: ${Object.keys(metro.routes).length} lines, ${Object.keys(metro.stops).length} stations`);
  const vline = await processFeed(VLINE_DIR, VLINE_CODE);
  console.log(`  V/Line: ${Object.keys(vline.routes).length} lines, ${Object.keys(vline.stops).length} stations`);

  const network = {
    updated_at: new Date().toISOString(),
    routes: { ...metro.routes, ...vline.routes },
    stops:  { ...metro.stops,  ...vline.stops },
  };

  // gtfs_route_id -> { name, color, appRouteId }  (every member line, for live GPS colouring)
  const gtfsRoutes = {};
  for (const feed of [metro, vline]) {
    for (const [rid, appId] of Object.entries(feed.routeToApp)) {
      gtfsRoutes[rid] = { name: APP[appId].name, color: APP[appId].color, appRouteId: appId };
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify(network));
  fs.writeFileSync(path.join(OUT_DIR, 'gtfs-routes.json'), JSON.stringify(gtfsRoutes, null, 2));

  console.log(`\nWrote ${Object.keys(network.routes).length} routes, ${Object.keys(network.stops).length} stops to data/network.json`);
  console.log(`Wrote ${Object.keys(gtfsRoutes).length} gtfs route mappings to data/gtfs-routes.json`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
