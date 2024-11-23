// simMain.js

import { SimUi } from "./simUi.js";
import { SimTime } from "./simTime.js";
import { SimSolarSystem } from "./simSolarSystem.js";
import { SimSatellites } from "./simSatellites.js";
import { SimLinks } from "./simLinks.js";
import { SimNetwork } from "./simNetwork.js";
import { SimDisplay } from "./simDisplay.js";

export class SimMain {
  constructor() {
    this.maxDistanceAU = 0.3;
    this.maxLinksPerSatellite = 2;

    this.previousLinkUpdateSimDate = 0;

    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simSatellites = new SimSatellites();
    this.simLinks = new SimLinks();
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

  /**
   * Configures the satellites based on provided configuration and initializes their rendering.
   *
   * @param {Object} satellitesConfig - Configuration object for satellites.
   */
  setSatellitesConfig(satellitesConfig) {
    const simDate = this.simTime.getDate();
    this.simSatellites.setSatellitesConfig(satellitesConfig);
    const satellites = this.simSatellites.updateSatellitesPositions(simDate);
    this.simDisplay.updateActiveLinks([]);
    this.simDisplay.updatePossibleLinks([]);
    this.simDisplay.setSatellites(satellites);
    this.updateLinks(simDate, satellites);
  }

  updateLinks(simDate, satellites) {
    const planets = this.simSolarSystem.updatePlanetsPositions(simDate);
    const possibleLinks = this.simLinks.getPossibleLinks(planets, satellites, this.maxDistanceAU);
    this.simDisplay.updatePossibleLinks(possibleLinks);

    // Get active links from simNetwork, passing possibleLinks to avoid recomputation
    const { links: activeLinks, maxFlow: maxFlow } = this.simNetwork.getNetworkData(
      planets,
      satellites,
      this.maxDistanceAU,
      this.maxLinksPerSatellite
    );
    // Update simDisplay with active links
    this.simDisplay.updateActiveLinks(activeLinks);
    if (this.ui) this.ui.updateInfoArea(`Marslink: ${Math.round(maxFlow * 1000)} Mbps`);
  }

  /**
   * The core update loop that advances the simulation by one frame.
   * It updates the positions of planets, satellites, and the display.
   * The links are updated asynchronously when the worker sends data.
   */
  updateLoop() {
    const simDate = this.simTime.getDate();

    // Update simulation data
    const planets = this.simSolarSystem.updatePlanetsPositions(simDate);
    const satellites = this.simSatellites.updateSatellitesPositions(simDate);

    // Update the display with new data
    this.simDisplay.updatePositions(planets, satellites);
    this.ui.updateSimTime(simDate);
    if (Math.abs(simDate - this.previousLinkUpdateSimDate) > 1000 * 60 * 60 * 24) {
      this.previousLinkUpdateSimDate = simDate;
      this.updateLinks(simDate, satellites);
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
