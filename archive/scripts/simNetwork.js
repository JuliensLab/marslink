// simNetwork.js

export class SimNetwork {
  constructor() {}

  /**
   * Calculates the optimal network configuration between Earth and Mars using the Edmonds-Karp algorithm.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @param {number} [maxDistanceAU=0.3] - Maximum distance in AU for creating a link.
   * @param {number} [maxLinksPerSatellite=2] - Maximum number of links (laser ports) per satellite.
   * @returns {Array} links - Array of link objects with properties:
   *                          {
   *                            from: { x, y, z },
   *                            to: { x, y, z },
   *                            distanceAU,
   *                            distanceKm,
   *                            latencySeconds,
   *                            gbpsCapacity,
   *                            gbpsFlowActual
   *                          }
   */
  getNetworkData(planets, satellites, maxDistanceAU = 0.3, maxLinksPerSatellite = 2) {
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
    positions[nodeIds.get("Earth")] = earth.position;
    positions[nodeIds.get("Mars")] = mars.position;

    // Add satellite positions
    satellites.forEach((satellite) => {
      positions[nodeIds.get(`${satellite.name}_in`)] = satellite.position;
      positions[nodeIds.get(`${satellite.name}_out`)] = satellite.position;
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
          fromId: earthId,
          toId: satInId,
          fromPosition: earth.position,
          toPosition: satPosition,
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
          fromId: satOutId,
          toId: marsId,
          fromPosition: satPosition,
          toPosition: mars.position,
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
      for (let j = 0; j < satellites.length; j++) {
        if (i === j) continue;
        const satB = satellites[j];
        const satBInId = nodeIds.get(`${satB.name}_in`);
        const distanceAU = calculateDistanceAU(satA.position, satB.position);
        if (distanceAU <= maxDistanceAU) {
          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = calculateGbps(distanceKm);
          const latencySeconds = calculateLatency(distanceKm);
          addEdge(satAOutId, satBInId, gbpsCapacity);
          possibleLinks.push({
            fromId: satAOutId,
            toId: satBInId,
            fromPosition: satA.position,
            toPosition: satB.position,
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
        fromId: earthId,
        toId: marsId,
        fromPosition: earth.position,
        toPosition: mars.position,
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
      const edgeKey = `${link.fromId}_${link.toId}`;
      const flow = flows[edgeKey] || 0;
      if (flow > 0) {
        outputLinks.push({
          from: link.fromPosition,
          to: link.toPosition,
          distanceAU: link.distanceAU,
          distanceKm: link.distanceKm,
          latencySeconds: link.latencySeconds,
          gbpsCapacity: link.gbpsCapacity,
          gbpsFlowActual: flow,
        });
      }
    }

    console.log(`Total aggregated Gbps between Earth and Mars: ${maxFlowResult.maxFlow.toFixed(2)} Gbps`);

    return outputLinks;
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
