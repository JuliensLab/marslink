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

export class SimMain {
  constructor() {
    this.km_per_au = 149597871; // 1 AU in kilometers
    this.previousLinkUpdateSimDate = 0;
    this.newSatellitesConfig = null;
    this.requestLinksUpdate = false;

    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simLinkBudget = new SimLinkBudget();
    this.simDeployment = new SimDeployment(this.simSolarSystem.getSolarSystemData().planets);
    this.simSatellites = new SimSatellites(this.simLinkBudget);
    this.simNetwork = new SimNetwork(this.simLinkBudget);
    // Do not instantiate simDisplay here; it will be set by setDisplayType
    this.simDisplay = null;
    this.linksColors = null;

    this.previousCalctimeMs = this.simLinkBudget.calctimeMs;

    this.ui = new SimUi(this); // This will call initializeSimMain, setting simDisplay

    this.latencyChartInstance = null;
    this.missionProfiles = null; // Initialize reportData storage
    this.capacityInfo = null;

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
    this.simDisplay.setLinksColors(this.linksColors);

    this.requestLinksUpdate = true;
  }

  setLinksColors(type) {
    this.linksColors = type;
    if (this.simDisplay) this.simDisplay.setLinksColors(type);
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
    const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
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
      const satCount = Math.ceil(Math.PI / Math.asin(distanceAuBetweenSats / (2 * satDistanceSunAuBias)));

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
    const argPeriStart = uiConfig["eccentric_rings.argument-of-perihelion"];
    const earthMarsInclinationPct = uiConfig["eccentric_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
    const satellitesConfig = [];
    for (let ringId = 0; ringId < ringCount; ringId++) {
      // Determine ring type
      const ringType = "Eccentric";
      // const circumferenceAu = 2 * Math.PI * distAverageAu;
      // const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);
      const satCount = Math.ceil(Math.PI / Math.asin(distanceAuBetweenSats / (2 * distAverageAu)));
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
      if (ringCount == 0) console.error("Gradient selected but there are no circular rings to cater to");
      ringCount += 2;
      const mbpsBetweenSatsCircular = uiConfig["circular_rings.requiredmbpsbetweensats"];
      if (mbpsBetweenSatsCircular == 0) return [];
      const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
      const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
      const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSatsCircular / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
      const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
      gradientOneSideStartMbps = 9999999999;
      console.log(gradientOneSideStartMbps);
      for (let ringId = 1; ringId < ringCount - 2; ringId++) {
        let satDistanceSunAu1 = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
        let satDistanceSunAu2 = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * (ringId + 1);

        let satDistanceSunAuBias1 =
          Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);
        const satCount1 = Math.ceil(Math.PI / Math.asin(distanceAuBetweenSats / (2 * satDistanceSunAuBias1)));

        let satDistanceSunAuBias2 =
          Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * (ringId + 1) * ((100 - inringIntraringBiasPct) / 100);
        const satCount2 = Math.ceil(Math.PI / Math.asin(distanceAuBetweenSats / (2 * satDistanceSunAuBias2)));

        const distanceThisRingToNextAU = Math.abs(satDistanceSunAu1 - satDistanceSunAu2);
        const distanceThisRingToNextKm = this.simLinkBudget.convertAUtoKM(distanceThisRingToNextAU);
        const throughputThisRingToNextMbpsOneSat = this.simLinkBudget.calculateGbps(distanceThisRingToNextKm) * 1000;
        const throughputThisRingToNextMbpsAllSats = throughputThisRingToNextMbpsOneSat * Math.min(satCount1, satCount2);
        const throughputOneSideOfPlanet = throughputThisRingToNextMbpsAllSats / 2;
        // console.log(throughputOneSideOfPlanet, gradientOneSideStartMbps);
        if (throughputOneSideOfPlanet < gradientOneSideStartMbps) gradientOneSideStartMbps = Math.ceil(throughputOneSideOfPlanet);
        // console.log("chose mbps", gradientOneSideStartMbps);
      }
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
      const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
      const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
      const ringId = 1;
      let satDistanceSunAuBias =
        Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);

      satCount = Math.ceil(((Math.PI / Math.asin(distanceAuBetweenSats / (2 * satDistanceSunAuBias))) * sideExtensionDeg) / 180);
      // sideExtensionDeg = 180;
    } else {
      const { a, n } = this.simSatellites.getParams_a_n(ringType);
      const distAverageAu = a;
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
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
    // console.log(uiConfig);
    const satellitesConfig = [];

    this.simLinkBudget.setTechnologyConfig(uiConfig);
    if (this.simLinkBudget.calctimeMs !== this.previousCalctimeMs) {
      this.requestLinksUpdate = true;
      this.previousCalctimeMs = this.simLinkBudget.calctimeMs;
    }
    this.simDeployment.setSatelliteMassConfig(
      uiConfig["capability.satellite-empty-mass"],
      uiConfig["capability.laser-terminal-mass"],
      uiConfig["capability.laser-ports-per-satellite"]
    );

    satellitesConfig.push(...this.setCircularRingsConfig(uiConfig));
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
    this.costPerLaunch = costConfig["costs.launch-cost-slider"];
    this.costPerSatellite = costConfig["costs.satellite-cost-slider"];
    this.costPerLaserTerminal = costConfig["costs.laser-terminal-cost-slider"];
    if (this.ui) this.ui.updateInfoAreaCosts(this.getCostsHtml(this.calculateCosts(this.maxFlowGbps, this.resultTrees)));
  }

