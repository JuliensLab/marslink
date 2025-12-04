// simLinkBudget.js

import { SIM_CONSTANTS } from "./simConstants.js";

export class SimLinkBudget {
  constructor() {
    this.baseGbps = SIM_CONSTANTS.DEFAULT_BASE_GBPS;
    this.baseDistanceKm = SIM_CONSTANTS.DEFAULT_BASE_DISTANCE_KM;
    this.techImprovementFactor = 1;
    this.AU_IN_KM = SIM_CONSTANTS.AU_IN_KM;
    this.SPEED_OF_LIGHT_KM_S = SIM_CONSTANTS.SPEED_OF_LIGHT_KM_S;
  }

  setTechnologyConfig(technologyConfig) {
    this.baseGbps = technologyConfig["laser_technology.current-throughput-gbps"];
    this.baseDistanceKm = technologyConfig["laser_technology.current-distance-km"];
    this.maxDistanceAU = technologyConfig["simulation.maxDistanceAU"];
    this.calctimeMs = technologyConfig["simulation.calctimeSec"] * 1000;
    this.maxLinksPerSatellite = technologyConfig["laser_technology.laser-ports-per-satellite"];

    this.maxLinksPerRing = {
      ring_earth: technologyConfig["ring_earth.laser-ports-per-satellite"],
      ring_mars: technologyConfig["ring_mars.laser-ports-per-satellite"],
      circular_rings: technologyConfig["circular_rings.laser-ports-per-satellite"],
      eccentric_rings: technologyConfig["eccentric_rings.laser-ports-per-satellite"],
    };

    this.techImprovementFactor = Math.pow(2, technologyConfig["laser_technology.improvement-factor"]);
    console.log("//// this.techImprovementFactor", this.techImprovementFactor);
  }

  convertAUtoKM(AU) {
    return AU * this.AU_IN_KM;
  }

  // Function to calculate Gbps capacity based on distance
  calculateGbps(distanceKm) {
    if (isNaN(distanceKm) || distanceKm <= 0) return 0;
    return this.techImprovementFactor * this.baseGbps * Math.pow(this.baseDistanceKm / distanceKm, 2);
  }

  // Function to calculate distance based on Gbps capacity
  calculateKm(gbps) {
    if (gbps <= 0) return Infinity;
    return Math.round(this.baseDistanceKm * Math.sqrt((this.techImprovementFactor * this.baseGbps) / gbps));
  }

  // Function to calculate latency based on distance
  calculateLatencySeconds(distanceKm) {
    return distanceKm / this.SPEED_OF_LIGHT_KM_S;
  }

  // Function to calculate distance between two positions
  calculateDistance(a, b) {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
  }

  getMaxLinksPerSatellite() {
    return this.maxLinksPerSatellite;
  }

  getMaxLinksPerRing(ringName) {
    if (!ringName) return this.maxLinksPerSatellite;
    if (ringName === "ring_earth") return this.maxLinksPerRing.ring_earth;
    if (ringName === "ring_mars") return this.maxLinksPerRing.ring_mars;
    if (ringName.startsWith("ring_circ")) return this.maxLinksPerRing.circular_rings;
    if (ringName.startsWith("ring_ecce")) return this.maxLinksPerRing.eccentric_rings;
    return this.maxLinksPerSatellite; // fallback
  }
}
