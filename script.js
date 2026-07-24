/* ============================================================
   PTVLiveMap - Main Application
   ============================================================
   Data flow (Cloudflare Pages):
     data/network.json  - routes + stops, static (built from GTFS)
     /api/departures    - live departures, signed server-side + edge-cached ~60s

   The browser never calls the PTV API directly (the key stays on the edge).
   requestAnimationFrame runs position interpolation at ~60fps so
   trains move smoothly between the ~60-second data refreshes.
   ============================================================ */

'use strict';

const ICONS = {
  sun:  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
};

class PTVLiveMap {
  constructor() {
    this.map          = null;
    this.routeGroup   = null;
    this.stopGroup    = null;
    this.trainGroup   = null;
    this.gpsGroup     = null;

    this.routeData    = new Map(); // routeId -> { id, name, color, totalMinutes, stopIds }
    this.stopsData    = new Map(); // stopId  -> { id, name, lat, lng }

    this.liveRuns     = new Map(); // runId -> run state object
    this.trainMarkers = new Map(); // runId -> { marker, el }
    this.routeLayers  = new Map(); // routeId -> L.polyline
    this.stopLayers   = new Map(); // stopId  -> L.circleMarker
    this.stopToRoutes = new Map(); // stopId  -> Set<routeId>
    this.stationTiers = new Map(); // stopId  -> 0 regular | 1 minor interchange | 2 major interchange
    this.stationLabels = [];       // L.marker label icons for major interchanges (shown at high zoom)
    this.labelGroup   = null;

    this.activeRoutes  = new Set(Object.keys(CONFIG.ROUTES).map(Number));
    this.showTrains    = true;
    this.showStations  = true;
    this.showRoutes    = true;
    this.panelOpen     = false;
    this.followedRunId = null;
    this.delayedOnly   = false;
    this._infoRunId    = null;

    this.pollTimer      = null;
    this.animFrame      = null;
    this._animRunning   = false;
    this._demoMode      = false;
    this._lastPollAt         = null;
    this._countdownTimer     = null;
    this._highlightedRouteId = null;
    this.routeFilterEls      = new Map(); // routeId -> chip element

    // Comet trails
    this.trailHistory   = new Map(); // kept for compat, no longer sampled
    this.trailSvg       = null;
    this._trailN        = 0;         // frame counter
    this._trailPositions = null;     // cached geo positions, recomputed every 10 frames
    this.showTrails     = localStorage.getItem('ptv-trails') !== '0';

    this._cinemaMode  = false;

    // Track the last departures fetch time to detect stale data
    this._lastFetchedAt = null;

    // ---- Live GPS layer (real positions from the Cloudflare Worker) ----
    this.gpsVehicles = new Map(); // id -> { fromLat, fromLng, toLat, toLng, bearing, route_id, t0 }
    this.gpsMarkers  = new Map(); // id -> { marker, el }
    this.showGPS     = false;
    this.gpsTimer    = null;
    this.gtfsRoutes  = {};        // gtfs route_id -> { name, color, appRouteId }
    this.gtfsRoutesNorm = {};     // normalised route_id -> meta (tolerant lookup for the live feed)
  }

  // ──────────────────────────────────────────────────────────
  //  Entry point
  // ──────────────────────────────────────────────────────────
  async init() {
    this.initMap();
    this.setupKeyboard();
    const saved = localStorage.getItem('ptv-theme');
    if (saved === 'light') this._applyTheme('light');
    if (localStorage.getItem('ptv-legend-collapsed') === '1') {
      const body = document.getElementById('legend-body');
      const btn  = document.getElementById('legend-toggle');
      if (body) { body.classList.add('hidden'); if (btn) btn.textContent = '▲'; }
    }
    this.initTrailSvg();
    const trailToggle = document.getElementById('toggle-trails');
    if (trailToggle) trailToggle.checked = this.showTrails;
    await this.loadNetworkData();
    await Promise.all([this.fetchLiveData(), this.loadDisruptions(), this.loadGtfsRoutes()]);
    this.startAnimation();
    this.startPolling();
    this.initGPS();
  }

  // ──────────────────────────────────────────────────────────
  //  Live GPS layer - real positions polled from the Worker.
  //  Only activates when CONFIG.WORKER_URL is set; otherwise the
  //  toggle stays hidden and the timetable layer runs unchanged.
  // ──────────────────────────────────────────────────────────
  initGPS() {
    if (!CONFIG.WORKER_URL) return;
    // Start polling, but only reveal the toggle once the Worker actually returns
    // vehicle data (i.e. after the API key is added) - no dead toggle before then.
    this.showGPS = true;
    this.fetchGPS();
    this.startGPSPolling();
  }

