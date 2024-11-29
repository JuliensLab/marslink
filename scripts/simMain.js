// simMain.js

import { SimUi } from "./simUi.js";
import { SimTime } from "./simTime.js";
import { SimSolarSystem } from "./simSolarSystem.js";
import { SimSatellites } from "./simSatellites.js";
import { SimLinkBudget } from "./simLinkBudget.js";
import { SimNetwork } from "./simNetwork.js";
import { SimDisplay } from "./simDisplay.js";

export class SimMain {
  constructor() {
    this.km_per_au = 149597871; // 1 AU in kilometers

    this.previousLinkUpdateSimDate = 0;
    this.newSatellitesConfig = null;
    this.requestLinksUpdate = false;

    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simSatellites = new SimSatellites();
    this.simLinkBudget = new SimLinkBudget();
    this.simNetwork = new SimNetwork(this.simLinkBudget);
    this.simDisplay = new SimDisplay();

    this.ui = new SimUi(this);

    // Initialize the chart instance as null
    this.latencyChartInstance = null;

    // Start the simulation loop
    this.startSimulationLoop();
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
    const ringCount = uiConfig["circular_rings.ringcount"];
    if (ringCount == 0) return [];
    const mbpsBetweenSats = uiConfig["circular_rings.requiredmbpsbetweensats"];
    const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
    const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
    const earthMarsInclinationPct = uiConfig["circular_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
    const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
    const satellitesConfig = [];
    for (let ringId = 0; ringId < ringCount; ringId++) {
      // Determine ring type
      const ringType = "Circular";
      let satDistanceSunAu = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
      if (ringCount == 1) satDistanceSunAu = (distInnerAu + distOuterAu) / 2;
      const circumferenceAu = 2 * Math.PI * satDistanceSunAu;
      const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);

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
    if (ringCount == 0) return [];
    const mbpsBetweenSats = uiConfig["eccentric_rings.requiredmbpsbetweensats"];
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
      const circumferenceAu = 2 * Math.PI * distAverageAu;
      const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);
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
    const satCount = uiConfig[ringName + ".satellite-count-slider"];
    const satDistanceSun = uiConfig[ringName + ".distance-sun-slider"];
    const sideExtensionDeg = uiConfig[ringName + ".side-extension-degrees-slider"];

    // Determine ring type
    let ringType = ringName == "ring_mars" ? "Mars" : "Earth";

    // Push the satellite configuration for this ring
    satellitesConfig.push({
      satCount: satCount,
      satDistanceSun: satDistanceSun,
      ringName: ringName,
      ringType: ringType,
      sideExtensionDeg: sideExtensionDeg,
      eccentricity: 0,
      raan: 0,
      argPeri: 0,
      earthMarsInclinationPct: 0,
    });

    return satellitesConfig;
  }

  setSatellitesConfig(uiConfig) {
    const satellitesConfig = [];

    this.simLinkBudget.setTechnologyConfig(uiConfig);
    satellitesConfig.push(...this.setCircularRingsConfig(uiConfig));
    satellitesConfig.push(...this.setEccentricRingsConfig(uiConfig));
    satellitesConfig.push(...this.generateSatellitesConfig(uiConfig, "ring_mars"));
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
              label: "Aggregate GBps per Latency Bin",
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
              title: { display: true, text: "Aggregate GBps" },
              beginAtZero: true,
            },
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: function (context) {
                  return `${context.parsed.y} GBps`;
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
  }

  setCosts(costConfig) {
    this.costPerLaunch = costConfig["costs.launch-cost-slider"];
    this.costPerSatellite = costConfig["costs.satellite-cost-slider"];
    this.satsPerLaunch = costConfig["costs.sats-per-launch-slider"];
    this.updateCosts();
  }

