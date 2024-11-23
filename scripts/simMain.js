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
    // Initialize simulation components
    this.simTime = new SimTime();
    this.simSolarSystem = new SimSolarSystem();
    this.simSatellites = new SimSatellites();
    this.simLinks = new SimLinks();
    this.simNetwork = new SimNetwork();
    this.simDisplay = new SimDisplay();

    // Initialize UI, passing the SimMain instance for callbacks
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
    let satellites = this.simSatellites.setSatellitesConfig(satellitesConfig);
    satellites = this.simSatellites.updateSatellitesPositions(simDate);
    this.simDisplay.setSatellites(satellites);
  }

  /**
   * The core update loop that advances the simulation by one frame.
   * It updates the positions of planets, satellites, links, and the display.
   */
  updateLoop() {
    const simDate = this.simTime.getDate();
    // console.log("simDate", simDate);

    // Update simulation data
    const planets = this.simSolarSystem.updatePlanetsPositions(simDate);
    const satellites = this.simSatellites.updateSatellitesPositions(simDate);
    // const links = this.simLinks.getLinksData(planets, satellites);
    const links = this.simNetwork.getNetworkData(planets, satellites);

    // Update the display with new data
    this.simDisplay.updateData(planets, satellites, links);
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
