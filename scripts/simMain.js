// simMain.js

import { SimUi } from "./simUi.js?v=4.40";
import { SimTime } from "./simTime.js?v=4.40";
import { SimSolarSystem } from "./simSolarSystem.js?v=4.40";
import { SimSatellites } from "./simSatellites.js?v=4.40";
import { SimDeployment } from "./simDeployment.js?v=4.40";
import { SimMissionValidator } from "./simMissionValidator.js?v=4.40";
import { SimLinkBudget } from "./simLinkBudget.js?v=4.40";
import { SimNetwork } from "./simNetwork.js?v=4.40";
// Import both SimDisplay implementations with unique names
import { SimDisplay as SimDisplay2D } from "./simDisplay-2d.js?v=4.40";
import { SimDisplay as SimDisplay3D } from "./simDisplay-3d.js?v=4.40";
import { generateReport } from "./reportGenerator.js?v=4.40";
import { SIM_CONSTANTS } from "./simConstants.js?v=4.40";
import { minOf, maxOf } from "./simMath.js?v=4.40";
import { SimFlightController } from "./simFlightController.js?v=4.40";
import { SimProbeController } from "./simProbeController.js?v=4.40";
import { findDepartureWindows } from "./simTransfer.js?v=4.40";
import { EARTH_MARS_CLOSEST_APPROACH_DEG } from "./simOrbits.js?v=4.40";

export class SimMain {
  // Clamp argument to [-1, 1] to prevent NaN from Math.asin domain errors
  constructor() {
    this.newSatellitesConfig = null;
    this.appliedSatellitesConfig = null;
    this.pendingUpdates = new Set(); // tracks: 'links', 'config', 'display', 'satellites_display'

    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simLinkBudget = new SimLinkBudget();
    this.simDeployment = new SimDeployment(this.simSolarSystem.getSolarSystemData().planets);
    this.simSatellites = new SimSatellites(this.simLinkBudget, this.simSolarSystem.getSolarSystemData().planets);
    // simNetwork kept on main thread ONLY for the longTermRun batch path
    this.simNetwork = new SimNetwork(this.simLinkBudget, this.simSatellites);

    // Spacecraft-flight overlay (fleet transfers + ship link extension).
    this.simFlight = new SimFlightController();
    this._flightExtFrame = 0;
    this._flightExtVersion = 0;        // bumped each time _flightExt is recomputed
    this._fleetLinkDrawnVersion = -1;  // version the Fleet-link card/charts were last drawn for
    this.fleetLinkCharts = { cap: null, lat: null }; // Chart.js instances (expanded view)
    // Fleet-link card 3-state toggle: 'closed' | 'compact' | 'expanded'.
    this._fleetLinkState = "expanded";
    try { const s = localStorage.getItem("marslink-fleetlink-state"); if (s) this._fleetLinkState = s; } catch {}

    // Monte-Carlo coverage-field overlay (independent probes — the alternative
    // to the flight fleet). Probes are static + independent, so per-frame cost
    // is nil; the measurement against the backbone is recomputed throttled.
    this.simProbe = new SimProbeController();
    this._probeMeasFrame = 0;
    this._probeMeasVersion = 0;  // bumped each time _probeMeas is recomputed
    this._probeMeas = null;      // latest measureProbes() result (for the Coverage card)
    this._probeMeasdLinks = null; // possibleLinks ref the probes were last measured against
    this._lastProbeRender = null; // render-data ref last pushed to the display
    this._lastProbeDisplay = null; // display instance last pushed to (detect 2D↔3D switch)
    this._coverageDrawnVersion = -1; // version the Coverage card/charts were last drawn for
    this.coverageCharts = { cap: null, lat: null, relayCap: null, relayLat: null }; // Chart.js instances (expanded)
    // Coverage card 3-state toggle: 'closed' | 'compact' | 'expanded'.
    this._coverageState = "compact";
    try { const s = localStorage.getItem("marslink-coverage-state"); if (s) this._coverageState = s; } catch {}

    // Start the clock mid-transfer so flights are visible on load: the next
    // Earth→Mars departure window + 3 months (rather than "now", which usually
    // sits between windows with no ships in flight).
    this._setInitialSimDate();

    // Debug handle: lets the console / preview inspect live sim state.
    if (typeof window !== "undefined") window.simMain = this;

    // --- Worker + triple-buffered window cache (-1/0/+1) ---
    this.simWorker = new Worker(new URL("./simWorker.js?v=4.40", import.meta.url), { type: "module" });
    this.simWorker.onmessage = (event) => this.handleWorkerMessage(event);
    this.simWorker.onerror = (event) => console.error("[Marslink] Worker error:", event.message);
    this.simWorker.postMessage({ type: "init" });
    this.workerReady = false;
    this.workerBusy = false;
    this.lastRequestId = 0;
    this.inFlightWindowIdx = null; // windowIdx currently being computed by worker

    // Recalc status (bottom-bar indicator): which phase the worker is in and
    // how long the last run of each phase took (used to drive the progress bar).
    this.recalcPhase = "idle"; // "idle" | "links" | "flow"
    this.recalcStart = 0;       // performance.now() when the current phase began
    this._inFlightComputeFlow = false; // whether the in-flight compute includes flow
    this._lastLinksMs = 0;     // measured links-phase duration of the last run
    this._estLinksMs = 0;      // estimate shown for the links phase
    this._estFlowMs = 0;       // estimate shown for the flow phase

    // Window cache: Map<windowIdx, { configEpoch, ...result }>
    this.WINDOW_DURATION = 1000 * 60 * 60 * 24; // 24h sim time
    this.windowCache = new Map();
    this.configEpoch = 0;
    this.displayedWindowIdx = null;
    this.previousSimDate = 0; // for detecting time direction
    this.simTimePausedForCache = false; // true when waiting for a cache window

    // Do not instantiate simDisplay here; it will be set by setDisplayType
    this.simDisplay = null;
    this.linksColors = null;
    this.satelliteColorMode = "Quad";
    this.thrustBodies = ""; // iso-thrust contour bodies (2D), comma list; "" = off
    this.planetOrbits = ""; // planet orbit toggle ("Show" = on) — true ellipses from elements
    // Reference lines drawn through the Sun (2D + 3D), as a comma list of enabled
    // options: "Closest approach" | "Mars apsides" | "Plane nodes" | "Earth apsides".
    this.referenceLines = "";
    this.geostationaryOrbits = ""; // geostationary orbit circles (Earth/Mars comma list)
    this.satLabelMode = false; // per-satellite value labels (S key)
    // Station-keeping model config { F (N), tm (kg), maxN, n (yr), isp (s), capacity (kg) }
    this.skCfg = { F: 0.17, tm: 15, maxN: 64, n: 5, isp: 2500, capacity: 1500 };
    this.sunSizeFactor = 1;
    this.planetsSizeFactor = 1;
    this.satelliteSizeFactor = 1;

    this.previousCalctimeMs = this.simLinkBudget.calctimeMs;

    this.ui = new SimUi(this);
    console.log("[Marslink] Simulation initialized");

    this.latencyChartInstance = null;
    this.missionProfiles = null;
    this.resultTrees = [];
    this.capacityInfo = null;
    this.routeSummary = null;
    this.lastNetworkData = null;
    this.maxFlowGbps = 0;

    this.startSimulationLoop();
  }

  /**
   * Sets the display type, creating the appropriate SimDisplay instance.
   * Disposes of the previous instance if it exists.
   * @param {string} type - "2d" or "3d"
   */
  setDisplayType(type) {
    // Dispose of the current display if it has a dispose method
    if (this.simDisplay && typeof this.simDisplay.dispose === "function") {
      this.simDisplay.dispose();
    }

    // Create new display based on type
    if (type === "2d") {
      this.simDisplay = new SimDisplay2D();
    } else if (type === "3d") {
      this.simDisplay = new SimDisplay3D();
    } else {
      console.error("Invalid display type:", type);
      return;
    }
    this.simDisplay.simSatellites = this.simSatellites;
    this.simDisplay.setLinksColors(this.linksColors);
    this.simDisplay.setSizeFactors(this.sunSizeFactor, this.planetsSizeFactor, this.satelliteSizeFactor);
    if (typeof this.simDisplay.setRoadsterSizeFactor === "function") this.simDisplay.setRoadsterSizeFactor(this.roadsterSizeFactor);
    this.simDisplay.setSatelliteColorMode(this.satelliteColorMode);
    if (typeof this.simDisplay.setThrustBodies === "function") this.simDisplay.setThrustBodies(this.thrustBodies);
    this.pushSatellitePhysics();
    if (typeof this.simDisplay.setPlanetOrbits === "function") this.simDisplay.setPlanetOrbits(this.planetOrbits);
    if (typeof this.simDisplay.setReferenceLines === "function") {
      this.simDisplay.setReferenceLines(this.referenceLines, this._referenceLineAngles());
    }
    if (typeof this.simDisplay.setGeostationaryOrbits === "function") this.simDisplay.setGeostationaryOrbits(this.geostationaryOrbits);
    if (typeof this.simDisplay.setSatLabelMode === "function") this.simDisplay.setSatLabelMode(this.satLabelMode);

    this.pendingUpdates.add('links');
  }

  setLinksColors(type) {
    if (type !== this.linksColors) {
      this.pendingUpdates.add('display');
      this.pendingUpdates.add('links');
    }
    this.linksColors = type;
    if (this.simDisplay) this.simDisplay.setLinksColors(type);
    if (this.simDisplay && this.planets) this.simDisplay.updatePositions(this.planets, this.satellites);
  }

  setSatelliteColorMode(mode) {
    this.satelliteColorMode = mode;
    if (this.simDisplay) this.simDisplay.setSatelliteColorMode(mode);
    this.pendingUpdates.add('display');
    this.pendingUpdates.add('satellites_display');
    if (this.simDisplay && this.planets) this.simDisplay.updatePositions(this.planets, this.satellites);
  }

  setThrustBodies(value) {
    this.thrustBodies = value;
    if (this.simDisplay && typeof this.simDisplay.setThrustBodies === "function") {
      this.simDisplay.setThrustBodies(value);
    }
  }

  setPlanetOrbits(value) {
    this.planetOrbits = value;
    if (this.simDisplay && typeof this.simDisplay.setPlanetOrbits === "function") {
      this.simDisplay.setPlanetOrbits(value);
    }
  }

  setReferenceLines(value) {
    this.referenceLines = value;
    if (this.simDisplay && typeof this.simDisplay.setReferenceLines === "function") {
      this.simDisplay.setReferenceLines(value, this._referenceLineAngles());
    }
  }

  setGeostationaryOrbits(value) {
    this.geostationaryOrbits = value;
    if (this.simDisplay && typeof this.simDisplay.setGeostationaryOrbits === "function") {
      this.simDisplay.setGeostationaryOrbits(value);
    }
  }

