/* ============================================================
   PTVLiveMap - Main Application
   ============================================================
   Data flow (GitHub Pages / GitHub Actions):
     data/network.json  - routes + stops fetched daily by GH Actions
     data/live.json     - departures fetched ~every 60s by GH Actions

   The browser never calls the PTV API directly.
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

    this.routeData    = new Map(); // routeId -> { id, name, color, totalMinutes, stopIds }
    this.stopsData    = new Map(); // stopId  -> { id, name, lat, lng }

    this.liveRuns     = new Map(); // runId -> run state object
    this.trainMarkers = new Map(); // runId -> { marker, el }
    this.routeLayers  = new Map(); // routeId -> L.polyline
    this.stopLayers   = new Map(); // stopId  -> L.circleMarker
    this.stopToRoutes = new Map(); // stopId  -> Set<routeId>

    this.activeRoutes  = new Set(Object.keys(CONFIG.ROUTES).map(Number));
    this.showTrains    = true;
    this.showStations  = true;
    this.showRoutes    = true;
    this.panelOpen     = false;
    this.followedRunId = null;
    this._infoRunId    = null;

    this.pollTimer      = null;
    this.animFrame      = null;
    this._animRunning   = false;
    this._demoMode      = false;
    this._lastPollAt         = null;
    this._countdownTimer     = null;
    this._highlightedRouteId = null;
    this.routeFilterEls      = new Map(); // routeId -> chip element

    // Track the last data/live.json fetch time to detect stale data
    this._lastFetchedAt = null;
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
    await this.loadNetworkData();
    await Promise.all([this.fetchLiveData(), this.loadDisruptions()]);
    this.startAnimation();
    this.startPolling();
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
    });

    this.tileLayer = L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      subdomains:  'abcd',
      maxZoom:     20,
    }).addTo(this.map);

    this.routeGroup = L.layerGroup().addTo(this.map);
    this.stopGroup  = L.layerGroup().addTo(this.map);
    this.trainGroup = L.layerGroup().addTo(this.map);
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
        this.stopsData.set(Number(id), s);
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
    this.routeLayers.clear();
    this.stopLayers.clear();
    this.stopToRoutes.clear();

    for (const [routeId, route] of this.routeData) {
      if (!Array.isArray(route.stopIds) || route.stopIds.length < 2) continue;

      const coords = route.stopIds
        .map(id => this.stopsData.get(id))
        .filter(Boolean)
        .map(s => [s.lat, s.lng]);

      if (coords.length < 2) continue;

      const poly = L.polyline(coords, {
        color:        route.color,
        weight:       CONFIG.ROUTE_WEIGHT,
        opacity:      CONFIG.ROUTE_OPACITY,
        smoothFactor: 1,
      });
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
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius:      3.5,
        fillColor:   '#ffffff',
        fillOpacity: 0.4,
        stroke:      false,
      }).bindTooltip(stop.name, { direction: 'top', offset: [0, -5] });

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
      if (this.showStations) this.stopGroup.addLayer(marker);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Fetch live departures (data/live.json written by GH Actions)
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
        const delayedStr = delayed > 0 ? `, ${delayed} delayed` : '';
        this.setCount(`${count} train${count !== 1 ? 's' : ''} active${delayedStr}`);
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
  async loadDisruptions() {
    try {
      const res  = await fetch(`data/disruptions.json?t=${Date.now()}`);
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

      // Demo: reverse direction when reaching the end of the route
      if (run._demo) {
        const stops = run.stopIds.map(id => this.stopsData.get(id)).filter(Boolean);
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

      this.upsertTrainMarker(runId, run.smoothLat, run.smoothLng, run);
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

  // Returns { stops, floatIdx } plus distance fields if available.
  // All position/ETA methods share this to avoid duplicating the math.
  _computeProgress(run, now) {
    const stops = run.stopIds.map(id => this.stopsData.get(id)).filter(Boolean);
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
      return { lat: last.lat, lng: last.lng };
    }
    return {
      lat: stops[prevIdx].lat + (stops[nextIdx].lat - stops[prevIdx].lat) * t,
      lng: stops[prevIdx].lng + (stops[nextIdx].lng - stops[prevIdx].lng) * t,
    };
  }

  // ──────────────────────────────────────────────────────────
  //  Train marker management
  // ──────────────────────────────────────────────────────────
  upsertTrainMarker(runId, lat, lng, run) {
    const latlng = [lat, lng];
    const isLate = run.delayMin > 2;

    if (this.trainMarkers.has(runId)) {
      const { marker, el } = this.trainMarkers.get(runId);
      marker.setLatLng(latlng);
      if (el) el.classList.toggle('late', isLate);
      if (this.followedRunId === runId) {
        this.map.setView(latlng, this.map.getZoom(), { animate: false });
      }
    } else {
      const el = document.createElement('div');
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
      if (!visible) for (const [id] of this.trainMarkers) this.removeTrain(id);
    }
    if (layer === 'stations') {
      this.showStations = visible;
      this.stopGroup.clearLayers();
      if (visible) for (const [, m] of this.stopLayers) this.stopGroup.addLayer(m);
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
        this.closeTrainInfo();
        if (results) results.innerHTML = '';
      }
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && e.target.tagName !== 'INPUT') {
        this.toggleFullscreen();
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

  resetView()        { this.map.setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM); }
  toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }
  clearCache() {
    try { localStorage.clear(); } catch {}
    location.reload();
  }

  // ──────────────────────────────────────────────────────────
  //  Polling - re-reads data/live.json on interval
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

    for (const [routeIdStr, stopIds] of Object.entries(CONFIG.DEMO_STOPS)) {
      const routeId = Number(routeIdStr);
      const cfg     = CONFIG.ROUTES[routeId];
      if (!cfg) continue;

      const totalMs = cfg.totalMinutes * 60000;

      // One outbound train 25% through, one inbound train 25% through return
      this.liveRuns.set(id, this._makeDemoRun(id++, routeId, cfg, [...stopIds],          now - totalMs * 0.25));
      this.liveRuns.set(id, this._makeDemoRun(id++, routeId, cfg, [...stopIds].reverse(), now - totalMs * 0.25));
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