  // ──────────────────────────────────────────────────────────
  //  Map setup
  // ──────────────────────────────────────────────────────────
  initMap() {
    this.map = L.map('map', {
      center:   CONFIG.MAP_CENTER,
      zoom:     CONFIG.MAP_ZOOM,
      minZoom:  CONFIG.MAP_MIN_ZOOM,
      maxZoom:  CONFIG.MAP_MAX_ZOOM,
      zoomControl: true,
      maxBounds:          [[-39.5, 140.0], [-33.5, 150.5]], // Victoria + surrounds
      maxBoundsViscosity: 1.0,
    });

    this.tileLayer = L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      subdomains:  'abcd',
      maxZoom:     20,
    }).addTo(this.map);

    this.routeGroup = L.layerGroup().addTo(this.map);
    this.stopGroup  = L.layerGroup().addTo(this.map);
    this.labelGroup = L.layerGroup().addTo(this.map);
    this.trainGroup = L.layerGroup().addTo(this.map);
    this.gpsGroup   = L.layerGroup().addTo(this.map);

    // Zoom-aware detail: reveal minor stations + labels as you zoom in.
    this.map.on('zoomend', () => this.updateZoomDetail());
  }

  // ──────────────────────────────────────────────────────────
  //  Trail SVG overlay - sits between route lines and train dots
  // ──────────────────────────────────────────────────────────
  initTrailSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'trail-svg';
    svg.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:500;overflow:visible;';
    this.map.getContainer().appendChild(svg);
    this.trailSvg = svg;
    // Reproject when map pans or zooms
    this.map.on('move zoom', () => { if (this.showTrails) this.renderTrails(); });
    // Sync cinema state if browser exits fullscreen via its own UI
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this._cinemaMode) {
        this._cinemaMode = false;
        document.body.classList.remove('cinema');
        setTimeout(() => this.map.invalidateSize(), 50);
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  //  Load static network data (written daily by GH Actions)
  // ──────────────────────────────────────────────────────────
  async loadNetworkData() {
    this.setStatus('loading');
    this.setCount('Loading network...');

    try {
      // Cache-bust so we always get the latest GH Actions commit
      const res  = await fetch(`${CONFIG.NETWORK_DATA_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.routes || !data.stops) throw new Error('Invalid network.json format');

      for (const [id, r] of Object.entries(data.routes)) {
        this.routeData.set(Number(id), r);
      }
      for (const [id, s] of Object.entries(data.stops)) {
        // Stop IDs stay strings - GTFS station keys are non-numeric (e.g. "vic:rail:FSS").
        this.stopsData.set(id, s);
      }

      this.renderNetwork();
      this.buildRouteFilters();

    } catch (err) {
      console.error('[PTV] Network data load failed:', err.message);
      this.setStatus('error');
      this.setCount('Network data unavailable - run "Fetch Network Data" workflow');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Render static network (polylines + station dots)
  // ──────────────────────────────────────────────────────────
  renderNetwork() {
    this.routeGroup.clearLayers();
    this.stopGroup.clearLayers();
    this.labelGroup.clearLayers();
    this.routeLayers.clear();
    this.stopLayers.clear();
    this.stopToRoutes.clear();
    this.stationTiers.clear();
    this.stationLabels = [];

    for (const [routeId, route] of this.routeData) {
      if (!Array.isArray(route.stopIds) || route.stopIds.length < 2) continue;

      // Prefer real GTFS track geometry (route.shape) for the line; fall back
      // to straight hops between stations for older network.json without shapes.
      const coords = (Array.isArray(route.shape) && route.shape.length >= 2)
        ? route.shape
        : route.stopIds
            .map(id => this.stopsData.get(id))
            .filter(Boolean)
            .map(s => [s.lat, s.lng]);

      if (coords.length < 2) continue;

      const poly = L.polyline(coords, {
        color:        route.color,
        weight:       CONFIG.ROUTE_WEIGHT,
        opacity:      CONFIG.ROUTE_OPACITY,
        smoothFactor: 1,
        lineCap:      'round',
        lineJoin:     'round',
        className:    'route-line',
      });
      // Set CSS color on the SVG path so the casing/glow filter (currentColor) tints per line.
      poly.on('add', () => { if (poly._path) poly._path.style.color = route.color; });
      poly.bindTooltip(route.name + ' Line', { sticky: true, direction: 'top' });

      this.routeLayers.set(routeId, poly);
      if (this.showRoutes && this.activeRoutes.has(routeId)) {
        this.routeGroup.addLayer(poly);
      }

      for (const sid of route.stopIds) {
        if (!this.stopToRoutes.has(sid)) this.stopToRoutes.set(sid, new Set());
        this.stopToRoutes.get(sid).add(routeId);
      }
    }

    for (const [stopId, stop] of this.stopsData) {
      // Station hierarchy: bigger ringed markers for interchanges, small dots for single-line stops.
      const lineCount = (this.stopToRoutes.get(stopId) || new Set()).size;
      const tier = lineCount >= 3 ? 2 : lineCount === 2 ? 1 : 0;
      this.stationTiers.set(stopId, tier);

      const style = tier === 2
        ? { radius: 4.5, fillColor: '#ffffff', fillOpacity: 1,    stroke: true, color: '#0d0d0d', weight: 1.6 }
        : tier === 1
          ? { radius: 3,   fillColor: '#ffffff', fillOpacity: 0.7, stroke: false }
          : { radius: 2,   fillColor: '#ffffff', fillOpacity: 0.3, stroke: false };

      const marker = L.circleMarker([stop.lat, stop.lng], style)
        .bindTooltip(stop.name, { direction: 'top', offset: [0, -5] });

      // Permanent name label for major interchanges, revealed at high zoom.
      if (tier === 2) {
        this.stationLabels.push(L.marker([stop.lat, stop.lng], {
          icon: L.divIcon({ className: 'stn-label', html: stop.name, iconSize: [0, 0], iconAnchor: [-7, 6] }),
          interactive: false, keyboard: false, pane: 'tooltipPane',
        }));
      }

      marker.on('click', () => {
        const routeIds  = this.stopToRoutes.get(stopId) || new Set();
        const linesDots = [...routeIds].map(rid => {
          const r = this.routeData.get(rid);
          return r ? `<span class="sp-dot" style="background:${r.color}" title="${r.name}"></span>` : '';
        }).join('');

        const deps    = this._getStationDepartures(stopId);
        const depRows = deps.length
          ? deps.map(d => {
              const eta      = d.minsAway === 0 ? '<span class="sp-arr">Now</span>' : `<span class="sp-eta">${d.minsAway}<span class="sp-min">m</span></span>`;
              const lateTag  = d.delayMin > 2 ? `<span class="sp-late">+${d.delayMin}m</span>` : '';
              return `<div class="sp-dep" onclick="app.selectTrainFromStation(${d.runId})">
                <span class="sp-dep-dot" style="background:${d.color}"></span>
                <span class="sp-dep-dest">To ${d.finalStopName}</span>
                ${lateTag}
                ${eta}
              </div>`;
            }).join('')
          : '<div class="sp-no-trains">No upcoming trains found</div>';

        L.popup({ closeButton: true, className: 'station-popup', maxWidth: 280, offset: [0, -6] })
          .setLatLng([stop.lat, stop.lng])
          .setContent(`
            <div class="sp-name">${stop.name}</div>
            ${linesDots ? `<div class="sp-lines">${linesDots}</div>` : ''}
            <div class="sp-deps">${depRows}</div>
          `)
          .openOn(this.map);
      });

      this.stopLayers.set(stopId, marker);
    }

    // Apply zoom-based station/label visibility now that markers exist.
    this.updateZoomDetail();

    // Gentle fade-in as the network draws on first load.
    const container = this.map.getContainer();
    container.classList.add('net-fade');
    setTimeout(() => container.classList.remove('net-fade'), 1000);
  }

  // ──────────────────────────────────────────────────────────
  //  Zoom-aware detail - declutter at city view, reveal on zoom-in
  // ──────────────────────────────────────────────────────────
  updateZoomDetail() {
    if (!this.map) return;
    const z = this.map.getZoom();

    for (const [stopId, marker] of this.stopLayers) {
      const tier    = this.stationTiers.get(stopId) || 0;
      // Major interchanges always show; minor at z>=11; ordinary stops only once zoomed in (z>=12)
      // so the city-wide view stays clean and the coloured lines + live trains read clearly.
      const minZoom = tier >= 2 ? 0 : tier === 1 ? 11 : 12;
      const show    = this.showStations && z >= minZoom;
      const on      = this.stopGroup.hasLayer(marker);
      if (show && !on) this.stopGroup.addLayer(marker);
      else if (!show && on) this.stopGroup.removeLayer(marker);
    }

    const showLabels = this.showStations && z >= 13;
    for (const lbl of this.stationLabels) {
      const on = this.labelGroup.hasLayer(lbl);
      if (showLabels && !on) this.labelGroup.addLayer(lbl);
      else if (!showLabels && on) this.labelGroup.removeLayer(lbl);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Fetch live departures (signed server-side by the /api/departures Pages Function)
  // ──────────────────────────────────────────────────────────
  async fetchLiveData() {
    this.setStatus('loading');

    try {
      // Cache-bust on every request so we always get the latest commit
      const res  = await fetch(`${CONFIG.LIVE_DATA_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Skip processing if data hasn't changed since last fetch
      if (data.fetched_at && data.fetched_at === this._lastFetchedAt) {
        this.setStatus('ok');
        return;
      }
      this._lastFetchedAt = data.fetched_at;

      const departures = data.departures || [];
      const runs       = data.runs       || {};
      const now        = Date.now();
      const seen       = new Set();

      for (const dep of departures) {
        const runId   = dep.run_id;
        const run     = runs[runId];
        if (!run) continue;

        const routeId = dep.route_id;
        const route   = this.routeData.get(routeId);
        const cfg     = CONFIG.ROUTES[routeId] || route; // fall back to network.json data for V/Line
        if (!cfg || !route || !Array.isArray(route.stopIds) || !route.stopIds.length) continue;

        const depTimeStr  = dep.estimated_departure_utc || dep.scheduled_departure_utc;
        const schedStr    = dep.scheduled_departure_utc;
        if (!depTimeStr) continue;

        const depMs   = Date.parse(depTimeStr);
        const schedMs = schedStr ? Date.parse(schedStr) : depMs;
        const delayMin = Math.round((depMs - schedMs) / 60000);

        const hubIdx = route.stopIds.indexOf(dep.stop_id);
        const effectiveHubIdx = hubIdx >= 0 ? hubIdx : Math.floor(route.stopIds.length / 2);

        const finalStop = this.stopsData.get(run.final_stop_id);

        seen.add(runId);

        const existing = this.liveRuns.get(runId);
        this.liveRuns.set(runId, {
          runId,
          routeId,
          routeName:      cfg.name,
          color:          cfg.color,
          directionId:    dep.direction_id,
          directionName:  run.direction_name || '',
          finalStopId:    run.final_stop_id,
          finalStopName:  finalStop ? finalStop.name : (run.direction_name || ''),
          hubDepartureMs: depMs,
          hubStopIdx:     effectiveHubIdx,
          stopIds:        route.stopIds,
          totalMinutes:   cfg.totalMinutes,
          delayMin,
          vehicle:        run.vehicle_descriptor || null,
          lastSeen:       now,
          // Preserve smoothed coords across data refreshes to avoid position jumps
          smoothLat: existing ? existing.smoothLat : null,
          smoothLng: existing ? existing.smoothLng : null,
        });
      }

      // Remove runs not seen after STALE_MULTIPLIER refresh cycles
      const staleMs = CONFIG.STALE_MULTIPLIER * CONFIG.LIVE_REFRESH_MS;
      for (const [runId, run] of this.liveRuns) {
        if (!seen.has(runId) && (now - run.lastSeen) > staleMs) {
          this.removeTrain(runId);
          this.liveRuns.delete(runId);
        }
      }

      const count = this.liveRuns.size;

      if (!data.fetched_at) {
        // No real data yet - activate demo mode
        this.activateDemoMode();
      } else {
        // Real data arrived - clear demo mode if it was active
        if (this._demoMode) {
          this._demoMode = false;
          for (const [runId, run] of this.liveRuns) {
            if (run._demo) { this.removeTrain(runId); this.liveRuns.delete(runId); }
          }
        }
        const delayed = [...this.liveRuns.values()].filter(r => r.delayMin > 2).length;
        this.setCount(`${count} train${count !== 1 ? 's' : ''} active`);
        this.setDelayChip(delayed);
        this.setLastUpdate(new Date(data.fetched_at));
        this.updateRouteChipCounts();
        this.setSetupOverlay(count === 0);

        const ageMin = (Date.now() - Date.parse(data.fetched_at)) / 60000;
        this.setStaleWarning(ageMin > 10 ? Math.round(ageMin) : null);
      }

      this.setStatus('ok');

    } catch (err) {
      console.error('[PTV] Live data fetch failed:', err.message);
      this.setStatus('error');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Disruptions
  // ──────────────────────────────────────────────────────────
  // gtfs route_id -> { name, color, appRouteId }, used to colour the live GPS layer.
  async loadGtfsRoutes() {
    try {
      const res = await fetch(`data/gtfs-routes.json?t=${Date.now()}`);
      if (!res.ok) return;
      this.gtfsRoutes = await res.json();
      for (const [rid, meta] of Object.entries(this.gtfsRoutes)) {
        this.gtfsRoutesNorm[this._normRouteId(rid)] = meta;
      }
    } catch {
      // Non-fatal: GPS arrows just fall back to the default colour
    }
  }

  _normRouteId(rid) {
    return String(rid).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Resolve a live-feed route_id to its line metadata (tolerant of id formatting).
  _gpsRouteMeta(routeId) {
    if (routeId == null) return null;
    return this.gtfsRoutes[routeId] || this.gtfsRoutesNorm[this._normRouteId(routeId)] || null;
  }

  async loadDisruptions() {
    try {
      const res  = await fetch(`/api/disruptions?t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      const list = data.disruptions || [];
      this._renderDisruptions(list);
    } catch {
      // Non-fatal: disruptions panel stays empty
    }
  }

  _renderDisruptions(disruptions) {
    const badge = document.getElementById('dis-badge');
    const listEl = document.getElementById('disruption-list');
    const section = document.getElementById('disruptions-section');
    if (!listEl) return;

    if (!disruptions.length) {
      if (badge)   badge.classList.add('hidden');
      if (section) section.classList.add('hidden');
      return;
    }

    if (badge)   { badge.textContent = disruptions.length; badge.classList.remove('hidden'); }
    if (section) section.classList.remove('hidden');

    listEl.innerHTML = disruptions.map(d => {
      const link = d.url
        ? `<a class="dis-link" href="${d.url}" target="_blank" rel="noopener">Details</a>`
        : '';
      return `<div class="dis-item">
        <div class="dis-type">${d.type}</div>
        <div class="dis-title">${d.title}${link}</div>
      </div>`;
    }).join('');
  }

  // ──────────────────────────────────────────────────────────
  //  Animation - runs at ~60fps regardless of data refresh rate
  // ──────────────────────────────────────────────────────────
  startAnimation() {
    if (this._animRunning) return;
    this._animRunning = true;
    const tick = () => {
      // Position updates every 2nd frame (~30fps): on-screen trains crawl a few px/s,
      // so this halves the work with no visible difference. Trails every 3rd frame.
      if (this._trailN % 2 === 0) {
        if (this.showTrains) this.updateTrainPositions();
        if (this.showGPS) this.updateGPSPositions();
      }
      if (this._trailN % 3 === 0) this.renderTrails();
      this._trailN++;
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
  }

  updateTrainPositions() {
    const now = Date.now();
    const bounds = this.map.getBounds().pad(0.25); // cull DOM work for trains outside the view

    for (const [runId, run] of this.liveRuns) {
      if (!this.activeRoutes.has(run.routeId)) {
        this.removeTrain(runId);
        continue;
      }

      // "Delayed only" filter: drop on-time trains from the DOM while active.
      if (this.delayedOnly && !(run.delayMin > 2)) {
        if (this.trainMarkers.has(runId)) {
          const { marker } = this.trainMarkers.get(runId);
          this.trainGroup.removeLayer(marker);
          this.trainMarkers.delete(runId);
        }
        continue;
      }

      // Demo: reverse direction when reaching the end of the route
      if (run._demo) {
        const stops = this._resolveStops(run);
        if (stops.length >= 2) {
          const elapsedMin  = (now - run.hubDepartureMs) / 60000;
          const floatIdx    = elapsedMin / (run.totalMinutes / stops.length);
          if (floatIdx >= stops.length - 1) {
            run.stopIds        = [...run.stopIds].reverse();
            run.hubDepartureMs = now;
          }
        }
      }

      const pos = this.calculatePosition(run, now);
      if (!pos) continue;

      // Smooth lerp toward calculated position each frame - prevents
      // visible jumps when new data arrives with slightly different timing
      const SMOOTH = 0.07;
      if (run.smoothLat === null) {
        run.smoothLat = pos.lat;
        run.smoothLng = pos.lng;
      } else {
        run.smoothLat += (pos.lat - run.smoothLat) * SMOOTH;
        run.smoothLng += (pos.lng - run.smoothLng) * SMOOTH;
      }

      // Keep interpolating every train's position (cheap), but only touch the DOM
      // for those in/near the viewport; off-screen ones shed their marker.
      if (bounds.contains([run.smoothLat, run.smoothLng])) {
        this.upsertTrainMarker(runId, run.smoothLat, run.smoothLng, run, pos.heading);
      } else if (this.trainMarkers.has(runId)) {
        const { marker } = this.trainMarkers.get(runId);
        this.trainGroup.removeLayer(marker);
        this.trainMarkers.delete(runId);
      }
    }

    for (const [runId] of this.trainMarkers) {
      if (!this.liveRuns.has(runId)) this.removeTrain(runId);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Position interpolation
  //  When network.json has stopDists (cumulative km per stop),
  //  interpolation is distance-proportional so city-loop stops
  //  (which are only ~500m apart) don't steal disproportionate
  //  time from outer segments (~5–8km apart).
  //  Falls back to equal-time-per-stop for older network.json.
  // ──────────────────────────────────────────────────────────

  // Resolve stopIds -> stop objects, cached per run so the animation loop
  // doesn't rebuild the array (and re-do N map lookups) every frame. The cache
  // invalidates automatically when stopIds is reassigned - i.e. on a data
  // refresh (new run object) or a demo-mode direction reverse (new array).
  _resolveStops(run) {
    if (run._stopsCache && run._stopsCacheKey === run.stopIds) return run._stopsCache;
    run._stopsCache    = run.stopIds.map(id => this.stopsData.get(id)).filter(Boolean);
    run._stopsCacheKey = run.stopIds;
    return run._stopsCache;
  }

  // Returns { stops, floatIdx } plus distance fields if available.
  // All position/ETA methods share this to avoid duplicating the math.
  _computeProgress(run, now) {
    const stops = this._resolveStops(run);
    if (stops.length < 2) return null;

    const elapsedMin = (now - run.hubDepartureMs) / 60000;
    const route      = this.routeData.get(run.routeId);
    const dists      = route?.stopDists;

    if (dists && dists.length === stops.length) {
      const totalDist = dists[dists.length - 1];
      if (totalDist === 0) return null;
      const speed      = totalDist / run.totalMinutes; // km/min
      const hubDist    = dists[Math.min(run.hubStopIdx, dists.length - 1)] || 0;
      const currentDist = Math.max(0, Math.min(totalDist, hubDist + elapsedMin * speed));

      let prevI = 0;
      for (let i = 1; i < dists.length; i++) {
        if (dists[i] >= currentDist) { prevI = i - 1; break; }
        if (i === dists.length - 1)    prevI = i;
      }
      const nextI   = Math.min(prevI + 1, dists.length - 1);
      const segDist = dists[nextI] - dists[prevI];
      const floatIdx = prevI + (segDist > 0 ? (currentDist - dists[prevI]) / segDist : 0);
      return { stops, floatIdx, currentDist, dists, speed };
    }

    // Fallback: equal time per stop
    const minPerStop = run.totalMinutes / stops.length;
    const floatIdx   = Math.max(0, run.hubStopIdx + elapsedMin / minPerStop);
    return { stops, floatIdx, minPerStop };
  }

  calculatePosition(run, now) {
    const p = this._computeProgress(run, now);
    if (!p) return null;
    const { stops, floatIdx } = p;

    const clamped = Math.max(0, Math.min(stops.length - 1.001, floatIdx));
    const prevIdx = Math.floor(clamped);
    const nextIdx = prevIdx + 1;
    const t       = clamped - prevIdx;

    if (nextIdx >= stops.length) {
      const last = stops[stops.length - 1];
      return { lat: last.lat, lng: last.lng, heading: null };
    }
    const a = stops[prevIdx], b = stops[nextIdx];
    // Heading (deg clockwise from north) of the current segment - stable near stops.
    const dLng = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
    const heading = (Math.atan2(dLng, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      heading,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  Train marker management
  // ──────────────────────────────────────────────────────────
  upsertTrainMarker(runId, lat, lng, run, heading) {
    const latlng   = [lat, lng];
    const delayCls = run.delayMin >= 10 ? 'delay-major' : run.delayMin > 2 ? 'delay-minor' : '';

    if (this.trainMarkers.has(runId)) {
      const { marker, wrap, dot } = this.trainMarkers.get(runId);
      marker.setLatLng(latlng);
      dot.className = `tm ${delayCls}`;
      if (heading == null) {
        wrap.classList.add('no-dir');
      } else {
        wrap.classList.remove('no-dir');
        wrap.style.transform = `rotate(${heading}deg)`;
      }
      if (this.followedRunId === runId) {
        this.map.setView(latlng, this.map.getZoom(), { animate: false });
      }
    } else {
      // Rotating wrapper carries the heading nub; the dot inside keeps its own
      // hover/scale transform so the two don't fight.
      const wrap = document.createElement('div');
      wrap.className = 'tm-wrap' + (heading == null ? ' no-dir' : '');
      if (heading != null) wrap.style.transform = `rotate(${heading}deg)`;

      const nub = document.createElement('div');
      nub.className = 'tm-nub';

      const dot = document.createElement('div');
      dot.className = `tm ${delayCls}`;
      dot.style.background = run.color;

      wrap.appendChild(nub);
      wrap.appendChild(dot);

      const icon = L.divIcon({ html: wrap, className: '', iconSize: [28, 28], iconAnchor: [14, 14] });
      const marker = L.marker(latlng, { icon, zIndexOffset: 500 });
      marker.on('click', () => this.showTrainInfo(runId));

      this.trainGroup.addLayer(marker);
      this.trainMarkers.set(runId, { marker, wrap, dot });
    }
  }

  removeTrain(runId) {
    if (this.trainMarkers.has(runId)) {
      const { marker } = this.trainMarkers.get(runId);
      this.trainGroup.removeLayer(marker);
      this.trainMarkers.delete(runId);
    }
    this.trailHistory.delete(runId);
    if (this.followedRunId === runId) {
      this.followedRunId = null;
      this.syncFollowBtn();
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Train info popup
  // ──────────────────────────────────────────────────────────
  showTrainInfo(runId) {
    const run = this.liveRuns.get(runId);
    if (!run) return;

    this._infoRunId    = runId;
    this.followedRunId = runId;
    this.syncFollowBtn();
    this._highlightRoute(run.routeId);

    const delayHtml = run.delayMin > 2
      ? `<span class="ti-late">+${run.delayMin} min late</span>`
      : `<span class="ti-ontime">On time</span>`;

    const vehicleStr = run.vehicle
      ? (run.vehicle.id || run.vehicle.low_floor_description || '')
      : '';

    const nextStop = this._getNextStop(run);
    const nextStopHtml = nextStop
      ? `<div class="ti-row"><span class="ti-label">Next stop</span><span class="ti-value">${nextStop.name}${nextStop.minsAway > 0 ? ` <span class="ti-eta">${nextStop.minsAway}m</span>` : ''}</span></div>`
      : '';

    document.getElementById('train-info-body').innerHTML = `
      <div class="ti-route" style="color:${run.color}">${run.routeName} Line</div>
      <div class="ti-dest">To ${run.finalStopName || run.directionName}</div>
      <div class="ti-row"><span class="ti-label">Status</span><span class="ti-value">${delayHtml}</span></div>
      ${nextStopHtml}
      <div class="ti-row"><span class="ti-label">Direction</span><span class="ti-value">${run.directionName || '-'}</span></div>
      ${vehicleStr ? `<div class="ti-row"><span class="ti-label">Vehicle</span><span class="ti-value">${vehicleStr}</span></div>` : ''}
    `;

    document.getElementById('train-info').classList.remove('hidden');
  }

  _getNextStop(run) {
    const p = this._computeProgress(run, Date.now());
    if (!p) return null;
    const { stops, floatIdx, dists, speed, minPerStop } = p;

    const nextIdx = Math.min(Math.ceil(floatIdx), stops.length - 1);
    const minsAway = dists && speed
      ? Math.max(0, Math.round((dists[nextIdx] - p.currentDist) / speed))
      : Math.max(0, Math.round((nextIdx - floatIdx) * minPerStop));

    return { name: stops[nextIdx].name, minsAway };
  }

  _getStationDepartures(stopId) {
    const results = [];
    const now = Date.now();

    for (const [, run] of this.liveRuns) {
      if (run._demo) continue;
      const stationIdx = run.stopIds.indexOf(stopId);
      if (stationIdx < 0) continue;

      const p = this._computeProgress(run, now);
      if (!p) continue;
      const { floatIdx, dists, speed, minPerStop } = p;

      if (floatIdx >= stationIdx + 0.5) continue; // already passed

      let minsAway;
      if (dists && speed) {
        minsAway = Math.max(0, Math.round((dists[stationIdx] - p.currentDist) / speed));
      } else {
        minsAway = Math.max(0, Math.round((stationIdx - floatIdx) * minPerStop));
      }
      if (minsAway > 90) continue;

      results.push({
        runId:         run.runId,
        color:         run.color,
        routeName:     run.routeName,
        finalStopName: run.finalStopName || run.directionName,
        minsAway,
        delayMin:      run.delayMin,
      });
    }

    return results.sort((a, b) => a.minsAway - b.minsAway).slice(0, 6);
  }

  _highlightRoute(routeId) {
    if (this._highlightedRouteId != null) {
      const prev = this.routeLayers.get(this._highlightedRouteId);
      if (prev) prev.setStyle({ weight: CONFIG.ROUTE_WEIGHT, opacity: CONFIG.ROUTE_OPACITY });
    }
    this._highlightedRouteId = routeId;
    const poly = this.routeLayers.get(routeId);
    if (poly) { poly.setStyle({ weight: 5, opacity: 1 }); poly.bringToFront(); }
  }

  _clearRouteHighlight() {
    if (this._highlightedRouteId != null) {
      const poly = this.routeLayers.get(this._highlightedRouteId);
      if (poly) poly.setStyle({ weight: CONFIG.ROUTE_WEIGHT, opacity: CONFIG.ROUTE_OPACITY });
      this._highlightedRouteId = null;
    }
  }

  closeTrainInfo() {
    this.followedRunId = null;
    this._infoRunId    = null;
    this.syncFollowBtn();
    this._clearRouteHighlight();
    document.getElementById('train-info').classList.add('hidden');
  }

  selectTrainFromStation(runId) {
    this.map.closePopup();
    this.showTrainInfo(runId);
    const marker = this.trainMarkers.get(runId);
    if (marker) this.map.panTo(marker.marker.getLatLng());
  }

  toggleFollow() {
    this.followedRunId = this.followedRunId ? null : this._infoRunId;
    this.syncFollowBtn();
  }

  syncFollowBtn() {
    const btn = document.getElementById('follow-btn');
    if (!btn) return;
    btn.classList.toggle('active', !!this.followedRunId);
    btn.textContent = this.followedRunId ? 'Unfollow' : 'Follow Train';
  }

  // ──────────────────────────────────────────────────────────
  //  Layer toggles
  // ──────────────────────────────────────────────────────────
  toggleLayer(layer, visible) {
    if (layer === 'trains') {
      this.showTrains = visible;
      if (!visible) {
        for (const [id] of this.trainMarkers) this.removeTrain(id);
        if (this.trailSvg) this.trailSvg.innerHTML = '';
      }
    }
    if (layer === 'stations') {
      this.showStations = visible;
      this.updateZoomDetail();
    }
    if (layer === 'routes') {
      this.showRoutes = visible;
      this.routeGroup.clearLayers();
      if (visible) {
        for (const [id, poly] of this.routeLayers) {
          if (this.activeRoutes.has(id)) this.routeGroup.addLayer(poly);
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Live GPS - real vehicle positions from the Worker
  // ──────────────────────────────────────────────────────────
  async fetchGPS() {
    try {
      const res = await fetch(CONFIG.WORKER_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const now  = Date.now();
      const seen = new Set();

      // Reveal the Live GPS toggle the first time the Worker returns real data.
      if (Array.isArray(data.vehicles)) {
        const row = document.getElementById('row-gps');
        if (row && row.style.display === 'none') row.style.display = '';
      }

      for (const v of data.vehicles || []) {
        if (v.lat == null || v.lon == null) continue;
        seen.add(v.id);
        const existing = this.gpsVehicles.get(v.id);
        if (existing) {
          // Interpolate from where it's currently shown toward the new fix
          existing.fromLat  = existing.curLat;
          existing.fromLng  = existing.curLng;
          existing.toLat    = v.lat;
          existing.toLng    = v.lon;
          existing.bearing  = v.bearing;
          existing.route_id = v.route_id;
          existing.t0       = now;
        } else {
          this.gpsVehicles.set(v.id, {
            fromLat: v.lat, fromLng: v.lon,
            toLat:   v.lat, toLng:   v.lon,
            curLat:  v.lat, curLng:  v.lon,
            bearing: v.bearing, route_id: v.route_id, t0: now,
          });
        }
      }

      // Drop vehicles that left the feed
      for (const [id] of this.gpsVehicles) {
        if (!seen.has(id)) {
          this.gpsVehicles.delete(id);
          this.removeGPSMarker(id);
        }
      }
    } catch (err) {
      console.error('[PTV] GPS fetch failed:', err.message);
    }
  }

  updateGPSPositions() {
    const now = Date.now();
    const bounds = this.map.getBounds().pad(0.25);
    for (const [id, v] of this.gpsVehicles) {
      const t = Math.min(1, (now - v.t0) / CONFIG.GPS_REFRESH_MS);
      v.curLat = v.fromLat + (v.toLat - v.fromLat) * t;
      v.curLng = v.fromLng + (v.toLng - v.fromLng) * t;
      if (bounds.contains([v.curLat, v.curLng])) this.upsertGPSMarker(id, v);
      else this.removeGPSMarker(id);
    }
  }

  upsertGPSMarker(id, v) {
    const latlng = [v.curLat, v.curLng];
    const rot    = v.bearing != null ? v.bearing : 0;
    const meta   = this._gpsRouteMeta(v.route_id);
    const color  = (meta && meta.color) || CONFIG.GPS_COLOR;

    if (this.gpsMarkers.has(id)) {
      const { marker, el } = this.gpsMarkers.get(id);
      marker.setLatLng(latlng);
      if (el) el.style.transform = `rotate(${rot}deg)`;
    } else {
      const el = document.createElement('div');
      el.className   = 'gps-arrow';
      el.style.cssText = `transform:rotate(${rot}deg);`;
      // Navigation arrow points up at bearing 0 (north); GTFS bearing is deg clockwise from north
      el.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="${color}" ` +
        `stroke="rgba(0,0,0,0.9)" stroke-width="1.2" stroke-linejoin="round">` +
        `<path d="M12 2 L19 21 L12 16 L5 21 Z"/></svg>`;

      const icon = L.divIcon({ html: el, className: '', iconSize: [22, 22], iconAnchor: [11, 11] });
      const marker = L.marker(latlng, { icon, zIndexOffset: 600 });
      const label = meta ? `${meta.name} line (live GPS)` : `Live GPS - route ${v.route_id}`;
      marker.bindTooltip(label, { direction: 'top' });

      this.gpsGroup.addLayer(marker);
      this.gpsMarkers.set(id, { marker, el });
    }
  }

  removeGPSMarker(id) {
    if (this.gpsMarkers.has(id)) {
      const { marker } = this.gpsMarkers.get(id);
      this.gpsGroup.removeLayer(marker);
      this.gpsMarkers.delete(id);
    }
  }

  toggleGPS(visible) {
    this.showGPS = visible;
    if (!visible) {
      for (const [id] of this.gpsMarkers) this.removeGPSMarker(id);
    }
  }

  startGPSPolling() {
    if (this.gpsTimer) clearInterval(this.gpsTimer);
    this.gpsTimer = setInterval(() => this.fetchGPS(), CONFIG.GPS_REFRESH_MS);
  }

  // ──────────────────────────────────────────────────────────
  //  Comet trails
  // ──────────────────────────────────────────────────────────
  renderTrails() {
    if (!this.trailSvg) return;

    if (!this.showTrails || !this.showTrains) {
      this.trailSvg.innerHTML = '';
      return;
    }

    // Opacity and width per segment, index 0 = oldest (faintest), 4 = newest (brightest)
    const OPACITIES = [0.05, 0.13, 0.27, 0.47, 0.68];
    const WIDTHS    = [1.5,  2,    2.5,  3,    3.5];
    const NUM_SEGS  = OPACITIES.length;

    const SPAN_MS   = 4 * 60000;
    const N_SAMPLES = 20;

    // Recompute geographic positions every 10 animation frames (~every 0.5s).
    // Map pan/zoom calls renderTrails too but doesn't advance _trailN,
    // so those calls just re-project the cached positions cheaply.
    if (!this._trailPositions || this._trailN % 10 === 0) {
      const now = Date.now();
      this._trailPositions = new Map();
      for (const [runId, run] of this.liveRuns) {
        if (!this.activeRoutes.has(run.routeId)) continue;
        if (run.smoothLat === null) continue;
        const pts = [];
        for (let i = N_SAMPLES; i >= 1; i--) {
          const pos = this.calculatePosition(run, now - i * (SPAN_MS / N_SAMPLES));
          if (pos) pts.push(pos);
        }
        pts.push({ lat: run.smoothLat, lng: run.smoothLng });
        if (pts.length >= 2) this._trailPositions.set(runId, { run, pts });
      }
    }

    const paths = [];
    for (const { run, pts } of this._trailPositions.values()) {
      const px = pts.map(p => {
        const pt = this.map.latLngToContainerPoint(L.latLng(p.lat, p.lng));
        return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
      });

      const n = px.length;
      for (let i = 0; i < NUM_SEGS; i++) {
        const from = Math.floor(n * i / NUM_SEGS);
        const to   = Math.min(n, Math.floor(n * (i + 1) / NUM_SEGS) + 1);
        if (to - from < 2) continue;
        const d = 'M' + px.slice(from, to).join('L');
        paths.push(
          `<path d="${d}" fill="none" stroke="${run.color}" ` +
          `stroke-width="${WIDTHS[i]}" stroke-opacity="${OPACITIES[i]}" ` +
          `stroke-linecap="round" stroke-linejoin="round"/>`
        );
      }
    }

    this.trailSvg.innerHTML = paths.join('');
  }

  toggleTrails(enabled) {
    this.showTrails = enabled;
    localStorage.setItem('ptv-trails', enabled ? '1' : '0');
    if (!enabled && this.trailSvg) this.trailSvg.innerHTML = '';
  }

  // ──────────────────────────────────────────────────────────
  //  Route filter chips
  // ──────────────────────────────────────────────────────────
  buildRouteFilters() {
    const container = document.getElementById('route-filters');
    if (!container) return;
    container.innerHTML = '';
    this.routeFilterEls.clear();

    const loaded = new Set(this.routeData.keys());

    for (const [idStr, cfg] of Object.entries(CONFIG.ROUTES)) {
      const id = Number(idStr);
      if (!loaded.has(id)) continue;

      const el = document.createElement('div');
      el.className = 'rf-item';
      el.innerHTML =
        `<span class="rf-dot" style="background:${cfg.color}"></span>` +
        `<span class="rf-name">${cfg.name}</span>` +
        `<span class="rf-count"></span>`;

      el.addEventListener('click', () => {
        if (this.activeRoutes.has(id)) {
          this.activeRoutes.delete(id);
          el.classList.add('off');
          const poly = this.routeLayers.get(id);
          if (poly) this.routeGroup.removeLayer(poly);
        } else {
          this.activeRoutes.add(id);
          el.classList.remove('off');
          const poly = this.routeLayers.get(id);
          if (poly && this.showRoutes) this.routeGroup.addLayer(poly);
        }
      });

      this.routeFilterEls.set(id, el);
      container.appendChild(el);
    }
  }

  updateRouteChipCounts() {
    const counts = new Map();
    for (const run of this.liveRuns.values()) {
      counts.set(run.routeId, (counts.get(run.routeId) || 0) + 1);
    }
    for (const [id, el] of this.routeFilterEls) {
      const span = el.querySelector('.rf-count');
      if (!span) continue;
      const n = counts.get(id) || 0;
      span.textContent = n > 0 ? n : '';
    }
  }

  setAllRoutes(visible) {
    const loaded = new Set(this.routeData.keys());
    for (const id of loaded) {
      const poly = this.routeLayers.get(id);
      const el   = this.routeFilterEls.get(id);
      if (visible) {
        this.activeRoutes.add(id);
        if (el) el.classList.remove('off');
        if (poly && this.showRoutes) this.routeGroup.addLayer(poly);
      } else {
        this.activeRoutes.delete(id);
        if (el) el.classList.add('off');
        if (poly) this.routeGroup.removeLayer(poly);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Panel + search
  // ──────────────────────────────────────────────────────────
  togglePanel() {
    this.panelOpen = !this.panelOpen;
    const panel  = document.getElementById('panel');
    const legend = document.getElementById('legend');
    panel.classList.toggle('panel-hidden', !this.panelOpen);
    panel.setAttribute('aria-hidden', String(!this.panelOpen));
    if (legend) legend.style.right = this.panelOpen ? 'calc(var(--panel-w) + 14px)' : '14px';
  }

  setupKeyboard() {
    const input   = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    if (input) {
      input.addEventListener('input',  e => this.handleSearch(e.target.value));
      input.addEventListener('blur',   () => setTimeout(() => { if (results) results.innerHTML = ''; }, 200));
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (this._cinemaMode) { this.toggleCinemaMode(); return; }
        this.closeTrainInfo();
        if (results) results.innerHTML = '';
      }
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && e.target.tagName !== 'INPUT') {
        this.toggleCinemaMode();
      }
      if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && e.target.tagName !== 'INPUT') {
        this.togglePanel();
      }
    });
  }

  handleSearch(query) {
    const results = document.getElementById('search-results');
    if (!results) return;
    if (!query || query.length < 2) { results.innerHTML = ''; return; }

    const q = query.toLowerCase();
    const matches = [...this.stopsData.values()]
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 8);

    if (!matches.length) {
      results.innerHTML = '<div class="sr-item" style="color:#555;cursor:default">No stations found</div>';
      return;
    }

    results.innerHTML = matches.map(s => {
      let color = '#fff';
      for (const [, route] of this.routeData) {
        if (route.stopIds.includes(s.id)) { color = route.color; break; }
      }
      return `<div class="sr-item" data-lat="${s.lat}" data-lng="${s.lng}" data-name="${s.name}">
        <span class="sr-dot" style="background:${color}"></span>${s.name}
      </div>`;
    }).join('');

    results.querySelectorAll('.sr-item[data-lat]').forEach(el => {
      el.addEventListener('click', () => {
        this.map.setView([+el.dataset.lat, +el.dataset.lng], 15);
        results.innerHTML = '';
        const input = document.getElementById('search-input');
        if (input) input.value = el.dataset.name;
      });
    });
  }

  // ──────────────────────────────────────────────────────────
  //  Actions
  // ──────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  //  Theme toggle
  // ──────────────────────────────────────────────────────────
  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    this._applyTheme(next);
    localStorage.setItem('ptv-theme', next);
  }

  _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);

    // Swap tile layer
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    const tileUrl = theme === 'light'
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    this.tileLayer = L.tileLayer(tileUrl, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      subdomains:  'abcd',
      maxZoom:     20,
    }).addTo(this.map);

    // Update button icon
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.innerHTML = theme === 'light' ? ICONS.moon : ICONS.sun;
  }

  resetView() { this.map.setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM); }

  toggleCinemaMode() {
    this._cinemaMode = !this._cinemaMode;
    document.body.classList.toggle('cinema', this._cinemaMode);
    if (this._cinemaMode) {
      // Close panel and train info so they don't linger under cinema overlay
      if (this.panelOpen) this.togglePanel();
      this.closeTrainInfo();
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
    // Leaflet needs to recalculate size after layout change
    setTimeout(() => this.map.invalidateSize(), 50);
  }
  clearCache() {
    try { localStorage.clear(); } catch {}
    location.reload();
  }

  // ──────────────────────────────────────────────────────────
  //  Polling - re-polls /api/departures on interval
  // ──────────────────────────────────────────────────────────
  startPolling() {
    this._lastPollAt = Date.now();
    this.pollTimer = setInterval(() => {
      this._lastPollAt = Date.now();
      this.fetchLiveData();
    }, CONFIG.LIVE_REFRESH_MS);
    this._countdownTimer = setInterval(() => this._tickCountdown(), 1000);
  }

  _tickCountdown() {
    const el = document.getElementById('next-update');
    if (!el || !this._lastPollAt) return;
    const remaining = Math.max(0, Math.ceil((CONFIG.LIVE_REFRESH_MS - (Date.now() - this._lastPollAt)) / 1000));
    el.textContent = remaining > 0 ? `(${remaining}s)` : '';
  }

  // ──────────────────────────────────────────────────────────
  //  Status helpers
  // ──────────────────────────────────────────────────────────
  setStatus(state) {
    const el = document.getElementById('api-dot');
    if (!el) return;
    el.className = { ok: 'dot-ok', error: 'dot-error', loading: 'dot-loading' }[state] || 'dot-loading';
    el.title     = { ok: 'Live',   error: 'Data error', loading: 'Updating...' }[state] || '';
  }

  // ──────────────────────────────────────────────────────────
  //  Demo mode - simulated trains for when no API key is set
  // ──────────────────────────────────────────────────────────
  activateDemoMode() {
    if (this._demoMode) return;
    this._demoMode = true;
    this.setSetupOverlay(false);

    const now = Date.now();
    let id = 9000;

    // Prefer the real stop sequences from the loaded network; fall back to the
    // seeded CONFIG.DEMO_STOPS only if the network has no stopIds.
    const sequences = [];
    for (const [routeId, route] of this.routeData) {
      if (Array.isArray(route.stopIds) && route.stopIds.length >= 2) {
        sequences.push([routeId, route.stopIds]);
      }
    }
    if (!sequences.length) {
      for (const [routeIdStr, stopIds] of Object.entries(CONFIG.DEMO_STOPS)) {
        sequences.push([Number(routeIdStr), stopIds]);
      }
    }

    for (const [routeId, stopIds] of sequences) {
      const cfg = CONFIG.ROUTES[routeId] || this.routeData.get(routeId);
      if (!cfg) continue;

      const totalMs = cfg.totalMinutes * 60000;

      // Two trains each direction, evenly staggered across the route (demo only)
      for (const offset of [0.28, 0.72]) {
        this.liveRuns.set(id, this._makeDemoRun(id++, routeId, cfg, [...stopIds],           now - totalMs * offset));
        this.liveRuns.set(id, this._makeDemoRun(id++, routeId, cfg, [...stopIds].reverse(), now - totalMs * offset));
      }
    }

    this.setCount(`${this.liveRuns.size} trains (demo)`);
    const el = document.getElementById('last-update');
    if (el) el.textContent = 'Demo mode - no API key yet';
  }

  _makeDemoRun(id, routeId, cfg, stopIds, hubDepartureMs) {
    return {
      runId: id, routeId,
      routeName: cfg.name, color: cfg.color,
      directionId: 0, directionName: cfg.name,
      finalStopId: null, finalStopName: cfg.name,
      hubDepartureMs, hubStopIdx: 0,
      stopIds, totalMinutes: cfg.totalMinutes,
      delayMin: 0, vehicle: null,
      lastSeen: Date.now(),
      smoothLat: null, smoothLng: null,
      _demo: true,
    };
  }

  setSetupOverlay(visible) {
    const el = document.getElementById('setup-overlay');
    if (el) el.classList.toggle('hidden', !visible);
  }

  setCount(text) {
    const el = document.getElementById('train-count');
    if (el) el.textContent = text;
  }

  // The "N delayed" chip doubles as a filter toggle (click = show delayed only).
  setDelayChip(n) {
    const el = document.getElementById('delay-filter');
    if (!el) return;
    if (n > 0) {
      el.textContent = `${n} delayed`;
      el.classList.remove('hidden');
      el.classList.toggle('active', this.delayedOnly);
    } else {
      el.classList.add('hidden');
      this.delayedOnly = false; // nothing to filter to
    }
  }

  toggleDelayedOnly() {
    this.delayedOnly = !this.delayedOnly;
    const el = document.getElementById('delay-filter');
    if (el) el.classList.toggle('active', this.delayedOnly);
  }

  setLastUpdate(date) {
    const el = document.getElementById('last-update');
    if (el) el.textContent = `Data: ${date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
  }

  setStaleWarning(ageMin) {
    const el = document.getElementById('stale-warning');
    if (!el) return;
    if (ageMin == null) {
      el.classList.add('hidden');
    } else {
      el.textContent = `Data ${ageMin}m old`;
      el.classList.remove('hidden');
    }
  }

  toggleLegend() {
    const body = document.getElementById('legend-body');
    const btn  = document.getElementById('legend-toggle');
    if (!body) return;
    const collapsed = body.classList.toggle('hidden');
    if (btn) btn.textContent = collapsed ? '▲' : '▼';
    try { localStorage.setItem('ptv-legend-collapsed', collapsed ? '1' : '0'); } catch {}
  }
}
