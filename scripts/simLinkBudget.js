export class SimLinkBudget {
  constructor() {
    this.baseGbps = 100;
    this.baseDistanceKm = 5400;
    this.techImprovementFactor = 1;
    this.AU_IN_KM = 149597871; // 1 AU in kilometers
    this.SPEED_OF_LIGHT_KM_S = 299792; // Speed of light in km/s
  }

  setTechnologyConfig(technologyConfig) {
    this.baseGbps = technologyConfig["current_technology_performance.current-throughput-gbps"];
    this.baseDistanceKm = technologyConfig["current_technology_performance.current-distance-km"];
    this.maxDistanceAU = technologyConfig["simulation.maxDistanceAU"];
    this.calctimeMs = technologyConfig["simulation.calctimeSec"] * 1000;
    this.maxLinksPerSatellite = technologyConfig["capability.laser-ports-per-satellite"];

    this.techImprovementFactor = Math.pow(2, technologyConfig["technology_improvement.improvement-factor"] - 1);
    console.log("this.techImprovementFactor", this.techImprovementFactor);
  }

  convertAUtoKM(AU) {
    return AU * this.AU_IN_KM;
  }

  // Function to calculate Gbps capacity based on distance
  calculateGbps(distanceKm) {
    return this.techImprovementFactor * this.baseGbps * Math.pow(this.baseDistanceKm / distanceKm, 2);
  }

  // Function to calculate distance based on Gbps capacity
  calculateKm(gbps) {
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
}
