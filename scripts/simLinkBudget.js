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
    this.maxLinksPerRing = {
      ring_earth: technologyConfig["ring_earth.laser-ports-per-satellite"],
      ring_mars: technologyConfig["ring_mars.laser-ports-per-satellite"],
      circular_rings: technologyConfig["circular_rings.laser-ports-per-satellite"],
      eccentric_rings: technologyConfig["eccentric_rings.laser-ports-per-satellite"],
      adapted_rings: technologyConfig["adapted_rings.laser-ports-per-satellite"],
    };

    // Global cap = max of all per-ring values (used as fallback and topology cap)
    this.maxLinksPerSatellite = Math.max(...Object.values(this.maxLinksPerRing).filter((v) => v > 0));

    this.techImprovementFactor = Math.pow(2, technologyConfig["laser_technology.improvement-factor"]);

    // Solar exclusion: angular margin (in degrees) from the sun's visible edge
    this.solarExclusionDeg = technologyConfig["simulation.solarExclusionDeg"] || 0;
    this.solarExclusionRad = this.solarExclusionDeg * SIM_CONSTANTS.DEG_TO_RAD;

    // Max-flow algorithm selection (one of the keys in FLOW_ALGORITHMS)
    this.flowAlgorithm = technologyConfig["simulation.flowAlgorithm"] || undefined;

    // Invalidate Gbps cache when tech config changes
    this._gbpsCache = new Map();
    // Precompute constant factor: techImprovementFactor * baseGbps * baseDistanceKm²
    this._gbpsFactor = this.techImprovementFactor * this.baseGbps * this.baseDistanceKm * this.baseDistanceKm;
  }

  convertAUtoKM(AU) {
    return AU * this.AU_IN_KM;
  }

  // Function to calculate Gbps capacity based on distance
  // Bucketed cache: distances rounded to 100km share the same result
  calculateGbps(distanceKm) {
    if (isNaN(distanceKm) || distanceKm <= 0) return 0;
    const bucket = (distanceKm / 100) | 0; // 100km buckets
    const cached = this._gbpsCache.get(bucket);
    if (cached !== undefined) return cached;
    const result = this._gbpsFactor / (distanceKm * distanceKm);
    this._gbpsCache.set(bucket, result);
    return result;
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
    if (ringName.startsWith("ring_adapt")) return this.maxLinksPerRing.adapted_rings || this.maxLinksPerSatellite;
    return this.maxLinksPerSatellite; // fallback
  }
}
