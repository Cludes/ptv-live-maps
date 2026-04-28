/* ============================================================
   PTVLiveMap - Main Application
   ============================================================
   Architecture:
     bootstrap()       - fetch routes + stops from PTV API, cache 1hr
     fetchLiveData()   - fetch departures from hub stop every 30s
     calculatePosition() - interpolate train position using timetable
     animate()         - rAF loop updates marker positions each frame
   ============================================================ */

'use strict';

class PTVLiveMap {
  constructor() {
    // Leaflet objects
    this.map         = null;
    this.routeGroup  = null;
    this.stopGroup   = null;
    this.trainGroup  = null;

    // Data stores
    this.routeData   = new Map(); // routeId -> { id, name, color, totalMinutes, stopIds }
    this.stopsData   = new Map(); // stopId  -> { id, name, lat, lng }

    // Live state
    this.liveRuns    = new Map(); // runId -> run object
    this.trainMarkers = new Map(); // runId -> { marker, el }

    // Layer caches
    this.routeLayers  = new Map(); // routeId -> L.polyline
    this.stopLayers   = new Map(); // stopId  -> L.circleMarker

    // UI state
    this.activeRoutes  = new Set(Object.keys(CONFIG.ROUTES).map(Number));
    this.showTrains    = true;
    this.showStations  = true;
    this.showRoutes    = true;
    this.panelOpen     = false;
    this.followedRunId = null;

    // Timers
    this.pollTimer  = null;
    this.animFrame  = null;
    this._animRunning = false;
  }

  // ──────────────────────────────────────────────────────────
  //  Entry point
  // ──────────────────────────────────────────────────────────
  async init() {
    this.initMap();
    this.setupKeyboard();
    await this.bootstrap();
    await this.fetchLiveData();
    this.startAnimation();
    this.startPolling();
  }

  // ──────────────────────────────────────────────────────────
  //  Map initialisation
  // ──────────────────────────────────────────────────────────
  initMap() {
    this.map = L.map('map', {
      center:  CONFIG.MAP_CENTER,
      zoom:    CONFIG.MAP_ZOOM,
      minZoom: CONFIG.MAP_MIN_ZOOM,
      maxZoom: CONFIG.MAP_MAX_ZOOM,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(this.map);

    // Separate layer groups so we can toggle each independently
    this.routeGroup = L.layerGroup().addTo(this.map);
    this.stopGroup  = L.layerGroup().addTo(this.map);
    this.trainGroup = L.layerGroup().addTo(this.map);
  }

  // ──────────────────────────────────────────────────────────
  //  Bootstrap: load static route + stop data (cached 1hr)
  // ──────────────────────────────────────────────────────────
  async bootstrap() {
    this.setStatus('loading');
    this.setCount('Loading network...');

    const CACHE_KEY = 'ptv_network_v2';
    const cached = this.loadCache(CACHE_KEY, CONFIG.BOOTSTRAP_CACHE_MS);
    if (cached) {
      this.applyNetworkData(cached);
      return;
    }

    try {
      // 1. Get all metro (route_type=0) routes
      const routesData = await this.apiGet('/v3/routes?route_types=0');
      const metroRoutes = (routesData.routes || []).filter(r => CONFIG.ROUTES[r.route_id]);

      if (!metroRoutes.length) throw new Error('No metro routes returned');

      // 2. Fetch stops for each route in controlled batches to stay within rate limits
      const stopResults = await this.batchFetch(
        metroRoutes.map(r => `/v3/stops/route/${r.route_id}/route_type/0?direction_id=0`)
      );

      const network = { routes: {}, stops: {} };

      metroRoutes.forEach((route, i) => {
        const cfg = CONFIG.ROUTES[route.route_id];
        const raw = stopResults[i];
        if (!cfg || !raw) return;

        const stops = (raw.stops || [])
          .filter(s => s.stop_latitude && s.stop_longitude)
          .sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0));

        network.routes[route.route_id] = {
          id:           route.route_id,
          name:         cfg.name,
          color:        cfg.color,
          totalMinutes: cfg.totalMinutes,
          stopIds:      stops.map(s => s.stop_id),
        };

        stops.forEach(s => {
          if (!network.stops[s.stop_id]) {
            network.stops[s.stop_id] = {
              id:   s.stop_id,
              name: (s.stop_name || '').replace(/ Station$/, ''),
              lat:  s.stop_latitude,
              lng:  s.stop_longitude,
            };
          }
        });
      });

      this.saveCache(CACHE_KEY, network);
      this.applyNetworkData(network);

    } catch (err) {
      console.error('[PTV] Bootstrap failed:', err);
      this.setStatus('error');
      this.setCount('Network load failed - check proxy config');
    }
  }

