// =============================================================
//  PTV Live Maps - Configuration
//  Fill in PROXY_URL after deploying your Cloudflare Worker
//  or Netlify Function (see README.md).
// =============================================================

const CONFIG = {
  // ---- Proxy URL (required) ----
  // After deploying worker.js to Cloudflare Workers, paste the URL here.
  // Example: 'https://ptv-proxy.yourname.workers.dev'
  // For Netlify deploy: '/.netlify/functions/ptv-proxy'
  PROXY_URL: 'https://YOUR_WORKER.workers.dev',

  // ---- Map ----
  MAP_CENTER: [-37.8136, 144.9631], // Melbourne CBD
  MAP_ZOOM: 11,
  MAP_MIN_ZOOM: 9,
  MAP_MAX_ZOOM: 18,

  // CartoDB Dark Matter - no API key required
  TILE_URL: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  TILE_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a> | ' +
    'Transit data &copy; <a href="https://www.ptv.vic.gov.au/">Public Transport Victoria</a>',

  // ---- Refresh intervals ----
  LIVE_REFRESH_MS:    30000,    // 30s - fetch live departures
  BOOTSTRAP_CACHE_MS: 3600000, // 1hr - cache static route/stop data in localStorage

  // ---- PTV metro train routes ----
  // route_id -> display config
  // totalMinutes = approximate end-to-end journey time (used for position interpolation)
  ROUTES: {
    1:  { name: 'Alamein',       color: '#094FA3', totalMinutes: 30, group: 'blue'   },
    2:  { name: 'Belgrave',      color: '#094FA3', totalMinutes: 70, group: 'blue'   },
    3:  { name: 'Craigieburn',   color: '#F7A500', totalMinutes: 58, group: 'orange' },
    4:  { name: 'Cranbourne',    color: '#16B4E8', totalMinutes: 65, group: 'teal'   },
    5:  { name: 'Frankston',     color: '#008B50', totalMinutes: 67, group: 'green'  },
    6:  { name: 'Glen Waverley', color: '#094FA3', totalMinutes: 47, group: 'blue'   },
    7:  { name: 'Hurstbridge',   color: '#E4222B', totalMinutes: 65, group: 'red'    },
    8:  { name: 'Lilydale',      color: '#094FA3', totalMinutes: 66, group: 'blue'   },
    9:  { name: 'Mernda',        color: '#E4222B', totalMinutes: 70, group: 'red'    },
    11: { name: 'Pakenham',      color: '#16B4E8', totalMinutes: 75, group: 'teal'   },
    12: { name: 'Sandringham',   color: '#F0A0C8', totalMinutes: 35, group: 'pink'   },
    14: { name: 'Stony Point',   color: '#888888', totalMinutes: 90, group: 'gray'   },
    15: { name: 'Sunbury',       color: '#F7A500', totalMinutes: 65, group: 'orange' },
    16: { name: 'Upfield',       color: '#F7A500', totalMinutes: 45, group: 'orange' },
    17: { name: 'Werribee',      color: '#008B50', totalMinutes: 55, group: 'green'  },
    18: { name: 'Williamstown',  color: '#008B50', totalMinutes: 40, group: 'green'  },
  },

  // ---- API settings ----
  HUB_STOP_ID:     1071, // Flinders Street Station
  MAX_RESULTS:     150,  // Max departures per hub request

  // ---- Visual settings ----
  ROUTE_WEIGHT:    2.5,
  ROUTE_OPACITY:   0.75,
  TRAIN_DOT_SIZE:  12,

  // Stale run removal: remove if not seen after N refreshes
  STALE_MULTIPLIER: 3,
};
