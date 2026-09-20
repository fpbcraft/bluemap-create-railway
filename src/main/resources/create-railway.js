(() => {
  "use strict";

  const BASE_URL = new URL("create-railway/", window.location.href);
  const STATUS_COLORS = {
    FREE: "#53d769",
    RESERVED: "#f5b642",
    OCCUPIED: "#ef5350",
    PASSIVE: "#718096",
  };
  const SIGNAL_COLORS = {
    GREEN: "#53d769",
    YELLOW: "#ffd54f",
    RED: "#ef5350",
    INVALID: "#9ca3af",
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const safeText = (value, fallback = "—") =>
    value === undefined || value === null || value === "" ? fallback : String(value);
  const formatSpeed = (speed) => `${Math.abs(Number(speed || 0)).toFixed(1)} b/t`;
  const formatState = (state) =>
    safeText(state, "unknown").toLowerCase().replaceAll("_", " ");

  class RailwayOverlay {
    constructor(app, api, integration) {
      this.app = app;
      this.api = api;
      this.integration = integration;
      this.mapWorlds = integration.mapWorlds || {};
      this.pollMs = Math.max(500, Number(integration.pollIntervalMs) || 1000);
      this.dimension = null;
      this.disposed = false;
      this.failedFetches = 0;
      this.stationMarkers = new Map();
      this.signalMarkers = new Map();
      this.segmentMarkers = new Map();
      this.trainMarkers = new Map();
      this.visibility = {
        stations: true,
        signals: true,
        segments: true,
        trains: true,
        passive: false,
      };

      this.root = new api.MarkerSet("create-railway", {
        label: "Create railway",
        toggleable: false,
      });
      this.stations = new api.MarkerSet("create-railway-stations", { toggleable: false });
      this.signals = new api.MarkerSet("create-railway-signals", { toggleable: false });
      this.segments = new api.MarkerSet("create-railway-segments", { toggleable: false });
      this.trains = new api.MarkerSet("create-railway-trains", { toggleable: false });
      this.root.add(this.segments, this.stations, this.signals, this.trains);
      app.popupMarkerSet.add(this.root);

      this.tooltip = document.createElement("div");
      this.tooltip.className = "create-railway-tooltip";
      this.tooltip.hidden = true;
      document.body.append(this.tooltip);

      this.controls = this.createControls();
      document.body.append(this.controls);
      this.applyVisibility();
      this.loop();
    }

    currentMapId() {
      return this.app.mapViewer?.map?.data?.id || this.app.mapViewer?.map?.id || null;
    }

    currentDimension() {
      const mapId = this.currentMapId();
      return mapId ? this.mapWorlds[mapId] || null : null;
    }

    createControls() {
      const host = document.createElement("div");
      host.className = "create-railway-controls";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "create-railway-controls__button";
      button.textContent = "Railway";
      button.setAttribute("aria-expanded", "false");

      const panel = document.createElement("div");
      panel.className = "create-railway-controls__panel";
      panel.hidden = true;

      const heading = document.createElement("div");
      heading.className = "create-railway-controls__heading";
      heading.textContent = "Create railway";
      panel.append(heading);

      const addToggle = (key, label) => {
        const row = document.createElement("label");
        row.className = "create-railway-toggle";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = this.visibility[key];
        input.addEventListener("change", () => {
          this.visibility[key] = input.checked;
          this.applyVisibility();
        });
        const span = document.createElement("span");
        span.textContent = label;
        row.append(input, span);
        panel.append(row);
      };

      addToggle("stations", "Stations");
      addToggle("trains", "Train labels");
      addToggle("signals", "Signals");
      addToggle("segments", "Signal sections");
      addToggle("passive", "Unsignalled track");

      const legend = document.createElement("div");
      legend.className = "create-railway-legend";
      for (const [state, color] of Object.entries(STATUS_COLORS)) {
        if (state === "PASSIVE") continue;
        const item = document.createElement("span");
        const dot = document.createElement("i");
        dot.style.background = color;
        item.append(dot, document.createTextNode(state.toLowerCase()));
        legend.append(item);
      }
      panel.append(legend);

      this.statusElement = document.createElement("div");
      this.statusElement.className = "create-railway-controls__status";
      this.statusElement.textContent = "Connecting…";
      panel.append(this.statusElement);

      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
      });

      host.append(button, panel);
      return host;
    }

    applyVisibility() {
      const pairs = [
        [this.stations, this.visibility.stations],
        [this.signals, this.visibility.signals],
        [this.segments, this.visibility.segments],
        [this.trains, this.visibility.trains],
      ];
      for (const [set, visible] of pairs) {
        const attached = this.root.children.includes(set);
        if (visible && !attached) this.root.add(set);
        if (!visible && attached) this.root.remove(set);
      }
      for (const marker of this.segmentMarkers.values()) {
        marker.line.visible = marker.__status !== "PASSIVE" || this.visibility.passive;
      }
    }

    async loop() {
      while (!this.disposed) {
        const nextDimension = this.currentDimension();
        if (nextDimension !== this.dimension) {
          this.dimension = nextDimension;
          this.clearAll();
        }
        await this.refresh();
        await sleep(this.pollMs);
      }
    }

    async refresh() {
      if (!this.dimension) {
        this.setStatus("No Minecraft dimension mapping for this map");
        return;
      }
      try {
        const response = await fetch(new URL(`state.json?t=${Date.now()}`, BASE_URL), {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const state = await response.json();
        const data = state.dimensions?.[this.dimension] || {
          stations: [],
          signals: [],
          segments: [],
          trains: [],
        };
        this.render(data);
        this.failedFetches = 0;
        const age = Math.max(0, Date.now() - Number(state.generatedAt || Date.now()));
        const stale = age > this.pollMs * 4 ? " · stale" : "";
        this.setStatus(
          `${data.trains?.length || 0} trains · ${data.stations?.length || 0} stations · ${data.signals?.length || 0} signals${stale}`,
        );
      } catch (error) {
        this.failedFetches++;
        if (this.failedFetches === 1) console.warn("[Create Railway] state fetch failed", error);
        this.setStatus("Railway telemetry unavailable");
      }
    }

    render(data) {
      this.renderStations(data.stations || []);
      this.renderSignals(data.signals || []);
      this.renderSegments(data.segments || []);
      this.renderTrains(data.trains || []);
      this.applyVisibility();
    }

    renderStations(stations) {
      const keep = new Set();
      for (const station of stations) {
        keep.add(station.id);
        let marker = this.stationMarkers.get(station.id);
        if (!marker) {
          marker = new this.api.HtmlMarker(`station-${station.id}`);
          marker.anchor.set(15, 15);
          marker.element.className = "create-railway-station";
          marker.element.tabIndex = 0;
          const icon = document.createElement("span");
          icon.className = "create-railway-station__icon";
          icon.textContent = "S";
          const name = document.createElement("span");
          name.className = "create-railway-station__name";
          marker.element.append(icon, name);
          this.bindTooltip(marker.element, () => marker.__tooltip);
          this.stations.add(marker);
          this.stationMarkers.set(station.id, marker);
        }
        marker.element.querySelector(".create-railway-station__name").textContent =
          safeText(station.name, "Station");
        marker.__tooltip = [
          safeText(station.name, "Station"),
          station.assembling ? "Assembly mode" : null,
          station.presentTrain ? `At platform: ${station.presentTrain}` : null,
          !station.presentTrain && station.imminentTrain
            ? `Approaching: ${station.imminentTrain}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");
        marker.element.setAttribute("aria-label", marker.__tooltip);
        marker.position.set(station.x, station.y + 1.25, station.z);
      }
      this.removeMissing(this.stationMarkers, this.stations, keep);
    }

    renderSignals(signals) {
      const keep = new Set();
      for (const signal of signals) {
        keep.add(signal.id);
        let marker = this.signalMarkers.get(signal.id);
        if (!marker) {
          marker = new this.api.HtmlMarker(`signal-${signal.id}`);
          marker.anchor.set(6, 6);
          marker.element.className = "create-railway-signal";
          marker.element.tabIndex = 0;
          this.bindTooltip(marker.element, () => marker.__tooltip);
          this.signals.add(marker);
          this.signalMarkers.set(signal.id, marker);
        }
        const state = safeText(signal.state, "INVALID").toUpperCase();
        marker.element.dataset.state = state;
        marker.element.style.setProperty(
          "--signal-color",
          SIGNAL_COLORS[state] || SIGNAL_COLORS.INVALID,
        );
        marker.__tooltip = [
          `${formatState(signal.type)} signal · ${state.toLowerCase()}`,
          signal.powered ? "Forced by redstone" : null,
          signal.group ? `Block ${signal.group.slice(0, 8)}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        marker.element.setAttribute("aria-label", marker.__tooltip);
        marker.position.set(signal.x, signal.y, signal.z);
      }
      this.removeMissing(this.signalMarkers, this.signals, keep);
    }

    renderSegments(segments) {
      const keep = new Set();
      for (const segment of segments) {
        if (!segment.points || segment.points.length < 2) continue;
        keep.add(segment.id);
        let marker = this.segmentMarkers.get(segment.id);
        if (!marker) {
          marker = new this.api.LineMarker(`segment-${segment.id}`);
          marker.line.depthTest = false;
          marker.line.linewidth = 4;
          marker.line.opacity = 0.82;
          marker.setLine(segment.points.flatMap((point) => [point.x, point.y, point.z]));
          this.segments.add(marker);
          this.segmentMarkers.set(segment.id, marker);
        }
        const status = safeText(segment.status, "FREE").toUpperCase();
        marker.__status = status;
        marker.line.color.setStyle(STATUS_COLORS[status] || STATUS_COLORS.FREE);
        marker.line.opacity = status === "PASSIVE" ? 0.28 : 0.82;
        marker.line.linewidth = status === "OCCUPIED" ? 6 : status === "RESERVED" ? 5 : 4;
        marker.line.visible = status !== "PASSIVE" || this.visibility.passive;
        marker.line.userData.createRailway = {
          status,
          group: segment.group,
          trains: segment.trains || [],
        };
      }
      this.removeMissing(this.segmentMarkers, this.segments, keep);
    }

    renderTrains(trains) {
      const keep = new Set();
      for (const train of trains) {
        keep.add(train.id);
        let marker = this.trainMarkers.get(train.id);
        if (!marker) {
          marker = new this.api.HtmlMarker(`train-${train.id}`);
          marker.anchor.set(14, 28);
          marker.element.className = "create-railway-train";
          marker.element.tabIndex = 0;
          const glyph = document.createElement("span");
          glyph.className = "create-railway-train__glyph";
          glyph.textContent = "▰";
          const label = document.createElement("span");
          label.className = "create-railway-train__label";
          marker.element.append(glyph, label);
          this.bindTooltip(marker.element, () => marker.__tooltip);
          this.trains.add(marker);
          this.trainMarkers.set(train.id, marker);
        }
        marker.element.querySelector(".create-railway-train__label").textContent =
          safeText(train.name, "Train");
        marker.element.dataset.state = safeText(train.state, "RUNNING");
        marker.__tooltip = [
          safeText(train.name, "Train"),
          `${formatSpeed(train.speed)} · ${formatState(train.state)}`,
          train.currentStation ? `At ${train.currentStation}` : null,
          !train.currentStation && train.targetStation
            ? `→ ${train.targetStation}${train.targetDistance ? ` · ${train.targetDistance} m` : ""}`
            : null,
          train.waitingForSignal ? "Waiting at signal" : null,
          train.owner ? `Driver: ${train.owner}` : null,
          `${train.carriages || 0} carriage${train.carriages === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join("\n");
        marker.element.setAttribute("aria-label", marker.__tooltip);
        marker.position.set(train.x, train.y, train.z);
      }
      this.removeMissing(this.trainMarkers, this.trains, keep);
    }

    bindTooltip(element, text) {
      const show = (event) => {
        const value = text();
        if (!value) return;
        this.tooltip.textContent = value;
        this.tooltip.hidden = false;
        const bounds = element.getBoundingClientRect();
        const x = event?.clientX || bounds.right;
        const y = event?.clientY || bounds.top;
        this.tooltip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - this.tooltip.offsetWidth - 8))}px`;
        this.tooltip.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - this.tooltip.offsetHeight - 8))}px`;
      };
      element.addEventListener("pointerenter", show);
      element.addEventListener("pointermove", show);
      element.addEventListener("pointerleave", () => (this.tooltip.hidden = true));
      element.addEventListener("focus", show);
      element.addEventListener("blur", () => (this.tooltip.hidden = true));
    }

    removeMissing(map, set, keep) {
      for (const [id, marker] of map) {
        if (keep.has(id)) continue;
        set.remove(marker);
        map.delete(id);
      }
    }

    clearSet(map, set) {
      for (const marker of map.values()) set.remove(marker);
      map.clear();
    }

    clearAll() {
      this.clearSet(this.stationMarkers, this.stations);
      this.clearSet(this.signalMarkers, this.signals);
      this.clearSet(this.segmentMarkers, this.segments);
      this.clearSet(this.trainMarkers, this.trains);
    }

    setStatus(text) {
      if (this.statusElement) this.statusElement.textContent = text;
    }

    dispose() {
      this.disposed = true;
      this.clearAll();
      this.app.popupMarkerSet.remove(this.root);
      this.tooltip.remove();
      this.controls.remove();
    }
  }

  async function loadIntegration() {
    const response = await fetch(new URL(`integration.json?t=${Date.now()}`, BASE_URL), {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`integration.json HTTP ${response.status}`);
    return response.json();
  }

  async function start() {
    for (let attempt = 0; attempt < 120; attempt++) {
      const app = window.bluemap;
      const api = window.BlueMap;
      if (
        app?.mapViewer?.markers &&
        app?.popupMarkerSet &&
        api?.MarkerSet &&
        api?.HtmlMarker &&
        api?.LineMarker
      ) {
        try {
          const integration = await loadIntegration();
          if (window.__createRailwayOverlay) window.__createRailwayOverlay.dispose();
          window.__createRailwayOverlay = new RailwayOverlay(app, api, integration);
          console.info("[Create Railway] BlueMap railway overlay ready");
          return;
        } catch (error) {
          console.warn("[Create Railway] initialization failed", error);
        }
      }
      await sleep(500);
    }
    console.warn("[Create Railway] BlueMap web API was not available");
  }

  start();
})();
