// =============================================================
//  PTV Live Maps - Configuration
//  No proxy needed - GitHub Actions fetches data server-side.
// =============================================================

const CONFIG = {
  // ---- Data sources ----
  NETWORK_DATA_URL: 'data/network.json', // routes + stops (static, built from GTFS)
  LIVE_DATA_URL:    '/api/departures',   // live departures, signed server-side by the Pages Function

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
  // How often the frontend re-polls /api/departures (the Pages Function edge-caches ~60s).
  // Cache-busting query param is appended so the browser always gets the latest version.
  LIVE_REFRESH_MS: 60000, // 60s - data only changes every ~60s, no gain polling faster

  // ---- Live GPS layer (real positions via the Cloudflare Worker / GTFS-Realtime) ----
  // Deploy worker/ then paste its URL here, e.g. 'https://ptv-gtfsr.<subdomain>.workers.dev'.
  // Leave empty to disable the real-GPS layer (the timetable layer keeps working unchanged).
  WORKER_URL:     'https://ptv-live-maps.pages.dev/api/vehicles',
  GPS_REFRESH_MS: 20000,    // poll the endpoint every 20s (matches its 20s edge cache)
  GPS_COLOR:      '#00E5FF', // accent colour for real-GPS trains (distinct from timetable dots)

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

    // V/Line regional routes (demo IDs - real IDs assigned by API after first network fetch)
    3001: { name: 'Geelong / Warrnambool', color: '#00B2A9', totalMinutes: 195, group: 'vline' },
    3002: { name: 'Ballarat',              color: '#7B2D8B', totalMinutes: 105, group: 'vline' },
    3003: { name: 'Bendigo',               color: '#D4006A', totalMinutes: 120, group: 'vline' },
    3004: { name: 'Gippsland',             color: '#E57200', totalMinutes: 200, group: 'vline' },
    3005: { name: 'Seymour / Albury',      color: '#00629B', totalMinutes: 190, group: 'vline' },
  },

  // ---- V/Line name -> display config (used by fetch-network.js for dynamic route IDs) ----
  VLINE_ROUTES: {
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
  },

  // ---- Visual ----
  ROUTE_WEIGHT:   2.5,
  ROUTE_OPACITY:  0.75,
  TRAIN_DOT_SIZE: 12,

  // Stale run removal threshold (multiples of LIVE_REFRESH_MS)
  STALE_MULTIPLIER: 6,
  // ---- Demo mode stop sequences (used when no real API data is available) ----
  // Ordered stop ID arrays from seeded network.json (terminus -> city or vice versa).
  // Trains bounce back and forth so the map looks alive before the API key is added.
  DEMO_STOPS: {
    3:  [1019, 1169, 1197, 1067, 1038, 1163, 1057, 1181, 1068, 1071], // Craigieburn
    15: [1014, 1209, 1102, 1135, 1025, 1046, 1068, 1071],             // Sunbury
    7:  [1118, 1183, 1162, 1064, 1031, 1006, 1165, 1027, 1042, 1147, 1071], // Hurstbridge
    9:  [1153, 1001, 1091, 1173, 1076, 1086, 1003, 1066, 1147, 1071], // Mernda
    5:  [1043, 1054, 1100, 1022, 1039, 1011, 1013, 1071],             // Frankston
    17: [1196, 1126, 1087, 1032, 1099, 1046, 1068, 1071],             // Werribee
    16: [1050, 1037, 1157, 1030, 1164, 1181, 1068, 1071],             // Upfield
    4:  [1167, 1172, 1133, 1185, 1145, 1011, 1013, 1071],             // Cranbourne
    11: [1131, 1172, 1133, 1185, 1145, 1011, 1013, 1071],             // Pakenham
    2:  [1020, 1082, 1122, 1090, 1112, 1130, 1051, 1071],             // Belgrave
    8:  [1154, 1088, 1090, 1112, 1130, 1051, 1071],                   // Lilydale
    6:  [1053, 1112, 1130, 1051, 1071],                               // Glen Waverley (approx)
    1:  [1127, 1130, 1119, 1095, 1051, 1071],                         // Alamein
    12: [1180, 1143, 1137, 1041, 1016, 1013],                         // Sandringham
    18: [1202, 1186, 1080, 1099, 1046, 1068, 1071],                   // Williamstown

    // V/Line regional (stop IDs 3001+ are seeded in data/network.json)
    3001: [3002, 3001, 3013, 3014, 1046, 1068],  // Warrnambool → Geelong → Southern Cross
    3002: [3010, 3003, 1176, 1025, 1068],          // Ararat → Ballarat → Southern Cross
    3003: [3004, 3033, 3031, 1014, 1025, 1068],    // Bendigo → Castlemaine → Sunbury → Southern Cross
    3004: [3006, 3012, 3005, 3011, 1177, 1008, 1068], // Bairnsdale → Sale → Traralgon → Dandenong → Southern Cross
    3005: [3008, 3007, 3050, 1001, 1147, 1068],    // Albury → Seymour → Epping → Clifton Hill → Southern Cross
  },
};
