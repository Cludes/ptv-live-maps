# PTV GTFS-Realtime Worker

A tiny Cloudflare Worker that fetches the Transport Victoria GTFS-Realtime
"Metro Train Vehicle Positions" feed (Protocol Buffers), decodes it, and serves
clean JSON with CORS so the browser map can poll it directly in real time.

It holds the API key (so it never reaches the browser) and edge-caches the feed
for 20s so many visitors polling at once don't exceed the feed's ~24 calls/60s limit.

## One-time setup

1. **Get a key (instant):** create an account at https://opendata.transport.vic.gov.au
   - Your `KeyID` is generated automatically on signup (Profile / API key).
   - You do NOT need to find the feed URL - it's already set in `wrangler.toml`
     (`.../gtfs/realtime/v1/metro/vehicle-positions`, confirmed live 2026-06-14).

2. **(Already done):** `FEED_URL` is pre-filled. The endpoint authenticates via the `KeyID`
   request header (verified against the live server's auth challenge), which the Worker sends
   for you. The OpenAPI spec mislabels it as `Ocp-Apim-Subscription-Key` - ignore that; the
   live gateway wants `KeyID`.

3. **Install + set the secret key:**
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler secret put PTV_KEYID   # paste your KeyID when prompted
   ```

4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   Note the deployed URL, e.g. `https://ptv-gtfsr.<your-subdomain>.workers.dev`.

5. **Test it:**
   ```bash
   curl https://ptv-gtfsr.<your-subdomain>.workers.dev
   ```
   You should get `{ "fetched_at": ..., "count": N, "vehicles": [ { lat, lon, ... } ] }`.

6. **Point the site at it:** put that URL in `config.js` as `WORKER_URL` (frontend wiring
   is a separate step - see the main repo).

## Response shape
```json
{
  "fetched_at": "2026-06-13T...Z",
  "count": 123,
  "vehicles": [
    { "id": "...", "trip_id": "...", "route_id": "...",
      "lat": -37.81, "lon": 144.96, "bearing": 270, "speed": 12.3, "timestamp": 1750000000 }
  ]
}
```
