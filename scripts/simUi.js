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
        "launch_schedule",
        "launch_vehicle",
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
        const ringCount = parseFloat(
          this.sliders.adapted_rings?.ringcount?.value ?? ringData.value
        );
        this.applySimpleDefaults(ringCount, { startFeedback: true });
      },
      { toDisplay: (v) => Math.pow(2, v), toInternal: (v) => Math.round(Math.log2(v)) }
    );

    // Ring count slider — linear. Passing `{ startFeedback: true }` arms a
    // 2-iteration feedback loop that rescales the earth / mars in-ring mbps
    // to match the actual adapted-ring aggregate capacity once the worker
    // delivers a fresh capacityInfo. The feedback only fires on slider moves,
    // not on the initial applySimpleDefaults call at the bottom of this
    // method (line 638), so the direct formula alone seeds the defaults.
    const ringRow = makeSliderRow("Relay ring count", ringData, "simple-ringcount", (val) => {
      this.applySimpleDefaults(val, { startFeedback: true });
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

  applySimpleDefaults(ringCount, options = {}) {
    // Estimate adapted rings total throughput
    const lb = this.simMain.simLinkBudget;
    const rM = this.simMain.simSatellites.getMars().a;
    const rE = this.simMain.simSatellites.getEarth().a;
    const Dem = rM - rE;
    const routeCount = Math.round((ringCount * Math.sqrt(3) * Math.PI * rM) / Dem);
    const interRingAu = Dem / (ringCount + 1);
    const interRingKm = lb.convertAUtoKM(interRingAu);
    const perRouteMbps = lb.calculateGbps(interRingKm) * 1000;
    const targetMbps = routeCount * perRouteMbps;

    // Direct formula: find requiredmbpsbetweensats that yields min capacity = targetMbps
    const earthMbps = this._mbpsBetweenSatsForTargetCapacity(targetMbps, "Earth");
    const marsMbps = this._mbpsBetweenSatsForTargetCapacity(targetMbps, "Mars");

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
      const keepSec = parseFloat(document.getElementById("sens-keep-step")?.value) || 0;
      let timeStr = "";
      if (perIterMs > 0 || keepSec > 0) {
        const totalSec = Math.round(total * (perIterMs / 1000 + keepSec));
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
        const keepStepSec = parseFloat(document.getElementById("sens-keep-step")?.value) || 0;
        const showDisplay = keepStepSec >= 1;
        // When not displaying steps, suppress updateLoop to prevent stale link flashes
        if (!showDisplay) this.simMain._sensitivityRunning = true;
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
          const cur = this.slidersData.adapted_rings?.ringcount?.value ?? "?";
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
          "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "launch_vehicle",
        ]);
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

        // ── Parallel path: fan scenarios out across a worker pool. Used whenever
        //    we're not animating each constellation (the common, slow case). ──
        if (!showDisplay) {
          // Generate every scenario's uiConfig synchronously, in the SAME nested
          // order as the serial path, so simLinkBudget (tech) evolves identically
          // and the seed requiredmbps values are bit-identical. No topology here.
          const allCats = [
            "economics", "simulation", "laser_technology",
            "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "launch_vehicle",
          ];
          // Make sure simMain's cost state matches the (unswept) baseline economics
          // so calculateCosts on returned results is consistent for every scenario.
          this.simMain.setCosts(this.getGroupsConfig(["economics"]));
          this.simMain.satellitePowerKw = baseConfig["launch_vehicle.satellite-power-kw"];

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
        } else
        for (const techUserVal of techValues) {
          if (stopRequested) break;
          for (const ringCount of ringValues) {
            if (stopRequested) break;

            // Apply ring count (via simple config) and laser tech
            if (ringCount != null) this.applySimpleDefaults(ringCount);
            if (techUserVal != null) {
              const techInternal = Math.round(Math.log2(techUserVal));
              this.applySliderValues({ "laser_technology.improvement-factor": techInternal });
            }

            // Stable config for the inner date loop
            const scenarioConfig = this.getGroupsConfig([
              "economics", "simulation", "laser_technology",
              "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "launch_vehicle",
            ]);
            scenarioConfig["simulation.calctimeSec"] = 100;
            this.simMain.setSatellitesConfig(scenarioConfig);
            // Force-apply the pending satellite config so longTermRun uses it.
            // Mirror updateLoop Phase 1: invalidate cache + clear display links
            // so the rAF-driven updateLoop doesn't re-apply stale cached links.
            if (this.simMain.newSatellitesConfig) {
              this.simMain.simSatellites.setSatellitesConfig(this.simMain.newSatellitesConfig);
              this.simMain.satellitesCount = this.simMain.simSatellites.getSatellites().length;
              this.simMain.appliedSatellitesConfig = this.simMain.newSatellitesConfig;
              this.simMain.newSatellitesConfig = null;
              this.simMain.configEpoch++;
              this.simMain.windowCache.clear();
              this.simMain.displayedWindowIdx = null;
            }

            // Clear stale links immediately and update display satellites
            // so the user sees the new constellation without old links.
            if (this.simMain.simDisplay) {
              this.simMain.simDisplay.updatePossibleLinks([]);
              this.simMain.simDisplay.updateActiveLinks([]);
              // Compute positions first so setSatellites can access .x/.y/.z
              const dispDate = new Date(dateValues[0] || "2030-01-01");
              const dispPlanets = this.simMain.simSolarSystem.updatePlanetsPositions(dispDate);
              const dispSats = this.simMain.simSatellites.updateSatellitesPositions(dispDate);
              this.simMain.simDisplay.setSatellites(this.simMain.simSatellites.getSatellites());
              this.simMain.simDisplay.updatePositions(dispPlanets, dispSats);
              this.simMain.simDisplay.animate();
            }

            // --- Synchronous feedback loop for earth/mars in-ring mbps ---
            // Compute topology quickly (no flow/latency), read inring capacity,
            // adjust sliders until earth/mars match the relay aggregate.
            if (ringCount != null) {
              const fbDate = new Date(dateValues[0] || "2030-01-01");
              let prevEarthMin = -1, prevMarsMin = -1;
              for (let fbIter = 0; fbIter < 100; fbIter++) {
                const planets = this.simMain.simSolarSystem.updatePlanetsPositions(fbDate);
                const satellites = this.simMain.simSatellites.updateSatellitesPositions(fbDate);
                const links = this.simMain.simNetwork.getPossibleLinks(planets, satellites);
                const capInfo = this.simMain.calculateCapacityInfo(links);
                const rs = this.simMain.simNetwork.routeSummary;
                if (!rs || !rs.totalThroughput || rs.totalThroughput <= 0) break;

                // Detect oscillation: if capacity values are unchanged, the
                // quadratic scale can't represent a closer value — stop.
                const eInring = capInfo.ringCapacities?.["ring_earth"]?.inring || [];
                const mInring = capInfo.ringCapacities?.["ring_mars"]?.inring || [];
                const curEarth = eInring.length ? Math.round(2 * minOf(eInring)) : 0;
                const curMars = mInring.length ? Math.round(2 * minOf(mInring)) : 0;
                if (curEarth === prevEarthMin && curMars === prevMarsMin) break;
                prevEarthMin = curEarth;
                prevMarsMin = curMars;

                const outcome = this._feedbackStep(capInfo, rs.totalThroughput);
                if (outcome !== "adjusted") break;

                // Rebuild satellites with corrected config
                const newConfig = this.getGroupsConfig([
                  "economics", "simulation", "laser_technology",
                  "ring_mars", "circular_rings", "eccentric_rings", "ring_earth", "adapted_rings", "launch_vehicle",
                ]);
                newConfig["simulation.calctimeSec"] = 100;
                this.simMain.setSatellitesConfig(newConfig);
                if (this.simMain.newSatellitesConfig) {
                  this.simMain.simSatellites.setSatellitesConfig(this.simMain.newSatellitesConfig);
                  this.simMain.satellitesCount = this.simMain.simSatellites.getSatellites().length;
                  this.simMain.appliedSatellitesConfig = this.simMain.newSatellitesConfig;
                  this.simMain.newSatellitesConfig = null;
                  this.simMain.configEpoch++;
                  this.simMain.windowCache.clear();
                  this.simMain.displayedWindowIdx = null;
                }
                await new Promise((r) => setTimeout(r, 0));
              }
            }

            for (const dateStr of dateValues) {
              if (stopRequested) break;

              console.log(`[Sensitivity] longTermRun: rings=${ringCount}, tech=${techUserVal}, date=${dateStr}, sats=${this.simMain.satellitesCount}`);
              const result = await this.simMain.longTermRun(
                { from: dateStr, to: dateStr, stepDays: 1 },
                { useTimeout: true, skipDisplay: !showDisplay }
              );

              // Capture live-metrics-equivalent data for this scenario
              const costs = this.simMain.calculateCosts(
                result.data?.[0]?.maxFlowGbps ?? 0,
                this.simMain.resultTrees
              );
              const capacityInfo = this.simMain.capacityInfo;
              const rs = this.simMain.routeSummary;
              const ld = this.simMain.lastLatencyData;

              // Per-segment flow capacities (Mbps): a ring's min cross-section is
              // 2 × its narrowest in-ring link.
              const ringMin = (name) => {
                const a = capacityInfo?.ringCapacities?.[name]?.inring;
                return a && a.length ? 2 * minOf(a) : null;
              };
              // Satellites per area, aggregated from the cost trees by ring.
              let earthSats = 0, marsSats = 0, relaySats = 0;
              for (const orbit of this.simMain.resultTrees || []) {
                const rn = orbit.ringName || "";
                const c = orbit.satCount || 0;
                if (rn === "ring_earth") earthSats += c;
                else if (rn === "ring_mars") marsSats += c;
                else relaySats += c; // adapted / circular / eccentric
              }
              const metrics = {
                sats: this.simMain.satellitesCount,
                earthSats, relaySats, marsSats,
                flow: (result.data?.[0]?.maxFlowGbps ?? 0) * 1000, // achieved max-flow, Mbps
                earthFlow: ringMin("ring_earth"),
                marsFlow: ringMin("ring_mars"),
                relayFlow: rs?.totalThroughput ?? null,            // relay aggregate capacity
                cost: costs.totalCosts,
                cpf: costs.costPerMbps,
                latMin: ld?.bestLatency != null ? ld.bestLatency / 60 : null,   // minutes
                latP50: ld?.medianLatency != null ? ld.medianLatency / 60 : null,
              };

              result.scenario = {
                ringCount: ringCount ?? "(current)",
                laserTechImprovement: techUserVal ?? "(current)",
                launchDate: dateStr,
                satellites: this.simMain.satellitesCount,
              };
              result.liveMetrics = {
                satellites: this.simMain.satellitesCount,
                costs,
                metrics,
                capacityInfo: capacityInfo ? JSON.parse(JSON.stringify(capacityInfo)) : null,
                routeSummary: rs ? { ...rs } : null,
              };
              resultArray.push(result);

              // --- Push to real-time charts ---
              pushChartPoint(result.scenario, metrics);

              completed++;
              const pct = Math.round((completed / totalScenarios) * 100);
              progressBar.style.width = `${pct}%`;
              progressText.textContent = `${pct}% (${completed}/${totalScenarios})`;

              // Keep step: display links for the configured duration, then clear
              if (showDisplay) {
                await new Promise((r) => setTimeout(r, keepStepSec * 1000));
                // Clear links before the next config change
                if (this.simMain.simDisplay) {
                  this.simMain.simDisplay.updatePossibleLinks([]);
                  this.simMain.simDisplay.updateActiveLinks([]);
                }
              } else {
                await new Promise((r) => setTimeout(r, 0));
              }
            }
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
          if (slider.type === "select" || slider.type === "dropdown" || slider.type === "radio") {
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
              "launch_vehicle",
            ])
          );
          break;

        case "economics.satellite-cost-slider":
        case "economics.launch-cost-slider":
        case "economics.laser-terminal-cost-slider":
        case "economics.fuel-cost-ch4o2":
        case "economics.fuel-cost-argon":
        case "economics.wrights-law-factor":
        case "economics.solar-cost-per-kw":
        case "economics.satellite-empty-mass":
          this.simMain.setCosts(this.getGroupsConfig(["economics"]));
          break;

        default:
          // Launch-vehicle params feed the deployment / cost chain → full recompute.
          if (section === "launch_vehicle") {
            this.simMain.setSatellitesConfig(
              this.getGroupsConfig([
                "economics", "simulation", "laser_technology",
                "ring_mars", "circular_rings", "eccentric_rings",
                "ring_earth", "adapted_rings", "launch_vehicle",
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
