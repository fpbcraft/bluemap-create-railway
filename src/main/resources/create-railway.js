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
  const formatEta = (distance, speed) => {
    const blocksPerSecond = Math.abs(Number(speed || 0)) * 20;
    if (!distance || blocksPerSecond < 0.05) return null;
    const seconds = Math.ceil(Number(distance) / blocksPerSecond);
    return seconds < 60 ? `~${seconds}s` : `~${Math.ceil(seconds / 60)}m`;
  };

  class RailwayOverlay {
    constructor(app, api, integration) {
      this.app = app;
      this.api = api;
      this.integration = integration;
      this.mapWorlds = integration.mapWorlds || {};
      this.pollMs = Math.max(500, Number(integration.pollIntervalMs) || 1000);
      this.dimension = null;
      this.disposed = false;
      this.active = false;
      this.failedFetches = 0;
      this.stationMarkers = new Map();
      this.signalMarkers = new Map();
      this.segmentMarkers = new Map();
      this.trainMarkers = new Map();
      this.trainById = new Map();
      this.selectedTrainId = null;
      this.blueMap3DDetected = false;
      this.trainLabelTouched = false;
      this.blueMap3DMeshes = [];
      this.toggleInputs = new Map();
      this.listeners = new AbortController();
      this.raycaster = api?.Three?.Raycaster ? new api.Three.Raycaster() : null;
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
      this.bindBlueMap3DInteractions();
      this.applyVisibility();
      this.setStatus("Open Railway to load live telemetry");
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
        this.toggleInputs.set(key, input);
        input.addEventListener("change", () => {
          this.visibility[key] = input.checked;
          if (key === "trains") this.trainLabelTouched = true;
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

      this.selectionElement = document.createElement("div");
      this.selectionElement.className = "create-railway-selection";
      this.selectionElement.hidden = true;
      panel.append(this.selectionElement);

      this.statusElement = document.createElement("div");
      this.statusElement.className = "create-railway-controls__status";
      this.statusElement.textContent = "Connecting…";
      panel.append(this.statusElement);

      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
        if (!panel.hidden) this.activate();
      });

      host.append(button, panel);
      return host;
    }

    activate() {
      if (this.active || this.disposed) return;
      this.active = true;
      this.setStatus("Connecting…");
      void this.loop();
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
      for (const marker of this.segmentMarkers.values()) this.styleSegment(marker);
    }

    async loop() {
      while (!this.disposed && this.active) {
        if (document.visibilityState === "hidden") {
          await sleep(this.pollMs);
          continue;
        }
        const nextDimension = this.currentDimension();
        if (nextDimension !== this.dimension) {
          this.dimension = nextDimension;
          this.clearSelection();
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
        const linked = this.blueMap3DDetected ? " · 3D linked" : "";
        this.setStatus(
          `${data.trains?.length || 0} trains · ${data.stations?.length || 0} stations · ${data.signals?.length || 0} signals${linked}${stale}`,
        );
      } catch (error) {
        this.failedFetches++;
        if (this.failedFetches === 1) console.warn("[Create Railway] state fetch failed", error);
        this.setStatus("Railway telemetry unavailable");
      }
    }

    render(data) {
      const trains = data.trains || [];
      const segments = data.segments || [];
      this.trainById = new Map(trains.map((train) => [train.id, train]));
      this.groupInfo = this.buildGroupInfo(segments);
      this.renderSegments(segments);
      this.renderSignals(data.signals || []);
      this.renderTrains(trains);
      this.renderStations(data.stations || []);
      this.syncBlueMap3DMeshes();
      this.renderSelectedTrain();
      this.applyVisibility();
    }

    buildGroupInfo(segments) {
      const groups = new Map();
      for (const segment of segments) {
        if (!segment.group) continue;
        const group = groups.get(segment.group) || {
          trainIds: new Set(),
          reservedTrainIds: new Set(),
        };
        for (const id of segment.trainIds || []) group.trainIds.add(id);
        for (const id of segment.reservedTrainIds || []) group.reservedTrainIds.add(id);
        groups.set(segment.group, group);
      }
      return groups;
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
        const inbound = [...this.trainById.values()]
          .filter(
            (train) =>
              train.targetStation === station.name &&
              train.currentStation !== station.name &&
              Number(train.targetDistance) > 0,
          )
          .sort((a, b) => Number(a.targetDistance) - Number(b.targetDistance))
          .slice(0, 3)
          .map((train) => {
            const eta = formatEta(train.targetDistance, train.speed);
            return `Inbound: ${safeText(train.name, "Train")} · ${train.targetDistance} m${eta ? ` · ${eta}` : ""}`;
          });
        marker.__tooltip = [
          safeText(station.name, "Station"),
          station.assembling ? "Assembly mode" : null,
          station.presentTrain ? `At platform: ${station.presentTrain}` : null,
          !station.presentTrain && station.imminentTrain
            ? `Approaching: ${station.imminentTrain}`
            : null,
          ...inbound,
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
        const block = signal.group ? this.groupInfo?.get(signal.group) : null;
        const occupied = block
          ? [...block.trainIds]
              .map((id) => this.trainById.get(id)?.name)
              .filter(Boolean)
              .join(", ")
          : "";
        const reserved = block
          ? [...block.reservedTrainIds]
              .map((id) => this.trainById.get(id)?.name)
              .filter(Boolean)
              .join(", ")
          : "";
        marker.__tooltip = [
          `${formatState(signal.type)} signal · ${state.toLowerCase()}`,
          signal.powered ? "Forced by redstone" : null,
          signal.group ? `Block ${signal.group.slice(0, 8)}` : null,
          occupied ? `Occupied by: ${occupied}` : null,
          reserved ? `Reserved for: ${reserved}` : null,
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
          marker.setLine(segment.points.flatMap((point) => [point.x, point.y, point.z]));
          this.segments.add(marker);
          this.segmentMarkers.set(segment.id, marker);
        }
        marker.__status = safeText(segment.status, "FREE").toUpperCase();
        marker.__trainIds = segment.trainIds || [];
        marker.__reservedTrainIds = segment.reservedTrainIds || [];
        marker.line.userData.createRailway = {
          status: marker.__status,
          group: segment.group,
          trains: segment.trains || [],
          trainIds: marker.__trainIds,
          reservedTrainIds: marker.__reservedTrainIds,
        };
        this.styleSegment(marker);
      }
      this.removeMissing(this.segmentMarkers, this.segments, keep);
    }

    styleSegment(marker) {
      const status = marker.__status || "FREE";
      const occupiedBySelected =
        this.selectedTrainId && (marker.__trainIds || []).includes(this.selectedTrainId);
      const reservedBySelected =
        this.selectedTrainId &&
        (marker.__reservedTrainIds || []).includes(this.selectedTrainId);
      const selected = occupiedBySelected || reservedBySelected;
      marker.line.color.setStyle(
        reservedBySelected && !occupiedBySelected
          ? STATUS_COLORS.RESERVED
          : STATUS_COLORS[status] || STATUS_COLORS.FREE,
      );
      marker.line.opacity = selected ? 1 : status === "PASSIVE" ? 0.28 : 0.82;
      marker.line.linewidth = selected
        ? 9
        : status === "OCCUPIED"
          ? 6
          : status === "RESERVED"
            ? 5
            : 4;
      marker.line.visible =
        selected || status !== "PASSIVE" || this.visibility.passive;
      marker.line.renderOrder = selected ? 120 : 100;
    }

    renderTrains(trains) {
      if (this.selectedTrainId && !this.trainById.has(this.selectedTrainId)) {
        this.clearSelection();
      }

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
          marker.element.addEventListener("click", (event) => {
            event.stopPropagation();
            this.selectTrain(train.id);
          });
          this.trains.add(marker);
          this.trainMarkers.set(train.id, marker);
        }
        marker.element.querySelector(".create-railway-train__label").textContent =
          safeText(train.name, "Train");
        marker.element.dataset.state = safeText(train.state, "RUNNING");
        marker.element.classList.toggle("selected", this.selectedTrainId === train.id);
        marker.__tooltip = this.trainTooltip(train);
        marker.element.setAttribute("aria-label", marker.__tooltip);
        marker.position.set(train.x, train.y, train.z);
      }
      this.removeMissing(this.trainMarkers, this.trains, keep);
    }

    trainTooltip(train) {
      const eta = formatEta(train.targetDistance, train.speed);
      const targetSpeed = Math.abs(Number(train.targetSpeed || 0));
      return [
        safeText(train.name, "Train"),
        `${formatSpeed(train.speed)} · ${formatState(train.state)}`,
        targetSpeed > 0 ? `Target speed: ${formatSpeed(targetSpeed)}` : null,
        train.backwards ? "Direction: reverse" : "Direction: forward",
        train.currentStation ? `At ${train.currentStation}` : null,
        !train.currentStation && train.targetStation
          ? `→ ${train.targetStation}${train.targetDistance ? ` · ${train.targetDistance} m` : ""}${eta ? ` · ${eta}` : ""}`
          : null,
        train.waitingForSignal ? "Waiting at signal" : null,
        train.owner ? `Driver: ${train.owner}` : null,
        `${train.carriages || 0} carriage${train.carriages === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    syncBlueMap3DMeshes() {
      const objects = window.__bluemap3d?.objects;
      if (!objects) {
        this.blueMap3DMeshes = [];
        return;
      }

      const meshes = [];
      for (const [objectId, entry] of Object.entries(objects)) {
        if (!objectId.startsWith("create_contraptions/") || !entry?.mesh) continue;
        const parts = objectId.split("/");
        if (parts.length < 4) continue;
        const trainId = parts.at(-2);
        const carriage = Number(parts.at(-1));
        if (!this.trainById.has(trainId) || !Number.isInteger(carriage)) continue;

        entry.mesh.userData.createRailwayTrainId = trainId;
        entry.mesh.userData.createRailwayCarriage = carriage;
        meshes.push(entry.mesh);
      }
      this.blueMap3DMeshes = meshes;

      if (meshes.length && !this.blueMap3DDetected) {
        this.blueMap3DDetected = true;
        if (!this.trainLabelTouched) {
          this.visibility.trains = false;
          const input = this.toggleInputs.get("trains");
          if (input) input.checked = false;
        }
        console.info(
          "[Create Railway] linked",
          meshes.length,
          "BlueMap3D carriage mesh(es) to railway telemetry",
        );
      }
    }

    bindBlueMap3DInteractions() {
      const canvas = this.app.mapViewer?.renderer?.domElement;
      if (!canvas || !this.raycaster || !this.api?.Three?.Vector2) return;

      canvas.addEventListener(
        "pointermove",
        (event) => {
          if (event.buttons || event.pointerType === "touch") return;
          const train = this.pickBlueMap3DTrain(event);
          if (!train) {
            if (this.tooltip.dataset.source === "bluemap3d") this.tooltip.hidden = true;
            canvas.style.cursor = "";
            return;
          }
          canvas.style.cursor = "pointer";
          this.showTooltip(this.trainTooltip(train), event, "bluemap3d");
        },
        { signal: this.listeners.signal },
      );

      canvas.addEventListener(
        "click",
        (event) => {
          const train = this.pickBlueMap3DTrain(event);
          if (train) this.selectTrain(train.id);
        },
        { signal: this.listeners.signal },
      );

      canvas.addEventListener(
        "pointerleave",
        () => {
          if (this.tooltip.dataset.source === "bluemap3d") this.tooltip.hidden = true;
          canvas.style.cursor = "";
        },
        { signal: this.listeners.signal },
      );
    }

    pickBlueMap3DTrain(event) {
      if (!this.active || !this.blueMap3DMeshes.length) return null;

      const canvas = this.app.mapViewer.renderer.domElement;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;

      const pointer = new this.api.Three.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(pointer, this.app.mapViewer.camera);
      const hits = this.raycaster.intersectObjects(this.blueMap3DMeshes, true);
      for (const hit of hits) {
        let object = hit.object;
        while (object) {
          const trainId = object.userData?.createRailwayTrainId;
          if (trainId && this.trainById.has(trainId)) return this.trainById.get(trainId);
          object = object.parent;
        }
      }
      return null;
    }

    selectTrain(trainId) {
      if (!this.trainById.has(trainId)) return;
      this.selectedTrainId = trainId;
      for (const marker of this.segmentMarkers.values()) this.styleSegment(marker);
      for (const [id, marker] of this.trainMarkers) {
        marker.element.classList.toggle("selected", id === trainId);
      }
      this.renderSelectedTrain();
    }

    clearSelection() {
      this.selectedTrainId = null;
      for (const marker of this.segmentMarkers.values()) this.styleSegment(marker);
      for (const marker of this.trainMarkers.values()) marker.element.classList.remove("selected");
      this.renderSelectedTrain();
    }

    renderSelectedTrain() {
      if (!this.selectionElement) return;
      const train = this.selectedTrainId ? this.trainById.get(this.selectedTrainId) : null;
      if (!train) {
        this.selectionElement.replaceChildren();
        this.selectionElement.hidden = true;
        return;
      }

      const header = document.createElement("div");
      header.className = "create-railway-selection__header";
      const title = document.createElement("strong");
      title.textContent = safeText(train.name, "Train");
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "Clear selected train");
      close.addEventListener("click", () => this.clearSelection());
      header.append(title, close);

      const body = document.createElement("div");
      body.className = "create-railway-selection__body";
      body.textContent = this.trainTooltip(train).split("\n").slice(1).join("\n");

      const occupied = [...this.segmentMarkers.values()].filter((marker) =>
        (marker.__trainIds || []).includes(train.id),
      ).length;
      const reserved = [...this.segmentMarkers.values()].filter((marker) =>
        (marker.__reservedTrainIds || []).includes(train.id),
      ).length;
      if (occupied || reserved) {
        const blocks = document.createElement("small");
        const details = [];
        if (occupied)
          details.push(
            `${occupied} occupied section${occupied === 1 ? "" : "s"}`,
          );
        if (reserved)
          details.push(
            `${reserved} reserved-ahead section${reserved === 1 ? "" : "s"}`,
          );
        blocks.textContent = `${details.join(" · ")} highlighted`;
        body.append(document.createElement("br"), blocks);
      }

      this.selectionElement.replaceChildren(header, body);
      this.selectionElement.hidden = false;
    }

    showTooltip(value, event, source = "marker") {
      if (!value) return;
      this.tooltip.textContent = value;
      this.tooltip.dataset.source = source;
      this.tooltip.hidden = false;
      const fallback = event?.currentTarget?.getBoundingClientRect?.();
      const x = event?.clientX || fallback?.right || 8;
      const y = event?.clientY || fallback?.top || 8;
      this.tooltip.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - this.tooltip.offsetWidth - 8))}px`;
      this.tooltip.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - this.tooltip.offsetHeight - 8))}px`;
    }

    bindTooltip(element, text) {
      const show = (event) => this.showTooltip(text(), event, "marker");
      element.addEventListener("pointerenter", show);
      element.addEventListener("pointermove", show);
      element.addEventListener("pointerleave", () => {
        if (this.tooltip.dataset.source === "marker") this.tooltip.hidden = true;
      });
      element.addEventListener("focus", show);
      element.addEventListener("blur", () => {
        if (this.tooltip.dataset.source === "marker") this.tooltip.hidden = true;
      });
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
      this.trainById.clear();
      this.blueMap3DMeshes = [];
    }

    setStatus(text) {
      if (this.statusElement) this.statusElement.textContent = text;
    }

    dispose() {
      this.disposed = true;
      this.listeners.abort();
      this.clearAll();
      this.app.popupMarkerSet.remove(this.root);
      this.tooltip.remove();
      this.controls.remove();
    }
  }

  async function loadIntegration() {
    const response = await fetch(new URL("integration.json", BASE_URL), {
      cache: "no-cache",
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
