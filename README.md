# PTV Live - Melbourne Train Tracker

A live Melbourne metro train tracking web app built on the [PTV Timetable API](https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/). Trains are displayed as animated dots moving along their routes in real time on an interactive dark map.

**Live site:** https://cludes.github.io/ptv-live-maps/

---

## What it looks like

- Dark map (CartoDB Dark Matter) centered on Melbourne
- Colored polylines for each of the 16 metro train lines
- Small glowing dots for each active service, moving smoothly between stations
- Click any dot to see route, destination, run ID, delay status
- Filter by line, toggle stations/routes/trains, search for any station
- Updates every 30 seconds

---

## How train positions work

The PTV API provides **timetable departure data**, not live GPS positions. The app uses a realistic interpolation model:

1. Departures are fetched from Flinders Street Station (the main city hub) every 30 seconds
2. Each departure record tells us: which run, which route, the scheduled/estimated departure time
3. Using the ordered stop sequence for each route and the approximate end-to-end journey time, the app calculates which segment the train is currently on
4. The dot is lerped (linearly interpolated) between consecutive station coordinates each animation frame

This gives smooth, realistic movement. Accuracy is proportional to how close the timetable is to reality - delays are shown visually when the API reports them.

---

## Setup

### Step 1 - Get PTV API credentials

1. Go to https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/
2. Fill in the API access request form - you will receive:
   - A **Developer ID** (number)
   - An **API Key** (long string)
3. Keep these secret - they go into your proxy, not your frontend code

---

### Step 2 - Deploy the API proxy

The PTV API does not support CORS, so you need a small server-side proxy to forward requests. Two options:

#### Option A: Cloudflare Workers (recommended - free, fast, global)

1. Create a free account at https://workers.cloudflare.com/
2. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
3. Add your PTV credentials as secrets (never stored in code):
   ```bash
   wrangler secret put PTV_DEV_ID
   # paste your Developer ID when prompted

   wrangler secret put PTV_API_KEY
   # paste your API key when prompted
   ```
4. Deploy the worker from this repo:
   ```bash
   wrangler deploy
   ```
5. Copy the worker URL shown (e.g. `https://ptv-proxy.yourname.workers.dev`)

#### Option B: Netlify Functions

1. Connect this repo to a [Netlify](https://netlify.com) site
2. In Netlify site settings, go to **Environment Variables** and add:
   - `PTV_DEV_ID` = your developer ID
   - `PTV_API_KEY` = your API key
3. Push to trigger a deploy - the function at `netlify/functions/ptv-proxy.js` deploys automatically
4. Your proxy URL will be `https://your-site.netlify.app/.netlify/functions/ptv-proxy`

---

### Step 3 - Configure the frontend

Open `config.js` and set `PROXY_URL` to the URL from Step 2:

```js
PROXY_URL: 'https://ptv-proxy.yourname.workers.dev',
// or for Netlify:
PROXY_URL: 'https://your-site.netlify.app/.netlify/functions/ptv-proxy',
```

---

### Step 4 - Enable GitHub Pages

1. Push all files to the `master` branch of your GitHub repo
2. In the repo settings, go to **Pages**
3. Set source to **Deploy from a branch**, select `master`, folder `/` (root)
4. Your live URL will be `https://yourusername.github.io/ptv-live-maps/`

No build step required - it's all static files served directly.

---

## File structure

```
ptv-live-maps/
- index.html                  Main page (map + UI)
- styles.css                  Dark theme styles
- config.js                   Configuration (set PROXY_URL here)
- script.js                   Main app logic
- worker.js                   Cloudflare Worker proxy
- wrangler.toml               Cloudflare Workers config
- netlify/
  - functions/
    - ptv-proxy.js            Netlify Function proxy (alternative)
- netlify.toml                Netlify deployment config
- package.json                Dev tooling deps
- .gitignore
- README.md
```

---

## Local development

To test locally without deploying:

```bash
# Option A - Cloudflare Worker local dev
npm install
# Create .dev.vars with your credentials (gitignored):
echo "PTV_DEV_ID=your_dev_id" >> .dev.vars
echo "PTV_API_KEY=your_api_key" >> .dev.vars
wrangler dev
# Worker runs at http://localhost:8787
# Set config.js PROXY_URL = 'http://localhost:8787' then open index.html
```

Or just open `index.html` directly in a browser after the proxy is deployed and PROXY_URL is set.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `F` | Toggle fullscreen |
| `Esc` | Close train info / clear search |

---

## Customisation

| Setting in `config.js` | Default | What it does |
|------------------------|---------|--------------|
| `LIVE_REFRESH_MS` | 30000 | How often to poll the API (ms) |
| `BOOTSTRAP_CACHE_MS` | 3600000 | How long to cache route/stop data (ms) |
| `ROUTE_WEIGHT` | 2.5 | Polyline thickness |
| `ROUTE_OPACITY` | 0.75 | Polyline opacity |
| `TRAIN_DOT_SIZE` | 12 | Train dot diameter (px) |
| `HUB_STOP_ID` | 1071 | Stop to fetch departures from (1071 = Flinders St) |

---

## Limitations

- **No real GPS** - position is interpolated from timetable data. Trains follow the schedule, not actual hardware positions.
- **Flinders Street hub** - only trains that stop at Flinders Street are captured. Services originating from other stations (e.g. some Stony Point services) may not appear.
- **Rate limiting** - the app fetches once per 30 seconds which is well within PTV's guidelines. Do not lower `LIVE_REFRESH_MS` below 10 seconds.
- **Route shapes** - stop-to-stop lines are straight. The PTV API doesn't provide shape polylines; exact curves would require the GTFS feed.

---

## Improving accuracy with GTFS data

For pixel-perfect route curves, download the PTV GTFS feed:

1. Go to https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/gtfs-data/
2. Download `google_transit.zip`
3. Extract `shapes.txt` - this contains detailed polyline coordinates for every route
4. Convert to GeoJSON and reference it in `script.js` `renderNetwork()` instead of the stop-to-stop lines

---

## Future improvements

- GTFS shape data for accurate curved route lines
- "Near me" button using device geolocation
- Service alerts from the PTV disruptions API
- Multiple hub stops to capture more active services
- Train schedule table for clicked station
- Dark/light theme toggle
- Accessibility improvements

---

## Attribution

Transit data licensed from **Public Transport Victoria** under a
[Creative Commons Attribution 4.0 International Licence](https://creativecommons.org/licenses/by/4.0/).

Map tiles by [CARTO](https://carto.com/attributions), data by [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
