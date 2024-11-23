// simLinks.js

export class SimLinks {
  constructor() {}

  /**
   * Generates all possible links between planets and satellites based on maxDistanceAU.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @param {number} [maxDistanceAU=0.3] - Maximum distance in AU for creating a link.
   * @returns {Array} links - Array of link objects with properties:
   *                          {
   *                            fromId: string,
   *                            toId: string,
   *                            distanceAU,
   *                            distanceKm,
   *                            latencySeconds,
   *                            gbpsCapacity
   *                          }
   */
  getPossibleLinks(planets, satellites, maxDistanceAU = 0.3) {
    // Constants
    const AU_IN_KM = 149597871; // 1 AU in kilometers
    const SPEED_OF_LIGHT_KM_S = 299792; // Speed of light in km/s
    const BASE_GBPS = 10000000; // Starting Gbps at 1000 km
    const BASE_DISTANCE_KM = 1000; // Base distance for Gbps calculation
    const planetsOptions = ["Earth", "Mars"];
    const filteredPlanets = planets.filter((planet) => planetsOptions.includes(planet.name));

    // Positions
    const positions = {};

    // Collect planet positions
    filteredPlanets.forEach((planet) => {
      positions[planet.name] = planet.position;
    });

    // Collect satellite positions
    satellites.forEach((satellite) => {
      positions[satellite.name] = satellite.position;
    });

    // Function to calculate distance between two positions in AU
    const calculateDistanceAU = (a, b) => {
      return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
    };

    // Function to calculate Gbps capacity based on distance
    const calculateGbps = (distanceKm) => {
      return BASE_GBPS * Math.pow(BASE_DISTANCE_KM / distanceKm, 2);
    };

    // Function to calculate latency based on distance
    const calculateLatency = (distanceKm) => {
      return distanceKm / SPEED_OF_LIGHT_KM_S;
    };

    const links = [];

    // Combine planets and satellites into one array
    const nodes = filteredPlanets.concat(satellites);

    // Generate all possible pairs
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i];
      const nodeAName = nodeA.name;
      const nodeAPosition = positions[nodeAName];

      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j];
        const nodeBName = nodeB.name;
        const nodeBPosition = positions[nodeBName];

        const distanceAU = calculateDistanceAU(nodeAPosition, nodeBPosition);
        if (distanceAU <= maxDistanceAU) {
          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = calculateGbps(distanceKm);
          const latencySeconds = calculateLatency(distanceKm);

          links.push({
            fromId: nodeAName,
            toId: nodeBName,
            distanceAU,
            distanceKm,
            latencySeconds,
            gbpsCapacity,
          });
        }
      }
    }

    return links;
  }
}
