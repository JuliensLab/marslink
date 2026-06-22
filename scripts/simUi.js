// simUi.js
import { slidersData } from "./slidersData.js?v=4.6";
import { LukashianClock } from "./lukashianTime.js?v=4.6";
import { wireAuthUi } from "./auth.js?v=4.6";
import { SensitivityPool } from "./sensitivityPool.js?v=4.6";
import { minOf } from "./simMath.js?v=4.6";

export class SimUi {
  constructor(simMain) {
    this.simMain = simMain;
    this.slidersData = slidersData;
    this.sliders = {};
    this.sliderContainers = {};
    this.dependencies = {};

    this.createSliders();
    this.hidePerSectionRingCounts(); // ring count is configured once, on relay_type
    this.updateRelaySectionVisibility(); // show only the active relay family's section
    this.updateColorLegend();
    setInterval(() => this.updateColorLegend(), 1500); // keep live Flow/Capacity values fresh
    this.initializeSimMain();
    this.setupModeNavigation();
    this.setupSliderSearch();
    this.setupPresets();
    this.setupSimpleConfig();
    this.setupReportPanel();
    this.setupHelpPopup();
    wireAuthUi();
    this.setupRightPanelToggle();
    this.setupSimTimeCycle();
    this.setupLinkLabelToggles();
    this.setupSatLabelToggle();
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
   * Bottom-bar S toggle + 's' key for per-satellite value labels of the current
   * satellite colour mode. Applies to whichever display is active.
   */
  setupSatLabelToggle() {
    const btn = document.getElementById("kbd-toggle-satlabels");
    const apply = (on) => { if (btn) btn.classList.toggle("active", !!on); };

    const toggle = () => {
      const sm = this.simMain;
      if (!sm || typeof sm.setSatLabelMode !== "function") return;
      sm.setSatLabelMode(!sm.satLabelMode);
    };

    if (btn) btn.addEventListener("click", toggle);

    window.addEventListener("keydown", (e) => {
      if ((e.key || "").toLowerCase() !== "s") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave Ctrl/Cmd+S etc. alone
      const t = e.target;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return; // don't hijack typing
      toggle();
    });

    window.addEventListener("marslink:sat-label-mode", (e) => apply(e.detail && e.detail.on));
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

    // --- Right-panel tab switching (Live metrics / Performance) ---
    const tabs = panel.querySelectorAll(".right-panel-tab");
    const panels = panel.querySelectorAll("[data-panel]");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.panel;
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        panels.forEach((p) => {
          // Only toggle visibility for panels that are direct children of the aside
          // (not nested data-panel attributes inside metric cards)
          if (p.parentElement === panel || p.parentElement?.parentElement === panel) {
            p.style.display = p.dataset.panel === target ? "" : "none";
          }
        });
      });
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
        "adapted_eccentric_rings",
        "launch_schedule",
        "launch_vehicle",
        "satellite",
      ])
    );
    // Set the initial display type
    const displayType = this.slidersData.display["display-type"].value;
    this.simMain.setDisplayType(displayType);
    const linksColors = this.slidersData.display["links-colors"].value;
    this.simMain.setLinksColors(linksColors);
    const satelliteColors = this.slidersData.display["satellite-colors"].value;
    this.simMain.setSatelliteColorMode(satelliteColors);
    const thrustBodies = this.slidersData.display["thrust-bodies"].value;
    this.simMain.setThrustBodies(thrustBodies);
    const planetOrbits = this.slidersData.display["planet-orbits"].value;
    this.simMain.setPlanetOrbits(planetOrbits);
    const planeNodes = this.slidersData.display["plane-nodes"].value;
    this.simMain.setPlaneNodes(planeNodes);
    const geoOrbits = this.slidersData.display["geostationary-orbits"].value;
    this.simMain.setGeostationaryOrbits(geoOrbits);

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

      if (mode === "simple" || mode === "configure" || mode === "sensitivity") {
        closeReportPanel();
        modeDrawer.hidden = false;
        modeDrawer.setAttribute("aria-hidden", "false");
        simplePane.hidden = mode !== "simple";
        configurePane.hidden = mode !== "configure";
        sensitivityPane.hidden = mode !== "sensitivity";
        // The expand mode is sensitivity-only; collapse the drawer for other panes.
        if (mode !== "sensitivity") {
          modeDrawer.classList.remove("sens-expanded");
          document.getElementById("sens-expand-btn")?.setAttribute("aria-pressed", "false");
        }
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
        // Expand every collapsible in the section (including nested sub-groups
        // like the Equalizer) so a matching row is actually revealed.
        if (q && anyVisible) {
          section.querySelectorAll(".slider-section-content").forEach((c) => c.classList.add("active"));
          section.querySelectorAll(".slider-section-header").forEach((h) => h.classList.add("expanded"));
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

    const ringData = this.slidersData.relay_type.ringcount;
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
      return Math.sign(v) * Math.round(Math.pow(2, Math.abs(v) - 1));
    };
    const signedPow2Inv = (v) => {
      if (v === 0) return 0;
      return Math.sign(v) * (Math.round(Math.log2(Math.abs(v))) + 1);
    };

    // Required-throughput master (pow10 Gbps) — the general-design driver. It sizes
    // the Earth/Mars rings (worst case = half) and, per relay type, either the ring
    // count (concentric) or the in-ring rate (eccentric). Drives via the advanced
    // relay_type.requiredgbps slider so a single switch case does the sizing.
    const gbpsData = this.slidersData.relay_type.requiredgbps;
    const throughputRow = makeSliderRow("Required throughput",
      { min: gbpsData.min, max: gbpsData.max, step: gbpsData.step, unit: gbpsData.unit, value: gbpsData.value },
      "simple-throughput",
      (internal) => { this.applySliderValues({ "relay_type.requiredgbps": internal }); },
      { toDisplay: (v) => Math.round(Math.pow(10, v) * 100) / 100, toInternal: (v) => Math.log10(v) }
    );
    const currentReqGbps = () => Math.pow(10, parseFloat(throughputRow.slider.value));

    // Time acceleration slider — signedPow2 scale (continuous, step 0.1)
    const timeData = this.slidersData.simulation["time-acceleration-slider"];
    const timeRow = makeSliderRow("Time acceleration",
      { min: timeData.min, max: timeData.max, step: 0.1, unit: "x", value: timeData.value },
      "simple-time",
      (val) => { this.applySliderValues({ "simulation.time-acceleration-slider": val }); },
      { toDisplay: signedPow2, toInternal: signedPow2Inv }
    );

    // Laser tech improvement slider — pow2 scale.
    // Changing the laser tech rescales per-link capacity (and therefore the
    // adapted-rings aggregate target), so we re-run the same defaults-and-
    // feedback-loop the ring-count slider uses, keeping the Earth/Mars in-ring
    // mbps locked to the new adapted capacity.
    const techRow = makeSliderRow("Laser tech improvement",
      { min: techData.min, max: techData.max, step: 1, unit: "x", value: techData.value },
      "simple-techfactor",
      (val) => {
        this.applySliderValues({ "laser_technology.improvement-factor": val });
        // Tech change rescales the link budget → re-size for the same throughput
        // (concentric ring count or eccentric in-ring rate shifts accordingly).
        this.applyDesignFromThroughput(currentReqGbps());
      },
      { toDisplay: (v) => Math.pow(2, v), toInternal: (v) => Math.round(Math.log2(v)) }
    );

    // Ring count slider — linear. Passing `{ startFeedback: true }` arms a
    // 2-iteration feedback loop that rescales the earth / mars in-ring mbps
    // to match the actual adapted-ring aggregate capacity once the worker
    // delivers a fresh capacityInfo. The feedback only fires on slider moves,
    // not on the initial applySimpleDefaults call at the bottom of this
    // method (line 638), so the direct formula alone seeds the defaults.
    // For eccentric families this is the coverage/latency knob (held while the in-ring
    // rate carries throughput); for concentric it is derived from throughput and shown
    // read-only (disabled below, so this handler only fires for eccentric).
    const ringRow = makeSliderRow("Relay ring count", ringData, "simple-ringcount", (val) => {
      this.applySliderValues({ "relay_type.ringcount": val });
      this.applyDesignFromThroughput(currentReqGbps());
    });

    // Relay-type selector (position 3, above the ring-count row). Switching family
    // updates section visibility + the active builder, then re-applies defaults so the
    // ring-count slider drives the newly selected family.
    const relayTypeData = this.slidersData.relay_type.selected;
    const relayRow = (() => {
      const wrap = document.createElement("div");
      wrap.className = "metric-card";
      wrap.style.cssText = "margin-bottom:6px; padding:10px 12px;";
      const header = document.createElement("div");
      header.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px;";
      const lbl = document.createElement("span");
      lbl.className = "metric-label";
      lbl.textContent = "Relay ring type";
      const sel = document.createElement("select");
      sel.className = "slider-value-input";
      sel.style.cssText = "flex:1; max-width:62%; text-align:left;";
      relayTypeData.options.forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (opt === this.getSelectedRelayType()) o.selected = true;
        if (relayTypeData.optionDescriptions?.[opt]) o.title = relayTypeData.optionDescriptions[opt];
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => {
        this.applySliderValues({ "relay_type.selected": sel.value });
        // Ring count is an input for eccentric families (coverage) and derived for
        // concentric ones — toggle the row, then re-size for the new family at the
        // current required throughput.
        const ecc = this._isEccentricSection(SimUi.RELAY_TYPE_SECTIONS[sel.value]);
        ringRow.slider.disabled = !ecc;
        ringRow.valInput.disabled = !ecc;
        ringRow.wrap.style.opacity = ecc ? "1" : "0.6";
        this.applyDesignFromThroughput(currentReqGbps());
      });
      header.appendChild(lbl);
      header.appendChild(sel);
      wrap.appendChild(header);
      return { wrap, sel };
    })();

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
    // Keep the simple ring-count slider synced when the shared relay_type.ringcount
    // changes in the advanced panel.
    const advRing = this.sliders.relay_type?.ringcount;
    if (advRing) {
      advRing.addEventListener("input", () => {
        ringRow.slider.value = advRing.value;
        ringRow.valInput.value = advRing.value;
      });
    }
    // Keep the simple throughput row synced when relay_type.requiredgbps changes
    // elsewhere (advanced panel, or our own applyDesignFromThroughput writes).
    const advGbps = this.sliders.relay_type?.requiredgbps;
    if (advGbps) {
      advGbps.addEventListener("input", () => {
        throughputRow.slider.value = advGbps.value;
        throughputRow.valInput.value = Math.round(Math.pow(10, parseFloat(advGbps.value)) * 100) / 100;
      });
    }

    // Keep the simple selector in sync when the relay type changes in the advanced panel.
    const advRelay = this.sliders.relay_type?.selected;
    if (advRelay) {
      advRelay.addEventListener("change", () => {
        const checked = advRelay.querySelector("input[type=radio]:checked");
        if (checked) relayRow.sel.value = checked.value;
      });
    }

    container.appendChild(timeRow.wrap);
    container.appendChild(techRow.wrap);
    container.appendChild(relayRow.wrap);
    container.appendChild(throughputRow.wrap);
    container.appendChild(ringRow.wrap);

    // Initialize from the current config: show the throughput the current ring setup
    // delivers, set the ring-count row's editability for the active family, then size
    // both ends from that throughput. The inversion round-trips to the same ring count
    // (concentric) / in-ring rate (eccentric), so nothing jumps on load.
    const R0 = parseFloat(this.sliders.relay_type?.ringcount?.value ?? ringData.value);
    try {
      const selKey0 = SimUi.RELAY_TYPE_SECTIONS[this.getSelectedRelayType()] || "adapted_rings";
      const ecc0 = this._isEccentricSection(selKey0);
      ringRow.slider.disabled = !ecc0;
      ringRow.valInput.disabled = !ecc0;
      ringRow.wrap.style.opacity = ecc0 ? "1" : "0.6";
      const t0Gbps = this._relayThroughputMbps(R0, selKey0) / 1000;
      this.applySliderValues({ "relay_type.requiredgbps": this.mapUserFacingToSliderValue(gbpsData, t0Gbps) });
    } catch (err) {
      // Never let throughput-driven init block app load — fall back to the known-good
      // ring-count seed so the page always finishes loading.
      console.error("[Marslink] throughput-driven init failed, falling back:", err);
      this.applySimpleDefaults(R0);
    }
  }

  /**
   * Applies the simple-mode defaults for a given ring count.
   */
  /**
   * Estimates min planet-to-ring capacity (Mbps) for a given requiredmbpsbetweensats.
   * Returns the worst-case (apoapsis) total capacity of both planet-to-satellite links.
   */
  /**
   * Direct formula: given a target planet-to-ring min capacity (Mbps),
   * compute the `requiredmbpsbetweensats` slider value that achieves it.
   *
   * Works backwards through the chain:
   *   targetMbps → worst-case distance → sat count → inter-sat distance → mbpsBetweenSats
   */
  _mbpsBetweenSatsForTargetCapacity(targetMbps, ringType) {
    const lb = this.simMain.simLinkBudget;
    const sats = this.simMain.simSatellites;
    const AU_IN_KM = 149597870.7;
    const { a } = sats.getParams_a_n(ringType);
    const e = ringType === "Mars" ? 0.0934231 : 0.0166967;
    const apo = a * (1 + e);

    // Step 1: target capacity per link (2 planet links, one per side).
    // This is just a seed — the feedback loop corrects to the exact target.
    const targetPerLinkGbps = targetMbps / 2 / 1000;
    if (targetPerLinkGbps <= 0) return 50;

    // Step 2: worst-case distance that gives this capacity
    // calculateGbps(d) = _gbpsFactor / d², so d = sqrt(_gbpsFactor / gbps)
    const gbpsFactor = lb._gbpsFactor;
    const worstDistKm = Math.sqrt(gbpsFactor / targetPerLinkGbps);
    const worstDistAu = worstDistKm / AU_IN_KM;

    // Step 3: satellite count from worst-case chord distance
    // chord = 2 * apo * sin(halfSpacing), so halfSpacing = asin(chord / (2 * apo))
    const sinHalf = worstDistAu / (2 * apo);
    if (sinHalf >= 1) return 50; // can't achieve this capacity
    const halfSpacingRad = Math.asin(sinHalf);
    let satCount = Math.ceil(Math.PI / halfSpacingRad);

    // Connectivity floor: never let adjacent spacing exceed the link range, or
    // the ring fragments into disconnected arcs (measured: flow collapses
    // nonlinearly once spacing > maxDistanceAU). Bump the count so the
    // worst-case chord stays within range regardless of the throughput target.
    const maxDistanceAU = lb.maxDistanceAU;
    if (maxDistanceAU > 0) {
      const sinConnect = maxDistanceAU / (2 * apo);
      if (sinConnect > 0 && sinConnect < 1) {
        const nConnect = Math.ceil(Math.PI / Math.asin(sinConnect));
        if (nConnect > satCount) satCount = nConnect;
      }
    }
    if (satCount < 2) return 50;

    // Step 4: inter-satellite distance from satellite count
    const circumferenceAu = 2 * Math.PI * a;
    const distAuBetweenSats = circumferenceAu / satCount;
    const distKmBetweenSats = distAuBetweenSats * AU_IN_KM;

    // Step 5: convert distance to mbps (inverse of calculateKm)
    // calculateGbps(d) = _gbpsFactor / d²
    const gbps = gbpsFactor / (distKmBetweenSats * distKmBetweenSats);
    return Math.max(1, Math.round(gbps * 1000));
  }

  /** True when the given relay-section key is one of the eccentric families. */
  _isEccentricSection(selKey) {
    return selKey === "eccentric_rings" || selKey === "adapted_eccentric_rings";
  }

  /**
   * Aggregate Earth↔Mars relay throughput (Mbps) the active family delivers at a
   * given ring count, from its own routing model:
   *   • concentric (adapted / circular): radial spokes — routeCount parallel routes,
   *     each ≈ one inter-ring link → routeCount · perRouteMbps  (∝ ringCount³)
   *   • eccentric (adapted-eccentric / eccentric): each ring is one azimuthal loop
   *     carrying both arcs → 2 · ringCount · (worst-case in-ring rate)
   * This is the forward law; applyDesignFromThroughput inverts it.
   */
  _relayThroughputMbps(ringCount, selKey) {
    if (ringCount <= 0) return 0;
    if (this._isEccentricSection(selKey)) {
      const reqMbps = this.getGroupsConfig([selKey])[`${selKey}.requiredmbpsbetweensats`] || 50;
      return 2 * ringCount * reqMbps;
    }
    const lb = this.simMain.simLinkBudget;
    const rM = this.simMain.simSatellites.getMars().a;
    const rE = this.simMain.simSatellites.getEarth().a;
    const Dem = rM - rE;
    const routeCount = Math.round((ringCount * Math.sqrt(3) * Math.PI * rM) / Dem);
    const interRingAu = Dem / (ringCount + 1);
    const perRouteMbps = lb.calculateGbps(lb.convertAUtoKM(interRingAu)) * 1000;
    return routeCount * perRouteMbps;
  }

  /**
   * Smallest concentric ring count whose forward throughput meets targetMbps.
   * Monotonic in ring count, so a scan up to the slider max is exact (and cheap).
   */
  _ringCountForThroughput(targetMbps, selKey) {
    const maxR = this.slidersData.relay_type.ringcount.max || 100;
    for (let R = 1; R <= maxR; R++) {
      if (this._relayThroughputMbps(R, selKey) >= targetMbps) return R;
    }
    return maxR;
  }

  applySimpleDefaults(ringCount, options = {}) {
    const selKey = SimUi.RELAY_TYPE_SECTIONS[this.getSelectedRelayType()] || "adapted_rings";

    // Seed the relay aggregate throughput from the SELECTED family's own routing model so
    // the Earth/Mars rings start near the right size; the feedback loop then refines
    // against the live routeSummary (exact for whichever family is active).
    const targetMbps = this._relayThroughputMbps(ringCount, selKey);

    // Direct formula: find requiredmbpsbetweensats that yields min capacity = targetMbps
    const earthMbps = this._mbpsBetweenSatsForTargetCapacity(targetMbps, "Earth");
    const marsMbps = this._mbpsBetweenSatsForTargetCapacity(targetMbps, "Mars");

    // The Simple "Relay ring count" is the single shared relay_type.ringcount, used by
    // whichever family is active (selKey, from the seed block above).
    this.applySliderValues({
      "relay_type.ringcount": ringCount,
      // Adapted-concentric tuning (only consumed when that family is the active one).
      "adapted_rings.auto_route_count": "yes",
      "adapted_rings.laser-ports-per-satellite": 2,
      "adapted_rings.linear_satcount_increase": 0.18,
      // Earth ring — sized to match relay capacity
      "ring_earth.laser-ports-per-satellite": 3,
      "ring_earth.side-extension-degrees-slider": 180,
      "ring_earth.match-circular-rings": "no",
      "ring_earth.requiredmbpsbetweensats": this.mapUserFacingToSliderValue(this.slidersData.ring_earth.requiredmbpsbetweensats, earthMbps),
      // Mars ring — sized to match adapted capacity
      "ring_mars.laser-ports-per-satellite": 3,
      "ring_mars.side-extension-degrees-slider": 180,
      "ring_mars.match-circular-rings": "no",
      "ring_mars.requiredmbpsbetweensats": this.mapUserFacingToSliderValue(this.slidersData.ring_mars.requiredmbpsbetweensats, marsMbps),
    });

    // Arm the feedback loop. Target is read live from routeSummary each
    // iteration, so we only store the iteration counter.  Max 100 reps;
    // stops early when both rings land within 5% of halfTarget.
    if (options.startFeedback && ringCount > 0) {
      this._simpleFeedbackState = { iterationsLeft: 100 };
    } else {
      this._simpleFeedbackState = null;
    }
  }

  /**
   * Throughput-driven design — the inverse of applySimpleDefaults. The designer sets
   * the required Earth↔Mars throughput (Gbps); this sizes the constellation to deliver
   * it, both ends from the same number, so no goal-seek loop:
   *   • Earth/Mars rings: worst-case in-ring rate = half the throughput (the busiest
   *     planet-ring link carries half, the gateway splitting the ring two ways).
   *   • Concentric (adapted / circular): ring count is DERIVED from throughput
   *     (throughput ∝ ring count³); the per-ring sat density follows from the lattice.
   *   • Eccentric (adapted-eccentric / eccentric): ring count is the user's coverage/
   *     latency knob (held); the worst-case in-ring rate is derived = throughput/(2·R).
   */
  applyDesignFromThroughput(reqGbps) {
    // Re-entrancy guard: applySliderValues below dispatches slider events that run
    // their own handlers synchronously; should any path lead back here, bail rather
    // than recurse. Legitimate callers (init, the requiredgbps slider, the simple
    // tech/relay/ring rows) are always top-level, never nested.
    if (this._applyingDesign) return;
    this._applyingDesign = true;
    try {
      this._applyDesignFromThroughput(reqGbps);
    } finally {
      this._applyingDesign = false;
    }
  }

  _applyDesignFromThroughput(reqGbps) {
    const selKey = SimUi.RELAY_TYPE_SECTIONS[this.getSelectedRelayType()] || "adapted_rings";
    const isEccentric = this._isEccentricSection(selKey);
    const T_mbps = Math.max(0, reqGbps * 1000);
    const values = {};

    if (isEccentric) {
      // Ring count is the coverage input; derive the worst-case in-ring rate from it.
      const R = Math.max(1, Math.round(parseFloat(
        this.sliders.relay_type?.ringcount?.value ?? this.slidersData.relay_type.ringcount.value
      )));
      const sd = this.slidersData[selKey].requiredmbpsbetweensats;
      // Clamp at the per-terminal line rate (the slider max ≈ the terminal ceiling):
      // past it, densifying one ring saturates and more throughput needs more rings.
      const cTermMbps = (this.simMain.simLinkBudget.cTermGbps || Infinity) * 1000;
      const m = Math.max(sd.min, Math.min(sd.max, cTermMbps, T_mbps / (2 * R)));
      values[`${selKey}.requiredmbpsbetweensats`] = this.mapUserFacingToSliderValue(sd, m);
    } else {
      // Concentric: ring count is derived from throughput.
      values["relay_type.ringcount"] = this._ringCountForThroughput(T_mbps, selKey);
      values["adapted_rings.auto_route_count"] = "yes";
      values["adapted_rings.laser-ports-per-satellite"] = 2;
      values["adapted_rings.linear_satcount_increase"] = 0.18;
    }

    // Earth/Mars planet rings: worst-case in-ring rate = half the total throughput.
    // The planet injects at one point and the ring splits two ways, so the busiest
    // in-ring link carries T/2 — set that directly as each planet ring's worst-case
    // rate (requiredmbpsbetweensats is exactly that target). Both planet rings are
    // sized to deliver the full throughput, so neither becomes the bottleneck.
    const planetMbps = T_mbps / 2;
    const eSd = this.slidersData.ring_earth.requiredmbpsbetweensats;
    const mSd = this.slidersData.ring_mars.requiredmbpsbetweensats;
    Object.assign(values, {
      "ring_earth.laser-ports-per-satellite": 3,
      "ring_earth.side-extension-degrees-slider": 180,
      "ring_earth.match-circular-rings": "no",
      "ring_earth.requiredmbpsbetweensats": this.mapUserFacingToSliderValue(eSd, planetMbps),
      "ring_mars.laser-ports-per-satellite": 3,
      "ring_mars.side-extension-degrees-slider": 180,
      "ring_mars.match-circular-rings": "no",
      "ring_mars.requiredmbpsbetweensats": this.mapUserFacingToSliderValue(mSd, planetMbps),
    });

    this.applySliderValues(values);
    // Both ends sized analytically from the same throughput — no feedback loop.
    this._simpleFeedbackState = null;
  }

  /**
   * Single step of the in-ring mbps feedback loop. Reads capacity data,
   * checks convergence, and applies a proportional correction if needed.
   *
   * @param {object} capInfo - { ringCapacities } from calculateCapacityInfo
   * @param {number} target  - relay aggregate throughput (Mbps)
   * @returns {"converged"|"adjusted"|"skip"} outcome of this step
   */
  _feedbackStep(capInfo, target) {
    const earthInring = capInfo.ringCapacities?.["ring_earth"]?.inring || [];
    const marsInring = capInfo.ringCapacities?.["ring_mars"]?.inring || [];
    if (earthInring.length === 0 || marsInring.length === 0) {
      console.log(`[Feedback] skip: earthInring=${earthInring.length}, marsInring=${marsInring.length}`);
      return "skip";
    }

    const earthMin = 2 * minOf(earthInring);
    const marsMin = 2 * minOf(marsInring);
    const lo = target * 1.02, hi = target * 1.04;
    console.log(`[Feedback] target=${target.toFixed(0)} earthMin=${earthMin.toFixed(0)} marsMin=${marsMin.toFixed(0)} band=[${lo.toFixed(0)},${hi.toFixed(0)}]`);
    if (earthMin >= lo && earthMin <= hi && marsMin >= lo && marsMin <= hi) return "converged";

    const earthInput = this.sliders.ring_earth?.requiredmbpsbetweensats;
    const marsInput = this.sliders.ring_mars?.requiredmbpsbetweensats;
    if (!earthInput || !marsInput) return "skip";
    const earthSD = this.slidersData.ring_earth?.requiredmbpsbetweensats;
    const marsSD = this.slidersData.ring_mars?.requiredmbpsbetweensats;
    const oldEarthMbps = this.mapSliderValueToUserFacing(earthSD, parseFloat(earthInput.value));
    const oldMarsMbps = this.mapSliderValueToUserFacing(marsSD, parseFloat(marsInput.value));
    if (!oldEarthMbps || !oldMarsMbps) return "skip";

    const aim = target * 1.03;
    const newEarthMbps = earthMin > 0 ? Math.max(1, Math.round(oldEarthMbps * aim / earthMin)) : oldEarthMbps;
    const newMarsMbps = marsMin > 0 ? Math.max(1, Math.round(oldMarsMbps * aim / marsMin)) : oldMarsMbps;
    const newEarthInt = this.mapUserFacingToSliderValue(earthSD, newEarthMbps);
    const newMarsInt = this.mapUserFacingToSliderValue(marsSD, newMarsMbps);
    if (newEarthInt === parseFloat(earthInput.value) && newMarsInt === parseFloat(marsInput.value)) return "converged";

    this.applySliderValues({
      "ring_earth.requiredmbpsbetweensats": newEarthInt,
      "ring_mars.requiredmbpsbetweensats": newMarsInt,
    });
    return "adjusted";
  }

  /**
   * Interactive feedback step — called by simMain on links-ready.
   * Delegates to _feedbackStep using the live capacityInfo + routeSummary.
   */
  runSimpleFeedbackStep() {
    const state = this._simpleFeedbackState;
    if (!state || state.iterationsLeft <= 0) return;

    const rs = this.simMain?.routeSummary;
    if (!rs || !rs.totalThroughput || rs.totalThroughput <= 0) return;
    const capacityInfo = this.simMain?.capacityInfo;
    if (!capacityInfo || !capacityInfo.ringCapacities) return;

    // No-progress / unreachable-target guard (mirrors the sensitivity loop):
    // if the realized in-ring capacities are unchanged from the previous step,
    // the slider granularity or ring geometry can't move them any closer to the
    // target (e.g. the Mars ring is saturated below target). Stop instead of
    // re-applying the same config every frame and recomputing forever.
    const eInring = capacityInfo.ringCapacities?.["ring_earth"]?.inring || [];
    const mInring = capacityInfo.ringCapacities?.["ring_mars"]?.inring || [];
    const curEarth = eInring.length ? Math.round(2 * minOf(eInring)) : 0;
    const curMars = mInring.length ? Math.round(2 * minOf(mInring)) : 0;

    // Surface the live tuning state for the status bar. Each step adjusts the
    // Earth/Mars requiredmbpsbetweensats (→ their satellite counts) to bring their
    // in-ring capacity toward the relay target; expose target + both ring values
    // so users see the convergence rather than a seemingly stuck recompute.
    state.step = (state.step || 0) + 1;
    this._tuningStatus = { step: state.step, target: rs.totalThroughput, earthMin: curEarth, marsMin: curMars };

    if (state.prevEarth === curEarth && state.prevMars === curMars) {
      this._simpleFeedbackState = null;
      this._tuningStatus = null;
      return;
    }
    state.prevEarth = curEarth;
    state.prevMars = curMars;

    const outcome = this._feedbackStep(capacityInfo, rs.totalThroughput);
    state.iterationsLeft--;
    if (outcome !== "adjusted" || state.iterationsLeft <= 0) {
      this._simpleFeedbackState = null;
      this._tuningStatus = null;
    }
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
  /**
   * Sets up the Sensitivity analysis panel: estimate, start/stop, sweep logic.
   */
  setupSensitivity() {
    const startBtn = document.getElementById("startSensitivity");
    if (!startBtn) return;

    const stopBtn = document.getElementById("stopSensitivity");
    const progressWrap = document.getElementById("sens-progress-wrap");
    const progressBar = document.getElementById("sens-progress-bar");
    const progressText = document.getElementById("sens-progress-text");
    const estimateEl = document.getElementById("sens-estimate");

    // Worker-thread control: cap at the machine's logical core count, default to
    // ~half (leave real headroom for the renderer/compositor — saturating all
    // logical cores starves the browser's main thread and freezes the UI). The
    // user can still override up to the available max.
    const threadsAvailable = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    const defaultWorkers = Math.max(1, Math.floor(threadsAvailable / 2));
    const workerCountInput = document.getElementById("sens-worker-count");
    const threadAvailEl = document.getElementById("sens-thread-avail");
    if (workerCountInput) {
      workerCountInput.max = threadsAvailable;
      if (!parseInt(workerCountInput.value, 10)) workerCountInput.value = defaultWorkers;
      const clampWorkers = () => {
        let v = parseInt(workerCountInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        if (v > threadsAvailable) v = threadsAvailable;
        workerCountInput.value = v;
      };
      workerCountInput.addEventListener("change", clampWorkers);
    }
    if (threadAvailEl) threadAvailEl.textContent = `of ${threadsAvailable} thread${threadsAvailable === 1 ? "" : "s"} available`;

    // Toggle linear step visibility based on progression type
    const progSelect = document.getElementById("sens-tech-progression");
    const stepInput = document.getElementById("sens-tech-step");

    // --- Helpers to build value arrays (shared by estimate + run) ---
    const buildRingValues = () => {
      if (!document.getElementById("sens-ring-enable").checked) return [null];
      const s = parseInt(document.getElementById("sens-ring-start").value);
      const e = parseInt(document.getElementById("sens-ring-end").value);
      const step = parseInt(document.getElementById("sens-ring-step").value) || 1;
      const vals = [];
      for (let r = s; r <= e; r += step) vals.push(r);
      return vals.length ? vals : [null];
    };
    const buildTechValues = () => {
      if (!document.getElementById("sens-tech-enable").checked) return [null];
      const s = parseInt(document.getElementById("sens-tech-start").value);
      const e = parseInt(document.getElementById("sens-tech-end").value);
      const prog = progSelect.value;
      const linStep = parseInt(stepInput.value) || 1;
      const vals = [];
      if (prog === "pow2") { for (let t = s; t <= e; t *= 2) vals.push(t); }
      else { for (let t = s; t <= e; t += linStep) vals.push(t); }
      return vals.length ? vals : [null];
    };
    const buildDateValues = () => {
      // When the date dimension is off (or its inputs are invalid), sweep at the
      // current sim date — the same date shown in the "Fixed:" label and used
      // everywhere else in the app — rather than a hardcoded value.
      const currentDate = () => {
        const d = this.simMain?.simTime?.getDate?.();
        return d ? d.toISOString().slice(0, 10) : "2030-01-01";
      };
      if (!document.getElementById("sens-date-enable").checked) return [currentDate()];
      const startMs = new Date(document.getElementById("sens-date-start").value).getTime();
      const endMs = new Date(document.getElementById("sens-date-end").value).getTime();
      const stepDays = parseInt(document.getElementById("sens-date-step").value) || 1;
      if (isNaN(startMs) || isNaN(endMs) || endMs < startMs) return [currentDate()];
      const vals = [];
      const dayMs = 86400 * 1000;
      for (let t = startMs; t <= endMs; t += stepDays * dayMs) {
        vals.push(new Date(t).toISOString().slice(0, 10));
      }
      return vals.length ? vals : [currentDate()];
    };

    // --- Estimate display (iteration count + time) ---
    const updateEstimate = () => {
      const total = buildRingValues().length * buildTechValues().length * buildDateValues().length;
      const wt = this.simMain?.lastWorkerTimings;
      const perIterMs = wt?.totalMs || wt?.links || 0;
      let timeStr = "";
      if (perIterMs > 0) {
        // Rough upper bound; the worker pool runs several scenarios concurrently.
        const totalSec = Math.round(total * (perIterMs / 1000));
        if (totalSec < 60) timeStr = ` ~${totalSec} seconds`;
        else if (totalSec < 3600) timeStr = ` ~${Math.round(totalSec / 60)} minutes`;
        else timeStr = ` ~${(totalSec / 3600).toFixed(1)} hours`;
        timeStr += " compute time";
      }
      estimateEl.textContent = `${total} iteration${total !== 1 ? "s" : ""}${timeStr}`;
    };
    this._updateSensEstimate = updateEstimate;

    progSelect.addEventListener("change", () => {
      stepInput.style.display = progSelect.value === "linear" ? "" : "none";
      updateEstimate();
    });

    // Enable/disable the three metric rows via their checkboxes.
    const wireEnable = (checkboxId, rowSelectorInputs) => {
      const cb = document.getElementById(checkboxId);
      if (!cb) return;
      const sync = () => {
        for (const el of rowSelectorInputs()) {
          el.disabled = !cb.checked;
          el.style.opacity = cb.checked ? "" : "0.4";
        }
        updateEstimate();
      };
      cb.addEventListener("change", sync);
      sync();
    };
    wireEnable("sens-ring-enable", () => [
      document.getElementById("sens-ring-start"),
      document.getElementById("sens-ring-end"),
      document.getElementById("sens-ring-step"),
    ]);
    wireEnable("sens-tech-enable", () => [
      document.getElementById("sens-tech-start"),
      document.getElementById("sens-tech-end"),
      document.getElementById("sens-tech-progression"),
      document.getElementById("sens-tech-step"),
    ]);
    wireEnable("sens-date-enable", () => [
      document.getElementById("sens-date-start"),
      document.getElementById("sens-date-end"),
      document.getElementById("sens-date-step"),
    ]);

    // Update estimate on any input change
    const sensInputs = document.querySelectorAll("#sensitivity-pane input, #sensitivity-pane select");
    for (const el of sensInputs) {
      el.addEventListener("input", updateEstimate);
      el.addEventListener("change", updateEstimate);
    }

    // --- Chart infrastructure ---
    const chartsWrap = document.getElementById("sens-charts");
    let sensCharts = []; // [satsChart, flowChart, costChart, cpfChart]

    const textMuted = "#7c879f";
    const textDim = "#525c75";
    const gridColor = "rgba(255, 255, 255, 0.06)";
    const tooltipBg = "#1a2030";
    // Palette for multi-series (up to 12 distinct colors)
    const palette = [
      "rgba(107,138,253,0.8)", "rgba(253,138,107,0.8)", "rgba(107,253,180,0.8)",
      "rgba(253,220,107,0.8)", "rgba(180,107,253,0.8)", "rgba(107,220,253,0.8)",
      "rgba(253,107,180,0.8)", "rgba(180,253,107,0.8)", "rgba(253,160,107,0.8)",
      "rgba(107,253,253,0.8)", "rgba(200,200,200,0.8)", "rgba(253,107,253,0.8)",
    ];

    const destroyCharts = () => {
      for (const c of sensCharts) if (c) c.destroy();
      sensCharts = [];
    };

    // Per-category folds: each toggle (data-target) collapses the breakdown charts
    // in its category. Resize on expand since charts created while a fold is hidden
    // start at zero size.
    for (const toggle of document.querySelectorAll(".sens-charts-toggle")) {
      const target = document.getElementById(toggle.dataset.target);
      if (!target) continue;
      toggle.addEventListener("click", () => {
        const show = target.hidden;
        target.hidden = !show;
        toggle.setAttribute("aria-expanded", String(show));
        toggle.classList.toggle("expanded", show);
        if (show) for (const c of sensCharts) if (c) c.resize();
      });
    }

    // Expand button: widen the drawer (CSS) and grow chart height; resize charts
    // once the width transition settles.
    const expandBtn = document.getElementById("sens-expand-btn");
    const drawer = document.getElementById("mode-drawer");
    if (expandBtn && drawer) {
      expandBtn.addEventListener("click", () => {
        const expanded = drawer.classList.toggle("sens-expanded");
        expandBtn.setAttribute("aria-pressed", String(expanded));
        setTimeout(() => { for (const c of sensCharts) if (c) c.resize(); }, 180);
      });
    }

    /**
     * Build the 3 Chart.js instances for flow / cost / cost-per-flow.
     * @param {string[]} enabledDims - e.g. ["rings"], ["rings","tech"], ["rings","tech","date"]
     * @param {object} dimValues - { rings: [...], tech: [...], date: [...] }
     */
    const createCharts = (enabledDims, dimValues) => {
      destroyCharts();
      chartsWrap.style.display = "";

      // Determine chart type and series grouping
      const xDim = enabledDims[0];       // x-axis dimension
      const seriesDim = enabledDims[1];   // series grouping dimension (if 2+ dims)
      const thirdDim = enabledDims[2];    // third dimension (if 3 dims)

      const xLabels = dimValues[xDim].map(String);
      const seriesValues = seriesDim ? dimValues[seriesDim] : [null];
      const thirdValues = thirdDim ? dimValues[thirdDim] : [null];

      const chartConfigs = [
        { id: "sens-chart-sats", title: "Satellites", unit: "", scale: 1, key: "sats" },
        { id: "sens-chart-flow", title: "Total Flow (achieved)", unit: "Gbps", scale: 1/1000, key: "flow" },
        { id: "sens-chart-earth-flow", title: "Earth flow (min)", unit: "Gbps", scale: 1/1000, key: "earthFlow" },
        { id: "sens-chart-mars-flow", title: "Mars flow (min)", unit: "Gbps", scale: 1/1000, key: "marsFlow" },
        { id: "sens-chart-relay-flow", title: "Relay flow (aggregate)", unit: "Gbps", scale: 1/1000, key: "relayFlow" },
        { id: "sens-chart-earth-sats", title: "Earth ring satellites", unit: "", scale: 1, key: "earthSats" },
        { id: "sens-chart-relay-sats", title: "Relay ring satellites", unit: "", scale: 1, key: "relaySats" },
        { id: "sens-chart-mars-sats", title: "Mars ring satellites", unit: "", scale: 1, key: "marsSats" },
        { id: "sens-chart-cost", title: "Total Cost", unit: "$M", scale: 1/1_000_000, key: "cost" },
        { id: "sens-chart-cpf",  title: "Cost / Flow", unit: "$/Mbps", scale: 1, key: "cpf" },
        // Scatter (metric vs metric — one point per scenario):
        { id: "sens-chart-cost-vs-flow", scatter: true, title: "Flow vs Cost", xKey: "cost", xScale: 1 / 1_000_000, xLabel: "Total Cost ($M)", yKey: "flow", yScale: 1 / 1000, yLabel: "Total Flow (Gbps)" },
        { id: "sens-chart-flow-vs-sats", scatter: true, title: "Flow vs Satellites", xKey: "sats", xScale: 1, xLabel: "Satellites", yKey: "flow", yScale: 1 / 1000, yLabel: "Total Flow (Gbps)" },
        { id: "sens-chart-latency-min", title: "Latency (min)", unit: "min", scale: 1, key: "latMin" },
        { id: "sens-chart-latency-p50", title: "Latency (p50)", unit: "min", scale: 1, key: "latP50" },
      ];

      // Build the per-series labelled, coloured datasets (shared by both types).
      const buildSeriesDatasets = (titleFallback, emptyData) => {
        const ds = [];
        let ci = 0;
        for (const sv of seriesValues) {
          for (const tv of thirdValues) {
            let label = "";
            if (sv != null) label += `${seriesDim === "tech" ? "Tech " : seriesDim === "date" ? "" : "Rings "}${sv}`;
            if (tv != null) label += `${label ? " / " : ""}${thirdDim === "tech" ? "Tech " : thirdDim === "date" ? "" : "Rings "}${tv}`;
            if (!label) label = titleFallback;
            ds.push({
              label,
              data: emptyData(),
              borderColor: palette[ci % palette.length],
              backgroundColor: palette[ci % palette.length].replace("0.8", "0.15"),
              borderWidth: 1.5, pointRadius: 3, tension: 0.2,
              _seriesVal: sv, _thirdVal: tv,
            });
            ci++;
          }
        }
        return ds;
      };

      for (const cfg of chartConfigs) {
        const canvas = document.getElementById(cfg.id);
        if (!canvas) continue;

        // ── Scatter charts: metric-vs-metric, {x,y} points, linear x-axis ──
        if (cfg.scatter) {
          const datasets = buildSeriesDatasets(cfg.title, () => []);
          const fmtAx = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.abs(v) >= 1 ? +v.toFixed(2) : +v.toPrecision(2));
          const chart = new Chart(canvas.getContext("2d"), {
            type: "line",
            data: { datasets },
            options: {
              responsive: true, maintainAspectRatio: false, animation: false,
              interaction: { mode: "nearest", intersect: false },
              layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
              scales: {
                x: { type: "linear", beginAtZero: true, title: { display: true, text: cfg.xLabel, color: textMuted, font: { size: 10 } }, ticks: { color: textDim, font: { size: 9 }, maxTicksLimit: 6 }, grid: { color: gridColor }, border: { color: gridColor } },
                y: { beginAtZero: true, title: { display: true, text: cfg.yLabel, color: textMuted, font: { size: 10 } }, ticks: { color: textDim, font: { size: 9 }, maxTicksLimit: 5 }, grid: { color: gridColor }, border: { display: false } },
              },
              plugins: {
                tooltip: {
                  mode: "nearest", intersect: false,
                  backgroundColor: tooltipBg, titleColor: "#eef1f7", bodyColor: "#b9c0d0",
                  borderColor: "rgba(255,255,255,0.1)", borderWidth: 1, cornerRadius: 4,
                  titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8,
                  callbacks: {
                    title: () => "",
                    label: (ctx) => `${ctx.dataset.label}: ${fmtAx(ctx.parsed.x)} ${cfg.xLabel.match(/\(([^)]+)\)/)?.[1] || ""} → ${fmtAx(ctx.parsed.y)} ${cfg.yLabel.match(/\(([^)]+)\)/)?.[1] || ""}`,
                  },
                },
                legend: { display: datasets.length > 1, labels: { color: textDim, font: { size: 9 }, boxWidth: 10 } },
                title: { display: true, text: cfg.title, color: textMuted, font: { size: 11, weight: "normal" }, padding: { bottom: 4 } },
              },
            },
          });
          chart._scatter = true;
          chart._xKey = cfg.xKey; chart._yKey = cfg.yKey;
          chart._xScale = cfg.xScale; chart._yScale = cfg.yScale;
          chart._seriesDim = seriesDim; chart._thirdDim = thirdDim;
          sensCharts.push(chart);
          continue;
        }

        // Build datasets: one per combination of seriesDim × thirdDim
        const datasets = [];
        let colorIdx = 0;
        for (const sv of seriesValues) {
          for (const tv of thirdValues) {
            let label = "";
            if (sv != null) label += `${seriesDim === "tech" ? "Tech " : seriesDim === "date" ? "" : "Rings "}${sv}`;
            if (tv != null) label += `${label ? " / " : ""}${thirdDim === "tech" ? "Tech " : thirdDim === "date" ? "" : "Rings "}${tv}`;
            if (!label) label = cfg.title;
            datasets.push({
              label,
              data: new Array(xLabels.length).fill(null),
              borderColor: palette[colorIdx % palette.length],
              backgroundColor: palette[colorIdx % palette.length].replace("0.8", "0.15"),
              borderWidth: 1.5,
              pointRadius: 3,
              tension: 0.2,
              _seriesVal: sv,
              _thirdVal: tv,
            });
            colorIdx++;
          }
        }

        const chart = new Chart(canvas.getContext("2d"), {
          type: "line",
          data: { labels: xLabels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            // Hover anywhere along an x to see that x and every series' value.
            interaction: { mode: "index", intersect: false },
            layout: { padding: { top: 4, right: 4, bottom: 0, left: 0 } },
            scales: {
              x: {
                title: { display: true, text: xDim === "rings" ? "Relay rings" : xDim === "tech" ? "Laser tech" : "Date", color: textMuted, font: { size: 10 } },
                ticks: { color: textDim, font: { size: 9 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 12 },
                grid: { display: false },
                border: { color: gridColor },
              },
              y: {
                title: { display: true, text: `${cfg.title} (${cfg.unit})`, color: textMuted, font: { size: 10 } },
                ticks: { color: textDim, font: { size: 9 }, maxTicksLimit: 5 },
                grid: { color: gridColor },
                border: { display: false },
                beginAtZero: true,
              },
            },
            plugins: {
              tooltip: {
                mode: "index",
                intersect: false,
                backgroundColor: tooltipBg, titleColor: "#eef1f7", bodyColor: "#b9c0d0",
                borderColor: "rgba(255,255,255,0.1)", borderWidth: 1, cornerRadius: 4,
                titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8,
                callbacks: {
                  title: (items) => {
                    const xName = xDim === "rings" ? "Relay rings" : xDim === "tech" ? "Laser tech" : "Date";
                    return items.length ? `${xName}: ${items[0].label}` : "";
                  },
                  label: (ctx) => {
                    const v = ctx.parsed.y;
                    if (v == null) return null; // skip series with a gap here
                    const a = Math.abs(v);
                    const num = a >= 1000 ? Math.round(v).toLocaleString() : a >= 1 ? v.toFixed(2) : a > 0 ? v.toPrecision(2) : "0";
                    return `${ctx.dataset.label}: ${num}${cfg.unit ? " " + cfg.unit : ""}`;
                  },
                },
              },
              legend: { display: datasets.length > 1, labels: { color: textDim, font: { size: 9 }, boxWidth: 10 } },
              title: { display: true, text: cfg.title, color: textMuted, font: { size: 11, weight: "normal" }, padding: { bottom: 4 } },
            },
          },
        });
        chart._sensScale = cfg.scale;
        chart._metricKey = cfg.key;
        chart._xDim = xDim;
        chart._seriesDim = seriesDim;
        chart._thirdDim = thirdDim;
        sensCharts.push(chart);
      }
    };

    /**
     * Push one scenario's metrics into every chart, matched by chart._metricKey.
     * @param {object} scenario - { ringCount, laserTechImprovement, launchDate }
     * @param {object} metrics  - { sats, flow, earthFlow, marsFlow, relayFlow,
     *                              cost, cpf, latMin, latP50 } (raw, pre-scale)
     */
    const dimVal = (dim, scenario) =>
      dim === "rings" ? scenario.ringCount : dim === "tech" ? scenario.laserTechImprovement : scenario.launchDate;
    const matchesSeries = (chart, ds, scenario) =>
      (chart._seriesDim == null || String(ds._seriesVal) === String(dimVal(chart._seriesDim, scenario))) &&
      (chart._thirdDim == null || String(ds._thirdVal) === String(dimVal(chart._thirdDim, scenario)));

    const pushChartPoint = (scenario, metrics) => {
      for (const chart of sensCharts) {
        if (!chart) continue;

        // Scatter charts: append an {x,y} point to the matching series.
        if (chart._scatter) {
          const x = metrics[chart._xKey], y = metrics[chart._yKey];
          if (Number.isFinite(x) && Number.isFinite(y)) {
            for (const ds of chart.data.datasets) {
              if (matchesSeries(chart, ds, scenario)) {
                ds.data.push({ x: x * chart._xScale, y: y * chart._yScale });
                break;
              }
            }
          }
          chart.update();
          continue;
        }

        // Category charts: write the metric at the swept-dimension index.
        const xVal = String(dimVal(chart._xDim, scenario));
        const xIdx = chart.data.labels.indexOf(xVal);
        if (xIdx < 0) continue;
        const v = metrics[chart._metricKey];
        for (const ds of chart.data.datasets) {
          if (matchesSeries(chart, ds, scenario)) {
            // Non-finite (cost/flow Infinity at zero flow, latency when no route) → gap.
            ds.data[xIdx] = Number.isFinite(v) ? v * chart._sensScale : null;
            break;
          }
        }
        chart.update();
      }
    };

    // --- Stop flag ---
    let stopRequested = false;

    // --- Run ---
    startBtn.addEventListener("click", async () => {
      stopRequested = false;
      startBtn.disabled = true;
      startBtn.style.display = "none";
      stopBtn.style.display = "";
      progressWrap.style.display = "";
      progressBar.style.width = "0%";
      progressText.textContent = "0%";

      try {
        const ringEnabled = document.getElementById("sens-ring-enable").checked;
        const techEnabled = document.getElementById("sens-tech-enable").checked;
        const dateEnabled = document.getElementById("sens-date-enable").checked;
        // Suppress the reactive updateLoop during the sweep so it doesn't waste the
        // main thread rebuilding/rendering constellations the worker path computes.
        this.simMain._sensitivityRunning = true;
        const ringValues = buildRingValues();
        const techValues = buildTechValues();
        const dateValues = buildDateValues();
        const totalScenarios = ringValues.length * techValues.length * dateValues.length;
        let completed = 0;
        console.log(`[Sensitivity] START: ${totalScenarios} scenarios, rings=[${ringValues}], tech=[${techValues}], dates=[${dateValues}]`);

        // Build chart dimension info
        const enabledDims = [];
        const dimValues = {};
        if (ringEnabled) { enabledDims.push("rings"); dimValues.rings = ringValues.filter(v => v != null); }
        if (techEnabled) { enabledDims.push("tech"); dimValues.tech = techValues.filter(v => v != null); }
        if (dateEnabled) { enabledDims.push("date"); dimValues.date = dateValues; }
        // If no dims enabled, use rings as a single-point x-axis
        if (enabledDims.length === 0) { enabledDims.push("rings"); dimValues.rings = ["(current)"]; }

        // Show fixed (unchecked) dimension values above charts
        const fixedEl = document.getElementById("sens-fixed-dims");
        const fixedParts = [];
        if (!ringEnabled) {
          const cur = this.slidersData.relay_type?.ringcount?.value ?? "?";
          fixedParts.push(`Relay rings: ${cur}`);
        }
        if (!techEnabled) {
          const cur = this.simMain?.simLinkBudget?.techImprovementFactor ?? "?";
          fixedParts.push(`Laser tech: ${cur}x`);
        }
        if (!dateEnabled) {
          const cur = this.simMain?.simTime?.getDate();
          fixedParts.push(`Date: ${cur ? cur.toISOString().slice(0, 10) : "?"}`);
        }
        fixedEl.textContent = fixedParts.length ? `Fixed: ${fixedParts.join(" · ")}` : "";

        createCharts(enabledDims, dimValues);

        // Save current config to restore later
        const baseConfig = this.getGroupsConfig([
          "economics", "simulation", "laser_technology",
          "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_vehicle", "satellite",
        ]);
        // Snapshot the RAW slider element values (internal positions) so we can
        // restore exactly. getGroupsConfig returns user-facing values; writing
        // those back onto a nonlinear range slider (pow10/quadratic) corrupts it —
        // e.g. maxSatCount (pow10) clamps to the slider max → a 10M-cap, 10M-mbps
        // monster constellation whose live flow calc never finishes after a sweep.
        const baseSliderState = [];
        for (const cat of Object.keys(this.sliders)) {
          for (const id of Object.keys(this.sliders[cat])) {
            const input = this.sliders[cat][id];
            if (!input) continue;
            if (input.classList && input.classList.contains("radio-container")) {
              const checked = input.querySelector("input[type=radio]:checked");
              baseSliderState.push({ input, radio: checked ? checked.value : null });
            } else {
              baseSliderState.push({ input, value: input.value });
            }
          }
        }
        const originalSimTime = this.simMain.simTime.getDate();

        const resultArray = [];

        // Post-process a worker scenario result into chart metrics (shared by both
        // the parallel and serial paths). Returns { scenario, metrics }.
        const buildScenarioMetrics = (res, ringCount, techUserVal, dateStr) => {
          const costs = this.simMain.calculateCosts(res.maxFlowGbps, res.resultTreesData || []);
          const capacityInfo = res.capacityInfo;
          const rs = res.routeSummary;
          const ld = res.latencyData;
          const ringMin = (name) => {
            const a = capacityInfo?.ringCapacities?.[name]?.inring;
            return a && a.length ? 2 * minOf(a) : null;
          };
          let earthSats = 0, marsSats = 0, relaySats = 0;
          for (const orbit of res.resultTreesData || []) {
            const rn = orbit.ringName || "";
            const c = orbit.satCount || 0;
            if (rn === "ring_earth") earthSats += c;
            else if (rn === "ring_mars") marsSats += c;
            else relaySats += c;
          }
          const metrics = {
            sats: res.satellitesCount,
            earthSats, relaySats, marsSats,
            flow: (res.maxFlowGbps ?? 0) * 1000,
            earthFlow: ringMin("ring_earth"),
            marsFlow: ringMin("ring_mars"),
            relayFlow: rs?.totalThroughput ?? null,
            cost: costs.totalCosts,
            cpf: costs.costPerMbps,
            latMin: ld?.bestLatency != null ? ld.bestLatency / 60 : null,
            latP50: ld?.medianLatency != null ? ld.medianLatency / 60 : null,
          };
          const scenario = {
            ringCount: ringCount ?? "(current)",
            laserTechImprovement: techUserVal ?? "(current)",
            launchDate: dateStr,
            satellites: res.satellitesCount,
          };
          return { scenario, metrics, costs, capacityInfo, rs };
        };

        // ── Fan scenarios out across a worker pool. This is the only mode —
        //    per-step animation isn't possible while scenarios run in workers. ──
        {
          // Generate every scenario's uiConfig synchronously, in a stable nested
          // order so simLinkBudget (tech) evolves deterministically and the seed
          // requiredmbps values are reproducible. No topology here.
          const allCats = [
            "economics", "simulation", "laser_technology",
            "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_vehicle", "satellite",
          ];
          // Make sure simMain's cost state matches the (unswept) baseline economics
          // so calculateCosts on returned results is consistent for every scenario.
          this.simMain.setCosts(this.getGroupsConfig(["economics"]));
          this.simMain.satellitePowerKw = baseConfig["satellite.satellite-power-kw"];

          const scenarios = [];
          let scenarioId = 0;
          for (const techUserVal of techValues) {
            for (const ringCount of ringValues) {
              if (ringCount != null) this.applySimpleDefaults(ringCount);
              if (techUserVal != null) {
                const techInternal = Math.round(Math.log2(techUserVal));
                this.applySliderValues({ "laser_technology.improvement-factor": techInternal });
              }
              const scenarioConfig = this.getGroupsConfig(allCats);
              scenarioConfig["simulation.calctimeSec"] = 100;
              // Estimate this scenario's peak worker heap from its (seed) satellite
              // count — cheap, no topology. Drives the pool's cumulative memory
              // budget so big constellations don't run so many-wide they overflow
              // the shared V8 heap cage. Over-cap scenarios build nothing (~0).
              const seedCfg = this.simMain.simSatellites.buildConfigFromUi(scenarioConfig);
              const estSats = seedCfg.reduce((sum, c) => sum + (c.satCount || 0), 0);
              const maxSat = scenarioConfig["simulation.maxSatCount"] || Infinity;
              const estMB = estSats > maxSat ? 20 : Math.max(20, estSats * 0.016);
              for (const dateStr of dateValues) {
                scenarios.push({ scenarioId: scenarioId++, ringCount, techUserVal, dateStr, uiConfig: scenarioConfig, estMB });
              }
            }
          }

          const requestedWorkers = parseInt(workerCountInput?.value, 10) || defaultWorkers;
          const pool = new SensitivityPool(requestedWorkers);
          this._sensPool = pool;
          console.log(`[Sensitivity] parallel: ${scenarios.length} scenarios across ${pool.size} workers`);

          // Live progress + worker utilization. onActivity fires as workers pick up
          // and finish jobs, so the readout reflects active threads in real time.
          let activeWorkers = 0;
          let memNote = "";
          const renderProgress = () => {
            const pct = Math.round((completed / totalScenarios) * 100);
            progressBar.style.width = `${pct}%`;
            progressText.textContent = `${pct}% (${completed}/${totalScenarios}) · ${activeWorkers}/${pool.size} workers active${memNote}`;
          };
          pool.onActivity = ({ active, inFlightMB, memBudgetMB }) => {
            activeWorkers = active;
            memNote = ` · ~${inFlightMB}/${memBudgetMB} MB`;
            renderProgress();
          };
          renderProgress();

          try {
            await Promise.all(scenarios.map((s) =>
              pool.submit({
                scenarioId: s.scenarioId,
                uiConfig: s.uiConfig,
                simDate: s.dateStr,
                sizingDate: dateValues[0] || s.dateStr,
                flowCalctimeMs: 20000,
              }, s.estMB).then((res) => {
                if (stopRequested || !res) return;
                const { scenario, metrics, costs, capacityInfo, rs } = buildScenarioMetrics(res, s.ringCount, s.techUserVal, s.dateStr);
                resultArray.push({
                  scenario,
                  liveMetrics: {
                    satellites: res.satellitesCount,
                    costs, metrics,
                    capacityInfo: capacityInfo ? JSON.parse(JSON.stringify(capacityInfo)) : null,
                    routeSummary: rs ? { ...rs } : null,
                  },
                  data: [{ maxFlowGbps: res.maxFlowGbps }],
                });
                pushChartPoint(scenario, metrics);
                completed++;
                renderProgress();
              }).catch((err) => {
                console.error(`[Sensitivity] scenario ${s.scenarioId} failed:`, err);
                completed++;
              })
            ));
          } finally {
            pool.terminate();
            this._sensPool = null;
          }
        }

        // Restore original config from the raw slider snapshot (exact internal
        // positions — never the user-facing baseConfig values, which corrupt
        // nonlinear sliders).
        for (const s of baseSliderState) {
          if (s.radio !== undefined) {
            if (s.radio != null) {
              const radio = s.input.querySelector(`input[type=radio][value="${CSS.escape(String(s.radio))}"]`);
              if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
            }
          } else {
            s.input.value = s.value;
            s.input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        // Restore sim time
        this.simMain.simTime.simMsSinceStart = originalSimTime.getTime() - this.simMain.simTime.initDate.getTime();
        this.simMain.simTime.previousRealMs = performance.now();
        this.simMain.updateLoop();

        // Offer results as a download
        const data = { config: { type: "sensitivity" }, results: resultArray };
        this._lastSensitivityResults = data;
        this._showSensDownload(data);

      } catch (error) {
        console.error("Sensitivity analysis error:", error);
      } finally {
        this.simMain._sensitivityRunning = false;
        startBtn.disabled = false;
        startBtn.style.display = "";
        stopBtn.style.display = "none";
        updateEstimate();
      }
    });

    stopBtn.addEventListener("click", () => {
      stopRequested = true;
      // Drop not-yet-started scenarios from the pool queue (in-flight ones finish).
      if (this._sensPool) this._sensPool.stop();
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
      setTimeout(() => { stopBtn.disabled = false; stopBtn.textContent = "Stop"; }, 0);
    });

    // Download button
    const downloadWrap = document.getElementById("sens-download-wrap");
    const downloadBtn = document.getElementById("sens-download-btn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => {
        if (this._lastSensitivityResults) {
          const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
          this.saveToJson(this._lastSensitivityResults, `marslink-sensitivity-${ts}`);
        }
      });
    }
  }

  _showSensDownload(data) {
    const wrap = document.getElementById("sens-download-wrap");
    if (wrap && data?.results?.length) wrap.style.display = "";
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
    } else if (slider.scale === "quadratic") {
      return Math.round(sliderValue * sliderValue);
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
  /**
   * Draws the colour-scale legends as a bottom-right overlay: one for the
   * Satellites colour mode and one for the Links colour mode. A mode with no
   * scale (Neutral / None) shows nothing.
   */
  updateColorLegend() {
    const host = document.getElementById("info-area");
    if (!host) return;
    let overlay = document.getElementById("color-legend-metrics");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "color-legend-metrics";
      overlay.className = "legend-scale";
      host.appendChild(overlay);
    }
    const lr = this.simMain && this.simMain.simDisplay && this.simMain.simDisplay.lastLinkRange;
    const fmtGbps = (v) => (v == null || !isFinite(v) ? "—" : v >= 1 ? v.toFixed(1) + " Gbps" : (v * 1000).toFixed(0) + " Mbps");
    const thrMax = Math.max(1, Math.round((this.simMain && this.simMain.simDisplay && this.simMain.simDisplay.satThrusterMax) || 1));
    // Thruster count is an integer, so show discrete swatches (one per distinct
    // count in the fleet) on the same log colour scale — not a gradient.
    const thrColor = (v) => {
      const t = thrMax > 1 ? Math.log(v) / Math.log(thrMax) : 0;
      const r = Math.round(255 * Math.min(1, t * 2));
      const g = Math.round(255 * Math.min(1, (1 - t) * 2));
      return `rgb(${r},${g},0)`;
    };
    const thrSpec = (() => {
      let vals = ((this.simMain && this.simMain.simDeployment && this.simMain.simDeployment.thrusterCounts) || [1]).slice();
      if (thrMax <= 1 || !vals.length) vals = [1];
      const CAP = 16; // thin (keeping endpoints) if a fleet spans many distinct counts
      if (vals.length > CAP) {
        const thin = [];
        for (let i = 0; i < CAP; i++) thin.push(vals[Math.round((i * (vals.length - 1)) / (CAP - 1))]);
        vals = [...new Set(thin)];
      }
      return { type: "discrete", title: "Thruster count", items: vals.map((v) => [thrColor(v), String(v)]) };
    })();
    // Laser-terminal count: integer per ring, so discrete swatches on the same scale.
    const laserMax = Math.max(1, Math.round((this.simMain && this.simMain.simDisplay && this.simMain.simDisplay.satLaserMax) || 1));
    const laserColor = (v) => {
      const t = laserMax > 1 ? Math.log(v) / Math.log(laserMax) : 0;
      const r = Math.round(255 * Math.min(1, t * 2));
      const g = Math.round(255 * Math.min(1, (1 - t) * 2));
      return `rgb(${r},${g},0)`;
    };
    const laserSpec = (() => {
      let vals = ((this.simMain && this.simMain.simDisplay && this.simMain.simDisplay.satLaserValues) || [1]).slice();
      if (!vals.length) vals = [1];
      return { type: "discrete", title: "Laser terminals", items: vals.map((v) => [laserColor(v), String(v)]) };
    })();
    const cap = Math.round((this.simMain && this.simMain.simDisplay && this.simMain.simDisplay.skCfg && this.simMain.simDisplay.skCfg.capacity) || 1500);
    // Per-zone satellite tallies for the Orbital-zone legend (only counted when
    // that mode is active, since the fleet can be large).
    const zoneCounts = (() => {
      const c = { INSIDE_EARTH: 0, EARTH_RING: 0, BETWEEN_EARTH_AND_MARS: 0, MARS_RING: 0, OUTSIDE_MARS: 0 };
      const sel = document.querySelector('input[name="display.satellite-colors"]:checked');
      if (!sel || sel.value !== "Zone") return c;
      const ss = this.simMain && this.simMain.simSatellites;
      const sats = ss && ss.getSatellites ? ss.getSatellites() : [];
      for (const s of sats) if (s.orbitalZone in c) c[s.orbitalZone]++;
      return c;
    })();
    const z = (n) => ` (${n.toLocaleString()})`;
    const SAT_LEGENDS = {
      Quad: { type: "discrete", title: "Solar-angle quadrant", items: [["#dd2222", "0–90°"], ["#22dd22", "90–180°"], ["#2222dd", "180–270°"], ["#666666", "270–360°"]] },
      Zone: { type: "discrete", title: "Orbital zone", items: [["#dd2222", "Inside Earth orbit" + z(zoneCounts.INSIDE_EARTH)], ["#0066ff", "Earth orbit" + z(zoneCounts.EARTH_RING)], ["#22dd22", "Between Earth and Mars orbits" + z(zoneCounts.BETWEEN_EARTH_AND_MARS)], ["#ff6600", "Mars orbit" + z(zoneCounts.MARS_RING)], ["#2222dd", "Outside Mars orbit" + z(zoneCounts.OUTSIDE_MARS)]] },
      Suit: { type: "discrete", title: "Suitability", items: [["#22dd22", "Earth & Mars"], ["#2222dd", "Earth only"], ["#dd2222", "Mars only"], ["#333333", "Neither"]] },
      Accel: { type: "gradient", title: "Acceleration", stops: ["#00ff00", "#ffff00", "#ff0000"], low: "1×10⁻⁷ m/s²", high: "1×10⁻³ m/s²" },
      Thrust: { type: "gradient", title: "Thrust required", stops: ["#00ff00", "#ffff00", "#ff0000"], low: "0.1 mN", high: "1000 mN" },
      "Thrust%": { type: "gradient", title: "Thrust used", stops: ["#00ff00", "#ffff00", "#ff0000"], low: "0%", high: "100%", over: ["#ff00ff", ">100% — can't hold station"] },
      Thrusters: thrSpec,
      Lasers: laserSpec,
      SKprop: { type: "gradient", title: "Station-keeping prop", stops: ["#00ff00", "#ffff00", "#ff0000"], low: "1 kg", high: cap + " kg" },
      Totprop: { type: "gradient", title: "Total prop", stops: ["#00ff00", "#ffff00", "#ff0000"], low: "1 kg", high: cap + " kg" },
      Time: { type: "gradient", title: "Time available", stops: ["#ff0000", "#ffff00", "#00ff00"], low: "≤1 yr", high: "≥100 yr" },
      Mass: { type: "gradient", title: "Satellite mass", stops: ["#00ff00", "#ffff00", "#ff0000"], low: "1000 kg", high: "1500 kg" },
    };
    const LINK_LEGENDS = {
      Flow: { type: "gradient", title: "Flow", stops: ["#7799ff", "#ff0000"], low: fmtGbps(lr ? lr.min : null), high: fmtGbps(lr ? lr.max : null) },
      Capacity: { type: "gradient", title: "Capacity", stops: ["#7799ff", "#ff0000"], low: fmtGbps(lr ? lr.min : null), high: fmtGbps(lr ? lr.max : null) },
    };
    const getMode = (name) => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; };
    const buildBoxHTML = (group, spec) => {
      if (!spec) return "";
      let inner = `<div class="metric-header"><span class="metric-label">${group} · ${spec.title}</span></div>`;
      if (spec.type === "gradient") {
        inner += `<div class="legend-gradient" style="background:linear-gradient(to right, ${spec.stops.join(", ")})"></div>`;
        inner += `<div class="detail-row"><span class="detail-label">${spec.low}</span><span class="detail-value">${spec.high}</span></div>`;
        if (spec.over) inner += `<div class="legend-row"><span class="legend-swatch" style="background:${spec.over[0]}"></span><span class="detail-label">${spec.over[1]}</span></div>`;
      } else {
        inner += spec.items.map(([color, label]) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${color}"></span><span class="detail-label">${label}</span></div>`
        ).join("");
      }
      return `<div class="metric-card">${inner}</div>`;
    };
    overlay.innerHTML =
      buildBoxHTML("Satellites", SAT_LEGENDS[getMode("display.satellite-colors")]) +
      buildBoxHTML("Links", LINK_LEGENDS[getMode("display.links-colors")]);
  }

  // Map each relay_type.selected option to its config section key.
  static RELAY_TYPE_SECTIONS = {
    "Adapted concentric": "adapted_rings",
    "Adapted eccentric": "adapted_eccentric_rings",
    "Circular": "circular_rings",
    "Eccentric": "eccentric_rings",
  };

  /** The currently selected relay family (radio value, or the schema default). */
  getSelectedRelayType() {
    const input = this.sliders.relay_type?.selected;
    const checked = input && input.querySelector ? input.querySelector("input[type=radio]:checked") : null;
    return checked ? checked.value : this.slidersData.relay_type?.selected?.value || "Adapted concentric";
  }

  /** The per-family ringcount sliders are superseded by the shared relay_type.ringcount;
   *  hide their rows so the relay ring count is configured in exactly one place. */
  hidePerSectionRingCounts() {
    for (const secKey of Object.values(SimUi.RELAY_TYPE_SECTIONS)) {
      const c = this.sliderContainers[secKey]?.ringcount;
      if (c) c.style.display = "none";
    }
  }

  /** Show only the selected relay family's config section; hide the other three. */
  updateRelaySectionVisibility() {
    const sel = this.getSelectedRelayType();
    for (const [label, sectionKey] of Object.entries(SimUi.RELAY_TYPE_SECTIONS)) {
      const content = document.getElementById("slider-section-content-" + sectionKey);
      const wrapper = content ? content.closest(".slider-section") : null;
      if (wrapper) wrapper.hidden = label !== sel;
    }
  }

  createSliders() {
    const slidersContainer = document.getElementById("sliders-container");
    slidersContainer.innerHTML = "";

    // Section-title overrides where the prettified key isn't the desired label.
    // (adapted_rings predates the eccentric variant; keep its key for back-compat
    // — localStorage, optimizer DOM ids, getGroupsConfig lists — but show the
    // disambiguating "Concentric" name now that "Adapted Eccentric" exists.)
    const SECTION_TITLES = {
      relay_type: "Constellation sizing",
      adapted_rings: "Adapted Concentric rings",
      adapted_eccentric_rings: "Adapted Eccentric rings",
    };

    for (const section in this.slidersData) {
      // Section wrapper (so search filter can hide the whole group when empty)
      const sectionWrapper = document.createElement("div");
      sectionWrapper.className = "slider-section";

      const sectionHeader = document.createElement("h3");
      sectionHeader.className = "slider-section-header";
      const sectionLabel = section.replace(/_/g, " ");
      sectionHeader.textContent = SECTION_TITLES[section] || sectionLabel.charAt(0).toUpperCase() + sectionLabel.slice(1);
      sectionWrapper.appendChild(sectionHeader);

      const sectionContent = document.createElement("div");
      sectionContent.className = "slider-section-content";
      sectionContent.id = "slider-section-content-" + section;
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
          // Raw slider position IS the base-10 exponent; min/max/step come straight
          // from slidersData (fractional step allowed for smooth log control).
          min = slider.min;
          max = slider.max;
          step = slider.step;
        } else if (slider.scale === "quadratic") {
          step = 1;
        }

        const savedValue = localStorage.getItem(fullSliderId);
        let validSavedValue = savedValue;
        if (savedValue !== null) {
          if (slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" || slider.type === "checkbox") {
            if (!slider.options || !slider.options.includes(savedValue)) {
              validSavedValue = null;
            }
          } else {
            const num = parseFloat(savedValue);
            if (isNaN(num)) {
              validSavedValue = null;
            } else if (slider.scale === "pow2" || slider.scale === "signedPow2" || slider.scale === "quadratic") {
              if (!Number.isInteger(num)) {
                validSavedValue = null;
              }
              // Reject stale saved values that exceed the defined max for quadratic
              // (old linear values like 200 would map to 40000 display).
              if (slider.scale === "quadratic" && num > slider.max) {
                validSavedValue = null;
              }
            } else if (slider.scale === "pow10") {
              // Fractional exponents are valid; reject stale out-of-range values
              // (e.g. an old quadratic raw value loaded under the new pow10 scale).
              if (num > slider.max || num < slider.min) {
                validSavedValue = null;
              }
            }
          }
        }
        // If the saved value is outside the original range, extend the slider's
        // effective bounds to accommodate it (values entered via the numeric input).
        if (validSavedValue !== null && slider.type !== "radio" && slider.type !== "checkbox" && slider.type !== "select" && slider.type !== "dropdown") {
          const n = parseFloat(validSavedValue);
          if (!isNaN(n)) {
            if (n < min) min = n;
            if (n > max) max = n;
          }
        }
        let sliderValue =
          validSavedValue !== null
            ? slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" || slider.type === "checkbox"
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
            // Keep each radio + its label together on one line (no internal wrap).
            const optWrap = document.createElement("span");
            optWrap.className = "radio-option";
            optWrap.style.display = "inline-flex";
            optWrap.style.alignItems = "center";
            optWrap.style.whiteSpace = "nowrap";
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = fullSliderId;
            radio.value = option;
            radio.id = `${fullSliderId}-${option}`;
            if (option === sliderValue) radio.checked = true;
            const radioLabel = document.createElement("label");
            radioLabel.setAttribute("for", radio.id);
            radioLabel.textContent = option;
            // Hover tooltip explaining what this option computes.
            const optDesc = slider.optionDescriptions && slider.optionDescriptions[option];
            if (optDesc) {
              radioLabel.title = optDesc;
              radio.title = optDesc;
              optWrap.title = optDesc;
            }
            optWrap.appendChild(radio);
            optWrap.appendChild(radioLabel);
            radioContainer.appendChild(optWrap);

            radio.addEventListener("change", () => {
              if (radio.checked) {
                this.updateValues(fullSliderId, radio.value);
                this.updateColorLegend();
              }
            });
          });
          input = radioContainer;
        } else if (slider.type === "checkbox") {
          // Multi-select: one checkbox per option; value is a comma list of the
          // checked options (empty string = none checked).
          const cbContainer = document.createElement("div");
          cbContainer.className = "radio-container";
          const selected = new Set(String(sliderValue || "").split(",").map((s) => s.trim()).filter(Boolean));
          const emitChange = () => {
            const checked = Array.from(cbContainer.querySelectorAll('input[type="checkbox"]'))
              .filter((cb) => cb.checked)
              .map((cb) => cb.value);
            this.updateValues(fullSliderId, checked.join(","));
          };
          slider.options.forEach((option) => {
            const optWrap = document.createElement("span");
            optWrap.className = "radio-option";
            optWrap.style.display = "inline-flex";
            optWrap.style.alignItems = "center";
            optWrap.style.whiteSpace = "nowrap";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = option;
            cb.id = `${fullSliderId}-${option}`;
            cb.checked = selected.has(option);
            const cbLabel = document.createElement("label");
            cbLabel.setAttribute("for", cb.id);
            cbLabel.textContent = option;
            const optDesc = slider.optionDescriptions && slider.optionDescriptions[option];
            if (optDesc) { cbLabel.title = optDesc; cb.title = optDesc; optWrap.title = optDesc; }
            optWrap.appendChild(cb);
            optWrap.appendChild(cbLabel);
            cbContainer.appendChild(optWrap);
            cb.addEventListener("change", emitChange);
          });
          input = cbContainer;
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
        } else if (slider.type !== "radio" && slider.type !== "checkbox") {
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
          slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" || slider.type === "checkbox"
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

    this._injectBandSolverUI();
  }

  /**
   * Append the "Optimize density" control to the Adapted rings section: a button
   * that runs the band-distribution solver (bandSolver.js) over the 10 density
   * bands to maximize the adapted-ring relay capacity, plus a live progress line
   * and a Stop button. Only added when the adapted-rings section exists.
   */
  _injectBandSolverUI() {
    const host = document.getElementById("slider-section-content-adapted_rings");
    if (!host || host.querySelector("#band-solver-wrap")) return;

    // Equalizer: shown inline (it's a single compact chart now, no need to collapse).
    // The 10 legacy band sliders are unused (the density is anchor-based) but kept
    // hidden in the DOM so any stale references stay valid.
    const firstBand = this.sliderContainers?.adapted_rings?.["band-0-pct"];
    if (firstBand && !document.getElementById("equalizer-group")) {
      const eqLabel = document.createElement("div");
      eqLabel.className = "slider-label";
      eqLabel.style.cssText = "margin-top:var(--s-2); font-weight:600; display:flex; align-items:center; gap:6px;";
      eqLabel.appendChild(this._curvePartCheckboxes("adapted_rings.density-anchors"));
      eqLabel.appendChild(document.createTextNode("Ring density"));
      const eqBody = document.createElement("div");
      eqBody.id = "equalizer-group";
      firstBand.parentNode.insertBefore(eqLabel, firstBand);
      firstBand.parentNode.insertBefore(eqBody, firstBand);
      for (let i = 0; i < 10; i++) {
        const row = this.sliderContainers.adapted_rings[`band-${i}-pct`];
        if (row) { row.style.display = "none"; eqBody.appendChild(row); }
      }
      const chartWrap = document.createElement("div");
      chartWrap.style.cssText = "padding:4px 2px 2px;";
      chartWrap.innerHTML = `<div class="muted" style="font-size:11px;margin:0 2px 3px;">Drag to shape ring density · click to add a point · double-click to remove · right-click to type</div>`;
      eqBody.appendChild(chartWrap);
      this._buildCurveChart(chartWrap, { key: "adapted_rings.density-anchors", defaultY: 50 });
    }

    // Replace the 4 Earth↔Mars blend sliders with the same curve chart: x = ring
    // position (Earth→Mars), y = blend % (0 = Earth value, 50 = natural, 100 = Mars).
    const BLEND_CHARTS = [
      { slider: "earth-mars-raan-pct", key: "adapted_rings.raan-curve", defaultY: 100, label: "Earth↔Mars RAAN" },
      { slider: "earth-mars-argperi-pct", key: "adapted_rings.argperi-curve", defaultY: [{ x: 0, y: 0 }, { x: 1, y: 100 }], label: "Earth↔Mars arg. perigee" },
      { slider: "earth-mars-eccentricity-pct", key: "adapted_rings.eccentricity-curve", defaultY: [{ x: 0, y: 0 }, { x: 1, y: 100 }], label: "Earth↔Mars eccentricity" },
      { slider: "earth-mars-orbit-inclination-pct", key: "adapted_rings.inclination-curve", defaultY: [{ x: 0, y: 0 }, { x: 1, y: 100 }], label: "Earth↔Mars inclination" },
    ];
    for (const bc of BLEND_CHARTS) {
      const row = this.sliderContainers?.adapted_rings?.[bc.slider];
      if (!row || document.getElementById("curvewrap-" + bc.key)) continue;
      const cw = document.createElement("div");
      cw.id = "curvewrap-" + bc.key;
      const lab = document.createElement("div");
      lab.className = "slider-label";
      lab.style.cssText = "margin-top:var(--s-2); font-weight:600; display:flex; align-items:center; gap:6px;";
      lab.appendChild(this._curvePartCheckboxes(bc.key));
      const txt = document.createElement("span");
      txt.innerHTML = `${bc.label} <span class="muted" style="font-weight:400;">· % Mars-ward</span>`;
      lab.appendChild(txt);
      cw.appendChild(lab);
      const chartHost = document.createElement("div");
      chartHost.style.cssText = "padding:2px;";
      cw.appendChild(chartHost);
      row.parentNode.insertBefore(cw, row);
      row.style.display = "none";
      this._buildCurveChart(chartHost, { key: bc.key, defaultY: bc.defaultY });
    }
    // Place the inclination chart directly below RAAN (the two plane orientations
    // belong together), ahead of arg-perigee and eccentricity.
    const raanWrap = document.getElementById("curvewrap-adapted_rings.raan-curve");
    const inclWrap = document.getElementById("curvewrap-adapted_rings.inclination-curve");
    if (raanWrap && inclWrap && raanWrap.parentNode) {
      raanWrap.parentNode.insertBefore(inclWrap, raanWrap.nextSibling);
    }

    const wrap = document.createElement("div");
    wrap.id = "band-solver-wrap";
    wrap.className = "slider-container";
    wrap.style.cssText = "margin-top:8px; padding-top:8px; border-top:1px solid var(--border, #333);";
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    const defThreads = Math.max(1, Math.floor(cores / 2));
    wrap.innerHTML = `
      <div style="display:flex; gap:6px; align-items:center;">
        <button id="band-solver-btn" class="btn btn-primary" type="button" style="flex:1;" title="Search every checked curve (ring density + blends) for the shapes that best meet the capacity/latency goal (uses the worker pool).">⚙ Optimize checked</button>
        <button id="band-solver-stop" class="btn" type="button" style="display:none;">Stop</button>
      </div>
      <div class="muted" style="display:flex; gap:10px; align-items:center; margin-top:6px; font-size:12px; flex-wrap:wrap;">
        <label title="Evaluation budget (more = better search, slower).">evals <input type="number" id="band-solver-evals" value="240" min="20" max="4000" step="20" style="width:60px;"></label>
        <label title="Number of control points the optimizer places on each checked curve (evenly spaced Earth→Mars). More = finer shaping but a larger search; the result is applied as this many anchors.">points <input type="number" id="band-solver-bands" value="10" min="2" max="40" step="1" style="width:48px;"></label>
        <label title="Parallel worker threads. Capped at the logical core count; the renderer needs some headroom, so ~half the cores is a good default.">threads <input type="number" id="band-solver-threads" value="${defThreads}" min="1" max="${cores}" step="1" style="width:48px;">/${cores}</label>
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-top:8px; font-size:12px;">
        <span class="muted" title="Optimize purely for relay capacity.">Capacity</span>
        <input type="range" id="band-solver-alpha" class="slider" min="0" max="100" value="50" step="5" style="flex:1; width:auto;" title="Goal blend: left = maximize capacity, right = minimize latency, middle = range-normalized trade-off between the two.">
        <span class="muted" title="Optimize purely for latency.">Latency</span>
      </div>
      <div class="muted" style="display:flex; gap:10px; align-items:center; margin-top:6px; font-size:12px; flex-wrap:wrap;">
        <label title="How many Earth/Mars geometries each layout is scored at (sampled across years via a low-discrepancy time step). More = more robust, slower.">geoms
          <select id="band-solver-geom" style="width:52px;">
            <option value="1">1</option>
            <option value="4" selected>4</option>
            <option value="16">16</option>
            <option value="64">64</option>
          </select></label>
        <label title="How the per-geometry scores combine. Mean = best lifetime average; Worst = robust to the hardest geometry (e.g. conjunction).">aggregate
          <select id="band-solver-agg" style="width:64px;">
            <option value="mean" selected>Mean</option>
            <option value="worst">Worst</option>
          </select></label>
        <label title="Fast-lane emphasis inside the latency goal: latency = this%·(fastest route) + rest·(traffic-weighted average). 0 = pure average.">fast-lane <input type="number" id="band-solver-fast" value="25" min="0" max="100" step="5" style="width:48px;">%</label>
      </div>
      <label class="muted" style="display:flex; gap:6px; align-items:center; margin-top:6px; font-size:12px;" title="Reject any layout with satellites inside Earth's orbit or outside Mars's — keep the whole relay strictly between the two planet orbits.">
        <input type="checkbox" id="band-solver-keep-between" checked style="margin:0; cursor:pointer; flex:none;">
        Keep all rings between Earth &amp; Mars orbits (no inside-Earth / outside-Mars sats)
      </label>
      <div id="band-solver-progress" class="muted" style="margin-top:6px; font-size:12px; display:none;"></div>`;
    host.appendChild(wrap);

    wrap.querySelector("#band-solver-btn").addEventListener("click", () => this._runBandSolver());
    wrap.querySelector("#band-solver-stop").addEventListener("click", () => { this._bandSolverStop = true; });
  }

  /**
   * Draggable curve editor for the 10 equalizer bands — replaces the 10 sliders with
   * one chart. Each band is a fixed-x control point dragged vertically (0–100); the
   * smooth Hann density curve (the same one the rings are placed to follow) is drawn
   * through them. The 10 band sliders remain in the DOM as the hidden data model: the
   * chart seeds from them and, on drag release, writes back via applySliderValues and
   * rebuilds — so config, presets, the optimizer and persistence are all unchanged.
   */
  /**
   * Reusable anchor-curve editor over a named curve in localStorage/config. Each
   * instance has its own state (closure-local), so the same template drives the
   * density equalizer and the per-`a` Earth↔Mars blend curves (RAAN, arg-perigee,
   * eccentricity, inclination). x ∈ [0,1] = ring position Earth→Mars; y ∈ [0,100].
   * Drag a point (endpoints y-only, middle x+y), click empty to add, double-click to
   * remove, right-click to type. Commits to `key` + rebuilds on release.
   *
   * @param {HTMLElement} host
   * @param {object} o
   * @param {string} o.key       config/localStorage key for the curve's anchors
   * @param {number} o.defaultY  y for the flat 2-anchor default
   */
  _buildCurveChart(host, { key, defaultY = 50 }) {
    const SVGNS = "http://www.w3.org/2000/svg";
    const W = 480, H = 132, padL = 8, padR = 8, padT = 16, padB = 16;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const ds = this.simMain.simSatellites;            // shared densityFromAnchors
    const REBUILD_CATS = [
      "economics", "simulation", "laser_technology",
      "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_vehicle", "satellite",
    ];
    const xOf = (x) => padL + x * plotW;              // curve coord [0,1] → px
    const yOf = (v) => padT + (1 - v / 100) * plotH;  // value [0,100] → px
    const xFromPx = (px) => Math.min(1, Math.max(0, (px - padL) / plotW));
    const valueFromY = (py) => Math.max(0, Math.min(100, (1 - (py - padT) / plotH) * 100));

    let anchors = this._getCurve(key, defaultY); // closure-local state — one per chart
    let dragIdx = null;
    let changed = false;

    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.cssText = "width:100%;height:auto;display:block;touch-action:none;user-select:none;cursor:crosshair;";
    host.style.position = "relative"; // anchor the absolutely-positioned edit field
    host.appendChild(svg);

    const clientToSvg = (cx, cy) => {
      const ctm = svg.getScreenCTM(); if (!ctm) return null;
      const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
      return pt.matrixTransform(ctm.inverse());
    };

    const render = () => {
      const A = anchors, SAMPLES = 80;
      let curve = "";
      for (let k = 0; k <= SAMPLES; k++) {
        const u = k / SAMPLES;
        curve += `${k === 0 ? "M" : "L"} ${xOf(u).toFixed(1)} ${yOf(ds.densityFromAnchors(A, u)).toFixed(1)} `;
      }
      const area = curve + `L ${xOf(1).toFixed(1)} ${yOf(0).toFixed(1)} L ${xOf(0).toFixed(1)} ${yOf(0).toFixed(1)} Z`;
      const pts = A.map((a, i) =>
        `<circle cx="${xOf(a.x).toFixed(1)}" cy="${yOf(a.y).toFixed(1)}" r="${dragIdx === i ? 6 : 4.5}" fill="var(--accent)" stroke="rgba(255,255,255,0.92)" stroke-width="1.5" pointer-events="none"/>` +
        `<text x="${xOf(a.x).toFixed(1)}" y="${(yOf(a.y) - 9).toFixed(1)}" font-size="9" text-anchor="middle" fill="var(--accent)" font-family="ui-monospace,monospace" pointer-events="none">${Math.round(a.y)}</text>`
      ).join("");
      svg.innerHTML =
        `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="var(--accent-dim)" stroke="var(--border-2)" stroke-width="0.6" stroke-dasharray="3 4" rx="2"/>` +
        `<path d="${area}" fill="var(--accent-dim)" stroke="none" pointer-events="none"/>` +
        `<path d="${curve}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" pointer-events="none"/>` +
        `<text x="${padL + 2}" y="${padT + 8}" font-size="8" fill="var(--text-2)" font-family="ui-monospace,monospace" pointer-events="none">100</text>` +
        `<text x="${padL + 2}" y="${padT + plotH - 2}" font-size="8" fill="var(--text-2)" font-family="ui-monospace,monospace" pointer-events="none">0</text>` +
        `<text x="${padL}" y="${H - 3}" font-size="9" fill="var(--text-2)" font-family="ui-monospace,monospace" pointer-events="none">Earth</text>` +
        `<text x="${padL + plotW}" y="${H - 3}" font-size="9" fill="var(--text-2)" text-anchor="end" font-family="ui-monospace,monospace" pointer-events="none">Mars</text>` +
        pts;
    };

    const commit = () => {
      this._setCurve(key, anchors);
      this.simMain.setSatellitesConfig(this.getGroupsConfig(REBUILD_CATS));
    };
    // Throttled live commit so the sim updates in real time during a drag (like the
    // sliders did), not only on release. The heavy satellite/topology rebuild is
    // frame-coalesced by the render loop; this just bounds config-rebuild frequency.
    let lastLive = 0;
    const liveCommit = () => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastLive < 55) return;
      lastLive = now;
      commit();
    };

    // Reset-to-default button (top-right corner of the chart). Restores this curve's
    // anchors to its default (a flat level, or a ramp), redraws and rebuilds.
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = "↺";
    resetBtn.title = "Reset this curve to its default";
    resetBtn.style.cssText =
      "position:absolute; top:1px; right:3px; z-index:2; padding:0 5px; font-size:12px; line-height:16px;" +
      "background:var(--accent-dim); color:var(--text-2); border:1px solid var(--border-2); border-radius:3px; cursor:pointer;";
    resetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      anchors = Array.isArray(defaultY)
        ? defaultY.map((p) => ({ x: p.x, y: p.y }))
        : [{ x: 0, y: defaultY }, { x: 1, y: defaultY }];
      dragIdx = null;
      render();
      commit();
    });
    host.appendChild(resetBtn);

    // Nearest anchor within HIT px of (vx,vy), else -1.
    const HIT = 9;
    const anchorAt = (vx, vy) => {
      for (let i = 0; i < anchors.length; i++) {
        const dx = xOf(anchors[i].x) - vx, dy = yOf(anchors[i].y) - vy;
        if (dx * dx + dy * dy <= HIT * HIT) return i;
      }
      return -1;
    };
    const DBLCLICK_MS = 350;
    let lastDown = null; // { i, t } — for double-click-to-remove

    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = clientToSvg(e.clientX, e.clientY); if (!p) return;
      if (p.x < padL - 2 || p.x > padL + plotW + 2 || p.y < padT - 8 || p.y > padT + plotH + 8) return;
      e.preventDefault();
      const hit = anchorAt(p.x, p.y);
      changed = false;
      if (hit >= 0) {
        const isEnd = hit === 0 || hit === anchors.length - 1;
        const now = Date.now();
        if (!isEnd && lastDown && lastDown.i === hit && now - lastDown.t < DBLCLICK_MS) {
          lastDown = null;                         // double-click → remove this anchor
          anchors = anchors.filter((_, k) => k !== hit);
          dragIdx = null;
          render(); commit();
          return;
        }
        lastDown = { i: hit, t: now };
        dragIdx = hit;                             // grab existing anchor
      } else {
        // empty space → add a new (strictly interior) anchor and grab it
        const na = { x: Math.min(0.999, Math.max(0.001, xFromPx(p.x))), y: valueFromY(p.y) };
        anchors = [...anchors, na].sort((a, b) => a.x - b.x);
        dragIdx = anchors.indexOf(na);
        lastDown = { i: dragIdx, t: Date.now() };
        changed = true;
      }
      try { svg.setPointerCapture(e.pointerId); } catch {}
      render();
    });
    svg.addEventListener("pointermove", (e) => {
      if (dragIdx == null) return;
      const p = clientToSvg(e.clientX, e.clientY); if (!p) return;
      const i = dragIdx, y = valueFromY(p.y);
      if (i === 0 || i === anchors.length - 1) {
        anchors[i] = { x: anchors[i].x, y };       // endpoints fixed in x (anchor the span)
      } else {
        const loX = anchors[i - 1].x + 1e-3, hiX = anchors[i + 1].x - 1e-3; // keep order
        anchors[i] = { x: Math.min(hiX, Math.max(loX, xFromPx(p.x))), y };
      }
      changed = true;
      render();
      liveCommit();              // real-time sim update while dragging
    });
    const end = (e) => {
      if (dragIdx == null) return;
      dragIdx = null;
      try { svg.releasePointerCapture(e.pointerId); } catch {}
      render();
      if (changed) commit();                       // one rebuild per gesture, on release
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);

    // Right-click an anchor → type its exact value into a small field over the point.
    let editorEl = null;
    const closeEditor = () => { if (editorEl) { editorEl.remove(); editorEl = null; } };
    const openEditor = (i) => {
      closeEditor();
      const a = anchors[i]; if (!a) return;
      const ctm = svg.getScreenCTM(); if (!ctm) return;
      const pt = svg.createSVGPoint(); pt.x = xOf(a.x); pt.y = yOf(a.y);
      const s = pt.matrixTransform(ctm);
      const hr = host.getBoundingClientRect();
      const inp = document.createElement("input");
      inp.type = "text"; inp.inputMode = "decimal";
      inp.value = String(Math.round(a.y));
      inp.title = "Enter to save · Esc to cancel";
      inp.style.cssText =
        `position:absolute; width:44px; left:${(s.x - hr.left - 22).toFixed(0)}px; top:${(s.y - hr.top - 30).toFixed(0)}px;` +
        `z-index:10; font-size:11px; text-align:center; padding:2px 3px; border-radius:3px;` +
        `background:var(--bg-elev,#0e1218); color:var(--text-1,#fff); border:1px solid var(--accent);`;
      host.appendChild(inp);
      editorEl = inp;
      inp.focus(); inp.select();
      let done = false;
      const finish = (apply) => {
        if (done) return; done = true;
        inp.removeEventListener("blur", onBlur);
        const v = parseFloat(inp.value);
        closeEditor();
        if (apply && isFinite(v) && anchors[i]) {
          anchors[i] = { x: anchors[i].x, y: Math.max(0, Math.min(100, v)) };
          render(); commit();
        }
      };
      const onBlur = () => finish(true);
      inp.addEventListener("blur", onBlur);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
    };
    svg.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const p = clientToSvg(e.clientX, e.clientY); if (!p) return;
      const i = anchorAt(p.x, p.y);
      if (i >= 0) openEditor(i);
    });

    // Register a refresh so external changes (e.g. the optimizer applying a density
    // result) re-seed this chart from storage and redraw.
    if (!this._curveRefresh) this._curveRefresh = {};
    this._curveRefresh[key] = () => { closeEditor(); anchors = this._getCurve(key, defaultY); dragIdx = null; render(); };
    render();
  }

  /**
   * Run the adapted-ring density optimizer. Builds the current full config, fans
   * candidate band-weight vectors out across a fresh worker pool (objective-only
   * fast path), and applies the best distribution found to the 10 band sliders.
   */
  async _runBandSolver() {
    if (this._bandSolverRunning) return;
    const btn = document.getElementById("band-solver-btn");
    const stopBtn = document.getElementById("band-solver-stop");
    const prog = document.getElementById("band-solver-progress");
    const evalsInput = document.getElementById("band-solver-evals");
    const maxEvals = Math.max(20, Math.min(4000, parseInt(evalsInput?.value, 10) || 240));
    const bandCount = Math.max(2, Math.min(40, parseInt(document.getElementById("band-solver-bands")?.value, 10) || 10));
    const alpha = Math.max(0, Math.min(1, (parseFloat(document.getElementById("band-solver-alpha")?.value) || 0) / 100));
    const wFast = Math.max(0, Math.min(1, (parseFloat(document.getElementById("band-solver-fast")?.value) || 0) / 100));
    const geomCount = Math.max(1, parseInt(document.getElementById("band-solver-geom")?.value, 10) || 1);
    const aggregation = document.getElementById("band-solver-agg")?.value === "worst" ? "worst" : "mean";
    const keepBetween = document.getElementById("band-solver-keep-between")?.checked !== false; // default on

    // The optimizer searches every checked part of every curve at once. Each curve is
    // sampled at bandCount evenly-spaced points; only the indices whose part (left
    // endpoint / middle / right endpoint) is checked are free — the rest stay fixed at
    // the curve's current value. The flat search vector concatenates the free values.
    const ds = this.simMain.simSatellites;
    const denom = Math.max(1, bandCount - 1);
    const segToAnchors = (seg) => seg.map((y, i) => ({ x: i / denom, y }));
    const plan = [];
    for (const c of this._getOptimizeCurves()) {
      const cur = this._getCurve(c.key, c.defaultY);
      const seed = [];
      for (let i = 0; i < bandCount; i++) seed.push(ds.densityFromAnchors(cur, i / denom));
      const free = [];
      for (let i = 0; i < bandCount; i++) {
        const isLeft = i === 0, isRight = i === bandCount - 1;
        if ((isLeft && c.parts.left) || (isRight && c.parts.right) || (!isLeft && !isRight && c.parts.middle)) free.push(i);
      }
      if (free.length) plan.push({ key: c.key, seed, free });
    }
    if (plan.length === 0) {
      prog.style.display = "";
      prog.textContent = "Nothing to optimize — check a part (‘middle’ needs ≥3 points).";
      return;
    }
    let _off = 0;
    for (const p of plan) { p.start = _off; _off += p.free.length; } // offset in the search vector

    this._bandSolverRunning = true;
    this._bandSolverStop = false;
    btn.disabled = true;
    btn.textContent = "Optimizing…";
    stopBtn.style.display = "";
    prog.style.display = "";
    prog.textContent = "Starting…";

    // Full current config; only the 10 band weights vary per candidate.
    const allCats = [
      "economics", "simulation", "laser_technology",
      "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_vehicle", "satellite",
    ];
    const baseConfig = this.getGroupsConfig(allCats);
    // Seed the search vector from the free values of each curve.
    const initialWeights = [];
    for (const p of plan) for (const idx of p.free) initialWeights.push(p.seed[idx]);
    // Reconstruct a curve's full anchor set from the search vector: start from its
    // fixed seed and overwrite only the free indices.
    const anchorsFor = (p, weights) => {
      const full = p.seed.slice();
      p.free.forEach((idx, j) => { full[idx] = weights[p.start + j]; });
      return segToAnchors(full);
    };

    // Geometry samples: score each layout at geomCount Earth/Mars configurations,
    // stepped from the current date by a golden-ratio fraction of the Earth–Mars
    // synodic period — a low-discrepancy, non-resonant spacing that spreads both the
    // relative separation and the absolute orientation across years (so the optimum
    // doesn't overfit a single date). geomCount=1 → just the current date.
    const startMs = (this.simMain?.simTime?.getDate?.() || new Date()).getTime();
    const SYNODIC_DAYS = 779.94, STEP_DAYS = SYNODIC_DAYS * 0.6180339887; // golden ratio
    const dates = [];
    for (let g = 0; g < geomCount; g++) dates.push(new Date(startMs + g * STEP_DAYS * 86400000).toISOString());

    // Constellation size is independent of the band weights, so estimate worker
    // heap once for the memory-admission budget.
    const seedCfg = this.simMain.simSatellites.buildConfigFromUi(baseConfig);
    const estSats = seedCfg.reduce((s, c) => s + (c.satCount || 0), 0);
    const estMB = Math.max(20, estSats * 0.016);

    const requestedWorkers = parseInt(document.getElementById("band-solver-threads")?.value, 10) || 0;
    const pool = new SensitivityPool(requestedWorkers || undefined);
    this._bandSolverPool = pool;

    // Live progress: onProgress (fired between batches, when workers are briefly
    // idle) owns the metrics line; onActivity owns the worker count and renders it
    // live, so the readout reflects threads actually running rather than the
    // momentary lull between batches.
    let active = 0;
    let lastLine = "Starting…";
    const renderProgress = () => { prog.textContent = `${lastLine} · ${active}/${pool.size} workers`; };
    pool.onActivity = ({ active: a }) => { active = a; renderProgress(); };

    let scenarioId = 0;
    const fmtCap = (mbps) => (mbps >= 1000 ? (mbps / 1000).toFixed(2) + " Gbps" : Math.round(mbps) + " Mbps");
    const fmtLat = (s) => (s != null && isFinite(s) ? (s / 60).toFixed(1) + " min" : "—");

    // Evaluate one layout: score it at every geometry, then aggregate.
    // Capacity = relay totalThroughput; latency = wFast·(fastest route) + rest·(avg).
    const evaluate = async (weights) => {
      const cfg = { ...baseConfig };
      // Rebuild each curve from its fixed seed + the free values in the search vector.
      for (const p of plan) cfg[p.key] = anchorsFor(p, weights);
      const per = await Promise.all(dates.map((d) =>
        pool.submit({
          scenarioId: scenarioId++,
          uiConfig: cfg,
          simDate: d,
          sizingDate: d,
          maxIterations: 0,     // relay capacity/latency are independent of planet-ring sizing
          objectiveOnly: true,  // skip max-flow / cost — just the topology + routeSummary
        }, estMB).then((res) => {
          const rs = res && res.routeSummary;
          const zc = (res && res.zoneCounts) || { insideEarth: 0, outsideMars: 0 };
          const viol = (zc.insideEarth || 0) + (zc.outsideMars || 0);
          if (!rs || !(rs.totalThroughput > 0)) return { cap: 0, lat: Infinity, viol };
          const avg = rs.avgLatency, min = rs.minLatency;
          const lat = isFinite(avg) && avg > 0 ? wFast * (isFinite(min) && min > 0 ? min : avg) + (1 - wFast) * avg : Infinity;
          return { cap: rs.totalThroughput, lat, viol };
        })
      ));
      const valid = per.filter(Boolean);
      if (!valid.length) return { capacity: 0, latency: Infinity, violation: 0 };
      const violation = valid.reduce((s, v) => s + (v.viol || 0), 0);
      // Constraint: any satellite inside Earth's orbit or outside Mars's makes the
      // layout infeasible. Penalize so feasible layouts always rank above infeasible
      // ones, with a gradient (fewer offenders = better) to steer the search feasible.
      if (keepBetween && violation > 0) return { capacity: -violation, latency: 1e9 + violation, violation };
      let capacity, latency;
      if (aggregation === "worst") {
        capacity = Math.min(...valid.map((v) => v.cap));
        latency = Math.max(...valid.map((v) => v.lat));
      } else {
        capacity = valid.reduce((s, v) => s + v.cap, 0) / valid.length;
        const lats = valid.map((v) => v.lat).filter(isFinite);
        latency = lats.length ? lats.reduce((s, v) => s + v, 0) / lats.length : Infinity;
      }
      return { capacity, latency, violation };
    };

    const { solveBandDistribution } = await import("./bandSolver.js?v=4.6");
    let result = null;
    try {
      result = await solveBandDistribution({
        initialWeights,
        evaluate,
        shouldStop: () => this._bandSolverStop,
        maxEvals,
        alpha,
        batchSize: Math.max(4, pool.size),
        onProgress: ({ phase, metrics, evals, maxEvals, temperature }) => {
          if (phase === "calibrating") { lastLine = `Calibrating · ${evals}/${maxEvals}`; }
          else {
            const m = metrics || {};
            lastLine = `${evals}/${maxEvals} · best ${fmtCap(m.capacity || 0)} / ${fmtLat(m.latency)} · T=${temperature.toFixed(2)}`;
          }
          renderProgress();
        },
      });
    } catch (err) {
      console.error("[BandSolver] failed:", err);
      prog.textContent = "Failed: " + (err?.message || err);
    } finally {
      pool.terminate();
      this._bandSolverPool = null;
      this._bandSolverRunning = false;
      btn.disabled = false;
      btn.textContent = "⚙ Optimize checked";
      stopBtn.style.display = "none";
    }

    const infeasible = keepBetween && (result?.metrics?.violation || 0) > 0;
    if (result && !infeasible && result.score > result.baselineScore + 1e-9) {
      // Apply each curve's winning shape (fixed seed + optimized free parts) + rebuild.
      for (const p of plan) {
        const anchors = anchorsFor(p, result.weights).map((a) => ({ x: a.x, y: Math.round(a.y * 100) / 100 }));
        this._setCurve(p.key, anchors);
        this._curveRefresh?.[p.key]?.();
      }
      this.simMain.setSatellitesConfig(this.getGroupsConfig(allCats));
      const b = result.baseline || {}, m = result.metrics || {};
      const baseFeasible = b.capacity > 0; // an infeasible (penalized) baseline → no meaningful % gain
      const capGain = baseFeasible ? ((m.capacity - b.capacity) / b.capacity) * 100 : null;
      const latChange = baseFeasible && isFinite(b.latency) && b.latency > 0 && isFinite(m.latency) ? ((m.latency - b.latency) / b.latency) * 100 : null;
      const capStr = capGain != null ? `${fmtCap(m.capacity || 0)} (${capGain >= 0 ? "+" : ""}${capGain.toFixed(1)}%)` : `${fmtCap(m.capacity || 0)} (from infeasible start)`;
      const latStr = latChange != null ? ` · lat ${fmtLat(m.latency)} (${latChange >= 0 ? "+" : ""}${latChange.toFixed(1)}%)` : ` · lat ${fmtLat(m.latency)}`;
      prog.textContent = `Applied · cap ${capStr}${latStr} · ${result.evals} evals.`;
    } else if (infeasible) {
      prog.textContent = `Couldn't keep all rings between the orbits (best layout still had ${result.metrics.violation} inside-Earth/outside-Mars sats) · kept current. Loosen the curves or uncheck the constraint.`;
    } else if (result) {
      prog.textContent = `No improvement after ${result.evals} evals · kept current.`;
    }
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
      // Fractional (not rounded) so the auto-sizer can land on any throughput,
      // not just exact powers of 10. The slider step snaps user drags.
      return Math.log10(userValue);
    } else if (slider.scale === "signedPow2") {
      // Inverse of: 0→0, ±k→±2^(k-1). Continuous (no rounding) so the
      // slider can be dragged smoothly through fractional positions.
      if (userValue === 0) return 0;
      return Math.sign(userValue) * (Math.log2(Math.abs(userValue)) + 1);
    } else if (slider.scale === "quadratic") {
      if (userValue <= 0) return 0;
      return Math.round(Math.sqrt(userValue));
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
      let newValue = slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" || slider.type === "checkbox" ? value : parseFloat(value);

      if (!(slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" || slider.type === "checkbox")) {
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
        case "display.thrust-bodies":
          this.simMain.setThrustBodies(newValue);
          break;
        case "display.planet-orbits":
          this.simMain.setPlanetOrbits(newValue);
          break;
        case "display.plane-nodes":
          this.simMain.setPlaneNodes(newValue);
          break;
        case "display.geostationary-orbits":
          this.simMain.setGeostationaryOrbits(newValue);
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
        case "satellite.satellite-empty-mass":
        case "laser_technology.laser-terminal-mass":
        case "simulation.maxDistanceAU":
        case "simulation.maxSatCount":
        case "simulation.calctimeSec":
        case "simulation.solarExclusionDeg":
        case "simulation.flowAlgorithm":
        case "simulation.linkUpdateIntervalHours":
        case "simulation.failed-satellites-slider":
        case "relay_type.ringcount":
        case "relay_type.selected":
          // Show only the selected relay family's config section, then rebuild (the
          // shared ring count drives whichever family is active).
          this.updateRelaySectionVisibility();
        // falls through to the shared relay rebuild below
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
        case "adapted_rings.trim-rings":
        case "adapted_rings.auto_route_count":
        case "adapted_rings.route_count":
        case "adapted_rings.linear_satcount_increase":
        case "adapted_rings.earth-mars-raan-pct":
        case "adapted_rings.earth-mars-argperi-pct":
        case "adapted_rings.earth-mars-eccentricity-pct":
        case "adapted_rings.earth-mars-orbit-inclination-pct":
        case "adapted_rings.space-by-radius":
        case "adapted_rings.earth-endpoint-anchor":
        case "adapted_rings.mars-endpoint-anchor":
        case "adapted_rings.earth-side-offset-pct":
        case "adapted_rings.mars-side-offset-pct":
        case "adapted_rings.band-0-pct":
        case "adapted_rings.band-1-pct":
        case "adapted_rings.band-2-pct":
        case "adapted_rings.band-3-pct":
        case "adapted_rings.band-4-pct":
        case "adapted_rings.band-5-pct":
        case "adapted_rings.band-6-pct":
        case "adapted_rings.band-7-pct":
        case "adapted_rings.band-8-pct":
        case "adapted_rings.band-9-pct":
        case "eccentric_rings.ringcount":
        case "eccentric_rings.requiredmbpsbetweensats":
        case "eccentric_rings.distance-sun-average-au":
        case "eccentric_rings.eccentricity":
        case "eccentric_rings.argument-of-perihelion":
        case "eccentric_rings.earth-mars-orbit-inclination-pct":
        case "adapted_eccentric_rings.laser-ports-per-satellite":
        case "adapted_eccentric_rings.cross-ring-links":
        case "adapted_eccentric_rings.ringcount":
        case "adapted_eccentric_rings.requiredmbpsbetweensats":
        case "adapted_eccentric_rings.argument-of-perihelion":
        case "adapted_eccentric_rings.earth-side-clearance-x":
        case "adapted_eccentric_rings.mars-side-clearance-x":
        case "adapted_eccentric_rings.earth-mars-orbit-inclination-pct":
          this.simMain.setSatellitesConfig(
            this.getGroupsConfig([
              "economics",
              "simulation",
              "laser_technology",
              "ring_mars",
              "relay_type",
              "circular_rings",
              "eccentric_rings",
              "ring_earth",
              "adapted_rings",
              "adapted_eccentric_rings",
              "launch_vehicle",
              "satellite",
            ])
          );
          break;

        case "relay_type.requiredgbps":
          // Throughput-driven design: size Earth/Mars rings + (concentric) the ring
          // count or (eccentric) the in-ring rate. Those sub-slider writes each trigger
          // the rebuild themselves. Standalone case (not in the fall-through chain above).
          this.applyDesignFromThroughput(newValue);
          break;

        case "economics.satellite-cost-slider":
        case "economics.launch-cost-slider":
        case "economics.laser-terminal-cost-slider":
        case "economics.fuel-cost-ch4o2":
        case "economics.fuel-cost-argon":
        case "economics.wrights-law-factor":
        case "economics.solar-cost-per-kw":
        case "satellite.satellite-empty-mass":
          this.simMain.setCosts(this.getGroupsConfig(["economics"]));
          break;

        default:
          // Launch-vehicle params feed the deployment / cost chain → full recompute.
          if (section === "launch_vehicle" || section === "satellite") {
            this.simMain.setSatellitesConfig(
              this.getGroupsConfig([
                "economics", "simulation", "laser_technology",
                "ring_mars", "relay_type", "circular_rings", "eccentric_rings",
                "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_vehicle", "satellite",
              ])
            );
          }
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
          let configVal = isNaN(num) ? sliderData.value : num;
          // Convert nonlinear slider positions to their user-facing value.
          // (pow2 is intentionally NOT mapped here — its raw exponent is consumed
          // downstream, e.g. setTechnologyConfig does Math.pow(2, ...).)
          if (sliderData.scale === "quadratic") configVal = Math.round(configVal * configVal);
          else if (sliderData.scale === "pow10") configVal = Math.round(Math.pow(10, configVal));
          config[`${categoryKey}.${sliderKey}`] = configVal;
        }
      }
    }
    // The adapted-ring density and the 4 Earth↔Mars blend curves are defined by chart
    // editors (not sliders), so attach them so the worker + ring builder see the same
    // curves. Each value is an anchor array {x∈[0,1], y∈[0,100]}.
    if (categoryKeys.includes("adapted_rings")) {
      for (const [k, dflt] of SimUi.ADAPTED_CURVES) config[k] = this._getCurve(k, dflt);
    }
    // relay_type selects which relay family is built and the shared relay ring count it
    // is built with. Always include both so every build path (initial load, presets,
    // sensitivity sweeps) targets the right family at the right size, even when the
    // caller's category list predates these controls.
    if (this.slidersData.relay_type) {
      config["relay_type.selected"] = this.getSelectedRelayType();
      const rc = this.sliders.relay_type?.ringcount?.value;
      config["relay_type.ringcount"] = rc !== undefined ? parseFloat(rc) : this.slidersData.relay_type.ringcount.value;
    }
    return config;
  }

  /** Read a named anchor curve {x∈[0,1], y∈[0,100]} (live model → storage → flat
   *  2-anchor default at `defaultY`). Always returns a fresh, sorted, ≥2-anchor array. */
  _getCurve(key, dflt = 50) {
    let a = this._curves && Array.isArray(this._curves[key]) ? this._curves[key] : null;
    if (!a) {
      try { const s = JSON.parse(localStorage.getItem(key)); if (Array.isArray(s)) a = s; } catch {}
    }
    // `dflt` is either a flat level (number) or a full anchor array (e.g. a ramp).
    if (!a || a.length < 2) a = Array.isArray(dflt) ? dflt : [{ x: 0, y: dflt }, { x: 1, y: dflt }];
    return a
      .map((p) => ({ x: Math.min(1, Math.max(0, +p.x || 0)), y: Math.min(100, Math.max(0, +p.y || 0)) }))
      .sort((p, q) => p.x - q.x);
  }

  /** Persist a named anchor curve (live model + localStorage). */
  _setCurve(key, anchors) {
    const clean = anchors
      .map((p) => ({ x: Math.min(1, Math.max(0, +p.x || 0)), y: Math.min(100, Math.max(0, +p.y || 0)) }))
      .sort((p, q) => p.x - q.x);
    if (!this._curves) this._curves = {};
    this._curves[key] = clean;
    try { localStorage.setItem(key, JSON.stringify(clean)); } catch {}
    return clean;
  }

  // Density equalizer + per-`a` Earth↔Mars blend curves with their defaults. RAAN
  // defaults flat at 100% (full Mars); inclination / arg-perigee / eccentricity
  // default to a 0→100 ramp (Earth value at the Earth side, Mars value at the Mars
  // side). A default may be a flat level (number) or a full anchor array.
  static get ADAPTED_CURVES() {
    const RAMP = [{ x: 0, y: 0 }, { x: 1, y: 100 }];
    return [
      ["adapted_rings.density-anchors", 50],
      ["adapted_rings.raan-curve", 100],
      ["adapted_rings.argperi-curve", RAMP],
      ["adapted_rings.eccentricity-curve", RAMP],
      ["adapted_rings.inclination-curve", RAMP],
    ];
  }

  // Density-anchor compatibility shims (the optimizer + distribution card use these).
  _getDensityAnchors() { return this._getCurve("adapted_rings.density-anchors", 50); }
  _setDensityAnchors(anchors) { return this._setCurve("adapted_rings.density-anchors", anchors); }
  _refreshEqualizerChart() { this._curveRefresh?.["adapted_rings.density-anchors"]?.(); }

  /** Per-curve optimizer parts {left, middle, right} — which portions of the curve
   *  the optimizer may vary. Lazily seeded (default: density all three on) + persisted. */
  _curveParts(key) {
    if (!this._optimizeParts) {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem("adapted_rings.optimize-parts")); } catch {}
      this._optimizeParts = stored && typeof stored === "object" && !Array.isArray(stored)
        ? stored
        : { "adapted_rings.density-anchors": { left: true, middle: true, right: true } };
    }
    if (!this._optimizeParts[key]) this._optimizeParts[key] = { left: false, middle: false, right: false };
    return this._optimizeParts[key];
  }
  _saveOptimizeParts() { try { localStorage.setItem("adapted_rings.optimize-parts", JSON.stringify(this._optimizeParts)); } catch {} }

  /** Three checkboxes — left endpoint / middle / right endpoint — gating which parts
   *  of a curve the optimizer is allowed to move. */
  _curvePartCheckboxes(key) {
    const parts = this._curveParts(key);
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex; gap:3px; flex:none;";
    const defs = [
      ["left", "Optimize the Earth-side endpoint (left)"],
      ["middle", "Optimize the middle of the curve"],
      ["right", "Optimize the Mars-side endpoint (right)"],
    ];
    for (const [part, title] of defs) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!parts[part];
      cb.title = title;
      cb.style.cssText = "margin:0; cursor:pointer;";
      cb.addEventListener("change", () => { parts[part] = cb.checked; this._saveOptimizeParts(); });
      wrap.appendChild(cb);
    }
    return wrap;
  }

  /** Curves with at least one part enabled, as {key, defaultY, parts}. */
  _getOptimizeCurves() {
    return SimUi.ADAPTED_CURVES
      .map(([key, defaultY]) => ({ key, defaultY, parts: this._curveParts(key) }))
      .filter((c) => c.parts.left || c.parts.middle || c.parts.right);
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
    const sections = ["satellites", "capacity", "ringdetail", "flow", "cost", "latency"];

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
