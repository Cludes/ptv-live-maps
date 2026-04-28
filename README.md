# PTV Live - Melbourne Train Tracker

A live Melbourne metro train tracker for GitHub Pages, powered by the [PTV Timetable API](https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/).

GitHub Actions fetches train departure data every ~60 seconds and commits it to the repo. GitHub Pages serves the result as a static site - no external servers, no proxies.

**Live site:** https://cludes.github.io/ptv-live-maps/

---

## How it works

```
GitHub Actions (every 5 min, 5 fetches inside each run)
    └─ Signs PTV API request with HMAC-SHA1
    └─ Writes data/live.json + data/network.json
    └─ Commits and pushes

GitHub Pages
    └─ Serves index.html + data/*.json as static files

Browser (60fps animation)
    └─ Reads data/live.json every 30s
    └─ Interpolates train positions between stops every frame
    └─ Trains move smoothly regardless of data refresh rate
```

The API key is stored as a GitHub repository secret and never exposed to the browser.

---

## Setup (5 steps)

### 1. Get PTV API credentials

Request access at: https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/

You'll receive by email:
- A **Developer ID** (number)
- An **API Key** (long string)

### 2. Add repository secrets

In your GitHub repo, go to **Settings - Secrets and variables - Actions** and add:

| Secret name   | Value                    |
|---------------|--------------------------|
| `PTV_DEV_ID`  | Your PTV Developer ID    |
| `PTV_API_KEY` | Your PTV API Key         |

The `CLUDESAPP_ID` and `CLUDESAPP_PEM` secrets (for GitHub App authentication) should already be in place.

### 3. Enable GitHub Pages

In your GitHub repo, go to **Settings - Pages**:
- Source: **Deploy from a branch**
- Branch: `master`, folder: `/ (root)`

### 4. Populate network data (first time only)

Go to **Actions - Fetch Network Data (Routes + Stops) - Run workflow**.

This fetches all Melbourne metro routes and stops and commits `data/network.json`. Takes about 2 minutes.

### 5. Trigger the first live data fetch

Go to **Actions - Fetch Live Train Data - Run workflow**.

After this runs, trains will appear on the map. The scheduled workflow then keeps data fresh automatically.

---

## Data refresh

The live train workflow runs on GitHub's 5-minute cron, but runs **5 fetches inside each workflow** with ~60-second gaps between them. This gives roughly 1-minute data freshness.

The browser-side animation runs at ~60fps continuously using position interpolation, so trains appear to move smoothly even between data updates.

---

## File structure

```
ptv-live-maps/
- index.html                            Map UI
- styles.css                            Dark theme
- config.js                             Route colours and settings
- script.js                             App logic and animation
- data/
  - network.json                        Routes + stops (updated daily)
  - live.json                           Current departures (updated ~60s)
- .github/
  - workflows/
    - fetch-trains.yml                  Scheduled live data workflow
    - fetch-network.yml                 Daily network data workflow
  - scripts/
    - fetch-trains.js                   PTV API fetcher (departures)
    - fetch-network.js                  PTV API fetcher (routes + stops)
```

---

## Keyboard shortcuts

| Key   | Action                          |
|-------|-------------------------------|
| `F`   | Toggle fullscreen               |
| `Esc` | Close train info / clear search |

---

## Configuration

Edit `config.js` to adjust behaviour:

| Setting             | Default | What it does                           |
|---------------------|---------|----------------------------------------|
| `LIVE_REFRESH_MS`   | 30000   | How often the browser re-reads live.json |
| `ROUTE_WEIGHT`      | 2.5     | Route line thickness                   |
| `ROUTE_OPACITY`     | 0.75    | Route line opacity                     |
| `TRAIN_DOT_SIZE`    | 12      | Train dot size (px)                    |
| `STALE_MULTIPLIER`  | 6       | Cycles before removing an unseen train |

---

## Limitations

- **Timetable-based positioning** - trains are interpolated from scheduled departure times, not live GPS. Position accuracy matches timetable accuracy.
- **~1 min data lag** - GitHub Actions has a 5-minute minimum cron, worked around with a fetch loop.
- **Flinders Street + outer terminuses** - trains that neither start nor stop at these hubs may not appear.

---

## Attribution

Transit data licensed from **Public Transport Victoria** under a [Creative Commons Attribution 4.0 International Licence](https://creativecommons.org/licenses/by/4.0/).

Map tiles by [CARTO](https://carto.com/attributions), data by [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
