// simMain.js

import { SimUi } from "./simUi.js?v=4.3";
import { SimTime } from "./simTime.js?v=4.3";
import { SimSolarSystem } from "./simSolarSystem.js?v=4.3";
import { SimSatellites } from "./simSatellites.js?v=4.3";
import { SimDeployment } from "./simDeployment.js?v=4.3";
import { SimMissionValidator } from "./simMissionValidator.js?v=4.3";
import { SimLinkBudget } from "./simLinkBudget.js?v=4.3";
import { SimNetwork } from "./simNetwork.js?v=4.3";
// Import both SimDisplay implementations with unique names
import { SimDisplay as SimDisplay2D } from "./simDisplay-2d.js?v=4.3";
import { SimDisplay as SimDisplay3D } from "./simDisplay-3d.js?v=4.3";
import { generateReport } from "./reportGenerator.js?v=4.3";
import { SIM_CONSTANTS } from "./simConstants.js?v=4.3";

export class SimMain {
  // Clamp argument to [-1, 1] to prevent NaN from Math.asin domain errors
  safeAsin(x) {
    return Math.asin(Math.max(-1, Math.min(1, x)));
  }

  constructor() {
    this.previousLinkUpdateSimDate = 0;
    this.newSatellitesConfig = null;
    this.appliedSatellitesConfig = null; // last config sent to the worker
    this.pendingUpdates = new Set(); // tracks: 'links', 'config', 'display', 'satellites_display'

    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simLinkBudget = new SimLinkBudget();
    this.simDeployment = new SimDeployment(this.simSolarSystem.getSolarSystemData().planets);
    this.simSatellites = new SimSatellites(this.simLinkBudget, this.simSolarSystem.getSolarSystemData().planets);
    // simNetwork is kept on the main thread ONLY for the longTermRun batch
    // path. The live updateLoop pipeline runs in the worker (see simWorker.js).
    this.simNetwork = new SimNetwork(this.simLinkBudget, this.simSatellites);

    // --- Spawn the heavy-pipeline worker ---
    // The worker owns its own SimSatellites/SimNetwork/etc. and handles
    // setSatellitesConfig + getPossibleLinks + getNetworkData + latencies in
    // the background, so the 3D camera stays at 60 fps during slider drags.
    this.simWorker = new Worker(new URL("./simWorker.js?v=4.5", import.meta.url), { type: "module" });
    this.simWorker.onmessage = (event) => this.handleWorkerMessage(event);
    this.simWorker.onerror = (event) => {
      console.error("[Marslink] Worker error:", event.message, event);
    };
    this.simWorker.postMessage({ type: "init" });
    this.lastRequestId = 0;
    this.latestResultRequestId = 0;

    // Do not instantiate simDisplay here; it will be set by setDisplayType
    this.simDisplay = null;
    this.linksColors = null;
    this.satelliteColorMode = "Quad";
    this.sunSizeFactor = 1;
    this.planetsSizeFactor = 1;
    this.satelliteSizeFactor = 1;

    this.previousCalctimeMs = this.simLinkBudget.calctimeMs;

    this.ui = new SimUi(this);
    console.log("[Marslink] Simulation initialized");

    this.latencyChartInstance = null;
    this.missionProfiles = null; // Initialize reportData storage
    this.resultTrees = []; // populated from worker results
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
    this.simDisplay.setSizeFactors(this.sunSizeFactor, this.planetsSizeFactor);
    this.simDisplay.setSatelliteColorMode(this.satelliteColorMode);

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
    const wasZero = this.satelliteSizeFactor === 0;
    const isZero = factor === 0;
    this.satelliteSizeFactor = factor;
    if (this.simDisplay && typeof this.simDisplay.setSizeFactors === "function") {
      this.simDisplay.setSizeFactors(this.sunSizeFactor, this.planetsSizeFactor, this.satelliteSizeFactor);
    }
    // Crossing the 0 boundary changes whether satellite meshes are drawn at all,
    // so we need to rebuild the instanced display from the current sat list.
    if (wasZero !== isZero) {
      this.pendingUpdates.add("satellites_display");
    }
  }

