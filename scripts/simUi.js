// simUi.js
import { slidersData } from "./slidersData.js?v=4.40";
import { LukashianClock } from "./lukashianTime.js?v=4.40";
import { wireAuthUi } from "./auth.js?v=4.40";
import { SensitivityPool } from "./sensitivityPool.js?v=4.40";
import { ensureState as ensureSimWorkerState, runScenario as runScenarioInProcess } from "./simWorker.js?v=4.40";
import { minOf } from "./simMath.js?v=4.40";
import { EARTH_MARS_CLOSEST_APPROACH_DEG } from "./simOrbits.js?v=4.40";

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
    const referenceLines = this.slidersData.display["reference-lines"].value;
    this.simMain.setReferenceLines(referenceLines);
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
    const archivePane = document.getElementById("archive-pane");
    const reportPanel = document.getElementById("report-panel");

    const setActiveButtons = (mode) => {
      // Only the mode tabs — NOT the .kbd-toggle link-label buttons, which also carry
      // data-mode (mbps/latency) and are managed separately by setupLinkLabelToggles.
      document.querySelectorAll(".mode-tab[data-mode]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
      });
    };

    const closeDrawer = () => {
      modeDrawer.hidden = true;
      modeDrawer.setAttribute("aria-hidden", "true");
      simplePane.hidden = true;
      configurePane.hidden = true;
      sensitivityPane.hidden = true;
      if (archivePane) archivePane.hidden = true;
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

      if (mode === "simple" || mode === "configure" || mode === "sensitivity" || mode === "archive") {
        closeReportPanel();
        modeDrawer.hidden = false;
        modeDrawer.setAttribute("aria-hidden", "false");
        simplePane.hidden = mode !== "simple";
        configurePane.hidden = mode !== "configure";
        sensitivityPane.hidden = mode !== "sensitivity";
        if (mode === "sensitivity") this._updateSensRouteGrey();
        if (archivePane) archivePane.hidden = mode !== "archive";
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

    document.querySelectorAll(".mode-tab[data-mode]").forEach((btn) => {
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

    // Time acceleration slider — signedPow2 scale (continuous, step 0.1)
    const timeData = this.slidersData.simulation["time-acceleration-slider"];
    const timeRow = makeSliderRow("Time acceleration",
      { min: timeData.min, max: timeData.max, step: 0.1, unit: "x", value: timeData.value },
      "simple-time",
      (val) => { this.applySliderValues({ "simulation.time-acceleration-slider": val }); },
      { toDisplay: signedPow2, toInternal: signedPow2Inv }
    );

    const currentRingCount = () => parseFloat(this.sliders.relay_type?.ringcount?.value ?? ringData.value);

    // Laser tech improvement slider — pow2 scale. Changing the laser tech rescales
    // per-link capacity, so the relay aggregate capacity shifts; the Earth/Mars auto-size
    // re-tracks the new relay capacity on the next build (when set to 'auto').
    const techRow = makeSliderRow("Laser tech improvement",
      { min: techData.min, max: techData.max, step: 1, unit: "x", value: techData.value },
      "simple-techfactor",
      (val) => {
        this.applySliderValues({ "laser_technology.improvement-factor": val });
      },
      { toDisplay: (v) => Math.pow(2, v), toInternal: (v) => Math.round(Math.log2(v)) }
    );

    // Relay ring count — the single main design input. Setting it rebuilds the relay
    // (which recomputes the relay capacity); the Earth/Mars auto-size then sizes each
    // planet ring's worst-case in-ring rate to half that capacity on the next build.
    // Editable for every family (concentric and eccentric alike).
    const ringRow = makeSliderRow("Relay ring count", ringData, "simple-ringcount", (val) => {
      this.applySliderValues({ "relay_type.ringcount": val });
    });

    // Relay-type selector (above the ring-count row). Switching family updates section
    // visibility + the active builder, then re-applies that family's structural defaults
    // and re-sizes Earth/Mars against the new relay capacity.
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
        this.applySimpleDefaults(currentRingCount(), { startFeedback: this._planetSizingMode() !== "off" });
      });
      header.appendChild(lbl);
      header.appendChild(sel);
      wrap.appendChild(header);
      return { wrap, sel };
    })();

    // (Earth/Mars auto-size lives in the Advanced panel only — removed from Simple.)

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

    // Keep the simple selectors synced when they change in the advanced panel.
    const advRelay = this.sliders.relay_type?.selected;
    if (advRelay) {
      advRelay.addEventListener("change", () => {
        const checked = advRelay.querySelector("input[type=radio]:checked");
        if (checked) relayRow.sel.value = checked.value;
      });
    }
    // Laser tech is a deprioritized scalar — append it LAST.
    container.appendChild(timeRow.wrap);
    container.appendChild(relayRow.wrap);
    container.appendChild(ringRow.wrap);
    container.appendChild(techRow.wrap);

    // Initialize: ring count is the input. Apply the active family's structural defaults
    // + the current ring count and seed Earth/Mars; the first links-ready then sizes the
    // planet rings to half the live relay capacity (per the Earth/Mars auto-size mode).
    const R0 = parseFloat(this.sliders.relay_type?.ringcount?.value ?? ringData.value);
    try {
      this.applySimpleDefaults(R0, { startFeedback: this._planetSizingMode() !== "off" });
    } catch (err) {
      console.error("[Marslink] ring-count-driven init failed:", err);
      this.applySimpleDefaults(R0);
    }
  }

  /** True when the given relay-section key is one of the eccentric families. */
  _isEccentricSection(selKey) {
    return selKey === "eccentric_rings" || selKey === "adapted_eccentric_rings";
  }

  /**
   * Earth/Mars auto-size mode — read live from the "Earth/Mars auto-size" selector:
   * "off" | "auto". Defaults to "auto" if the control is missing.
   */
  _planetSizingMode() {
    const container = this.sliders.relay_type?.planet_sizing;
    const checked = container && container.querySelector ? container.querySelector("input[type=radio]:checked") : null;
    return checked ? checked.value : this.slidersData.relay_type?.planet_sizing?.value || "auto";
  }

  /**
   * Earth/Mars auto-size — called by simMain on every links-ready, but only acts once per
   * design change (when ARMED) and only in 'auto'. Plugs HALF the live RELAY-INTRINSIC
   * capacity (routeSummary.relayOnlyThroughput — each route's bottleneck over relay-chain
   * hops only, planet-ring gateway hops excluded, so the sizing input cannot depend on the
   * previous planet-ring size) into each planet ring's worst-case in-ring rate
   * (ring_earth/ring_mars.requiredmbpsbetweensats). A planet injects at one gateway and its
   * ring carries the traffic two ways, so half the relay capacity per side sizes the ring to
   * deliver the full relay capacity. 'off' leaves the rings to the user.
   * This is a single direct write, NOT a goal-seek. Two things keep it from looping: (1) the
   * armed flag — the auto-write doesn't re-arm, so it can't chase the geometry-driven relay
   * drift while time runs; (2) a step-resolution idempotency guard — a range <input> snaps a
   * written value to its step, so comparing raw values would rewrite every frame.
   */
  runPlanetSizingStep() {
    // 'auto' only, and only when ARMED by a design change (ring count / tech / relay type /
    // switching to auto). The auto-write below does NOT re-arm, so it can't loop. Without
    // this gate, sizing on every links-ready chases the geometry-driven relay drift while
    // time runs (each write re-dirties the window, the clock advances, the relay shifts).
    if (this._planetSizingMode() !== "auto" || !this._planetSizeArmed) return;

    const rs = this.simMain?.routeSummary;
    if (!rs || !(rs.totalThroughput > 0)) return; // capacity not ready → stay armed, retry next
    this._planetSizeArmed = false;                // consume the arm: one re-size per design change
    // Relay-intrinsic capacity (planet hops excluded): sizing from the end-to-end number
    // fed the previous planet-ring size back into the next sizing — the satCount
    // "hysteresis" at fixed ring count. Fallback covers stale worker payloads.
    this._writePlanetSizing(rs.relayOnlyThroughput ?? rs.totalThroughput);
  }

  /**
   * Size both planet rings' worst-case in-ring rate from a relay capacity (Mbps):
   * each planet ring carries half (a planet injects at one gateway, two paths), so the
   * target is relayMbps/2, rounded UP to the next slider step. Shared by the auto-sizer
   * (runPlanetSizingStep, with the live relay capacity) and the optimized sweep (with the
   * optimizer's converged capacity). Pure write — the caller owns the arm/selector gating.
   * Returns true if it changed the sliders, false if they already matched (idempotent).
   */
  _writePlanetSizing(relayMbps) {
    const planetMbps = Math.max(1, relayMbps / 2); // relay capacity ÷ 2 (two paths per planet)
    const eSd = this.slidersData.ring_earth.requiredmbpsbetweensats;
    const mSd = this.slidersData.ring_mars.requiredmbpsbetweensats;
    // Round UP to the next slider step (these are log10 axes, so the rungs are ~12%
    // apart). Rounding to nearest could land a rung BELOW half-capacity, making 2× the
    // in-ring rate < relay capacity — the planet ring would bottleneck the relay. Ceiling
    // guarantees 2 × (worst-case in-ring rate) ≥ relay capacity. The 1e-9 epsilon keeps a
    // value already sitting on a step from being bumped up an extra rung by float noise.
    const ceilToStep = (sd, mbps) => {
      const step = parseFloat(sd.step) || 1;
      const min = sd.min ?? 0;
      const raw = this.mapUserFacingToSliderValue(sd, mbps);
      return min + Math.ceil((raw - min) / step - 1e-9) * step;
    };
    const eInt = ceilToStep(eSd, planetMbps);
    const mInt = ceilToStep(mSd, planetMbps);
    const eCur = parseFloat(this.sliders.ring_earth?.requiredmbpsbetweensats?.value);
    const mCur = parseFloat(this.sliders.ring_mars?.requiredmbpsbetweensats?.value);

    // Skip when the computed value lands on the step the slider already holds. Comparing at
    // step resolution (not raw value) is what stops the per-frame rebuild loop.
    const stepIdx = (sd, v) => Math.round((v - (sd.min ?? 0)) / (parseFloat(sd.step) || 1));
    if (stepIdx(eSd, eInt) === stepIdx(eSd, eCur) && stepIdx(mSd, mInt) === stepIdx(mSd, mCur)) return false;

    this.applySliderValues({
      "ring_earth.requiredmbpsbetweensats": eInt,
      "ring_mars.requiredmbpsbetweensats": mInt,
    });
    return true;
  }

  /**
   * The ceil-snapped USER-FACING worst-case in-ring rate (Mbps) a planet ring should use
   * for a given relay capacity — same ½-capacity + round-up rule as _writePlanetSizing, but
   * pure (no slider writes). Used to keep a previewed layout's Earth/Mars rings consistent
   * with the solution being shown. Both planet rings share one slider config.
   */
  _planetRingMbps(relayMbps) {
    const sd = this.slidersData.ring_earth.requiredmbpsbetweensats;
    const planetMbps = Math.max(1, relayMbps / 2);
    const step = parseFloat(sd.step) || 1, min = sd.min ?? 0;
    const raw = this.mapUserFacingToSliderValue(sd, planetMbps);
    const internal = min + Math.ceil((raw - min) / step - 1e-9) * step;
    return this.mapSliderValueToUserFacing(sd, internal);
  }

  /**
   * Aggregate Earth↔Mars relay throughput (Mbps) the active family delivers at a
   * given ring count, from its own routing model:
   *   • concentric (adapted / circular): radial spokes — routeCount parallel routes,
   *     each ≈ one inter-ring link → routeCount · perRouteMbps  (∝ ringCount³)
   *   • eccentric (adapted-eccentric / eccentric): each ring is one azimuthal loop
   *     carrying both arcs → 2 · ringCount · (worst-case in-ring rate)
   * Used only to seed the Earth/Mars rings before the live relay capacity is known.
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
   * Metadata for the sensitivity panel's SECOND sweep axis, which adapts to the
   * active relay family:
   *   • Contoured concentric → "Route count"  (adapted_rings.route_count)
   *   • Contoured eccentric  → "Throughput in ring (worst case)"
   *                          (adapted_eccentric_rings.requiredmbpsbetweensats)
   * Other families have no swept second parameter (axis greyed).
   */
  _sensSecondAxis() {
    const t = this.getSelectedRelayType?.();
    if (t === "Contoured eccentric") {
      return {
        kind: "throughput",
        applyKey: "adapted_eccentric_rings.requiredmbpsbetweensats",
        label: "Throughput in ring (worst case)",
        prefix: "Mbps ",
        unit: "Mbps",
      };
    }
    return {
      kind: "routes",
      applyKey: "adapted_rings.route_count",
      label: "Route count",
      prefix: "Routes ",
      unit: "routes",
    };
  }

  /** Is the sensitivity second-axis a no-op? Route count (concentric) is only directly
   *  settable when Auto Route Count = no; the eccentric throughput is always settable;
   *  every other family leaves this axis inert. */
  _sensRouteGreyed() {
    const t = this.getSelectedRelayType?.();
    if (t === "Contoured eccentric") return false;
    if (t === "Contoured concentric") {
      const auto = this.slidersData.adapted_rings?.auto_route_count?.value || "yes";
      return auto !== "no";
    }
    return true;
  }

  /** Relabel + grey (disable + dim) the sensitivity second-axis block to match the
   *  active relay family. */
  _updateSensRouteGrey() {
    const grp = document.getElementById("sens-route-group");
    if (!grp) return;
    const ax = this._sensSecondAxis();
    const labelEl = document.getElementById("sens-route-label");
    const unitEl = document.getElementById("sens-route-unit");
    if (labelEl) labelEl.textContent = ax.label;
    if (unitEl) unitEl.textContent = ax.unit;
    const greyed = this._sensRouteGreyed();
    grp.style.opacity = greyed ? "0.4" : "";
    grp.style.pointerEvents = greyed ? "none" : "";
    const cb = document.getElementById("sens-route-enable");
    if (cb) cb.disabled = greyed;
    const note = document.getElementById("sens-route-note");
    if (note) note.textContent = !greyed ? ""
      : this.getSelectedRelayType?.() === "Contoured concentric"
        ? "Route count is auto-derived — set Auto Route Count to ‘no’ (manual) in the concentric section to sweep it."
        : "This axis applies to the Contoured concentric (route count) and Contoured eccentric (in-ring throughput) families.";
  }

  applySimpleDefaults(ringCount, options = {}) {
    const selKey = SimUi.RELAY_TYPE_SECTIONS[this.getSelectedRelayType()] || "adapted_rings";

    // Seed the Earth/Mars in-ring worst-case rate at half the analytic relay capacity
    // (a planet injects at one gateway → its ring carries half). This is only a starting
    // estimate; runPlanetSizingStep refines it to half the LIVE relay capacity (the
    // Capacity card number) on the next links-ready, per the Earth/Mars auto-size mode.
    const targetMbps = this._relayThroughputMbps(ringCount, selKey);
    const planetMbps = Math.max(1, targetMbps / 2);
    const earthMbps = planetMbps;
    const marsMbps = planetMbps;

    // The Simple "Relay ring count" is the single shared relay_type.ringcount, used by
    // whichever family is active (selKey, from the seed block above).
    this.applySliderValues({
      "relay_type.ringcount": ringCount,
      // Adapted-concentric tuning (only consumed when that family is the active one).
      "adapted_rings.auto_route_count": "yes",
      "adapted_rings.extra-terminals": 1,
      "adapted_rings.satcount-density-routes": 100,
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
    // The Earth/Mars rings are seeded analytically above; on the next links-ready the
    // 'auto' sizer refines them to half the live relay capacity (idempotent, no-op for 'off').
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
    // Route-count sweep. Disabled unless the concentric family is active with Auto Route
    // Count = no (manual) — otherwise the route count is auto-derived from ring count.
    const buildRouteValues = () => {
      const cb = document.getElementById("sens-route-enable");
      if (!cb || !cb.checked || this._sensRouteGreyed()) return [null];
      const s = parseInt(document.getElementById("sens-route-start").value);
      const e = parseInt(document.getElementById("sens-route-end").value);
      const step = parseInt(document.getElementById("sens-route-step").value) || 1;
      const vals = [];
      for (let r = s; r <= e; r += step) vals.push(r);
      return vals.length ? vals : [null];
    };
    // Write a swept slider value WITHOUT the interactive slider's max clamping it. The
    // sweep legitimately explores values beyond the manual range (e.g. multi-Gbps in-ring
    // rates above the 999 Mbps slider max), but range inputs clamp .value to their `max`
    // attribute — so lift `max` first. Originals are restored when the run finishes
    // (this._sensWidenedMaxes, drained in the restore/finally block).
    const setSweptSlider = (fullId, v) => {
      const [sec, id] = fullId.split(".");
      const input = this.sliders[sec]?.[id];
      if (input && input.max !== "" && Number.isFinite(+input.max) && +v > +input.max) {
        if (!this._sensWidenedMaxes) this._sensWidenedMaxes = new Map();
        if (!this._sensWidenedMaxes.has(input)) this._sensWidenedMaxes.set(input, input.max);
        input.max = String(v);
      }
      this.applySliderValues({ [fullId]: v });
    };
    // The second sweep axis means route count (concentric) or in-ring worst-case
    // throughput (eccentric) — see _sensSecondAxis. The two families need the value
    // applied at different points relative to applySimpleDefaults:
    //   • throughput: BEFORE — applySimpleDefaults seeds the Earth/Mars rings from the
    //     relay capacity, which for eccentric is derived from this in-ring rate.
    //   • route count: AFTER — applySimpleDefaults forces auto_route_count = yes, so we
    //     re-set it to manual and write the count.
    const applySecondAxisPre = (v) => {
      if (v == null) return;
      const ax = this._sensSecondAxis();
      if (ax.kind === "throughput") setSweptSlider(ax.applyKey, v);
    };
    const applySecondAxisPost = (v) => {
      if (v == null) return;
      const ax = this._sensSecondAxis();
      if (ax.kind === "routes") {
        this.applySliderValues({ "adapted_rings.auto_route_count": "no" });
        setSweptSlider("adapted_rings.route_count", v);
      }
    };
    const currentDateIso = () => {
      const d = this.simMain?.simTime?.getDate?.();
      return d ? d.toISOString() : new Date(Date.UTC(2030, 0, 1)).toISOString();
    };

    // Planet-placement axis. "current" = a single scenario at the current sim date (real
    // ephemeris). "geometry-4/16" = geometry samples (shared with the optimizer via
    // _buildGeometries): the relay sats stay at FIXED_GEOM_DATE and each sample passes
    // angle offsets measured from the Earth–Mars closest-approach reference (worker-side).
    const FIXED_GEOM_DATE = new Date(Date.UTC(2000, 0, 1)).toISOString();
    const geomModeVal = () => document.getElementById("sens-geom-mode")?.value || "current";
    const buildPlacements = () => {
      if (geomModeVal() === "current") {
        const iso = currentDateIso();
        return [{ label: iso.slice(0, 10), simDate: iso, earthAngleOffset: null, marsAngleOffset: null }];
      }
      const count = geomModeVal() === "geometry-16" ? 16 : 4;
      return this._buildGeometries(count).map((g) => ({
        label: `E${g.earthOffset}/M${g.marsOffset}`,
        simDate: FIXED_GEOM_DATE,
        earthAngleOffset: g.earthOffset,
        marsAngleOffset: g.marsOffset,
      }));
    };
    // The placement dimension is a real swept axis only in the geometry modes (>1 sample);
    // "current" is a single fixed point. Drives chart dims + the "Fixed:" label.
    const placementIsDim = () => geomModeVal() !== "current";
    // Per-scenario max-flow time budget (ms), from the panel field. Scenarios whose solve
    // exceeds it are reported as flow gaps (not 0). Separate from the live view's
    // "Allowed flow calc time" (simulation.calctimeSec). 0 = no limit (run the solve to
    // completion, like the live sim — may take very long / never finish; pair with Main
    // thread). Defaults to 20 s if the field is blank/invalid.
    const flowBudgetMs = () => {
      const v = parseFloat(document.getElementById("sens-flow-budget")?.value);
      if (v === 0) return Infinity; // no timeout — grind to completion
      return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : 20000;
    };
    let placementAxisLabel = "Date"; // set per run; "Geometry" in geometry modes
    // The second sweep axis's display metadata (route count vs in-ring throughput),
    // captured at run start; used for chart labels/titles. See _sensSecondAxis.
    let secondAxisMeta = this._sensSecondAxis();

    // --- Estimate display (iteration count + time) ---
    const updateEstimate = () => {
      const total = buildRingValues().length * buildTechValues().length * buildRouteValues().length * buildPlacements().length;
      const optimized = (this._sensMode || "simple") === "optimized";
      const wt = this.simMain?.lastWorkerTimings;
      const perIterMs = wt?.totalMs || wt?.links || 0;
      let timeStr = "";
      if (optimized) {
        // Each scenario runs a full optimization (its own worker pool); per-scenario time
        // is dominated by the optimizer's eval count, not a single sim — don't pretend.
        timeStr = " · optimizes each, runs serially (slow)";
      } else if (perIterMs > 0) {
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

    // --- Simple / Optimized sub-mode toggle ---
    this._sensMode = this._sensMode || "simple";
    const optControls = document.getElementById("sens-opt-controls");
    const workerGroup = document.getElementById("sens-worker-group");
    const modeBtns = [...document.querySelectorAll(".sens-mode-btn")];
    const syncMode = () => {
      const optimized = this._sensMode === "optimized";
      for (const b of modeBtns) b.classList.toggle("active", b.dataset.mode === this._sensMode);
      if (optControls) optControls.style.display = optimized ? "" : "none";
      if (workerGroup) workerGroup.style.display = optimized ? "none" : "";
      if (startBtn) startBtn.textContent = optimized ? "Run Optimized Sweep" : "Run Sensitivity";
      updateEstimate();
    };
    for (const b of modeBtns) b.addEventListener("click", () => { this._sensMode = b.dataset.mode; syncMode(); });

    // --- Execution location toggle (Simple mode): Worker pool vs Main thread ---
    this._sensExec = this._sensExec || "worker";
    const execBtns = [...document.querySelectorAll(".sens-exec-btn")];
    const workerCountRow = document.getElementById("sens-worker-count-row");
    const mainOpts = document.getElementById("sens-main-opts");
    const syncExec = () => {
      const main = this._sensExec === "main";
      for (const b of execBtns) b.classList.toggle("active", b.dataset.exec === this._sensExec);
      if (workerCountRow) workerCountRow.style.display = main ? "none" : "";
      if (mainOpts) mainOpts.style.display = main ? "" : "none";
    };
    for (const b of execBtns) b.addEventListener("click", () => { this._sensExec = b.dataset.exec; syncExec(); });
    syncExec();

    // --- Geometry explainer popover (ⓘ): renders what the selected mode samples,
    //     and re-renders live when the mode changes while open. ---
    const geomInfoBtn = document.getElementById("sens-geom-info");
    const geomHelp = document.getElementById("sens-geom-help");
    const geomSel = document.getElementById("sens-geom-mode");
    const renderGeomHelp = () => { if (geomHelp) geomHelp.innerHTML = this._geometryHelp(geomModeVal()); };
    if (geomInfoBtn && geomHelp) {
      geomInfoBtn.addEventListener("click", () => {
        const show = geomHelp.hidden;
        if (show) renderGeomHelp();
        geomHelp.hidden = !show;
        geomInfoBtn.setAttribute("aria-expanded", String(show));
      });
    }
    if (geomSel) geomSel.addEventListener("change", () => { if (geomHelp && !geomHelp.hidden) renderGeomHelp(); });

    syncMode();

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
            if (sv != null) label += `${seriesDim === "tech" ? "Tech " : seriesDim === "date" ? "" : seriesDim === "routes" ? secondAxisMeta.prefix : "Rings "}${sv}`;
            if (tv != null) label += `${label ? " / " : ""}${thirdDim === "tech" ? "Tech " : thirdDim === "date" ? "" : thirdDim === "routes" ? secondAxisMeta.prefix : "Rings "}${tv}`;
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
            if (sv != null) label += `${seriesDim === "tech" ? "Tech " : seriesDim === "date" ? "" : seriesDim === "routes" ? secondAxisMeta.prefix : "Rings "}${sv}`;
            if (tv != null) label += `${label ? " / " : ""}${thirdDim === "tech" ? "Tech " : thirdDim === "date" ? "" : thirdDim === "routes" ? secondAxisMeta.prefix : "Rings "}${tv}`;
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
                title: { display: true, text: xDim === "rings" ? "Relay rings" : xDim === "tech" ? "Laser tech" : xDim === "routes" ? secondAxisMeta.label : placementAxisLabel, color: textMuted, font: { size: 10 } },
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
                    const xName = xDim === "rings" ? "Relay rings" : xDim === "tech" ? "Laser tech" : xDim === "routes" ? secondAxisMeta.label : placementAxisLabel;
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
      dim === "rings" ? scenario.ringCount : dim === "tech" ? scenario.laserTechImprovement : dim === "routes" ? scenario.routeCount : scenario.launchDate;
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
        const optimizedMode = (this._sensMode || "simple") === "optimized";
        const ringEnabled = document.getElementById("sens-ring-enable").checked;
        const techEnabled = document.getElementById("sens-tech-enable").checked;
        const placementEnabled = placementIsDim();
        placementAxisLabel = "Geometry"; // only used when the placement axis is a swept dim (geometry modes)
        // Simple (parallel) mode: suppress the reactive updateLoop so it doesn't waste the
        // main thread rebuilding/rendering constellations the worker path computes. Optimized
        // mode is serial and SHOULD render — the user watches the layout evolve per scenario
        // (initial conditions + each accepted SA solution), so leave the loop live.
        this.simMain._sensitivityRunning = !optimizedMode;
        secondAxisMeta = this._sensSecondAxis(); // relay family fixed for the run
        const flowMs = flowBudgetMs(); // per-scenario max-flow budget, fixed for the run
        const ringValues = buildRingValues();
        const techValues = buildTechValues();
        const routeValues = buildRouteValues();
        const routeEnabled = routeValues[0] != null;
        const placements = buildPlacements();
        const totalScenarios = ringValues.length * techValues.length * routeValues.length * placements.length;
        let completed = 0;
        let flowTimeouts = 0; // scenarios whose max-flow solve exceeded the time budget (plotted as gaps)
        console.log(`[Sensitivity] START (${this._sensMode}): ${totalScenarios} scenarios, rings=[${ringValues}], tech=[${techValues}], placements=[${placements.map((p) => p.label)}]`);

        // Build chart dimension info. The placement axis ("date") carries either date
        // strings or geometry-sample labels (E…/M…), so the chart infra is unchanged.
        const enabledDims = [];
        const dimValues = {};
        if (ringEnabled) { enabledDims.push("rings"); dimValues.rings = ringValues.filter(v => v != null); }
        if (routeEnabled) { enabledDims.push("routes"); dimValues.routes = routeValues.filter(v => v != null); }
        if (techEnabled) { enabledDims.push("tech"); dimValues.tech = techValues.filter(v => v != null); }
        if (placementEnabled) { enabledDims.push("date"); dimValues.date = placements.map((p) => p.label); }
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
        if (!placementEnabled) {
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
        // Optimized mode mutates the adapted-ring curves; snapshot them to restore after.
        const baseCurves = {};
        for (const [k, d] of SimUi.ADAPTED_CURVES) baseCurves[k] = this._getCurve(k, d);

        const resultArray = [];

        // Post-process a worker scenario result into chart metrics (shared by both
        // the parallel and serial paths). Returns { scenario, metrics }.
        const buildScenarioMetrics = (res, ringCount, techUserVal, dateStr, routeCount) => {
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
            // A timed-out max-flow solve (too large to solve in the budget) is unknown, not
            // zero — emit null so the chart shows a gap instead of a misleading drop to 0.
            flow: res.flowError ? null : (res.maxFlowGbps ?? 0) * 1000,
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
            routeCount: routeCount ?? "(current)",
            launchDate: dateStr,
            satellites: res.satellitesCount,
          };
          return { scenario, metrics, costs, capacityInfo, rs };
        };

        const allCats = [
          "economics", "simulation", "laser_technology",
          "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_vehicle", "satellite",
        ];
        // Make sure simMain's cost state matches the (unswept) baseline economics
        // so calculateCosts on returned results is consistent for every scenario.
        this.simMain.setCosts(this.getGroupsConfig(["economics"]));
        this.simMain.satellitePowerKw = baseConfig["satellite.satellite-power-kw"];

        // Heap estimate (cheap, no topology) for the pool's memory-admission budget.
        const estMBfor = (cfg) => {
          const seedCfg = this.simMain.simSatellites.buildConfigFromUi(cfg);
          const estSats = seedCfg.reduce((sum, c) => sum + (c.satCount || 0), 0);
          const maxSat = cfg["simulation.maxSatCount"] || Infinity;
          return estSats > maxSat ? 20 : Math.max(20, estSats * 0.016);
        };

        if (!optimizedMode) {
          // ── Simple: fan scenarios out across a worker pool (parallel). ──
          // Generate every scenario's uiConfig synchronously, in a stable nested
          // order so simLinkBudget (tech) evolves deterministically and the seed
          // requiredmbps values are reproducible. No topology here.
          // Whether to drop each scenario's result into the config archive (same
          // checkbox as optimized mode). The live UI is mutated per scenario here
          // during generation, then restored afterwards — so the archive config
          // snapshot + relay type must be captured NOW, not in the async callback.
          const doArchive = document.getElementById("opt-archive")?.checked !== false;
          const scenarios = [];
          let scenarioId = 0;
          for (const techUserVal of techValues) {
            for (const ringCount of ringValues) {
              for (const routeCount of routeValues) {
                // Throughput axis (eccentric): set BEFORE seeding so the Earth/Mars rings
                // size to half this scenario's relay capacity.
                applySecondAxisPre(routeCount);
                if (ringCount != null) this.applySimpleDefaults(ringCount);
                if (techUserVal != null) {
                  const techInternal = Math.round(Math.log2(techUserVal));
                  this.applySliderValues({ "laser_technology.improvement-factor": techInternal });
                }
                // Route-count axis (concentric): applySimpleDefaults reset auto_route_count.
                applySecondAxisPost(routeCount);
                const scenarioConfig = this.getGroupsConfig(allCats);
                scenarioConfig["simulation.calctimeSec"] = 100;
                const estMB = estMBfor(scenarioConfig);
                // Snapshot the live config (sliders + curves), relay type and resolved
                // ring count for this (tech, ring, route) combo — shared across placements.
                const archiveConfig = doArchive ? (this._archiveSnapshotConfig?.() || {}) : null;
                const archiveRelayType = doArchive ? this.getSelectedRelayType() : null;
                const resolvedRingCount = typeof ringCount === "number" ? ringCount : (parseFloat(this.sliders.relay_type?.ringcount?.value) || 0);
                for (const placement of placements) {
                  scenarios.push({ scenarioId: scenarioId++, ringCount, techUserVal, routeCount, placement, uiConfig: scenarioConfig, estMB, archiveConfig, archiveRelayType, resolvedRingCount });
                }
              }
            }
          }

          // Record one finished scenario into the charts + archive. Shared by the worker
          // pool and the in-process Main-thread path; does not touch progress counters.
          const recordScenarioResult = (res, s) => {
            if (res.flowError) flowTimeouts++;
            const { scenario, metrics, costs, capacityInfo, rs } = buildScenarioMetrics(res, s.ringCount, s.techUserVal, s.placement.label, s.routeCount);
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
            if (doArchive && this._archiveAppend) {
              const gbpsVal = rs && rs.totalThroughput > 0 ? rs.totalThroughput / 1000 : (res.maxFlowGbps || 0);
              const m = {
                relayType: s.archiveRelayType,
                ringCount: s.resolvedRingCount,
                routeCount: s.routeCount ?? null,
                satCount: res.satellitesCount || 0,
                gbps: Math.round(gbpsVal * 1000) / 1000,
                latMinMin: metrics.latMin != null ? Math.round(metrics.latMin * 10) / 10 : null,
                latP50Min: metrics.latP50 != null ? Math.round(metrics.latP50 * 10) / 10 : null,
                totalCostM: Number.isFinite(costs?.totalCosts) ? Math.round(costs.totalCosts / 1e6) : null,
                costPerMbps: Number.isFinite(costs?.costPerMbps) ? costs.costPerMbps : null,
                launches: costs?.launchCount ?? null,
                lasers: costs?.laserCount ?? null,
              };
              const tag = `sweep: ${s.ringCount ?? "cur"} rings${s.techUserVal != null ? " · " + s.techUserVal + "x" : ""}${s.routeCount != null ? " · " + s.routeCount + " " + secondAxisMeta.unit : ""} · ${s.placement.label}`;
              this._archiveAppend({ id: Date.now() + s.scenarioId, name: tag, ts: new Date().toISOString(), config: s.archiveConfig || {}, metrics: m });
            }
          };

          if (this._sensExec === "main") {
            // ── Main thread: run scenarios SERIALLY in-process (no worker pool). Blocks the
            //    UI during each solve, but there is no parallel-worker memory contention —
            //    constellations that time out under the pool can finish here. Optionally
            //    rebuild + display each constellation and dwell so the user can watch. ──
            ensureSimWorkerState();
            const renderMT = document.getElementById("sens-mt-render")?.checked === true;
            const dwellMs = Math.max(0, (parseFloat(document.getElementById("sens-mt-dwell")?.value) || 0) * 1000);
            // With display on, let the render loop run so each build is visible.
            if (renderMT) this.simMain._sensitivityRunning = false;
            const renderProgress = () => {
              const pct = Math.round((completed / totalScenarios) * 100);
              progressBar.style.width = `${pct}%`;
              progressText.textContent = `${pct}% (${completed}/${totalScenarios}) · main thread${renderMT ? " · displaying" : " · solving…"}`;
            };
            renderProgress();
            console.log(`[Sensitivity] main thread: ${scenarios.length} scenarios serially${renderMT ? " (displaying)" : ""}`);
            for (const s of scenarios) {
              if (stopRequested) break;
              // (Display build happens AFTER the solve, from the SIZED config — building
              // s.uiConfig here would show the seed-rated planet rings, which the sizing
              // loop inside runScenario corrects on its own copy. Seed rates come from the
              // analytic _relayThroughputMbps prediction, ~3-4x optimistic vs the routed
              // graph, so the seed build's planet rings are visibly over-provisioned.)
              let res;
              try {
                res = runScenarioInProcess({
                  // Shallow-copy: runScenario mutates these keys during Earth/Mars sizing,
                  // and placements of the same (tech,ring,route) share one config object —
                  // the worker path is immune (postMessage clones), in-process is not.
                  scenarioId: s.scenarioId, uiConfig: { ...s.uiConfig },
                  simDate: s.placement.simDate, sizingDate: placements[0].simDate,
                  earthAngleOffset: s.placement.earthAngleOffset, marsAngleOffset: s.placement.marsAngleOffset,
                  flowCalctimeMs: flowMs,
                  includeLinks: renderMT,
                });
              } catch (err) {
                console.error(`[Sensitivity] main-thread scenario ${s.scenarioId} failed:`, err);
                completed++; renderProgress();
                continue;
              }
              if (stopRequested || !res) { completed++; renderProgress(); continue; }
              if (renderMT && Array.isArray(res.possibleLinks) && res.possibleLinks.length) {
                // Rebuild the VISIBLE constellation from the scenario's SIZED config (the
                // Earth/Mars rates runScenario's feedback loop converged to), then show the
                // solved links and sync the right panel via the same consolidated apply the
                // window cache uses — THEN dwell. View, links, and panel now all describe
                // the same sized constellation, and simMain's own async worker (fed the same
                // sized config) later agrees instead of overwriting with seed-rated data.
                try { this.simMain.setSatellitesConfig({ ...s.uiConfig, ...(res.sizedConfig || {}) }); } catch (e) { console.warn("[Sensitivity] display build failed:", e?.message); }
                await new Promise((r) => setTimeout(r, 0));
                try {
                  this.simMain.applyWindowResult({
                    networkData: { maxFlowGbps: res.maxFlowGbps || 0, links: res.possibleLinks },
                    latencyData: res.latencyData || null,
                    capacityInfo: res.capacityInfo || null,
                    routeSummary: res.routeSummary || null,
                    missionProfilesData: res.missionProfilesData || null,
                    resultTreesData: res.resultTreesData || [],
                    satellitesCount: res.satellitesCount,
                    possibleLinks: res.possibleLinks,
                  });
                } catch (e) { console.warn("[Sensitivity] scenario panel sync failed:", e?.message); }
                if (dwellMs > 0) await new Promise((r) => setTimeout(r, dwellMs));
              }
              recordScenarioResult(res, s);
              completed++; renderProgress();
              // Yield so the progress bar + charts paint between scenarios.
              await new Promise((r) => setTimeout(r, 0));
            }
          } else {
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
                simDate: s.placement.simDate,
                sizingDate: placements[0].simDate,
                earthAngleOffset: s.placement.earthAngleOffset,
                marsAngleOffset: s.placement.marsAngleOffset,
                flowCalctimeMs: flowMs,
              }, s.estMB).then((res) => {
                if (stopRequested || !res) return;
                recordScenarioResult(res, s);
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
          } // end worker-pool branch
        } else {
          // ── Optimized: SERIAL. Per scenario, set the config live, run the curve
          //    optimizer (its own worker pool), resize Earth/Mars from the optimized
          //    relay capacity, capture metrics via one worker submit, and archive. ──
          const resetCurves = document.getElementById("opt-reset")?.checked !== false;
          const doArchive = document.getElementById("opt-archive")?.checked !== false;
          const pool = new SensitivityPool(1); // one final metric submit per scenario
          this._sensPool = pool;
          const renderProgress = () => {
            const pct = Math.round((completed / totalScenarios) * 100);
            progressBar.style.width = `${pct}%`;
            progressText.textContent = `${pct}% (${completed}/${totalScenarios}) · optimizing…`;
          };
          renderProgress();

          try {
            let scenarioId = 0;
            for (const techUserVal of techValues) {
              for (const ringCount of ringValues) {
                for (const routeCount of routeValues) {
                for (const placement of placements) {
                  if (stopRequested) break;
                  // 1. Apply this scenario's design live (the optimizer reads the live UI).
                  applySecondAxisPre(routeCount);
                  if (ringCount != null) this.applySimpleDefaults(ringCount);
                  if (techUserVal != null) this.applySliderValues({ "laser_technology.improvement-factor": Math.round(Math.log2(techUserVal)) });
                  applySecondAxisPost(routeCount);
                  // 2. Reset only the SELECTED curves (any part checked) to their default shape.
                  if (resetCurves) {
                    for (const c of this._getOptimizeCurves()) {
                      const def = Array.isArray(c.defaultY) ? c.defaultY : [{ x: 0, y: c.defaultY }, { x: 1, y: c.defaultY }];
                      this._setCurve(c.key, def); this._curveRefresh?.[c.key]?.();
                    }
                  }
                  // 3. Optimize headless — applies the winning curves to the live UI.
                  const opt = await this._runBandSolver({ silent: true });
                  if (stopRequested) break;
                  // 4. Resize Earth/Mars from the optimized relay capacity (respect the selector).
                  if (this._planetSizingMode() === "auto" && opt?.capacity > 0) this._writePlanetSizing(opt.capacity);
                  // 5. Final metrics: one worker submit of the fully-optimized live config.
                  const cfg = this.getGroupsConfig(allCats);
                  cfg["simulation.calctimeSec"] = 100;
                  const res = await pool.submit({
                    scenarioId: scenarioId++, uiConfig: cfg,
                    simDate: placement.simDate, sizingDate: placements[0].simDate,
                    earthAngleOffset: placement.earthAngleOffset, marsAngleOffset: placement.marsAngleOffset,
                    flowCalctimeMs: flowMs,
                  }, estMBfor(cfg));
                  if (stopRequested || !res) { completed++; renderProgress(); continue; }
                  if (res.flowError) flowTimeouts++;
                  const { scenario, metrics, costs, capacityInfo, rs } = buildScenarioMetrics(res, ringCount, techUserVal, placement.label, routeCount);
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
                  // 6. Archive the optimized config + its metrics.
                  if (doArchive && this._archiveAppend) {
                    const gbpsVal = rs && rs.totalThroughput > 0 ? rs.totalThroughput / 1000 : (res.maxFlowGbps || 0);
                    const m = {
                      relayType: this.getSelectedRelayType(),
                      ringCount: typeof ringCount === "number" ? ringCount : (parseFloat(this.sliders.relay_type?.ringcount?.value) || 0),
                      routeCount: routeCount ?? null,
                      latticeCount: this._latticeTerminals(),
                      satCount: res.satellitesCount || 0,
                      gbps: Math.round(gbpsVal * 1000) / 1000,
                      latMinMin: metrics.latMin != null ? Math.round(metrics.latMin * 10) / 10 : null,
                      latP50Min: metrics.latP50 != null ? Math.round(metrics.latP50 * 10) / 10 : null,
                      totalCostM: Number.isFinite(costs?.totalCosts) ? Math.round(costs.totalCosts / 1e6) : null,
                      costPerMbps: Number.isFinite(costs?.costPerMbps) ? costs.costPerMbps : null,
                      launches: costs?.launchCount ?? null,
                      lasers: costs?.laserCount ?? null,
                    };
                    const tag = `opt: ${ringCount ?? "cur"} rings${techUserVal != null ? " · " + techUserVal + "x" : ""}${routeCount != null ? " · " + routeCount + " " + secondAxisMeta.unit : ""} · ${placement.label}`;
                    this._archiveAppend({ id: Date.now() + scenarioId, name: tag, ts: new Date().toISOString(), config: this._archiveSnapshotConfig?.() || {}, metrics: m });
                  }
                  completed++;
                  renderProgress();
                }
                if (stopRequested) break;
                }
                if (stopRequested) break;
              }
              if (stopRequested) break;
            }
          } finally {
            pool.terminate();
            this._sensPool = null;
          }
        }

        // Restore original config from the raw slider snapshot (exact internal
        // positions — never the user-facing baseConfig values, which corrupt
        // nonlinear sliders). Skip sliders whose value is unchanged: the sweep only
        // touches config sliders, so re-dispatching unchanged ones is wasted work — and
        // for display.display-type it would needlessly tear down & rebuild the whole 3D
        // display mid-restore (which dropped the roadster's size, among other state).
        for (const s of baseSliderState) {
          if (s.radio !== undefined) {
            const cur = s.input.querySelector("input[type=radio]:checked");
            if ((cur ? cur.value : null) === s.radio) continue; // unchanged
            if (s.radio != null) {
              const radio = s.input.querySelector(`input[type=radio][value="${CSS.escape(String(s.radio))}"]`);
              if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
            }
          } else {
            if (s.input.value === s.value) continue; // unchanged
            s.input.value = s.value;
            s.input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
        // Restore the adapted-ring curves (optimized mode mutates them).
        for (const [k, anchors] of Object.entries(baseCurves)) {
          this._setCurve(k, anchors);
          this._curveRefresh?.[k]?.();
        }
        // Restore sim time
        this.simMain.simTime.simMsSinceStart = originalSimTime.getTime() - this.simMain.simTime.initDate.getTime();
        this.simMain.simTime.previousRealMs = performance.now();
        this.simMain.updateLoop();

        // Note any scenarios whose max-flow solve timed out — their Total Flow is shown as
        // a gap (unknown, not zero). This is the constellation outgrowing the solver's time
        // budget, typically at high in-ring throughput / very large sat counts.
        if (flowTimeouts > 0) {
          const fe = document.getElementById("sens-fixed-dims");
          if (fe) fe.textContent = `${fe.textContent ? fe.textContent + " · " : ""}⚠ ${flowTimeouts}/${totalScenarios} scenario(s) too large to solve flow in time — shown as gaps (Total Flow unknown, not 0).`;
          console.warn(`[Sensitivity] ${flowTimeouts}/${totalScenarios} scenarios timed out in the max-flow solve (plotted as gaps).`);
        }

        // Offer results as a download
        const data = { config: { type: "sensitivity" }, results: resultArray };
        this._lastSensitivityResults = data;
        this._showSensDownload(data);

      } catch (error) {
        console.error("Sensitivity analysis error:", error);
      } finally {
        this.simMain._sensitivityRunning = false;
        // Restore any slider `max` attributes lifted to allow out-of-range sweep values
        // (the base value was already restored from baseSliderState above).
        if (this._sensWidenedMaxes) {
          for (const [input, origMax] of this._sensWidenedMaxes) input.max = origMax;
          this._sensWidenedMaxes = null;
        }
        startBtn.disabled = false;
        startBtn.style.display = "";
        stopBtn.style.display = "none";
        updateEstimate();
      }
    });

    stopBtn.addEventListener("click", () => {
      stopRequested = true;
      this._bandSolverStop = true; // also abort an in-flight optimization (optimized mode)
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
    "Contoured concentric": "adapted_rings",
    "Contoured eccentric": "adapted_eccentric_rings",
    "Circular": "circular_rings",
    "Eccentric": "eccentric_rings",
  };

  /** The currently selected relay family (radio value, or the schema default). */
  getSelectedRelayType() {
    const input = this.sliders.relay_type?.selected;
    const checked = input && input.querySelector ? input.querySelector("input[type=radio]:checked") : null;
    return checked ? checked.value : this.slidersData.relay_type?.selected?.value || "Contoured concentric";
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
    // The sensitivity second-axis (route count vs in-ring throughput) depends on the
    // active family — relabel/grey it to match.
    this._updateSensRouteGrey();
  }

  createSliders() {
    const slidersContainer = document.getElementById("sliders-container");
    slidersContainer.innerHTML = "";
    // Live "computed" readout rows (e.g. the laser-terminal total) — refreshed on change.
    this._computedReadouts = [];

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

        // Non-input rows: a section sub-header, or a derived (computed) read-only value.
        // These carry no value and are skipped by getGroupsConfig / the archive snapshot.
        if (slider.type === "header" || slider.type === "computed") {
          const row = document.createElement("div");
          row.dataset.search = `${slider.label || ""} ${sectionLabel}`.toLowerCase();
          if (slider.description) row.title = slider.description;
          if (slider.type === "header") {
            row.className = "slider-subheader";
            row.style.cssText = "font-weight:600; font-size:12px; margin:10px 0 2px; opacity:0.9;";
            row.textContent = slider.label;
          } else {
            row.className = "slider-container slider-computed";
            row.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:12px; padding:1px 0; opacity:0.85;";
            const lab = document.createElement("span");
            lab.className = "slider-label";
            lab.textContent = slider.label;
            const val = document.createElement("span");
            val.className = "slider-computed-value";
            val.style.cssText = "font-variant-numeric:tabular-nums; font-weight:600;";
            let txt = ""; try { txt = slider.compute ? String(slider.compute(this)) : ""; } catch {}
            val.textContent = txt;
            row.append(lab, val);
            this._computedReadouts.push({ el: val, compute: slider.compute });
          }
          sectionContent.appendChild(row);
          continue;
        }

        if (slider.displayCondition) {
          const refFullId = `${section}.${slider.displayCondition.slider}`;
          if (!this.dependencies[refFullId]) this.dependencies[refFullId] = [];
          this.dependencies[refFullId].push(fullSliderId);
        }
        if (slider.disabledCondition) {
          const refFullId = `${section}.${slider.disabledCondition.slider}`;
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
        // Check disabled (grey-out) condition: visible but inactive until the ref matches
        if (slider.disabledCondition) {
          const refSlider = this.slidersData[section][slider.disabledCondition.slider];
          if (refSlider && refSlider.value !== slider.disabledCondition.value) {
            sliderContainer.style.opacity = "0.4";
            sliderContainer.style.pointerEvents = "none";
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

    this._updatePlanetSizingLock();
    this._injectBandSolverUI();
    this._injectFlightUI();
    this._injectProbeUI();
    this._injectConfigArchive();
  }

  /**
   * Local config archive: save the current config (all sliders + the adapted-ring
   * curves) together with a snapshot of the latest computed results (relay type, ring
   * count, sat count, Gbps capacity, cost), list them with those headline details, and
   * load any entry back (re-applies sliders + curves and rebuilds). Stored in
   * localStorage under "marslinkArchive"; injected at the top of the advanced panel.
   */
  _injectConfigArchive() {
    const host = document.getElementById("archive-pane-body");
    if (!host || host.dataset.wired) return;
    host.dataset.wired = "1";

    const KEY = "marslinkArchive";
    const load = () => { try { const a = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(a) ? a : []; } catch { return []; } };
    const save = (arr) => { try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch (e) { console.error("[Archive] save failed", e); } };
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString();

    // --- capture: sliders + curves + live result metrics ---------------------
    // Sections that actually affect the constellation, costs & performance (the same set
    // sent to the worker on rebuild). Deliberately EXCLUDES "display" (pure visualization)
    // plus a couple of playback/overlay-only controls — those are not saved.
    const BUILD_CATS = ["economics", "simulation", "laser_technology", "ring_mars", "relay_type", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "adapted_eccentric_rings", "launch_schedule", "launch_vehicle", "satellite"];
    const VIZ_SLIDERS = new Set(["simulation.time-acceleration-slider"]);
    const snapshotSliders = () => {
      const snap = {};
      for (const section of BUILD_CATS) {
        const group = this.slidersData[section];
        if (!group) continue;
        for (const sliderId in group) {
          const fullId = `${section}.${sliderId}`;
          if (VIZ_SLIDERS.has(fullId)) continue;
          const input = this.sliders[section]?.[sliderId];
          if (!input) continue;
          if (input.classList && input.classList.contains("radio-container")) {
            const checked = input.querySelector("input[type=radio]:checked");
            snap[fullId] = checked ? checked.value : group[sliderId].value;
          } else snap[fullId] = input.value;
        }
      }
      return snap;
    };
    const snapshotCurves = () => {
      const out = {};
      for (const [k, dflt] of SimUi.ADAPTED_CURVES) out[k] = this._getCurve(k, dflt);
      return out;
    };
    const captureMetrics = () => {
      const sm = this.simMain;
      let costs = null;
      try { costs = sm.calculateCosts(sm.maxFlowGbps, sm.resultTrees); } catch {}
      const rs = sm.routeSummary;
      const gbps = rs && rs.totalThroughput > 0 ? rs.totalThroughput / 1000 : (sm.maxFlowGbps || 0);
      const lat = sm.lastLatencyData;
      return {
        relayType: this.getSelectedRelayType(),
        ringCount: parseFloat(this.sliders.relay_type?.ringcount?.value ?? this.slidersData.relay_type.ringcount.value) || 0,
        latticeCount: this._latticeTerminals(),
        satCount: sm.satellitesCount || costs?.satellitesCount || 0,
        gbps: Math.round(gbps * 1000) / 1000,
        latMinMin: lat && Number.isFinite(lat.bestLatency) ? Math.round((lat.bestLatency / 60) * 10) / 10 : null,
        latP50Min: lat && Number.isFinite(lat.medianLatency) ? Math.round((lat.medianLatency / 60) * 10) / 10 : null,
        totalCostM: costs && Number.isFinite(costs.totalCosts) ? Math.round(costs.totalCosts / 1e6) : null,
        costPerMbps: costs && Number.isFinite(costs.costPerMbps) ? costs.costPerMbps : null,
        launches: costs?.launchCount ?? null,
        lasers: costs?.laserCount ?? null,
      };
    };

    // --- load: re-apply sliders + curves, then rebuild -----------------------
    const applySliders = (snap) => {
      for (const [fullId, value] of Object.entries(snap)) {
        const [section, sliderId] = fullId.split(".");
        const input = this.sliders[section]?.[sliderId];
        if (!input) continue;
        if (input.classList && input.classList.contains("radio-container")) {
          const radio = input.querySelector(`input[type=radio][value="${CSS.escape(String(value))}"]`);
          if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
        } else {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    };
    const loadEntry = (entry) => {
      const cfg = entry.config || {};
      if (cfg.sliders) applySliders(cfg.sliders);
      if (cfg.curves) for (const [k, anchors] of Object.entries(cfg.curves)) {
        if (Array.isArray(anchors)) { this._setCurve(k, anchors); this._curveRefresh?.[k]?.(); }
      }
      // Final rebuild so the curves (read inline by getGroupsConfig) take effect.
      try { this.simMain.setSatellitesConfig(this.getGroupsConfig(BUILD_CATS)); } catch (e) { console.error("[Archive] load failed", e); }
    };

    // One-time migration of legacy "presets" (sliders-only) into the archive, then
    // retire the old store so there is a single source of truth.
    (() => {
      let presets = null;
      try { presets = JSON.parse(localStorage.getItem("marslinkPresets") || "null"); } catch {}
      if (!presets || typeof presets !== "object") return;
      const arr = load();
      const have = new Set(arr.map((e) => e.name));
      let i = 0, added = false;
      for (const name of Object.keys(presets)) {
        if (have.has(name)) continue;
        const sliders = {};
        for (const [k, v] of Object.entries(presets[name] || {})) {
          const sec = k.split(".")[0];
          if (BUILD_CATS.includes(sec) && !VIZ_SLIDERS.has(k)) sliders[k] = v;
        }
        arr.push({ id: Date.now() + (i++), name, ts: new Date().toISOString(), config: { sliders, curves: {} }, metrics: {}, legacy: true });
        added = true;
      }
      if (added) save(arr);
      try { localStorage.removeItem("marslinkPresets"); } catch {}
    })();

    // --- UI: full archive in its own tab — Save + per-metric charts + saved list ------
    const wrap = document.createElement("div");
    wrap.id = "config-archive";
    wrap.style.cssText = "display:flex; flex-direction:column; gap:14px; max-width:1100px;";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "btn btn-primary";
    saveBtn.style.cssText = "width:100%;";
    saveBtn.textContent = "💾 Save current config + results";

    // One scatter per metric, colored by relay family. The x-axis is switchable
    // between ring count and satellite count via the toggle below (xMode).
    const ECC = (t) => /eccentric/i.test(t || "");
    const C_CONC = "#4a90e2", C_ECC = "#ffb454";
    // Eccentric points are shaded by ring count along a warm gradient (gold → deep
    // orange), so within the eccentric family the ring count is readable while the
    // whole family stays distinct from the single-color concentric blue. C_ECC is the
    // fallback when there is no ring-count spread to map.
    const ECC_LO = [45, 92, 66], ECC_HI = [12, 90, 48]; // [h,s,l] gradient endpoints
    const eccColorFor = (t) => {
      const u = Math.max(0, Math.min(1, t));
      const c = (a, b) => a + (b - a) * u;
      return `hsl(${c(ECC_LO[0], ECC_HI[0]).toFixed(1)}, ${c(ECC_LO[1], ECC_HI[1]).toFixed(1)}%, ${c(ECC_LO[2], ECC_HI[2]).toFixed(1)}%)`;
    };
    const ECC_GRAD_CSS = `linear-gradient(90deg, ${eccColorFor(0)}, ${eccColorFor(1)})`;
    // Concentric points are colored by circular-lattice setting using 3 DISTINCT cool
    // colors spanning green → teal → blue, so the lattice choice is readable while the
    // family stays distinct from the warm eccentric gradient. C_CONC is the fallback when
    // an entry didn't record its lattice (latticeCount: 0 none / 1 half / 2 full).
    const CONC_COLORS = { 0: "#35c75a", 1: "#10a9c2", 2: "#3b6fe0" };
    const LAT_NAME = { 0: "no lattice", 1: "half lattice", 2: "full lattice" };
    // Lattice count for an entry: prefer the captured metric, else derive from the saved
    // config's lattice radio (so concentric configs saved before latticeCount was captured
    // still color correctly). The radio was only a CAP — the lattice actually built was
    // limited by the laser terminals left after the 2 radial links, so clamp the derived
    // value by (total ports − 2): 2 ports → no lattice, 3 → ≤half, 4+ → ≤full. Returns NaN
    // when unknown → falls back to the plain blue.
    const latticeOf = (e) => {
      const m = e.metrics || {};
      if (Number.isFinite(+m.latticeCount)) return +m.latticeCount;
      const opt = e.config?.sliders?.["adapted_rings.lattice"];
      if (typeof opt !== "string") return NaN;
      const sel = /^No/.test(opt) ? 0 : /^Half/.test(opt) ? 1 : 2;
      const ports = parseFloat(e.config?.sliders?.["adapted_rings.laser-ports-per-satellite"]);
      if (!Number.isFinite(ports)) return sel;
      return Math.min(sel, Math.max(0, Math.min(2, Math.round(ports) - 2)));
    };
    const X_MODES = {
      ring: { label: "ring count", unit: "rings", get: (m) => +m.ringCount },
      sat: { label: "satellite count", unit: "sats", get: (m) => +m.satCount },
    };
    let xMode = "ring"; // "ring" | "sat" — current x-axis (toggle below)
    const METRICS = [
      { label: "Gbps capacity", unit: "Gbps", get: (m) => +m.gbps },
      { label: "Latency min", unit: "min", get: (m) => +m.latMinMin },
      { label: "Latency p50", unit: "min", get: (m) => +m.latP50Min },
      { label: "Cost", unit: "$M", get: (m) => +m.totalCostM },
      { label: "Cost / Mbps", unit: "$/Mbps", get: (m) => +m.costPerMbps },
    ];

    // Laser-tech normalization. Saved configs were captured at whatever laser-tech
    // improvement factor was active then; to compare them fairly we rescale every
    // capacity (Gbps/Mbps) LINEARLY to a common tech level chosen by the slider below.
    // The factor is 2^improvement-factor (see SimLinkBudget), so k = 2^(target − saved).
    // Cost is fixed, so Cost/Mbps scales by 1/k. Only the charts use this normalized
    // view; the saved-configs list keeps the actual values that were saved.
    const NORM_KEY = "laser_technology.improvement-factor";
    let normTechIF = parseFloat(this.sliders.laser_technology?.["improvement-factor"]?.value ?? this.slidersData.laser_technology?.["improvement-factor"]?.value);
    if (!Number.isFinite(normTechIF)) normTechIF = 7;
    const normalizeArr = (arr) => arr.map((e) => {
      const m = e.metrics || {};
      const savedIF = parseFloat(e.config?.sliders?.[NORM_KEY]);
      if (!Number.isFinite(savedIF)) return e; // legacy entry w/o tech factor — leave as saved
      const k = Math.pow(2, normTechIF - savedIF);
      if (k === 1) return e;
      const gbps = Number.isFinite(+m.gbps) ? +m.gbps * k : m.gbps;
      const costPerMbps = Number.isFinite(+m.costPerMbps) ? +m.costPerMbps / k : m.costPerMbps;
      return { ...e, metrics: { ...m, gbps, costPerMbps } };
    });
    const buildChart = (arr, metric, xm) => {
      const pts = arr.map((e) => { const m = e.metrics || {}; return { x: xm.get(m), y: metric.get(m), ecc: ECC(m.relayType), rc: +m.ringCount, lat: latticeOf(e), name: e.name }; })
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0);
      if (!pts.length) return `<div class="muted" style="font-size:11px; padding:8px;">No data yet.</div>`;
      // Concentric lattice → one of 3 distinct blues (0 none / 1 half / 2 full).
      const concColor = (lat) => CONC_COLORS[lat] || C_CONC;
      // Ring-count range across ALL eccentric entries (not just this chart's valid
      // points), so the gradient scale is identical across every chart.
      const eccRings = arr.filter((e) => ECC((e.metrics || {}).relayType)).map((e) => +(e.metrics || {}).ringCount).filter(Number.isFinite);
      const rMin = eccRings.length ? Math.min(...eccRings) : 0;
      const rMax = eccRings.length ? Math.max(...eccRings) : 0;
      const eccColor = (rc) => (rMax > rMin && Number.isFinite(rc)) ? eccColorFor((rc - rMin) / (rMax - rMin)) : C_ECC;
      const W = 300, H = 180, padL = 48, padR = 8, padT = 10, padB = 26;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const nice = (v) => { if (!(v > 0)) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };
      const xTop = nice(Math.max(1, ...pts.map((p) => p.x)));
      const yTop = nice(Math.max(1e-9, ...pts.map((p) => p.y)));
      const X = (x) => padL + (x / xTop) * plotW;
      const Y = (y) => padT + (1 - y / yTop) * plotH;
      const yLab = (v) => (yTop >= 1000 ? Math.round(v).toLocaleString() : yTop >= 10 ? String(Math.round(v)) : String(+v.toFixed(2)));
      const xLab = (v) => (xTop >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v)));
      let s = `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="var(--accent-dim,rgba(255,255,255,0.02))" stroke="var(--border-2,#333)" stroke-width="0.6"/>`;
      for (const f of [0, 0.5, 1]) {
        const gx = padL + f * plotW, gy = padT + f * plotH;
        s += `<line x1="${gx}" y1="${padT}" x2="${gx}" y2="${padT + plotH}" stroke="var(--border-2,#333)" stroke-width="0.4" stroke-dasharray="2 3"/>`;
        s += `<line x1="${padL}" y1="${gy}" x2="${padL + plotW}" y2="${gy}" stroke="var(--border-2,#333)" stroke-width="0.4" stroke-dasharray="2 3"/>`;
        s += `<text x="${gx}" y="${padT + plotH + 11}" font-size="8" text-anchor="middle" fill="var(--text-2,#aaa)">${xLab(f * xTop)}</text>`;
        s += `<text x="${padL - 4}" y="${padT + (1 - f) * plotH + 3}" font-size="8" text-anchor="end" fill="var(--text-2,#aaa)">${yLab(f * yTop)}</text>`;
      }
      s += `<text x="${padL + plotW / 2}" y="${H - 2}" font-size="8" text-anchor="middle" fill="var(--text-2,#aaa)">${xm.label}</text>`;
      for (const p of pts) s += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3.5" fill="${p.ecc ? eccColor(p.rc) : concColor(p.lat)}" fill-opacity="0.85" stroke="rgba(0,0,0,0.45)" stroke-width="0.5"><title>${esc(p.name)} — ${xLab(p.x)} ${xm.unit} · ${yLab(p.y)} ${metric.unit}${p.ecc && Number.isFinite(p.rc) && xm.unit !== "rings" ? ` · ${Math.round(p.rc)} rings` : ""}${!p.ecc && Number.isFinite(p.lat) ? ` · ${LAT_NAME[p.lat] || p.lat + " lattice"}` : ""}</title></circle>`;
      return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; display:block; font-family:ui-monospace,monospace;">${s}</svg>`;
    };

    const legend = document.createElement("div");
    legend.className = "muted";
    legend.style.cssText = "font-size:11px; display:flex; flex-direction:column; gap:5px; align-items:stretch;";
    const concSwatch = (lat) => `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:9px;height:9px;border-radius:50%;background:${CONC_COLORS[lat]};display:inline-block;"></span>${LAT_NAME[lat]}</span>`;
    legend.innerHTML =
      `<span style="display:flex;align-items:center;gap:8px;"><span class="muted">concentric:</span>${concSwatch(0)}${concSwatch(1)}${concSwatch(2)}<span class="muted" style="margin-left:auto;" id="archive-count"></span></span>` +
      `<span style="display:flex;align-items:center;gap:5px;"><span class="muted">eccentric:</span><span id="ecc-rmin" style="font-variant-numeric:tabular-nums;"></span><span style="width:42px;height:9px;border-radius:5px;background:${ECC_GRAD_CSS};display:inline-block;"></span><span id="ecc-rmax" style="font-variant-numeric:tabular-nums;"></span><span class="muted">rings</span></span>`;

    const chartsWrap = document.createElement("div");
    chartsWrap.style.cssText = "display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px;";
    const renderCharts = () => {
      const arr = normalizeArr(load());
      const xm = X_MODES[xMode] || X_MODES.ring;
      // Reflect the eccentric ring-count span in the legend's gradient labels.
      const eccRings = arr.filter((e) => ECC((e.metrics || {}).relayType)).map((e) => +(e.metrics || {}).ringCount).filter(Number.isFinite);
      const rminEl = legend.querySelector("#ecc-rmin"), rmaxEl = legend.querySelector("#ecc-rmax");
      if (rminEl && rmaxEl) {
        rminEl.textContent = eccRings.length ? String(Math.min(...eccRings)) : "";
        rmaxEl.textContent = eccRings.length ? String(Math.max(...eccRings)) : "";
      }
      chartsWrap.innerHTML = "";
      for (const metric of METRICS) {
        const card = document.createElement("div");
        card.style.cssText = "border:1px solid var(--border-2,#333); border-radius:8px; padding:6px 8px;";
        card.innerHTML = `<div style="font-size:12px; font-weight:600; margin-bottom:2px;">${metric.label} <span class="muted" style="font-weight:400;">(${metric.unit})</span></div>` + buildChart(arr, metric, xm);
        chartsWrap.appendChild(card);
      }
    };

    // Standalone cost-vs-capacity chart: x = Mbps, y = total cost. Unlike the grid
    // above, this is keyed off capacity itself, so the ring/sat x-axis toggle does
    // not affect it.
    const X_MBPS = { label: "capacity (Mbps)", unit: "Mbps", get: (m) => +m.gbps * 1000 };
    const COST_METRIC = { label: "Cost", unit: "$M", get: (m) => +m.totalCostM };
    const costVsMbpsWrap = document.createElement("div");
    costVsMbpsWrap.style.cssText = "display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px;";
    const renderCostVsMbps = () => {
      const arr = normalizeArr(load());
      costVsMbpsWrap.innerHTML = "";
      const card = document.createElement("div");
      card.style.cssText = "border:1px solid var(--border-2,#333); border-radius:8px; padding:6px 8px;";
      card.innerHTML = `<div style="font-size:12px; font-weight:600; margin-bottom:2px;">${COST_METRIC.label} <span class="muted" style="font-weight:400;">(${COST_METRIC.unit}) vs ${X_MBPS.label}</span></div>` + buildChart(arr, COST_METRIC, X_MBPS);
      costVsMbpsWrap.appendChild(card);
    };

    const listEl = document.createElement("div");
    listEl.style.cssText = "display:flex; flex-direction:column; gap:6px;";
    const renderList = () => {
      const arr = load();
      const cEl = legend.querySelector("#archive-count"); if (cEl) cEl.textContent = arr.length ? `${arr.length} saved` : "";
      if (!arr.length) { listEl.innerHTML = `<div class="muted" style="font-size:12px; padding:4px 2px;">No saved configs yet — click Save.</div>`; return; }
      listEl.innerHTML = "";
      for (const e of arr) {
        const m = e.metrics || {};
        const hasM = m.relayType || m.ringCount || m.satCount;
        const cost = m.totalCostM != null ? `$${fmtInt(m.totalCostM)}M` : "—";
        const cpm = m.costPerMbps != null && isFinite(m.costPerMbps) ? `$${fmtInt(m.costPerMbps)}/Mbps` : "—";
        let date = ""; try { date = new Date(e.ts).toLocaleString(); } catch {}
        const row = document.createElement("div");
        row.style.cssText = "border:1px solid var(--border-2,#333); border-radius:6px; padding:6px 8px;";
        row.innerHTML =
          `<div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">` +
          `<div style="min-width:0;">` +
          `<div style="font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(e.name)}${e.legacy ? ' <span class="muted" style="font-weight:400;">· preset</span>' : ""}</div>` +
          (hasM
            ? `<div class="muted" style="font-size:11px;">${esc(m.relayType || "?")} · ${fmtInt(m.ringCount)} rings · ${fmtInt(m.satCount)} sats</div><div class="muted" style="font-size:11px;">${m.gbps ?? "?"} Gbps · ${cost} · ${cpm}</div>`
            : `<div class="muted" style="font-size:11px;">imported preset — load to apply</div>`) +
          `<div class="muted" style="font-size:10px; opacity:0.65;">${esc(date)}</div>` +
          `</div>` +
          `<div style="display:flex; flex-direction:column; gap:4px; flex:none;">` +
          `<button class="btn archive-load" data-id="${esc(e.id)}" style="font-size:11px; padding:2px 8px;">Load</button>` +
          `<button class="btn archive-del" data-id="${esc(e.id)}" title="Delete" style="font-size:11px; padding:2px 8px;">✕</button>` +
          `</div></div>`;
        listEl.appendChild(row);
      }
      listEl.querySelectorAll(".archive-load").forEach((b) => b.addEventListener("click", () => {
        const e = load().find((x) => String(x.id) === b.dataset.id);
        if (e) loadEntry(e);
      }));
      listEl.querySelectorAll(".archive-del").forEach((b) => b.addEventListener("click", () => {
        if (!confirm("Delete this saved config?")) return;
        save(load().filter((x) => String(x.id) !== b.dataset.id));
        renderAll();
      }));
    };
    const renderAll = () => { renderCharts(); renderCostVsMbps(); renderList(); };

    // Hooks so other features (the optimized sensitivity sweep) can capture the current
    // config and append archive entries without going through the Save button/prompt.
    this._archiveSnapshotConfig = () => ({ sliders: snapshotSliders(), curves: snapshotCurves() });
    this._archiveAppend = (entry) => { const arr = load(); arr.unshift(entry); save(arr); renderAll(); };

    saveBtn.addEventListener("click", () => {
      const m = captureMetrics();
      const def = `${m.relayType} · ${m.gbps} Gbps · ${fmtInt(m.satCount)} sats`;
      const name = prompt("Name this saved config:", def);
      if (name === null) return;
      const arr = load();
      arr.unshift({ id: Date.now(), name: name.trim() || def, ts: new Date().toISOString(), config: { sliders: snapshotSliders(), curves: snapshotCurves() }, metrics: m });
      save(arr);
      renderAll();
    });

    // Copy the full archive (all saved configs + their metrics) to the clipboard as JSON.
    const copyBtn = document.createElement("button");
    copyBtn.type = "button"; copyBtn.className = "btn";
    copyBtn.style.cssText = "width:100%;";
    copyBtn.textContent = "📋 Copy results JSON";
    copyBtn.title = "Copy every saved config and its results to the clipboard as a JSON array.";
    copyBtn.addEventListener("click", async () => {
      const json = JSON.stringify(load(), null, 2);
      const done = (ok) => { copyBtn.textContent = ok ? "✓ Copied" : "✕ Copy failed"; setTimeout(() => { copyBtn.textContent = "📋 Copy results JSON"; }, 1500); };
      try {
        await navigator.clipboard.writeText(json);
        done(true);
      } catch (e) {
        // Fallback for non-secure contexts where the async Clipboard API is unavailable.
        try {
          const ta = document.createElement("textarea");
          ta.value = json; ta.style.cssText = "position:fixed; opacity:0;";
          document.body.appendChild(ta); ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          done(ok);
        } catch (e2) { console.error("[Archive] copy failed", e2); done(false); }
      }
    });

    // x-axis toggle: express the charts against ring count or satellite count.
    const mkLabel = (t) => { const d = document.createElement("div"); d.style.cssText = "font-size:13px; font-weight:600;"; d.textContent = t; return d; };
    const xToggle = document.createElement("div");
    xToggle.className = "muted";
    xToggle.style.cssText = "font-size:11px; display:flex; gap:6px; align-items:center;";
    const chartsLabel = mkLabel("Saved configs by ring count");
    const setXMode = (mode) => {
      xMode = mode;
      xToggle.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.mode === xMode;
        b.classList.toggle("btn-primary", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      chartsLabel.textContent = `Saved configs by ${X_MODES[xMode].label}`;
      renderCharts();
    };
    xToggle.append(document.createTextNode("x-axis:"));
    for (const [mode, def] of Object.entries(X_MODES)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.dataset.mode = mode;
      b.style.cssText = "font-size:11px; padding:2px 10px;";
      b.textContent = def.label;
      b.addEventListener("click", () => setXMode(mode));
      xToggle.appendChild(b);
    }

    // Laser-tech normalization slider — sits beside the x-axis toggle. Moving it
    // rescales every Gbps/Mbps-bearing chart to the chosen tech level (linear in
    // capacity); the saved-configs list below stays at the saved values.
    const techRow = document.createElement("div");
    techRow.className = "muted";
    techRow.style.cssText = "font-size:11px; display:flex; gap:8px; align-items:center;";
    const techVal = document.createElement("span");
    techVal.style.cssText = "font-variant-numeric:tabular-nums; min-width:46px;";
    const techSlider = document.createElement("input");
    techSlider.type = "range"; techSlider.min = "0"; techSlider.max = "20"; techSlider.step = "1";
    techSlider.value = String(normTechIF);
    techSlider.style.cssText = "flex:1; max-width:200px;";
    const fmtMult = (v) => { const f = Math.pow(2, v); return f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k×` : `${f}×`; };
    const updTech = () => { techVal.textContent = `${fmtMult(normTechIF)} (2^${normTechIF})`; };
    techSlider.addEventListener("input", () => { normTechIF = parseFloat(techSlider.value) || 0; updTech(); renderCharts(); renderCostVsMbps(); });
    techRow.append(document.createTextNode("normalize to laser tech:"), techSlider, techVal);
    updTech();

    // Import: paste a JSON array (or a single entry) and append it to the archive.
    // Accepts the output of "Copy results JSON" as-is. Entries with missing or
    // colliding ids are re-stamped so they don't overwrite existing saves.
    const importBtn = document.createElement("button");
    importBtn.type = "button"; importBtn.className = "btn";
    importBtn.style.cssText = "width:100%;";
    importBtn.textContent = "📥 Import results JSON";
    importBtn.title = "Paste a JSON array of saved configs to add them to this archive.";

    const importPanel = document.createElement("div");
    importPanel.hidden = true;
    importPanel.style.cssText = "display:flex; flex-direction:column; gap:6px; border:1px solid var(--border-2,#333); border-radius:6px; padding:8px;";
    const importTa = document.createElement("textarea");
    importTa.placeholder = "Paste archive JSON here — an array of saved configs (the output of 📋 Copy results JSON), or a single entry…";
    importTa.style.cssText = "width:100%; min-height:120px; resize:vertical; font-family:ui-monospace,monospace; font-size:11px; box-sizing:border-box;";
    const importMsg = document.createElement("div");
    importMsg.className = "muted"; importMsg.style.cssText = "font-size:11px;";
    const importActions = document.createElement("div");
    importActions.style.cssText = "display:flex; gap:6px;";
    const importDoBtn = document.createElement("button");
    importDoBtn.type = "button"; importDoBtn.className = "btn btn-primary";
    importDoBtn.style.cssText = "font-size:11px; padding:3px 12px;";
    importDoBtn.textContent = "Add to archive";
    const importCancelBtn = document.createElement("button");
    importCancelBtn.type = "button"; importCancelBtn.className = "btn";
    importCancelBtn.style.cssText = "font-size:11px; padding:3px 12px;";
    importCancelBtn.textContent = "Cancel";
    importActions.append(importDoBtn, importCancelBtn);
    importPanel.append(importTa, importActions, importMsg);

    importBtn.addEventListener("click", () => {
      importPanel.hidden = !importPanel.hidden;
      if (!importPanel.hidden) { importMsg.textContent = ""; importTa.focus(); }
    });
    importCancelBtn.addEventListener("click", () => { importPanel.hidden = true; importTa.value = ""; importMsg.textContent = ""; });
    importDoBtn.addEventListener("click", () => {
      const raw = importTa.value.trim();
      if (!raw) { importMsg.textContent = "Paste some JSON first."; return; }
      let parsed;
      try { parsed = JSON.parse(raw); } catch (err) { importMsg.textContent = "Invalid JSON: " + err.message; return; }
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]).filter((e) => e && typeof e === "object");
      if (!incoming.length) { importMsg.textContent = "No archive entries found in that JSON."; return; }
      const arr = load();
      const ids = new Set(arr.map((e) => String(e.id)));
      let base = Date.now(), added = 0;
      for (const src of incoming) {
        const entry = { ...src };
        if (entry.id == null || ids.has(String(entry.id))) entry.id = base++;
        ids.add(String(entry.id));
        if (!entry.ts) entry.ts = new Date().toISOString();
        if (!entry.config || typeof entry.config !== "object") entry.config = { sliders: {}, curves: {} };
        if (!entry.metrics || typeof entry.metrics !== "object") entry.metrics = {};
        if (!entry.name) entry.name = "imported";
        arr.unshift(entry);
        added++;
      }
      save(arr);
      renderAll();
      importTa.value = "";
      importPanel.hidden = true;
      importMsg.textContent = `Added ${added} ${added === 1 ? "entry" : "entries"}.`;
    });

    // --- Danger zone: wipe the entire archive --------------------------------
    const RED = "#e5484d";
    const danger = document.createElement("div");
    danger.style.cssText = `margin-top:18px; border:1px solid ${RED}; border-radius:8px; padding:10px 12px; background:rgba(229,72,77,0.07); display:flex; flex-direction:column; gap:8px;`;
    const dangerTitle = document.createElement("div");
    dangerTitle.style.cssText = `font-size:12px; font-weight:700; color:${RED}; display:flex; align-items:center; gap:6px;`;
    dangerTitle.innerHTML = `<span aria-hidden="true">⚠️</span> Danger zone`;
    const dangerDesc = document.createElement("div");
    dangerDesc.className = "muted";
    dangerDesc.style.cssText = "font-size:11px;";
    dangerDesc.textContent = "Permanently delete every saved config in this archive. This cannot be undone.";
    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.type = "button";
    deleteAllBtn.style.cssText = `align-self:flex-start; font-size:11px; font-weight:600; padding:4px 12px; border:1px solid ${RED}; border-radius:6px; background:${RED}; color:#fff; cursor:pointer;`;
    deleteAllBtn.textContent = "🗑 Delete all saved configs";
    deleteAllBtn.addEventListener("click", () => {
      const n = load().length;
      if (!n) { importMsg.textContent = ""; return; }
      if (!confirm(`Delete all ${n} saved config${n === 1 ? "" : "s"}? This cannot be undone.`)) return;
      save([]);
      renderAll();
    });
    danger.append(dangerTitle, dangerDesc, deleteAllBtn);

    wrap.append(saveBtn, copyBtn, importBtn, importPanel, chartsLabel, xToggle, techRow, legend, chartsWrap, mkLabel("Cost vs capacity"), costVsMbpsWrap, mkLabel("Saved configs"), listEl, danger);
    host.appendChild(wrap);
    setXMode(xMode);
    renderAll();
  }

  /**
   * Lock or unlock the Earth/Mars "Throughput in ring (worst case)" fields based on the
   * Earth/Mars auto-size mode. In 'auto' the value is derived (half the live relay
   * capacity, written by runPlanetSizingStep) so the rows are read-only + greyed; in
   * 'off' the user may edit them, so they're enabled with their plain label.
   */
  _updatePlanetSizingLock() {
    const locked = this._planetSizingMode() === "auto";
    for (const section of ["ring_earth", "ring_mars"]) {
      const input = this.sliders[section]?.requiredmbpsbetweensats;
      const container = this.sliderContainers[section]?.requiredmbpsbetweensats;
      if (!input || !container) continue;
      input.disabled = locked;
      const numericInput = document.getElementById(`${section}.requiredmbpsbetweensats-value`);
      if (numericInput) numericInput.disabled = locked;
      container.style.opacity = locked ? "0.6" : "1";
      const label = container.querySelector(".slider-label");
      if (label) {
        label.textContent = locked ? "Throughput in ring (worst case) · ½ relay capacity" : "Throughput in ring (worst case)";
        label.title = locked
          ? "Derived: half the live relay capacity (the Capacity card's relay number). Each planet injects at a single gateway and its ring carries the traffic two ways, so the worst-case (periapsis) in-ring link carries half. Switch 'Earth/Mars auto-size' to 'off' to edit."
          : "Worst-case (periapsis) in-ring link rate; sets the planet ring's satellite count.";
      }
    }
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
      this._buildCurveChart(chartWrap, { key: "adapted_rings.density-anchors", defaultY: 50, titleEl: eqLabel });
    }

    // Replace the 4 Earth↔Mars blend sliders with the same curve chart: x = ring
    // position (Earth→Mars), y = blend % (0 = Earth value, 50 = natural, 100 = Mars).
    const BLEND_CHARTS = [
      { slider: "earth-mars-raan-pct", key: "adapted_rings.raan-curve", defaultY: 100, label: "Earth↔Mars RAAN" },
      { slider: "earth-mars-argperi-pct", key: "adapted_rings.argperi-curve", defaultY: [{ x: 0, y: 0 }, { x: 0.1, y: 45 }, { x: 0.2, y: 64 }, { x: 0.3, y: 84 }, { x: 0.4, y: 100 }, { x: 1, y: 100 }], label: "Earth↔Mars arg. perigee" },
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
      this._buildCurveChart(chartHost, { key: bc.key, defaultY: bc.defaultY, titleEl: lab });
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
    const defThreads = Math.max(1, Math.floor((cores * 2) / 3));
    wrap.innerHTML = `
      <div style="display:flex; gap:6px; align-items:center;">
        <button id="band-solver-btn" class="btn btn-primary" type="button" style="flex:1;" title="Search every checked curve (ring density + blends) for the shapes that best meet the capacity/latency goal (uses the worker pool).">⚙ Optimize checked</button>
        <button id="band-solver-stop" class="btn" type="button" style="display:none;">Stop</button>
      </div>
      <div class="muted" style="display:flex; gap:10px; align-items:center; margin-top:6px; font-size:12px; flex-wrap:wrap;">
        <label title="Evaluation budget (more = better search, slower).">evals <input type="number" id="band-solver-evals" value="500" min="20" max="20000" step="20" style="width:60px;"></label>
        <label title="Number of control points the optimizer places on each checked curve (evenly spaced Earth→Mars). More = finer shaping but a larger search; the result is applied as this many anchors.">points <input type="number" id="band-solver-bands" value="30" min="2" max="40" step="1" style="width:48px;"></label>
        <label title="Parallel worker threads. Capped at the logical core count; the renderer needs some headroom, so ~two-thirds of the cores is a good default.">threads <input type="number" id="band-solver-threads" value="${defThreads}" min="1" max="${cores}" step="1" style="width:48px;">/${cores}</label>
        <label title="Hard memory cap, as a % of this tab's JS heap limit. Workers share one ~4GB V8 cage with the main thread, so their heaps add up — the optimizer only starts a job while the running total stays under this cap, so a sweep won't crash the tab ('Aw, Snap! Out of Memory'). Lower it if you hit crashes; raise it to admit more jobs at once. Default 75%.">mem <input type="number" id="band-solver-mem" value="75" min="10" max="95" step="5" style="width:48px;">%</label>
        <label title="Scale factor on the size of each proposed change (the Gaussian step). 1× = unscaled; below 1 = smaller, smoother moves (less abrupt); above 1 = bolder jumps. Applies to the annealing perturbations, not the random restarts.">step <input type="number" id="band-solver-step" value="0.3" min="0.05" max="2" step="0.05" style="width:52px;">×</label>
      </div>
      <div class="muted" style="display:flex; gap:10px; align-items:center; margin-top:6px; font-size:12px; flex-wrap:wrap;">
        <span title="Each generation picks ONE of the checked move types at random and applies it to the whole batch. 'all charts' touches every checked chart; '1 chart' picks one random chart for the batch. 'all dims' jitters every value in scope; '1 dim' jitters one random value of the chosen chart. Check several to mix strategies.">moves <span class="muted" style="font-weight:400;">(random each step):</span></span>
        <label style="display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" class="band-solver-move" value="all"> all dims · all charts</label>
        <label style="display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" class="band-solver-move" value="all-1chart"> all dims · 1 chart</label>
        <label style="display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" class="band-solver-move" value="single-1chart" checked> 1 dim · 1 chart</label>
        <label style="display:inline-flex; align-items:center; gap:3px;"><input type="checkbox" class="band-solver-move" value="samex"> 1 dim (same x) · all charts</label>
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-top:8px; font-size:12px;">
        <span class="muted" title="Optimize purely for relay capacity.">Capacity</span>
        <input type="range" id="band-solver-alpha" class="slider" min="0" max="100" value="0" step="5" style="flex:1; width:auto;" title="Goal blend: left = maximize capacity, right = minimize latency, middle = range-normalized trade-off between the two.">
        <span class="muted" title="Optimize purely for latency.">Latency</span>
      </div>
      <div class="muted" style="display:flex; gap:10px; align-items:center; margin-top:6px; font-size:12px; flex-wrap:wrap;">
        <label title="Earth/Mars geometries each layout is scored at. 'current' = the live layout at the current sim date. 4 / 16 place Earth & Mars on their orbits by geometry, measured from the Earth–Mars closest-approach direction, date-independent: 4 = Earth fixed +90° × Mars at {0,90,180,270}°; 16 = both at {0,90,180,270}° (4×4). Scores combine per the aggregate setting.">geoms
          <select id="band-solver-geom" style="width:72px;">
            <option value="1" selected>current</option>
            <option value="4">4</option>
            <option value="16">16</option>
          </select></label>
        <button type="button" id="band-solver-geom-info" class="icon-btn" aria-expanded="false" title="Show what these geometries sample" style="line-height:1; padding:2px 6px;">&#9432;</button>
        <label title="How the per-geometry scores combine. Mean = best lifetime average; Worst = robust to the hardest geometry (e.g. conjunction).">aggregate
          <select id="band-solver-agg" style="width:64px;">
            <option value="mean" selected>Mean</option>
            <option value="worst">Worst</option>
          </select></label>
        <label title="Fast-lane emphasis inside the latency goal: latency = this%·(fastest route) + rest·(traffic-weighted average). 0 = pure average.">fast-lane <input type="number" id="band-solver-fast" value="25" min="0" max="100" step="5" style="width:48px;">%</label>
      </div>
      <div id="band-solver-geom-help" hidden style="margin:6px 0; padding:8px; border:1px solid var(--border-2,#333); border-radius:6px; background:var(--accent-dim,rgba(255,255,255,0.02));"></div>
      <label class="muted" style="display:flex; gap:6px; align-items:center; margin-top:6px; font-size:12px;" title="Reject any layout with satellites inside Earth's orbit or outside Mars's — keep the whole relay strictly between the two planet orbits.">
        <input type="checkbox" id="band-solver-keep-between" checked style="margin:0; cursor:pointer; flex:none;">
        Keep all rings between Earth &amp; Mars orbits (no inside-Earth / outside-Mars sats)
      </label>
      <div id="band-solver-progress" class="muted" style="margin-top:6px; font-size:12px; display:none;"></div>`;
    host.appendChild(wrap);

    wrap.querySelector("#band-solver-btn").addEventListener("click", () => this._runBandSolver());
    wrap.querySelector("#band-solver-stop").addEventListener("click", () => { this._bandSolverStop = true; });

    // Geometry explainer popover (ⓘ) next to the optimizer's "geoms" selector. Maps the
    // geom count (1/4/16) to the shared diagram mode and re-renders on change while open.
    const bsGeomSel = wrap.querySelector("#band-solver-geom");
    const bsGeomInfo = wrap.querySelector("#band-solver-geom-info");
    const bsGeomHelp = wrap.querySelector("#band-solver-geom-help");
    const bsMode = () => (bsGeomSel?.value === "16" ? "geometry-16" : bsGeomSel?.value === "4" ? "geometry-4" : "current");
    const bsRender = () => { if (bsGeomHelp) bsGeomHelp.innerHTML = this._geometryHelp(bsMode()); };
    if (bsGeomInfo && bsGeomHelp) {
      bsGeomInfo.addEventListener("click", () => {
        const show = bsGeomHelp.hidden;
        if (show) bsRender();
        bsGeomHelp.hidden = !show;
        bsGeomInfo.setAttribute("aria-expanded", String(show));
      });
    }
    if (bsGeomSel) bsGeomSel.addEventListener("change", () => { if (bsGeomHelp && !bsGeomHelp.hidden) bsRender(); });
  }

  /**
   * Spacecraft-flight controls (self-contained section, like the band solver). Drives
   * the SimFlightController directly — NOT the constellation rebuild path — so changing
   * fleet params never re-sizes the relay. Persists to localStorage under
   * "spacecraft_flights.*"; the manufacturing rate uses the shared anchor-curve editor.
   */
  _injectFlightUI() {
    const container = document.getElementById("sliders-container");
    if (!container || document.getElementById("slider-section-content-spacecraft_flights")) return;
    const flight = this.simMain.simFlight;
    if (!flight) return;

    // Section scaffold (mirrors the generated sections so styling/search/collapse match).
    const wrapper = document.createElement("div");
    wrapper.className = "slider-section";
    const header = document.createElement("h3");
    header.className = "slider-section-header";
    header.textContent = "Spacecraft flights";
    wrapper.appendChild(header);
    const content = document.createElement("div");
    content.className = "slider-section-content";
    content.id = "slider-section-content-spacecraft_flights";
    wrapper.appendChild(content);
    container.appendChild(wrapper);
    header.addEventListener("click", () => {
      const expanded = content.classList.toggle("active");
      header.classList.toggle("expanded", expanded);
    });

    const LS = (k, d) => { const v = localStorage.getItem("spacecraft_flights." + k); return v === null ? d : v; };
    const saveLS = (k, v) => localStorage.setItem("spacecraft_flights." + k, String(v));

    // Visibility toggles: ship markers and transfer arcs independently.
    const mkChk = (id, label, dflt) => {
      const row = document.createElement("label");
      row.className = "slider-container";
      row.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = LS(id, dflt ? "1" : "0") !== "0";
      chk.style.cssText = "margin:0;cursor:pointer;flex:none;";
      row.appendChild(chk);
      row.appendChild(document.createTextNode(label));
      content.appendChild(row);
      return chk;
    };
    const shipsChk = mkChk("showShips", "Show spacecrafts", false);
    const pathsChk = mkChk("showPaths", "Show flight paths", false);

    // Range-row factory (matches the app's .slider-container markup).
    const sliders = {};
    const mk = (id, label, min, max, step, def, unit, fmt) => {
      const c = document.createElement("div");
      c.className = "slider-container";
      c.dataset.search = (label + " spacecraft flights").toLowerCase();
      const top = document.createElement("div");
      top.className = "slider-row-top";
      const lab = document.createElement("span");
      lab.className = "slider-label";
      lab.textContent = label;
      const val = document.createElement("span");
      val.className = "slider-value-input";
      val.style.cssText = "margin-left:auto;font-variant-numeric:tabular-nums;";
      top.appendChild(lab); top.appendChild(val);
      if (unit) { const u = document.createElement("span"); u.className = "slider-unit"; u.textContent = unit; top.appendChild(u); }
      const inp = document.createElement("input");
      inp.type = "range"; inp.className = "slider";
      inp.min = min; inp.max = max; inp.step = step; inp.value = LS(id, def);
      const show = () => { val.textContent = fmt ? fmt(parseFloat(inp.value)) : inp.value; };
      show();
      inp.addEventListener("input", () => { show(); saveLS(id, inp.value); apply(); });
      c.appendChild(top); c.appendChild(inp);
      content.appendChild(c);
      sliders[id] = inp;
      return inp;
    };

    const portsInp = mk("ports", "Laser terminals per ship", 1, 3, 1, "2", " ports");
    const sigmaInp = mk("sigma", "Departure spread (σ)", 0, 60, 1, "10", " days");
    const retInp = mk("return", "Mars→Earth return", 0, 100, 1, "50", " %");
    const capInp = mk("cap", "Flight count cap", 1, 1000, 1, "1000", " legs", (v) => (v >= 1000 ? "∞" : String(v)));

    // Manufacturing-rate curve (ships/yr across 2025→2050) — reuses the anchor editor.
    const mfgLabel = document.createElement("div");
    mfgLabel.className = "slider-label";
    mfgLabel.style.cssText = "margin-top:var(--s-2);font-weight:600;";
    mfgLabel.innerHTML = `Starship manufacturing <span class="muted" style="font-weight:400;">· ships/yr, 2025→2050</span>`;
    content.appendChild(mfgLabel);
    const chartNote = document.createElement("div");
    chartNote.className = "muted";
    chartNote.style.cssText = "font-size:11px;margin:0 2px 3px;";
    chartNote.textContent = "Drag to shape yearly build rate · click to add · double-click to remove · right-click to type";
    content.appendChild(chartNote);
    const chartHost = document.createElement("div");
    chartHost.style.cssText = "padding:2px;";
    content.appendChild(chartHost);

    const MFG_KEY = "spacecraft_flights.manufacturing-curve";
    const MFG_DEFAULT = [{ x: 0, y: 8 }, { x: 1, y: 60 }];
    const Y0 = 2025, Y1 = 2050;
    const buildManufacturing = () => {
      const anchors = this._getCurve(MFG_KEY, MFG_DEFAULT);
      const out = {};
      for (let y = Y0; y <= Y1; y++) out[y] = Math.round(this.simMain.simSatellites.densityFromAnchors(anchors, (y - Y0) / (Y1 - Y0)));
      return out;
    };
    const apply = () => {
      const f = this.simMain.simFlight;
      f.showShips = shipsChk.checked;
      f.showPaths = pathsChk.checked;
      f.setEnabled(shipsChk.checked || pathsChk.checked);
      f.setConfig({
        portsPerShip: parseInt(portsInp.value, 10),
        sigmaDays: parseFloat(sigmaInp.value),
        returnFraction: parseFloat(retInp.value) / 100,
        flightCap: parseInt(capInp.value, 10),
        manufacturingByYear: buildManufacturing(),
      });
      if (!f.enabled && this.simMain.simDisplay && this.simMain.simDisplay.setFlightData) {
        this.simMain.simDisplay.setFlightData(null);
      }
      this.simMain.refreshFleetMetric();
    };

    this._buildCurveChart(chartHost, {
      key: MFG_KEY, defaultY: MFG_DEFAULT, xLabels: [String(Y0), String(Y1)], yTopLabel: "100/yr",
      onCommit: () => apply(), titleEl: mfgLabel,
    });

    shipsChk.addEventListener("change", () => { saveLS("showShips", shipsChk.checked ? "1" : "0"); apply(); });
    pathsChk.addEventListener("change", () => { saveLS("showPaths", pathsChk.checked ? "1" : "0"); apply(); });

    apply(); // push initial (saved/default) config into the controller
  }

  /**
   * Inject the "Coverage probes" section (Monte-Carlo coverage field — the
   * alternative to spacecraft flights). Self-contained, persisted under
   * "coverage_probes.*", wired straight to simMain.simProbe (NO constellation
   * rebuild). Advanced-mode only, like the flight section.
   */
  _injectProbeUI() {
    const container = document.getElementById("sliders-container");
    if (!container || document.getElementById("slider-section-content-coverage_probes")) return;
    const probe = this.simMain.simProbe;
    if (!probe) return;

    const wrapper = document.createElement("div");
    wrapper.className = "slider-section";
    const header = document.createElement("h3");
    header.className = "slider-section-header";
    header.textContent = "Coverage probes";
    wrapper.appendChild(header);
    const content = document.createElement("div");
    content.className = "slider-section-content";
    content.id = "slider-section-content-coverage_probes";
    wrapper.appendChild(content);
    container.appendChild(wrapper);
    header.addEventListener("click", () => {
      const expanded = content.classList.toggle("active");
      header.classList.toggle("expanded", expanded);
    });

    const LS = (k, d) => { const v = localStorage.getItem("coverage_probes." + k); return v === null ? d : v; };
    const saveLS = (k, v) => localStorage.setItem("coverage_probes." + k, String(v));

    // Enable / show toggle (off by default — the flight overlay is the default view).
    const row = document.createElement("label");
    row.className = "slider-container";
    row.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;";
    const enableChk = document.createElement("input");
    enableChk.type = "checkbox";
    enableChk.checked = LS("enabled", "0") !== "0";
    enableChk.style.cssText = "margin:0;cursor:pointer;flex:none;";
    row.appendChild(enableChk);
    row.appendChild(document.createTextNode("Show coverage probes"));
    content.appendChild(row);

    const note = document.createElement("div");
    note.className = "muted";
    note.style.cssText = "font-size:11px;margin:2px 2px 4px;";
    note.textContent = "Random spacecraft scattered between Earth & Mars orbits — each measured independently against the relay.";
    content.appendChild(note);

    // Range-row factory (matches the app's .slider-container markup).
    const sliders = {};
    const mk = (id, label, min, max, step, def, unit, fmt) => {
      const c = document.createElement("div");
      c.className = "slider-container";
      c.dataset.search = (label + " coverage probes").toLowerCase();
      const top = document.createElement("div");
      top.className = "slider-row-top";
      const lab = document.createElement("span");
      lab.className = "slider-label";
      lab.textContent = label;
      const val = document.createElement("span");
      val.className = "slider-value-input";
      val.style.cssText = "margin-left:auto;font-variant-numeric:tabular-nums;";
      top.appendChild(lab); top.appendChild(val);
      if (unit) { const u = document.createElement("span"); u.className = "slider-unit"; u.textContent = unit; top.appendChild(u); }
      const inp = document.createElement("input");
      inp.type = "range"; inp.className = "slider";
      inp.min = min; inp.max = max; inp.step = step; inp.value = LS(id, def);
      const show = () => { val.textContent = fmt ? fmt(parseFloat(inp.value)) : inp.value; };
      show();
      inp.addEventListener("input", () => { show(); saveLS(id, inp.value); apply(); });
      c.appendChild(top); c.appendChild(inp);
      content.appendChild(c);
      sliders[id] = inp;
      return inp;
    };

    const countInp = mk("count", "Number of probes", 50, 3000, 50, "500", "");
    const seedInp = mk("seed", "Random seed", 1, 50, 1, "1", "");
    const portsInp = mk("ports", "Laser terminals per probe", 1, 3, 1, "1", " ports");

    const apply = () => {
      const p = this.simMain.simProbe;
      p.showProbes = enableChk.checked;
      p.setEnabled(enableChk.checked);
      p.setConfig({
        count: parseInt(countInp.value, 10),
        seed: parseInt(seedInp.value, 10),
        portsPerProbe: parseInt(portsInp.value, 10),
      });
      if (!p.enabled && this.simMain.simDisplay && this.simMain.simDisplay.setProbeData) {
        this.simMain.simDisplay.setProbeData(null);
      }
      // The overlay is event-driven (measures only on window/cloud change), so a
      // UI change must force one re-push + card refresh on the next frame.
      this.simMain._lastProbeRender = null;
      this.simMain._coverageDrawnVersion = -1;
      this.simMain.refreshCoverageMetric();
    };

    enableChk.addEventListener("change", () => { saveLS("enabled", enableChk.checked ? "1" : "0"); apply(); });

    apply(); // push initial (saved/default) config into the controller
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
  _buildCurveChart(host, { key, defaultY = 50, onCommit = null, xLabels = null, yTopLabel = "100", titleEl = null }) {
    const SVGNS = "http://www.w3.org/2000/svg";
    const W = 480, H = 132, padL = 8, padR = 8, padT = 16, padB = 16;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xLeftLabel = (xLabels && xLabels[0]) || "Earth";
    const xRightLabel = (xLabels && xLabels[1]) || "Mars";
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
    // Optimizer overlays (non-interactive): the accepted scenario + the in-flight batch
    // "cloud", drawn over the blue base curve while the band solver runs. {accepted, batch}
    // are anchor arrays; null = none.
    let overlay = { accepted: null, batch: null };

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

    // Sample the smooth curve through an anchor set into an SVG path string.
    const SAMPLES = 80;
    const pathFor = (A) => {
      let d = "";
      for (let k = 0; k <= SAMPLES; k++) {
        const u = k / SAMPLES;
        d += `${k === 0 ? "M" : "L"} ${xOf(u).toFixed(1)} ${yOf(ds.densityFromAnchors(A, u)).toFixed(1)} `;
      }
      return d;
    };
    const render = () => {
      const A = anchors;
      const curve = pathFor(A);
      const area = curve + `L ${xOf(1).toFixed(1)} ${yOf(0).toFixed(1)} L ${xOf(0).toFixed(1)} ${yOf(0).toFixed(1)} Z`;
      // Optimizer overlays: the faded batch "cloud" first, then the bold accepted line —
      // both amber, over the blue base curve and beneath the draggable handles.
      let ov = "";
      if (overlay.batch) for (const bA of overlay.batch)
        ov += `<path d="${pathFor(bA)}" fill="none" stroke="#ffb454" stroke-width="1" stroke-opacity="0.2" stroke-linecap="round" pointer-events="none"/>`;
      if (overlay.accepted)
        ov += `<path d="${pathFor(overlay.accepted)}" fill="none" stroke="#ffb454" stroke-width="1.6" stroke-linecap="round" pointer-events="none"/>`;
      const pts = A.map((a, i) =>
        `<circle cx="${xOf(a.x).toFixed(1)}" cy="${yOf(a.y).toFixed(1)}" r="${dragIdx === i ? 6 : 4.5}" fill="var(--accent)" stroke="rgba(255,255,255,0.92)" stroke-width="1.5" pointer-events="none"/>` +
        `<text x="${xOf(a.x).toFixed(1)}" y="${(yOf(a.y) - 9).toFixed(1)}" font-size="9" text-anchor="middle" fill="var(--accent)" font-family="ui-monospace,monospace" pointer-events="none">${Math.round(a.y)}</text>`
      ).join("");
      svg.innerHTML =
        `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="var(--accent-dim)" stroke="var(--border-2)" stroke-width="0.6" stroke-dasharray="3 4" rx="2"/>` +
        `<path d="${area}" fill="var(--accent-dim)" stroke="none" pointer-events="none"/>` +
        `<path d="${curve}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" pointer-events="none"/>` +
        ov +
        `<text x="${padL + 2}" y="${padT + 8}" font-size="8" fill="var(--text-2)" font-family="ui-monospace,monospace" pointer-events="none">${yTopLabel}</text>` +
        `<text x="${padL + 2}" y="${padT + plotH - 2}" font-size="8" fill="var(--text-2)" font-family="ui-monospace,monospace" pointer-events="none">0</text>` +
        `<text x="${padL}" y="${H - 3}" font-size="9" fill="var(--text-2)" font-family="ui-monospace,monospace" pointer-events="none">${xLeftLabel}</text>` +
        `<text x="${padL + plotW}" y="${H - 3}" font-size="9" fill="var(--text-2)" text-anchor="end" font-family="ui-monospace,monospace" pointer-events="none">${xRightLabel}</text>` +
        pts;
    };

    const commit = () => {
      this._setCurve(key, anchors);
      if (onCommit) onCommit(anchors);
      else this.simMain.setSatellitesConfig(this.getGroupsConfig(REBUILD_CATS));
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

    // Reset-to-default button — placed on the chart's title line (right-aligned) when the
    // caller passes its titleEl, else the chart's top-right corner. Restores this curve's
    // anchors to its default (a flat level, or a ramp), redraws and rebuilds.
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = "↺";
    resetBtn.title = "Reset this curve to its default";
    resetBtn.style.cssText =
      (titleEl ? "margin-left:auto;" : "position:absolute; top:1px; right:3px; z-index:2;") +
      "padding:0 6px; font-size:12px; line-height:16px;" +
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
    if (titleEl) {
      titleEl.style.display = "flex";
      titleEl.style.alignItems = "center";
      titleEl.appendChild(resetBtn);
    } else {
      host.appendChild(resetBtn);
    }

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
    this._curveRefresh[key] = () => { closeEditor(); anchors = this._getCurve(key, defaultY); dragIdx = null; overlay = { accepted: null, batch: null }; render(); };
    // Optimizer overlay setter: merge a partial {accepted?, batch?} (anchor arrays) and
    // redraw; pass null to clear. The band solver drives this live during a run.
    if (!this._curveSetOverlay) this._curveSetOverlay = {};
    this._curveSetOverlay[key] = (ov) => { overlay = ov ? { ...overlay, ...ov } : { accepted: null, batch: null }; render(); };
    render();
  }

  /**
   * Shared geometry-sample list used by the optimizer AND the sensitivity sweep, so
   * "geometry mode" means the same thing everywhere. geomCount:
   *   • 1  → [{ current: true }]  — score the live layout at `currentDateIso`.
   *   • 4  → Earth fixed 90° from the reference × Mars at {0,90,180,270}°.
   *   • 16 → Earth {0,90,180,270}° × Mars {0,90,180,270}°  (4×4 grid).
   * Offsets are ecliptic-longitude offsets from the Earth–Mars closest-approach
   * direction (applied worker-side via applyGeometryOffsets); the relay satellites are
   * held at a fixed reference phase (FIXED_GEOM_DATE) because the dense rings are
   * ~rotation-invariant. Returns plain {current} | {earthOffset,marsOffset} entries.
   */
  _buildGeometries(geomCount) {
    const ANG4 = [0, 90, 180, 270];
    if (geomCount <= 1) return [{ current: true }];
    if (geomCount === 4) return ANG4.map((m) => ({ earthOffset: 90, marsOffset: m }));
    const g = [];
    for (const e of ANG4) for (const m of ANG4) g.push({ earthOffset: e, marsOffset: m });
    return g;
  }

  /**
   * Explanatory popover for the planet-geometry selector (Sensitivity + the optimizer):
   * a 2-D schematic of the Earth & Mars orbits with the closest-approach 0° reference,
   * showing EXACTLY what `mode` samples:
   *   • "current"     → Earth & Mars at their actual current-date positions (1 scenario).
   *   • "geometry-4"  → Earth fixed at +90°, Mars at {0,90,180,270}° (4 scenarios).
   *   • "geometry-16" → Earth × Mars at {0,90,180,270}° each (16 scenarios).
   * Returns an HTML string (inline SVG + legend). Re-render when the mode changes.
   */
  _geometryHelp(mode = "geometry-4") {
    const E = this.simMain?.simSatellites?.getEarth?.() || { a: 1.00002, e: 0.0166967, p: 102.8517 };
    const M = this.simMain?.simSatellites?.getMars?.() || { a: 1.5236365, e: 0.0934231, p: 336.0882 };
    const ref = EARTH_MARS_CLOSEST_APPROACH_DEG;
    const d2r = Math.PI / 180;
    const rad = (o, L) => { const v = (L - o.p) * d2r; return (o.a * (1 - o.e * o.e)) / (1 + o.e * Math.cos(v)); };
    const W = 320, H = 230, cx = 150, cy = 115, scale = 52;
    // Ecliptic longitude L (deg) → screen (y flipped so +longitude is CCW/up).
    const P = (o, L) => ({ x: cx + rad(o, L) * Math.cos(L * d2r) * scale, y: cy - rad(o, L) * Math.sin(L * d2r) * scale });
    const orbitPath = (o) => { let d = ""; for (let L = 0; L <= 360; L += 3) { const p = P(o, L); d += (L === 0 ? "M" : "L") + p.x.toFixed(1) + " " + p.y.toFixed(1) + " "; } return d + "Z"; };
    const dot = (p, col, r2, title) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r2}" fill="${col}"><title>${title}</title></circle>`;
    // Current ecliptic longitude of a live planet (for "current" mode).
    const liveLon = (name) => {
      try {
        const planets = this.simMain?.simSolarSystem?.getSolarSystemData?.()?.planets || [];
        const p = planets.find((pl) => pl.name === name);
        if (p && p.position) { let L = (Math.atan2(p.position.y, p.position.x) * 180) / Math.PI; return ((L % 360) + 360) % 360; }
      } catch {}
      return null;
    };
    const C_E = "#4a90e2", C_M = "#ffb454", C_REF = "#5dd6a0";
    const ANG = [0, 90, 180, 270];
    let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:340px; height:auto; display:block; font-family:ui-monospace,monospace;">`;
    svg += `<path d="${orbitPath(E)}" fill="none" stroke="${C_E}" stroke-width="1.2"/>`;
    svg += `<path d="${orbitPath(M)}" fill="none" stroke="${C_M}" stroke-width="1.2"/>`;
    svg += `<circle cx="${cx}" cy="${cy}" r="3" fill="#ffd76b"><title>Sun</title></circle>`;
    // Reference (0°) direction line toward the Mars closest-approach point.
    const mref = P(M, ref);
    svg += `<line x1="${cx}" y1="${cy}" x2="${mref.x.toFixed(1)}" y2="${mref.y.toFixed(1)}" stroke="${C_REF}" stroke-width="1" stroke-dasharray="3 3"/>`;
    svg += `<text x="${(mref.x + 6).toFixed(1)}" y="${(mref.y - 4).toFixed(1)}" font-size="9" fill="${C_REF}">0°</text>`;

    let desc;
    if (mode === "current") {
      const eL = liveLon("Earth"), mL = liveLon("Mars");
      const eP = P(E, eL == null ? ref + 90 : eL), mP = P(M, mL == null ? ref : mL);
      svg += `<line x1="${eP.x.toFixed(1)}" y1="${eP.y.toFixed(1)}" x2="${mP.x.toFixed(1)}" y2="${mP.y.toFixed(1)}" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1"/>`;
      svg += dot(eP, C_E, 4.5, `Earth ${eL == null ? "" : Math.round(eL) + "°"}`);
      svg += dot(mP, C_M, 4.5, `Mars ${mL == null ? "" : Math.round(mL) + "°"}`);
      desc = `<b>Current date</b>: Earth &amp; Mars at their actual positions for the current sim date — a single scenario.`;
    } else if (mode === "geometry-16") {
      for (const off of ANG) svg += dot(P(E, ref + off), C_E, 3.5, `Earth +${off}°`);
      for (const off of ANG) svg += dot(P(M, ref + off), C_M, 3.5, `Mars +${off}°`);
      desc = `<b>×16</b>: 4 Earth × 4 Mars positions at {0, 90, 180, 270}° from the reference — 16 scenarios.`;
    } else {
      svg += dot(P(E, ref + 90), C_E, 4.5, "Earth +90° (fixed)");
      for (const off of ANG) svg += dot(P(M, ref + off), C_M, 3.5, `Mars +${off}°`);
      desc = `<b>×4</b>: Earth fixed at +90°, Mars at {0, 90, 180, 270}° from the reference — 4 scenarios.`;
    }
    svg += `</svg>`;
    const geomNote = mode === "current" ? "" :
      `<div style="margin-top:4px;">Geometry modes place the planets by orbital longitude (relay sats held at a fixed phase), decoupled from any date — so results reflect the planet geometry, not a calendar.</div>`;
    const legend =
      `<div style="font-size:11px; line-height:1.5; margin-top:6px;">` +
      `<div>${desc}</div>` +
      `<div style="margin-top:4px;"><span style="color:${C_REF};">●</span> <b>0°</b> = the Earth–Mars <b>closest approach</b> (${ref}°, narrowest orbit gap), the reference offsets are measured from.</div>` +
      geomNote +
      `<div style="margin-top:4px;"><span style="color:${C_E};">●</span> Earth &nbsp; <span style="color:${C_M};">●</span> Mars</div>` +
      `</div>`;
    return svg + legend;
  }

  /**
   * Run the adapted-ring density optimizer. Builds the current full config, fans
   * candidate band-weight vectors out across a fresh worker pool (objective-only fast
   * path), and applies the best distribution found to the curve(s).
   * opts.silent: run headless (no band-solver button/progress/revert UI) and return
   *   { applied, capacity } — used by the optimized sensitivity sweep.
   */
  async _runBandSolver(opts = {}) {
    const silent = !!opts.silent;
    if (this._bandSolverRunning) return null;
    const btn = document.getElementById("band-solver-btn");
    const stopBtn = document.getElementById("band-solver-stop");
    const prog = document.getElementById("band-solver-progress");
    const evalsInput = document.getElementById("band-solver-evals");
    const maxEvals = Math.max(20, Math.min(20000, parseInt(evalsInput?.value, 10) || 240));
    const bandCount = Math.max(2, Math.min(40, parseInt(document.getElementById("band-solver-bands")?.value, 10) || 10));
    const alpha = Math.max(0, Math.min(1, (parseFloat(document.getElementById("band-solver-alpha")?.value) || 0) / 100));
    const wFast = Math.max(0, Math.min(1, (parseFloat(document.getElementById("band-solver-fast")?.value) || 0) / 100));
    const geomCount = Math.max(1, parseInt(document.getElementById("band-solver-geom")?.value, 10) || 1);
    const aggregation = document.getElementById("band-solver-agg")?.value === "worst" ? "worst" : "mean";
    const keepBetween = document.getElementById("band-solver-keep-between")?.checked !== false; // default on
    const moveModes = [...document.querySelectorAll(".band-solver-move:checked")].map((c) => c.value);
    if (!moveModes.length) moveModes.push("single-1chart"); // fall back if the user unchecked all
    const stepScale = Math.max(0.05, Math.min(2, parseFloat(document.getElementById("band-solver-step")?.value) || 1)); // scales proposed move size

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
      if (prog) { prog.style.display = ""; prog.textContent = "Nothing to optimize — check a part (‘middle’ needs ≥3 points)."; }
      return silent ? { applied: false, capacity: 0 } : undefined;
    }
    let _off = 0;
    for (const p of plan) { p.start = _off; _off += p.free.length; } // offset in the search vector

    // Snapshot the optimized curves so the run can be reverted afterwards; clear any
    // stale revert button from a previous run.
    const initialCurves = plan.map((p) => ({ key: p.key, anchors: this._getCurve(p.key, 50).map((a) => ({ x: a.x, y: a.y })) }));
    document.getElementById("band-solver-revert")?.remove();

    this._bandSolverRunning = true;
    this._bandSolverStop = false;
    if (btn) { btn.disabled = true; btn.textContent = "Optimizing…"; }
    if (stopBtn) stopBtn.style.display = "";
    if (prog) { prog.style.display = ""; prog.textContent = "Starting…"; }

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

    // Geometry samples (shared with the sensitivity sweep via _buildGeometries):
    // 'current' scores the live layout at the current sim date; 4/16 place Earth & Mars
    // by geometry, decoupled from date, holding the relay satellites at FIXED_GEOM_DATE.
    const currentDateIso = (this.simMain?.simTime?.getDate?.() || new Date()).toISOString();
    const FIXED_GEOM_DATE = new Date(Date.UTC(2000, 0, 1)).toISOString(); // fixed satellite phase
    const geometries = this._buildGeometries(geomCount);

    // Constellation size is independent of the band weights, so estimate worker
    // heap once for the memory-admission budget.
    const seedCfg = this.simMain.simSatellites.buildConfigFromUi(baseConfig);
    const estSats = seedCfg.reduce((s, c) => s + (c.satCount || 0), 0);
    const estMB = Math.max(20, estSats * 0.016);

    const requestedWorkers = parseInt(document.getElementById("band-solver-threads")?.value, 10) || 0;
    const memPct = Math.max(10, Math.min(95, parseInt(document.getElementById("band-solver-mem")?.value, 10) || 60));
    const pool = new SensitivityPool(requestedWorkers || undefined, { memBudgetPct: memPct });
    this._bandSolverPool = pool;
    // Per-step batch = how many scenarios actually run AT ONCE: capped by BOTH the worker
    // count and the memory budget (≈ memBudget / per-scenario heap). This keeps each SA
    // step a single concurrent wave (no straggler sub-waits) and makes the eval count
    // advance by exactly what ran — e.g. 22, not 30, when memory only fits 22 of 30 workers.
    const memConcurrent = Math.max(1, Math.floor(pool.memBudgetMB / Math.max(1, estMB)));
    const batchSize = Math.min(pool.size, memConcurrent);

    // Live progress: onProgress (fired between batches, when workers are briefly
    // idle) owns the metrics line; onActivity owns the worker count and renders it
    // live, so the readout reflects threads actually running rather than the
    // momentary lull between batches.
    let active = 0;
    let lastLine = "Starting…";
    const renderProgress = () => { if (prog) prog.textContent = `${lastLine} · ${active}/${pool.size} workers`; };
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
      const per = await Promise.all(geometries.map((g) =>
        pool.submit({
          scenarioId: scenarioId++,
          uiConfig: cfg,
          simDate: g.current ? currentDateIso : FIXED_GEOM_DATE,
          sizingDate: g.current ? currentDateIso : FIXED_GEOM_DATE,
          earthAngleOffset: g.current ? null : g.earthOffset, // null → use the date's geometry (current)
          marsAngleOffset: g.current ? null : g.marsOffset,
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

    // Live constellation preview: rebuild the main display from a weight vector (the SA's
    // accepted state, or the seed for the initial conditions) so the user watches the layout
    // evolve. Throttled, and WITHOUT mutating the stored curves — so if the run ends with no
    // improvement we can restore the original view. `vizDirty` tracks whether we touched the
    // display so the no-improvement branches know to rebuild back to the original. Works in
    // both the manual optimizer and the optimized sweep (whose updateLoop stays live); it
    // only queues the config — the reactive updateLoop renders it on the next frame.
    let vizDirty = false, lastVizMs = 0, lastVizSig = "";
    const VIZ_THROTTLE_MS = 500;
    const previewAccepted = (weights, capacity) => {
      if (!weights) return;
      const sig = weights.map((w) => Math.round(w)).join(",");
      if (sig === lastVizSig) return;                       // accepted state unchanged
      const now = performance.now();
      if (now - lastVizMs < VIZ_THROTTLE_MS) return;        // bound rebuild rate
      lastVizMs = now; lastVizSig = sig;
      const cfg = this.getGroupsConfig(allCats);
      for (const p of plan) cfg[p.key] = anchorsFor(p, weights);
      // Resize Earth/Mars worst-case throughput to match THIS solution's relay capacity
      // BEFORE the rebuild, so the previewed planet rings aren't stale (auto mode only;
      // 'off' leaves them as the user set). Preview-only — does not touch the sliders.
      if (capacity > 0 && this._planetSizingMode() === "auto") {
        const pm = this._planetRingMbps(capacity);
        cfg["ring_earth.requiredmbpsbetweensats"] = pm;
        cfg["ring_mars.requiredmbpsbetweensats"] = pm;
      }
      this.simMain.setSatellitesConfig(cfg);
      vizDirty = true;
    };

    // Render the initial conditions immediately (ring/tech/curves may have just changed,
    // e.g. a new sweep scenario) so the viz starts from the right layout, not the old one.
    // Earth/Mars use their seeded values here; each accepted best then refines them below.
    previewAccepted(initialWeights);

    const { solveBandDistribution } = await import("./bandSolver.js?v=4.40");
    let result = null;
    try {
      result = await solveBandDistribution({
        initialWeights,
        evaluate,
        shouldStop: () => this._bandSolverStop,
        maxEvals,
        alpha,
        batchSize,
        moveModes,
        stepScale,
        segments: plan.map((p) => ({ start: p.start, length: p.free.length, free: p.free })), // per-chart ranges (+ x-indices for same-x moves)
        onBatch: (ws) => {
          // Live "what's cooking" cloud: map each candidate's weight vector to per-curve
          // anchors and push it as the faded batch overlay on every optimized chart.
          for (const p of plan) this._curveSetOverlay?.[p.key]?.({ batch: ws.map((w) => anchorsFor(p, w)) });
        },
        onProgress: ({ phase, metrics, evals, maxEvals, temperature, currentWeights, bestWeights }) => {
          if (phase === "calibrating") { lastLine = `Calibrating · ${evals}/${maxEvals}`; }
          else {
            const m = metrics || {};
            lastLine = `${evals}/${maxEvals} · best ${fmtCap(m.capacity || 0)} / ${fmtLat(m.latency)} · T=${temperature.toFixed(2)}`;
          }
          // Bold accepted-scenario line follows the SA chain's current (accepted) state.
          if (currentWeights) for (const p of plan) this._curveSetOverlay?.[p.key]?.({ accepted: anchorsFor(p, currentWeights) });
          // Live-rebuild the constellation from the BEST solution so the viz reflects each
          // improvement (the dedup skips ticks where the best didn't change), resizing
          // Earth/Mars to that solution's capacity first.
          previewAccepted(bestWeights, metrics?.capacity);
          renderProgress();
        },
      });
    } catch (err) {
      console.error("[BandSolver] failed:", err);
      if (prog) prog.textContent = "Failed: " + (err?.message || err);
    } finally {
      pool.terminate();
      this._bandSolverPool = null;
      this._bandSolverRunning = false;
      if (btn) { btn.disabled = false; btn.textContent = "⚙ Optimize checked"; }
      if (stopBtn) stopBtn.style.display = "none";
    }

    // The run is over — drop the live overlays (the base curve now carries the result).
    for (const p of plan) this._curveSetOverlay?.[p.key]?.(null);

    let applied = false;
    const infeasible = keepBetween && (result?.metrics?.violation || 0) > 0;
    if (result && !infeasible && result.score > result.baselineScore + 1e-9) {
      // Apply each curve's winning shape (fixed seed + optimized free parts) + rebuild.
      for (const p of plan) {
        const anchors = anchorsFor(p, result.weights).map((a) => ({ x: a.x, y: Math.round(a.y * 100) / 100 }));
        this._setCurve(p.key, anchors);
        this._curveRefresh?.[p.key]?.();
      }
      applied = true;
      // The optimized curves change the relay capacity → re-size Earth/Mars in-ring
      // rate to half the new live capacity on the rebuild's links-ready (auto mode;
      // no-op for 'off'). Arming here is what every other design change does. (The
      // optimized sweep also writes Earth/Mars explicitly from the returned capacity.)
      this._planetSizeArmed = true;
      this.simMain.setSatellitesConfig(this.getGroupsConfig(allCats));
      const b = result.baseline || {}, m = result.metrics || {};
      const baseFeasible = b.capacity > 0; // an infeasible (penalized) baseline → no meaningful % gain
      const capGain = baseFeasible ? ((m.capacity - b.capacity) / b.capacity) * 100 : null;
      const latChange = baseFeasible && isFinite(b.latency) && b.latency > 0 && isFinite(m.latency) ? ((m.latency - b.latency) / b.latency) * 100 : null;
      const capStr = capGain != null ? `${fmtCap(m.capacity || 0)} (${capGain >= 0 ? "+" : ""}${capGain.toFixed(1)}%)` : `${fmtCap(m.capacity || 0)} (from infeasible start)`;
      const latStr = latChange != null ? ` · lat ${fmtLat(m.latency)} (${latChange >= 0 ? "+" : ""}${latChange.toFixed(1)}%)` : ` · lat ${fmtLat(m.latency)}`;
      if (prog) prog.textContent = `Applied · cap ${capStr}${latStr} · ${result.evals} evals.`;
      // Offer a one-click revert to the pre-run curves (interactive mode only).
      if (!silent && prog) {
        const revertBtn = document.createElement("button");
        revertBtn.id = "band-solver-revert";
        revertBtn.type = "button";
        revertBtn.className = "btn";
        revertBtn.textContent = "↩ Revert to initial curves";
        revertBtn.style.cssText = "margin-top:6px; font-size:12px; width:100%;";
        revertBtn.addEventListener("click", () => {
          for (const ic of initialCurves) {
            this._setCurve(ic.key, ic.anchors);
            this._curveRefresh?.[ic.key]?.();
          }
          this._planetSizeArmed = true; // capacity reverts too → re-size Earth/Mars to match
          this.simMain.setSatellitesConfig(this.getGroupsConfig(allCats));
          revertBtn.remove();
          prog.textContent = "Reverted to initial curves.";
        });
        prog.parentNode.insertBefore(revertBtn, prog.nextSibling);
      }
    } else if (infeasible) {
      if (prog) prog.textContent = `Couldn't keep all rings between the orbits (best layout still had ${result.metrics.violation} inside-Earth/outside-Mars sats) · kept current. Loosen the curves or uncheck the constraint.`;
    } else if (result) {
      if (prog) prog.textContent = `No improvement after ${result.evals} evals · kept current.`;
    }
    // The live preview may have left the display on the last accepted (non-winning) state;
    // when we didn't commit a winner, rebuild from the unchanged stored curves to restore it.
    if (vizDirty && !applied) this.simMain.setSatellitesConfig(this.getGroupsConfig(allCats));

    // Headless callers (the optimized sweep) get the converged relay capacity so they
    // can size Earth/Mars and capture metrics; falls back to the baseline if the search
    // didn't improve (curves unchanged but capacity is still meaningful).
    return { applied, capacity: result?.metrics?.capacity ?? result?.baseline?.capacity ?? 0 };
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

    // Keep derived read-outs (e.g. the laser-terminal total) in sync with this change.
    this._refreshComputedReadouts();

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
        case "display.reference-lines":
          this.simMain.setReferenceLines(newValue);
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
        case "simulation.interring-matcher":
        case "simulation.route-continuity":
        case "simulation.greedy-merge-swap-degrees":
        case "circular_rings.flow-solver":
        case "eccentric_rings.flow-solver":
        case "adapted_rings.flow-solver":
        case "adapted_eccentric_rings.flow-solver":
        case "simulation.linkUpdateIntervalHours":
        case "simulation.failed-satellites-slider":
        case "relay_type.ringcount":
        case "relay_type.selected":
          // Show only the selected relay family's config section, then rebuild (the
          // shared ring count drives whichever family is active).
          this._planetSizeArmed = true; // a design change → re-size Earth/Mars on next links-ready
          this.updateRelaySectionVisibility();
        // falls through to the shared relay rebuild below
        case "adapted_eccentric_rings.requiredmbpsbetweensats":
          // Changing the adapted-eccentric in-ring worst-case rate shifts the relay
          // capacity, so re-size Earth/Mars to half the new capacity on next links-ready
          // (same trigger as a ring-count change).
          this._planetSizeArmed = true;
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
        case "adapted_rings.extra-terminals":
        case "adapted_rings.lattice":
        case "adapted_rings.ringcount":
        case "adapted_rings.trim-rings":
        case "adapted_rings.auto_route_count":
        case "adapted_rings.route_count":
        case "adapted_rings.satcount-density-routes":
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
        case "adapted_eccentric_rings.extra-terminals":
        case "adapted_eccentric_rings.cross-ring-links":
        case "adapted_eccentric_rings.ringcount":
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

        case "relay_type.planet_sizing":
          // Earth/Mars auto-size mode changed: relock/unlock the planet in-ring rows and
          // re-size them against the live relay capacity (standalone — no rebuild here;
          // runPlanetSizingStep's own slider writes trigger any needed rebuild).
          this._updatePlanetSizingLock();
          this._planetSizeArmed = true; // switching to auto → size against the current relay capacity
          this.runPlanetSizingStep();
          break;

        case "economics.satellite-cost-slider":
        case "economics.launch-cost-slider":
        case "economics.laser-terminal-cost-slider":
        case "economics.fuel-cost-ch4o2":
        case "economics.fuel-cost-argon":
        case "economics.wrights-law-factor":
        case "economics.solar-cost-per-kw":
        case "economics.radiator-cost-per-kw":
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
          const container = this.sliderContainers[depSec][depSlid];
          if (!container) return;
          if (depSlider.displayCondition) {
            const c = depSlider.displayCondition;
            const refValue = this.slidersData[depSec][c.slider].value;
            container.style.display = refValue === c.value ? "block" : "none";
          }
          if (depSlider.disabledCondition) {
            const c = depSlider.disabledCondition;
            const refValue = this.slidersData[depSec][c.slider].value;
            const on = refValue === c.value;
            container.style.opacity = on ? "" : "0.4";
            container.style.pointerEvents = on ? "" : "none";
          }
        });
      }
    }
  }

  /** Re-evaluate every live "computed" readout row (e.g. the laser-terminal total). */
  _refreshComputedReadouts() {
    if (!this._computedReadouts) return;
    for (const r of this._computedReadouts) {
      if (!r || !r.el || !r.compute) continue;
      try { r.el.textContent = String(r.compute(this)); } catch {}
    }
  }

  /** Current "Extra terminals (spacecraft)" count for an adapted ring family (≥0 int). */
  _extraTerminals(section) {
    const inp = this.sliders?.[section]?.["extra-terminals"];
    let v = inp ? parseFloat(inp.value) : this.slidersData?.[section]?.["extra-terminals"]?.value;
    v = Math.round(Number(v));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** Circular-lattice terminal count for adapted concentric: No=0 / Half=1 / Full=2. */
  _latticeTerminals() {
    const c = this.sliders?.adapted_rings?.lattice;
    let val = this.slidersData?.adapted_rings?.lattice?.value;
    if (c && c.querySelector) { const r = c.querySelector("input[type=radio]:checked"); if (r) val = r.value; }
    val = String(val || "");
    return /^No/.test(val) ? 0 : /^Half/.test(val) ? 1 : 2;
  }

  /** Total per-sat laser terminals for an adapted ring family (base + spacecraft extras). */
  _adaptedTerminalTotal(section) {
    const extra = this._extraTerminals(section);
    // concentric: 2 radial + lattice (0/1/2); eccentric: 2 in-ring + 1 junction.
    const base = section === "adapted_rings" ? 2 + this._latticeTerminals() : 3;
    return base + extra;
  }

  getGroupsConfig(categoryKeys) {
    const config = {};
    for (const categoryKey of categoryKeys) {
      const group = this.slidersData[categoryKey];
      for (const [sliderKey, sliderData] of Object.entries(group)) {
        // Non-input rows (section headers, derived read-outs) carry no config value.
        if (sliderData.type === "header" || sliderData.type === "computed") continue;
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
  // defaults flat at 100% (full Mars); inclination / eccentricity default to a 0→100
  // ramp (Earth value at the Earth side, Mars value at the Mars side); arg-perigee
  // ramps fast to 100% over the inner ~40% then holds. A default may be a flat level
  // (number) or a full anchor array.
  static get ADAPTED_CURVES() {
    const RAMP = [{ x: 0, y: 0 }, { x: 1, y: 100 }];
    const ARGPERI = [{ x: 0, y: 0 }, { x: 0.1, y: 45 }, { x: 0.2, y: 64 }, { x: 0.3, y: 84 }, { x: 0.4, y: 100 }, { x: 1, y: 100 }];
    return [
      ["adapted_rings.density-anchors", 50],
      ["adapted_rings.raan-curve", 100],
      ["adapted_rings.argperi-curve", ARGPERI],
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

    // The Fleet-link and Coverage cards are emitted as part of this panel;
    // (re)create their distribution charts now that the canvases are in the DOM.
    this.simMain?.makeFleetLinkCharts?.();
    this.simMain?.makeCoverageCharts?.();
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
