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
    this.maxDistanceAU = 0.2;
    this.maxLinksPerSatellite = 8;

    this.previousLinkUpdateSimDate = 0;
    this.newSatellitesConfig = null;
    this.requestLinksUpdate = false;

    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simSatellites = new SimSatellites();
    this.simLinkBudget = new SimLinkBudget();
    this.simNetwork = new SimNetwork();
    this.simDisplay = new SimDisplay();

    this.ui = new SimUi(this);

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

  setAutoringConfig(uiConfig) {
    const ringCount = uiConfig["circular_rings.ringcount"];
    const mbpsBetweenSats = uiConfig["circular_rings.requiredmbpsbetweensats"];
    const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
    const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / this.km_per_au;
    const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / ringCount;
    const satellitesConfig = [];
    for (let ringId = 0; ringId < ringCount; ringId++) {
      // Determine ring type
      const ringType = "Circular";
      const satDistanceSunAu = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
      const circumferenceAu = 2 * Math.PI * satDistanceSunAu;
      const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);

      // Push the satellite configuration for this ring
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: satDistanceSunAu,
        ringName: "ring" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
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
    });

    return satellitesConfig;
  }

  setSatellitesConfig(uiConfig) {
    const satellitesConfig = [];
    console.log(uiConfig);

    this.simLinkBudget.setTechnologyConfig(uiConfig);
    satellitesConfig.push(...this.setAutoringConfig(uiConfig));
    satellitesConfig.push(...this.generateSatellitesConfig(uiConfig, "ring_mars"));
    satellitesConfig.push(...this.generateSatellitesConfig(uiConfig, "ring_earth"));

    this.newSatellitesConfig = satellitesConfig;
    console.log(satellitesConfig);
  }

  removeLinks() {
    this.simDisplay.updateActiveLinks([]);
    this.simDisplay.updatePossibleLinks([]);
  }

  updateLinks(planets, satellites) {
    const possibleLinks = this.simNetwork.getPossibleLinks(
      planets,
      satellites,
      this.simLinkBudget,
      this.maxDistanceAU,
      this.maxLinksPerSatellite
    );
    this.simDisplay.updatePossibleLinks(possibleLinks);

    // Get active links from simNetwork, passing possibleLinks to avoid recomputation
    if (false) {
      const { links: activeLinks, maxFlow: maxFlow } = this.simNetwork.getNetworkData(
        planets,
        satellites,
        this.simLinkBudget,
        this.maxDistanceAU,
        this.maxLinksPerSatellite
      );
      // Update simDisplay with active links
      this.simDisplay.updateActiveLinks(activeLinks);
      if (this.ui) this.ui.updateInfoArea(`Marslink: ${Math.round(maxFlow * 1000)} Mbps`);
    }
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
      satellites = this.simSatellites.updateSatellitesPositions(simDate);
      console.log(satellites);
      this.removeLinks();
      this.requestLinksUpdate = true;
      this.simDisplay.setSatellites(satellites);
      this.newSatellitesConfig = null;
    } else satellites = this.simSatellites.updateSatellitesPositions(simDate);

    this.simDisplay.updatePositions(planets, satellites);
    this.ui.updateSimTime(simDate);

    if (this.requestLinksUpdate || Math.abs(simDate - this.previousLinkUpdateSimDate) > 1000 * 60 * 60 * 24) {
      this.previousLinkUpdateSimDate = simDate;
      this.removeLinks();
      this.updateLinks(planets, satellites);
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
