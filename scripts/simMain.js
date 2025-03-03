// simMain.js

import { SimUi } from "./simUi.js?v=2.4";
import { SimTime } from "./simTime.js?v=2.4";
import { SimSolarSystem } from "./simSolarSystem.js?v=2.4";
import { SimSatellites } from "./simSatellites.js?v=2.4";
import { SimDeployment } from "./simDeployment.js?v=2.4";
import { SimLinkBudget } from "./simLinkBudget.js?v=2.4";
import { SimNetwork } from "./simNetwork.js?v=2.4";
// Import both SimDisplay implementations with unique names
import { SimDisplay as SimDisplay2D } from "./simDisplay-2d.js?v=2.4";
import { SimDisplay as SimDisplay3D } from "./simDisplay-3d.js?v=2.4";
import { generateReport } from "./reportGenerator.js?v=2.4";

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
    this.simDeployment = new SimDeployment();
    this.simLinkBudget = new SimLinkBudget();
    this.simNetwork = new SimNetwork(this.simLinkBudget);
    // Do not instantiate simDisplay here; it will be set by setDisplayType
    this.simDisplay = null;

    this.ui = new SimUi(this); // This will call initializeSimMain, setting simDisplay

    this.latencyChartInstance = null;
    this.reportData = null; // Initialize reportData storage

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

    this.requestLinksUpdate = true;
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
    const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
    const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
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
    const mbpsBetweenSats = uiConfig[ringName + ".requiredmbpsbetweensats"];
    const sideExtensionDeg = uiConfig[ringName + ".side-extension-degrees-slider"];

    // Determine ring type
    let ringType = ringName == "ring_mars" ? "Mars" : "Earth";
    const { a, n } = this.simSatellites.getParams_a_n(ringType);
    const distAverageAu = a;

    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
    const circumferenceAu = 2 * Math.PI * distAverageAu;
    const actualCircumferenceAu = (circumferenceAu * sideExtensionDeg * 2) / 360;
    const satCount = Math.ceil(actualCircumferenceAu / distanceAuBetweenSats);

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
    this.satsPerLaunch = costConfig["costs.sats-per-launch-slider"];
    if (this.ui) this.ui.updateInfoAreaCosts(this.getCostsHtml(this.calculateCosts(this.maxFlowGbps)));
  }

  calculateCosts(maxFlowGbps) {
    const satellitesCount = this.satellitesCount;
    if (satellitesCount) {
      const launchCount = Math.ceil(satellitesCount / this.satsPerLaunch);
      const launchCost = Math.round((launchCount * this.costPerLaunch) / 10) * 10;
      const satellitesCost = Math.round((satellitesCount * this.costPerSatellite) / 10) * 10;
      const totalCosts = launchCost + satellitesCost;
      let costPerMbps = Infinity;
      if (maxFlowGbps) costPerMbps = Math.round(totalCosts / (maxFlowGbps * 1000));
      return { satellitesCount, launchCount, launchCost, satellitesCost, totalCosts, costPerMbps };
    }
  }

  getCostsHtml(costs) {
    let html = "";
    html += `${this.satellitesCount} satellites`;

    if (costs) {
      html = "";
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

      html += `${costs.satellitesCount} satellites ${costs.launchCount} launches`;

      html += `<br>`;
      html += `<br>`;

      // Determine the scale (m, b, t) based on the highest value
      let scale = "m";
      if (costs.totalCosts >= 1_000_000 || costs.launchCost >= 1_000_000 || costs.satellitesCost >= 1_000_000) {
        scale = "t"; // Trillions
      } else if (costs.totalCosts >= 1_000 || costs.launchCost >= 1_000 || costs.satellitesCost >= 1_000) {
        scale = "b"; // Billions
      }

      html += `Total cost $${formatCost(costs.totalCosts, scale)}`;
      html += "<br>";
      html += `&nbsp;&nbsp;Launch $${formatCost(costs.launchCost, scale)} + Sats $${formatCost(costs.satellitesCost, scale)}`;
      if (costs.costPerMbps) {
        html += `<br>`;
        html += `&nbsp;$${formatCost(costs.costPerMbps, "m")} / Mbps`;
      }
    }
    return html;
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
      this.reportData = this.simDeployment.setOrbitalElements(
        this.simSatellites.orbitalElements,
        this.simSolarSystem.getSolarSystemData().planets
      );
      satellites = this.simSatellites.updateSatellitesPositions(simDate);
      this.satellitesCount = satellites.length;
      this.requestLinksUpdate = true;
      this.newSatellitesConfig = null;
    } else {
      satellites = this.simSatellites.updateSatellitesPositions(simDate);
    }

    if (this.requestLinksUpdate || Math.abs(simDate - this.previousLinkUpdateSimDate) > 1000 * 60 * 60 * 24) {
      this.previousLinkUpdateSimDate = simDate;

      let perf = performance.now();
      const possibleLinks = this.simNetwork.getPossibleLinks(planets, satellites, this.simLinkBudget);
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

          this.ui.updateInfoAreaCosts(this.getCostsHtml(this.calculateCosts(networkData.maxFlowGbps)));
          this.ui.updateInfoAreaData(this.getInfoAreaHTML(networkData, latencyData));
          this.makeLatencyChart(latencyData, binSize);
        }
      } else {
        this.ui.updateInfoAreaCosts(this.getCostsHtml(null));
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
            const finalCosts = this.calculateCosts(networkData.maxFlowGbps);
            delete finalCosts.costPerMbps; // Remove 'costPerMbps' as per refactoring

            // Summarize the collected data
            const dataSummary = this.summarizeLongTermData(data);
            this.updateLoop();

            // Resolve the promise with the result
            resolve({ dates, calctimeMs, costs: finalCosts, dataSummary });
          } else {
            // Handle the case where networkData is undefined
            console.error("No networkData was generated during the simulation.");
            const dataSummary = this.summarizeLongTermData(data);
            this.updateLoop();
            resolve({ dates, calctimeMs, costs: {}, dataSummary });
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
          const possibleLinks = this.simNetwork.getPossibleLinks(planets, satellites, this.simLinkBudget);

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

          // Calculate costs based on network data
          const costs = this.calculateCosts(networkData.maxFlowGbps);

          // Extract relevant metrics
          const maxFlowGbps = networkData.error ? null : networkData.maxFlowGbps;
          const bestLatencyMinutes = latencyData.bestLatency !== null ? rnd(latencyData.bestLatency / 60, 1) : null;
          const avgLatencyMinutes = latencyData.averageLatency !== null ? rnd(latencyData.averageLatency / 60, 1) : null;
          const possibleLinksCount = possibleLinks.length;

          // Push the collected data into the 'data' array
          data.push({
            simDate: simDate.toISOString(), // Format date to ISO string
            possibleLinksCount,
            maxFlowGbps,
            bestLatencyMinutes,
            avgLatencyMinutes,
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
    const fields = ["possibleLinksCount", "maxFlowGbps", "bestLatencyMinutes", "avgLatencyMinutes", "costPerMbps"];

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
    if (!this.reportData) {
      console.error("Report data not available. Run the simulation first.");
      return;
    }
    generateReport(this.reportData);
  }
}
// Initialize the simulation once the DOM is fully loaded
document.addEventListener("DOMContentLoaded", () => {
  const simMain = new SimMain();
});