  updateCosts() {
    let html = "";
    const satellites = this.satellites;

    // Helper function to format numbers into m, b, or t based on the determined scale
    const formatCost = (value, scale) => {
      if (scale === "t") {
        return `${(value / 1_000_000).toFixed(1)}t`; // Trillions
      } else if (scale === "b") {
        return `${(value / 1_000).toFixed(1)}b`; // Billions
      } else {
        return `${value}m`; // Millions
      }
    };

    if (satellites) {
      const launchCount = Math.ceil(satellites.length / this.satsPerLaunch);

      html += `${satellites.length} satellites ${launchCount} launches`;

      html += `<br>`;
      html += `<br>`;

      const launchCost = Math.round((launchCount * this.costPerLaunch) / 10) * 10;
      const satellitesCost = Math.round((satellites.length * this.costPerSatellite) / 10) * 10;
      const totalCosts = launchCost + satellitesCost;

      // Determine the scale (m, b, t) based on the highest value
      let scale = "m";
      if (totalCosts >= 1_000_000 || launchCost >= 1_000_000 || satellitesCost >= 1_000_000) {
        scale = "t"; // Trillions
      } else if (totalCosts >= 1_000 || launchCost >= 1_000 || satellitesCost >= 1_000) {
        scale = "b"; // Billions
      }

      html += `Total cost $${formatCost(totalCosts, scale)}`;
      html += "<br>";
      html += `&nbsp;&nbsp;Launch $${formatCost(launchCost, scale)} + Sats $${formatCost(satellitesCost, scale)}`;
      if (this.networkData && this.networkData.maxFlowGbps > 0) {
        const costPerMbps = Math.round(totalCosts / (this.networkData.maxFlowGbps * 1000));
        html += `<br>`;
        html += `&nbsp;$${formatCost(costPerMbps, scale)} / Mbps`;
      }
    }

    document.getElementById("info-area-costs").innerHTML = html;
  }

  /**
   * Prepares the HTML for the info area, including the latency chart.
   *
   * @param {Object} networkData - The network data containing flows and graph information.
   * @param {Array} satellites - Array of satellite objects.
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
   * Updates the links and the latency chart.
   *
   * @param {Array} planets - Array of planet objects.
   * @param {Array} satellites - Array of satellite objects.
   */
  updateLinks() {
    const possibleLinks = this.simNetwork.getPossibleLinks(this.planets, this.satellites, this.simLinkBudget);
    this.simDisplay.updatePossibleLinks(possibleLinks);

    // Get active links from simNetwork, passing possibleLinks to avoid recomputation
    if (true) {
      this.networkData = this.simNetwork.getNetworkData(this.planets, this.satellites, possibleLinks);

      // Update simDisplay with active links
      this.simDisplay.updateActiveLinks(this.networkData.links);

      if (this.ui) {
        this.binSize = 60 * 5; // Bin size in seconds (1 minute)
        this.latencyData = this.simNetwork.calculateLatencies(this.networkData, this.binSize);

        this.updateCosts();
        // Pass latencyData to getInfoAreaHTML and makeLatencyChart
        this.ui.updateInfoArea(this.getInfoAreaHTML(this.networkData, this.satellites, this.latencyData));
        // After updating the info area, create or update the latency chart
        this.makeLatencyChart(this.latencyData, this.binSize);
      }
    }
  }

  /**
   * The core update loop that advances the simulation by one frame.
   * It updates the positions of planets, satellites, and the display.
   * The links are updated asynchronously when the worker sends data.
   */
  updateLoop() {
    const simDate = this.simTime.getDate();
    this.planets = this.simSolarSystem.updatePlanetsPositions(simDate);

    if (this.newSatellitesConfig) {
      this.simSatellites.setSatellitesConfig(this.newSatellitesConfig);
      this.satellites = this.simSatellites.updateSatellitesPositions(simDate);
      // console.log(satellites);
      this.removeLinks();
      this.requestLinksUpdate = true;
      this.simDisplay.setSatellites(this.satellites);
      this.newSatellitesConfig = null;
    } else this.satellites = this.simSatellites.updateSatellitesPositions(simDate);

    this.simDisplay.updatePositions(this.planets, this.satellites);
    this.ui.updateSimTime(simDate);

    if (this.requestLinksUpdate || Math.abs(simDate - this.previousLinkUpdateSimDate) > 1000 * 60 * 60 * 24) {
      this.previousLinkUpdateSimDate = simDate;
      this.removeLinks();
      this.updateLinks();
      this.requestLinksUpdate = false;
    }
  }

  /**
   * Starts the main simulation loop using requestAnimationFrame for optimal performance.
   */
  startSimulationLoop() {
    const loop = () => {
      this.updateLoop();
      requestAnimationFrame(loop);
    };
    loop();
  }
}

// Initialize the simulation once the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  const simMain = new SimMain();
});