  applyNetworkData(network) {
    for (const [id, r] of Object.entries(network.routes)) {
      this.routeData.set(Number(id), r);
    }
    for (const [id, s] of Object.entries(network.stops)) {
      this.stopsData.set(Number(id), s);
    }
    this.renderNetwork();
    this.buildRouteFilters();
  }

  // ──────────────────────────────────────────────────────────
  //  Render static network (route lines + station dots)
  // ──────────────────────────────────────────────────────────
  renderNetwork() {
    this.routeGroup.clearLayers();
    this.stopGroup.clearLayers();
    this.routeLayers.clear();
    this.stopLayers.clear();

    // Draw route polylines
    for (const [routeId, route] of this.routeData) {
      const coords = route.stopIds
        .map(id => this.stopsData.get(id))
        .filter(Boolean)
        .map(s => [s.lat, s.lng]);

      if (coords.length < 2) continue;

      const poly = L.polyline(coords, {
        color:       route.color,
        weight:      CONFIG.ROUTE_WEIGHT,
        opacity:     CONFIG.ROUTE_OPACITY,
        smoothFactor: 1,
      });

      poly.bindTooltip(route.name + ' Line', { sticky: true, direction: 'top' });

      this.routeLayers.set(routeId, poly);
      if (this.showRoutes && this.activeRoutes.has(routeId)) {
        this.routeGroup.addLayer(poly);
      }
    }

    // Draw station dots (visible from zoom 12+)
    for (const [stopId, stop] of this.stopsData) {
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius:      3.5,
        fillColor:   '#ffffff',
        fillOpacity: 0.45,
        stroke:      false,
        interactive: true,
      }).bindTooltip(stop.name, { direction: 'top', offset: [0, -5] });

      marker.on('click', () => {
        this.map.setView([stop.lat, stop.lng], Math.max(this.map.getZoom(), 14));
      });