  calculateCosts(maxFlowGbps, resultTrees) {
    const satellitesCount = this.satellitesCount;
    if (satellitesCount) {
      // Calculate total deployment launches (Starship launches)
      let launchCount = 0;
      resultTrees.forEach((orbitTree) => {
        launchCount += orbitTree.deploymentFlights_count;
      });
      const starshipCount = launchCount;

      // Recompute propellant usage per orbit, similar to generateReport
      const orbits = {};
      resultTrees.forEach((orbitTree) => {
        orbits[orbitTree.ringName] = {
          deploymentFlights_count: orbitTree.deploymentFlights_count,
          satCountPerDeploymentFlight: orbitTree.satCountPerDeploymentFlight,
          satCount: orbitTree.satCount,
          propellant: {},
        };
        for (let data of Object.values(orbitTree.vehicles)) {
          if (!Object.keys(orbits[orbitTree.ringName].propellant).includes(data.propellantType))
            orbits[orbitTree.ringName].propellant[data.propellantType] = { selfPropulsion_kg: 0, tankerPropellant_kg: 0 };
          orbits[orbitTree.ringName].propellant[data.propellantType].selfPropulsion_kg +=
            (data.count ? data.count * data.propellantLoaded_kg : data.propellantLoaded_kg) * orbitTree.deploymentFlights_count;
          orbits[orbitTree.ringName].propellant[data.propellantType].tankerPropellant_kg +=
            (data.count ? data.count * data.tankerPropellant_kg : data.tankerPropellant_kg) * orbitTree.deploymentFlights_count;
        }
      });

      // Calculate total tanker propellant mass
      let total_tankerPropellant_kg = 0;
      for (const orbitData of Object.values(orbits)) {
        for (const propellantData of Object.values(orbitData.propellant)) {
          total_tankerPropellant_kg += propellantData.tankerPropellant_kg;
        }
      }

      // Assume each tanker launch delivers 100,000 kg of propellant (configurable in future)
      const tankerCapacity_kg = 100000; // Assumption: 100 tons per tanker launch
      const tankerCount = Math.ceil(total_tankerPropellant_kg / tankerCapacity_kg);

      // Total liftoffs include both Starship (deployment) and tanker launches
      const liftoffCount = starshipCount + tankerCount;

      // Calculate total propellant mass by type (self + tanker) and their costs
      const allPropellantTypes = [];
      for (const orbitData of Object.values(orbits)) {
        for (const propellantType of Object.keys(orbitData.propellant)) {
          if (!allPropellantTypes.includes(propellantType)) allPropellantTypes.push(propellantType);
        }
      }

      const totalPropellant_kg = {};
      for (const propellantType of allPropellantTypes) {
        totalPropellant_kg[propellantType] = 0;
        for (const orbitData of Object.values(orbits)) {
          if (orbitData.propellant[propellantType]) {
            totalPropellant_kg[propellantType] +=
              orbitData.propellant[propellantType].selfPropulsion_kg + orbitData.propellant[propellantType].tankerPropellant_kg;
          }
        }
      }

      // Define propellant costs per kg (assumed values; should be properties of the class)
      const propellantCosts = this.propellantCosts || {
        "CH4/O2": 0.3, // $0.3 per kg
        Argon: 0.5, // $0.5 per kg
      };

      // Calculate total propellant cost and breakdown
      let propellantCost = 0;
      const propellantCostBreakdown = {};
      for (const [propellantType, kg] of Object.entries(totalPropellant_kg)) {
        const costPerKg = propellantCosts[propellantType] || 0;
        const cost = kg * costPerKg; // Cost in dollars
        propellantCostBreakdown[propellantType] = cost;
        propellantCost += cost;
        console.log(propellantType, kg, costPerKg, cost);
      }

      // Calculate costs (all in dollars)
      const launchCost = liftoffCount * this.costPerLaunch * 1000000;
      const satellitesCost = satellitesCount * this.costPerSatellite * 1000000;
      const laserPortsPerSatellite = this.simLinkBudget.maxLinksPerSatellite;
      const laserTerminalsCost = satellitesCount * laserPortsPerSatellite * this.costPerLaserTerminal * 1000000;
      console.log(
        liftoffCount,
        this.costPerLaunch,
        satellitesCount,
        this.costPerSatellite,
        laserPortsPerSatellite,
        this.costPerLaserTerminal
      );
      const totalCosts = launchCost + propellantCost + satellitesCost + laserTerminalsCost;
      console.log(totalCosts, launchCost, propellantCost, satellitesCost, laserTerminalsCost);

      // Calculate cost per Mbps if maxFlowGbps is provided
      let costPerMbps = Infinity;
      if (maxFlowGbps) costPerMbps = Math.round(totalCosts / (maxFlowGbps * 1000));

      return {
        satellitesCount,
        launchCount: starshipCount,
        tankerCount,
        liftoffCount,
        launchCost,
        propellantCost,
        satellitesCost,
        laserTerminalsCost,
        totalCosts,
        costPerMbps,
        propellantCostBreakdown,
      };
    }
  }

