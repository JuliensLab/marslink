// simNetwork.js

export class SimNetwork {
  constructor(simLinkBudget) {
    this.AU_IN_KM = 149597871; // 1 AU in kilometers
    this.SPEED_OF_LIGHT_KM_S = 299792; // Speed of light in km/s}
    this.simLinkBudget = simLinkBudget;
  }

  /**
   * Generates all possible links between planets and satellites.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
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

  // Function to calculate Euclidean distance in AU between two satellites
  calculateDistance2DAU = (pos1, pos2) => {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Helper Functions
  calculateDistanceAU = (a, b) => {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
  };

  calculateGbps = (distanceKm) => {
    return this.simLinkBudget.calculateGbps(distanceKm);
  };

  calculateLatency = (distanceKm) => {
    return distanceKm / this.SPEED_OF_LIGHT_KM_S;
  };

  calculateDistanceToSun = (position) => {
    return Math.sqrt(Math.pow(position.x, 2) + Math.pow(position.y, 2) + Math.pow(position.z, 2));
  };

  getPossibleLinks(planets, satellites) {
    // Group satellites by ringName
    const rings = {}; // { ringName: [satellite1, satellite2, ...] }

    satellites.forEach((satellite) => {
      const ringName = satellite.ringName;
      if (!rings[ringName]) rings[ringName] = [];
      rings[ringName].push(satellite);
    });

    // Positions mapping
    const positions = {};

    // Collect satellite positions
    satellites.forEach((satellite) => {
      positions[satellite.name] = satellite.position;
    });

    // Initialize variables
    const linkCounts = {}; // Track the number of links per satellite

    // Initialize linkCounts for satellites
    satellites.forEach((satellite) => {
      linkCounts[satellite.name] = 0;
    });

    // Constants
    const planetsOptions = ["Earth", "Mars"];

    // Filter planets based on the provided options
    const filteredPlanets = planets.filter((planet) => planetsOptions.includes(planet.name));

    // Collect planet positions
    filteredPlanets.forEach((planet) => {
      positions[planet.name] = planet.position;
    });

    const finalLinks = []; // Final list of links to return

    this.intraRing(rings, positions, linkCounts, finalLinks);

    this.interCircularRings(rings, positions, linkCounts, finalLinks);

    this.marsEarthRings(rings, positions, linkCounts, finalLinks);

    this.eccentricRings(rings, positions, linkCounts, finalLinks);

    this.connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks);

    return finalLinks;
  }

  intraRing(rings, positions, linkCounts, finalLinks) {
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
          const distanceAU = this.calculateDistanceAU(positions[satellite.name], positions[neighborName]);
          const distanceKm = distanceAU * this.AU_IN_KM;

          // Enforce maximum distance constraint
          if (distanceAU > this.simLinkBudget.maxDistanceAU) return;

          const gbpsCapacity = this.calculateGbps(distanceKm);
          const latencySeconds = this.calculateLatency(distanceKm);

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
  }

  eccentricRings(rings, positions, linkCounts, finalLinks) {
    // Step 1: Identify valid rings (eccentric and circular rings)
    const eccentricRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_ecce"));
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));
    const validRingNames = new Set([...eccentricRingNames, ...circularRingNames]);

    // Step 2: Collect all possible link options between eccentric satellites and satellites in valid rings
    const possibleLinks = [];

    // For each eccentric satellite
    eccentricRingNames.forEach((eccentricRingName) => {
      const eccSatellites = rings[eccentricRingName];

      eccSatellites.forEach((eccSatellite) => {
        // For each satellite in valid rings (excluding itself)
        validRingNames.forEach((targetRingName) => {
          const targetSatellites = rings[targetRingName];

          targetSatellites.forEach((targetSatellite) => {
            // Exclude the same satellite
            if (eccSatellite.name === targetSatellite.name) return;

            // Exclude if both satellites are in the same eccentric ring
            if (
              eccentricRingNames.includes(eccentricRingName) &&
              eccentricRingNames.includes(targetRingName) &&
              eccentricRingName === targetRingName
            ) {
              return;
            }

            const distanceAU = this.calculateDistanceAU(positions[eccSatellite.name], positions[targetSatellite.name]);
            // Enforce maximum distance constraint
            if (distanceAU > this.simLinkBudget.maxDistanceAU) return;

            const distanceKm = distanceAU * this.AU_IN_KM;
            const gbpsCapacity = this.calculateGbps(distanceKm);
            const latencySeconds = this.calculateLatency(distanceKm);

            possibleLinks.push({
              fromSatellite: eccSatellite,
              toSatellite: targetSatellite,
              distanceAU,
              distanceKm,
              gbpsCapacity,
              latencySeconds,
            });
          });
        });
      });
    });

    // Step 3: Filter the possibleLinks to retain only those with sufficient capacity
    const bestGbpsCapacity = possibleLinks.reduce((max, link) => Math.max(max, link.gbpsCapacity), 0);
    const minGbpsCapacityPctOfBest = 0.001; // Adjust as needed

    const filteredLinks = possibleLinks.filter((link) => link.gbpsCapacity >= bestGbpsCapacity * minGbpsCapacityPctOfBest);
    // console.log(filteredLinks);

    // Step 4: Sort the possible links by Gbps capacity descending (or distance ascending if preferred)
    filteredLinks.sort((a, b) => b.gbpsCapacity - a.gbpsCapacity);

    // Step 5: Assign links while respecting constraints
    const connectedEccentricSatellites = new Set();
    const connectedTargetSatellites = new Set();
    const maxConnectionsPerSatellite = this.simLinkBudget.maxLinksPerSatellite;
    // const maxConnectionsPerRing = {}; // { ringName: Set of connected satellite names }

    filteredLinks.forEach((link) => {
      const fromId = link.fromSatellite.name;
      const toId = link.toSatellite.name;
      const fromRing = link.fromSatellite.ringName;
      const toRing = link.toSatellite.ringName;

      // Initialize connection sets for rings if not present
      // if (!maxConnectionsPerRing[fromRing]) maxConnectionsPerRing[fromRing] = new Set();
      // if (!maxConnectionsPerRing[toRing]) maxConnectionsPerRing[toRing] = new Set();

      // Check if satellites have reached maximum links
      if (linkCounts[fromId] >= maxConnectionsPerSatellite || linkCounts[toId] >= maxConnectionsPerSatellite) {
        return;
      }

      // Check if satellites have already been connected in this step
      if (connectedEccentricSatellites.has(fromId) && connectedTargetSatellites.has(toId)) {
        return;
      }

      // // Check if the eccentric satellite has already connected to the target ring
      // if (maxConnectionsPerRing[fromRing].has(toRing)) {
      //   return;
      // }

      // Exclude links between satellites from the same eccentric ring
      if (eccentricRingNames.includes(fromRing) && eccentricRingNames.includes(toRing) && fromRing === toRing) {
        return;
      }

      // To avoid duplicate links, order the IDs lexicographically
      const [orderedFromId, orderedToId] = fromId < toId ? [fromId, toId] : [toId, fromId];

      // Check if the link already exists
      const linkExists = finalLinks.some((existingLink) => existingLink.fromId === orderedFromId && existingLink.toId === orderedToId);
      if (linkExists) return;

      // Add the link
      finalLinks.push({
        fromId: orderedFromId,
        toId: orderedToId,
        distanceAU: link.distanceAU,
        distanceKm: link.distanceKm,
        latencySeconds: link.latencySeconds,
        gbpsCapacity: link.gbpsCapacity,
      });

      // Increment link counts
      linkCounts[fromId]++;
      linkCounts[toId]++;

      // Mark satellites and rings as connected
      connectedEccentricSatellites.add(fromId);
      connectedTargetSatellites.add(toId);
      // maxConnectionsPerRing[fromRing].add(toRing);
    });
  }

  interCircularRings(rings, positions, linkCounts, finalLinks) {
    // Step 2: Add Links for Circular Rings Based on `a` and `vpo` (Excluding Mars and Earth Rings)
    // Identify circular rings (exclude 'ring_mars' and 'ring_earth')
    const circularRingNames2 = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));

    // Sort circular rings from furthest to closest based on 'a' (descending order)
    const sortedCircularRings = circularRingNames2.slice().sort((a, b) => {
      const aDistance = rings[a][0].a; // 'a' is the distance from the sun in AU
      const bDistance = rings[b][0].a;
      return aDistance - bDistance; // Descending order: furthest first
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

        const nearestRightSatellite = findNearestLower();
        const nearestLeftSatellite = findNearestHigher();
        const distanceAURight = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestRightSatellite.name]);
        const distanceAULeft = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestLeftSatellite.name]);
        const nearestSatellite =
          distanceAURight < distanceAULeft
            ? { satellite: nearestRightSatellite, distanceAU: distanceAURight }
            : { satellite: nearestLeftSatellite, distanceAU: distanceAULeft };

        let targetSatellites;
        if (this.simLinkBudget.maxLinksPerSatellite <= 4) targetSatellites = [nearestSatellite];
        else
          targetSatellites = [
            { satellite: nearestRightSatellite, distanceAU: distanceAURight },
            { satellite: nearestLeftSatellite, distanceAU: distanceAULeft },
          ];

        targetSatellites.forEach((targetSatellite) => {
          const toId = targetSatellite.satellite.name;
          const fromId = currentSatellite.name;

          // Check if both satellites can have more links
          if (
            linkCounts[fromId] >= this.simLinkBudget.maxLinksPerSatellite ||
            linkCounts[toId] >= this.simLinkBudget.maxLinksPerSatellite
          ) {
            return;
          }

          // Calculate the actual distance
          const distanceAU = targetSatellite.distanceAU;

          // Enforce maximum distance constraint
          if (distanceAU > this.simLinkBudget.maxDistanceAU) return;

          const distanceKm = distanceAU * this.AU_IN_KM;
          const gbpsCapacity = this.calculateGbps(distanceKm);
          // bestGbpsCapacity = Math.max(bestGbpsCapacity, gbpsCapacity);
          // if (gbpsCapacity < bestGbpsCapacity * minGbpsCapacityPctOfBest) return;
          const latencySeconds = this.calculateLatency(distanceKm);

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
  }

  marsEarthRings(rings, positions, linkCounts, finalLinks) {
    const binSizeAU = 0.3;
    const maxConnectionsPerTargetFromSameRing = 1;

    // Identify Mars and Earth rings and add planets to their respective rings
    const earthMarsRings = ["ring_earth", "ring_mars"].filter((ringName) => rings[ringName]);

    // Add Mars and Earth to their respective rings
    earthMarsRings.forEach((ringName) => {
      const planetName = ringName.split("_")[1].charAt(0).toUpperCase() + ringName.split("_")[1].slice(1);
      if (positions[planetName]) {
        rings[ringName].push({ name: planetName, position: positions[planetName] });
      }
    });
    // Precompute ring 'a' values for all rings
    const ringAValues = {};
    Object.keys(rings).forEach((ringName) => {
      ringAValues[ringName] = rings[ringName][0].a; // Assume all satellites in a ring have the same 'a'
    });

    // Spatial binning setup
    const matrix_coords = {};
    const getBinIndex = (coordinate) => Math.floor(coordinate / binSizeAU);

    // Populate the spatial matrix with all satellites
    Object.values(rings)
      .flat()
      .forEach((satellite) => {
        const { x, y } = positions[satellite.name];
        const binX = getBinIndex(x);
        const binY = getBinIndex(y);

        if (!matrix_coords[binX]) {
          matrix_coords[binX] = {};
        }
        if (!matrix_coords[binX][binY]) {
          matrix_coords[binX][binY] = [];
        }

        matrix_coords[binX][binY].push(satellite);
      });

    // Track connections for target satellites
    const targetRingConnectionCounts = {}; // { targetSat.name: count }

    Object.values(rings)
      .flat()
      .forEach((satellite) => {
        targetRingConnectionCounts[satellite.name] = 0;
      });

    // Collect potential links for Earth and Mars rings
    let potentialLinks = [];

    earthMarsRings.forEach((targetRingName) => {
      const targetSatellites = rings[targetRingName];
      const excludedRing = targetRingName; // Prevent connecting to the same ring

      // For each satellite in the Mars or Earth ring
      targetSatellites.forEach((satellite) => {
        const satellitePosition = positions[satellite.name];
        const binX = getBinIndex(satellitePosition.x);
        const binY = getBinIndex(satellitePosition.y);

        let nearestSatellite = null;
        let nearestDistanceAU = Infinity;

        // Explore nearby bins for potential connections
        const nearbyBins = [
          [binX - 1, binY - 1],
          [binX - 1, binY],
          [binX - 1, binY + 1],
          [binX, binY - 1],
          [binX, binY],
          [binX, binY + 1],
          [binX + 1, binY - 1],
          [binX + 1, binY],
          [binX + 1, binY + 1],
        ];

        nearbyBins.forEach(([bx, by]) => {
          if (matrix_coords[bx] && matrix_coords[bx][by]) {
            const binSatellites = matrix_coords[bx][by];

            binSatellites.forEach((targetSat) => {
              const targetRing = Object.keys(rings).find((ringName) => rings[ringName].includes(targetSat));

              if (!targetRing || targetRing === excludedRing) {
                return; // Skip if invalid ring or excluded ring
              }

              // Check if the target satellite already has too many connections
              if (targetRingConnectionCounts[targetSat.name] >= maxConnectionsPerTargetFromSameRing) {
                return;
              }

              const distanceAU = this.calculateDistanceAU(positions[satellite.name], positions[targetSat.name]);
              if (distanceAU > this.simLinkBudget.maxDistanceAU) return; // Skip if distance exceeds max

              // Track the nearest satellite
              if (distanceAU < nearestDistanceAU) {
                nearestSatellite = targetSat;
                nearestDistanceAU = distanceAU;
              }
            });
          }
        });

        if (nearestSatellite) {
          const distanceKm = nearestDistanceAU * this.AU_IN_KM;
          const gbpsCapacity = this.calculateGbps(distanceKm);
          const latencySeconds = this.calculateLatency(distanceKm);

          // Order IDs lexicographically to avoid duplicates
          const [orderedFromId, orderedToId] =
            satellite.name < nearestSatellite.name ? [satellite.name, nearestSatellite.name] : [nearestSatellite.name, satellite.name];

          potentialLinks.push({
            fromId: orderedFromId,
            toId: orderedToId,
            distanceAU: nearestDistanceAU,
            distanceKm,
            latencySeconds,
            gbpsCapacity,
          });

          // Increment connection count for the target satellite
          targetRingConnectionCounts[nearestSatellite.name]++;
        }
      });
    });

    // Sort potential links by distance (ascending)
    potentialLinks.sort((a, b) => a.distanceAU - b.distanceAU);

    // Assign links while respecting constraints
    potentialLinks.forEach((link) => {
      const { fromId, toId } = link;

      // Initialize link counts if not present
      if (!(fromId in linkCounts)) linkCounts[fromId] = 0;
      if (!(toId in linkCounts)) linkCounts[toId] = 0;

      // Check if satellites can have more links
      if (linkCounts[fromId] >= this.simLinkBudget.maxLinksPerSatellite || linkCounts[toId] >= this.simLinkBudget.maxLinksPerSatellite) {
        return;
      }

      // Add the link to finalLinks
      finalLinks.push(link);

      // Increment link counts
      linkCounts[fromId]++;
      linkCounts[toId]++;
    });
  }

  connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks) {
    // Step 1: Identify eccentric rings and circular rings
    const eccentricRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_ecce"));
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));

    // Step 2: Build a spatial matrix for satellites in circular rings
    const BIN_SIZE_AU = 0.1; // Adjust bin size as appropriate
    const matrix_coords = {};
    const getBinIndex = (coord) => Math.floor(coord / BIN_SIZE_AU);

    // Populate the spatial matrix with satellites from circular rings
    circularRingNames.forEach((ringName) => {
      rings[ringName].forEach((satellite) => {
        const { x, y } = positions[satellite.name];
        const binX = getBinIndex(x);
        const binY = getBinIndex(y);
        if (!matrix_coords[binX]) matrix_coords[binX] = {};
        if (!matrix_coords[binX][binY]) matrix_coords[binX][binY] = [];
        matrix_coords[binX][binY].push(satellite);
      });
    });

    // Step 3: Collect possible links from eccentric satellites to nearby circular satellites
    const possibleLinks = [];

    // For each satellite in eccentric rings
    eccentricRingNames.forEach((ecceRingName) => {
      const eccSatellites = rings[ecceRingName];
      eccSatellites.forEach((eccSatellite) => {
        const { x, y } = positions[eccSatellite.name];
        const binX = getBinIndex(x);
        const binY = getBinIndex(y);

        // Collect satellites from the 9 surrounding bins
        const nearbySatellites = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const currentBinX = binX + dx;
            const currentBinY = binY + dy;
            if (matrix_coords[currentBinX] && matrix_coords[currentBinX][currentBinY]) {
              matrix_coords[currentBinX][currentBinY].forEach((sat) => {
                nearbySatellites.push(sat);
              });
            }
          }
        }

        // For each nearby satellite, create a potential link
        nearbySatellites.forEach((circSatellite) => {
          // Exclude the satellite itself
          if (circSatellite.name === eccSatellite.name) return;

          const distanceAU = this.calculateDistanceAU(positions[eccSatellite.name], positions[circSatellite.name]);
          // Enforce maximum distance constraint
          if (distanceAU > this.simLinkBudget.maxDistanceAU) return;

          const distanceKm = distanceAU * this.AU_IN_KM;
          const gbpsCapacity = this.calculateGbps(distanceKm);
          const latencySeconds = this.calculateLatency(distanceKm);

          // Create a link object
          possibleLinks.push({
            fromSatellite: eccSatellite,
            toSatellite: circSatellite,
            distanceAU,
            distanceKm,
            gbpsCapacity,
            latencySeconds,
          });
        });
      });
    });

    // Step 4: Filter the possibleLinks to retain only those with sufficient capacity
    // Determine the best Gbps capacity from the possibleLinks
    const bestGbpsCapacity = possibleLinks.reduce((max, link) => Math.max(max, link.gbpsCapacity), 0);
    // Define the minimum Gbps capacity percentage (e.g., 1%)
    const minGbpsCapacityPctOfBest = 0.1; // Adjust as needed
    // Filter the possibleLinks
    const filteredLinks = possibleLinks.filter((link) => link.gbpsCapacity >= bestGbpsCapacity * minGbpsCapacityPctOfBest);

    // Step 5: Sort the possible links by Gbps capacity descending
    filteredLinks.sort((a, b) => b.gbpsCapacity - a.gbpsCapacity);

    // Step 6: Connect the satellites, one such link per satellite, respecting constraints
    const connectedEccentricSatellites = new Set();
    const connectedCircularSatellites = new Set();

    filteredLinks.forEach((link) => {
      const fromId = link.fromSatellite.name;
      const toId = link.toSatellite.name;

      // Check if either satellite has already been connected in this step
      if (connectedEccentricSatellites.has(fromId) || connectedCircularSatellites.has(toId)) {
        return; // Skip this link
      }

      // Check if the satellites have not exceeded their max links
      if (linkCounts[fromId] >= this.simLinkBudget.maxLinksPerSatellite || linkCounts[toId] >= this.simLinkBudget.maxLinksPerSatellite) {
        return; // Skip this link
      }

      // To avoid duplicate links, order the IDs lexicographically
      const [orderedFromId, orderedToId] = fromId < toId ? [fromId, toId] : [toId, fromId];

      // Check if the link already exists
      const linkExists = finalLinks.some((existingLink) => existingLink.fromId === orderedFromId && existingLink.toId === orderedToId);
      if (linkExists) return;

      // Add the link
      finalLinks.push({
        fromId: orderedFromId,
        toId: orderedToId,
        distanceAU: link.distanceAU,
        distanceKm: link.distanceKm,
        latencySeconds: link.latencySeconds,
        gbpsCapacity: link.gbpsCapacity,
      });

      // Increment link counts
      linkCounts[fromId]++;
      linkCounts[toId]++;

      // Mark satellites as connected
      connectedEccentricSatellites.add(fromId);
      connectedCircularSatellites.add(toId);
    });
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
    const perfStart = performance.now();

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

    // console.log("Graph Construction Complete:", graph);

    // Implement the Edmonds-Karp Algorithm
    const source = nodeIds.get("Earth");
    const sink = nodeIds.get("Mars");

    const maxFlowResult = this.edmondsKarp(graph, capacities, source, sink, perfStart);
    if (maxFlowResult === null) return { links: [], maxFlowGbps: 0, error: "timed out" };

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
    return {
      links: outputLinks,
      maxFlowGbps: maxFlowResult.maxFlow,
      graph, // Adjacency list
      capacities, // Edge capacities
      flows, // Flow per edge
      nodeIds, // Map of node names to IDs
      positions, // Node positions
      error: null,
    };
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
  edmondsKarp(graph, capacities, source, sink, perfStart) {
    const flows = {}; // Edge flows
    let maxFlow = 0;

    while (true) {
      if (performance.now() - perfStart > this.simLinkBudget.calctimeMs) return null;
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

  /**
   * Calculates latencies for the network flows and aggregates the gbps per latency bin.
   *
   * @param {Object} networkData - The object returned by getNetworkData containing graph, flows, etc.
   * @param {Number} binSize - The size of each latency bin in seconds.
   * @returns {Object} - An object containing the latency histogram, best latency, and average latency.
   */
  calculateLatencies(networkData, binSize = 60) {
    const { graph, flows, nodeIds, capacities } = networkData;
    const inverseNodeIds = new Map();
    if (nodeIds === undefined) return null;
    nodeIds.forEach((id, name) => inverseNodeIds.set(id, name));

    const source = nodeIds.get("Earth");
    const sink = nodeIds.get("Mars");

    // Initialize variables for statistics
    const paths = [];
    let totalFlowLatencyProduct = 0;
    let totalFlow = 0;
    let minLatency = Infinity;

    // Helper Function to Find a Path with Positive Flow
    const findPathWithFlow = () => {
      const parent = new Array(Object.keys(graph).length).fill(-1);
      const queue = [];
      queue.push(source);
      while (queue.length > 0) {
        const current = queue.shift();
        for (const neighbor of graph[current]) {
          const edgeKey = `${current}_${neighbor}`;
          if (flows[edgeKey] > 0 && parent[neighbor] === -1 && neighbor !== source) {
            parent[neighbor] = current;
            queue.push(neighbor);
            if (neighbor === sink) break;
          }
        }
      }

      if (parent[sink] === -1) return null; // No path found

      // Reconstruct Path
      const path = [];
      let node = sink;
      while (node !== source) {
        const prev = parent[node];
        path.unshift({ from: prev, to: node });
        node = prev;
      }
      return path;
    };

    while (true) {
      const path = findPathWithFlow();
      if (!path) break;

      // Find minimum flow along the path
      let minFlow = Infinity;
      for (const edge of path) {
        const edgeKey = `${edge.from}_${edge.to}`;
        if (flows[edgeKey] < minFlow) {
          minFlow = flows[edgeKey];
        }
      }

      // Calculate total latency for the path
      let totalLatency = 0;
      for (const edge of path) {
        const fromName = inverseNodeIds.get(edge.from);
        const toName = inverseNodeIds.get(edge.to);
        // Retrieve the link's latency
        const link = networkData.links.find(
          (l) => (l.fromId === fromName && l.toId === toName) || (l.fromId === toName && l.toId === fromName)
        );
        if (link) {
          totalLatency += link.latencySeconds;
        } else {
          console.warn(`Link not found between ${fromName} and ${toName}`);
        }
      }

      // Update statistics
      totalFlowLatencyProduct += minFlow * totalLatency;
      totalFlow += minFlow;
      if (totalLatency < minLatency) {
        minLatency = totalLatency;
      }

      paths.push({ path, flow: minFlow, latency: totalLatency });

      // Subtract the flow from the edges
      for (const edge of path) {
        const edgeKey = `${edge.from}_${edge.to}`;
        flows[edgeKey] -= minFlow;
        const reverseEdgeKey = `${edge.to}_${edge.from}`;
        flows[reverseEdgeKey] += minFlow; // Update reverse flow
      }
    }

    // Aggregate flows into latency bins
    const latencyBins = {};
    paths.forEach(({ flow, latency }) => {
      const bin = Math.floor(latency / binSize) * binSize;
      if (!latencyBins[bin]) {
        latencyBins[bin] = 0;
      }
      latencyBins[bin] += flow;
    });

    // Convert latencyBins to sorted array
    const sortedBins = Object.keys(latencyBins)
      .map(Number)
      .sort((a, b) => a - b)
      .map((bin) => ({
        latency: bin, // in seconds
        totalGbps: Math.round(latencyBins[bin] * 1e6) / 1e6, // Round to 6 decimal places
      }));

    const averageLatency = totalFlow > 0 ? totalFlowLatencyProduct / totalFlow : 0;

    return {
      histogram: sortedBins,
      bestLatency: minLatency,
      averageLatency: averageLatency,
    };
  }
}