      this.stopLayers.set(stopId, marker);
      if (this.showStations) this.stopGroup.addLayer(marker);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Fetch live departures from hub stop (Flinders Street)
  // ──────────────────────────────────────────────────────────
  async fetchLiveData() {
    this.setStatus('loading');

    try {
      // Fetch departures from Flinders Street - expand=run gives us run details inline
      const data = await this.apiGet(
        `/v3/departures/route_type/0/stop/${CONFIG.HUB_STOP_ID}` +
        `?expand=run&max_results=${CONFIG.MAX_RESULTS}&look_backwards=false`
      );

      const departures = data.departures || [];
      const runs       = data.runs       || {};
      const now        = Date.now();
      const seen        = new Set();

      for (const dep of departures) {
        const runId  = dep.run_id;
        const run    = runs[runId];
        if (!run) continue;

        const routeId = dep.route_id;
        const cfg     = CONFIG.ROUTES[routeId];
        const route   = this.routeData.get(routeId);
        if (!cfg || !route || !route.stopIds.length) continue;

        // Prefer estimated time, fall back to scheduled
        const depTimeStr = dep.estimated_departure_utc || dep.scheduled_departure_utc;
        if (!depTimeStr) continue;

        const depMs  = Date.parse(depTimeStr);
        const schedMs = dep.scheduled_departure_utc ? Date.parse(dep.scheduled_departure_utc) : depMs;
        const delayMin = Math.round((depMs - schedMs) / 60000);

        // Hub stop index in this route's ordered stop list
        const hubIdx = route.stopIds.indexOf(CONFIG.HUB_STOP_ID);
        // If hub not found in route, use middle as approximation
        const effectiveHubIdx = hubIdx >= 0 ? hubIdx : Math.floor(route.stopIds.length / 2);

        const finalStop = this.stopsData.get(run.final_stop_id);

        seen.add(runId);

        const existing = this.liveRuns.get(runId);
        this.liveRuns.set(runId, {
          runId,
          routeId,
          routeName:   cfg.name,
          color:       cfg.color,
          directionId: dep.direction_id,
          directionName: run.direction_name || '',
          finalStopId:   run.final_stop_id,
          finalStopName: finalStop ? finalStop.name : (run.direction_name || ''),
          hubDepartureMs: depMs,
          hubStopIdx:    effectiveHubIdx,
          stopIds:       route.stopIds,
          totalMinutes:  cfg.totalMinutes,
          delayMin,
          vehicle:       run.vehicle_descriptor || null,
          lastSeen:      now,
          // Preserve smoothed position from previous frame to avoid jump on data refresh
          smoothLat: existing ? existing.smoothLat : null,
          smoothLng: existing ? existing.smoothLng : null,
        });
      }

      // Remove runs not seen for more than STALE_MULTIPLIER refresh cycles
      const staleThreshold = CONFIG.STALE_MULTIPLIER * CONFIG.LIVE_REFRESH_MS;
      for (const [runId, run] of this.liveRuns) {
        if (!seen.has(runId) && (now - run.lastSeen) > staleThreshold) {
          this.removeTrain(runId);
          this.liveRuns.delete(runId);
        }
      }

      const count = this.liveRuns.size;
      this.setCount(`${count} train${count !== 1 ? 's' : ''} active`);
      this.setLastUpdate(new Date());
      this.setStatus('ok');

    } catch (err) {
      console.error('[PTV] Live fetch failed:', err);
      this.setStatus('error');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Animation loop (requestAnimationFrame)
  // ──────────────────────────────────────────────────────────
  startAnimation() {
    if (this._animRunning) return;
    this._animRunning = true;

    const tick = () => {
      if (this.showTrains) this.updateTrainPositions();
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
  }

  updateTrainPositions() {
    const now = Date.now();

    for (const [runId, run] of this.liveRuns) {
      if (!this.activeRoutes.has(run.routeId)) {
        this.removeTrain(runId);
        continue;
      }

      const pos = this.calculatePosition(run, now);
      if (!pos) continue;

      // Smooth position: lerp 10% toward target each frame (~16ms) to prevent jitter on data refresh
      const SMOOTH = 0.08;
      if (run.smoothLat === null) {
        run.smoothLat = pos.lat;
        run.smoothLng = pos.lng;
      } else {
        run.smoothLat += (pos.lat - run.smoothLat) * SMOOTH;
        run.smoothLng += (pos.lng - run.smoothLng) * SMOOTH;
      }

      this.upsertTrainMarker(runId, run.smoothLat, run.smoothLng, run);
    }

    // Prune markers for removed runs
    for (const [runId] of this.trainMarkers) {
      if (!this.liveRuns.has(runId)) this.removeTrain(runId);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Position interpolation
  //
  //  Model: train departs hub stop at hubDepartureMs and moves
  //  along the stop sequence at a constant rate derived from
  //  totalMinutes / totalStops. This is a timetable-based
  //  approximation since PTV doesn't expose real GPS positions.
  // ──────────────────────────────────────────────────────────
  calculatePosition(run, now) {
    const { hubDepartureMs, hubStopIdx, stopIds, totalMinutes } = run;

    const stops = stopIds.map(id => this.stopsData.get(id)).filter(Boolean);
    if (stops.length < 2) return null;

    const elapsedMin = (now - hubDepartureMs) / 60000;
    const minPerStop = totalMinutes / stops.length;

    // Float index along the stop sequence from the hub stop
    let floatIdx = hubStopIdx + elapsedMin / minPerStop;

    // Clamp to valid range
    floatIdx = Math.max(0, Math.min(stops.length - 1.001, floatIdx));

    const prevIdx = Math.floor(floatIdx);
    const nextIdx = prevIdx + 1;
    const t       = floatIdx - prevIdx; // 0..1 progress between stops

    if (nextIdx >= stops.length) {
      return { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng };
    }

    const prev = stops[prevIdx];
    const next = stops[nextIdx];

    return {
      lat: prev.lat + (next.lat - prev.lat) * t,
      lng: prev.lng + (next.lng - prev.lng) * t,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  Marker create / update
  // ──────────────────────────────────────────────────────────
  upsertTrainMarker(runId, lat, lng, run) {
    const latlng  = [lat, lng];
    const isLate  = run.delayMin > 2;

    if (this.trainMarkers.has(runId)) {
      const { marker, el } = this.trainMarkers.get(runId);
      marker.setLatLng(latlng);
      if (el) el.classList.toggle('late', isLate);
      if (this.followedRunId === runId) {
        this.map.setView(latlng, this.map.getZoom(), { animate: false });
      }
    } else {
      // Build DOM element for the dot (DivIcon gives full CSS control)
      const el  = document.createElement('div');
      el.className = `tm${isLate ? ' late' : ''}`;
      el.style.cssText = `background:${run.color};box-shadow:0 0 7px ${run.color}80;`;

      const icon = L.divIcon({
        html:       el,
        className:  '',
        iconSize:   [CONFIG.TRAIN_DOT_SIZE, CONFIG.TRAIN_DOT_SIZE],
        iconAnchor: [CONFIG.TRAIN_DOT_SIZE / 2, CONFIG.TRAIN_DOT_SIZE / 2],
      });

      const marker = L.marker(latlng, { icon, zIndexOffset: 500 });
      marker.on('click', () => this.showTrainInfo(runId));

      this.trainGroup.addLayer(marker);
      this.trainMarkers.set(runId, { marker, el });
    }
  }

  removeTrain(runId) {
    if (this.trainMarkers.has(runId)) {
      const { marker } = this.trainMarkers.get(runId);
      this.trainGroup.removeLayer(marker);
      this.trainMarkers.delete(runId);
    }
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

    this.followedRunId = runId;
    this.syncFollowBtn();

    const delayHtml = run.delayMin > 2
      ? `<span class="ti-late">+${run.delayMin} min late</span>`
      : `<span class="ti-ontime">On time</span>`;

    const vehicleStr = run.vehicle
      ? (run.vehicle.id || run.vehicle.low_floor_description || '')
      : '';

    document.getElementById('train-info-body').innerHTML = `
      <div class="ti-route" style="color:${run.color}">${run.routeName} Line</div>
      <div class="ti-dest">To ${run.finalStopName || run.directionName}</div>
      <div class="ti-row"><span class="ti-label">Status</span><span class="ti-value">${delayHtml}</span></div>
      <div class="ti-row"><span class="ti-label">Run ID</span><span class="ti-value">${run.runId}</span></div>
      <div class="ti-row"><span class="ti-label">Direction</span><span class="ti-value">${run.directionName || '-'}</span></div>
      ${vehicleStr ? `<div class="ti-row"><span class="ti-label">Vehicle</span><span class="ti-value">${vehicleStr}</span></div>` : ''}
      <div class="ti-row"><span class="ti-label">Stops</span><span class="ti-value">${run.stopIds.length}</span></div>
    `;

    document.getElementById('train-info').classList.remove('hidden');
  }

  closeTrainInfo() {
    this.followedRunId = null;
    this.syncFollowBtn();
    document.getElementById('train-info').classList.add('hidden');
  }

  toggleFollow() {
    if (this.followedRunId) {
      this.followedRunId = null;
    }
    // If called while an info panel is open but not following, start following
    // (button is only visible when train info is open, so runId is known)
    this.syncFollowBtn();
  }

  syncFollowBtn() {
    const btn = document.getElementById('follow-btn');
    if (!btn) return;
    btn.classList.toggle('active', !!this.followedRunId);
    btn.textContent = this.followedRunId ? 'Unfollow' : 'Follow Train';
  }

  // ──────────────────────────────────────────────────────────
  //  Layer visibility toggles
  // ──────────────────────────────────────────────────────────
  toggleLayer(layer, visible) {
    if (layer === 'trains') {
      this.showTrains = visible;
      if (!visible) {
        for (const [id] of this.trainMarkers) this.removeTrain(id);
      }
    }

    if (layer === 'stations') {
      this.showStations = visible;
      this.stopGroup.clearLayers();
      if (visible) {
        for (const [, marker] of this.stopLayers) this.stopGroup.addLayer(marker);
      }
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
  //  Route filter chips
  // ──────────────────────────────────────────────────────────
  buildRouteFilters() {
    const container = document.getElementById('route-filters');
    if (!container) return;
    container.innerHTML = '';

    // Only show routes we actually loaded data for
    const loadedIds = new Set(this.routeData.keys());

    for (const [idStr, cfg] of Object.entries(CONFIG.ROUTES)) {
      const id = Number(idStr);
      if (!loadedIds.has(id)) continue;

      const el = document.createElement('div');
      el.className = 'rf-item';
      el.dataset.routeId = id;
      el.innerHTML =
        `<span class="rf-dot" style="background:${cfg.color}"></span>` +
        `<span>${cfg.name}</span>`;

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

      container.appendChild(el);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Panel toggle
  // ──────────────────────────────────────────────────────────
  togglePanel() {
    this.panelOpen = !this.panelOpen;
    const panel  = document.getElementById('panel');
    const legend = document.getElementById('legend');

    panel.classList.toggle('panel-hidden', !this.panelOpen);
    panel.setAttribute('aria-hidden', String(!this.panelOpen));

    // Nudge legend left to avoid overlap
    if (legend) {
      legend.style.right = this.panelOpen
        ? `calc(var(--panel-w) + 14px)`
        : '14px';
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Search
  // ──────────────────────────────────────────────────────────
  setupKeyboard() {
    const input   = document.getElementById('search-input');
    const results = document.getElementById('search-results');

    if (input) {
      input.addEventListener('input', e => this.handleSearch(e.target.value));
      input.addEventListener('blur',  () => setTimeout(() => { results.innerHTML = ''; }, 200));
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        this.closeTrainInfo();
        if (results) results.innerHTML = '';
      }
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && e.target.tagName !== 'INPUT') {
        this.toggleFullscreen();
      }
    });
  }

  handleSearch(query) {
    const results = document.getElementById('search-results');
    if (!results) return;

    if (!query || query.length < 2) { results.innerHTML = ''; return; }

    const q  = query.toLowerCase();
    const matches = [...this.stopsData.values()]
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 8);

    if (!matches.length) {
      results.innerHTML = '<div class="sr-item" style="color:#555;cursor:default">No stations found</div>';
      return;
    }

    results.innerHTML = matches.map(s => {
      // Find a color for this stop's first associated route
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
  //  Utility actions
  // ──────────────────────────────────────────────────────────
  resetView() {
    this.map.setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  clearCache() {
    try { localStorage.removeItem('ptv_network_v2'); } catch {}
    location.reload();
  }

  // ──────────────────────────────────────────────────────────
  //  Polling
  // ──────────────────────────────────────────────────────────
  startPolling() {
    this.pollTimer = setInterval(() => this.fetchLiveData(), CONFIG.LIVE_REFRESH_MS);
  }

  // ──────────────────────────────────────────────────────────
  //  PTV API request via proxy
  // ──────────────────────────────────────────────────────────
  async apiGet(path) {
    const url = `${CONFIG.PROXY_URL}?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 80)}`);
    }
    return res.json();
  }

  // Batch parallel fetches in groups to avoid hammering the proxy
  async batchFetch(paths, batchSize = 4) {
    const results = [];
    for (let i = 0; i < paths.length; i += batchSize) {
      const chunk = paths.slice(i, i + batchSize);
      const settled = await Promise.allSettled(chunk.map(p => this.apiGet(p)));
      results.push(...settled.map(r => r.status === 'fulfilled' ? r.value : null));
    }
    return results;
  }

  // ──────────────────────────────────────────────────────────
  //  Status helpers
  // ──────────────────────────────────────────────────────────
  setStatus(state) {
    const el = document.getElementById('api-dot');
    if (!el) return;
    el.className = { ok: 'dot-ok', error: 'dot-error', loading: 'dot-loading' }[state] || 'dot-loading';
    el.title     = { ok: 'API live', error: 'API error', loading: 'Fetching...' }[state] || '';
  }

  setCount(text) {
    const el = document.getElementById('train-count');
    if (el) el.textContent = text;
  }

  setLastUpdate(date) {
    const el = document.getElementById('last-update');
    if (el) {
      el.textContent = `Updated ${date.toLocaleTimeString('en-AU', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })}`;
    }
  }

  // ──────────────────────────────────────────────────────────
  //  localStorage cache helpers
  // ──────────────────────────────────────────────────────────
  loadCache(key, maxAgeMs) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > maxAgeMs) return null;
      return data;
    } catch { return null; }
  }

  saveCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* storage quota exceeded - continue without cache */ }
  }
}