  setCircularRingsConfig(uiConfig) {
    let ringCount = uiConfig["circular_rings.ringcount"];
    if (ringCount == 0) return [];
    ringCount += 2;
    const mbpsBetweenSats = uiConfig["circular_rings.requiredmbpsbetweensats"];
    if (mbpsBetweenSats == 0) return [];
    const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
    const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
    const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
    const earthMarsInclinationPct = uiConfig["circular_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
    const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
    const satellitesConfig = [];
    for (let ringId = 1; ringId < ringCount - 1; ringId++) {
      // Determine ring type
      const ringType = "Circular";
      let satDistanceSunAu = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
      // if (ringCount == 3) satDistanceSunAu = (distInnerAu + distOuterAu) / 2;
      // const circumferenceAu = 2 * Math.PI * satDistanceSunAu;
      // const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);
      let satDistanceSunAuBias =
        Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);
      const satCount = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias)));

      // Push the satellite configuration for this ring
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: satDistanceSunAu,
        ringName: "ring_circ_" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
        eccentricity: 0,
        raan: 0,
        argPeri: 0,
        earthMarsInclinationPct,
      });
    }
    return satellitesConfig;
  }

  setEccentricRingsConfig(uiConfig) {
    const ringCount = uiConfig["eccentric_rings.ringcount"];
    const mbpsBetweenSats = uiConfig["eccentric_rings.requiredmbpsbetweensats"];
    if (ringCount == 0 || mbpsBetweenSats == 0) return [];
    const distAverageAu = uiConfig["eccentric_rings.distance-sun-average-au"];
    const eccentricity = uiConfig["eccentric_rings.eccentricity"];
    if (eccentricity >= 1) return [];
    const argPeriStart = uiConfig["eccentric_rings.argument-of-perihelion"];
    const earthMarsInclinationPct = uiConfig["eccentric_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
    const satellitesConfig = [];
    for (let ringId = 0; ringId < ringCount; ringId++) {
      // Determine ring type
      const ringType = "Eccentric";
      // const circumferenceAu = 2 * Math.PI * distAverageAu;
      // const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);
      const satCount = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * distAverageAu)));
      const argPeri = (argPeriStart + (ringId * 360) / ringCount) % 360;

      // Push the satellite configuration for this ring
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: distAverageAu,
        ringName: "ring_ecce_" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
        eccentricity,
        raan: 0,
        argPeri,
        earthMarsInclinationPct,
      });
    }
    return satellitesConfig;
  }

  setAdaptedRingsConfig(uiConfig) {
    const userRingCount = uiConfig["adapted_rings.ringcount"];
    if (userRingCount == 0) return [];
    let ringCount = userRingCount + 2;

    // Section 4.4: Optimal route count N from R_opt = sqrt(D_em * S / (sqrt(3) * pi * r_M))
    // Inverted for S = N*R: N = R * sqrt(3) * pi * r_M / D_em
    let routeCount;
    if (uiConfig["adapted_rings.auto_route_count"] === "yes") {
      const rM = this.simSatellites.getMars().a;
      const rE = this.simSatellites.getEarth().a;
      const Dem = rM - rE;
      routeCount = Math.round((userRingCount * Math.sqrt(3) * Math.PI * rM) / Dem);
    } else {
      routeCount = uiConfig["adapted_rings.route_count"];
    }
    if (routeCount == 0) return [];

    const linearSatCountIncrease = uiConfig["adapted_rings.linear_satcount_increase"];

    const distOuterAu = this.simSatellites.getMars().a;
    const distInnerAu = this.simSatellites.getEarthApsis().periapsis * 1.006;
    const earthMarsInclinationPct = 0.5;

    // 1. Calculate the Periapsis Radius for the start (Earth) and end (Mars)
    // Note: We use your existing interpolation function to get the 'e' at those points
    const eInner = this.simSatellites.interpolateOrbitalElementNonLinear(distInnerAu, "e");
    const eOuter = this.simSatellites.interpolateOrbitalElementNonLinear(distOuterAu, "e");

    const rpInner = distInnerAu * (1 - eInner);
    const rpOuter = distOuterAu * (1 - eOuter);

    // 2. Determine the linear step size for the Periapsis Radius
    const rpStep = (rpOuter - rpInner) / (ringCount - 1);

    const satellitesConfig = [];

    for (let ringId = 1; ringId < ringCount - 1; ringId++) {
      const ringType = "Adapted";

      // 3. Determine the Target Periapsis for this specific ring
      const targetRp = rpInner + rpStep * ringId;

      // 4. Solve for 'a' (Semi-Major Axis)
      // We need to find 'a' such that: a * (1 - e(a)) === targetRp
      // Since e(a) changes with a, we use a simple approximation loop to find the perfect a.

      let a_calc = targetRp; // Initial guess: assume e is 0, so a = rp

      // Iterate 5 times to refine 'a' (Converges very fast)
      for (let i = 0; i < 5; i++) {
        let e_current = this.simSatellites.interpolateOrbitalElementNonLinear(a_calc, "e");
        let rp_current = a_calc * (1 - e_current);
        let error = targetRp - rp_current;
        a_calc = a_calc + error; // Apply correction
      }

      let satDistanceSunAu = a_calc;
      let satCount = Math.ceil(routeCount * (1 + (linearSatCountIncrease * ringId) / ringCount));

      // Push the satellite configuration for this ring
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: satDistanceSunAu,
        ringName: "ring_adapt_" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
        eccentricity: null, // The simulation likely recalculates this from satDistanceSunAu later
        raan: null,
        argPeri: null,
        earthMarsInclinationPct,
      });
    }
    return satellitesConfig;
  }

  /**
   * Generates the satellites configuration array based on current slider values.
   * @returns {Array<Object>} - The satellites configuration array.
   */
  generateSatellitesConfig(uiConfig, ringName) {
    const satellitesConfig = [];

    // Fetch values from slidersData (already updated)
    const mbpsBetweenSats = uiConfig[ringName + ".requiredmbpsbetweensats"];
    let sideExtensionDeg = uiConfig[ringName + ".side-extension-degrees-slider"];
    let matchCircularRings = uiConfig[ringName + ".match-circular-rings"];
    if (sideExtensionDeg == 0 || (mbpsBetweenSats == 0 && matchCircularRings == "no")) return satellitesConfig;

    // Determine ring type
    let ringType = ringName == "ring_mars" ? "Mars" : "Earth";

    let satCount = 0;
    let gradientOneSideStartMbps = null;
    // this code is solely to determine gradientOneSideStartMbps
    if (matchCircularRings == "gradient") {
      let ringCount = uiConfig["circular_rings.ringcount"];
      if (ringCount == 0) {
        matchCircularRings = "no"; // fall back — no circular rings to match
      } else {
      ringCount += 2;
      const mbpsBetweenSatsCircular = uiConfig["circular_rings.requiredmbpsbetweensats"];
      if (mbpsBetweenSatsCircular == 0) return [];
      const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
      const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
      const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSatsCircular / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
      const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
      gradientOneSideStartMbps = 9999999999;
      for (let ringId = 1; ringId < ringCount - 2; ringId++) {
        let satDistanceSunAu1 = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
        let satDistanceSunAu2 = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * (ringId + 1);

        let satDistanceSunAuBias1 =
          Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);
        const satCount1 = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias1)));

        let satDistanceSunAuBias2 =
          Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * (ringId + 1) * ((100 - inringIntraringBiasPct) / 100);
        const satCount2 = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias2)));

        const distanceThisRingToNextAU = Math.abs(satDistanceSunAu1 - satDistanceSunAu2);
        const distanceThisRingToNextKm = this.simLinkBudget.convertAUtoKM(distanceThisRingToNextAU);
        const throughputThisRingToNextMbpsOneSat = this.simLinkBudget.calculateGbps(distanceThisRingToNextKm) * 1000;
        const throughputThisRingToNextMbpsAllSats = throughputThisRingToNextMbpsOneSat * Math.min(satCount1, satCount2);
        const throughputOneSideOfPlanet = throughputThisRingToNextMbpsAllSats / 2;
        if (throughputOneSideOfPlanet < gradientOneSideStartMbps) gradientOneSideStartMbps = Math.ceil(throughputOneSideOfPlanet);
      }
      } // end else (ringCount > 0)
    }
    if (
      // ringName == "ring_earth" &&
      matchCircularRings != "no" &&
      uiConfig["circular_rings.requiredmbpsbetweensats"] > 0 &&
      uiConfig["circular_rings.ringcount"] > 0
    ) {
      let ringCount = uiConfig["circular_rings.ringcount"];
      ringCount += 2;
      const mbpsBetweenSats = uiConfig["circular_rings.requiredmbpsbetweensats"];
      const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
      const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
      const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
      const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
      const ringId = 1;
      let satDistanceSunAuBias =
        Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);

      satCount = Math.ceil(((Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias))) * sideExtensionDeg) / 180);
      // sideExtensionDeg = 180;
    } else {
      const { a, n } = this.simSatellites.getParams_a_n(ringType);
      const distAverageAu = a;
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
      const circumferenceAu = 2 * Math.PI * distAverageAu;
      const actualCircumferenceAu = (circumferenceAu * sideExtensionDeg * 2) / 360;
      satCount = Math.ceil(actualCircumferenceAu / distanceAuBetweenSats);
    }

    // Push the satellite configuration for this ring
    satellitesConfig.push({
      satCount: satCount,
      satDistanceSun: null,
      ringName: ringName,
      ringType: ringType,
      sideExtensionDeg: sideExtensionDeg,
      eccentricity: 0,
      raan: 0,
      argPeri: 0,
      earthMarsInclinationPct: 0,
      gradientOneSideStartMbps,
    });

    return satellitesConfig;
  }

  setSatellitesConfig(uiConfig) {
    // Stash the latest uiConfig so the worker dispatch in updateLoop can
    // forward it on the next applyConfig.
    this._lastUiConfig = uiConfig;

    const satellitesConfig = [];

    this.simLinkBudget.setTechnologyConfig(uiConfig);
    if (this.simLinkBudget.calctimeMs !== this.previousCalctimeMs) {
      this.pendingUpdates.add('links');
      this.previousCalctimeMs = this.simLinkBudget.calctimeMs;
    }
    this.simDeployment.setSatelliteMassConfig(
      uiConfig["economics.satellite-empty-mass"],
      uiConfig["laser_technology.laser-terminal-mass"],
      {
        ring_earth: uiConfig["ring_earth.laser-ports-per-satellite"],
        ring_mars: uiConfig["ring_mars.laser-ports-per-satellite"],
        circular_rings: uiConfig["circular_rings.laser-ports-per-satellite"],
        eccentric_rings: uiConfig["eccentric_rings.laser-ports-per-satellite"],
        adapted_rings: uiConfig["adapted_rings.laser-ports-per-satellite"],
      }
    );

    this.simSatellites.setMaxSatCount(uiConfig["simulation.maxSatCount"]);

    satellitesConfig.push(...this.setCircularRingsConfig(uiConfig));
    satellitesConfig.push(...this.setAdaptedRingsConfig(uiConfig));
    satellitesConfig.push(...this.setEccentricRingsConfig(uiConfig));
    if (uiConfig["ring_mars.side-extension-degrees-slider"]) satellitesConfig.push(...this.generateSatellitesConfig(uiConfig, "ring_mars"));
    if (uiConfig["ring_earth.side-extension-degrees-slider"])
      satellitesConfig.push(...this.generateSatellitesConfig(uiConfig, "ring_earth"));

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
    // Use the histogram from latencyData
    if (latencyData) {
      const latencyHistogram = latencyData.histogram;

      // Get the canvas context
      const canvas = document.getElementById("latencyChart");
      if (!canvas) {
        console.warn("Latency chart canvas not found.");
        return;
      }
      const ctx = canvas.getContext("2d");

      // Prepare data for Chart.js
      const labels = latencyHistogram.map((bin) => {
        const startMin = bin.latency / 60;
        const endMin = (bin.latency + binSize) / 60;
        return `${startMin} - ${endMin} min`;
      });
      const data = latencyHistogram.map((bin) => bin.totalGbps);

      if (this.latencyChartInstance) {
        // Update existing chart
        this.latencyChartInstance.data.labels = labels;
        this.latencyChartInstance.data.datasets[0].data = data;
        this.latencyChartInstance.update();
      } else {
        // Create a new chart
        this.latencyChartInstance = new Chart(ctx, {
          type: "bar",
          data: {
            labels: labels,
            datasets: [
              {
                label: "Aggregate Gbps per Latency Bin",
                data: data,
                backgroundColor: "rgba(75, 192, 192, 0.6)",
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: {
                title: { display: true, text: "Latency (minutes)" },
              },
              y: {
                title: { display: true, text: "Aggregate Gbps" },
                beginAtZero: true,
              },
            },
            plugins: {
              tooltip: {
                callbacks: {
                  label: function (context) {
                    return `${context.parsed.y} Gbps`;
                  },
                },
              },
              legend: {
                display: false,
              },
            },
          },
        });
      }
    } else {
      // Clear the canvas entirely if latencyData is not available
      const canvas = document.getElementById("latencyChart");
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  setCosts(costConfig) {
    this.costPerLaunch = costConfig["economics.launch-cost-slider"];
    this.costPerSatellite = costConfig["economics.satellite-cost-slider"];
    this.costPerLaserTerminal = costConfig["economics.laser-terminal-cost-slider"];
    // The cost values are baked into resultTrees inside the worker (via
    // SimMissionValidator's costs argument). When the user moves a cost
    // slider we need a fresh worker pass — otherwise the displayed totals
    // would still reflect the previous slider position. The flag also
    // applies to the "satellite-empty-mass" slider, which feeds into the
    // deployment-vehicles calc.
    this.pendingUpdates.add("links");
    // Also update the info area immediately with whatever resultTrees we
    // currently have, so the change is at least partly reflected before the
    // worker reply lands.
    if (this.ui) this.ui.updateInfoAreaCosts(this.getCostsHtml(this.calculateCosts(this.maxFlowGbps, this.resultTrees), this.lastNetworkData));
  }

  calculateCosts(maxFlowGbps, resultTrees) {
    let totalSatellitesCount = 0;
    let totalLaunchCount = 0;
    let totalTankerCount = 0;
    let totalLiftoffCount = 0;
    let totalLaunchCost = 0;
    let totalPropellantCost = 0;
    let totalSatellitesCost = 0;
    let totalLaserTerminalsCost = 0;
    let propellantCostBreakdown = {};

    for (const orbit of resultTrees) {
      totalSatellitesCount += orbit.satellitesCount;
      totalLaunchCount += orbit.launchCount;
      totalTankerCount += orbit.tankerCount;
      totalLiftoffCount += orbit.liftoffCount;
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
    }

    const totalCosts = totalLaunchCost + totalPropellantCost + totalSatellitesCost + totalLaserTerminalsCost;

    let costPerMbps = Infinity;
    if (maxFlowGbps) costPerMbps = Math.round(totalCosts / (maxFlowGbps * 1000));

    return {
      satellitesCount: totalSatellitesCount,
      launchCount: totalLaunchCount,
      tankerCount: totalTankerCount,
      liftoffCount: totalLiftoffCount,
      launchCost: totalLaunchCost,
      propellantCost: totalPropellantCost,
      satellitesCost: totalSatellitesCost,
      laserTerminalsCost: totalLaserTerminalsCost,
      totalCosts,
      costPerMbps,
      propellantCostBreakdown,
    };
  }

  getCostsHtml(costs, networkData) {
    let html = "";
    // Always show satellite count
    html += `${this.satellitesCount} satellites`;
    // Show capacity diagram if available
    if (this.capacityInfo) {
      const { ringCapacities } = this.capacityInfo;
      const fmtMbps = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)} Gbps` : `${Math.round(v)} Mbps`;
      const fmtNum = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}` : `${Math.round(v)}`;
      const pct = (flow, cap) => cap > 0 ? `${Math.round(flow / cap * 100)}%` : "";
      // Format min|avg|max with shared unit (chosen by the smallest value)
      const fmtRange = (...vals) => {
        const unit = Math.min(...vals) >= 1000 ? "Gbps" : "Mbps";
        const fmt = unit === "Gbps" ? (v) => (v / 1000).toFixed(1) : (v) => Math.round(v);
        return vals.map(fmt).join("|") + " " + unit;
      };
      const showFlow = this.linksColors === "Flow";

      // Capacity data: inring link capacities per ring
      const earthInring = ringCapacities["ring_earth"]?.inring || [];
      const marsInring = ringCapacities["ring_mars"]?.inring || [];
      const earthCap = { side1: 0, side2: 0 };
      const marsCap = { side1: 0, side2: 0 };

      // Per-side capacity = actual capacity of the 2 planet-to-ring links
      const earthPlanetLinks = ringCapacities["ring_earth"]?.planetLinks || [];
      const earthCaps = earthPlanetLinks.map((l) => l.cap).sort((a, b) => b - a);
      earthCap.side1 = earthCaps[0] || 0;
      earthCap.side2 = earthCaps[1] || 0;

      const marsPlanetLinks = ringCapacities["ring_mars"]?.planetLinks || [];
      const marsCaps = marsPlanetLinks.map((l) => l.cap).sort((a, b) => b - a);
      marsCap.side1 = marsCaps[0] || 0;
      marsCap.side2 = marsCaps[1] || 0;

      // Flow data: actual flow on planet-to-satellite links
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

      // Pick values based on mode
      const earth = showFlow ? earthFlow : earthCap;
      const earthTotal = earth.side1 + earth.side2;
      const earthCapTotal = earthCap.side1 + earthCap.side2;
      const mars = showFlow ? marsFlow : marsCap;
      const marsTotal = mars.side1 + mars.side2;
      const marsCapTotal = marsCap.side1 + marsCap.side2;

      // Adapted rings route data (always capacity-based)
      const rs = this.routeSummary;

      // Actual flow from max-flow algorithm
      const actualFlowMbps = networkData?.maxFlowGbps ? networkData.maxFlowGbps * 1000 : (this.maxFlowGbps ? this.maxFlowGbps * 1000 : 0);

      // Build compact planet line: ---10←●→10---  Label
      const planetLine = (left, symbol, right, label, offset = 0) => {
        const core = `${fmtNum(left)}\u2190${symbol}\u2192${fmtNum(right)}`;
        const W = 17;
        const pad = Math.max(0, W - core.length);
        const padL = Math.max(0, Math.floor(pad / 2) + offset);
        const padR = Math.max(0, pad - padL);
        return `${"-".repeat(padL)}${core}${"-".repeat(padR)}  ${label}\n`;
      };

      // Adapted rings pipe string (shared by compact and expanded)
      const W = 17;
      const pipeCount = rs ? Math.min(rs.routeCount, W) : 0;
      const pad = rs ? Math.floor((W - pipeCount) / 2) : 0;
      const pipes = rs ? " ".repeat(pad) + "\u2502".repeat(pipeCount) : "";

      // Active route count (flow mode)
      let activeRoutes = 0;
      if (showFlow && networkData?.links) {
        activeRoutes = networkData.links.filter((l) => l.gbpsFlow > 0 && (
          (l.fromId.startsWith("ring_earth") && l.toId.startsWith("ring_adapt")) ||
          (l.fromId.startsWith("ring_adapt") && l.toId.startsWith("ring_earth"))
        )).length;
      }
      const adaptedFlowPct = rs && rs.totalThroughput > 0 ? pct(actualFlowMbps, rs.totalThroughput) : "";

      // Bottleneck analysis (always based on capacity)
      const segments = [];
      if (earthCapTotal > 0) segments.push({ name: "earth ring", cap: earthCapTotal });
      if (rs) segments.push({ name: "adapted rings", cap: rs.totalThroughput });
      if (marsCapTotal > 0) segments.push({ name: "mars ring", cap: marsCapTotal });
      let bottleneckLine = "";
      if (segments.length > 1) {
        const minCap = Math.min(...segments.map((s) => s.cap));
        const maxCap = Math.max(...segments.map((s) => s.cap));
        if (maxCap > 0 && (maxCap - minCap) / maxCap > 0.01) {
          const bottleneck = segments.reduce((a, b) => (a.cap < b.cap ? a : b));
          bottleneckLine = `Bottleneck: ${bottleneck.name}`;
        } else {
          bottleneckLine = `Balanced system`;
        }
      }

      html += `<div style="margin-top: 10px;">`;

      // --- Toggle ---
      html += `<div style="cursor: pointer; display: flex; align-items: center;">`;
      html += `<span id="capacity-arrow">▶</span> <span>Expand</span>`;
      html += `</div>`;

      // --- Header: mode + algorithm initials + laser tech improvement factor ---
      const algoInitials = {
        "topology-aware": "TA",
        "push-relabel": "PR",
        "edmonds-karp": "EK",
      }[this.simLinkBudget.flowAlgorithm] || "??";
      const modeTitle = showFlow ? `FLOW (${algoInitials})` : "CAPACITY";
      const techFactor = this.simLinkBudget.techImprovementFactor || 1;
      const headerLine = `${modeTitle} | Laser tech improvement ${techFactor}x\n`;

      // --- Compact summary (visible when collapsed) ---
      html += `<pre id="capacity-compact" style="font-family: monospace; font-size: 11px; line-height: 1.4; margin: 0; white-space: pre;">`;
      html += headerLine;
      if (showFlow) {
        html += planetLine(earth.side1, "\u25CF", earth.side2, `${fmtMbps(earthTotal)}, ${pct(earthTotal, earthCapTotal)}`, -2);
        if (rs) html += `${pipes}  ${fmtMbps(actualFlowMbps)}, ${adaptedFlowPct}\n`;
        html += planetLine(mars.side1, "\u2022", mars.side2, `${fmtMbps(marsTotal)}, ${pct(marsTotal, marsCapTotal)}`, 2);
      } else {
        html += planetLine(earth.side1, "\u25CF", earth.side2, fmtMbps(earthTotal), -2);
        if (rs) html += `${pipes}  ${fmtMbps(rs.totalThroughput)}\n`;
        html += planetLine(mars.side1, "\u2022", mars.side2, fmtMbps(marsTotal), 2);
      }
      if (actualFlowMbps > 0) html += `Flow: ${fmtMbps(actualFlowMbps)}\n`;
      if (bottleneckLine) html += `${bottleneckLine}\n`;
      html += `</pre>`;
      html += `<div id="capacity-content" style="display: none; margin-top: 4px;">`;
      html += `<pre style="font-family: monospace; font-size: 11px; line-height: 1.4; margin: 0; white-space: pre;">`;
      html += headerLine;

      // Earth section
      if (earthTotal > 0 || earthInring.length > 0) {
        if (!showFlow && earthInring.length > 0) {
          const eMin = Math.min(...earthInring), eMax = Math.max(...earthInring);
          const eAvg = earthInring.reduce((a, b) => a + b, 0) / earthInring.length;
          html += `ring Earth ${fmtRange(eMin, eAvg, eMax)}\n`;
        }
        const earthLabel = showFlow
          ? `Earth (${fmtMbps(earthTotal)}, ${pct(earthTotal, earthCapTotal)})`
          : `Earth (${fmtMbps(earthTotal)})`;
        html += planetLine(earth.side1, "\u25CF", earth.side2, earthLabel, -2);
      }

      // Adapted rings section
      if (rs) {
        const adaptedRingCount = Object.keys(ringCapacities).filter((r) => r.startsWith("ring_adapt")).length;
        if (showFlow) {
          html += `${pipes}  ${fmtMbps(actualFlowMbps)}, ${adaptedFlowPct}\n`;
          html += `${pipes}  ${adaptedRingCount} rings\n`;
          html += `${pipes}  ${activeRoutes}/${rs.routeCount} routes active\n`;
          html += `${pipes}  ${fmtRange(rs.minThroughput, rs.avgThroughput, rs.maxThroughput)}\n`;
        } else {
          html += `${pipes}  ${fmtMbps(rs.totalThroughput)}\n`;
          html += `${pipes}  ${adaptedRingCount} rings\n`;
          html += `${pipes}  ${rs.routeCount} routes\n`;
          html += `${pipes}  ${fmtRange(rs.minThroughput, rs.avgThroughput, rs.maxThroughput)}\n`;
        }
        html += `${pipes}  ${(rs.minLatency / 60).toFixed(1)}|${(rs.avgLatency / 60).toFixed(1)}|${(rs.maxLatency / 60).toFixed(1)} min\n`;
      }

      // Mars section
      if (marsTotal > 0 || marsInring.length > 0) {
        const marsLabel = showFlow
          ? `Mars (${fmtMbps(marsTotal)}, ${pct(marsTotal, marsCapTotal)})`
          : `Mars (${fmtMbps(marsTotal)})`;
        html += planetLine(mars.side1, "\u2022", mars.side2, marsLabel, 2);
        if (!showFlow && marsInring.length > 0) {
          const mMin = Math.min(...marsInring), mMax = Math.max(...marsInring);
          const mAvg = marsInring.reduce((a, b) => a + b, 0) / marsInring.length;
          html += `ring Mars ${fmtRange(mMin, mAvg, mMax)}\n`;
        }
      }

      if (actualFlowMbps > 0) html += `\nFlow: ${fmtMbps(actualFlowMbps)}\n`;
      if (bottleneckLine) html += bottleneckLine;

      html += `</pre>`;
      html += `</div>`;
      html += `</div>`;
    }
    // Show costs if available
    if (costs) {
      // Helper function to format costs in dollars to m, b, or t
      const formatCost = (value) => {
        if (value >= 1_000_000_000_000) {
          return `${(value / 1_000_000_000_000).toFixed(1)}t`; // Trillions
        } else if (value >= 1_000_000_000) {
          return `${(value / 1_000_000_000).toFixed(1)}b`; // Billions
        } else if (value >= 1_000_000) {
          return `${(value / 1_000_000).toFixed(0)}m`; // Millions
        } else if (value >= 1_000) {
          return `${(value / 1_000).toFixed(0)}k`; // Thousands
        } else {
          return `${value.toLocaleString()}`; // Dollars
        }
      };

      html += `<br>`;
      html += `<br>`;

      html += `Total cost $${formatCost(costs.totalCosts)}`;
      html += "<br>";
      html += `<div style="margin-top: 10px;">`;
      html += `<div style="cursor: pointer; display: flex; align-items: center;">`;
      html += `<span id="cost-arrow">▼</span> <span>Cost Details</span>`;
      html += `</div>`;
      html += `<div id="cost-content" style="display: block; margin-top: 10px;">`;

      html += `<span class='detail-data'>Launch $${formatCost(costs.launchCost)}<br>Sats $${formatCost(
        costs.satellitesCost
      )}<br>Lasers $${formatCost(costs.laserTerminalsCost)}<br>Propellants $${formatCost(costs.propellantCost)}</span>`;

      // Add propellant costs breakdown
      html += "<br>";
      html += "<span class='detail-data'>";
      const propellantEntries = [];
      for (const [propellantType, cost] of Object.entries(costs.propellantCostBreakdown)) {
        propellantEntries.push(`- ${propellantType} $${formatCost(cost)}`);
      }
      html += propellantEntries.join("<br>");

      html += "</span>";

      html += `</div>`;
      html += `</div>`;

      if (costs.costPerMbps) {
        html += `<br>`;
        html += `$${costs.costPerMbps.toLocaleString()} / Mbps`;
      }
    }
    return html;
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
          if (!interCap[key]) interCap[key] = { sum: 0, count: 0 };
          interCap[key].sum += cap;
          interCap[key].count += 1;
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

  /**
   * The core update loop that advances the simulation by one frame.
   *
   * Per-frame work (always runs, ~few ms):
   *   - advance simTime, recompute planet + satellite positions
   *   - update simDisplay positions (matrices in-place)
   *
   * Heavy work (delegated to the worker, runs in the background):
   *   - getPossibleLinks, getNetworkData, calculateLatencies, mission profile,
   *     mission validator, capacityInfo
   *
   * The main thread also runs `simSatellites.setSatellitesConfig` itself
   * whenever `newSatellitesConfig` is set, because the per-frame display
   * needs the resulting satellite list immediately. The worker independently
   * runs the same setSatellitesConfig in parallel — both can finish in
   * roughly the same wall-clock time without ever blocking the camera.
   */
  updateLoop() {
    const simDate = this.simTime.getDate();
    const planets = this.simSolarSystem.updatePlanetsPositions(simDate);

    // --- Phase 1: apply pending sat-config locally (for the display) ---
    let configJustApplied = false;
    if (this.newSatellitesConfig) {
      const t0 = performance.now();
      this.simSatellites.setSatellitesConfig(this.newSatellitesConfig);
      const setMs = Math.round(performance.now() - t0);
      this.satellitesCount = this.simSatellites.getSatellites().length;
      console.log(`[Marslink] Main: setSatellitesConfig=${setMs}ms (${this.satellitesCount} sats)`);
      this.appliedSatellitesConfig = this.newSatellitesConfig;
      this.newSatellitesConfig = null;
      this.pendingUpdates.add("links");
      this.pendingUpdates.add("config");
      this.pendingUpdates.add("satellites_display");
      configJustApplied = true;
    }

    // --- Phase 2: compute current satellite positions for the display ---
    const satellites = this.simSatellites.updateSatellitesPositions(simDate);

    // --- Phase 3: dispatch heavy work to the worker if needed ---
    const needsLinkRefresh =
      this.pendingUpdates.has("links") ||
      Math.abs(simDate - this.previousLinkUpdateSimDate) > 1000 * 60 * 60 * 24;

    if (needsLinkRefresh && this.appliedSatellitesConfig && this._lastUiConfig) {
      this.previousLinkUpdateSimDate = simDate;
      this.lastRequestId++;
      const computeFlow =
        this.linksColors === "Flow" &&
        (this.simLinkBudget.calctimeMs > 0 ||
          this.pendingUpdates.has("config") ||
          this.pendingUpdates.has("display"));
      this.simWorker.postMessage({
        type: "applyConfig",
        requestId: this.lastRequestId,
        uiConfig: this._lastUiConfig,
        satellitesConfig: this.appliedSatellitesConfig,
        simDate,
        computeFlow,
      });
      // Clear the flags now — the worker reply (or staleness drop) is the
      // only signal we need going forward.
      this.pendingUpdates.delete("links");
      this.pendingUpdates.delete("config");
      this.pendingUpdates.delete("display");
      this.ui.updateSimTime(simDate);
    }

    // --- Phase 4: per-frame display updates ---
    if (configJustApplied && this.simDisplay) {
      // Rebuild instanced meshes immediately for the new sat list. Links
      // remain stale until the worker reply arrives, but the satellite dots
      // are correct from this very frame.
      this.simDisplay.setSatellites(satellites);
      this.pendingUpdates.delete("satellites_display");
    }
    if (this.simDisplay) this.simDisplay.updatePositions(planets, satellites);

    if (this.pendingUpdates.has("satellites_display")) {
      this.simDisplay.setSatellites(satellites);
      this.pendingUpdates.delete("satellites_display");
    }
  }

  /**
   * Receives results from the worker and pushes them into the display + UI.
   * Stale results (older than the most recent applyConfig requestId) are
   * dropped so a fast slider drag doesn't render every intermediate state.
   */
  handleWorkerMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ready") {
      console.log("[Marslink] Worker ready");
      return;
    }

    if (msg.type === "error") {
      console.error("[Marslink] Worker error:", msg.message, msg.stack || "");
      return;
    }

    if (msg.type !== "result") return;

    // Drop stale results — only the most-recent in-flight request matters.
    if (msg.requestId < this.lastRequestId) {
      // A newer request is in flight; ignore this one.
      return;
    }
    this.latestResultRequestId = msg.requestId;

    // --- Cache the worker output ---
    this.lastNetworkData = msg.networkData || null;
    this.maxFlowGbps = msg.networkData ? msg.networkData.maxFlowGbps || 0 : 0;
    this.capacityInfo = msg.capacityInfo || null;
    this.routeSummary = msg.routeSummary || null;
    this.missionProfiles = msg.missionProfilesData || null;
    this.resultTrees = msg.resultTreesData || [];
    if (typeof msg.satellitesCount === "number") this.satellitesCount = msg.satellitesCount;

    // --- Push into the display ---
    if (this.simDisplay) {
      this.simDisplay.updatePossibleLinks(msg.possibleLinks || []);
      this.simDisplay.updateActiveLinks(msg.networkData ? msg.networkData.links || [] : []);
    }

    // --- Push into the info area / latency chart ---
    if (this.ui) {
      this.ui.updateInfoAreaCosts(
        this.getCostsHtml(this.calculateCosts(this.maxFlowGbps, this.resultTrees), this.lastNetworkData)
      );
      if (msg.networkData && msg.latencyData) {
        this.ui.updateInfoAreaData(this.getInfoAreaHTML(msg.networkData, msg.latencyData));
        this.makeLatencyChart(msg.latencyData, 60 * 5);
      } else {
        this.ui.updateInfoAreaData("");
        this.makeLatencyChart(null);
      }
    }

    // --- Logging (mirrors the old [Marslink] Phases line) ---
    const algoName = this.simLinkBudget.flowAlgorithm || "default";
    const flowGbps =
      msg.networkData && typeof msg.networkData.maxFlowGbps === "number"
        ? msg.networkData.maxFlowGbps.toFixed(1)
        : "?";
    const linksCount = msg.possibleLinks ? msg.possibleLinks.length : 0;
    console.log(
      `[Marslink] Worker reply: ${linksCount} links | Flow ${flowGbps} Gbps (${algoName}) | total=${msg.totalMs}ms`
    );
    if (msg.timings) {
      const parts = Object.entries(msg.timings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(" | ");
      console.log(`[Marslink] Worker phases: ${parts}`);
    }
  }

  startSimulationLoop() {
    const loop = () => {
      this.updateLoop();
      requestAnimationFrame(loop);
    };
    loop();
  }

  // Assuming this is within a class context
  async longTermRun(dates) {
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

          // Update the display
          this.removeLinks();
          this.simDisplay.updatePositions(planets, satellites);
          this.simDisplay.updatePossibleLinks(possibleLinks);
          this.simDisplay.updateActiveLinks(networkData.links);
          this.simDisplay.animate();

          // Calculate latency data
          const latencyData = this.simNetwork.calculateLatencies(networkData);

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

        // Schedule the next simulation step
        requestAnimationFrame(step);
      };

      // Start the simulation
      requestAnimationFrame(step);
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
        const min = Math.min(...values);
        const max = Math.max(...values);

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
   * Generates the deployment report and renders it into the in-page #report-panel.
   */
  generateReport() {
    if (!this.missionProfiles) {
      const body = document.getElementById("report-panel-body");
      if (body) {
        body.innerHTML = `<p class="empty-state">Waiting for simulation data… try again in a moment.</p>`;
      }
      console.warn("Report data not available yet.");
      return;
    }
    const costs = {
      costPerLaunchMillionUSD: this.costPerLaunch,
      costPerSatelliteMillionUSD: this.costPerSatellite,
      costPerLaserTerminalMillionUSD: this.costPerLaserTerminal,
      laserPortsPerSatellite: this.simLinkBudget.maxLinksPerSatellite,
    };
    generateReport(this.missionProfiles, this.resultTrees, costs, this.simSatellites.getSatellites());
  }
}
// Initialize the simulation once the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  const simMain = new SimMain();
});
