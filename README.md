# PTV Live - Melbourne Train Tracker

[![Deploy to Cloudflare Pages](https://github.com/Cludes/ptv-live-maps/actions/workflows/deploy-cf-pages.yml/badge.svg)](https://github.com/Cludes/ptv-live-maps/actions/workflows/deploy-cf-pages.yml)

A live Melbourne metro + V/Line train tracker, powered by the [PTV Timetable API](https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/) and hosted on Cloudflare Pages.

Live departures are signed and fetched server-side by a Cloudflare Pages Function, so the PTV API key never reaches the browser. A separate additive layer plots real GPS positions from the Transport Victoria GTFS-Realtime feed.

**Live site:** https://ptv-live-maps.pages.dev/

---

## How it works

```
Cloudflare Pages Functions (same origin as the site)
    /api/departures  - signs PTV Timetable API with HMAC-SHA1, returns departures, edge-cached ~60s
    /api/disruptions - current metro + regional rail disruptions, edge-cached ~5 min
    /api/vehicles    - GTFS-Realtime vehicle positions (real GPS layer)

Browser (60fps animation)
    └─ Polls /api/departures every 60s
    └─ Interpolates train positions between stops every frame
    └─ Trains move smoothly regardless of data refresh rate
```

The static network (routes, stops, track geometry) is built from the static GTFS feed and served from `data/network.json`. The PTV credentials are stored only as encrypted Cloudflare Pages secrets and never exposed to the browser.

---

## Setup

### 1. Get PTV Timetable API credentials

Request access at: https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/ptv-timetable-api/

You'll receive by email a **User ID** (devid) and an **API Key**.

### 2. Add them as Cloudflare Pages secrets

In the Cloudflare dashboard: **Workers & Pages - ptv-live-maps - Settings - Variables and Secrets**, add two encrypted secrets:

| Secret name   | Value                 |
|---------------|-----------------------|
| `PTV_DEV_ID`  | Your PTV User ID      |
| `PTV_API_KEY` | Your PTV API Key      |

(`PTV_KEYID`, the GTFS-Realtime Subscription Key, powers the optional real-GPS layer at `/api/vehicles`.)

Alternatively, if the same values are stored as GitHub repo secrets, run the **Sync PTV secrets to Cloudflare Pages** workflow to copy them across without exposing the values.

Cloudflare binds secrets at deploy time, so re-run **Deploy to Cloudflare Pages** after adding or changing them.

### 3. Deploy

Every push to `master` triggers the **Deploy to Cloudflare Pages** workflow, which builds the static site and bundles the Functions in `functions/`.

---

## File structure

```
ptv-live-maps/
- index.html                            Map UI
- styles.css                            Dark theme
- config.js                             Route colours and settings
- script.js                             App logic and animation
- data/
  - network.json                        Routes + stops + track geometry (static, built from GTFS)
  - gtfs-routes.json                    GTFS route_id -> line metadata (colours the GPS layer)
- functions/
  - api/
    - departures.js                     Signed live departures (server-side)
    - disruptions.js                    Signed disruptions (server-side)
    - vehicles.js                       GTFS-Realtime vehicle positions
- .github/
  - workflows/
    - deploy-cf-pages.yml               Deploys site + Functions to Cloudflare Pages
    - sync-ptv-secrets.yml              Copies PTV repo secrets into Pages secrets
    - fetch-network.yml                 Optional network rebuild (disabled by default)
  - scripts/
    - build-network-from-gtfs.js        Builds network.json from the static GTFS feed
    - fetch-network.js                  PTV API network fetcher (legacy, no track geometry)
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

| Setting             | Default | What it does                              |
|---------------------|---------|-------------------------------------------|
| `LIVE_REFRESH_MS`   | 60000   | How often the browser polls `/api/departures` |
| `ROUTE_WEIGHT`      | 2.5     | Route line thickness                      |
| `ROUTE_OPACITY`     | 0.75    | Route line opacity                        |
| `TRAIN_DOT_SIZE`    | 12      | Train dot size (px)                       |
| `STALE_MULTIPLIER`  | 6       | Cycles before removing an unseen train    |

---

## Limitations

- **Timetable-based positioning** - trains are interpolated from scheduled departure times, not live GPS (that's the separate `/api/vehicles` layer). Position accuracy matches timetable accuracy.
- **Flinders Street + outer terminuses** - trains that neither start nor stop at these hubs may not appear.

---

## Attribution

Transit data licensed from **Public Transport Victoria** under a [Creative Commons Attribution 4.0 International Licence](https://creativecommons.org/licenses/by/4.0/).

Map tiles by [CARTO](https://carto.com/attributions), data by [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
