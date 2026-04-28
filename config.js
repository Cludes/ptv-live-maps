// =============================================================
//  PTV Live Maps - Configuration
//  No proxy needed - GitHub Actions fetches data server-side.
// =============================================================

const CONFIG = {
  // ---- Data files (written by GitHub Actions, served by GitHub Pages) ----
  NETWORK_DATA_URL: 'data/network.json', // routes + stops (updated daily)
  LIVE_DATA_URL:    'data/live.json',    // current departures (updated every 5 min)

  // ---- Map ----
  MAP_CENTER: [-37.8136, 144.9631], // Melbourne CBD
  MAP_ZOOM:    11,
  MAP_MIN_ZOOM: 9,
  MAP_MAX_ZOOM: 18,

  // CartoDB Dark Matter - no API key required
  TILE_URL: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  TILE_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a> | ' +
    'Transit data &copy; <a href="https://www.ptv.vic.gov.au/">Public Transport Victoria</a>',

  // ---- Refresh ----
  // How often the frontend re-reads data/live.json (GitHub Actions updates it every ~5 min).
  // Cache-busting query param is appended so the browser always gets the latest version.
  LIVE_REFRESH_MS: 30000, // 30s - poll often so we pick up GH Actions updates quickly

  // ---- Melbourne metro routes ----
  ROUTES: {
    1:  { name: 'Alamein',       color: '#094FA3', totalMinutes: 30,  group: 'blue'   },
    2:  { name: 'Belgrave',      color: '#094FA3', totalMinutes: 70,  group: 'blue'   },
    3:  { name: 'Craigieburn',   color: '#F7A500', totalMinutes: 58,  group: 'orange' },
    4:  { name: 'Cranbourne',    color: '#16B4E8', totalMinutes: 65,  group: 'teal'   },
    5:  { name: 'Frankston',     color: '#008B50', totalMinutes: 67,  group: 'green'  },
    6:  { name: 'Glen Waverley', color: '#094FA3', totalMinutes: 47,  group: 'blue'   },
    7:  { name: 'Hurstbridge',   color: '#E4222B', totalMinutes: 65,  group: 'red'    },
    8:  { name: 'Lilydale',      color: '#094FA3', totalMinutes: 66,  group: 'blue'   },
    9:  { name: 'Mernda',        color: '#E4222B', totalMinutes: 70,  group: 'red'    },
    11: { name: 'Pakenham',      color: '#16B4E8', totalMinutes: 75,  group: 'teal'   },
    12: { name: 'Sandringham',   color: '#F0A0C8', totalMinutes: 35,  group: 'pink'   },
    14: { name: 'Stony Point',   color: '#888888', totalMinutes: 90,  group: 'gray'   },
    15: { name: 'Sunbury',       color: '#F7A500', totalMinutes: 65,  group: 'orange' },
    16: { name: 'Upfield',       color: '#F7A500', totalMinutes: 45,  group: 'orange' },
    17: { name: 'Werribee',      color: '#008B50', totalMinutes: 55,  group: 'green'  },
    18: { name: 'Williamstown',  color: '#008B50', totalMinutes: 40,  group: 'green'  },
  },

  // ---- Visual ----
  ROUTE_WEIGHT:   2.5,
  ROUTE_OPACITY:  0.75,
  TRAIN_DOT_SIZE: 12,

  // Stale run removal threshold (multiples of LIVE_REFRESH_MS)
  STALE_MULTIPLIER: 6,
};