  setSatLabelMode(on) {
    this.satLabelMode = !!on;
    if (this.simDisplay && typeof this.simDisplay.setSatLabelMode === "function") {
      this.simDisplay.setSatLabelMode(this.satLabelMode);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("marslink:sat-label-mode", { detail: { on: this.satLabelMode } }));
    }
  }

  /**
   * Build a per-ring { dryMass, skProp } map (dry mass + station-keeping argon
   * budget, kg) and push it to the display with the satellite Isp & thrust, for
   * the mass/thrust satellite colour schemes (Accel / Thrust / Thrust% / Time).
   */
  pushSatellitePhysics() {
    if (!this.simDisplay || typeof this.simDisplay.setSatellitePhysics !== "function") return;
    if (!this.simDeployment || !this.simDeployment.dryMasses) return;
    // Read the per-ring station-keeping baselines computed by computeStationKeeping
    // (must run first, in the configJustApplied block), add laser-port counts.
    const ringData = (this.simDeployment && this.simDeployment.ringStationKeeping) || {};
    // Per-ring non-SK propellant (transfer + deorbit) from the latest deployment
    // profile = loaded − station-keeping; used by the 'Total prop' colour scheme.
    const nonSkByRing = {};
    const mp = this.missionProfiles;
    if (mp && mp.byOrbit) for (const o of mp.byOrbit) {
      const v = o.vehicles && o.vehicles.Satellites;
      if (v) nonSkByRing[o.ringName] = Math.max(0, (v.propellantLoaded_kg || 0) - (v.stationKeepingArgon_kg || 0));
    }
    const map = {};
    let maxPorts = 1;
    const portsSet = new Set();
    for (const rn in ringData) {
      const ports = (this.simLinkBudget && this.simLinkBudget.getMaxLinksPerRing(rn)) || 0;
      const nonSk = nonSkByRing[rn] || 0;
      const rd = ringData[rn];
      // SK propellant available = capacity − other prop. Other ≈ (dry+SK)·k where k is
      // the transfer+deorbit factor; solving total ≤ capacity → cap = (C − dry·k)/(1+k).
      const k = nonSk / Math.max(1, rd.dryMass + (rd.skPropRing || 0));
      const capAvailable = Math.max(0, ((this.skCfg.capacity || 1500) - rd.dryMass * k) / (1 + k));
      map[rn] = { ...rd, ports, nonSkFuel: nonSk, capAvailable }; // dryMass, aAvg, nRing, skPropRing, aThreshold, ports, nonSkFuel, capAvailable
      if (ports > maxPorts) maxPorts = ports;
      if (ports > 0) portsSet.add(ports);
    }
    this.simDisplay.setSatellitePhysics(map, this.skCfg);
    this.simDisplay.satLaserMax = maxPorts; // fleet max laser terminals (Lasers scale/legend)
    this.simDisplay.satLaserValues = [...portsSet].sort((a, b) => a - b);
    this.simDisplay.satThrusterMax = (this.simDeployment && this.simDeployment.maxThrusterCount) || 1;
  }

  /**
   * Refresh the per-ring non-SK propellant (transfer + deorbit = loaded − SK) on the
   * display's satPhysics from the latest mission profile, for the 'Total prop' scheme.
   * Called when the worker delivers new mission profiles (which arrive after the
   * initial pushSatellitePhysics, so nonSkFuel would otherwise stay 0).
   */
  updateSatelliteFuel() {
    const phys = this.simDisplay && this.simDisplay.satPhysics;
    const mp = this.missionProfiles;
    if (!phys || !mp || !mp.byOrbit) return;
    const cap = (this.skCfg && this.skCfg.capacity) || 1500;
    for (const o of mp.byOrbit) {
      const v = o.vehicles && o.vehicles.Satellites;
      const r = phys[o.ringName];
      if (!v || !r) continue;
      const nonSk = Math.max(0, (v.propellantLoaded_kg || 0) - (v.stationKeepingArgon_kg || 0));
      r.nonSkFuel = nonSk;
      const k = nonSk / Math.max(1, r.dryMass + (r.skPropRing || 0)); // transfer+deorbit prop factor
      r.capAvailable = Math.max(0, (cap - r.dryMass * k) / (1 + k)); // SK prop the tank leaves
    }
  }

  /**
   * Sets the time acceleration factor for the simulation.
   *
   * @param {number} timeAccelerationFactor - Factor by which simulated time progresses.
   *                                          e.g., 2 means time runs twice as fast.
   */
  setTimeAccelerationFactor(timeAccelerationFactor) {
    this.simTime.setTimeAccelerationFactor(timeAccelerationFactor);
  }

  /**
   * Sets the sun size factor for the display.
   *
   * @param {number} factor - Multiplier for sun size.
   */
  setSunSizeFactor(factor) {
    this.sunSizeFactor = factor;
    if (this.simDisplay && typeof this.simDisplay.setSizeFactors === "function") {
      this.simDisplay.setSizeFactors(this.sunSizeFactor, this.planetsSizeFactor, this.satelliteSizeFactor);
    }
  }

  /**
   * Sets the planets size factor for the display.
   *
   * @param {number} factor - Multiplier for planets size.
   */
  setPlanetsSizeFactor(factor) {
    this.planetsSizeFactor = factor;
    if (this.simDisplay && typeof this.simDisplay.setSizeFactors === "function") {
      this.simDisplay.setSizeFactors(this.sunSizeFactor, this.planetsSizeFactor, this.satelliteSizeFactor);
    }
  }

  /**
   * Sets the satellites size factor for the display.
   *
   * @param {number} factor - Multiplier for satellites size.
   */
  setSatelliteSizeFactor(factor) {
    this.satelliteSizeFactor = factor;
    if (this.simDisplay && typeof this.simDisplay.setSizeFactors === "function") {
      this.simDisplay.setSizeFactors(this.sunSizeFactor, this.planetsSizeFactor, this.satelliteSizeFactor);
    }
  }

  setRoadsterSizeFactor(factor) {
    this.roadsterSizeFactor = factor;
    if (this.simDisplay && typeof this.simDisplay.setRoadsterSizeFactor === "function") {
      this.simDisplay.setRoadsterSizeFactor(factor);
    }
  }

  setSatellitesConfig(uiConfig) {
    this._lastUiConfig = uiConfig;
    const satellitesConfig = [];

    // Link update interval slider → window duration for the -1/0/+1 cache
    const linkUpdateHours = uiConfig["simulation.linkUpdateIntervalHours"];
    if (typeof linkUpdateHours === "number" && linkUpdateHours > 0) {
      const newDuration = linkUpdateHours * 60 * 60 * 1000;
      if (newDuration !== this.WINDOW_DURATION) {
        this.WINDOW_DURATION = newDuration;
        // Window boundaries changed — invalidate cache
        this.windowCache.clear();
        this.displayedWindowIdx = null;
        this.pendingUpdates.add("links");
      }
    }

    this.simLinkBudget.setTechnologyConfig(uiConfig);
    if (this.simLinkBudget.calctimeMs !== this.previousCalctimeMs) {
      this.pendingUpdates.add('links');
      this.previousCalctimeMs = this.simLinkBudget.calctimeMs;
    }
    this.simDeployment.setVehicleConfig(uiConfig);
    this.satellitePowerKw = uiConfig["satellite.satellite-power-kw"]; // for solar cost
    this.skCfg = {
      F: (uiConfig["satellite.satellite-thrust"] || 170) / 1000, // mN → N
      tm: uiConfig["satellite.thruster-system-mass"] >= 0 ? uiConfig["satellite.thruster-system-mass"] : 15,
      maxN: uiConfig["satellite.max-thrusters"] >= 1 ? uiConfig["satellite.max-thrusters"] : 64,
      n: uiConfig["satellite.sk-years"] >= 1 ? uiConfig["satellite.sk-years"] : 5,
      isp: uiConfig["satellite.satellite-isp"] || 2500,
      capacity: uiConfig["satellite.satellite-propellant-capacity"] || 1500,
    };
    // Per-ring TOTAL terminal counts (radial/in-ring + lattice/junction + spacecraft
    // extras) live on simLinkBudget after setTechnologyConfig above; use them so dry mass
    // matches the cost/topology terminal budget for the adapted families too.
    this.simDeployment.setSatelliteMassConfig(
      uiConfig["satellite.satellite-empty-mass"],
      uiConfig["laser_technology.laser-terminal-mass"],
      this.simLinkBudget.maxLinksPerRing
    );

    this.simSatellites.setMaxSatCount(uiConfig["simulation.maxSatCount"]);

    // Array shape is built by SimSatellites (shared with the parallel sensitivity
    // worker) so the live path and batch path can never drift.
    satellitesConfig.push(...this.simSatellites.buildConfigFromUi(uiConfig));

    this.newSatellitesConfig = satellitesConfig;
  }

  removeLinks() {
    this.simDisplay.updateActiveLinks([]);
    this.simDisplay.updatePossibleLinks([]);
  }

  /**
   * Creates or updates the latency histogram chart.
   *
   * @param {Object} latencyData - The latency data containing histogram, bestLatency, averageLatency.
   */
  makeLatencyChart(latencyData, binSize) {
    // Destroy previous instance — the canvas is recreated in getCostsHtml each render
    if (this.latencyChartInstance) {
      this.latencyChartInstance.destroy();
      this.latencyChartInstance = null;
    }

    if (!latencyData) return;

    const canvas = document.getElementById("latencyChart");
    if (!canvas) return;

    const labels = latencyData.histogram.map((bin) => {
      const startMin = bin.latency / 60;
      const endMin = (bin.latency + binSize) / 60;
      return `${startMin} - ${endMin} min`;
    });
    const data = latencyData.histogram.map((bin) => bin.totalGbps);

    // Theme colors matching the app's dark UI
    const textMuted = "#7c879f";   // --text-2
    const textDim = "#525c75";     // --text-3
    const gridColor = "rgba(255, 255, 255, 0.06)";
    const accentBar = "rgba(107, 138, 253, 0.55)";  // --accent at ~55%
    const accentHover = "rgba(142, 166, 255, 0.75)"; // --accent-hot at ~75%
    const tooltipBg = "#1a2030";   // --bg-3

    this.latencyChartInstance = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: accentBar,
          hoverBackgroundColor: accentHover,
          borderRadius: 2,
          barPercentage: 0.9,
          categoryPercentage: 0.85,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 4, right: 4, bottom: 0, left: 0 } },
        scales: {
          x: {
            title: { display: true, text: "Latency (min)", color: textMuted, font: { size: 10 } },
            ticks: { color: textDim, font: { size: 9 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 8 },
            grid: { display: false },
            border: { color: gridColor },
          },
          y: {
            title: { display: true, text: "Gbps", color: textMuted, font: { size: 10 } },
            ticks: { color: textDim, font: { size: 9 }, maxTicksLimit: 5 },
            grid: { color: gridColor },
            border: { display: false },
            beginAtZero: true,
          },
        },
        plugins: {
          tooltip: {
            backgroundColor: tooltipBg,
            titleColor: "#eef1f7",
            bodyColor: "#b9c0d0",
            borderColor: "rgba(255,255,255,0.1)",
            borderWidth: 1,
            cornerRadius: 4,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            padding: 8,
            callbacks: { label: (ctx) => `${ctx.parsed.y} Gbps` },
          },
          legend: { display: false },
        },
      },
    });
  }

  setCosts(costConfig) {
    this.costPerLaunch = costConfig["economics.launch-cost-slider"];
    this.costPerSatellite = costConfig["economics.satellite-cost-slider"];
    this.costPerLaserTerminal = costConfig["economics.laser-terminal-cost-slider"];
    this.wrightsLawFactor = (costConfig["economics.wrights-law-factor"] || 100) / 100;
    this.propellantCostsPerKg = {
      "CH4/O2": costConfig["economics.fuel-cost-ch4o2"],
      Argon: costConfig["economics.fuel-cost-argon"],
    };
    this.solarCostPerKw = costConfig["economics.solar-cost-per-kw"]; // $M per kW (at Earth aphelion; scaled by apoapsis²)
    this.radiatorCostPerKw = costConfig["economics.radiator-cost-per-kw"]; // $M per kW (at Earth aphelion; scaled by 1/perihelion²)
    // Rebuild resultTrees so propellant costs are recalculated from current slider values
    if (this.missionProfiles) {
      this.resultTrees = new SimMissionValidator(this.missionProfiles, {
        costPerLaunch: this.costPerLaunch,
        costPerSatellite: this.costPerSatellite,
        costPerLaserTerminal: this.costPerLaserTerminal,
        laserPortsPerRing: this.simLinkBudget.maxLinksPerRing,
        propellantCostsPerKg: this.propellantCostsPerKg,
        wrightsLawFactor: this.wrightsLawFactor,
      });
    }
    if (this.ui) this.ui.updateInfoAreaCosts(this.getCostsHtml(this.calculateCosts(this.maxFlowGbps, this.resultTrees), this.lastNetworkData, null));
  }

  calculateCosts(maxFlowGbps, resultTrees) {
    let totalSatellitesCount = 0;
    let totalLaunchCount = 0;
    let totalLaunchCost = 0;
    let totalPropellantCost = 0;
    let totalSatellitesCost = 0;
    let totalLaserTerminalsCost = 0;
    let propellantCostBreakdown = {};
    let propellantMassBreakdown = {};

    let totalDeploymentFlights = 0;
    let totalTankerFlights = 0;
    let totalLaserCount = 0;

    for (const orbit of resultTrees) {
      totalSatellitesCount += orbit.satCount || 0;
      totalLaserCount += (orbit.satCount || 0) * (this.simLinkBudget.getMaxLinksPerRing(orbit.ringName) || 0);
      const flights = orbit.deploymentFlights_count || 0;
      const tankersPerFlight = orbit.vehicles ? Object.keys(orbit.vehicles).filter((k) => k.startsWith("Tanker")).length : 0;
      totalDeploymentFlights += flights;
      totalTankerFlights += flights * tankersPerFlight;
      totalLaunchCount += flights * (1 + tankersPerFlight);
      totalLaunchCost += orbit.launchCost;
      totalPropellantCost += orbit.propellantCost;
      totalSatellitesCost += orbit.satellitesCost;
      totalLaserTerminalsCost += orbit.laserTerminalsCost;
      if (orbit.propellantCostBreakdown) {
        for (const [type, cost] of Object.entries(orbit.propellantCostBreakdown)) {
          if (!propellantCostBreakdown[type]) propellantCostBreakdown[type] = 0;
          propellantCostBreakdown[type] += cost;
        }
      }
      // Accumulate propellant mass per type
      if (orbit.vehicles) {
        for (const vehicle of Object.values(orbit.vehicles)) {
          const pType = vehicle.propellantType;
          if (!pType) continue;
          const massKg =
            ((vehicle.count ? vehicle.count * vehicle.propellantLoaded_kg : vehicle.propellantLoaded_kg) +
            (vehicle.count ? vehicle.count * (vehicle.tankerPropellant_kg || 0) : (vehicle.tankerPropellant_kg || 0)))
            * (orbit.deploymentFlights_count || 1);
          if (!propellantMassBreakdown[pType]) propellantMassBreakdown[pType] = 0;
          propellantMassBreakdown[pType] += massKg;
        }
      }
    }

    // Thermal hardware, distance-scaled and launch-independent (apples-to-apples across orbit
    // families). Solar array is sized for the LOWEST flux (aphelion) → cost ∝ apoapsis²; the
    // radiator is sized for the HIGHEST flux (perihelion) → cost ∝ 1/perihelion². Both are
    // normalized to Earth's aphelion (matching solarPanelMassKg). An eccentric ring pays BOTH
    // extremes at once (big array AND big radiator); a concentric ring, at a single radius, pays
    // only one — so this charges the eccentric dual-thermal premium as hardware, not via launch.
    const els = (this.simSatellites && this.simSatellites.getOrbitalElements && this.simSatellites.getOrbitalElements()) || [];
    const earthApo = (this.simSatellites && this.simSatellites.apsidesEarth && this.simSatellites.apsidesEarth.apoapsis) || 1;
    const apsisByRing = {};
    for (const el of els) {
      if (!el || !el.ringName || !el.apsides) continue;
      const apoPct = el.apsides.apo_pctEarth > 0 ? el.apsides.apo_pctEarth : 1;
      const periPct = el.apsides.periapsis > 0 ? el.apsides.periapsis / earthApo : apoPct;
      apsisByRing[el.ringName] = { apoPct, periPct: Math.max(0.1, periPct) };
    }
    const powerKw = this.satellitePowerKw || 0;
    const solarPerKw = (this.solarCostPerKw || 0) * 1_000_000;
    const radPerKw = (this.radiatorCostPerKw || 0) * 1_000_000;
    let totalSolarCost = 0;
    let totalRadiatorCost = 0;
    for (const orbit of resultTrees) {
      const n = orbit.satCount || 0;
      const ap = apsisByRing[orbit.ringName] || { apoPct: 1, periPct: 1 };
      totalSolarCost += n * powerKw * solarPerKw * ap.apoPct * ap.apoPct; // array ∝ apoapsis²
      totalRadiatorCost += (n * powerKw * radPerKw) / (ap.periPct * ap.periPct); // radiator ∝ 1/perihelion²
    }

    const totalCosts = totalLaunchCost + totalPropellantCost + totalSatellitesCost + totalLaserTerminalsCost + totalSolarCost + totalRadiatorCost;

    // Wright's law savings: difference between no-learning cost (c1 * n) and actual
    const noLearningLaunch = (this.costPerLaunch || 0) * 1_000_000 * totalLaunchCount;
    const noLearningSat = (this.costPerSatellite || 0) * 1_000_000 * totalSatellitesCount;
    const noLearningLaser = (this.costPerLaserTerminal || 0) * 1_000_000 * totalLaserCount;
    const noLearningTotal = noLearningLaunch + noLearningSat + noLearningLaser + totalPropellantCost + totalSolarCost + totalRadiatorCost;
    const wrightSavings = noLearningTotal - totalCosts;

    let costPerMbps = Infinity;
    if (maxFlowGbps) costPerMbps = Math.round(totalCosts / (maxFlowGbps * 1000));

    return {
      satellitesCount: totalSatellitesCount,
      launchCount: totalLaunchCount,
      deploymentFlights: totalDeploymentFlights,
      tankerFlights: totalTankerFlights,
      laserCount: totalLaserCount,
      launchCost: totalLaunchCost,
      propellantCost: totalPropellantCost,
      satellitesCost: totalSatellitesCost,
      laserTerminalsCost: totalLaserTerminalsCost,
      solarCost: totalSolarCost,
      radiatorCost: totalRadiatorCost,
      totalCosts,
      costPerMbps,
      propellantCostBreakdown,
      propellantMassBreakdown,
      wrightSavings,
      noLearningTotal,
    };
  }

  /**
   * Shared vertical Earth→relay→Mars data-path SVG, used by BOTH the Capacity and the Flow
   * cards. The skeleton is identical for both — one column per relay ring (single bars =
   * junctions; double bars = an eccentric ring's two routes; thick single = a concentric
   * ring's route), colour-coded planets, planet ring lines. Only the per-segment LABELS and
   * the planet ground-link numbers differ (link capacity vs achieved flow), so callers pass
   * pre-formatted label strings and the two cards stay visually in lock-step. Self-contained
   * (explicit colours), so it renders identically in the panel and anywhere it's reused.
   *
   * @param d.relayRingCount  number of relay rings (0 ⇒ draws the "no relay" broken path)
   * @param d.isEccentric     true ⇒ double route bars; false ⇒ thick single route bars
   * @param d.earthSide1/2, d.marsSide1/2  the two busiest planet ground-link values
   * @param d.fmtNum          formatter for the small planet-side numbers
   * @param d.labels          pre-formatted strings, any of which may be null to skip:
   *                          earthTotal, ringEarth, earthJunction, relayMain, relayL1..L3,
   *                          marsJunction, ringMars, marsTotal, bottleneck, noRelayMain,
   *                          noRelaySub
   */
  _relayPathSvg(d) {
    const { relayRingCount, isEccentric, fmtNum,
            earthSide1 = 0, earthSide2 = 0, marsSide1 = 0, marsSide2 = 0, labels = {} } = d;

    const W = 365, barL = 12, barR = 150, labelX = 158, H = 208;
    const EARTH = "#4d97e0", MARS = "#e07a52", RELAY = "#8893a0",
          EARTH_LN = "#3f6d92", MARS_LN = "#8a5a48", // muted planet-tinted ring lines
          TXT = "#c9ced6", MUT = "#868d97", WARN = "#e0b352", BG = "#181b21";

    const Y = { eg: 16, er: 34, ej: 51, r0: 70, r1: 88, r2: 106, r3: 124, mj: 143, mr: 160, mg: 178, bn: 196 };
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const txt = (x, y, t, fill = TXT, size = 11, anchor = "start") =>
      t == null || t === "" ? "" : `<text x="${x}" y="${(y + 3.5).toFixed(1)}" fill="${fill}" font-size="${size}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}>${esc(t)}</text>`;

    let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Earth to Mars relay path" style="width:100%;height:auto;font-family:ui-monospace,Menlo,Consolas,monospace;">`;
    s += `<rect x="0" y="0" width="${W}" height="${H}" rx="7" fill="${BG}"/>`;
    s += `<line x1="${barL}" y1="${Y.er}" x2="${barR}" y2="${Y.er}" stroke="${EARTH_LN}" stroke-width="1"/>`;
    s += `<line x1="${barL}" y1="${Y.mr}" x2="${barR}" y2="${Y.mr}" stroke="${MARS_LN}" stroke-width="1"/>`;

    // No relay family active (0 relay rings): the planet rings exist but nothing bridges
    // them, so there is no Earth↔Mars path. Draw both rings + planets and a broken, dashed
    // connector with an ✕ where the relay should be, and flag the missing relay below.
    if (!relayRingCount) {
      const pcx = barL + (barR - barL) / 2;
      const slot0 = (barR - barL) / 9;
      const eX = +(pcx - slot0).toFixed(1), mX = +(pcx + slot0).toFixed(1);
      const midY = (Y.er + Y.mr) / 2;
      s += `<line x1="${pcx}" y1="${Y.er + 9}" x2="${pcx}" y2="${(midY - 11).toFixed(1)}" stroke="${WARN}" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.75"/>`;
      s += `<line x1="${pcx}" y1="${(midY + 11).toFixed(1)}" x2="${pcx}" y2="${Y.mr - 9}" stroke="${WARN}" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.75"/>`;
      s += `<line x1="${pcx - 5}" y1="${midY - 5}" x2="${pcx + 5}" y2="${midY + 5}" stroke="${WARN}" stroke-width="1.6"/>`;
      s += `<line x1="${pcx - 5}" y1="${midY + 5}" x2="${pcx + 5}" y2="${midY - 5}" stroke="${WARN}" stroke-width="1.6"/>`;
      s += `<circle cx="${eX}" cy="${Y.er}" r="5.5" fill="${EARTH}"/>`;
      s += `<circle cx="${mX}" cy="${Y.mr}" r="4" fill="${MARS}"/>`;
      s += txt(eX, Y.eg, labels.earthTotal, EARTH, 12, "middle");
      s += txt(labelX, Y.er, labels.ringEarth, EARTH);
      s += txt(labelX, midY - 6, labels.noRelayMain || "no relay rings", WARN, 12);
      s += txt(labelX, midY + 11, labels.noRelaySub || "no Earth↔Mars path", MUT, 11);
      s += txt(labelX, Y.mr, labels.ringMars, MARS);
      s += txt(mX, Y.mg, labels.marsTotal, MARS, 12, "middle");
      s += txt(barL, Y.bn, labels.bottleneck, WARN);
      s += `</svg>`;
      return s;
    }

    // One column per relay ring, capped at 9 (1 ring → 1 junction · 1 double route · 1 junction).
    const C = Math.max(1, Math.min(relayRingCount || 1, 9));
    const colW = (barR - barL) / C;
    const slot = (barR - barL) / 9; // fixed planet offset (~one 9-col slot), independent of C
    for (let i = 0; i < C; i++) {
      const cx = barL + (i + 0.5) * colW;
      s += `<line x1="${cx.toFixed(1)}" y1="${Y.er + 9}" x2="${cx.toFixed(1)}" y2="${Y.r0 - 9}" stroke="${EARTH}" stroke-width="1.6" stroke-linecap="round"/>`;
      if (isEccentric) {
        s += `<line x1="${(cx - 1.8).toFixed(1)}" y1="${Y.r0 - 8}" x2="${(cx - 1.8).toFixed(1)}" y2="${Y.r3 + 8}" stroke="${RELAY}" stroke-width="1.5"/>`;
        s += `<line x1="${(cx + 1.8).toFixed(1)}" y1="${Y.r0 - 8}" x2="${(cx + 1.8).toFixed(1)}" y2="${Y.r3 + 8}" stroke="${RELAY}" stroke-width="1.5"/>`;
      } else {
        s += `<line x1="${cx.toFixed(1)}" y1="${Y.r0 - 8}" x2="${cx.toFixed(1)}" y2="${Y.r3 + 8}" stroke="${RELAY}" stroke-width="3.2"/>`;
      }
      s += `<line x1="${cx.toFixed(1)}" y1="${Y.r3 + 9}" x2="${cx.toFixed(1)}" y2="${Y.mr - 9}" stroke="${MARS}" stroke-width="1.6" stroke-linecap="round"/>`;
    }
    const pcx = barL + (barR - barL) / 2;
    const eX = +(pcx - slot).toFixed(1), mX = +(pcx + slot).toFixed(1); // planets offset: Earth one slot left, Mars one slot right
    s += `<circle cx="${eX.toFixed(1)}" cy="${Y.er}" r="5.5" fill="${EARTH}"/>`;
    s += txt(eX - 10, Y.er, fmtNum(earthSide1 || 0), EARTH_LN, 11, "end");
    s += txt(eX + 10, Y.er, fmtNum(earthSide2 || 0), EARTH_LN, 11);
    s += `<circle cx="${mX.toFixed(1)}" cy="${Y.mr}" r="4" fill="${MARS}"/>`;
    s += txt(mX - 9, Y.mr, fmtNum(marsSide1 || 0), MARS_LN, 11, "end");
    s += txt(mX + 9, Y.mr, fmtNum(marsSide2 || 0), MARS_LN, 11);
    // Earth/Mars totals sit centred over/under their planet; per-segment values run down
    // the right column, each coloured to match its diagram element (Earth, relay, Mars).
    s += txt(eX, Y.eg, labels.earthTotal, EARTH, 12, "middle");
    s += txt(labelX, Y.er, labels.ringEarth, EARTH);
    s += txt(labelX, Y.ej, labels.earthJunction, EARTH);
    s += txt(labelX, Y.r0, labels.relayMain, RELAY, 12);
    s += txt(labelX, Y.r1, labels.relayL1, RELAY);
    s += txt(labelX, Y.r2, labels.relayL2, RELAY);
    s += txt(labelX, Y.r3, labels.relayL3, RELAY);
    s += txt(labelX, Y.mj, labels.marsJunction, MARS);
    s += txt(labelX, Y.mr, labels.ringMars, MARS);
    s += txt(mX, Y.mg, labels.marsTotal, MARS, 12, "middle");
    s += txt(barL, Y.bn, labels.bottleneck, WARN);
    s += `</svg>`;
    return s;
  }

  /**
   * Vertical Earth→relay→Mars CAPACITY data-path (expanded Capacity diagram). Builds the
   * capacity label set and hands the skeleton to {@link _relayPathSvg}.
   */
  _capacityPathSvg(d) {
    const { rs, earthInring, marsInring, earthCap, marsCap, earthCapTotal, marsCapTotal,
            relayRingCount, bottleneckLine, eJct, mJct, fmtMbps, fmtRange, fmtNum } = d;
    // Junction label: link count, total capacity, min|avg|max per link (from interCap).
    const jctCapLabel = (j, prefix) => (j && j.count
      ? `${fmtMbps(j.sum)} · ${prefix}${j.count} links · ${fmtRange(j.min, j.sum / j.count, j.max)}`
      : null);

    // ring↔relay junction aggregates (eccentric: from ringDetail; null otherwise).
    // Each eccentric ring has ONE junction (tangent point) per planet, made of k links.
    // eJuncRings = junctions (rings that connect), eJuncN = total links across them.
    let eJuncN = null, eJuncCap = 0, eJuncRings = 0, mJuncN = null, mJuncCap = 0, mJuncRings = 0;
    if (rs && rs.ringDetail) {
      eJuncN = 0; mJuncN = 0;
      for (const r of rs.ringDetail) {
        eJuncN += r.earth.count; eJuncCap += r.earth.mbps; if (r.earth.count > 0) eJuncRings++;
        mJuncN += r.mars.count; mJuncCap += r.mars.mbps; if (r.mars.count > 0) mJuncRings++;
      }
    }
    const stat = (arr) => (arr && arr.length ? { lo: minOf(arr), hi: maxOf(arr), avg: arr.reduce((a, b) => a + b, 0) / arr.length } : null);
    const eS = stat(earthInring), mS = stat(marsInring);

    return this._relayPathSvg({
      relayRingCount, isEccentric: !!(rs && rs.ringDetail), fmtNum,
      earthSide1: earthCap.side1, earthSide2: earthCap.side2,
      marsSide1: marsCap.side1, marsSide2: marsCap.side2,
      labels: {
        earthTotal: `Earth ${fmtMbps(earthCapTotal)}`,
        ringEarth: eS ? `ring Earth ${fmtRange(eS.lo, eS.avg, eS.hi)}` : null,
        earthJunction: jctCapLabel(eJct, eJuncN != null ? `${eJuncRings} junctions · ` : "") || (eJuncN != null ? `${eJuncRings} junctions · ${eJuncN} links · ${fmtMbps(eJuncCap)}` : `ring \u2192 relay`),
        relayMain: rs ? fmtMbps(rs.totalThroughput) : null,
        relayL1: rs ? `${relayRingCount} rings, ${rs.routeCount} routes` : null,
        relayL2: rs ? fmtRange(rs.minThroughput, rs.avgThroughput, rs.maxThroughput) : null,
        relayL3: rs ? `${(rs.minLatency / 60).toFixed(1)}|${(rs.avgLatency / 60).toFixed(1)}|${(rs.maxLatency / 60).toFixed(1)} min` : null,
        marsJunction: jctCapLabel(mJct, mJuncN != null ? `${mJuncRings} junctions · ` : "") || (mJuncN != null ? `${mJuncRings} junctions · ${mJuncN} links · ${fmtMbps(mJuncCap)}` : `relay \u2192 ring`),
        ringMars: mS ? `ring Mars ${fmtRange(mS.lo, mS.avg, mS.hi)}` : null,
        marsTotal: `Mars ${fmtMbps(marsCapTotal)}`,
        bottleneck: bottleneckLine,
      },
    });
  }

  /**
   * Flow counterpart of {@link _capacityPathSvg}: same vertical data-path, but the labels
   * read the achieved max-flow (Gbps + % of each planet's ground capacity) and the junctions
   * show how many routes actually carry flow. Relay-type agnostic — concentric and eccentric
   * families render identically (eccentric just gets the double route bars).
   */
  _flowPathSvg(d) {
    const { rs, earthInring, marsInring, earthFlow, marsFlow, earthFlowTotal, marsFlowTotal,
            earthCapTotal, marsCapTotal, actualFlowMbps, earthActive, marsActive,
            relayRingCount, bottleneckLine, eJct, mJct, eJctFlowStat, mJctFlowStat,
            fmtMbps, fmtRange, fmtNum, pct } = d;
    // Junction label: active links, total flow, utilization vs junction capacity,
    // and min|avg|max flow per active link.
    const jctFlowLabel = (f, cap) => (f && f.count
      ? `${fmtMbps(f.sum)}${cap && cap.sum ? " · " + pct(f.sum, cap.sum) : ""} · ${f.count} active · ${fmtRange(f.min, f.avg, f.max)}`
      : null);

    const stat = (arr) => (arr && arr.length ? { lo: minOf(arr), hi: maxOf(arr), avg: arr.reduce((a, b) => a + b, 0) / arr.length } : null);
    const eS = stat(earthInring), mS = stat(marsInring);

    return this._relayPathSvg({
      relayRingCount, isEccentric: !!(rs && rs.ringDetail), fmtNum,
      earthSide1: earthFlow.side1, earthSide2: earthFlow.side2,
      marsSide1: marsFlow.side1, marsSide2: marsFlow.side2,
      labels: {
        earthTotal: `Earth ${fmtMbps(earthFlowTotal)} · ${pct(earthFlowTotal, earthCapTotal)}`,
        ringEarth: eS ? `ring Earth ${fmtRange(eS.lo, eS.avg, eS.hi)}` : null,
        earthJunction: jctFlowLabel(eJctFlowStat, eJct) || (earthActive != null ? `${earthActive} routes active` : `ring \u2192 relay`),
        relayMain: rs ? fmtMbps(actualFlowMbps) : null,
        relayL1: rs ? `${relayRingCount} rings, ${rs.routeCount} routes` : null,
        relayL2: rs ? fmtRange(rs.minThroughput, rs.avgThroughput, rs.maxThroughput) : null,
        relayL3: rs ? `${(rs.minLatency / 60).toFixed(1)}|${(rs.avgLatency / 60).toFixed(1)}|${(rs.maxLatency / 60).toFixed(1)} min` : null,
        marsJunction: jctFlowLabel(mJctFlowStat, mJct) || (marsActive != null ? `${marsActive} routes active` : `relay \u2192 ring`),
        ringMars: mS ? `ring Mars ${fmtRange(mS.lo, mS.avg, mS.hi)}` : null,
        marsTotal: `Mars ${fmtMbps(marsFlowTotal)} · ${pct(marsFlowTotal, marsCapTotal)}`,
        bottleneck: bottleneckLine,
      },
    });
  }

  /** The two ecliptic longitudes (degrees) where Earth's and Mars's orbital planes
   *  intersect — the line of nodes. Intersection direction = nEarth × nMars. */
  _earthMarsPlaneNodes() {
    const planeNormal = (i, o) => {
      const r = Math.PI / 180, si = Math.sin(i * r), ci = Math.cos(i * r);
      return [si * Math.sin(o * r), -si * Math.cos(o * r), ci];
    };
    const E = this.simSatellites.getEarth(), Mp = this.simSatellites.getMars();
    const nE = planeNormal(E.i || 0, E.o || 0), nM = planeNormal(Mp.i || 0, Mp.o || 0);
    const lx = nE[1] * nM[2] - nE[2] * nM[1];
    const ly = nE[2] * nM[0] - nE[0] * nM[2];
    let n1 = ((Math.atan2(ly, lx) * 180) / Math.PI) % 360;
    if (n1 < 0) n1 += 360;
    return { n1, n2: (n1 + 180) % 360 };
  }

  // Mars's line of apsides: the perihelion is at solar angle = Mars's longitude of perihelion
  // (p); aphelion is 180° opposite. Same {n1, n2} angle pair shape as _earthMarsPlaneNodes.
  _marsPeriapsisNodes() {
    const Mp = this.simSatellites.getMars();
    const n1 = ((((Mp && Mp.p) || 0) % 360) + 360) % 360;
    return { n1, n2: (n1 + 180) % 360 };
  }

  // Earth's line of apsides: perihelion at solar angle = Earth's longitude of perihelion (p).
  _earthPeriapsisNodes() {
    const E = this.simSatellites.getEarth();
    const n1 = ((((E && E.p) || 0) % 360) + 360) % 360;
    return { n1, n2: (n1 + 180) % 360 };
  }

  // Earth–Mars orbits' closest approach: the geometry-sampling 0° reference direction
  // (narrowest gap between the orbits); the opposite side is the widest gap.
  _closestApproachNodes() {
    const n1 = ((EARTH_MARS_CLOSEST_APPROACH_DEG % 360) + 360) % 360;
    return { n1, n2: (n1 + 180) % 360 };
  }

  // All reference-line angle pairs, keyed by the checkbox option label. Passed to the
  // display, which draws only the enabled ones.
  _referenceLineAngles() {
    return {
      "Closest approach": this._closestApproachNodes(),
      "Mars apsides": this._marsPeriapsisNodes(),
      "Plane nodes": this._earthMarsPlaneNodes(),
      "Earth apsides": this._earthPeriapsisNodes(),
    };
  }

  /**
   * Set the initial sim clock to the middle of the next Earth→Mars transfer —
   * the next departure window + 3 months — so the fleet overlay shows ships in
   * flight on load instead of "now" (which usually falls between windows). Falls
   * back to real-time on any failure.
   */
  _setInitialSimDate() {
    try {
      const planets = this.simSolarSystem.getSolarSystemData().planets;
      const earth = planets.find((p) => p.name === "Earth");
      const mars = planets.find((p) => p.name === "Mars");
      if (!earth || !mars) return;
      const now = this.simTime.getDate();
      const horizon = new Date(now.getTime() + 3 * 365.25 * 24 * 60 * 60 * 1000);
      const windows = findDepartureWindows(earth, mars, now, horizon);
      if (!windows.length) return;
      const start = new Date(windows[0]);
      start.setUTCMonth(start.getUTCMonth() + 3); // ~mid-transit
      this.simTime.initDate = start;
      this.simTime.simMsSinceStart = 0;
      this.simTime.previousRealMs = performance.now();
    } catch (e) {
      console.warn("[Marslink] initial sim date fallback:", e && e.message);
    }
  }

  /**
   * Right-panel "Fleet" metric card (spacecraft-flight overlay). Built from the
   * SimFlightController's ledger at the current sim date. Returned as a full
   * .metric-card so it can be emitted inside getCostsHtml AND swapped in place
   * each frame via refreshFleetMetric() (the date + in-transit counts change as
   * time animates, between the worker-driven full panel regenerations).
   */
  fleetMetricHtml() {
    const f = this.simFlight;
    const shell = (inner) => `<div class="metric-card" id="fleet-metric-card">${inner}</div>`;
    if (!f || !f.enabled) {
      return shell(`<div class="metric-header"><span class="metric-label">Fleet</span><span class="metric-value-sm" style="color:var(--text-3)">hidden</span></div>`);
    }
    const planets = this.simSolarSystem.getSolarSystemData().planets;
    const earth = planets.find((p) => p.name === "Earth");
    const mars = planets.find((p) => p.name === "Mars");
    f.ensureFleet(earth, mars);
    if (!f.fleet) return shell(`<div class="metric-header"><span class="metric-label">Fleet</span><span class="metric-value-sm">—</span></div>`);
    const d = this.simTime.getDate();
    const c = f.fleet.poolCountsAt(d);
    const inTransit = c.transitToMars + c.transitToEarth;
    const row = (label, val, color) =>
      `<div class="detail-row"><span class="detail-label"${color ? ` style="color:${color}"` : ""}>${label}</span><span class="detail-value">${val.toLocaleString()}</span></div>`;
    let inner = `<div class="metric-header"><span class="metric-label">Fleet</span><span class="metric-value-sm">${c.total.toLocaleString()} ships</span></div>`;
    inner += `<div style="font-size:11px;color:var(--text-3);margin:-2px 0 4px;">${d.toISOString().slice(0, 10)} · ${inTransit.toLocaleString()} in transit</div>`;
    inner += `<div class="metric-details" style="display:block;">`;
    inner += row("→ Mars (transit)", c.transitToMars, "#12c8ff");
    inner += row("→ Earth (transit)", c.transitToEarth, "#ff4fd8");
    inner += row("On Earth", c.onEarth);
    inner += row("On Mars", c.onMars);
    if (c.retired) inner += row("Retired", c.retired);
    inner += `</div>`;
    return shell(inner);
  }

  /**
   * Right-panel "Fleet link" connectivity-analysis card. Reads the latest ship
   * extension result (this._flightExt, computed throttled in updateLoop): how many
   * in-transit ships reach the relay backbone, the deepest relay chain, and the
   * access-link capacity/latency distribution (ship → its backbone root; the
   * root→Earth/Mars leg is the existing network's job).
   */
  /** Full-unit formatters shared by the Fleet-link card + its charts. */
  _fmtCapFull(g) {
    if (!isFinite(g) || g <= 0) return "—";
    if (g >= 1) return `${g.toFixed(g >= 10 ? 0 : 1)} Gbps`;
    const mb = g * 1000;
    return mb >= 10 ? `${Math.round(mb)} Mbps` : `${mb.toFixed(1)} Mbps`;
  }
  _fmtLatFull(s) {
    if (!isFinite(s) || s <= 0) return "—";
    if (s >= 3600) return `${(s / 3600).toFixed(1)} h`;
    if (s >= 60) return `${(s / 60).toFixed(1)} min`;
    return `${Math.round(s)} s`;
  }

  fleetConnectivityHtml() {
    const f = this.simFlight;
    const shell = (inner) => `<div class="metric-card" id="fleet-connectivity-card">${inner}</div>`;
    const head = (val, color) => `<div class="metric-header"><span class="metric-label">Fleet link</span><span class="metric-value-sm"${color ? ` style="color:${color}"` : ""}>${val}</span></div>`;
    if (!f || !f.enabled) return shell(head("hidden", "var(--text-3)"));
    const ext = this._flightExt;
    if (!ext || !ext.summary || ext.summary.total === 0) return shell(head("no ships in transit", "var(--text-3)"));

    const { connected, unconnected, total } = ext.summary;
    const reachPct = total ? Math.round((connected / total) * 100) : 0;
    const conn = ext.perShip.filter((s) => s.connected);
    const hopsMax = conn.reduce((m, s) => Math.max(m, s.hops), 0);

    const fmtCap = (g) => this._fmtCapFull(g);
    const fmtLat = (s) => this._fmtLatFull(s);
    const finite = (key) => conn.map((s) => s[key]).filter((v) => isFinite(v) && v > 0);
    const med = (key) => { const a = finite(key).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
    const stats = (key) => { const a = finite(key); if (!a.length) return null; return { min: Math.min(...a), max: Math.max(...a), avg: a.reduce((s, v) => s + v, 0) / a.length }; };

    const E = "#3b82f6", M = "#e0573e";
    const state = this._fleetLinkState;
    const arrow = state === "expanded" ? "&#9662;" : "&#9656;";
    const label = state === "expanded" ? "Compact" : state === "compact" ? "Charts" : "Distributions";

    let inner = head(`${connected}/${total} linked`);
    inner += `<div class="metric-sub">${reachPct}% reach · max ${hopsMax} hop${hopsMax === 1 ? "" : "s"}${unconnected ? ` · <span style="color:var(--accent-hot)">${unconnected} cut off</span>` : ""}</div>`;
    inner += `<div class="metric-toggle" id="fleetlink-toggle" onclick="window.simMain.cycleFleetLink()"><span class="arrow">${arrow}</span><span>${label}</span></div>`;

    if (state === "compact") {
      const row = (l, v, c) => `<div class="detail-row"><span class="detail-label"${c ? ` style="color:${c}"` : ""}>${l}</span><span class="detail-value">${v}</span></div>`;
      inner += `<div class="metric-details" style="display:block;">`;
      inner += row(`<span style="color:${E}">Earth</span> / <span style="color:${M}">Mars</span> cap`, `${fmtCap(med("capEarthGbps"))} / ${fmtCap(med("capMarsGbps"))}`);
      inner += row(`<span style="color:${E}">Earth</span> / <span style="color:${M}">Mars</span> lag`, `${fmtLat(med("latEarthSec"))} / ${fmtLat(med("latMarsSec"))}`);
      inner += row("To relay (cap · lag)", `${fmtCap(med("capacityGbps"))} · ${fmtLat(med("accessLatencySec"))}`);
      if (unconnected) inner += row("Unconnected", String(unconnected), "var(--accent-hot)");
      inner += `</div>`;
    } else if (state === "expanded") {
      const statLine = (color, name, st, fmt) => st
        ? `<div class="fl-stat"><span class="fl-dot" style="background:${color}"></span><span class="fl-name">${name}</span><span class="fl-vals">${fmt(st.min)} <span class="fl-sep">·</span> <b>${fmt(st.avg)}</b> <span class="fl-sep">·</span> ${fmt(st.max)}</span></div>`
        : `<div class="fl-stat"><span class="fl-dot" style="background:${color}"></span><span class="fl-name">${name}</span><span class="fl-vals" style="color:var(--text-3)">—</span></div>`;
      inner += `<div id="fleetlink-content" style="display:block;">`;
      inner += `<div class="fl-legend">min · <b>avg</b> · max — best single-path · ${conn.length} ship${conn.length === 1 ? "" : "s"}</div>`;
      inner += `<div class="fl-group-title">Capacity to planet</div>`;
      inner += statLine(E, "Earth", stats("capEarthGbps"), fmtCap);
      inner += statLine(M, "Mars", stats("capMarsGbps"), fmtCap);
      inner += `<div class="chart-wrap fl-chart"><canvas id="fl-cap-chart"></canvas></div>`;
      inner += `<div class="fl-group-title">Latency to planet</div>`;
      inner += statLine(E, "Earth", stats("latEarthSec"), fmtLat);
      inner += statLine(M, "Mars", stats("latMarsSec"), fmtLat);
      inner += `<div class="chart-wrap fl-chart"><canvas id="fl-lat-chart"></canvas></div>`;
      const ca = stats("capacityGbps"), la = stats("accessLatencySec");
      inner += `<div class="fl-group-title">Access to relay backbone</div>`;
      inner += `<div class="detail-row"><span class="detail-label">Capacity</span><span class="detail-value">${ca ? `${fmtCap(ca.min)} · ${fmtCap(ca.avg)} · ${fmtCap(ca.max)}` : "—"}</span></div>`;
      inner += `<div class="detail-row"><span class="detail-label">Latency</span><span class="detail-value">${la ? `${fmtLat(la.min)} · ${fmtLat(la.avg)} · ${fmtLat(la.max)}` : "—"}</span></div>`;
      if (unconnected) inner += `<div class="detail-row"><span class="detail-label" style="color:var(--accent-hot)">Unconnected</span><span class="detail-value">${unconnected}</span></div>`;
      inner += `</div>`;
    }
    return shell(inner);
  }

  /** Cycle the Fleet-link card: closed → compact → expanded → closed. */
  cycleFleetLink() {
    const next = { closed: "compact", compact: "expanded", expanded: "closed" };
    this._fleetLinkState = next[this._fleetLinkState] || "expanded";
    try { localStorage.setItem("marslink-fleetlink-state", this._fleetLinkState); } catch {}
    this._renderFleetLinkCard();
  }

  /** Rebuild the Fleet-link card DOM + (re)create its charts for the current data/state. */
  _renderFleetLinkCard() {
    const b = document.getElementById("fleet-connectivity-card");
    if (b) b.outerHTML = this.fleetConnectivityHtml();
    this.makeFleetLinkCharts();
  }

  destroyFleetLinkCharts() {
    for (const k of ["cap", "lat"]) {
      const c = this.fleetLinkCharts && this.fleetLinkCharts[k];
      if (c) { try { c.destroy(); } catch {} this.fleetLinkCharts[k] = null; }
    }
  }

  /**
   * (Re)create the two Fleet-link distribution charts (Earth vs Mars, grouped
   * histograms). No-op unless the card is expanded and the canvases are present.
   * Called after every panel render and whenever _flightExt changes.
   */
  makeFleetLinkCharts() {
    this.destroyFleetLinkCharts();
    this._fleetLinkDrawnVersion = this._flightExtVersion;
    if (this._fleetLinkState !== "expanded") return;
    const ext = this._flightExt;
    if (!ext || !ext.perShip) return;
    const conn = ext.perShip.filter((s) => s.connected);
    if (!conn.length) return;
    const capCanvas = document.getElementById("fl-cap-chart");
    const latCanvas = document.getElementById("fl-lat-chart");
    if (capCanvas) this.fleetLinkCharts.cap = this._fleetHistChart(capCanvas, conn.map((s) => s.capEarthGbps), conn.map((s) => s.capMarsGbps), "cap");
    if (latCanvas) this.fleetLinkCharts.lat = this._fleetHistChart(latCanvas, conn.map((s) => s.latEarthSec), conn.map((s) => s.latMarsSec), "lat");
  }

  /** Build one grouped Earth/Mars histogram (Chart.js). kind: "cap" (Gbps) | "lat" (seconds). */
  _fleetHistChart(canvas, earthRaw, marsRaw, kind) {
    if (typeof Chart === "undefined") return null;
    const earth = earthRaw.filter((v) => isFinite(v) && v > 0);
    const mars = marsRaw.filter((v) => isFinite(v) && v > 0);
    const all = earth.concat(mars);
    if (!all.length) return null;

    // Pick a single display unit for the whole axis from the combined max.
    let scale, unit;
    if (kind === "cap") { const mx = Math.max(...all); if (mx >= 1) { scale = 1; unit = "Gbps"; } else { scale = 1000; unit = "Mbps"; } }
    else { const mxMin = Math.max(...all) / 60; if (mxMin >= 120) { scale = 1 / 3600; unit = "h"; } else { scale = 1 / 60; unit = "min"; } }

    const eS = earth.map((v) => v * scale), mS = mars.map((v) => v * scale);
    const sv = eS.concat(mS);
    const min = Math.min(...sv), max = Math.max(...sv);
    const BINS = 16, range = (max - min) || 1, bw = range / BINS;
    const binize = (arr) => { const c = new Array(BINS).fill(0); for (const v of arr) { let i = Math.floor((v - min) / range * BINS); if (i >= BINS) i = BINS - 1; if (i < 0) i = 0; c[i]++; } return c; };
    const eC = binize(eS), mC = binize(mS);
    const fmt = (v) => v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
    const labels = []; for (let i = 0; i < BINS; i++) labels.push(fmt(min + (i + 0.5) * bw));

    const textDim = "#525c75", textMuted = "#7c879f", grid = "rgba(255,255,255,0.06)", tipBg = "#1a2030";
    return new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Earth", data: eC, backgroundColor: "rgba(59,130,246,0.6)", hoverBackgroundColor: "rgba(59,130,246,0.85)", borderRadius: 2, barPercentage: 1, categoryPercentage: 0.92 },
          { label: "Mars", data: mC, backgroundColor: "rgba(224,87,62,0.6)", hoverBackgroundColor: "rgba(224,87,62,0.85)", borderRadius: 2, barPercentage: 1, categoryPercentage: 0.92 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false, // card re-renders as time animates; skip per-update tweening
        layout: { padding: { top: 2, right: 4, bottom: 0, left: 0 } },
        scales: {
          x: {
            title: { display: true, text: `${kind === "cap" ? "Capacity" : "Latency"} (${unit})`, color: textMuted, font: { size: 10 } },
            ticks: { color: textDim, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
            grid: { display: false }, border: { color: grid },
          },
          y: {
            title: { display: true, text: "ships", color: textMuted, font: { size: 10 } },
            ticks: { color: textDim, font: { size: 9 }, maxTicksLimit: 4, precision: 0 },
            grid: { color: grid }, border: { display: false }, beginAtZero: true,
          },
        },
        plugins: {
          legend: { display: true, position: "top", align: "end", labels: { color: textMuted, font: { size: 10 }, boxWidth: 10, boxHeight: 10 } },
          tooltip: {
            backgroundColor: tipBg, titleColor: "#eef1f7", bodyColor: "#b9c0d0",
            borderColor: "rgba(255,255,255,0.1)", borderWidth: 1, cornerRadius: 4, padding: 8,
            titleFont: { size: 11 }, bodyFont: { size: 11 },
            callbacks: {
              title: (items) => { const i = items[0].dataIndex; return `${fmt(min + i * bw)}–${fmt(min + (i + 1) * bw)} ${unit}`; },
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} ship${ctx.parsed.y === 1 ? "" : "s"}`,
            },
          },
        },
      },
    });
  }

  /**
   * Swap the live Fleet cards. The ships card is cheap (text only) and refreshes
   * every tick; the Fleet-link card is only rebuilt when its data changed
   * (_flightExtVersion) so we don't tear down + recreate Chart.js every frame.
   */
  refreshFleetMetric() {
    const a = document.getElementById("fleet-metric-card");
    if (a) a.outerHTML = this.fleetMetricHtml();
    if (this._flightExtVersion !== this._fleetLinkDrawnVersion) this._renderFleetLinkCard();
  }

  /**
   * Right-panel "Coverage probes" card (Monte-Carlo coverage-field overlay).
   * Reports the coverage fraction (% of independent probes that found any
   * spare-port backbone node) and, like the Fleet-link card, a 3-state view:
   * closed → compact (median rows) → expanded (min·avg·max stat lines +
   * distribution charts) for capacity/latency to Earth & Mars and to the relay
   * access hop. Built from this._probeMeas (computed throttled in Phase 5c).
   */
  coverageMetricHtml() {
    const p = this.simProbe;
    const shell = (inner) => `<div class="metric-card" id="coverage-metric-card">${inner}</div>`;
    const head = (val, color) => `<div class="metric-header"><span class="metric-label">Coverage probes</span><span class="metric-value-sm"${color ? ` style="color:${color}"` : ""}>${val}</span></div>`;
    if (!p || !p.enabled) return shell(head("hidden", "var(--text-3)"));
    const meas = this._probeMeas;
    if (!meas || !meas.summary || meas.summary.total === 0) return shell(head("sampling…", "var(--text-3)"));

    const { connected, unconnected, total } = meas.summary;
    const reachPct = total ? Math.round((connected / total) * 100) : 0;
    const conn = meas.perProbe.filter((s) => s.connected);

    const fmtCap = (g) => this._fmtCapFull(g);
    const fmtLat = (s) => this._fmtLatFull(s);
    const finite = (key) => conn.map((s) => s[key]).filter((v) => isFinite(v) && v > 0);
    const med = (key) => { const a = finite(key).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
    const stats = (key) => { const a = finite(key); if (!a.length) return null; return { min: Math.min(...a), max: Math.max(...a), avg: a.reduce((s, v) => s + v, 0) / a.length }; };

    const E = "#3b82f6", M = "#e0573e", R = "#16c8aa";
    const state = this._coverageState;
    const arrow = state === "expanded" ? "&#9662;" : "&#9656;";
    const label = state === "compact" ? "Charts" : state === "expanded" ? "Compact" : "Distributions";

    let inner = head(`${reachPct}% coverage`);
    inner += `<div class="metric-sub">${connected.toLocaleString()}/${total.toLocaleString()} probes linked${unconnected ? ` · <span style="color:var(--accent-hot)">${unconnected.toLocaleString()} no link</span>` : ""}</div>`;
    inner += `<div class="metric-toggle" id="coverage-toggle" onclick="window.simMain.cycleCoverage()"><span class="arrow">${arrow}</span><span>${label}</span></div>`;

    if (state === "compact") {
      const row = (l, v, c) => `<div class="detail-row"><span class="detail-label"${c ? ` style="color:${c}"` : ""}>${l}</span><span class="detail-value">${v}</span></div>`;
      inner += `<div class="metric-details" style="display:block;">`;
      inner += row(`<span style="color:${E}">Earth</span> / <span style="color:${M}">Mars</span> cap`, `${fmtCap(med("capEarthGbps"))} / ${fmtCap(med("capMarsGbps"))}`);
      inner += row(`<span style="color:${E}">Earth</span> / <span style="color:${M}">Mars</span> lag`, `${fmtLat(med("latEarthSec"))} / ${fmtLat(med("latMarsSec"))}`);
      inner += row("To relay (cap · lag)", `${fmtCap(med("capacityGbps"))} · ${fmtLat(med("accessLatencySec"))}`);
      inner += `</div>`;
    } else if (state === "expanded") {
      const statLine = (color, name, st, fmt) => st
        ? `<div class="fl-stat"><span class="fl-dot" style="background:${color}"></span><span class="fl-name">${name}</span><span class="fl-vals">${fmt(st.min)} <span class="fl-sep">·</span> <b>${fmt(st.avg)}</b> <span class="fl-sep">·</span> ${fmt(st.max)}</span></div>`
        : `<div class="fl-stat"><span class="fl-dot" style="background:${color}"></span><span class="fl-name">${name}</span><span class="fl-vals" style="color:var(--text-3)">—</span></div>`;
      inner += `<div id="coverage-content" style="display:block;">`;
      inner += `<div class="fl-legend">min · <b>avg</b> · max — best single-path · ${conn.length} probe${conn.length === 1 ? "" : "s"}</div>`;

      inner += `<div class="fl-group-title">Capacity to planet</div>`;
      inner += statLine(E, "Earth", stats("capEarthGbps"), fmtCap);
      inner += statLine(M, "Mars", stats("capMarsGbps"), fmtCap);
      inner += `<div class="chart-wrap fl-chart"><canvas id="cov-cap-chart"></canvas></div>`;

      inner += `<div class="fl-group-title">Latency to planet</div>`;
      inner += statLine(E, "Earth", stats("latEarthSec"), fmtLat);
      inner += statLine(M, "Mars", stats("latMarsSec"), fmtLat);
      inner += `<div class="chart-wrap fl-chart"><canvas id="cov-lat-chart"></canvas></div>`;

      inner += `<div class="fl-group-title">To relay (access hop)</div>`;
      inner += statLine(R, "Capacity", stats("capacityGbps"), fmtCap);
      inner += `<div class="chart-wrap fl-chart"><canvas id="cov-relaycap-chart"></canvas></div>`;
      inner += statLine(R, "Latency", stats("accessLatencySec"), fmtLat);
      inner += `<div class="chart-wrap fl-chart"><canvas id="cov-relaylat-chart"></canvas></div>`;
      inner += `</div>`;
    }
    return shell(inner);
  }

  /** Cycle the Coverage card: closed → compact → expanded → closed. */
  cycleCoverage() {
    const next = { closed: "compact", compact: "expanded", expanded: "closed" };
    this._coverageState = next[this._coverageState] || "expanded";
    try { localStorage.setItem("marslink-coverage-state", this._coverageState); } catch {}
    this._renderCoverageCard();
  }

  /** Rebuild the Coverage card DOM + (re)create its charts for the current data/state. */
  _renderCoverageCard() {
    const b = document.getElementById("coverage-metric-card");
    if (b) b.outerHTML = this.coverageMetricHtml();
    this.makeCoverageCharts();
  }

  destroyCoverageCharts() {
    for (const k of ["cap", "lat", "relayCap", "relayLat"]) {
      const c = this.coverageCharts && this.coverageCharts[k];
      if (c) { try { c.destroy(); } catch {} this.coverageCharts[k] = null; }
    }
  }

  /**
   * (Re)create the four Coverage distribution charts — capacity-to-planet and
   * latency-to-planet (Earth vs Mars), plus the to-relay access-hop capacity and
   * latency. No-op unless the card is expanded and the canvases are present.
   * Called after every panel render and whenever the measurement changes.
   */
  makeCoverageCharts() {
    this.destroyCoverageCharts();
    this._coverageDrawnVersion = this._probeMeasVersion;
    if (this._coverageState !== "expanded") return;
    const meas = this._probeMeas;
    if (!meas || !meas.perProbe) return;
    const conn = meas.perProbe.filter((s) => s.connected);
    if (!conn.length) return;
    const E = "rgba(59,130,246,0.6)", Eh = "rgba(59,130,246,0.85)";
    const M = "rgba(224,87,62,0.6)", Mh = "rgba(224,87,62,0.85)";
    const R = "rgba(22,200,170,0.62)", Rh = "rgba(22,200,170,0.85)";
    const cap = document.getElementById("cov-cap-chart");
    const lat = document.getElementById("cov-lat-chart");
    const rcap = document.getElementById("cov-relaycap-chart");
    const rlat = document.getElementById("cov-relaylat-chart");
    if (cap) this.coverageCharts.cap = this._coverageHistChart(cap, [
      { label: "Earth", color: E, hover: Eh, data: conn.map((s) => s.capEarthGbps) },
      { label: "Mars", color: M, hover: Mh, data: conn.map((s) => s.capMarsGbps) },
    ], "cap");
    if (lat) this.coverageCharts.lat = this._coverageHistChart(lat, [
      { label: "Earth", color: E, hover: Eh, data: conn.map((s) => s.latEarthSec) },
      { label: "Mars", color: M, hover: Mh, data: conn.map((s) => s.latMarsSec) },
    ], "lat");
    if (rcap) this.coverageCharts.relayCap = this._coverageHistChart(rcap, [
      { label: "To relay", color: R, hover: Rh, data: conn.map((s) => s.capacityGbps) },
    ], "cap");
    if (rlat) this.coverageCharts.relayLat = this._coverageHistChart(rlat, [
      { label: "To relay", color: R, hover: Rh, data: conn.map((s) => s.accessLatencySec) },
    ], "lat");
  }

  /**
   * One grouped histogram (Chart.js) over 1–2 series. kind: "cap" (Gbps) | "lat"
   * (seconds). Capacity follows ~1/d² and spans orders of magnitude, so it is
   * binned on a LOG axis (a linear axis dumps almost every probe into the first
   * bin); latency has a narrow range and stays linear.
   */
  _coverageHistChart(canvas, series, kind) {
    if (typeof Chart === "undefined") return null;
    const cleaned = series.map((s) => ({ ...s, vals: s.data.filter((v) => isFinite(v) && v > 0) }));
    const all = cleaned.flatMap((s) => s.vals);
    if (!all.length) return null;

    const BINS = 16;
    const min = Math.min(...all), max = Math.max(...all);

    // Per-kind binning: log-spaced for capacity, linear for latency.
    let binOf, centerOf, edgeOf, axisLabel, valFmt, tipSuffix = "";
    if (kind === "cap") {
      const lo = Math.log10(min), hi = Math.log10(max), span = (hi - lo) || 1;
      binOf = (v) => { const i = Math.floor((Math.log10(v) - lo) / span * BINS); return i < 0 ? 0 : i >= BINS ? BINS - 1 : i; };
      centerOf = (i) => Math.pow(10, lo + (i + 0.5) * span / BINS);
      edgeOf = (i) => Math.pow(10, lo + i * span / BINS);
      axisLabel = "Capacity (log)";
      // Compact, per-value unit: G = Gbps, M = Mbps, k = kbps.
      valFmt = (g) => {
        if (g >= 1) return `${g >= 100 ? Math.round(g) : g >= 10 ? g.toFixed(0) : g.toFixed(1)}G`;
        const mb = g * 1000;
        if (mb >= 1) return `${mb >= 100 ? Math.round(mb) : mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)}M`;
        const kb = g * 1e6;
        return `${kb >= 100 ? Math.round(kb) : kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)}k`;
      };
    } else {
      let scale, unit;
      if (max / 60 >= 120) { scale = 1 / 3600; unit = "h"; } else { scale = 1 / 60; unit = "min"; }
      const smin = min * scale, smax = max * scale, range = (smax - smin) || 1;
      binOf = (v) => { const i = Math.floor((v * scale - smin) / range * BINS); return i < 0 ? 0 : i >= BINS ? BINS - 1 : i; };
      centerOf = (i) => smin + (i + 0.5) * range / BINS;
      edgeOf = (i) => smin + i * range / BINS;
      axisLabel = `Latency (${unit})`;
      tipSuffix = ` ${unit}`;
      valFmt = (v) => v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
    }

    const binize = (vals) => { const c = new Array(BINS).fill(0); for (const v of vals) c[binOf(v)]++; return c; };
    const labels = []; for (let i = 0; i < BINS; i++) labels.push(valFmt(centerOf(i)));
    const datasets = cleaned.map((s) => ({ label: s.label, data: binize(s.vals), backgroundColor: s.color, hoverBackgroundColor: s.hover || s.color, borderRadius: 2, barPercentage: 1, categoryPercentage: 0.92 }));

    const textDim = "#525c75", textMuted = "#7c879f", grid = "rgba(255,255,255,0.06)", tipBg = "#1a2030";
    return new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { top: 2, right: 4, bottom: 0, left: 0 } },
        scales: {
          x: {
            title: { display: true, text: axisLabel, color: textMuted, font: { size: 10 } },
            ticks: { color: textDim, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
            grid: { display: false }, border: { color: grid },
          },
          y: {
            title: { display: true, text: "probes", color: textMuted, font: { size: 10 } },
            ticks: { color: textDim, font: { size: 9 }, maxTicksLimit: 4, precision: 0 },
            grid: { color: grid }, border: { display: false }, beginAtZero: true,
          },
        },
        plugins: {
          legend: { display: datasets.length > 1, position: "top", align: "end", labels: { color: textMuted, font: { size: 10 }, boxWidth: 10, boxHeight: 10 } },
          tooltip: {
            backgroundColor: tipBg, titleColor: "#eef1f7", bodyColor: "#b9c0d0",
            borderColor: "rgba(255,255,255,0.1)", borderWidth: 1, cornerRadius: 4, padding: 8,
            titleFont: { size: 11 }, bodyFont: { size: 11 },
            callbacks: {
              title: (items) => { const i = items[0].dataIndex; return `${valFmt(edgeOf(i))}–${valFmt(edgeOf(i + 1))}${tipSuffix}`; },
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} probe${ctx.parsed.y === 1 ? "" : "s"}`,
            },
          },
        },
      },
    });
  }

  /**
   * Swap the live Coverage card. Rebuilt + charts recreated only when the
   * measurement changed (_probeMeasVersion), so we don't tear down + recreate
   * Chart.js every frame as time animates.
   */
  refreshCoverageMetric() {
    if (this._probeMeasVersion === this._coverageDrawnVersion && document.getElementById("coverage-metric-card")) return;
    const a = document.getElementById("coverage-metric-card");
    if (a) a.outerHTML = this.coverageMetricHtml();
    this.makeCoverageCharts();
  }

  getCostsHtml(costs, networkData, latencyData) {
    let html = "";

    const fmtM = (value) => `$${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}M`;
    const fmtCost = (value) => value >= 1_000_000_000
      ? `$${(value / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}B`
      : fmtM(value);

    const fmtMbps = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)} Gbps` : `${Math.round(v)} Mbps`;

    // ── 1. SATELLITES ──
    html += `<div class="metric-card">`;
    html += `<div class="metric-header">`;
    html += `<span class="metric-label">Satellites</span>`;
    html += `<span class="metric-value">${this.satellitesCount.toLocaleString()}</span>`;
    html += `</div>`;
    html += `<div class="metric-toggle" id="satellites-toggle">`;
    html += `<span class="arrow" id="satellites-arrow">&#9656;</span><span>Details</span>`;
    html += `</div>`;
    html += `<div class="metric-details" id="satellites-content" style="display: none;">`;
    if (this.resultTrees && this.resultTrees.length > 0) {
      // Aggregate by ring type: earth, adapted, mars
      const groups = { earth: { sats: 0, ports: 0 }, adapted: { sats: 0, ports: 0 }, mars: { sats: 0, ports: 0 } };
      for (const orbit of this.resultTrees) {
        const rn = orbit.ringName || "";
        const ports = this.simLinkBudget.getMaxLinksPerRing(rn);
        if (rn === "ring_earth") { groups.earth.sats += orbit.satCount; groups.earth.ports = ports; }
        else if (rn === "ring_mars") { groups.mars.sats += orbit.satCount; groups.mars.ports = ports; }
        else { groups.adapted.sats += orbit.satCount; groups.adapted.ports = ports; }
      }
      // Totals first so per-ring rows can show % of total laser ports.
      let totalLasers = 0;
      for (const g of Object.values(groups)) totalLasers += g.sats * g.ports;

      const fmtPct = (ringPorts) => {
        if (totalLasers <= 0) return "0%";
        const p = (ringPorts / totalLasers) * 100;
        // One decimal under 10%, whole numbers above — keeps the column tidy.
        return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
      };

      const ringLabel = (label, g) => {
        if (g.sats === 0) return "";
        const pct = fmtPct(g.sats * g.ports);
        return `<div class="detail-row"><span class="detail-label">${label} <span style="color:var(--text-3)">${g.ports}p</span></span><span class="detail-value">${pct} · ${g.sats.toLocaleString()}</span></div>`;
      };
      html += ringLabel("Earth ring", groups.earth);
      html += ringLabel("Adapted rings", groups.adapted);
      html += ringLabel("Mars ring", groups.mars);

      const totalFlights = this.resultTrees.reduce((s, o) => s + (o.deploymentFlights_count || 0), 0);
      html += `<div class="detail-row" style="border-top: 1px solid var(--border-1); padding-top: 4px; margin-top: 4px;"><span class="detail-label">Total laser ports</span><span class="detail-value">${totalLasers.toLocaleString()}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Deployment flights</span><span class="detail-value">${totalFlights.toLocaleString()}</span></div>`;
    }
    html += `</div></div>`;

    // ── 1b. FLEET (spacecraft-flight overlay) ──
    // Fleet-link card is emitted last (see end of getCostsHtml).
    html += this.fleetMetricHtml();

    // ── 1c. COVERAGE PROBES (Monte-Carlo coverage-field overlay) ──
    html += this.coverageMetricHtml();

    // ── 2. COST ──
    if (costs) {
      html += `<div class="metric-card">`;
      html += `<div class="metric-header">`;
      html += `<span class="metric-label">Total Cost</span>`;
      html += `<span class="metric-value">${fmtCost(costs.totalCosts)}</span>`;
      html += `</div>`;
      html += `<div class="metric-toggle" id="cost-toggle">`;
      html += `<span class="arrow" id="cost-arrow">&#9656;</span><span>Details</span>`;
      html += `</div>`;
      html += `<div class="metric-details" id="cost-content" style="display: none;">`;
      const fmtTons = (kg) => `${Math.round(kg / 1000).toLocaleString()}t`;
      html += `<div class="detail-row"><span class="detail-label">Launch <span style="color:var(--text-3)">${costs.launchCount.toLocaleString()} (${costs.deploymentFlights.toLocaleString()} + ${costs.tankerFlights.toLocaleString()} tankers)</span></span><span class="detail-value">${fmtM(costs.launchCost)}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Satellites <span style="color:var(--text-3)">${costs.satellitesCount.toLocaleString()}</span></span><span class="detail-value">${fmtM(costs.satellitesCost)}</span></div>`;
      html += `<div class="detail-row"><span class="detail-label">Laser terminals <span style="color:var(--text-3)">${costs.laserCount.toLocaleString()}</span></span><span class="detail-value">${fmtM(costs.laserTerminalsCost)}</span></div>`;
      if (costs.solarCost > 0) {
        html += `<div class="detail-row"><span class="detail-label">Solar arrays</span><span class="detail-value">${fmtM(costs.solarCost)}</span></div>`;
      }
      if (costs.radiatorCost > 0) {
        html += `<div class="detail-row"><span class="detail-label">Radiators</span><span class="detail-value">${fmtM(costs.radiatorCost)}</span></div>`;
      }
      html += `<div class="detail-row"><span class="detail-label">Propellant</span><span class="detail-value">${fmtM(costs.propellantCost)}</span></div>`;
      for (const [type, cost] of Object.entries(costs.propellantCostBreakdown)) {
        const massKg = costs.propellantMassBreakdown[type] || 0;
        html += `<div class="detail-row" style="padding-left: 10px;"><span class="detail-label">${type} <span style="color:var(--text-3)">${fmtTons(massKg)}</span></span><span class="detail-value">${fmtM(cost)}</span></div>`;
      }
      html += `<div class="detail-row" style="border-top: 1px solid var(--border-1); padding-top: 4px; margin-top: 4px;"><span class="detail-label" style="color: var(--text-1);">Total</span><span class="detail-value" style="color: var(--text-0);">${fmtM(costs.totalCosts)}</span></div>`;
      if (costs.wrightSavings > 0) {
        const pct = Math.round(costs.wrightSavings / costs.noLearningTotal * 100);
        html += `<div class="detail-row" style="margin-top: 4px;"><span class="detail-label" style="color: var(--accent);">Wright's law savings</span><span class="detail-value" style="color: var(--accent);">−${fmtM(costs.wrightSavings)} (${pct}%)</span></div>`;
      }
      html += `</div></div>`;
    }

    // ── 3. CAPACITY (always shows, capacity-only) ──
    if (this.capacityInfo) {
      const { ringCapacities, interCap } = this.capacityInfo;

      // Active relay family (only one is enabled at a time). Drives the ring-count line
      // and the bottleneck label so the card reads correctly for every relay type — for
      // adapted concentric these resolve to the same "adapted rings" / count as before.
      const relayRingKeys = Object.keys(ringCapacities).filter((r) => r !== "ring_earth" && r !== "ring_mars");
      const relayRingCount = relayRingKeys.length;
      const relayLabel = relayRingKeys.some((r) => r.startsWith("ring_adapt"))
        ? "adapted concentric rings"
        : relayRingKeys.some((r) => r.startsWith("ring_adecc"))
        ? "adapted eccentric rings"
        : relayRingKeys.some((r) => r.startsWith("ring_circ"))
        ? "circular rings"
        : relayRingKeys.some((r) => r.startsWith("ring_ecce"))
        ? "eccentric rings"
        : "relay rings";
      const fmtNum = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}` : `${Math.round(v)}`;
      const pct = (flow, cap) => cap > 0 ? `${Math.round(flow / cap * 100)}%` : "";
      const fmtRange = (...vals) => {
        const unit = minOf(vals) >= 1000 ? "Gbps" : "Mbps";
        const fmt = unit === "Gbps" ? (v) => (v / 1000).toFixed(1) : (v) => Math.round(v);
        return vals.map(fmt).join("|") + " " + unit;
      };

      const earthInring = ringCapacities["ring_earth"]?.inring || [];
      const marsInring = ringCapacities["ring_mars"]?.inring || [];
      const earthCap = { side1: 0, side2: 0 };
      const marsCap = { side1: 0, side2: 0 };

      const earthPlanetLinks = ringCapacities["ring_earth"]?.planetLinks || [];
      const earthCaps = earthPlanetLinks.map((l) => l.cap).sort((a, b) => b - a);
      earthCap.side1 = earthCaps[0] || 0;
      earthCap.side2 = earthCaps[1] || 0;

      const marsPlanetLinks = ringCapacities["ring_mars"]?.planetLinks || [];
      const marsCaps = marsPlanetLinks.map((l) => l.cap).sort((a, b) => b - a);
      marsCap.side1 = marsCaps[0] || 0;
      marsCap.side2 = marsCaps[1] || 0;

      const earthCapTotal = earthCap.side1 + earthCap.side2;
      const marsCapTotal = marsCap.side1 + marsCap.side2;
      const rs = this.routeSummary;

      const planetLine = (left, symbol, right, label, offset = 0) => {
        const core = `${fmtNum(left)}\u2190${symbol}\u2192${fmtNum(right)}`;
        const W = 17;
        const pad = Math.max(0, W - core.length);
        const padL = Math.max(0, Math.floor(pad / 2) + offset);
        const padR = Math.max(0, pad - padL);
        return `${"-".repeat(padL)}${core}${"-".repeat(padR)}  ${label}\n`;
      };

      const W = 17;
      const pipeCount = rs ? Math.min(rs.routeCount, W) : 0;
      const padPipe = rs ? Math.floor((W - pipeCount) / 2) : 0;
      const pipes = rs ? " ".repeat(padPipe) + "\u2502".repeat(pipeCount) : "";

      const segments = [];
      if (earthCapTotal > 0) segments.push({ name: "earth ring", cap: earthCapTotal });
      if (rs) segments.push({ name: relayLabel, cap: rs.totalThroughput });
      if (marsCapTotal > 0) segments.push({ name: "mars ring", cap: marsCapTotal });
      let bottleneckLine = "";
      this._bottleneckInfo = null; // surfaced to the bottom-bar warnings
      if (relayRingCount === 0) {
        // No relay family active → nothing bridges Earth and Mars, so the end-to-end
        // capacity is zero. The missing relay IS the bottleneck (not either planet ring).
        bottleneckLine = `Bottleneck: no relay rings`;
        this._bottleneckInfo = { name: "no relay rings", cap: 0, relayCap: 0 };
      } else if (segments.length > 1) {
        const minCap = minOf(segments.map((s) => s.cap));
        const maxCap = maxOf(segments.map((s) => s.cap));
        if (maxCap > 0 && (maxCap - minCap) / maxCap > 0.05) {
          const bottleneck = segments.reduce((a, b) => (a.cap < b.cap ? a : b));
          bottleneckLine = `Bottleneck: ${bottleneck.name}`;
          this._bottleneckInfo = { name: bottleneck.name, cap: bottleneck.cap, relayCap: rs ? rs.totalThroughput : 0 };
        } else {
          bottleneckLine = `Balanced`;
        }
      }

      const techFactor = this.simLinkBudget.techImprovementFactor || 1;
      // End-to-end Earth↔Mars capacity = the BOTTLENECK stage: the min of the Earth-ring, relay,
      // and Mars-ring capacities (the same `segments` the bottleneck line is computed from), NOT
      // the relay number alone — a smaller planet-ring/ground link caps the whole path. This keeps
      // the header consistent with the "Bottleneck: …" subline. No relay rings ⇒ no Earth↔Mars path
      // ⇒ zero (a planet ring's own internal capacity is not a usable Earth-to-Mars figure here).
      const capHeaderValue =
        relayRingCount === 0 ? fmtMbps(0)
        : segments.length ? fmtMbps(minOf(segments.map((s) => s.cap)))
        : rs ? fmtMbps(rs.totalThroughput) : fmtMbps(earthCapTotal);

      html += `<div class="metric-card">`;
      html += `<div class="metric-header">`;
      html += `<span class="metric-label">Capacity</span>`;
      html += `<span class="metric-value-sm">${capHeaderValue}</span>`;
      html += `</div>`;
      const subParts = [];
      if (bottleneckLine) subParts.push(bottleneckLine);
      if (techFactor > 1) subParts.push(`Laser tech ${techFactor}x`);
      if (subParts.length) html += `<div class="metric-sub">${subParts.join(" · ")}</div>`;

      // Toggle for capacity diagram
      html += `<div class="metric-toggle" id="capacity-toggle">`;
      html += `<span class="arrow" id="capacity-arrow">&#9656;</span><span>Diagram</span>`;
      html += `</div>`;

      // Planet-line range label: "2×ring_min – 2×ring_max". The in-ring link
      // capacities drive the range (they vary with orbital eccentricity); the
      // planet links (shown as left←●→right) are just the current ground
      // capacity at this orbital position.
      const ringRange = (inring) => {
        if (!inring || inring.length === 0) return null;
        const lo = 2 * minOf(inring), hi = 2 * maxOf(inring);
        if (lo === hi) return fmtMbps(lo);
        const unit = Math.min(lo, hi) >= 1000 ? "Gbps" : "Mbps";
        const fmt = unit === "Gbps" ? (v) => (v / 1000).toFixed(1) : (v) => Math.round(v);
        return `${fmt(lo)}-${fmt(hi)} ${unit}`;
      };
      const earthRingRange = ringRange(earthInring);
      const marsRingRange = ringRange(marsInring);

      // Ring-to-relay junction aggregates (all interCap pairs touching the planet
      // ring; planet-body links live in planetLinks, Earth-Mars pairs in flows).
      const junctionOf = (planetRing) => {
        let sum = 0, count = 0, min = Infinity, max = 0;
        for (const [key, v] of Object.entries(interCap || {})) {
          if (key.includes(planetRing)) {
            sum += v.sum; count += v.count;
            if (v.min != null && v.min < min) min = v.min;
            if (v.max != null && v.max > max) max = v.max;
          }
        }
        return { sum, count, min: Number.isFinite(min) ? min : 0, max };
      };
      const eJct = junctionOf("ring_earth");
      const mJct = junctionOf("ring_mars");
      const jctLine = (j, label) => {
        if (!j.count) return "";
        const n = Math.min(j.count, W);
        const pad = Math.floor((W - n) / 2);
        return `${" ".repeat(pad)}${":".repeat(n)}${" ".repeat(Math.max(0, W - pad - n))}  ${label}\n`;
      };
      // Relay-intrinsic capacity (junction hops excluded) for the middle line — the
      // junctions get their own lines, so the middle must not re-fold them.
      const relayIntrinsicMbps = rs ? (rs.relayOnlyThroughput ?? rs.totalThroughput) : 0;

      // Compact capacity diagram — 5 lines: Earth ring / Earth junction / relay
      // (intrinsic) / Mars junction / Mars ring
      html += `<pre class="capacity-diagram" id="capacity-compact" style="display: none;">`;
      html += planetLine(earthCap.side1, "\u25CF", earthCap.side2, earthRingRange || fmtMbps(earthCapTotal), -2);
      html += jctLine(eJct, fmtMbps(eJct.sum));
      if (rs) html += `${pipes}  ${fmtMbps(relayIntrinsicMbps)}\n`;
      else html += `        ✗          no relay rings\n`;
      html += jctLine(mJct, fmtMbps(mJct.sum));
      html += planetLine(marsCap.side1, "\u2022", marsCap.side2, marsRingRange || fmtMbps(marsCapTotal), 2);
      html += `</pre>`;

      // Expanded capacity diagram \u2014 vertical Earth\u2192relay\u2192Mars data path as SVG. Reads
      // top\u2192bottom: Earth ground \u00B7 Earth ring (planet \u25CF, ground link caps) \u00B7 ring\u2192relay
      // junctions \u00B7 relay routes \u00B7 relay\u2192Mars junctions \u00B7 Mars ring (\u2022) \u00B7 Mars ground.
      // Bars: single = junction; double = the 2 routes of an eccentric ring; thick single
      // = a concentric ring's route. Planets are colour-coded (Earth blue, Mars red).
      html += `<div id="capacity-content" style="display: none;">`;
      html += this._capacityPathSvg({
        rs, earthInring, marsInring, earthCap, marsCap, earthCapTotal, marsCapTotal,
        earthRingRange, marsRingRange, relayRingCount, bottleneckLine, eJct, mJct,
        fmtMbps, fmtRange, fmtNum, minOf, maxOf,
      });

      // Per-ring junction/route detail (adapted-eccentric / eccentric families). A toggle
      // reveals: the planet-ring in-ring capacity (header lines) plus a table of each
      // ring's Earth junction / relay routes / Mars junction (count + Mbps). A ring whose
      // route capacity exceeds either junction (the junction under-serves it) is highlighted.
      const ringDetail = rs && rs.ringDetail;
      if (ringDetail && ringDetail.length) {
        const ringMbpsRange = (inring) => {
          if (!inring || !inring.length) return "—";
          const lo = Math.round(minOf(inring)), hi = Math.round(maxOf(inring));
          const av = Math.round(inring.reduce((s, v) => s + v, 0) / inring.length);
          return `${lo}|${av}|${hi}`;
        };
        const { n1: nodeEarthMars, n2: node2 } = this._earthMarsPlaneNodes();

        html += `<div class="metric-toggle" id="ringdetail-toggle"><span class="arrow" id="ringdetail-arrow">&#9656;</span><span>Ring detail</span></div>`;
        html += `<div id="ringdetail-content" style="display:none;">`;
        html += `<pre class="capacity-diagram" style="margin:4px 0;">`;
        html += `ring Earth ${ringMbpsRange(earthInring)} Mbps\n`;
        html += `ring Mars ${ringMbpsRange(marsInring)} Mbps\n`;
        html += `Earth↔Mars plane nodes ${Math.round(nodeEarthMars)}° | ${Math.round(node2)}°`;
        html += `</pre>`;
        // Each of Earth / Relay / Mars is split into a count + mbps sub-column; a faint
        // left border marks each group. Earth/Mars columns are junction links, Relay is
        // the ring's two routes.
        const grp = "border-left:1px solid rgba(128,128,128,0.25);";
        html += `<table style="width:100%; border-collapse:collapse; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:1.45;">`;
        html += `<thead>`;
        html += `<tr style="opacity:0.6;"><td style="text-align:left;">Ring</td>`;
        html += `<td colspan="2" style="text-align:center; ${grp}">Earth</td>`;
        html += `<td colspan="2" style="text-align:center; ${grp}">Relay</td>`;
        html += `<td colspan="2" style="text-align:center; ${grp}">Mars</td></tr>`;
        html += `<tr style="opacity:0.45; font-size:9px;"><td style="text-align:left;">ArgP</td>`;
        html += `<td style="text-align:right; ${grp}">count</td><td style="text-align:right;">mbps</td>`;
        html += `<td style="text-align:right; ${grp}">count</td><td style="text-align:right;">mbps</td>`;
        html += `<td style="text-align:right; ${grp}">count</td><td style="text-align:right;">mbps</td></tr>`;
        html += `</thead><tbody>`;
        for (const r of ringDetail) {
          const eM = Math.round(r.earth.mbps), mM = Math.round(r.mars.mbps), rM = Math.round(r.routesMbps);
          const over = rM > eM || rM > mM;
          const ang = String(Math.round(r.argP)).padStart(3, "0");
          const rowStyle = over ? ` style="color: var(--accent-hot, #dd2222);"` : "";
          html += `<tr${rowStyle}>`;
          html += `<td style="text-align:left;">${ang}°</td>`;
          html += `<td style="text-align:right; ${grp}">${r.earth.count}</td><td style="text-align:right;">${eM}</td>`;
          html += `<td style="text-align:right; ${grp}">${r.routesCount}</td><td style="text-align:right;">${rM}</td>`;
          html += `<td style="text-align:right; ${grp}">${r.mars.count}</td><td style="text-align:right;">${mM}</td>`;
          html += `</tr>`;
        }
        html += `</tbody></table>`;
        html += `</div>`;
      }

      html += `</div>`;
      html += `</div>`;

      // ── 3a. RELAY DISTRIBUTION (the equalizer density + resulting ring positions) ──
      // When adapted rings are active, plot the continuous equalizer density curve the
      // rings are placed to follow, the 10 band weights as points on it, and each ring
      // as a tick at its actual semi-major axis.
      const adaptedEls = this.simSatellites.getOrbitalElements()
        .filter((e) => e.ringName && e.ringName.startsWith("ring_adapt"));
      if (adaptedEls.length > 0) {
        const aByRing = new Map();
        for (const e of adaptedEls) if (!aByRing.has(e.ringName)) aByRing.set(e.ringName, e.a);
        const aVals = [...aByRing.values()].sort((x, y) => x - y);
        const aEarth = this.simSatellites.getEarth().a;
        const aMars = this.simSatellites.getMars().a;
        const lo = Math.min(aEarth, aVals[0]);
        const hi = Math.max(aMars, aVals[aVals.length - 1]);
        const span = hi - lo || 1;
        const aMin = aVals[0], aMax = aVals[aVals.length - 1], aSpan = (aMax - aMin) || 1;

        // Equalizer density curve from the chart's anchors (piecewise-linear),
        // shared via SimSatellites.densityFromAnchors so the card, the editor and the
        // ring builder all draw the identical curve. Points = the anchors themselves.
        const anchors = (this.ui && this.ui._getDensityAnchors) ? this.ui._getDensityAnchors() : [{ x: 0, y: 50 }, { x: 1, y: 50 }];
        const density = (u) => this.simSatellites.densityFromAnchors(anchors, u);

        const W = 300, H = 66, padX = 6, padTop = 7, trackY = 48, innerW = W - 2 * padX;
        const xA = (a) => padX + ((a - lo) / span) * innerW;       // semi-major axis → px
        const xU = (u) => xA(aMin + u * aSpan);                    // density coord → px (ring span)
        let yMax = 1;
        for (const a of anchors) yMax = Math.max(yMax, a.y);
        const SAMPLES = 80;
        const rho = [];
        for (let k = 0; k <= SAMPLES; k++) { const r = density(k / SAMPLES); rho.push(r); yMax = Math.max(yMax, r); }
        const yBase = trackY - 8;
        const yOf = (v) => padTop + (1 - v / yMax) * (yBase - padTop);

        let curve = `M ${xU(0).toFixed(1)} ${yOf(rho[0]).toFixed(1)}`;
        for (let k = 1; k <= SAMPLES; k++) curve += ` L ${xU(k / SAMPLES).toFixed(1)} ${yOf(rho[k]).toFixed(1)}`;
        const areaPath = curve + ` L ${xU(1).toFixed(1)} ${yBase.toFixed(1)} L ${xU(0).toFixed(1)} ${yBase.toFixed(1)} Z`;

        const pts = anchors.map((a) =>
          `<circle cx="${xU(a.x).toFixed(1)}" cy="${yOf(a.y).toFixed(1)}" r="2.3" fill="var(--accent-hot)"/>`
        ).join("");
        const ticks = aVals.map((a) =>
          `<line x1="${xA(a).toFixed(1)}" y1="${trackY - 5}" x2="${xA(a).toFixed(1)}" y2="${trackY + 5}" stroke="var(--accent)" stroke-width="1" opacity="0.85"/>`
        ).join("");

        html += `<div class="metric-card">`;
        html += `<div class="metric-header"><span class="metric-label">Relay distribution</span><span class="metric-value-sm">${aVals.length} rings</span></div>`;
        html += `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;margin-top:4px;">`;
        html += `<path d="${areaPath}" fill="var(--accent-dim)" stroke="none"/>`;
        html += `<path d="${curve}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
        html += pts;
        html += `<line x1="${padX}" y1="${trackY}" x2="${padX + innerW}" y2="${trackY}" stroke="var(--border-2)" stroke-width="1"/>`;
        html += ticks;
        html += `<text x="${padX}" y="${H - 2}" font-size="9" fill="var(--text-2)">Earth ${aEarth.toFixed(2)} AU</text>`;
        html += `<text x="${padX + innerW}" y="${H - 2}" font-size="9" fill="var(--text-2)" text-anchor="end">Mars ${aMars.toFixed(2)} AU</text>`;
        html += `</svg>`;
        html += `</div>`;
      }

      // ── 3a-bis. ADAPTED-ECCENTRIC CLOSENESS (apsides vs planet orbits) ──
      // For each adapted-eccentric ring, plot how its perihelion meets Earth's orbit
      // and its aphelion meets Mars's orbit, per ecliptic longitude. Two distance
      // lines (planet orbit + ring apsis) on the left axis trace the planets' eccentric
      // breathing; the signed gap (+ clearance / − overshoot) rides a right axis with a
      // zero line, so the Earth-/Mars-side clearance sliders are visible directly.
      const eccApsides = this.simSatellites.getAdaptedEccentricApsides
        ? this.simSatellites.getAdaptedEccentricApsides()
        : [];
      if (eccApsides.length > 0) {
        const closenessChart = (key, planetLabel) => {
          const rows = eccApsides.slice().sort((a, b) => a[key].angle - b[key].angle);
          const apsisLabel = key === "apo" ? "aphelion" : "perihelion";
          const W = 300, H = 122, padL = 30, padR = 30, padTop = 10, padBot = 26;
          const plotW = W - padL - padR, plotH = H - padTop - padBot;
          const x = (ang) => padL + (ang / 360) * plotW;
          // Gap series = the ring's WORST clearance over its whole orbit (not the apsis
          // gap, which is just the flat clearance margin). Negative ⇒ satellites stray
          // inside Earth / beyond Mars. This auto-scales around 0 so it stays readable at
          // any clearance and reveals exactly where rings cross the planet orbit.
          const gapOf = (r) => (key === "apo" ? r.worstMars : r.worstEarth).gap;
          // Left axis: planet + ring apsis distances (the two "breathing" curves).
          let dMin = Infinity, dMax = -Infinity, gMin = 0, gMax = 0;
          for (const r of rows) {
            dMin = Math.min(dMin, r[key].planetR, r[key].ringR);
            dMax = Math.max(dMax, r[key].planetR, r[key].ringR);
            gMin = Math.min(gMin, gapOf(r));
            gMax = Math.max(gMax, gapOf(r));
          }
          const dPad = (dMax - dMin) * 0.12 || 0.01;
          dMin -= dPad; dMax += dPad;
          const dSpan = dMax - dMin || 1;
          const gPad = (gMax - gMin) * 0.15 || 1e-4;
          gMin -= gPad; gMax += gPad;
          const gSpan = gMax - gMin || 1;
          const yL = (d) => padTop + (1 - (d - dMin) / dSpan) * plotH;
          const yR = (g) => padTop + (1 - (g - gMin) / gSpan) * plotH;
          const poly = (accessor, scale) =>
            rows.map((r, i) => `${i ? "L" : "M"} ${x(r[key].angle).toFixed(1)} ${scale(accessor(r)).toFixed(1)}`).join(" ");
          const planetPath = poly((r) => r[key].planetR, yL);
          const ringPath = poly((r) => r[key].ringR, yL);
          const gapPath = poly(gapOf, yR);
          // When "Quad" satellite coloring is active, tint each ring's marker by the
          // solar-angle quadrant of its apsis (same palette as the 2D/3D view), so the
          // chart's per-ring dots match how the satellites are colored on screen.
          const useQuad = this.satelliteColorMode === "Quad";
          const QUAD = ["#dd2222", "#22dd22", "#2222dd", "#666666"];
          const quadColor = (ang) => QUAD[Math.min(3, Math.floor((((ang % 360) + 360) % 360) / 90))];
          const dot = (accessor, scale, color) =>
            rows.map((r) => {
              const v = accessor(r);
              // Overshoot (gap < 0) is always flagged red, regardless of color mode.
              const c = v < 0 ? "#dd2222" : useQuad ? quadColor(r[key].angle) : color;
              return `<circle cx="${x(r[key].angle).toFixed(1)}" cy="${scale(v).toFixed(1)}" r="${v < 0 ? 2.8 : useQuad ? 2.4 : 1.6}" fill="${c}"/>`;
            }).join("");
          const zeroY = yR(0);
          const worstGap = Math.min(...rows.map(gapOf));
          // Mark this planet's own perihelion (P) and aphelion (A): vertical reference
          // lines at their ecliptic longitudes (perihelion at arg-of-perihelion p,
          // aphelion 180° opposite), with the apsis distance a(1∓e). Shows where the
          // planet's orbit-distance curve troughs/peaks relative to each ring's apsis.
          const planet = key === "apo" ? this.simSatellites.getMars() : this.simSatellites.getEarth();
          const apsisMarks = [];
          if (planet && isFinite(planet.a) && isFinite(planet.e)) {
            const pLon = (((planet.p || 0) % 360) + 360) % 360;
            apsisMarks.push({ lon: pLon, r: planet.a * (1 - planet.e), tag: "P" });
            apsisMarks.push({ lon: ((pLon + 180) % 360 + 360) % 360, r: planet.a * (1 + planet.e), tag: "A" });
          }
          html += `<div class="metric-card">`;
          html += `<div class="metric-header"><span class="metric-label">${planetLabel}-side closeness</span>`;
          html += `<span class="metric-value-sm" style="color:${worstGap < 0 ? "var(--accent-hot)" : "var(--text-2)"}">min ${(worstGap >= 0 ? "+" : "−")}${Math.abs(worstGap).toFixed(4)} AU</span></div>`;
          html += `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;margin-top:4px;">`;
          // Overshoot zone: gap < 0 (below the zero line) = satellites beyond the planet
          // orbit. Shade it faint red so any dip into it is obvious. Gate on the true
          // worst gap (not the padded axis min) so it only appears on real overshoot.
          if (worstGap < 0) {
            const oy = Math.min(padTop + plotH, zeroY);
            html += `<rect x="${padL}" y="${oy.toFixed(1)}" width="${plotW}" height="${(padTop + plotH - oy).toFixed(1)}" fill="#dd2222" opacity="0.10"/>`;
          }
          // zero line for the gap (right axis)
          html += `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${padL + plotW}" y2="${zeroY.toFixed(1)}" stroke="var(--border-2)" stroke-width="1" stroke-dasharray="2 2"/>`;
          // planet perihelion / aphelion reference verticals (drawn behind the curves)
          for (const mk of apsisMarks) {
            const mx = x(mk.lon);
            html += `<line x1="${mx.toFixed(1)}" y1="${padTop}" x2="${mx.toFixed(1)}" y2="${(padTop + plotH).toFixed(1)}" stroke="#c9a227" stroke-width="0.8" stroke-dasharray="1 2" opacity="0.7"/>`;
            html += `<circle cx="${mx.toFixed(1)}" cy="${yL(mk.r).toFixed(1)}" r="2" fill="none" stroke="#c9a227" stroke-width="1"/>`;
            html += `<text x="${mx.toFixed(1)}" y="${(padTop - 2).toFixed(1)}" font-size="7.5" fill="#c9a227" text-anchor="middle">${mk.tag} ${mk.r.toFixed(2)}</text>`;
          }
          html += `<path d="${planetPath}" fill="none" stroke="var(--text-2)" stroke-width="1.3"/>`;
          html += `<path d="${ringPath}" fill="none" stroke="var(--accent)" stroke-width="1.3"/>`;
          html += `<path d="${gapPath}" fill="none" stroke="var(--accent-hot)" stroke-width="1.5"/>`;
          html += dot(gapOf, yR, "var(--accent-hot)");
          // left/right axis end labels
          html += `<text x="2" y="${(padTop + 4).toFixed(1)}" font-size="8" fill="var(--text-2)">${dMax.toFixed(2)}</text>`;
          html += `<text x="2" y="${(padTop + plotH).toFixed(1)}" font-size="8" fill="var(--text-2)">${dMin.toFixed(2)} AU</text>`;
          html += `<text x="${W - 2}" y="${(padTop + 4).toFixed(1)}" font-size="8" fill="var(--accent-hot)" text-anchor="end">${gMax >= 0 ? "+" : ""}${gMax.toFixed(3)}</text>`;
          html += `<text x="${W - 2}" y="${(padTop + plotH).toFixed(1)}" font-size="8" fill="var(--accent-hot)" text-anchor="end">${gMin.toFixed(3)} Δ</text>`;
          // x ticks
          for (const a of [0, 90, 180, 270, 360]) {
            html += `<text x="${x(a).toFixed(1)}" y="${H - 6}" font-size="8" fill="var(--text-2)" text-anchor="middle">${a}°</text>`;
          }
          // legend
          html += `<text x="${padL}" y="${H - 14}" font-size="7.5" fill="var(--text-2)"><tspan fill="var(--text-2)">━ ${planetLabel}</tspan>  <tspan fill="var(--accent)">━ ring ${apsisLabel}</tspan>  <tspan fill="var(--accent-hot)">━ min gap</tspan>  <tspan fill="#c9a227">┊ P/A</tspan></text>`;
          html += `</svg>`;
          html += `</div>`;
        };
        closenessChart("peri", "Earth");
        closenessChart("apo", "Mars");
      }

      // ── 3b. FLOW ──
      const actualFlowMbps = networkData?.maxFlowGbps ? networkData.maxFlowGbps * 1000 : (this.maxFlowGbps ? this.maxFlowGbps * 1000 : 0);
      const flowSelected = this.linksColors === "Flow";
      const hasFlow = flowSelected && actualFlowMbps > 0;

      const algoName = this.simLinkBudget.flowAlgorithm || "unknown";

      html += `<div class="metric-card">`;
      html += `<div class="metric-header">`;
      html += `<span class="metric-label">Flow<span class="metric-badge">${algoName}</span></span>`;
      if (hasFlow) {
        html += `<span class="metric-value-sm">${fmtMbps(actualFlowMbps)}</span>`;
      } else {
        html += `<span class="metric-na">\u2014</span>`;
      }
      html += `</div>`;

      if (hasFlow) {
        const earthFlow = { side1: 0, side2: 0 };
        const marsFlow = { side1: 0, side2: 0 };
        if (networkData?.links) {
          const getFlows = (planetName) => {
            const flows = networkData.links
              .filter((l) => l.fromId === planetName || l.toId === planetName)
              .map((l) => (l.gbpsFlow || 0) * 1000).sort((a, b) => b - a);
            return { side1: flows[0] || 0, side2: flows[1] || 0 };
          };
          const ef = getFlows("Earth");
          earthFlow.side1 = ef.side1; earthFlow.side2 = ef.side2;
          const mf = getFlows("Mars");
          marsFlow.side1 = mf.side1; marsFlow.side2 = mf.side2;
        }
        const earthFlowTotal = earthFlow.side1 + earthFlow.side2;
        const marsFlowTotal = marsFlow.side1 + marsFlow.side2;

        // Active Earth\u2194relay / Mars\u2194relay routes (links that actually carry flow). A relay
        // ring is any ring_* that isn't a planet ring \u2014 the old code hard-coded "ring_adapt",
        // so this count read 0 for the eccentric/circular families; keeping it relay-type
        // agnostic makes the Flow card correct for every relay family.
        let earthActive = null, marsActive = null;
        if (networkData?.links) {
          const isRelayRing = (id) => id && id.startsWith("ring_") && !id.startsWith("ring_earth") && !id.startsWith("ring_mars");
          const countActive = (planetPrefix) => networkData.links.filter((l) =>
            l.gbpsFlow > 0 &&
            ((l.fromId.startsWith(planetPrefix) && isRelayRing(l.toId)) ||
             (l.toId.startsWith(planetPrefix) && isRelayRing(l.fromId)))
          ).length;
          earthActive = countActive("ring_earth");
          marsActive = countActive("ring_mars");
        }
        const adaptedFlowPct = rs && rs.totalThroughput > 0 ? pct(actualFlowMbps, rs.totalThroughput) : "";

        html += `<div class="metric-sub">${pct(actualFlowMbps, rs ? rs.totalThroughput : earthCapTotal)} of capacity</div>`;

        // Toggle for flow diagram (closed \u2192 compact ASCII \u2192 expanded SVG)
        html += `<div class="metric-toggle" id="flow-toggle">`;
        html += `<span class="arrow" id="flow-arrow">&#9656;</span><span>Diagram</span>`;
        html += `</div>`;

        // Ring-to-relay junction flow (sum of gbpsFlow over planet-ring/relay links);
        // by conservation it tracks the end-to-end flow — the useful reading is each
        // junction's UTILIZATION against its capacity line in the diagram above.
        let eJctFlow = 0, mJctFlow = 0, eJctFlowStat = null, mJctFlowStat = null;
        if (networkData?.links) {
          const isRelayRingJ = (id) => id && id.startsWith("ring_") && !id.startsWith("ring_earth") && !id.startsWith("ring_mars");
          const jFlow = (planetPrefix) => {
            const flows = networkData.links.filter((l) =>
              ((l.fromId.startsWith(planetPrefix) && isRelayRingJ(l.toId)) ||
               (l.toId.startsWith(planetPrefix) && isRelayRingJ(l.fromId)))
            ).map((l) => (l.gbpsFlow || 0) * 1000).filter((f) => f > 0);
            const sum = flows.reduce((s, f) => s + f, 0);
            return { sum, count: flows.length, min: flows.length ? minOf(flows) : 0,
                     max: flows.length ? maxOf(flows) : 0, avg: flows.length ? sum / flows.length : 0 };
          };
          const ej = jFlow("ring_earth"), mj = jFlow("ring_mars");
          eJctFlow = ej.sum; mJctFlow = mj.sum; eJctFlowStat = ej; mJctFlowStat = mj;
        }
        const relayFlowPct = rs ? pct(actualFlowMbps, rs.relayOnlyThroughput ?? rs.totalThroughput) : "";

        // Compact flow diagram (ASCII, mirrors the 5-line compact Capacity diagram)
        html += `<pre class="capacity-diagram" id="flow-compact" style="display: none;">`;
        html += planetLine(earthFlow.side1, "\u25CF", earthFlow.side2, `${fmtMbps(earthFlowTotal)}, ${pct(earthFlowTotal, earthCapTotal)}`, -2);
        html += jctLine(eJct, `${fmtMbps(eJctFlow)}, ${pct(eJctFlow, eJct.sum)}`);
        if (rs) html += `${pipes}  ${fmtMbps(actualFlowMbps)}, ${relayFlowPct}\n`;
        html += jctLine(mJct, `${fmtMbps(mJctFlow)}, ${pct(mJctFlow, mJct.sum)}`);
        html += planetLine(marsFlow.side1, "\u2022", marsFlow.side2, `${fmtMbps(marsFlowTotal)}, ${pct(marsFlowTotal, marsCapTotal)}`, 2);
        html += `</pre>`;

        // Expanded flow diagram \u2014 vertical Earth\u2192relay\u2192Mars data path as SVG, the same
        // skeleton as the Capacity diagram with flow-reading labels (works for both ring
        // families). The compact ASCII above stays for the mid toggle state.
        html += `<div id="flow-content" style="display: none;">`;
        html += this._flowPathSvg({
          rs, earthInring, marsInring, earthFlow, marsFlow, earthFlowTotal, marsFlowTotal,
          earthCapTotal, marsCapTotal, actualFlowMbps, earthActive, marsActive,
          relayRingCount, bottleneckLine, eJct, mJct, eJctFlowStat, mJctFlowStat,
          fmtMbps, fmtRange, fmtNum, pct,
        });
        html += `</div>`;
      } else if (!flowSelected) {
        html += `<div class="metric-sub">Select Flow to enable</div>`;
      }

      html += `</div>`;
    }

    // ── 4. COST / MBPS ──
    html += `<div class="metric-card">`;
    html += `<div class="metric-header">`;
    html += `<span class="metric-label">Cost / Mbps</span>`;
    if (costs && costs.costPerMbps && costs.costPerMbps !== Infinity) {
      html += `<span class="metric-value">$${costs.costPerMbps.toLocaleString()}</span>`;
    } else {
      html += `<span class="metric-na">\u2014</span>`;
    }
    html += `</div>`;
    if (!this.linksColors || this.linksColors !== "Flow") {
      html += `<div class="metric-sub">Select Flow to enable</div>`;
    }
    html += `</div>`;

    // ── 5. LATENCY ──
    html += `<div class="metric-card">`;
    html += `<div class="metric-header">`;
    html += `<span class="metric-label">Latency</span>`;
    if (latencyData && !isNaN(latencyData.bestLatency)) {
      const best = (latencyData.bestLatency / 60).toFixed(1);
      const p50 = (latencyData.medianLatency / 60).toFixed(1);
      html += `<span class="metric-value-sm">${best} | ${p50} min</span>`;
      html += `</div>`;
      html += `<div class="metric-sub">min | p50</div>`;
      html += `<div class="metric-toggle" id="latency-toggle">`;
      html += `<span class="arrow" id="latency-arrow">&#9656;</span><span>Chart</span>`;
      html += `</div>`;
      html += `<div id="latency-content" style="display: none;">`;
      html += `<div class="chart-wrap"><canvas id="latencyChart"></canvas></div>`;
      html += `</div>`;
    } else if (networkData && networkData.error) {
      html += `<span class="metric-na">Timed out</span>`;
      html += `</div>`;
    } else if (this.linksColors !== "Flow") {
      html += `<span class="metric-na">\u2014</span>`;
      html += `</div>`;
      html += `<div class="metric-sub">Select Flow to enable</div>`;
    } else {
      html += `<span class="metric-na">\u2014</span>`;
      html += `</div>`;
    }
    html += `</div>`;

    // \u2500\u2500 6. FLEET LINK (in-transit ship connectivity) \u2014 last card. \u2500\u2500
    html += this.fleetConnectivityHtml();

    return html;
  }

  updatePerfPanel() {
    // Refresh sensitivity estimate whenever worker timings change
    if (this.ui?._updateSensEstimate) this.ui._updateSensEstimate();
    const el = document.getElementById("perf-area-content");
    if (!el) return;
    let html = "";

    const row = (label, value, indent = false) =>
      `<div class="detail-row"${indent ? ' style="padding-left:8px"' : ""}><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
    const sep = () => `<div style="border-top:1px solid var(--border-1);margin:4px 0"></div>`;

    // ── Renderer ──
    html += `<div class="metric-card">`;
    html += `<div class="metric-header"><span class="metric-label">Renderer</span></div>`;
    const renderer = this.simDisplay?.renderer;
    if (renderer) {
      const gl = renderer.getContext();
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      const gpuName = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "Unknown";
      html += row("3D engine", "Three.js (WebGL 2)");
      html += `<div class="detail-row"><span class="detail-label">GPU</span><span class="detail-value" style="font-size:9px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${gpuName}">${gpuName.split("/")[0]?.split("(")[1]?.replace(")", "") || gpuName}</span></div>`;
      const info = renderer.info;
      if (info) {
        html += row("Draw calls", info.render?.calls?.toLocaleString() || "—");
        html += row("Triangles", info.render?.triangles?.toLocaleString() || "—");
        html += row("Geometries", info.memory?.geometries?.toLocaleString() || "—");
        html += row("Textures", info.memory?.textures?.toLocaleString() || "—");
      }
    } else {
      html += row("3D engine", "Not initialized");
    }
    if (performance.memory) {
      const mb = (b) => `${Math.round(b / 1048576)} MB`;
      html += row("JS heap", `${mb(performance.memory.usedJSHeapSize)} / ${mb(performance.memory.jsHeapSizeLimit)}`);
    }
    html += `</div>`;

    // ── Worker pipeline ──
    html += `<div class="metric-card">`;
    html += `<div class="metric-header"><span class="metric-label">Worker pipeline</span>`;
    const wt = this.lastWorkerTimings;
    html += `<span class="metric-value-sm">${wt?.totalMs || "—"} ms</span></div>`;
    if (wt?.topology) {
      const tt = wt.topology;
      html += row("setSatellitesConfig", `${wt.flow?.setSatellitesConfig ?? "—"} ms`);
      html += sep();
      html += row("Topology total", `${tt.total ?? "—"} ms`);
      html += row("setup", `${tt.setup ?? "—"} ms`, true);
      html += row("intraRing", `${tt.intraRing ?? "—"} ms`, true);
      html += row("interAdaptedRings", `${tt.interAdaptedRings ?? "—"} ms`, true);
      html += row("planetToRings", `${tt.planetToRings ?? "—"} ms`, true);
      html += row("routes + capture", `${(tt.routes || 0) + (tt.captureTopology || 0)} ms`, true);
      html += row("links generated", (tt.links || 0).toLocaleString(), true);
    }
    if (wt?.flow) {
      const ft = wt.flow;
      html += sep();
      html += row("Max-flow", ft.getNetworkData != null ? `${ft.getNetworkData} ms` : "— ms");
      html += row("Latencies", ft.calculateLatencies != null ? `${ft.calculateLatencies} ms` : "— ms");
    } else {
      html += sep();
      html += row("Max-flow", "— ms");
      html += row("Latencies", "— ms");
    }
    html += `</div>`;

    // ── Simulation ──
    html += `<div class="metric-card">`;
    html += `<div class="metric-header"><span class="metric-label">Simulation</span></div>`;
    html += row("Satellites", (this.satellitesCount || 0).toLocaleString());
    html += row("Window duration", `${Math.round(this.WINDOW_DURATION / 3600000)} h`);
    html += row("Cache", `${this.windowCache.size} / 3 windows`);
    html += row("Config epoch", this.configEpoch);
    html += row("Flow algorithm", this.simLinkBudget.flowAlgorithm || "—");
    html += `</div>`;

    el.innerHTML = html;
  }

  calculateCapacityInfo(links) {
    const ringCapacities = {};
    const interCap = {};
    links.forEach((link) => {
      let fromRing = link.fromId.split("-")[0];
      let toRing = link.toId.split("-")[0];
      // Treat planet nodes as their respective rings
      if (fromRing === "Earth") fromRing = "ring_earth";
      if (fromRing === "Mars") fromRing = "ring_mars";
      if (toRing === "Earth") toRing = "ring_earth";
      if (toRing === "Mars") toRing = "ring_mars";
      const cap = link.gbpsCapacity * 1000;
      if (!ringCapacities[fromRing]) ringCapacities[fromRing] = { inring: [], flows: 0, flowsCount: 0, planetLinks: [] };
      if (!ringCapacities[toRing]) ringCapacities[toRing] = { inring: [], flows: 0, flowsCount: 0, planetLinks: [] };
      if (fromRing === toRing) {
        const isPlanetLink = link.fromId === "Earth" || link.toId === "Earth" || link.fromId === "Mars" || link.toId === "Mars";
        if (isPlanetLink) {
          // Planet-to-satellite ground links — track separately, don't mix into inring
          if (link.fromId === "Earth" || link.toId === "Earth") {
            const satId = link.fromId === "Earth" ? link.toId : link.fromId;
            ringCapacities["ring_earth"].planetLinks.push({ cap, satId });
          }
          if (link.fromId === "Mars" || link.toId === "Mars") {
            const satId = link.fromId === "Mars" ? link.toId : link.fromId;
            ringCapacities["ring_mars"].planetLinks.push({ cap, satId });
          }
        } else {
          // Actual satellite-to-satellite intra-ring links
          ringCapacities[fromRing].inring.push(cap);
        }
      } else {
        const isInterplanetary =
          (fromRing === "ring_earth" && toRing === "ring_mars") || (fromRing === "ring_mars" && toRing === "ring_earth");
        if (isInterplanetary) {
          ringCapacities[fromRing].flows += cap;
          ringCapacities[toRing].flows += cap;
          ringCapacities[fromRing].flowsCount += 1;
          ringCapacities[toRing].flowsCount += 1;
        } else {
          // inter-ring, add to planetLinks if from planet
          if (fromRing === "ring_earth") {
            const satId = link.toId;
            ringCapacities["ring_earth"].planetLinks.push({ cap, satId });
          }
          if (fromRing === "ring_mars") {
            const satId = link.toId;
            ringCapacities["ring_mars"].planetLinks.push({ cap, satId });
          }
          // For interCap, for all inter-ring except interplanetary
          const key = [fromRing, toRing].sort().join("-");
          if (!interCap[key]) interCap[key] = { sum: 0, count: 0, min: Infinity, max: 0 };
          interCap[key].sum += cap;
          interCap[key].count += 1;
          if (cap < interCap[key].min) interCap[key].min = cap;
          if (cap > interCap[key].max) interCap[key].max = cap;
        }
      }
    });
    return { ringCapacities, interCap };
  }

  /**
   * Prepares the HTML for the info area, including the latency chart.
   *
   * @param {Object} networkData - The network data containing flows and graph information.
   * @param {Object} latencyData - The latency data containing histogram, bestLatency, averageLatency.
   * @returns {string} - The HTML string for the info area.
   */
  getInfoAreaHTML(networkData, latencyData) {
    let html = "";

    if (networkData.error) {
      html += `Error: timed out (too many sats)`;
    } else {
      if (networkData.maxFlowGbps > 0) html += `Total throughput: ${Math.round(networkData.maxFlowGbps * 1000)} Mbps`;
      else html += "No connection";
    }
    html += `<br>`;

    if (latencyData && !isNaN(latencyData.bestLatency)) {
      const bestLatencyMinutes = (latencyData.bestLatency / 60).toFixed(1);
      const averageLatencyMinutes = (latencyData.averageLatency / 60).toFixed(1);
      html += `Latency: Best ${bestLatencyMinutes} min - Avg ${averageLatencyMinutes} min<br>`;
    }

    html += "<br>";

    return html;
  }

  // ─── Worker dispatch helpers ──────────────────────────────────────────

  /**
   * Restore sim time advancement after a cache-wait pause.
   */
  unpauseCacheWait() {
    if (!this.simTimePausedForCache) return;
    this.simTimePausedForCache = false;
    if (this._savedAcceleration !== undefined) {
      this.simTime.timeAccelerationFactor = this._savedAcceleration;
      this._savedAcceleration = undefined;
    }
  }

  /**
   * Post a compute request to the worker for a given window.
   * Only one request in flight at a time; if the worker is busy, the caller
   * should wait (the next frame will retry via prefetch).
   */
  dispatchWorker(windowIdx, simDate) {
    if (!this.workerReady || !this._lastUiConfig || !this.appliedSatellitesConfig) return;
    this.lastRequestId++;
    this.workerBusy = true;
    this.inFlightWindowIdx = windowIdx;
    const computeFlow =
      this.linksColors === "Flow" &&
      (this.simLinkBudget.calctimeMs > 0 || this.pendingUpdates.has("config") || this.pendingUpdates.has("display"));
    // Recalc status: the worker always computes topology (links) first.
    this._inFlightComputeFlow = computeFlow;
    this.recalcPhase = "links";
    this.recalcStart = performance.now();
    this.simWorker.postMessage({
      type: "compute",
      requestId: this.lastRequestId,
      windowIdx,
      configEpoch: this.configEpoch,
      uiConfig: this._lastUiConfig,
      satellitesConfig: this.appliedSatellitesConfig,
      simDate,
      computeFlow,
    });
    this.updateWorkerStatus();
  }

  /**
   * Apply a cached window result to the display + UI.
   */
  applyWindowResult(result) {
    this.lastNetworkData = result.networkData || null;
    this.lastLatencyData = result.latencyData || null; // surfaced to the archive metric capture
    this.maxFlowGbps = result.networkData ? result.networkData.maxFlowGbps || 0 : 0;
    this.capacityInfo = result.capacityInfo || null;
    this.routeSummary = result.routeSummary || null;
    this.missionProfiles = result.missionProfilesData || null;
    this.resultTrees = result.resultTreesData || [];
    this.updateSatelliteFuel();
    this._maybeAutoRefreshReport();
    if (typeof result.satellitesCount === "number") this.satellitesCount = result.satellitesCount;

    if (this.simDisplay) {
      this.simDisplay.updatePossibleLinks(result.possibleLinks || []);
      this.simDisplay.updateActiveLinks(result.networkData ? result.networkData.links || [] : []);
    }
    if (this.ui) {
      this.ui.updateInfoAreaCosts(
        this.getCostsHtml(this.calculateCosts(this.maxFlowGbps, this.resultTrees), this.lastNetworkData, result.latencyData)
      );
      this.ui.updateInfoAreaData("");
      if (result.latencyData) {
        this.makeLatencyChart(result.latencyData, 60 * 5);
      } else {
        this.makeLatencyChart(null);
      }
    }
  }

  /**
   * Receives results from the worker and stores them in the window cache.
   */
  handleWorkerMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ready") {
      this.workerReady = true;
      console.log("[Marslink] Worker ready");
      // Kick off initial computation if config is already applied
      if (this.appliedSatellitesConfig && this._lastUiConfig) {
        const simDate = this.simTime.getDate();
        const windowIdx = Math.floor(simDate / this.WINDOW_DURATION);
        this.dispatchWorker(windowIdx, new Date((windowIdx + 0.5) * this.WINDOW_DURATION));
      }
      return;
    }

    if (msg.type === "error") {
      console.error("[Marslink] Worker error:", msg.message);
      this.workerBusy = false;
      this.inFlightWindowIdx = null;
      this.recalcPhase = "idle";
      this.updateWorkerStatus();
      return;
    }

    // --- LINKS-READY: early delivery of possibleLinks before flow is done ---
    if (msg.type === "links-ready") {
      if (msg.configEpoch !== this.configEpoch) return; // stale
      // Use displayedWindowIdx as reference (not getDate which may be frozen)
      const refIdx = this.displayedWindowIdx ?? Math.floor(this.simTime.getDate() / this.WINDOW_DURATION);

      // Store links in a partial cache entry (flow fields will be merged later)
      const existing = this.windowCache.get(msg.windowIdx);
      if (!existing || existing.configEpoch !== this.configEpoch) {
        this.windowCache.set(msg.windowIdx, { ...msg, networkData: null, latencyData: null, partial: true });
      }

      // If this is the displayed window, show links immediately
      if (msg.windowIdx === refIdx) {
        this.capacityInfo = msg.capacityInfo || null;
        this.routeSummary = msg.routeSummary || null;
        this.missionProfiles = msg.missionProfilesData || null;
        this.resultTrees = msg.resultTreesData || [];
        this.updateSatelliteFuel();
        this._maybeAutoRefreshReport();
        // Earth/Mars auto-size: size each planet ring's worst-case in-ring rate to half
        // the live relay capacity (the Capacity card number). Fires on the earlier
        // links-ready path so the user sees the correction without waiting for the flow.
        if (this.ui?.runPlanetSizingStep) this.ui.runPlanetSizingStep();
        if (typeof msg.satellitesCount === "number") this.satellitesCount = msg.satellitesCount;
        if (this.simDisplay) {
          this.simDisplay.updatePossibleLinks(msg.possibleLinks || []);
        }
        // Update capacity UI with links data (flow will come later)
        if (this.ui) {
          this.ui.updateInfoAreaCosts(
            this.getCostsHtml(this.calculateCosts(this.maxFlowGbps, this.resultTrees), this.lastNetworkData, null)
          );
        }
        this.displayedWindowIdx = refIdx;
      }

      // If we're paused waiting for an adjacent window and this is it, unpause
      if (this.simTimePausedForCache && this.displayedWindowIdx !== null &&
          Math.abs(msg.windowIdx - this.displayedWindowIdx) <= 1) {
        this.unpauseCacheWait();
      }

      console.log(`[Marslink] Worker links: window ${msg.windowIdx} | ${msg.possibleLinks?.length || 0} links | ${msg.linksMs}ms`);
      if (msg.topologyTimings) {
        const tt = msg.topologyTimings;
        console.log(`[Marslink] Topology: ${Object.entries(tt).map(([k, v]) => `${k}=${v}${typeof v === "number" && k !== "links" ? "ms" : ""}`).join(" | ")}`);
      }
      this.lastWorkerTimings = { links: msg.linksMs, topology: msg.topologyTimings };
      // Recalc status: links done for the in-flight window → enter the flow phase.
      if (typeof msg.linksMs === "number") { this._lastLinksMs = msg.linksMs; this._estLinksMs = msg.linksMs; }
      if (this.inFlightWindowIdx === msg.windowIdx && this._inFlightComputeFlow) {
        this.recalcPhase = "flow";
        this.recalcStart = performance.now();
      }
      this.updatePerfPanel();
      this.updateWorkerStatus();
      return;
    }

    // --- RESULT: full result with flow data ---
    if (msg.type !== "result") return;

    this.workerBusy = false;
    this.inFlightWindowIdx = null;
    // Recalc status: full result in → back to idle; refresh the flow estimate.
    this.recalcPhase = "idle";
    if (this._inFlightComputeFlow && typeof msg.totalMs === "number") {
      this._estFlowMs = Math.max(0, msg.totalMs - (this._lastLinksMs || 0));
    }

    // Drop stale results (old config epoch)
    if (msg.configEpoch !== this.configEpoch) {
      this.updateWorkerStatus();
      return;
    }

    // Merge flow data into the cached entry (links were already stored by links-ready)
    const cached = this.windowCache.get(msg.windowIdx);
    if (cached && cached.configEpoch === this.configEpoch) {
      cached.networkData = msg.networkData;
      cached.latencyData = msg.latencyData;
      cached.timings = msg.timings;
      cached.totalMs = msg.totalMs;
      cached.partial = false;
    } else {
      this.windowCache.set(msg.windowIdx, msg);
    }

    // Evict distant windows (keep only -1, 0, +1 relative to displayed)
    const refIdx = this.displayedWindowIdx ?? Math.floor(this.simTime.getDate() / this.WINDOW_DURATION);
    for (const key of this.windowCache.keys()) {
      if (Math.abs(key - refIdx) > 2) this.windowCache.delete(key);
    }

    // If this result is for the displayed window, apply flow overlay.
    // If time is paused waiting for the NEXT window and this result is it,
    // unpause — the next updateLoop frame will swap and resume time.
    if (msg.windowIdx === refIdx) {
      this.applyWindowResult({ ...this.windowCache.get(refIdx) });
      this.displayedWindowIdx = refIdx;
    }
    if (this.simTimePausedForCache && this.displayedWindowIdx !== null &&
        Math.abs(msg.windowIdx - this.displayedWindowIdx) <= 1) {
      this.unpauseCacheWait();
    }

    // Log
    const algoName = this.simLinkBudget.flowAlgorithm || "default";
    const flowGbps = msg.networkData?.maxFlowGbps?.toFixed(1) ?? "—";
    console.log(
      `[Marslink] Worker flow: window ${msg.windowIdx} | Flow ${flowGbps} Gbps (${algoName}) | ${msg.totalMs}ms`
    );
    if (msg.timings) {
      console.log(`[Marslink] Worker phases: ${Object.entries(msg.timings).map(([k, v]) => `${k}=${v}ms`).join(" | ")}`);
    }
    this.lastWorkerTimings = {
      ...this.lastWorkerTimings,
      flow: msg.timings,
      totalMs: msg.totalMs,
      topology: msg.topologyTimings || this.lastWorkerTimings?.topology,
    };

    this.updateWorkerStatus();
    this.updatePerfPanel();
  }

  /**
   * Update the -1/0/+1 status indicator in the bottom bar.
   */
  updateWorkerStatus() {
    const currentIdx = Math.floor(this.simTime.getDate() / this.WINDOW_DURATION);

    // ── Recalc phase chip: Idle / Computing links / Computing flow / Prefetching ──
    // "Foreground" = computing the window we need NOW (e.g. right after a config
    // change, when sim time is paused waiting). Background prefetch of an adjacent
    // window is shown more quietly so steady playback isn't noisy.
    const recalcEl = document.getElementById("recalc-status");
    if (recalcEl) {
      const foreground =
        this.workerBusy &&
        (this.inFlightWindowIdx === currentIdx || this.displayedWindowIdx === null || this.simTimePausedForCache);
      const phase = !this.workerBusy ? "idle" : foreground ? this.recalcPhase : "prefetch";
      const label = recalcEl.querySelector(".recalc-label");
      const fill = recalcEl.querySelector(".recalc-bar-fill");
      recalcEl.classList.remove("phase-idle", "phase-links", "phase-flow", "phase-prefetch", "indeterminate");
      const fmtS = (ms) => (ms / 1000).toFixed(1);

      recalcEl.classList.add(`phase-${phase}`);
      recalcEl.title = "Link & flow recalculation status";
      if (phase === "links" || phase === "flow") {
        const est = phase === "links" ? this._estLinksMs : this._estFlowMs;
        const elapsed = performance.now() - this.recalcStart;
        const name = phase === "links" ? "Computing links" : "Computing flow";
        if (est > 0) {
          label.textContent = `${name}… ${fmtS(elapsed)} / ~${fmtS(est)}s`;
          fill.style.width = `${Math.min(99, (elapsed / est) * 100)}%`;
        } else {
          label.textContent = `${name}… ${fmtS(elapsed)}s`;
          fill.style.width = "100%";
          recalcEl.classList.add("indeterminate"); // unknown duration → animated bar
        }
      } else if (phase === "prefetch") {
        label.textContent = "Prefetching…";
        fill.style.width = "100%";
        recalcEl.classList.add("indeterminate");
      } else {
        label.textContent = "Idle";
        fill.style.width = "0%";
      }
    }

    // ── Past / Current / Next window cache pills ──
    const el = document.getElementById("worker-status");
    if (el) {
      const slotState = (idx) => {
        const cached = this.windowCache.get(idx);
        if (cached && cached.configEpoch === this.configEpoch) return cached.partial ? "partial" : "ready";
        if (this.inFlightWindowIdx === idx) return "computing";
        return "empty";
      };
      const stateText = { empty: "empty", computing: "computing…", partial: "links ready, flow pending", ready: "ready" };
      const names = ["Past", "Current", "Next"];
      const idxs = [currentIdx - 1, currentIdx, currentIdx + 1];
      el.querySelectorAll(".cache-pill").forEach((pill, i) => {
        const st = slotState(idxs[i]);
        const cls = `cache-pill state-${st}`;
        if (pill.className !== cls) pill.className = cls;
        const title = `${names[i]} window: ${stateText[st]}`;
        if (pill.title !== title) pill.title = title;
      });
    }

    // ── Warnings (flow timeout, max-sats cap) ──
    const warnEl = document.getElementById("sim-warnings");
    if (warnEl) {
      const warnings = [];
      // (The over-cap case is a hard error on the view — see showSatCapError — not
      // a soft warning, since the truncated sim would be misleading.)
      // Planet-ring bottleneck: an Earth/Mars ring carries meaningfully less than
      // the relay, so it (not the relay) caps flow — typically the sat budget
      // limiting its size. Reuses the capacity card's computed bottleneck.
      const bn = this._bottleneckInfo;
      if (bn && bn.name === "no relay rings") {
        warnings.push(`No relay rings — no Earth↔Mars path`);
      } else if (bn && (bn.name === "earth ring" || bn.name === "mars ring") && bn.relayCap > 0 && bn.cap < bn.relayCap * 0.9) {
        const planet = bn.name === "mars ring" ? "Mars" : "Earth";
        const g = (mbps) => (mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} Gbps` : `${Math.round(mbps)} Mbps`);
        warnings.push(`${planet} ring limits flow (${g(bn.cap)} < relay ${g(bn.relayCap)})`);
      }
      if (this.linksColors === "Flow" && this.lastNetworkData && this.lastNetworkData.error) {
        warnings.push(`Flow calc timed out — raise “Allowed flow calc time”`);
      }
      const html = warnings.map((w) => `<span class="sim-warning">⚠ ${w}</span>`).join("");
      if (html !== this._lastWarnHtml) {
        this._lastWarnHtml = html;
        warnEl.innerHTML = html;
        warnEl.hidden = !html;
      }
    }
  }

  /**
   * Identify which parameter group is driving the satellite count, so the
   * over-cap error can tell the user exactly what to reduce.
   */
  computeSatCapDriver() {
    const cfg = this.appliedSatellitesConfig || [];
    const groups = {};
    for (const c of cfg) {
      const rn = c.ringName || "";
      let key;
      if (rn === "ring_earth") key = "Earth ring throughput";
      else if (rn === "ring_mars") key = "Mars ring throughput";
      else if (rn.startsWith("ring_adapt") || rn.startsWith("ring_circ")) key = "Relay ring count / throughput";
      else if (rn.startsWith("ring_adecc")) key = "Adapted Eccentric rings";
      else if (rn.startsWith("ring_ecce")) key = "Eccentric rings";
      else key = "the ring parameters";
      groups[key] = (groups[key] || 0) + (c.satCount || 0);
    }
    let top = "the ring parameters", max = -1;
    for (const [k, v] of Object.entries(groups)) if (v > max) { max = v; top = k; }
    return top;
  }

  /** Show the over-cap error overlay and blank stale metrics. */
  showSatCapError() {
    const el = document.getElementById("sim-error-overlay");
    if (!el) return;
    const req = this.simSatellites.requestedSatelliteCount || 0;
    const cap = this.simSatellites.maxSatCount || 0;
    const driver = this.computeSatCapDriver();
    const msg =
      `<div class="sim-error-title">Too many satellites to simulate</div>` +
      `<div class="sim-error-body">This configuration needs <b>${req.toLocaleString()}</b> satellites — ` +
      `over the <b>${cap.toLocaleString()}</b> cap.</div>` +
      `<div class="sim-error-actions">Increase <b>Max Satellites in Simulation</b>, or reduce <b>${driver}</b>.</div>`;
    if (el.hidden || el._lastMsg !== msg) {
      el.innerHTML = msg;
      el._lastMsg = msg;
      el.hidden = false;
      // Blank stale metrics so nothing misleading remains beside the error.
      if (this.ui) this.ui.updateInfoAreaCosts("");
    }
  }

  /** Hide the over-cap error overlay (sim is back within the cap). */
  hideSatCapError() {
    const el = document.getElementById("sim-error-overlay");
    if (el && !el.hidden) { el.hidden = true; el._lastMsg = null; }
  }

  // ─── Core update loop ───────────────────────────────────────────────

  /**
   * Per-frame update loop. Satellite positions update every frame (cheap).
   * Link/flow computation is delegated to the worker and cached in the
   * -1/0/+1 window buffer. The main thread never blocks on link computation.
   */
  updateLoop() {
    // During sensitivity runs, skip the entire update loop to prevent
    // stale worker results from flashing old links on new satellites.
    if (this._sensitivityRunning) return;

    let simDate = this.simTime.getDate();
    if (this.ui) this.ui.updateSimTime(simDate);
    const planets = this.simSolarSystem.updatePlanetsPositions(simDate);

    // --- Phase 1: Config change → local sat rebuild + cache invalidation ---
    let configJustApplied = false;
    if (this.newSatellitesConfig) {
      const t0 = performance.now();
      this.simSatellites.setSatellitesConfig(this.newSatellitesConfig);
      const setMs = Math.round(performance.now() - t0);
      this.satellitesCount = this.simSatellites.getSatellites().length;
      console.log(`[Marslink] Main: setSatellitesConfig=${setMs}ms (${this.satellitesCount} sats)`);
      this.appliedSatellitesConfig = this.newSatellitesConfig;
      this.newSatellitesConfig = null;
      configJustApplied = true;

      // Invalidate cache — all windows are stale
      this.configEpoch++;
      this.windowCache.clear();
      this.displayedWindowIdx = null;

      // Clear display links (avoid sat/link name mismatch)
      if (this.simDisplay) {
        this.simDisplay.updatePossibleLinks([]);
        this.simDisplay.updateActiveLinks([]);
      }

      // Don't add "links"/"config" to pendingUpdates — the configEpoch bump +
      // windowCache.clear() + displayedWindowIdx=null already cause Phase 3 to
      // dispatch the worker. Adding them caused a double-dispatch: the first
      // compute would finish, workerBusy→false, but "links" was still in
      // pendingUpdates → the else-if branch dispatched window 0 again.
      this.pendingUpdates.add("satellites_display");
    }

    // --- Cap guard: refuse to run an over-cap (truncated, misleading) sim ---
    // Show an error on the view and skip all compute/display until the user
    // raises the cap or reduces the driving parameters.
    if (this.simSatellites.satellitesTruncated) {
      this.satellitesCount = this.simSatellites.requestedSatelliteCount;
      if (this.simDisplay) {
        this.simDisplay.updatePossibleLinks([]);
        this.simDisplay.updateActiveLinks([]);
        if (configJustApplied) this.simDisplay.setSatellites([]);
        this.simDisplay.updatePositions(planets, []);
      }
      this.showSatCapError();
      this.updateWorkerStatus();
      return;
    }
    this.hideSatCapError();

    // --- Phase 2: Per-frame satellite positions ---
    const satellites = this.simSatellites.updateSatellitesPositions(simDate);

    // --- Phase 3: Window cache check + worker dispatch ---
    let currentWindowIdx = Math.floor(simDate / this.WINDOW_DURATION);
    const timeDirection = simDate >= this.previousSimDate ? 1 : -1;
    this.previousSimDate = simDate;

    // Compute the representative sim date for a window — the MIDPOINT, so
    // the link geometry is most accurate across the full window.
    const windowMidDate = (idx) => new Date((idx + 0.5) * this.WINDOW_DURATION);

    // If we've crossed into a window that isn't cached, pause sim time
    // by zeroing the acceleration factor. getDate() then accumulates
    // zero sim-time each frame → satellites freeze in place. When the
    // worker delivers the missing window, we restore the factor.
    if (currentWindowIdx !== this.displayedWindowIdx && this.displayedWindowIdx !== null) {
      const cached = this.windowCache.get(currentWindowIdx);
      if (!cached || cached.configEpoch !== this.configEpoch) {
        if (!this.simTimePausedForCache) {
          this.simTimePausedForCache = true;
          this._savedAcceleration = this.simTime.timeAccelerationFactor;
          this.simTime.timeAccelerationFactor = 0;
        }
      }
    }

    // Check if current window is cached and fresh
    if (currentWindowIdx !== this.displayedWindowIdx) {
      const cached = this.windowCache.get(currentWindowIdx);
      if (cached && cached.configEpoch === this.configEpoch) {
        // INSTANT SWAP — precomputed window is ready
        this.applyWindowResult(cached);
        this.displayedWindowIdx = currentWindowIdx;
        this.unpauseCacheWait();
        this.pendingUpdates.delete("links");
        this.pendingUpdates.delete("config");
        this.pendingUpdates.delete("display");
      } else if (!this.workerBusy || this.inFlightWindowIdx !== currentWindowIdx) {
        // Not cached, not in flight → dispatch worker for current window
        if (!this.workerBusy) {
          this.dispatchWorker(currentWindowIdx, windowMidDate(currentWindowIdx));
        }
      }
    } else if (this.pendingUpdates.has("links") || this.pendingUpdates.has("display")) {
      // Same window but needs refresh (e.g., Flow mode toggled)
      if (!this.workerBusy) {
        this.windowCache.delete(currentWindowIdx);
        this.dispatchWorker(currentWindowIdx, windowMidDate(currentWindowIdx));
        this.pendingUpdates.delete("links");
        this.pendingUpdates.delete("config");
        this.pendingUpdates.delete("display");
      }
    }

    // --- Phase 4: Prefetch next window ---
    if (!this.workerBusy && this.displayedWindowIdx !== null) {
      const nextIdx = currentWindowIdx + timeDirection;
      const nextCached = this.windowCache.get(nextIdx);
      if (!nextCached || nextCached.configEpoch !== this.configEpoch) {
        this.dispatchWorker(nextIdx, windowMidDate(nextIdx));
      }
    }

    // --- Phase 5: Per-frame display ---
    if (configJustApplied && this.simDisplay) {
      this.simDisplay.setSatellites(satellites);
      // Run the station-keeping model (per-ring + per-sat) on the main-thread deployment
      // FIRST — it feeds both the display (satPhysics) and the deployment-report cost.
      const bodyPos = {};
      for (const p of Object.values(planets)) if (p && p.position) bodyPos[p.name] = p.position;
      this.simDeployment.computeStationKeeping(satellites, this.simSatellites.getOrbitalElements(), bodyPos, this.skCfg);
      this.pushSatellitePhysics();
      this.pendingUpdates.delete("satellites_display");
    }
    if (this.simDisplay) this.simDisplay.updatePositions(planets, satellites);

    // --- Phase 5b: Spacecraft-flight overlay (fleet transfers) ---
    if (this.simDisplay && this.simFlight && this.simFlight.enabled && this.simDisplay.setFlightData) {
      const earthEle = Array.isArray(planets) ? planets.find((p) => p && p.name === "Earth") : null;
      const marsEle = Array.isArray(planets) ? planets.find((p) => p && p.name === "Mars") : null;
      this.simFlight.ensureFleet(earthEle, marsEle);
      const fd = this.simFlight.getRenderData(simDate);

      // Extension links need the constellation backbone (BFS over the full link
      // graph), so recompute periodically and reuse between refreshes.
      const possibleLinks = this.simDisplay.possibleLinks;
      this._flightExtFrame = (this._flightExtFrame || 0) + 1;
      if (fd.count > 0 && possibleLinks && possibleLinks.length && this.simLinkBudget.maxDistanceAU > 0 && this._flightExtFrame % 20 === 0) {
        try {
          this._flightExt = this.simFlight.computeExtension({ planets, satellites, possibleLinks, simLinkBudget: this.simLinkBudget, simDate });
          this._flightExtVersion++; // bump so the Fleet-link card rebuilds its charts with fresh data
        } catch (e) { /* overlay is non-fatal */ }
      }
      if (this._flightExt && fd.count > 0 && this.simFlight.showShips) {
        fd.links = this._flightExt.links || [];
        const connectedSet = new Set((this._flightExt.perShip || []).filter((s) => s.connected).map((s) => s.shipId));
        for (const sh of fd.ships) sh.connected = connectedSet.has(sh.id);
      }
      this.simDisplay.setFlightData(fd);
      // Keep the right-panel Fleet card live as time animates (throttled).
      if (this._flightExtFrame % 15 === 0) this.refreshFleetMetric();
    }

    // --- Phase 5c: Monte-Carlo coverage-field overlay (independent probes) ---
    if (this.simDisplay && this.simProbe && this.simProbe.enabled && this.simDisplay.setProbeData) {
      this.simProbe.ensureCloud(this.simSatellites.getEarth(), this.simSatellites.getMars());

      // The probe cloud is STATIC and the backbone reach only changes when the
      // worker delivers a new window (a new possibleLinks). So measure ONCE per
      // window change (or when the cloud was resampled), NOT on a frame timer —
      // the measurement (rooted-backbone extraction + four widest/shortest-path
      // passes over ~10k+ links) is a heavy synchronous calc that, when run every
      // N frames, stalls the render loop periodically. Event-driving it makes the
      // steady-state per-frame cost ~zero.
      const possibleLinks = this.simDisplay.possibleLinks;
      const backboneReady = possibleLinks && possibleLinks.length && this.simLinkBudget.maxDistanceAU > 0;
      if (backboneReady && (possibleLinks !== this._probeMeasdLinks || !this.simProbe.hasMeasurement())) {
        try {
          this._probeMeas = this.simProbe.measure({ planets, satellites, possibleLinks, simLinkBudget: this.simLinkBudget });
          this._probeMeasdLinks = possibleLinks;
          this._probeMeasVersion++;
        } catch (e) { /* overlay is non-fatal */ }
      }

      // getRenderData is cached, so it returns the same object until the
      // measurement/cloud changes — only re-push to the display when it actually
      // changed (or the display instance switched 2D↔3D).
      const rd = this.simProbe.getRenderData();
      if (rd !== this._lastProbeRender || this.simDisplay !== this._lastProbeDisplay) {
        this.simDisplay.setProbeData(rd);
        this._lastProbeRender = rd;
        this._lastProbeDisplay = this.simDisplay;
      }
      if (this._probeMeasVersion !== this._coverageDrawnVersion) this.refreshCoverageMetric();
    }

    if (this.pendingUpdates.has("satellites_display")) {
      if (this.simDisplay) this.simDisplay.setSatellites(satellites);
      this.pendingUpdates.delete("satellites_display");
    }

    // --- Phase 6: Status indicator + perf panel refresh ---
    this.updateWorkerStatus();
    // Refresh perf panel every ~2s (120 frames at 60fps) for live GPU/memory stats
    this._perfFrameCount = (this._perfFrameCount || 0) + 1;
    if (this._perfFrameCount >= 120) {
      this._perfFrameCount = 0;
      this.updatePerfPanel();
    }
  }

  startSimulationLoop() {
    const loop = () => {
      try {
        this.updateLoop();
      } catch (e) {
        console.error("[Marslink] updateLoop error:", e);
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  // Assuming this is within a class context
  async longTermRun(dates, { skipDisplay = false, useTimeout = false } = {}) {
    const data = [];
    const calctimeMs = 20000;

    // Helper function to round numbers to a specified precision
    function rnd(number, precision) {
      const factor = Math.pow(10, precision);
      return Math.round(number * factor) / factor;
    }

    // Initialize start and end dates
    let currentDate = new Date(dates.from);
    const endDate = new Date(dates.to);

    let networkData; // Declare networkData outside the loop

    // Recompute mission profiles + cost trees for THIS constellation. longTermRun
    // is the batch path (sensitivity sweep) and nothing else refreshes these during
    // a sweep — without this, cost/flow lag one scenario behind and produce an
    // outlier at every tech transition (first ring shows the previous tech's last).
    try {
      this.missionProfiles = this.simDeployment.getMissionProfile(this.simSatellites.getOrbitalElements());
      this.resultTrees = new SimMissionValidator(this.missionProfiles, {
        costPerLaunch: this.costPerLaunch,
        costPerSatellite: this.costPerSatellite,
        costPerLaserTerminal: this.costPerLaserTerminal,
        laserPortsPerRing: this.simLinkBudget.maxLinksPerRing,
        propellantCostsPerKg: this.propellantCostsPerKg,
        wrightsLawFactor: this.wrightsLawFactor,
      });
    } catch (e) {
      console.warn("[longTermRun] mission profile failed:", e.message);
    }

    return new Promise((resolve, reject) => {
      const step = () => {
        if (currentDate > endDate) {
          // After the loop, handle the final data
          if (networkData) {
            const finalCosts = this.calculateCosts(networkData.maxFlowGbps, this.resultTrees);
            delete finalCosts.costPerMbps; // Remove 'costPerMbps' as per refactoring

            // Summarize the collected data
            const dataSummary = this.summarizeLongTermData(data);
            this.updateLoop();

            // Resolve the promise with the result
            resolve({ dates, calctimeMs, costs: finalCosts, dataSummary, data });
          } else {
            // Handle the case where networkData is undefined
            console.error("No networkData was generated during the simulation.");
            const dataSummary = this.summarizeLongTermData(data);
            this.updateLoop();
            resolve({ dates, calctimeMs, costs: {}, dataSummary, data });
          }
          return; // Terminate the simulation
        }

        // Process the current simulation step
        const simDate = new Date(currentDate); // Clone the current date

        try {
          // Update positions of planets and satellites for the current simulation date
          const planets = this.simSolarSystem.updatePlanetsPositions(simDate);

          const satellites = this.simSatellites.updateSatellitesPositions(simDate);

          // Get possible links based on current positions
          const possibleLinks = this.simNetwork.getPossibleLinks(planets, satellites);

          // Retrieve network data
          networkData = this.simNetwork.getNetworkData(planets, satellites, possibleLinks, calctimeMs);

          // Leave simMain state consistent with the just-computed scenario so the
          // sensitivity capture reads fresh values, not the previous scenario's.
          this.routeSummary = this.simNetwork.routeSummary || null;
          this.capacityInfo = this.calculateCapacityInfo(possibleLinks);
          this.maxFlowGbps = networkData.error ? 0 : networkData.maxFlowGbps || 0;
          this.lastNetworkData = networkData;

          // Update the display (skip during batch sensitivity runs)
          if (!skipDisplay && this.simDisplay) {
            this.removeLinks();
            this.simDisplay.updatePositions(planets, satellites);
            this.simDisplay.updatePossibleLinks(possibleLinks);
            this.simDisplay.updateActiveLinks(networkData.links);
            this.simDisplay.animate();
          }

          // Calculate latency data
          const latencyData = this.simNetwork.calculateLatencies(networkData);
          this.lastLatencyData = latencyData; // surfaced to the sensitivity capture

          const costs = this.calculateCosts(networkData.maxFlowGbps, this.resultTrees);

          // Extract relevant metrics
          const maxFlowGbps = networkData.error ? null : networkData.maxFlowGbps;
          const bestLatencyMinutes = latencyData.bestLatency !== null ? rnd(latencyData.bestLatency / 60, 1) : null;
          const avgLatencyMinutes = latencyData.averageLatency !== null ? rnd(latencyData.averageLatency / 60, 1) : null;
          const maxLatencyMinutes = latencyData.maxLatency !== null ? rnd(latencyData.maxLatency / 60, 1) : null;
          const possibleLinksCount = possibleLinks.length;

          // Push the collected data into the 'data' array
          data.push({
            simDate: simDate.toISOString(), // Format date to ISO string
            possibleLinksCount,
            maxFlowGbps,
            bestLatencyMinutes,
            avgLatencyMinutes,
            maxLatencyMinutes,
            latencyHistogram: latencyData.histogram,
            costPerMbps: costs.costPerMbps,
          });

          // Increment the current date by 'stepDays'
          currentDate.setDate(currentDate.getDate() + dates.stepDays);
        } catch (error) {
          // Handle any unexpected errors during the simulation step
          console.error("Error during simulation step:", error);
          reject(error);
          return;
        }

        // Schedule the next simulation step. Use setTimeout for batch runs
        // — rAF can stall if the animation loop crashes.
        const schedule = (useTimeout || skipDisplay) ? (fn) => setTimeout(fn, 0) : requestAnimationFrame;
        schedule(step);
      };

      // Start the simulation
      const schedule = (useTimeout || skipDisplay) ? (fn) => setTimeout(fn, 0) : requestAnimationFrame;
      schedule(step);
    });
  }

  /**
   * Summarizes the long-term simulation data by calculating the minimum and average values
   * for each metric, along with the total number of simulated days.
   *
   * @param {Array<Object>} data - The array of simulation data objects.
   * @returns {Object} - An object containing the summary:
   *                     {
   *                       dayCount: number,
   *                       possibleLinksCount: { min: number, avg: number },
   *                       maxFlowGbps: { min: number, avg: number },
   *                       bestLatencyMinutes: { min: number, avg: number },
   *                       avgLatencyMinutes: { min: number, avg: number },
   *                       costPerMbps: { min: number, avg: number }
   *                     }
   */
  summarizeLongTermData(data) {
    // Initialize summary object with dayCount
    const summary = {
      dayCount: data.length,
      possibleLinksCount: { min: null, avg: null, max: null },
      maxFlowGbps: { min: null, avg: null, max: null },
      bestLatencyMinutes: { min: null, avg: null, max: null },
      avgLatencyMinutes: { min: null, avg: null, max: null },
      costPerMbps: { min: null, avg: null, max: null },
    };

    // Define the fields to summarize
    const fields = ["possibleLinksCount", "maxFlowGbps", "bestLatencyMinutes", "avgLatencyMinutes", "maxLatencyMinutes", "costPerMbps"];

    fields.forEach((field) => {
      // Extract non-null values for the current field
      const values = data.map((entry) => entry[field]).filter((value) => value !== null && value !== undefined);

      if (values.length > 0) {
        // Calculate minimum value
        const min = minOf(values);
        const max = maxOf(values);

        // Calculate average value
        const sum = values.reduce((acc, val) => acc + val, 0);
        const avg = sum / values.length;

        // Assign to summary
        summary[field] = { min, avg, max };
      } else {
        // If no valid data, keep min and avg as null
        summary[field] = { min: null, avg: null, max: null };
      }
    });

    return summary;
  }
  /**
   * Called whenever missionProfiles gets (re)populated by the worker.
   * If the Deployment tab is waiting on data and the panel is visible,
   * render the report automatically so the user doesn't have to re-open it.
   */
  _maybeAutoRefreshReport() {
    if (!this._reportPendingAutoRefresh) return;
    if (!this.missionProfiles) return;
    const panel = document.getElementById("report-panel");
    if (!panel || panel.hidden) {
      // Panel was dismissed; drop the armed state so we don't surprise-render later.
      this._reportPendingAutoRefresh = false;
      return;
    }
    this.generateReport();
  }

  /**
   * Generates the deployment report and renders it into the in-page #report-panel.
   */
  generateReport() {
    if (!this.missionProfiles) {
      const body = document.getElementById("report-panel-body");
      if (body) {
        body.innerHTML = `<p class="empty-state">Waiting for simulation data…</p>`;
      }
      // Arm an auto-refresh so the report renders itself as soon as the
      // worker delivers missionProfiles — no need for the user to re-open
      // the Deployment tab.
      this._reportPendingAutoRefresh = true;
      console.warn("Report data not available yet — will auto-refresh when ready.");
      return;
    }
    this._reportPendingAutoRefresh = false;
    const costs = {
      costPerLaunchMillionUSD: this.costPerLaunch,
      costPerSatelliteMillionUSD: this.costPerSatellite,
      costPerLaserTerminalMillionUSD: this.costPerLaserTerminal,
      laserPortsPerRing: this.simLinkBudget.maxLinksPerRing,
      propellantCostsPerKg: this.propellantCostsPerKg,
    };
    // Pull live launch-schedule slider values and Earth's orbital elements
    // so the report can compute per-flight dates and draw Hohmann transfers.
    const scheduleConfig = this.ui ? this.ui.getGroupsConfig(["launch_schedule"]) : {};
    const schedule = {
      startYear: scheduleConfig["launch_schedule.start_year"] ?? 2028,
      rampEndYear: scheduleConfig["launch_schedule.ramp_end_year"] ?? 2031,
      hoursBetweenFlights: scheduleConfig["launch_schedule.hours_between_flights"] ?? 8,
      scrubFactorPct: scheduleConfig["launch_schedule.scrub_factor_pct"] ?? 20,
    };
    const earthElements = this.simSatellites.getEarth();
    const marsElements = this.simSatellites.getMars();
    const orbitalElements = this.simSatellites.getOrbitalElements();
    generateReport(
      this.missionProfiles,
      this.resultTrees,
      costs,
      this.simSatellites.getSatellites(),
      { schedule, earthElements, marsElements, orbitalElements, simDeployment: this.simDeployment }
    );
  }
}
// Initialize the simulation once the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  const simMain = new SimMain();
});
