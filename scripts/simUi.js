// simUi.js
import { slidersData } from "./slidersData.js?v=4.3";
import { LukashianClock } from "./lukashianTime.js?v=4.4";

export class SimUi {
  constructor(simMain) {
    this.simMain = simMain;
    this.slidersData = slidersData;
    this.sliders = {};
    this.sliderContainers = {};
    this.dependencies = {};

    this.createSliders();
    this.initializeSimMain();
    this.setupModeNavigation();
    this.setupSliderSearch();
    this.setupPresets();
    this.setupSimpleConfig();
    this.setupFullRunForm();
    this.setupReportPanel();
    this.setupHelpPopup();
    this.setupRightPanelToggle();
    this.setupSimTimeCycle();
    this.setupLinkLabelToggles();
    this.setupFullRunButton();
    this.setupSensitivity();
  }

  /**
   * Bottom-bar L / M toggle buttons. Click acts like the keyboard shortcut,
   * and the active state is reflected in the .active class.
   */
  setupLinkLabelToggles() {
    const buttons = document.querySelectorAll(".kbd-toggle[data-mode]");
    if (!buttons.length) return;

    const setActive = (mode) => {
      buttons.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
      });
    };

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const display = this.simMain.simDisplay;
        if (!display || typeof display.setLinkLabelMode !== "function") return;
        const mode = btn.dataset.mode;
        display.setLinkLabelMode(display.linkLabelMode === mode ? null : mode);
      });
    });

    window.addEventListener("marslink:link-label-mode", (e) => {
      setActive(e.detail?.mode ?? null);
    });

    // Initialize from current state if anything is already toggled
    const initial = this.simMain.simDisplay?.linkLabelMode ?? null;
    setActive(initial);
  }

  /**
   * Click-to-cycle through different time formats on the bottom-bar sim-time
   * display: UTC → Local → Lukashian Earth → Lukashian Mars → UTC.
   * State is persisted in localStorage.
   */
  setupSimTimeCycle() {
    this.lukashianClock = new LukashianClock();
    this.simTimeModes = ["utc", "local", "lukashian-earth", "lukashian-mars"];
    this.simTimeModeLabels = {
      "utc": "UTC",
      "local": "Local",
      "lukashian-earth": "Lukashian Earth",
      "lukashian-mars": "Lukashian Mars",
    };
    const stored = localStorage.getItem("marslinkSimTimeMode");
    this.simTimeMode = this.simTimeModes.includes(stored) ? stored : "utc";

    const el = document.getElementById("simTime");
    if (!el) return;
    el.style.cursor = "pointer";
    el.title = "Click to cycle: UTC / Local / Lukashian Earth / Lukashian Mars";
    el.addEventListener("click", () => {
      const idx = this.simTimeModes.indexOf(this.simTimeMode);
      this.simTimeMode = this.simTimeModes[(idx + 1) % this.simTimeModes.length];
      localStorage.setItem("marslinkSimTimeMode", this.simTimeMode);
      if (this._lastSimTime) this.updateSimTime(this._lastSimTime);
    });
  }

  /**
   * Collapse / expand the right metrics panel. State persisted to localStorage.
   */
  setupRightPanelToggle() {
    const panel = document.getElementById("right-panel");
    const toggle = document.getElementById("right-panel-toggle");
    if (!panel || !toggle) return;

    const STORAGE_KEY = "marslinkRightPanelCollapsed";
    const apply = (collapsed) => {
      panel.classList.toggle("collapsed", collapsed);
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
      toggle.title = collapsed ? "Expand panel" : "Collapse panel";
    };

    apply(localStorage.getItem(STORAGE_KEY) === "1");

    toggle.addEventListener("click", () => {
      const collapsed = !panel.classList.contains("collapsed");
      apply(collapsed);
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    });
  }

  /**
   * Click-to-toggle help popup in the top bar. Closes on outside click or Escape.
   */
  setupHelpPopup() {
    const btn = document.getElementById("help-btn");
    const popup = document.getElementById("help-popup");
    if (!btn || !popup) return;

    const close = () => {
      popup.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      popup.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popup.hidden) open();
      else close();
    });

    // Click outside closes the popup.
    document.addEventListener("click", (e) => {
      if (popup.hidden) return;
      if (popup.contains(e.target) || btn.contains(e.target)) return;
      close();
    });

    // Escape closes the popup.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !popup.hidden) close();
    });
  }

  initializeSimMain() {
    const timeAccelerationSlider = this.slidersData.simulation["time-acceleration-slider"];
    const timeAccelerationValue = this.mapSliderValueToUserFacing(timeAccelerationSlider, timeAccelerationSlider.value);
    this.simMain.setTimeAccelerationFactor(timeAccelerationValue);
    this.simMain.setCosts(this.getGroupsConfig(["economics"]));
    this.simMain.setSatellitesConfig(
      this.getGroupsConfig([
        "economics",
        "simulation",
        "laser_technology",
        "ring_mars",
        "circular_rings",
        "eccentric_rings",
        "ring_earth",
        "adapted_rings",
        "launch_schedule",
      ])
    );
    // Set the initial display type
    const displayType = this.slidersData.display["display-type"].value;
    this.simMain.setDisplayType(displayType);
    const linksColors = this.slidersData.display["links-colors"].value;
    this.simMain.setLinksColors(linksColors);
    const satelliteColors = this.slidersData.display["satellite-colors"].value;
    this.simMain.setSatelliteColorMode(satelliteColors);

    // Set initial size factors
    const sunSizeSlider = this.slidersData.display["sun-size-factor"];
    const sunSizeValue = this.mapSliderValueToUserFacing(sunSizeSlider, parseFloat(this.sliders.display["sun-size-factor"].value));
    this.simMain.setSunSizeFactor(sunSizeValue);

    const planetsSizeSlider = this.slidersData.display["planets-size-factor"];
    const planetsSizeValue = this.mapSliderValueToUserFacing(
      planetsSizeSlider,
      parseFloat(this.sliders.display["planets-size-factor"].value)
    );
    this.simMain.setPlanetsSizeFactor(planetsSizeValue);

    const satellitesSizeSlider = this.slidersData.display["satellite-size-factor"];
    const satellitesSizeValue = this.mapSliderValueToUserFacing(
      satellitesSizeSlider,
      parseFloat(this.sliders.display["satellite-size-factor"].value)
    );
    this.simMain.setSatelliteSizeFactor(satellitesSizeValue);

    const roadsterSizeSlider = this.slidersData.display["roadster-size-factor"];
    const roadsterSizeValue = this.mapSliderValueToUserFacing(
      roadsterSizeSlider,
      parseFloat(this.sliders.display["roadster-size-factor"].value)
    );
    this.simMain.setRoadsterSizeFactor(roadsterSizeValue);

  }

  /**
   * Sets up the Full Run form fields (loads saved values, persists on change).
   * The form markup itself lives in index.html (#run-pane).
   */
  setupFullRunForm() {
    const defaults = {
      fullRunImprovementScores: "256,512,1024",
      fullRunDates: "2034-08-19,2027-02-19",
      fullRunRingCounts: "2,3,4,5,6",
      fullRunMbps: "25,50,100",
    };

    for (const [id, fallback] of Object.entries(defaults)) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.value = localStorage.getItem(id) || fallback;
      const persist = () => localStorage.setItem(id, input.value);
      input.addEventListener("blur", persist);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") persist();
      });
    }
  }

  /**
   * Wires the top-bar mode tabs and left-rail icon buttons.
   * Three modes: configure, report, run.
   */
  setupModeNavigation() {
    this.activeMode = null;
    const modeDrawer = document.getElementById("mode-drawer");
    const simplePane = document.getElementById("simple-pane");
    const configurePane = document.getElementById("configure-pane");
    const sensitivityPane = document.getElementById("sensitivity-pane");
    const runPane = document.getElementById("run-pane");
    const reportPanel = document.getElementById("report-panel");

    const setActiveButtons = (mode) => {
      document.querySelectorAll("[data-mode]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
      });
    };

    const closeDrawer = () => {
      modeDrawer.hidden = true;
      modeDrawer.setAttribute("aria-hidden", "true");
      simplePane.hidden = true;
      configurePane.hidden = true;
      sensitivityPane.hidden = true;
      runPane.hidden = true;
    };

    const closeReportPanel = () => {
      reportPanel.hidden = true;
      reportPanel.setAttribute("aria-hidden", "true");
    };

    const openMode = (mode) => {
      // Toggle off if clicking the active mode again
      if (this.activeMode === mode) {
        this.activeMode = null;
        setActiveButtons(null);
        closeDrawer();
        closeReportPanel();
        return;
      }
      this.activeMode = mode;
      setActiveButtons(mode);

      if (mode === "simple" || mode === "configure" || mode === "sensitivity" || mode === "run") {
        closeReportPanel();
        modeDrawer.hidden = false;
        modeDrawer.setAttribute("aria-hidden", "false");
        simplePane.hidden = mode !== "simple";
        configurePane.hidden = mode !== "configure";
        sensitivityPane.hidden = mode !== "sensitivity";
        runPane.hidden = mode !== "run";
      } else if (mode === "report") {
        closeDrawer();
        reportPanel.hidden = false;
        reportPanel.setAttribute("aria-hidden", "false");
        // Show a placeholder until generation finishes
        const body = document.getElementById("report-panel-body");
        if (body && !body.querySelector(".report")) {
          body.innerHTML = `<p class="empty-state">Generating report from current configuration…</p>`;
        }
        this.simMain.generateReport();
      }
    };

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => openMode(btn.dataset.mode));
    });

    document.querySelectorAll("[data-close-drawer]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeMode = null;
        setActiveButtons(null);
        closeDrawer();
        closeReportPanel();
      });
    });

    // Refresh report button
    const refreshBtn = document.getElementById("report-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => this.simMain.generateReport());
    }

    // Open Simple config by default so first-time users see the controls.
    openMode("simple");
  }

  /**
   * Wires the in-page report panel (close button is already covered by data-close-drawer).
   * Hook reserved for future deep-linking / event listeners.
   */
  setupReportPanel() {
    // No-op for now — close & refresh wiring lives in setupModeNavigation.
  }

  /**
   * Filter sliders by label text. Sections with no visible children collapse and hide.
   */
  setupSliderSearch() {
    const search = document.getElementById("slider-search");
    if (!search) return;
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      const sections = document.querySelectorAll(".slider-section");
      sections.forEach((section) => {
        const rows = section.querySelectorAll(".slider-container");
        let anyVisible = false;
        rows.forEach((row) => {
          const text = (row.dataset.search || "").toLowerCase();
          const match = !q || text.includes(q);
          row.classList.toggle("filtered-out", !match);
          if (match) anyVisible = true;
        });
        section.classList.toggle("filtered-out", !anyVisible);
        // While searching, expand matching sections; restore on clear.
        const content = section.querySelector(".slider-section-content");
        const header = section.querySelector(".slider-section-header");
        if (content && header) {
          if (q && anyVisible) {
            content.classList.add("active");
            header.classList.add("expanded");
          } else if (!q) {
            // Leave existing state alone
          }
        }
      });
    });
  }

  /**
   * Presets dropdown — save / load named snapshots of all slider values.
   * Stored as { [presetName]: { [fullSliderId]: internalValue } } under "marslinkPresets".
   */
  setupPresets() {
    const select = document.getElementById("presets-select");
    const saveBtn = document.getElementById("save-preset-btn");
    const deleteBtn = document.getElementById("delete-preset-btn");
    if (!select || !saveBtn) return;

    const STORAGE_KEY = "marslinkPresets";
    const loadAll = () => {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      } catch {
        return {};
      }
    };
    const saveAll = (presets) => localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));

    const refreshOptions = () => {
      const presets = loadAll();
      const current = select.value;
      select.innerHTML = `<option value="">Presets…</option>`;
      for (const name of Object.keys(presets)) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      if (current && presets[current]) select.value = current;
    };

    const snapshot = () => {
      const snap = {};
      for (const section in this.slidersData) {
        for (const sliderId in this.slidersData[section]) {
          const fullId = `${section}.${sliderId}`;
          const input = this.sliders[section]?.[sliderId];
          if (!input) continue;
          // For radio groups, the "input" is a container; read the checked one.
          if (input.classList && input.classList.contains("radio-container")) {
            const checked = input.querySelector("input[type=radio]:checked");
            snap[fullId] = checked ? checked.value : this.slidersData[section][sliderId].value;
          } else {
            snap[fullId] = input.value;
          }
        }
      }
      return snap;
    };

    const apply = (snap) => {
      for (const [fullId, value] of Object.entries(snap)) {
        const [section, sliderId] = fullId.split(".");
        const input = this.sliders[section]?.[sliderId];
        if (!input) continue;
        if (input.classList && input.classList.contains("radio-container")) {
          const radio = input.querySelector(`input[type=radio][value="${CSS.escape(String(value))}"]`);
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } else {
          input.value = value;
          // Fire input/change so listeners (and the numeric companion) sync.
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    };

    saveBtn.addEventListener("click", () => {
      const name = prompt("Save current configuration as preset:");
      if (!name) return;
      const presets = loadAll();
      presets[name] = snapshot();
      saveAll(presets);
      refreshOptions();
      select.value = name;
    });

    deleteBtn?.addEventListener("click", () => {
      const name = select.value;
      if (!name) return;
      if (!confirm(`Delete preset "${name}"?`)) return;
      const presets = loadAll();
      delete presets[name];
      saveAll(presets);
      refreshOptions();
    });

    select.addEventListener("change", () => {
      const name = select.value;
      if (!name) return;
      const presets = loadAll();
      if (presets[name]) apply(presets[name]);
    });

    refreshOptions();
  }

  /**
   * Programmatically sets slider values and fires change events.
   * @param {Object} values - { "group.slider": value, ... }
   */
  applySliderValues(values) {
    for (const [fullId, value] of Object.entries(values)) {
      const [section, sliderId] = fullId.split(".");
      const input = this.sliders[section]?.[sliderId];
      if (!input) continue;
      if (input.classList && input.classList.contains("radio-container")) {
        const radio = input.querySelector(`input[type=radio][value="${CSS.escape(String(value))}"]`);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  /**
   * Builds the simple configuration panel with ring count + laser tech sliders.
   * Changing ring count auto-sets all other parameters to sensible defaults.
   */
  setupSimpleConfig() {
    const container = document.getElementById("simple-config-container");
    if (!container) return;

    const ringData = this.slidersData.adapted_rings.ringcount;
    const techData = this.slidersData.laser_technology["improvement-factor"];

    const makeSliderRow = (label, data, id, onChange, opts = {}) => {
      // opts.toDisplay(internal) → display value, opts.toInternal(display) → internal value
      const toDisplay = opts.toDisplay || ((v) => v);
      const toInternal = opts.toInternal || ((v) => v);

      const wrap = document.createElement("div");
      wrap.className = "metric-card";
      wrap.style.marginBottom = "6px";
      wrap.style.padding = "10px 12px";

      const header = document.createElement("div");
      header.style.cssText = "display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;";
      const lbl = document.createElement("span");
      lbl.className = "metric-label";
      lbl.textContent = label;

      const valWrap = document.createElement("span");
      valWrap.style.cssText = "display:inline-flex; align-items:baseline; gap:2px;";
      const valInput = document.createElement("input");
      valInput.type = "number";
      valInput.className = "slider-value-input";
      valInput.value = toDisplay(data.value);
      valInput.style.cssText = "width:60px; text-align:right;";
      const unitSpan = document.createElement("span");
      unitSpan.className = "metric-label";
      unitSpan.textContent = data.unit || "";
      valWrap.appendChild(valInput);
      valWrap.appendChild(unitSpan);

      header.appendChild(lbl);
      header.appendChild(valWrap);
      wrap.appendChild(header);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = data.min;
      slider.max = data.max;
      slider.step = data.step;
      slider.value = data.value;
      slider.style.width = "100%";
      wrap.appendChild(slider);

      // Slider → input + callback
      slider.addEventListener("input", () => {
        const internal = parseFloat(slider.value);
        valInput.value = toDisplay(internal);
        onChange(internal);
      });

      // Input → slider + callback
      const commitInput = () => {
        const displayVal = parseFloat(valInput.value);
        if (isNaN(displayVal)) { valInput.value = toDisplay(parseFloat(slider.value)); return; }
        const internal = toInternal(displayVal);
        const clamped = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), internal));
        slider.value = clamped;
        valInput.value = toDisplay(clamped);
        onChange(clamped);
      };
      valInput.addEventListener("change", commitInput);
      valInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitInput(); valInput.blur(); } });

      return { wrap, slider, valInput };
    };

    // Helper: signedPow2 display value
    const signedPow2 = (v) => {
      if (v === 0) return 0;
      return Math.sign(v) * Math.pow(2, Math.abs(v) - 1);
    };
    const signedPow2Inv = (v) => {
      if (v === 0) return 0;
      return Math.sign(v) * (Math.round(Math.log2(Math.abs(v))) + 1);
    };

    // Time acceleration slider — signedPow2 scale
    const timeData = this.slidersData.simulation["time-acceleration-slider"];
    const timeRow = makeSliderRow("Time acceleration",
      { min: timeData.min, max: timeData.max, step: 1, unit: "x", value: timeData.value },
      "simple-time",
      (val) => { this.applySliderValues({ "simulation.time-acceleration-slider": val }); },
      { toDisplay: signedPow2, toInternal: signedPow2Inv }
    );

    // Laser tech improvement slider — pow2 scale
    const techRow = makeSliderRow("Laser tech improvement",
      { min: techData.min, max: techData.max, step: 1, unit: "x", value: techData.value },
      "simple-techfactor",
      (val) => { this.applySliderValues({ "laser_technology.improvement-factor": val }); },
      { toDisplay: (v) => Math.pow(2, v), toInternal: (v) => Math.round(Math.log2(v)) }
    );

    // Ring count slider — linear
    const ringRow = makeSliderRow("Relay ring count", ringData, "simple-ringcount", (val) => {
      this.applySimpleDefaults(val);
    });

    // Sync from advanced panel
    const advTime = this.sliders.simulation?.["time-acceleration-slider"];
    if (advTime) {
      advTime.addEventListener("input", () => {
        timeRow.slider.value = advTime.value;
        timeRow.valInput.value = signedPow2(parseFloat(advTime.value));
      });
    }
    const advTech = this.sliders.laser_technology?.["improvement-factor"];
    if (advTech) {
      advTech.addEventListener("input", () => {
        techRow.slider.value = advTech.value;
        techRow.valInput.value = Math.pow(2, parseFloat(advTech.value));
      });
    }
    const advRing = this.sliders.adapted_rings?.ringcount;
    if (advRing) {
      advRing.addEventListener("input", () => {
        ringRow.slider.value = advRing.value;
        ringRow.valInput.value = advRing.value;
      });
    }

    container.appendChild(timeRow.wrap);
    container.appendChild(techRow.wrap);
    container.appendChild(ringRow.wrap);

    // Apply defaults on initial load
    this.applySimpleDefaults(ringData.value);
  }

  /**
   * Applies the simple-mode defaults for a given ring count.
   */
  /**
   * Estimates min planet-to-ring capacity (Mbps) for a given requiredmbpsbetweensats.
   * Returns the worst-case (apoapsis) total capacity of both planet-to-satellite links.
   */
  _estimatePlanetRingMinCapacity(mbpsBetweenSats, ringType) {
    const lb = this.simMain.simLinkBudget;
    const sats = this.simMain.simSatellites;
    const AU_IN_KM = 149597870.7;
    const { a, n } = sats.getParams_a_n(ringType);
    const e = ringType === "Mars" ? 0.0934231 : 0.0166967;

    // Compute sat count (same formula as generateSatellitesConfig with matchCircularRings="no", sideExtension=180)
    const distKmBetweenSats = lb.calculateKm(mbpsBetweenSats / 1000);
    const distAuBetweenSats = distKmBetweenSats / AU_IN_KM;
    const circumferenceAu = 2 * Math.PI * a;
    const satCount = Math.ceil(circumferenceAu / distAuBetweenSats);
    if (satCount < 2) return 0;

    // Worst-case: at apoapsis, ring radius = a*(1+e), planet at same radius
    // Angular spacing = 360/satCount degrees, max offset = half spacing
    const apo = a * (1 + e);
    const halfSpacingRad = Math.PI / satCount;
    // Chord distance at apoapsis for angular offset = halfSpacing
    const worstDistAu = 2 * apo * Math.sin(halfSpacingRad);
    const worstDistKm = worstDistAu * AU_IN_KM;
    const capacityPerLinkGbps = lb.calculateGbps(worstDistKm);
    // Two links (one on each angular side)
    return capacityPerLinkGbps * 2 * 1000; // Mbps
  }

  applySimpleDefaults(ringCount) {
    // Estimate adapted rings total throughput to size earth/mars rings
    const lb = this.simMain.simLinkBudget;
    const rM = this.simMain.simSatellites.getMars().a;
    const rE = this.simMain.simSatellites.getEarth().a;
    const Dem = rM - rE;
    const routeCount = Math.round((ringCount * Math.sqrt(3) * Math.PI * rM) / Dem);
    // Min link capacity along a route ≈ capacity at the widest inter-ring gap
    const interRingAu = Dem / (ringCount + 1);
    const interRingKm = lb.convertAUtoKM(interRingAu);
    const perRouteMbps = lb.calculateGbps(interRingKm) * 1000;
    const targetMbps = routeCount * perRouteMbps;

    // Initial heuristic for earth/mars ring throughput target
    let earthMbps = Math.round(targetMbps * 1.03 * 0.8 / 4) || 50;
    let marsMbps = Math.round(targetMbps * 1.20 * 0.826 / 4) || 50;

    // Feedback loop (2 iterations): estimate actual min capacity, then adjust input to hit target
    for (let iter = 0; iter < 2; iter++) {
      const earthMinCap = this._estimatePlanetRingMinCapacity(earthMbps, "Earth");
      const marsMinCap = this._estimatePlanetRingMinCapacity(marsMbps, "Mars");
      if (earthMinCap > 0) earthMbps = Math.round(earthMbps * targetMbps / earthMinCap / 2) || 50;
      if (marsMinCap > 0) marsMbps = Math.round(marsMbps * targetMbps / marsMinCap / 2) || 50;
    }

    this.applySliderValues({
      // Adapted rings
      "adapted_rings.ringcount": ringCount,
      "adapted_rings.auto_route_count": "yes",
      "adapted_rings.laser-ports-per-satellite": 2,
      "adapted_rings.linear_satcount_increase": 0.18,
      // Disable circular and eccentric
      "circular_rings.ringcount": 0,
      "eccentric_rings.ringcount": 0,
      // Earth ring — sized to match adapted capacity
      "ring_earth.laser-ports-per-satellite": 3,
      "ring_earth.side-extension-degrees-slider": 180,
      "ring_earth.match-circular-rings": "no",
      "ring_earth.requiredmbpsbetweensats": earthMbps,
      // Mars ring — sized to match adapted capacity
      "ring_mars.laser-ports-per-satellite": 3,
      "ring_mars.side-extension-degrees-slider": 180,
      "ring_mars.match-circular-rings": "no",
      "ring_mars.requiredmbpsbetweensats": marsMbps,
    });
  }

  saveToJson(object, fileName) {
    // Convert the object to JSON
    const jsonString = JSON.stringify(object, null, 2);

    // Create a Blob with the JSON content
    const blob = new Blob([jsonString], { type: "application/json" });

    // Create a link element
    const link = document.createElement("a");

    // Set the download attribute with a filename
    link.download = `${fileName}.json`;

    // Create a URL for the Blob and set it as the href
    link.href = URL.createObjectURL(blob);

    // Append the link to the document (this is required for some browsers)
    document.body.appendChild(link);

    // Programmatically click the link to trigger the download
    link.click();

    // Remove the link from the document
    document.body.removeChild(link);
  }

  /**
   * Sets up the Start Full Run button with its event listener.
   */
  setupFullRunButton() {
    const startButton = document.getElementById("startFullRun");
    const summaryContainer = document.getElementById("long-term-summary-run-text");
    const progressBar = document.getElementById("progress-bar-run"); // Ensure you have a progress bar in your HTML
    const progressText = document.getElementById("progress-text-run"); // And a progress text element

    if (startButton && summaryContainer && progressBar && progressText) {
      startButton.addEventListener("click", async () => {
        // Disable the button to prevent multiple clicks
        startButton.disabled = true;
        startButton.textContent = "Running...";
        progressBar.style.width = "0%";
        progressText.textContent = "Progress: 0%";

        try {
          // Get input values
          const datesInput = document.getElementById("fullRunDates").value;
          const dates = datesInput.split(",").map((d) => d.trim());

          const ringCountsInput = document.getElementById("fullRunRingCounts").value;
          const ringCounts = ringCountsInput.split(",").map((r) => parseInt(r.trim()));

          const mbpsInput = document.getElementById("fullRunMbps").value;
          const throughputs = mbpsInput.split(",").map((m) => parseInt(m.trim()));

          const improvementScoresInput = document.getElementById("fullRunImprovementScores").value;
          const improvementScores = improvementScoresInput.split(",").map((s) => parseFloat(s.trim()));

          // Calculate total number of scenarios for progress tracking
          const totalScenarios = dates.length * ringCounts.length * throughputs.length * improvementScores.length;
          let completedScenarios = 0;

          // Get base configuration (excluding overridden parameters)
          const baseConfig = this.getGroupsConfig([
            "economics",
            "simulation",
            "laser_technology",
            "ring_mars",
            "circular_rings",
            "eccentric_rings",
            "ring_earth",
            "adapted_rings",
          ]);

          // Remove parameters that are overridden by the simulation
          delete baseConfig["circular_rings.ringcount"];
          delete baseConfig["circular_rings.requiredmbpsbetweensats"];
          delete baseConfig["eccentric_rings.ringcount"];
          delete baseConfig["simulation.calctimeSec"];
          delete baseConfig["laser_technology.improvement-factor"];
          delete baseConfig["adapted_rings.ringcount"];
          delete baseConfig["adapted_rings.route_count"];

          // Initialize satellitesConfig
          const satellitesConfig = this.getGroupsConfig([
            "economics",
            "simulation",
            "laser_technology",
            "ring_mars",
            "circular_rings",
            "eccentric_rings",
            "ring_earth",
            "adapted_rings",
          ]);

          const resultArray = [];

          // Iterate over each combination of improvementScore, ringCount, throughput, and date
          for (const improvementScore of improvementScores) {
            for (const ringCount of ringCounts) {
              for (const throughput of throughputs) {
                for (const date of dates) {
                  // Update satellitesConfig with current scenario parameters
                  satellitesConfig["circular_rings.ringcount"] = ringCount;
                  satellitesConfig["circular_rings.requiredmbpsbetweensats"] = throughput;
                  satellitesConfig["eccentric_rings.ringcount"] = 0;
                  satellitesConfig["simulation.calctimeSec"] = 100; // No limit
                  satellitesConfig["laser_technology.improvement-factor"] = Math.log2(improvementScore);
                  // Set simTime to the date for deployment
                  const originalSimTime = this.simMain.simTime.getDate();
                  const targetDate = new Date(date);
                  this.simMain.simTime.simMsSinceStart = targetDate.getTime() - this.simMain.simTime.initDate.getTime();
                  this.simMain.simTime.previousRealMs = performance.now();

                  // Apply the new satellites configuration
                  this.simMain.setSatellitesConfig(satellitesConfig);

                  // Run the simulation for the specific date
                  const result = await this.simMain.longTermRun({ from: date, to: date, stepDays: 1 });

                  // Restore original simTime and update display
                  this.simMain.simTime.simMsSinceStart = originalSimTime.getTime() - this.simMain.simTime.initDate.getTime();
                  this.simMain.simTime.previousRealMs = performance.now();
                  this.simMain.updateLoop();

                  result.scenario = { date, ringCount, throughputMbps: throughput, improvementScore };
                  // Push the result to the resultArray
                  resultArray.push(result);

                  // Update progress
                  completedScenarios++;
                  const overallProgress = completedScenarios / totalScenarios;
                  const percent = Math.round(overallProgress * 100);
                  progressBar.style.width = `${percent}%`;
                  progressText.textContent = `Progress: ${percent}%`;
                }
              }
            }
          }

          const data = { config: baseConfig, results: resultArray };

          // Store data in localStorage for the results page
          localStorage.setItem("marslinkFullRunResults", JSON.stringify(data));

          // Open the results webpage
          window.open("results/fullrun/index.html");
        } catch (error) {
          console.error("Error during full run simulation:", error);
          summaryContainer.textContent = "An error occurred during the simulation.";
        } finally {
          // Re-enable the button after completion
          startButton.disabled = false;
          startButton.textContent = "Start Full Run";
        }
      });
    } else {
      console.error("Start Full Run button or summary container not found.");
    }
  }

  /**
   * Sets up the Sensitivity analysis button and sweep logic.
   */
  setupSensitivity() {
    const startBtn = document.getElementById("startSensitivity");
    if (!startBtn) return;

    const progressWrap = document.getElementById("sens-progress-wrap");
    const progressBar = document.getElementById("sens-progress-bar");
    const progressText = document.getElementById("sens-progress-text");

    // Toggle linear step visibility based on progression type
    const progSelect = document.getElementById("sens-tech-progression");
    const stepInput = document.getElementById("sens-tech-step");
    progSelect.addEventListener("change", () => {
      stepInput.style.display = progSelect.value === "linear" ? "" : "none";
    });

    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      startBtn.textContent = "Running...";
      progressWrap.style.display = "";
      progressBar.style.width = "0%";
      progressText.textContent = "0%";

      try {
        const ringStart = parseInt(document.getElementById("sens-ring-start").value);
        const ringEnd = parseInt(document.getElementById("sens-ring-end").value);
        const ringStep = parseInt(document.getElementById("sens-ring-step").value) || 1;

        const techStart = parseInt(document.getElementById("sens-tech-start").value);
        const techEnd = parseInt(document.getElementById("sens-tech-end").value);
        const techProg = progSelect.value;
        const techLinStep = parseInt(stepInput.value) || 1;

        // Build ring count values
        const ringValues = [];
        for (let r = ringStart; r <= ringEnd; r += ringStep) ringValues.push(r);

        // Build laser tech values (user-facing)
        const techValues = [];
        if (techProg === "pow2") {
          for (let t = techStart; t <= techEnd; t *= 2) techValues.push(t);
        } else {
          for (let t = techStart; t <= techEnd; t += techLinStep) techValues.push(t);
        }

        const totalScenarios = ringValues.length * techValues.length;
        let completed = 0;

        // Save current config to restore later
        const baseConfig = this.getGroupsConfig([
          "economics", "simulation", "laser_technology",
          "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings",
        ]);
        const originalSimTime = this.simMain.simTime.getDate();

        const resultArray = [];

        for (const techUserVal of techValues) {
          const techInternal = Math.round(Math.log2(techUserVal));

          for (const ringCount of ringValues) {
            // Apply simple config defaults for this ring count
            // (this sets adapted rings, disables circular/eccentric, sizes earth/mars)
            this.applySimpleDefaults(ringCount);

            // Override laser tech
            this.applySliderValues({ "laser_technology.improvement-factor": techInternal });

            // Get the resulting full config
            const scenarioConfig = this.getGroupsConfig([
              "economics", "simulation", "laser_technology",
              "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings",
            ]);
            scenarioConfig["simulation.calctimeSec"] = 100;

            // Apply and run
            this.simMain.setSatellitesConfig(scenarioConfig);
            const result = await this.simMain.longTermRun({ from: "2030-01-01", to: "2030-01-01", stepDays: 1 });

            result.scenario = {
              ringCount,
              laserTechImprovement: techUserVal,
              satellites: result.dataSummary?.possibleLinksCount?.min ?? null,
            };
            resultArray.push(result);

            completed++;
            const pct = Math.round((completed / totalScenarios) * 100);
            progressBar.style.width = `${pct}%`;
            progressText.textContent = `${pct}% (${completed}/${totalScenarios})`;

            // Yield to UI
            await new Promise((r) => setTimeout(r, 0));
          }
        }

        // Restore original config
        for (const [key, val] of Object.entries(baseConfig)) {
          const [section, sliderId] = key.split(".");
          const input = this.sliders[section]?.[sliderId];
          if (!input) continue;
          if (input.classList && input.classList.contains("radio-container")) {
            const radio = input.querySelector(`input[type=radio][value="${CSS.escape(String(val))}"]`);
            if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
          } else {
            input.value = val;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        // Restore sim time
        this.simMain.simTime.simMsSinceStart = originalSimTime.getTime() - this.simMain.simTime.initDate.getTime();
        this.simMain.simTime.previousRealMs = performance.now();
        this.simMain.updateLoop();

        // Store and open results
        const data = { config: { type: "sensitivity" }, results: resultArray };
        localStorage.setItem("marslinkSensitivityResults", JSON.stringify(data));
        window.open("results/fullrun/index.html");

      } catch (error) {
        console.error("Sensitivity analysis error:", error);
      } finally {
        startBtn.disabled = false;
        startBtn.textContent = "Run Sensitivity";
      }
    });
  }

  /**
   * Maps internal slider value to user-facing value, considering the scale (linear or pow2).
   * @param {Object} slider - The slider configuration object.
   * @param {number} [sliderValue=slider.value] - The internal value of the slider.
   * @returns {number} - The mapped user-facing value.
   */
  mapSliderValueToUserFacing(slider, sliderValue = slider.value) {
    if (slider.scale === "pow2") {
      return Math.pow(2, sliderValue);
    } else if (slider.scale === "pow10") {
      return Math.pow(10, sliderValue);
    } else if (slider.scale === "signedPow2") {
      // 0 → 0, +k → +2^(k-1), -k → -2^(k-1)
      if (sliderValue === 0) return 0;
      return Math.sign(sliderValue) * Math.pow(2, Math.abs(sliderValue) - 1);
    } else {
      return sliderValue;
    }
  }

  /**
   * Formats a number into a shorter string with K, M, B suffixes.
   * @param {number} num - The number to format.
   * @returns {string} - The formatted number as a string.
   */
  formatNumber(num) {
    const absNum = Math.abs(num);
    if (absNum >= 1.0e9) {
      // Billion
      return (num / 1.0e9).toFixed(1) + "B";
    } else if (absNum >= 1.0e6) {
      // Million
      return (num / 1.0e6).toFixed(1) + "M";
    } else if (absNum >= 1.0e3) {
      // Thousand
      return (num / 1.0e3).toFixed(1) + "K";
    } else {
      // Less than thousand
      return num.toString();
    }
  }

  formatSimTimeToUTC(simTime) {
    // Create a Date object using the simulated Unix time
    const simDate = new Date(simTime);

    // Format the date to a readable string in UTC
    const formattedDate = simDate.toISOString().replace("T", " ").slice(0, 19) + " UTC";

    return formattedDate;
  }

  /**
   * Creates sliders based on the slidersData configuration.
   * Sets up event listeners to handle user input and dispatch actions to simMain.
   */
  createSliders() {
    const slidersContainer = document.getElementById("sliders-container");
    slidersContainer.innerHTML = "";

    for (const section in this.slidersData) {
      // Section wrapper (so search filter can hide the whole group when empty)
      const sectionWrapper = document.createElement("div");
      sectionWrapper.className = "slider-section";

      const sectionHeader = document.createElement("h3");
      sectionHeader.className = "slider-section-header";
      const sectionLabel = section.replace(/_/g, " ");
      sectionHeader.textContent = sectionLabel.charAt(0).toUpperCase() + sectionLabel.slice(1);
      sectionWrapper.appendChild(sectionHeader);

      const sectionContent = document.createElement("div");
      sectionContent.className = "slider-section-content";
      sectionWrapper.appendChild(sectionContent);

      slidersContainer.appendChild(sectionWrapper);

      this.sliders[section] = {};
      this.sliderContainers[section] = {};

      for (const sliderId in this.slidersData[section]) {
        const slider = this.slidersData[section][sliderId];
        const fullSliderId = `${section}.${sliderId}`;

        if (slider.displayCondition) {
          const refFullId = `${section}.${slider.displayCondition.slider}`;
          if (!this.dependencies[refFullId]) this.dependencies[refFullId] = [];
          this.dependencies[refFullId].push(fullSliderId);
        }

        let min = slider.min;
        let max = slider.max;
        let step = slider.step;

        if (slider.scale === "pow2") {
          if (slider.min < 0) {
            const steps = slider.steps || 101;
            min = -Math.floor(steps / 2);
            max = Math.floor(steps / 2);
          } else {
            min = slider.min;
            max = slider.max;
          }
          step = 1;
        } else if (slider.scale === "pow10") {
          const steps = slider.steps || 101;
          if (slider.min < 0 && slider.max > 0) {
            min = -Math.floor(steps / 2);
            max = Math.floor(steps / 2);
          } else if (slider.min >= 0) {
            min = 0;
            max = steps - 1;
          }
          step = 1;
        }

        const savedValue = localStorage.getItem(fullSliderId);
        let validSavedValue = savedValue;
        if (savedValue !== null) {
          if (slider.type === "select" || slider.type === "dropdown" || slider.type === "radio") {
            if (!slider.options || !slider.options.includes(savedValue)) {
              validSavedValue = null;
            }
          } else {
            const num = parseFloat(savedValue);
            if (isNaN(num)) {
              validSavedValue = null;
            } else if (slider.scale === "pow2" || slider.scale === "pow10" || slider.scale === "signedPow2") {
              if (!Number.isInteger(num)) {
                validSavedValue = null;
              }
            }
          }
        }
        // If the saved value is outside the original range, extend the slider's
        // effective bounds to accommodate it (values entered via the numeric input).
        if (validSavedValue !== null && slider.type !== "radio" && slider.type !== "select" && slider.type !== "dropdown") {
          const n = parseFloat(validSavedValue);
          if (!isNaN(n)) {
            if (n < min) min = n;
            if (n > max) max = n;
          }
        }
        let sliderValue =
          validSavedValue !== null
            ? slider.type === "select" || slider.type === "dropdown" || slider.type === "radio"
              ? validSavedValue
              : parseFloat(validSavedValue)
            : slider.value;

        // ───── Row container ─────
        const sliderContainer = document.createElement("div");
        sliderContainer.className = "slider-container";
        sliderContainer.dataset.search = `${slider.label || ""} ${sectionLabel}`.toLowerCase();

        // Check display condition
        if (slider.displayCondition) {
          const refSlider = this.slidersData[section][slider.displayCondition.slider];
          if (refSlider && refSlider.value !== slider.displayCondition.value) {
            sliderContainer.style.display = "none";
          }
        }

        // ───── Top row: label + numeric input (range only) ─────
        const rowTop = document.createElement("div");
        rowTop.className = "slider-row-top";

        const label = document.createElement("label");
        label.setAttribute("for", fullSliderId);
        label.className = "slider-label";
        label.textContent = slider.label;
        if (slider.description) label.title = slider.description;
        rowTop.appendChild(label);

        let input;
        let numericInput = null;
        let displayValue;

        if (slider.type === "select" || slider.type === "dropdown") {
          input = document.createElement("select");
          input.id = fullSliderId;
          input.className = "slider";
          for (const option of slider.options) {
            const optionElem = document.createElement("option");
            optionElem.value = option;
            optionElem.textContent = option;
            if (option === sliderValue) optionElem.selected = true;
            input.appendChild(optionElem);
          }
          displayValue = sliderValue;
        } else if (slider.type === "radio") {
          const radioContainer = document.createElement("div");
          radioContainer.className = "radio-container";
          slider.options.forEach((option) => {
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = fullSliderId;
            radio.value = option;
            radio.id = `${fullSliderId}-${option}`;
            if (option === sliderValue) radio.checked = true;
            const radioLabel = document.createElement("label");
            radioLabel.setAttribute("for", radio.id);
            radioLabel.textContent = option;
            radioContainer.appendChild(radio);
            radioContainer.appendChild(radioLabel);

            radio.addEventListener("change", () => {
              if (radio.checked) {
                this.updateValues(fullSliderId, radio.value);
              }
            });
          });
          input = radioContainer;
        } else {
          input = document.createElement("input");
          input.type = "range";
          input.id = fullSliderId;
          input.className = "slider";
          input.min = min;
          input.max = max;
          input.step = step;
          input.value = sliderValue;
          displayValue = this.mapSliderValueToUserFacing(slider, sliderValue);

          // Inline editable numeric input (user-facing value)
          numericInput = document.createElement("input");
          numericInput.type = "number";
          numericInput.className = "slider-value-input";
          numericInput.id = `${fullSliderId}-value`;
          numericInput.value = this.formatNumericValue(displayValue);
          rowTop.appendChild(numericInput);

          if ((slider.unit || "").trim()) {
            const unitEl = document.createElement("span");
            unitEl.className = "slider-unit";
            unitEl.textContent = slider.unit.trim();
            rowTop.appendChild(unitEl);
          }
        }

        // For non-range types, no top row numeric — just the label is enough on the top.
        sliderContainer.appendChild(rowTop);
        sliderContainer.appendChild(input);
        sectionContent.appendChild(sliderContainer);

        this.sliders[section][sliderId] = input;
        this.sliderContainers[section][sliderId] = sliderContainer;

        // ───── Wire change handlers ─────
        if (slider.type === "select" || slider.type === "dropdown") {
          input.addEventListener("change", () => {
            this.updateValues(fullSliderId, input.value);
          });
        } else if (slider.type !== "radio") {
          const isCalcTime = fullSliderId === "simulation.calctimeSec";

          // Slider → numeric input
          const onSliderInput = (commit) => {
            const newValue = parseFloat(input.value);
            const userVal = this.mapSliderValueToUserFacing(slider, newValue);
            if (numericInput && document.activeElement !== numericInput) {
              numericInput.value = this.formatNumericValue(userVal);
            }
            if (commit) this.updateValues(fullSliderId, newValue);
          };

          input.addEventListener("input", () => onSliderInput(!isCalcTime));
          if (isCalcTime) input.addEventListener("change", () => onSliderInput(true));

          // Numeric input → slider. Accepts values outside the original range
          // by dynamically extending the slider's min/max to match.
          if (numericInput) {
            const commitNumeric = () => {
              const userVal = parseFloat(numericInput.value);
              if (isNaN(userVal)) {
                numericInput.value = this.formatNumericValue(this.mapSliderValueToUserFacing(slider, parseFloat(input.value)));
                return;
              }
              const internal = this.mapUserFacingToSliderValue(slider, userVal);
              // Extend range if needed so the slider thumb can represent this value.
              if (internal > parseFloat(input.max)) input.max = internal;
              if (internal < parseFloat(input.min)) input.min = internal;
              input.value = internal;
              const snappedUser = this.mapSliderValueToUserFacing(slider, internal);
              numericInput.value = this.formatNumericValue(snappedUser);
              this.updateValues(fullSliderId, internal);
            };
            numericInput.addEventListener("change", commitNumeric);
            numericInput.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                commitNumeric();
                numericInput.blur();
              }
            });
          }
        }

        slider.value =
          slider.type === "select" || slider.type === "dropdown" || slider.type === "radio"
            ? sliderValue
            : parseFloat(sliderValue);
      }
    }

    // Section toggle handlers
    const headers = document.querySelectorAll(".slider-section-header");
    headers.forEach((header, i) => {
      header.addEventListener("click", () => {
        const content = header.nextElementSibling;
        const expanded = content.classList.toggle("active");
        header.classList.toggle("expanded", expanded);
      });
      // Open the first section by default for discoverability
      if (i === 0) {
        header.classList.add("expanded");
        header.nextElementSibling.classList.add("active");
      }
    });
  }

  /**
   * Inverse of mapSliderValueToUserFacing — converts a user-typed value
   * back into the internal slider position.
   */
  mapUserFacingToSliderValue(slider, userValue) {
    if (slider.scale === "pow2") {
      if (userValue <= 0) return slider.min;
      return Math.round(Math.log2(userValue));
    } else if (slider.scale === "pow10") {
      if (userValue <= 0) return slider.min;
      return Math.round(Math.log10(userValue));
    } else if (slider.scale === "signedPow2") {
      // Inverse of: 0→0, ±k→±2^(k-1)
      if (userValue === 0) return 0;
      return Math.sign(userValue) * (Math.round(Math.log2(Math.abs(userValue))) + 1);
    }
    return userValue;
  }

  clampInternalValue(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Format a numeric value for display in the inline number input.
   * Keeps small numbers precise; trims to 4 significant digits otherwise.
   */
  formatNumericValue(num) {
    if (num === null || num === undefined || isNaN(num)) return "";
    const abs = Math.abs(num);
    if (abs === 0) return "0";
    if (abs >= 1000) return Math.round(num).toString();
    if (abs >= 1) return Number(num.toFixed(2)).toString();
    return Number(num.toPrecision(3)).toString();
  }

  /**
   * Updates internal values based on slider input and dispatches actions to simMain.
   * @param {string} sliderId - The unique ID of the slider.
   * @param {number} value - The internal slider value from the input element.
   */
  updateValues(sliderId, value) {
    // Save the new internal value to localStorage
    localStorage.setItem(sliderId, value);

    const [section, specificSliderId] = sliderId.split(".");
    if (this.slidersData[section] && this.slidersData[section][specificSliderId]) {
      const slider = this.slidersData[section][specificSliderId];
      let newValue = slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" ? value : parseFloat(value);

      if (!(slider.type === "select" || slider.type === "dropdown" || slider.type === "radio")) {
        newValue = this.mapSliderValueToUserFacing(slider, newValue);
      }
      slider.value = newValue;

      // Dispatch actions based on slider ID
      switch (sliderId) {
        case "display.display-type":
          this.simMain.setDisplayType(newValue);
          break;
        case "display.links-colors":
          this.simMain.setLinksColors(newValue);
          break;
        case "display.satellite-colors":
          this.simMain.setSatelliteColorMode(newValue);
          break;
        case "simulation.time-acceleration-slider":
          this.simMain.setTimeAccelerationFactor(newValue);
          break;
        case "display.sun-size-factor":
          this.simMain.setSunSizeFactor(newValue);
          break;
        case "display.planets-size-factor":
          this.simMain.setPlanetsSizeFactor(newValue);
          break;
        case "display.satellite-size-factor":
          this.simMain.setSatelliteSizeFactor(newValue);
          break;
        case "display.roadster-size-factor":
          this.simMain.setRoadsterSizeFactor(newValue);
          break;

        case "laser_technology.current-throughput-gbps":
        case "laser_technology.current-distance-km":
        case "laser_technology.improvement-factor":
        case "ring_earth.laser-ports-per-satellite":
        case "ring_mars.laser-ports-per-satellite":
        case "circular_rings.laser-ports-per-satellite":
        case "eccentric_rings.laser-ports-per-satellite":
        case "economics.satellite-empty-mass":
        case "laser_technology.laser-terminal-mass":
        case "simulation.maxDistanceAU":
        case "simulation.maxSatCount":
        case "simulation.calctimeSec":
        case "simulation.solarExclusionDeg":
        case "simulation.flowAlgorithm":
        case "simulation.linkUpdateIntervalHours":
        case "simulation.failed-satellites-slider":
        case "ring_earth.match-circular-rings":
        case "ring_earth.side-extension-degrees-slider":
        case "ring_earth.requiredmbpsbetweensats":
        case "ring_mars.match-circular-rings":
        case "ring_mars.side-extension-degrees-slider":
        case "ring_mars.requiredmbpsbetweensats":
        case "circular_rings.ringcount":
        case "circular_rings.requiredmbpsbetweensats":
        case "circular_rings.distance-sun-slider-outer-au":
        case "circular_rings.distance-sun-slider-inner-au":
        case "circular_rings.inring-interring-bias-pct":
        case "circular_rings.earth-mars-orbit-inclination-pct":
        case "adapted_rings.laser-ports-per-satellite":
        case "adapted_rings.ringcount":
        case "adapted_rings.auto_route_count":
        case "adapted_rings.route_count":
        case "adapted_rings.linear_satcount_increase":
        case "eccentric_rings.ringcount":
        case "eccentric_rings.requiredmbpsbetweensats":
        case "eccentric_rings.distance-sun-average-au":
        case "eccentric_rings.eccentricity":
        case "eccentric_rings.argument-of-perihelion":
        case "eccentric_rings.earth-mars-orbit-inclination-pct":
          this.simMain.setSatellitesConfig(
            this.getGroupsConfig([
              "economics",
              "simulation",
              "laser_technology",
              "ring_mars",
              "circular_rings",
              "eccentric_rings",
              "ring_earth",
              "adapted_rings",
            ])
          );
          break;

        case "economics.satellite-cost-slider":
        case "economics.launch-cost-slider":
        case "economics.laser-terminal-cost-slider":
        case "economics.fuel-cost-ch4o2":
        case "economics.fuel-cost-argon":
        case "economics.wrights-law-factor":
        case "economics.satellite-empty-mass":
          this.simMain.setCosts(this.getGroupsConfig(["economics"]));
          break;

        default:
          break;
      }

      // Update dependent sliders visibility
      if (this.dependencies[sliderId]) {
        this.dependencies[sliderId].forEach((depId) => {
          const [depSec, depSlid] = depId.split(".");
          const depSlider = this.slidersData[depSec][depSlid];
          const condition = depSlider.displayCondition;
          const refValue = this.slidersData[depSec][condition.slider].value;
          const container = this.sliderContainers[depSec][depSlid];
          if (refValue === condition.value) {
            container.style.display = "block";
          } else {
            container.style.display = "none";
          }
        });
      }
    }
  }

  getGroupsConfig(categoryKeys) {
    const config = {};
    for (const categoryKey of categoryKeys) {
      const group = this.slidersData[categoryKey];
      for (const [sliderKey, sliderData] of Object.entries(group)) {
        // Safely access the value, defaulting to sliderData.value if undefined
        const value =
          this.sliders?.[categoryKey]?.[sliderKey]?.value !== undefined ? this.sliders[categoryKey][sliderKey].value : sliderData.value;

        // Check the type from slidersData to determine how to handle the value
        if (sliderData.type === "radio" || typeof sliderData.value === "string") {
          // Keep strings as strings
          config[`${categoryKey}.${sliderKey}`] = value;
        } else if (typeof sliderData.value === "boolean") {
          // Keep booleans as booleans
          config[`${categoryKey}.${sliderKey}`] = value;
        } else {
          // Parse numbers as float, fall back to default if NaN
          const num = parseFloat(value);
          config[`${categoryKey}.${sliderKey}`] = isNaN(num) ? sliderData.value : num;
        }
      }
    }
    return config;
  }
  updateSimTime(simTime) {
    this._lastSimTime = simTime;
    const el = document.getElementById("simTime");
    if (!el) return;
    const mode = this.simTimeMode || "utc";
    const label = this.simTimeModeLabels?.[mode] || "UTC";
    let body;
    if (mode === "utc") {
      body = this.formatSimTimeToUTC(simTime);
    } else if (mode === "local") {
      const d = simTime instanceof Date ? simTime : new Date(simTime);
      body = d.toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } else if (mode === "lukashian-earth") {
      body = this.lukashianClock?.formatEarth(simTime) || "—";
    } else if (mode === "lukashian-mars") {
      body = this.lukashianClock?.formatMars(simTime) || "—";
    }
    el.textContent = `${label} · ${body}`;
  }

  updateInfoAreaData(html) {
    document.getElementById("info-area-data").innerHTML = html;
  }

  updateInfoAreaCosts(html) {
    const STORAGE_KEY = "marslink-panel-states";
    const sections = ["satellites", "capacity", "flow", "cost", "latency"];

    // Read live DOM state into _arrowStates before innerHTML wipe
    if (!this._arrowStates) {
      // First render: try to restore from localStorage
      try { this._arrowStates = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { this._arrowStates = {}; }
    } else {
      for (const id of sections) {
        const content = document.getElementById(`${id}-content`);
        const compact = document.getElementById(`${id}-compact`);
        if (content) {
          if (content.style.display !== "none") this._arrowStates[id] = "expanded";
          else if (compact && compact.style.display !== "none") this._arrowStates[id] = "compact";
          else this._arrowStates[id] = "closed";
        }
      }
    }

    document.getElementById("info-area-costs").innerHTML = html;

    const persistStates = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._arrowStates)); } catch {}
    };

    for (const id of sections) {
      const arrow = document.getElementById(`${id}-arrow`);
      if (!arrow) continue;
      const content = document.getElementById(`${id}-content`);
      const compact = document.getElementById(`${id}-compact`);
      const label = arrow.parentElement.querySelector("span:last-child");

      const applyState = (state, save) => {
        if (state === "expanded") {
          if (content) content.style.display = "block";
          if (compact) compact.style.display = "none";
          arrow.innerHTML = "&#9662;"; // ▼
          if (label && compact) label.textContent = "Compact";
          else if (label) label.textContent = "Hide";
        } else if (state === "compact") {
          if (content) content.style.display = "none";
          if (compact) compact.style.display = "block";
          arrow.innerHTML = "&#9656;"; // ▶
          if (label) label.textContent = "Expand";
        } else {
          if (content) content.style.display = "none";
          if (compact) compact.style.display = "none";
          arrow.innerHTML = "&#9656;"; // ▶
          if (label && compact) label.textContent = "Diagram";
          else if (label) label.textContent = id === "latency" ? "Chart" : "Details";
        }
        this._arrowStates[id] = state;
        if (save) persistStates();
      };

      // Restore saved state
      const saved = this._arrowStates[id];
      if (saved && saved !== "closed") applyState(saved, false);

      arrow.parentElement.addEventListener("click", () => {
        const contentVisible = content && content.style.display !== "none";
        const compactVisible = compact && compact.style.display !== "none";
        let newState;

        if (compact) {
          // 3-state: closed → compact → expanded → closed
          if (contentVisible) newState = "closed";
          else if (compactVisible) newState = "expanded";
          else newState = "compact";
        } else {
          // 2-state: closed → expanded → closed
          newState = contentVisible ? "closed" : "expanded";
        }
        applyState(newState, true);

        // Resize chart after expanding latency (Chart.js needs visible canvas)
        if (id === "latency" && newState === "expanded" && this.simMain?.latencyChartInstance) {
          this.simMain.latencyChartInstance.resize();
        }
      });
    }
  }

  /**
   * Updates the long-term run summary in the UI.
   * @param {Object} summary - The summarized simulation data.
   */
  updateLongTermSummary(summary) {
    const summaryContainer = document.getElementById("long-term-summary");
    if (summaryContainer) {
      summaryContainer.textContent = JSON.stringify(summary, null, 2);
    }
  }
}