  getCostsHtml(costs, networkData) {
    let html = "";
    // Always show satellite count
    html += `${this.satellitesCount} satellites`;
    // Show capacity if available
    if (this.capacityInfo) {
      const { ringCapacities, interCap } = this.capacityInfo;
      // Circular rings
      const circularRings = Object.keys(ringCapacities)
        .filter((r) => r.startsWith("ring_circ_"))
        .sort((a, b) => {
          const numA = parseInt(a.split("_")[2]);
          const numB = parseInt(b.split("_")[2]);
          return numA - numB;
        });
      html += `<div style="margin-top: 10px;">`;
      html += `<div style="cursor: pointer; display: flex; align-items: center;">`;
      html += `<span id="capacity-arrow">▼</span> <span>Capacity Details</span>`;
      html += `</div>`;
      html += `<div id="capacity-content" style="display: block; margin-top: 10px;">`;
      // Between Earth and Mars
      const earthFlows = ringCapacities["ring_earth"] ? ringCapacities["ring_earth"].flows : 0;
      const earthFlowsCount = ringCapacities["ring_earth"] ? ringCapacities["ring_earth"].flowsCount : 0;
      const marsFlows = ringCapacities["ring_mars"] ? ringCapacities["ring_mars"].flows : 0;
      const marsFlowsCount = ringCapacities["ring_mars"] ? ringCapacities["ring_mars"].flowsCount : 0;
      // Earth planet: sum of inter-ring link capacities for Earth
      let earthPlanetSum = 0;
      let earthPlanetLinks = ringCapacities["ring_earth"] ? ringCapacities["ring_earth"].planetLinks : [];
      earthPlanetLinks.forEach((link) => (earthPlanetSum += link.cap));
      if (earthPlanetSum > 0) {
        html += `Earth<br>`;
        html += `<span class='detail-data'>| ${Math.round(earthPlanetSum)} mbps (${earthPlanetLinks.length} links)</span><br>`;
      }
      // Earth inring
      const earthInring = ringCapacities["ring_earth"] ? ringCapacities["ring_earth"].inring : [];
      if (earthInring.length > 0) {
        const min = Math.min(...earthInring);
        const max = Math.max(...earthInring);
        const avg = earthInring.reduce((a, b) => a + b, 0) / earthInring.length;

        if (Math.abs(min - avg) < 1 && Math.abs(min - max) && Math.abs(max - avg)) html += `Earth ring: ${Math.round(avg)} mbps<br>`;
        else html += `Earth ring: ${Math.round(min)} / ${Math.round(avg)} / ${Math.round(max)} mbps<br>`;
      }
      if (earthFlows > 0) {
        html += `Between Earth and Mars: ${Math.round(earthFlows)} mbps (${earthFlowsCount} links @${
          Math.round((earthFlows / earthFlowsCount) * 10) / 10
        } mbps)<br>`;
      }
      // Between Earth and Circular
      Object.keys(interCap)
        .filter((key) => key.includes("ring_earth") && key.includes("ring_circ_"))
        .forEach((key) => {
          const parts = key.split("-");
          const circPart = parts.find((p) => p.startsWith("ring_circ_"));
          const circNum = parseInt(circPart.split("_")[2]);
          const between = interCap[key];
          html += `<span class='detail-data'>| ${Math.round(between.sum)} mbps (${between.count} links @${
            Math.round((between.sum / between.count) * 10) / 10
          } mbps)</span><br>`;
        });
      // Circular rings
      circularRings.forEach((ring, index) => {
        const ringNum = parseInt(ring.split("_")[2]);
        const inring = ringCapacities[ring].inring;
        if (inring.length > 0) {
          const min = Math.min(...inring);
          const max = Math.max(...inring);
          const avg = inring.reduce((a, b) => a + b, 0) / inring.length;
          if (Math.abs(min - avg) < 1 && Math.abs(min - max) && Math.abs(max - avg))
            html += `Circ ring ${ringNum}: ${Math.round(avg)} mbps<br>`;
          else html += `Circ ring ${ringNum}: ${Math.round(min)} / ${Math.round(avg)} / ${Math.round(max)} mbps<br>`;
        } else {
          html += `Circ ring ${ringNum}: 0 mbps<br>`;
        }
        if (index < circularRings.length - 1) {
          const nextRing = circularRings[index + 1];
          const nextNum = parseInt(nextRing.split("_")[2]);
          const betweenKey = [ring, nextRing].sort().join("-");
          const between = interCap[betweenKey] || { sum: 0, count: 0 };
          html += `<span class='detail-data'>| ${Math.round(between.sum)} mbps (${between.count} links @${
            Math.round((between.sum / between.count) * 10) / 10
          } mbps)</span><br>`;
        }
      });
      // Between Mars and Circular
      Object.keys(interCap)
        .filter((key) => key.includes("ring_mars") && key.includes("ring_circ_"))
        .forEach((key) => {
          const parts = key.split("-");
          const circPart = parts.find((p) => p.startsWith("ring_circ_"));
          const circNum = parseInt(circPart.split("_")[2]);
          const between = interCap[key];
          html += `<span class='detail-data'>| (CR${circNum}) ${Math.round(between.sum)}mbps (${between.count} links @${
            Math.round((between.sum / between.count) * 10) / 10
          } mbps)</span><br>`;
        });
      // Mars inring
      const marsInring = ringCapacities["ring_mars"] ? ringCapacities["ring_mars"].inring : [];
      if (marsInring.length > 0) {
        const min = Math.min(...marsInring);
        const max = Math.max(...marsInring);
        const avg = marsInring.reduce((a, b) => a + b, 0) / marsInring.length;

        if (Math.abs(min - avg) < 1 && Math.abs(min - max) && Math.abs(max - avg)) html += `Mars ring: ${Math.round(avg)} mbps<br>`;
        else html += `Mars ring: ${Math.round(min)} / ${Math.round(avg)} / ${Math.round(max)} mbps<br>`;
      }
      // Mars planet: sum of inter-ring link capacities for Mars
      let marsPlanetSum = 0;
      let marsPlanetLinks = ringCapacities["ring_mars"] ? ringCapacities["ring_mars"].planetLinks : [];
      marsPlanetLinks.forEach((link) => (marsPlanetSum += link.cap));
      if (marsPlanetSum > 0) {
        html += `<span class='detail-data'>| ${Math.round(marsPlanetSum)} mbps (${marsPlanetLinks.length} links)</span><br>`;
        html += `Mars`;
      }
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
        ringCapacities[fromRing].inring.push(cap);
        // Add to planetLinks if planet is involved in intra-ring
        if (link.fromId === "Earth" || link.toId === "Earth") {
          const satId = link.fromId === "Earth" ? link.toId : link.fromId;
          ringCapacities["ring_earth"].planetLinks.push({ cap, satId });
        }
        if (link.fromId === "Mars" || link.toId === "Mars") {
          const satId = link.fromId === "Mars" ? link.toId : link.fromId;
          ringCapacities["ring_mars"].planetLinks.push({ cap, satId });
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
    // Console log planet links
    if (ringCapacities["ring_earth"] && ringCapacities["ring_earth"].planetLinks.length > 0) {
      console.log("Earth");
      ringCapacities["ring_earth"].planetLinks.forEach((link) => {
        console.log(`to ${link.satId}: ${Math.round(link.cap)}mbps`);
      });
    }
    if (ringCapacities["ring_mars"] && ringCapacities["ring_mars"].planetLinks.length > 0) {
      console.log("Mars");
      ringCapacities["ring_mars"].planetLinks.forEach((link) => {
        console.log(`to ${link.satId}: ${Math.round(link.cap)}mbps`);
      });
    }
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
   * It updates the positions of planets, satellites, and the display.
   * The links are updated asynchronously when the worker sends data.
   */
  updateLoop() {
    const simDate = this.simTime.getDate();
    const planets = this.simSolarSystem.updatePlanetsPositions(simDate);

    let satellites;
    if (this.newSatellitesConfig) {
      this.simSatellites.setSatellitesConfig(this.newSatellitesConfig);
      this.simSatellites.setOrbitalElements(this.newSatellitesConfig);
      this.missionProfiles = this.simDeployment.getMissionProfile(this.simSatellites.orbitalElements);
      this.resultTrees = new SimMissionValidator(this.missionProfiles);
      // if (!new SimMissionValidator(this.missionProfiles)) throw new Error("Mission validation failed");
      satellites = this.simSatellites.updateSatellitesPositions(simDate);
      this.satellitesCount = satellites.length;
      console.log("Total satellites on main page:", this.satellitesCount);
      const possibleLinks = this.simNetwork.getPossibleLinks(planets, satellites);
      this.capacityInfo = this.calculateCapacityInfo(possibleLinks);
      this.requestLinksUpdate = true;
      this.newSatellitesConfig = null;
    } else {
      satellites = this.simSatellites.updateSatellitesPositions(simDate);
    }

    if (this.requestLinksUpdate || Math.abs(simDate - this.previousLinkUpdateSimDate) > 1000 * 60 * 60 * 24) {
      this.previousLinkUpdateSimDate = simDate;

      let perf = performance.now();
      const possibleLinks = this.simNetwork.getPossibleLinks(planets, satellites);
      console.log(`Possible links: ${Math.round(performance.now() - perf)} ms`);

      this.removeLinks();
      this.simDisplay.updatePossibleLinks(possibleLinks);
      this.simDisplay.setSatellites(satellites);
      this.simDisplay.updatePositions(planets, satellites);
      this.ui.updateSimTime(simDate);

      if (this.simLinkBudget.calctimeMs > 0) {
        let perf = performance.now();
        const networkData = this.simNetwork.getNetworkData(planets, satellites, possibleLinks, this.simLinkBudget.calctimeMs);
        console.log(`Flow: ${Math.round(performance.now() - perf)} ms`);
        this.maxFlowGbps = networkData.maxFlowGbps;
        this.simDisplay.updateActiveLinks(networkData.links);

        if (this.ui) {
          const binSize = 60 * 5;
          const latencyData = this.simNetwork.calculateLatencies(networkData, binSize);

          this.ui.updateInfoAreaCosts(this.getCostsHtml(this.calculateCosts(networkData.maxFlowGbps, this.resultTrees)));
          this.ui.updateInfoAreaData(this.getInfoAreaHTML(networkData, latencyData));
          this.makeLatencyChart(latencyData, binSize);
        }
      } else {
        this.ui.updateInfoAreaCosts(this.getCostsHtml(null, null));
        this.ui.updateInfoAreaData("");
        this.makeLatencyChart(null);
      }
      this.requestLinksUpdate = false;
    } else {
      this.simDisplay.updatePositions(planets, satellites);
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
        console.log(simDate.toUTCString());

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
   * Generates an HTML report from the stored reportData and opens it in a new tab.
   */
  generateReport() {
    if (!this.missionProfiles) {
      console.error("Report data not available. Run the simulation first.");
      return;
    }
    const costs = {
      costPerLaunchMillionUSD: this.costPerLaunch,
      costPerSatelliteMillionUSD: this.costPerSatellite,
      costPerLaserTerminalMillionUSD: this.costPerLaserTerminal,
      laserPortsPerSatellite: this.simLinkBudget.maxLinksPerSatellite,
    };
    generateReport(this.missionProfiles, this.resultTrees, costs, this.simSatellites.satellites);
  }
}
// Initialize the simulation once the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  const simMain = new SimMain();
});
