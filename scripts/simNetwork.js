// simNetwork.js

export class SimNetwork {
  constructor() {}

  /**
   * Calculates the optimal network configuration between Earth and Mars using the Edmonds-Karp algorithm.
   *
   * The total aggregated Gbps is calculated by modeling the communication network as a flow network and
   * using the Edmonds-Karp algorithm (a specific implementation of the Ford-Fulkerson method) to find
   * the maximum flow from the source node (Earth) to the sink node (Mars). The maximum flow represents
   * the maximum possible data throughput (in Gbps) that can be achieved given the capacities of the
   * links in the network.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @param {number} [maxDistanceAU=0.3] - Maximum distance in AU for creating a link.
   * @param {number} [maxLinksPerSatellite=2] - Maximum number of links (laser ports) per satellite.
   * @returns {Array} links - Array of link objects with properties:
   *                          {
   *                            fromId: string,
   *                            toId: string,
   *                            distanceAU,
   *                            distanceKm,
   *                            latencySeconds,
   *                            gbpsCapacity,
   *                            gbpsFlowActual
   *                          }
   */
  getNetworkData(planets, satellites, maxDistanceAU = 0.4, maxLinksPerSatellite = 2) {
    // Constants
    const AU_IN_KM = 149597871; // 1 AU in kilometers
    const SPEED_OF_LIGHT_KM_S = 299792; // Speed of light in km/s
    const BASE_GBPS = 10000000; // Starting Gbps at 1000 km
    const BASE_DISTANCE_KM = 1000; // Base distance for Gbps calculation

    // Node IDs
    const nodeIds = new Map(); // Map to store node IDs
    let nodeIdCounter = 0;

    // Add Earth and Mars to node IDs
    const earth = planets.find((planet) => planet.name === "Earth");
    const mars = planets.find((planet) => planet.name === "Mars");

    if (!earth || !mars) {
      console.warn("Earth or Mars position is not available.");
      return [];
    }

    nodeIds.set("Earth", nodeIdCounter++);
    nodeIds.set("Mars", nodeIdCounter++);

    // For each satellite, create 'in' and 'out' nodes
    satellites.forEach((satellite) => {
      nodeIds.set(`${satellite.name}_in`, nodeIdCounter++);
      nodeIds.set(`${satellite.name}_out`, nodeIdCounter++);
    });

    // Build the graph
    const graph = {}; // Adjacency list representation
    const capacities = {}; // Edge capacities
    const positions = {}; // Node positions for reference

    // Initialize graph nodes
    for (let [name, id] of nodeIds.entries()) {
      graph[id] = [];
    }

    // Helper function to add edges
    const addEdge = (fromId, toId, capacity) => {
      graph[fromId].push(toId);
      graph[toId].push(fromId); // Add reverse edge for residual graph
      const edgeKey = `${fromId}_${toId}`;
      capacities[edgeKey] = capacity;
      capacities[`${toId}_${fromId}`] = 0; // Reverse edge capacity
    };

    // Add positions for Earth and Mars
    positions["Earth"] = earth.position;
    positions["Mars"] = mars.position;

    // Add satellite positions
    satellites.forEach((satellite) => {
      positions[satellite.name] = satellite.position;
    });

    // Add edges between satellite_in and satellite_out with capacities based on port constraints
    satellites.forEach((satellite) => {
      const inId = nodeIds.get(`${satellite.name}_in`);
      const outId = nodeIds.get(`${satellite.name}_out`);
      const maxSatelliteCapacity = Infinity; // Assuming unlimited capacity through the satellite
      addEdge(inId, outId, maxSatelliteCapacity);
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

    // Collect possible links
    const possibleLinks = [];

    // Satellites to Planets (Earth and Mars)
    satellites.forEach((satellite) => {
      const satInId = nodeIds.get(`${satellite.name}_in`);
      const satOutId = nodeIds.get(`${satellite.name}_out`);
      const satName = satellite.name;
      const satPosition = satellite.position;

      // From Earth to satellite_in
      const distanceAU = calculateDistanceAU(earth.position, satPosition);
      if (distanceAU <= maxDistanceAU) {
        const distanceKm = distanceAU * AU_IN_KM;
        const gbpsCapacity = calculateGbps(distanceKm);
        const latencySeconds = calculateLatency(distanceKm);
        const earthId = nodeIds.get("Earth");
        addEdge(earthId, satInId, gbpsCapacity);
        possibleLinks.push({
          fromId: "Earth",
          toId: satName,
          fromNodeId: earthId,
          toNodeId: satInId, // Store node IDs here
          distanceAU,
          distanceKm,
          latencySeconds,
          gbpsCapacity,
        });
      }

      // From satellite_out to Mars
      const distanceToMarsAU = calculateDistanceAU(satPosition, mars.position);
      if (distanceToMarsAU <= maxDistanceAU) {
        const distanceKm = distanceToMarsAU * AU_IN_KM;
        const gbpsCapacity = calculateGbps(distanceKm);
        const latencySeconds = calculateLatency(distanceKm);
        const marsId = nodeIds.get("Mars");
        addEdge(satOutId, marsId, gbpsCapacity);
        possibleLinks.push({
          fromId: satName,
          toId: "Mars",
          fromNodeId: satOutId, // Include fromNodeId
          toNodeId: marsId, // Include toNodeId
          distanceAU: distanceToMarsAU,
          distanceKm,
          latencySeconds,
          gbpsCapacity,
        });
      }
    });

    // Satellites to Satellites
    for (let i = 0; i < satellites.length; i++) {
      const satA = satellites[i];
      const satAOutId = nodeIds.get(`${satA.name}_out`);
      const satAName = satA.name;
      for (let j = 0; j < satellites.length; j++) {
        if (i === j) continue;
        const satB = satellites[j];
        const satBInId = nodeIds.get(`${satB.name}_in`);
        const satBName = satB.name;
        const distanceAU = calculateDistanceAU(satA.position, satB.position);
        if (distanceAU <= maxDistanceAU) {
          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = calculateGbps(distanceKm);
          const latencySeconds = calculateLatency(distanceKm);
          addEdge(satAOutId, satBInId, gbpsCapacity);
          possibleLinks.push({
            fromId: satAName,
            toId: satBName,
            fromNodeId: satAOutId, // Use node IDs
            toNodeId: satBInId, // Use node IDs
            distanceAU,
            distanceKm,
            latencySeconds,
            gbpsCapacity,
          });
        }
      }
    }

    // Earth to Mars direct link (if within max distance)
    const earthMarsDistanceAU = calculateDistanceAU(earth.position, mars.position);
    if (earthMarsDistanceAU <= maxDistanceAU) {
      const earthId = nodeIds.get("Earth");
      const marsId = nodeIds.get("Mars");
      const distanceKm = earthMarsDistanceAU * AU_IN_KM;
      const gbpsCapacity = calculateGbps(distanceKm);
      const latencySeconds = calculateLatency(distanceKm);
      addEdge(earthId, marsId, gbpsCapacity);
      possibleLinks.push({
        fromId: "Earth",
        toId: "Mars",
        fromNodeId: earthId, // Include fromNodeId
        toNodeId: marsId, // Include toNodeId
        distanceAU: earthMarsDistanceAU,
        distanceKm,
        latencySeconds,
        gbpsCapacity,
      });
    }

    // Now, we need to implement the Edmonds-Karp algorithm
    const maxFlowResult = this.edmondsKarp(graph, capacities, nodeIds.get("Earth"), nodeIds.get("Mars"));

    // Extract the flows on each edge
    const flows = maxFlowResult.flows;

    // Prepare the output links with flow > 0
    const outputLinks = [];

    for (const link of possibleLinks) {
      const edgeKey = `${link.fromNodeId}_${link.toNodeId}`; // Use node IDs to construct edgeKey
      const flow = flows[edgeKey] || 0;
      if (flow > 0) {
        outputLinks.push({
          fromId: link.fromId,
          toId: link.toId,
          distanceAU: Math.round(link.distanceAU * 1000000) / 1000000,
          distanceKm: Math.round(link.distanceKm),
          latencySeconds: Math.round(link.latencySeconds * 10) / 10,
          gbpsCapacity: Math.round(link.gbpsCapacity * 1000000) / 1000000,
          gbpsFlowActual: Math.round(flow * 1000000) / 1000000,
        });
      }
    }

    return { links: outputLinks, maxFlow: maxFlowResult.maxFlow };
  }

  /**
   * Edmonds-Karp algorithm to find the maximum flow in a flow network.
   *
   * @param {Object} graph - Adjacency list of the graph.
   * @param {Object} capacities - Edge capacities.
   * @param {number} source - Source node ID.
   * @param {number} sink - Sink node ID.
   * @returns {Object} - { maxFlow, flows }
   */
  edmondsKarp(graph, capacities, source, sink) {
    const flows = {}; // Edge flows
    let maxFlow = 0;

    while (true) {
      // Breadth-First Search (BFS) to find the shortest augmenting path
      const queue = [];
      const parents = {};
      queue.push(source);
      parents[source] = null;

      while (queue.length > 0) {
        const current = queue.shift();

        for (const neighbor of graph[current]) {
          const edgeKey = `${current}_${neighbor}`;
          const residualCapacity = capacities[edgeKey] - (flows[edgeKey] || 0);
          if (residualCapacity > 0 && !(neighbor in parents)) {
            parents[neighbor] = current;
            if (neighbor === sink) break; // Reached sink
            queue.push(neighbor);
          }
        }
      }

      // If we didn't find a path to the sink, we're done
      if (!(sink in parents)) break;

      // Find minimum residual capacity along the path
      let pathFlow = Infinity;
      let s = sink;
      while (s !== source) {
        const prev = parents[s];
        const edgeKey = `${prev}_${s}`;
        const residualCapacity = capacities[edgeKey] - (flows[edgeKey] || 0);
        pathFlow = Math.min(pathFlow, residualCapacity);
        s = prev;
      }

      // Update flows along the path
      s = sink;
      while (s !== source) {
        const prev = parents[s];
        const edgeKey = `${prev}_${s}`;
        const reverseEdgeKey = `${s}_${prev}`;
        flows[edgeKey] = (flows[edgeKey] || 0) + pathFlow;
        flows[reverseEdgeKey] = (flows[reverseEdgeKey] || 0) - pathFlow;
        s = prev;
      }

      maxFlow += pathFlow;
    }

    return { maxFlow, flows };
  }
}
