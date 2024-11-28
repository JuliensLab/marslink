// simNetwork.js

export class SimNetwork {
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

  getPossibleLinks(planets, satellites, simLinkBudget, maxDistanceAU, maxLinksPerSatellite) {
    // Constants
    const AU_IN_KM = 149597871; // 1 AU in kilometers
    const SPEED_OF_LIGHT_KM_S = 299792; // Speed of light in km/s
    const planetsOptions = ["Earth", "Mars"];

    // Filter planets based on the provided options
    const filteredPlanets = planets.filter((planet) => planetsOptions.includes(planet.name));

    // Positions mapping
    const positions = {};

    // Collect planet positions
    filteredPlanets.forEach((planet) => {
      positions[planet.name] = planet.position;
    });

    // Collect satellite positions
    satellites.forEach((satellite) => {
      positions[satellite.name] = satellite.position;
    });

    // Helper Functions
    const calculateDistanceAU = (a, b) => {
      return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
    };

    const calculateGbps = (distanceKm) => {
      return simLinkBudget.calculateGbps(distanceKm);
    };

    const calculateLatency = (distanceKm) => {
      return distanceKm / SPEED_OF_LIGHT_KM_S;
    };

    const calculateDistanceToSun = (position) => {
      return Math.sqrt(Math.pow(position.x, 2) + Math.pow(position.y, 2) + Math.pow(position.z, 2));
    };

    // Initialize variables
    const finalLinks = []; // Final list of links to return
    const linkCounts = {}; // Track the number of links per satellite

    // Initialize linkCounts for satellites
    satellites.forEach((satellite) => {
      linkCounts[satellite.name] = 0;
    });

    // Step 1: Add Neighbor Links for All Satellites (Circular, Mars, and Earth Rings)
    // Group satellites by ringName
    const rings = {}; // { ringName: [satellite1, satellite2, ...] }

    satellites.forEach((satellite) => {
      const ringName = satellite.ringName;
      if (!rings[ringName]) rings[ringName] = [];
      rings[ringName].push(satellite);
    });

    // Create neighbor links for all rings (including Mars and Earth)
    Object.entries(rings).forEach(([ringName, ringSatellites]) => {
      ringSatellites.forEach((satellite) => {
        satellite.neighbors.forEach((neighborName) => {
          // Ensure neighbor exists
          if (!positions[neighborName]) return;

          // To avoid duplicate links, order the IDs lexicographically
          const [fromId, toId] = satellite.name < neighborName ? [satellite.name, neighborName] : [neighborName, satellite.name];

          // Check if the link already exists
          const linkExists = finalLinks.some((link) => link.fromId === fromId && link.toId === toId);
          if (linkExists) return;

          // Calculate distances and other metrics
          const distanceAU = calculateDistanceAU(positions[satellite.name], positions[neighborName]);
          const distanceKm = distanceAU * AU_IN_KM;

          // Enforce maximum distance constraint
          if (distanceAU > maxDistanceAU) return;

          const gbpsCapacity = calculateGbps(distanceKm);
          const latencySeconds = calculateLatency(distanceKm);

          // Add the link
          finalLinks.push({
            fromId,
            toId,
            distanceAU,
            distanceKm,
            latencySeconds,
            gbpsCapacity,
          });

          // Increment link counts
          linkCounts[satellite.name]++;
          linkCounts[neighborName]++;
        });
      });
    });

    // console.log("Step 1: Added Neighbor Links for All Rings");

    // Step 2: Add Links for Circular Rings Based on `a` and `vpo` (Excluding Mars and Earth Rings)
    // Identify circular rings (exclude 'ring_mars' and 'ring_earth')
    const circularRingNames = Object.keys(rings).filter((ringName) => !["ring_mars", "ring_earth"].includes(ringName));

    // Sort circular rings from furthest to closest based on 'a' (descending order)
    const sortedCircularRings = circularRingNames.slice().sort((a, b) => {
      const aDistance = rings[a][0].a; // 'a' is the distance from the sun in AU
      const bDistance = rings[b][0].a;
      return bDistance - aDistance; // Descending order: furthest first
    });

    // Iterate through each circular ring and link to the next inner ring
    for (let i = 0; i < sortedCircularRings.length - 1; i++) {
      const currentRingName = sortedCircularRings[i];
      const nextRingName = sortedCircularRings[i + 1];
      const currentRingSatellites = rings[currentRingName];
      const nextRingSatellites = rings[nextRingName];

      // Sort the next ring satellites by vpo for efficient searching
      const sortedNextRingSatellites = nextRingSatellites.slice().sort((a, b) => a.position.vpo - b.position.vpo);
      const sortedVpoList = sortedNextRingSatellites.map((sat) => sat.position.vpo);

      // For each satellite in the current ring, find the nearest lower and higher vpo satellites in the next ring
      currentRingSatellites.forEach((currentSatellite) => {
        const currentVpo = currentSatellite.position.vpo % 360; // Ensure vpo is within [0, 360)

        // Function to find the nearest lower vpo satellite
        const findNearestLower = () => {
          // Binary search for the rightmost satellite with vpo <= currentVpo
          let left = 0;
          let right = sortedVpoList.length - 1;
          let resultIndex = -1;

          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (sortedVpoList[mid] <= currentVpo) {
              resultIndex = mid;
              left = mid + 1;
            } else {
              right = mid - 1;
            }
          }

          if (resultIndex === -1) {
            // Wrap around to the last satellite
            return sortedNextRingSatellites[sortedNextRingSatellites.length - 1];
          } else {
            return sortedNextRingSatellites[resultIndex];
          }
        };

        // Function to find the nearest higher vpo satellite
        const findNearestHigher = () => {
          // Binary search for the leftmost satellite with vpo > currentVpo
          let left = 0;
          let right = sortedVpoList.length - 1;
          let resultIndex = -1;

          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (sortedVpoList[mid] > currentVpo) {
              resultIndex = mid;
              right = mid - 1;
            } else {
              left = mid + 1;
            }
          }

          if (resultIndex === -1) {
            // Wrap around to the first satellite
            return sortedNextRingSatellites[0];
          } else {
            return sortedNextRingSatellites[resultIndex];
          }
        };

        const nearestLowerSatellite = findNearestLower();
        const nearestHigherSatellite = findNearestHigher();

        const targetSatellites = [nearestLowerSatellite, nearestHigherSatellite];

        targetSatellites.forEach((targetSatellite) => {
          const toId = targetSatellite.name;
          const fromId = currentSatellite.name;

          // Check if both satellites can have more links
          if (linkCounts[fromId] >= maxLinksPerSatellite || linkCounts[toId] >= maxLinksPerSatellite) {
            return;
          }

          // Calculate the actual distance
          const distanceAU = calculateDistanceAU(positions[fromId], positions[toId]);

          // Enforce maximum distance constraint
          if (distanceAU > maxDistanceAU) return;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = calculateGbps(distanceKm);
          const latencySeconds = calculateLatency(distanceKm);

          // To avoid duplicate links, order the IDs lexicographically
          const [orderedFromId, orderedToId] = fromId < toId ? [fromId, toId] : [toId, fromId];

          // Check if the link already exists
          const linkExists = finalLinks.some((link) => link.fromId === orderedFromId && link.toId === orderedToId);
          if (linkExists) return;

          // Add the link
          finalLinks.push({
            fromId: orderedFromId,
            toId: orderedToId,
            distanceAU,
            distanceKm,
            latencySeconds,
            gbpsCapacity,
          });

          // Increment link counts
          linkCounts[fromId]++;
          linkCounts[toId]++;
        });
      });
    }

    // console.log("Step 2: Added Links for Circular Rings Based on a and VPO");

    // Step 3: Add Links for Mars and Earth Rings Using VPO Delta
    // Identify Mars and Earth rings
    const earthMarsRings = ["ring_earth", "ring_mars"].filter((ringName) => rings[ringName]);

    // Precompute ring 'a' values for all rings
    const ringAValues = {};
    Object.keys(rings).forEach((ringName) => {
      ringAValues[ringName] = rings[ringName][0].a; // Assume all satellites in a ring have the same 'a'
    });

    // Function to find the nearest satellite in a circular ring to a given position
    const findNearestSatellite = (circularSatellites, targetPosition) => {
      if (circularSatellites.length === 0) return null;

      // Sort circularSatellites by distance to targetPosition
      const sortedByDistance = circularSatellites.slice().sort((a, b) => {
        const distA = calculateDistanceAU(a.position, targetPosition);
        const distB = calculateDistanceAU(b.position, targetPosition);
        return distA - distB;
      });

      return sortedByDistance[0]; // Return the closest satellite
    };

    // Function to calculate VPO delta for a given ring (Earth or Mars)
    const calculateVpoDelta = (targetRingName, targetSatellite) => {
      // Find the nearest circular ring based on 'a' (distance from the sun)
      const targetA = ringAValues[targetRingName];
      const otherRingNames = Object.keys(rings).filter((ringName) => !["ring_earth", "ring_mars"].includes(ringName));

      // Find the circular ring with the closest 'a' value to targetA
      const sortedByA = otherRingNames.slice().sort((a, b) => {
        return Math.abs(ringAValues[a] - targetA) - Math.abs(ringAValues[b] - targetA);
      });

      const nearestCircularRingName = sortedByA[0];
      const nearestCircularRing = rings[nearestCircularRingName];

      if (!nearestCircularRing || nearestCircularRing.length === 0) return 0; // Default delta if no circular ring found

      // Find the nearest satellite in the circular ring to the targetSatellite's position
      const nearestCircularSatellite = findNearestSatellite(nearestCircularRing, targetSatellite.position);

      if (!nearestCircularSatellite) return 0; // Default delta if no satellite found

      // Calculate VPO delta
      const vpoDelta = (targetSatellite.position.vpo - nearestCircularSatellite.position.vpo + 360) % 360;

      return vpoDelta;
    };

    // Calculate VPO deltas for Earth and Mars rings
    const vpoDeltas = {}; // { 'ring_earth': delta, 'ring_mars': delta }

    earthMarsRings.forEach((targetRingName) => {
      const targetSatellites = rings[targetRingName];
      if (targetSatellites.length === 0) return;

      const firstSatellite = targetSatellites[0];
      const delta = calculateVpoDelta(targetRingName, firstSatellite);
      vpoDeltas[targetRingName] = delta;
    });
    // Function to apply VPO delta and normalize
    const applyVpoDelta = (vpo, delta) => {
      return (vpo + delta + 360) % 360;
    };

    function convertRingToPlanet(ringName) {
      // Extract the part after the underscore and capitalize it
      const partAfterUnderscore = ringName.split("_")[1];
      return partAfterUnderscore.charAt(0).toUpperCase() + partAfterUnderscore.slice(1).toLowerCase();
    }

    // Add Links for Earth and Mars Rings
    earthMarsRings.forEach((targetRingName) => {
      const targetSatellites = rings[targetRingName];
      // Add Earth and Mars to its ring
      targetSatellites.push(filteredPlanets.find((planet) => planet.name == convertRingToPlanet(targetRingName)));
      const vpoDelta = vpoDeltas[targetRingName] || 0;

      targetSatellites.forEach((satellite) => {
        const satellitePosition = satellite.position;
        const satelliteDistanceToSun = calculateDistanceToSun(satellitePosition);

        // Determine the closest rings based on 'a' values
        const otherRingNames = Object.keys(rings).filter((ringName) => ringName !== targetRingName);
        const ringDifferences = otherRingNames.map((ringName) => {
          const aValue = ringAValues[ringName];
          const difference = Math.abs(satelliteDistanceToSun - aValue);
          return { ringName, difference };
        });

        // Sort rings by difference
        ringDifferences.sort((a, b) => a.difference - b.difference);

        // Select closest and second closest rings based on the specified criteria
        let selectedRings = [];
        if (ringDifferences.length > 0) {
          const firstDifference = ringDifferences[0].difference;
          const secondDifference = ringDifferences[1] ? ringDifferences[1].difference : Infinity;

          if (firstDifference < secondDifference / 2) {
            selectedRings.push(ringDifferences[0].ringName);
          } else {
            selectedRings.push(ringDifferences[0].ringName);
            if (ringDifferences[1]) {
              selectedRings.push(ringDifferences[1].ringName);
            }
          }
        }

        // For each selected ring, find target satellites
        selectedRings.forEach((selectedRingName) => {
          const selectedRingSatellites = rings[selectedRingName];

          // Sort selected ring satellites by adjusted VPO distance to current satellite
          const sortedByVpo = selectedRingSatellites.slice().sort((a, b) => {
            const currentVpoAdjusted = applyVpoDelta(satellite.position.vpo, -vpoDelta);
            const vpoA = a.position.vpo;
            const vpoB = b.position.vpo;

            const diffA = Math.min(Math.abs(vpoA - currentVpoAdjusted), 360 - Math.abs(vpoA - currentVpoAdjusted));
            const diffB = Math.min(Math.abs(vpoB - currentVpoAdjusted), 360 - Math.abs(vpoB - currentVpoAdjusted));
            return diffA - diffB;
          });

          // Take the top 10 satellites with nearest adjusted VPO
          const top10VpoSatellites = sortedByVpo.slice(0, 4);

          // Calculate distances and select the 2 nearest satellites
          const sortedByDistance = top10VpoSatellites
            .map((targetSat) => {
              const distanceAU = calculateDistanceAU(positions[satellite.name], positions[targetSat.name]);
              return { satellite: targetSat, distanceAU };
            })
            .sort((a, b) => a.distanceAU - b.distanceAU);

          const nearestTwoSatellites = sortedByDistance.slice(0, 2).map((item) => item.satellite);

          // Add links to finalLinks
          nearestTwoSatellites.forEach((targetSat) => {
            const toId = targetSat.name;
            const fromId = satellite.name;

            // Check if both satellites can have more links
            if (linkCounts[fromId] >= maxLinksPerSatellite || linkCounts[toId] >= maxLinksPerSatellite) {
              return;
            }

            // Calculate the actual distance
            const distanceAU = calculateDistanceAU(positions[fromId], positions[toId]);

            // Enforce maximum distance constraint
            // if (distanceAU > maxDistanceAU) return;

            const distanceKm = distanceAU * AU_IN_KM;
            const gbpsCapacity = calculateGbps(distanceKm);
            const latencySeconds = calculateLatency(distanceKm);

            // To avoid duplicate links, order the IDs lexicographically
            const [orderedFromId, orderedToId] = fromId < toId ? [fromId, toId] : [toId, fromId];

            // Check if the link already exists
            const linkExists = finalLinks.some((link) => link.fromId === orderedFromId && link.toId === orderedToId);
            if (linkExists) return;

            // Add the link
            finalLinks.push({
              fromId: orderedFromId,
              toId: orderedToId,
              distanceAU,
              distanceKm,
              latencySeconds,
              gbpsCapacity,
            });

            // Increment link counts
            linkCounts[fromId]++;
            linkCounts[toId]++;
          });
        });
      });
    });

    // console.log("Step 3: Added Links for Mars and Earth Rings Using VPO Delta");
    console.log(finalLinks);
    return finalLinks;
  }
  /**
   * Constructs the network graph based on precomputed finalLinks and computes the maximum flow.
   *
   * @param {Array} planets - Array of planet objects (e.g., Earth, Mars) with properties like name and position.
   * @param {Array} satellites - Array of satellite objects with properties like name, ringName, position, neighbors, and 'a'.
   * @param {Array} finalLinks - Array of link objects precomputed by getPossibleLinks, each containing fromId, toId, distanceAU, distanceKm, latencySeconds, and gbpsCapacity.
   * @returns {Object} - An object containing the established links with flow information and the total maximum flow.
   */
  getNetworkData(planets, satellites, finalLinks) {
    // Constants (if needed)
    const AU_IN_KM = 149597871; // 1 AU in kilometers
    const SPEED_OF_LIGHT_KM_S = 299792; // Speed of light in km/s

    // Node ID Assignment
    const nodeIds = new Map(); // Map to store node IDs
    let nodeIdCounter = 0;

    // Add Earth and Mars to node IDs
    const earth = planets.find((planet) => planet.name === "Earth");
    const mars = planets.find((planet) => planet.name === "Mars");

    if (!earth || !mars) {
      console.warn("Earth or Mars position is not available.");
      return { links: [], maxFlow: 0 };
    }

    nodeIds.set("Earth", nodeIdCounter++);
    nodeIds.set("Mars", nodeIdCounter++);

    // Add Satellites to node IDs (single node per satellite, no splitting)
    satellites.forEach((satellite) => {
      nodeIds.set(satellite.name, nodeIdCounter++);
    });

    // Build the Graph
    const graph = {}; // Adjacency list representation
    const capacities = {}; // Edge capacities
    const positions = {}; // Node positions for reference

    // Initialize graph nodes
    nodeIds.forEach((id, name) => {
      graph[id] = [];
      positions[name] = planetOrSatellitePosition(planets, satellites, name);
    });

    // Helper Function to Retrieve Position
    function planetOrSatellitePosition(planets, satellites, name) {
      const planet = planets.find((p) => p.name === name);
      if (planet) return planet.position;
      const satellite = satellites.find((s) => s.name === name);
      return satellite ? satellite.position : null;
    }

    // Helper Function to Add Edges (Bidirectional)
    const addEdge = (fromId, toId, capacity) => {
      if (!graph[fromId].includes(toId)) {
        graph[fromId].push(toId);
      }
      if (!graph[toId].includes(fromId)) {
        graph[toId].push(fromId);
      }
      const edgeKey = `${fromId}_${toId}`;
      capacities[edgeKey] = capacity;
      const reverseEdgeKey = `${toId}_${fromId}`;
      capacities[reverseEdgeKey] = capacity; // Same capacity in reverse
    };

    // Add All Links (Bidirectional)
    finalLinks.forEach((link) => {
      const { fromId, toId, gbpsCapacity } = link;

      // Validate Node IDs
      if (!nodeIds.has(fromId)) {
        console.warn(`fromId "${fromId}" not found among planets or satellites.`);
        return;
      }
      if (!nodeIds.has(toId)) {
        console.warn(`toId "${toId}" not found among planets or satellites.`);
        return;
      }

      const fromNodeId = nodeIds.get(fromId);
      const toNodeId = nodeIds.get(toId);

      addEdge(fromNodeId, toNodeId, gbpsCapacity);
    });

    console.log("Graph Construction Complete:", graph);

    // Implement the Edmonds-Karp Algorithm
    const source = nodeIds.get("Earth");
    const sink = nodeIds.get("Mars");

    const maxFlowResult = this.edmondsKarp(graph, capacities, source, sink);

    // Extract the Flows on Each Link
    const flows = maxFlowResult.flows;

    // Prepare the Output Links with flow > 0
    const outputLinks = [];

    finalLinks.forEach((link) => {
      const { fromId, toId, distanceAU, distanceKm, latencySeconds, gbpsCapacity } = link;

      // Retrieve Node IDs
      const fromNodeId = nodeIds.get(fromId);
      const toNodeId = nodeIds.get(toId);

      // Define Edge Keys
      const forwardEdgeKey = `${fromNodeId}_${toNodeId}`;
      const reverseEdgeKey = `${toNodeId}_${fromNodeId}`;

      // Calculate Net Flow (Forward - Reverse)
      const forwardFlow = flows[forwardEdgeKey] || 0;
      const reverseFlow = flows[reverseEdgeKey] || 0;
      const netFlow = forwardFlow - reverseFlow;

      if (netFlow > 0) {
        outputLinks.push({
          fromId: fromId,
          toId: toId,
          distanceAU: Math.round(distanceAU * 1e6) / 1e6,
          distanceKm: Math.round(distanceKm),
          latencySeconds: Math.round(latencySeconds * 10) / 10,
          gbpsCapacity: Math.round(gbpsCapacity * 1e6) / 1e6,
          gbpsFlowActual: Math.round(netFlow * 1e6) / 1e6,
        });
      }
      // Optionally, handle negative flows if needed
      else if (netFlow < 0) {
        outputLinks.push({
          fromId: toId,
          toId: fromId,
          distanceAU: Math.round(distanceAU * 1e6) / 1e6,
          distanceKm: Math.round(distanceKm),
          latencySeconds: Math.round(latencySeconds * 10) / 10,
          gbpsCapacity: Math.round(gbpsCapacity * 1e6) / 1e6,
          gbpsFlowActual: Math.round(-netFlow * 1e6) / 1e6,
        });
      }
    });

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

      // If no path to sink, terminate
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
