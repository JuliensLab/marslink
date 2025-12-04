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
    const maxLinksPerSatellite = this.simLinkBudget.getMaxLinksPerSatellite();
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

    this.marsEarthRings(rings, positions, linkCounts, finalLinks);
    // this.interCircularRings(rings, positions, linkCounts, finalLinks);
    // this.interEccentricRings(rings, positions, linkCounts, finalLinks);
    // this.connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks);

    // const isOdd = maxLinksPerSatellite % 2 === 1;
    // if (isOdd) {
    //   this.marsEarthRings(rings, positions, linkCounts, finalLinks, true);
    //   this.interCircularRings(rings, positions, linkCounts, finalLinks, true);
    //   this.interEccentricRings(rings, positions, linkCounts, finalLinks, true);
    //   this.connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks, true);
    // }

    return finalLinks;
  }

  intraRing(rings, positions, linkCounts, finalLinks) {
    // Create neighbor links for all rings (including Mars and Earth)

    // Initialize a Set for existing links for O(1) lookup
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));

    // Precompute AU to KM conversion if not already done
    const AU_IN_KM = this.AU_IN_KM; // Assuming this is a constant

    // Iterate through each ring
    for (const [ringName, ringSatellites] of Object.entries(rings)) {
      for (const satellite of ringSatellites) {
        // Early termination if satellite has reached max links
        if (linkCounts[satellite.name] >= this.simLinkBudget.getMaxLinksPerRing(satellite.ringName)) {
          continue;
        }

        for (const neighborName of satellite.neighbors) {
          // Ensure neighbor exists
          if (!positions[neighborName]) continue;

          // Early termination if neighbor has reached max links
          if (linkCounts[neighborName] >= this.simLinkBudget.getMaxLinksPerRing(satellite.ringName)) {
            continue;
          }

          // Order the IDs lexicographically to avoid duplicate links
          const [fromId, toId] = satellite.name < neighborName ? [satellite.name, neighborName] : [neighborName, satellite.name];

          const linkKey = `${fromId}-${toId}`;

          // Check if the link already exists using the Set
          if (existingLinks.has(linkKey)) continue;

          // Calculate distances and other metrics
          const distanceAU = this.calculateDistanceAU(positions[satellite.name], positions[neighborName]);

          // Enforce maximum distance constraint
          if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = this.calculateGbps(distanceKm);
          const latencySeconds = this.calculateLatency(distanceKm);

          // Add the link to finalLinks
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

          // Add the new link to the Set to avoid future duplicates
          existingLinks.add(linkKey);

          // Early termination if satellite has reached max links after adding
          if (linkCounts[satellite.name] >= this.simLinkBudget.getMaxLinksPerRing(satellite.ringName)) {
            break; // Exit the neighbors loop for this satellite
          }
        }
      }
    }
  }

  interEccentricRings(rings, positions, linkCounts, finalLinks, skipInvert = false) {
    const maxLinksPerSatellite = this.simLinkBudget.maxLinksPerSatellite;
    const isOdd = maxLinksPerSatellite % 2 === 1;
    // Step 1: Identify valid rings (eccentric and circular rings)
    const eccentricRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_ecce"));
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));
    const validRingNames = new Set([...eccentricRingNames, ...circularRingNames]);

    // Step 2: Initialize a Set for existing links for O(1) lookup
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));

    // Precompute AU to KM conversion if not already done
    const AU_IN_KM = this.AU_IN_KM; // Assuming this is a constant

    // Step 3: Collect all possible link options between eccentric satellites and satellites in valid rings
    const possibleLinks = [];

    // Precompute a Set for eccentric ring names for faster lookup
    const eccentricRingSet = new Set(eccentricRingNames);

    for (const eccentricRingName of eccentricRingNames) {
      const eccSatellites = rings[eccentricRingName];
      const sortedEccSatellites = eccSatellites.slice().sort((a, b) => (a.position.vpo || 0) - (b.position.vpo || 0));
      for (let i = 0; i < sortedEccSatellites.length; i++) {
        const skipCondition = isOdd && (skipInvert ? i % 2 === 0 : i % 2 === 1);
        if (skipCondition) continue;
        const eccSatellite = sortedEccSatellites[i];

        // Iterate through all valid rings
        for (const targetRingName of validRingNames) {
          // Exclude if both satellites are in the same eccentric ring
          if (eccentricRingSet.has(eccentricRingName) && eccentricRingSet.has(targetRingName) && eccentricRingName === targetRingName) {
            continue;
          }

          const targetSatellites = rings[targetRingName];

          for (const targetSatellite of targetSatellites) {
            // Exclude the same satellite
            if (eccSatellite.name === targetSatellite.name) continue;

            // Calculate distanceAU
            const distanceAU = this.calculateDistanceAU(positions[eccSatellite.name], positions[targetSatellite.name]);

            // Enforce maximum distance constraint
            if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;

            const distanceKm = distanceAU * AU_IN_KM;
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
          }
        }
      }
    }

    // Step 4: Filter the possibleLinks to retain only those with sufficient capacity
    if (possibleLinks.length === 0) return; // Early exit if no possible links

    let bestGbpsCapacity = 0;
    for (const link of possibleLinks) {
      if (link.gbpsCapacity > bestGbpsCapacity) {
        bestGbpsCapacity = link.gbpsCapacity;
      }
    }

    const minGbpsCapacityPctOfBest = 0.001; // Adjust as needed
    const capacityThreshold = bestGbpsCapacity * minGbpsCapacityPctOfBest;

    // Instead of filtering, we can filter while iterating to save memory
    // However, since we need to sort, we'll keep the filtered list
    const filteredLinks = [];
    for (const link of possibleLinks) {
      if (link.gbpsCapacity >= capacityThreshold) {
        filteredLinks.push(link);
      }
    }

    // Step 5: Sort the possible links by Gbps capacity descending (or distance ascending if preferred)
    filteredLinks.sort((a, b) => b.gbpsCapacity - a.gbpsCapacity);

    // Step 6: Assign links while respecting constraints
    for (const link of filteredLinks) {
      const fromId = link.fromSatellite.name;
      const toId = link.toSatellite.name;
      const fromRing = link.fromSatellite.ringName;
      const toRing = link.toSatellite.ringName;

      // Check if satellites have reached maximum links
      if (
        linkCounts[fromId] >= this.simLinkBudget.getMaxLinksPerRing(fromRing) ||
        linkCounts[toId] >= this.simLinkBudget.getMaxLinksPerRing(toRing)
      ) {
        continue;
      }

      // Exclude links between satellites from the same eccentric ring
      if (eccentricRingSet.has(fromRing) && eccentricRingSet.has(toRing) && fromRing === toRing) {
        continue;
      }

      // To avoid duplicate links, order the IDs lexicographically
      const [orderedFromId, orderedToId] = fromId < toId ? [fromId, toId] : [toId, fromId];

      const linkKey = `${orderedFromId}-${orderedToId}`;

      // Check if the link already exists using the Set
      if (existingLinks.has(linkKey)) continue;

      // Add the link to finalLinks
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

      // Add the new link to the Set to avoid future duplicates
      existingLinks.add(linkKey);

      // Optional: Early termination if desired
      // If there's a limit on the number of links to assign, implement it here
    }
  }

  /**
   * Finds the indices of the nearest lower and higher VPO satellites relative to a given VPO.
   * @param {number[]} sortedVpoList - A sorted array of VPO values in ascending order.
   * @param {number} targetVpo - The VPO value to find neighbors for.
   * @returns {Object} An object containing the indices of the nearest lower and higher satellites.
   */
  findNearestVpoIndices(sortedVpoList, targetVpo) {
    let left = 0;
    let right = sortedVpoList.length - 1;
    let mid;
    let lower = sortedVpoList.length - 1; // Default to the last index (wrap-around)
    let higher = 0; // Default to the first index (wrap-around)

    while (left <= right) {
      mid = Math.floor((left + right) / 2);
      if (sortedVpoList[mid] <= targetVpo) {
        lower = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    // The higher index is the next one after lower, with wrap-around
    higher = (lower + 1) % sortedVpoList.length;

    return { lower, higher };
  }

  interCircularRings(rings, positions, linkCounts, finalLinks, skipInvert = false) {
    const maxLinksPerSatellite = this.simLinkBudget.maxLinksPerSatellite;
    const isOdd = maxLinksPerSatellite % 2 === 1;

    // Identify circular rings (exclude 'ring_mars' and 'ring_earth')
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));

    // Sort circular rings from furthest to closest based on 'a' (ascending order)
    const sortedCircularRings = circularRingNames.slice().sort((a, b) => {
      const aDistance = rings[a][0].a; // 'a' is the distance from the sun in AU
      const bDistance = rings[b][0].a;
      return aDistance - bDistance; // Ascending order: nearest first
    });

    // Initialize a Set for existing links for O(1) lookup
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));

    // Precompute AU to KM conversion
    const AU_IN_KM = this.AU_IN_KM;

    // Iterate through each circular ring and link to the next inner ring
    for (let i = 0; i < sortedCircularRings.length - 1; i++) {
      const currentRingName = sortedCircularRings[i];
      const nextRingName = sortedCircularRings[i + 1];
      const currentRingSatellites = rings[currentRingName];
      const nextRingSatellites = rings[nextRingName];

      // Sort satellites by VPO for efficient searching
      const sortedNextRingSatellites = nextRingSatellites.slice().sort((a, b) => a.position.vpo - b.position.vpo);
      const sortedVpoList = sortedNextRingSatellites.map((sat) => sat.position.vpo);
      const sortedCurrentRingSatellites = currentRingSatellites.slice().sort((a, b) => a.position.vpo - b.position.vpo);

      let nextIndex = 0;
      const nextLength = sortedVpoList.length;
      let lastConnectedIndex = -2; // Track the index of the last connected satellite in the current ring

      for (let j = 0; j < sortedCurrentRingSatellites.length; j++) {
        // Determine if we should attempt a connection
        const shouldAttemptConnection = !isOdd || j - lastConnectedIndex > 1;

        if (!shouldAttemptConnection) continue;

        const currentSatellite = sortedCurrentRingSatellites[j];
        const currentVpo = currentSatellite.position.vpo % 360; // Ensure vpo is within [0, 360)

        // Sweep to find the nearest higher VPO satellite
        while (nextIndex < nextLength && sortedVpoList[nextIndex] < currentVpo) {
          nextIndex++;
        }

        // Determine nearest lower and higher satellites with wrap-around
        const nearestHigher = sortedNextRingSatellites[nextIndex % nextLength];
        const nearestLower = sortedNextRingSatellites[(nextIndex - 1 + nextLength) % nextLength];

        // Calculate distances
        const distanceAULower = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestLower.name]);
        const distanceAUHigher = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestHigher.name]);

        // Collect candidates, sorted by distance
        const candidates = [
          { satellite: nearestLower, distanceAU: distanceAULower },
          { satellite: nearestHigher, distanceAU: distanceAUHigher },
        ].sort((a, b) => a.distanceAU - b.distanceAU);

        let connected = false;
        for (const targetSatellite of candidates) {
          const toId = targetSatellite.satellite.name;
          const fromId = currentSatellite.name;

          // Check if both satellites can have more links
          if (
            linkCounts[fromId] >= this.simLinkBudget.getMaxLinksPerRing(currentSatellite.ringName) ||
            linkCounts[toId] >= this.simLinkBudget.getMaxLinksPerRing(targetSatellite.satellite.ringName)
          ) {
            continue; // Try the next candidate
          }

          // Enforce maximum distance constraint
          const distanceAU = targetSatellite.distanceAU;
          if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = this.calculateGbps(distanceKm);
          const latencySeconds = this.calculateLatency(distanceKm);

          // Order the IDs lexicographically to avoid duplicate links
          const [orderedFromId, orderedToId] = fromId < toId ? [fromId, toId] : [toId, fromId];
          const linkKey = `${orderedFromId}-${orderedToId}`;

          // Check if the link already exists
          if (existingLinks.has(linkKey)) continue;

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

          // Add the new link to the Set
          existingLinks.add(linkKey);

          // Mark this satellite as connected
          lastConnectedIndex = j;
          connected = true;
          break; // Stop after connecting to one target
        }

        // If no connection was made and we're in the second pass (skipInvert=true),
        // consider switching to the opposite set of satellites in the next iteration
        if (isOdd && !connected && skipInvert && j < sortedCurrentRingSatellites.length - 1) {
          // Force the next satellite to be considered regardless of the skip pattern
          lastConnectedIndex = j - 1; // Allow the next satellite to attempt a connection
        }
      }
    }
  }

  marsEarthRings(rings, positions, linkCounts, finalLinks, skipInvert = false) {
    const maxLinksPerSatellite = this.simLinkBudget.maxLinksPerSatellite;
    const isOdd = maxLinksPerSatellite % 2 === 1;
    const binSizeAU = 0.3;
    const maxConnectionsPerPlanetarySatellite = 3; // Maximum of 2 links per satellite in planetary rings

    // Identify Mars and Earth rings and add planets to their respective rings
    const earthMarsRings = ["ring_earth", "ring_mars"].filter((ringName) => rings[ringName]);

    // Add Mars and Earth to their respective rings
    earthMarsRings.forEach((ringName) => {
      const planetName = ringName.split("_")[1].charAt(0).toUpperCase() + ringName.split("_")[1].slice(1);
      if (positions[planetName]) {
        rings[ringName].push({ name: planetName, position: positions[planetName], a: 0 }); // Assuming 'a' is 0 for planets
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
      const sortedTargetSatellites = targetSatellites.slice().sort((a, b) => (a.position.vpo || 0) - (b.position.vpo || 0));
      const excludedRing = targetRingName; // Prevent connecting to the same ring

      // For each satellite in the Mars or Earth ring
      for (let i = 0; i < sortedTargetSatellites.length; i++) {
        const skipCondition = isOdd && (skipInvert ? i % 2 === 0 : i % 2 === 1);
        if (skipCondition) continue;
        const satellite = sortedTargetSatellites[i];
        const satellitePosition = positions[satellite.name];
        const binX = getBinIndex(satellitePosition.x);
        const binY = getBinIndex(satellitePosition.y);

        let possibleTargets = [];

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

              const distanceAU = this.calculateDistanceAU(positions[satellite.name], positions[targetSat.name]);
              if (distanceAU > this.simLinkBudget.maxDistanceAU) return; // Skip if distance exceeds max

              possibleTargets.push({ satellite: targetSat, distanceAU });
            });
          }
        });

        if (possibleTargets.length > 0) {
          possibleTargets.sort((a, b) => a.distanceAU - b.distanceAU);
          const topCount = 2;
          for (let k = 0; k < Math.min(topCount, possibleTargets.length); k++) {
            const target = possibleTargets[k];
            const distanceAU = target.distanceAU;
            const distanceKm = distanceAU * this.AU_IN_KM;
            const gbpsCapacity = this.calculateGbps(distanceKm);
            const latencySeconds = this.calculateLatency(distanceKm);

            // Order IDs lexicographically to avoid duplicates
            const [orderedFromId, orderedToId] =
              satellite.name < target.satellite.name ? [satellite.name, target.satellite.name] : [target.satellite.name, satellite.name];

            potentialLinks.push({
              fromId: orderedFromId,
              toId: orderedToId,
              distanceAU,
              distanceKm,
              latencySeconds,
              gbpsCapacity,
            });
          }
        }
      }
    });

    // **New Implementation Starts Here**

    // **Step 1: List All Potential Link Options**
    // The potentialLinks array already contains all possible links between Mars/Earth rings and other rings.

    // **Step 2: Sort Links by Highest Gbps Capacity (Descending Order)**
    potentialLinks.sort((a, b) => b.gbpsCapacity - a.gbpsCapacity);

    // **Step 3: Assign Links with Constraints**
    // - Each satellite in planetary rings (Mars and Earth rings) can have a maximum of 2 links.
    // - Satellites in other rings respect the simLinkBudget.maxLinksPerSatellite.

    // Initialize a Set for existing links for O(1) lookup
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));

    potentialLinks.forEach((link) => {
      const { fromId, toId, distanceAU, distanceKm, latencySeconds, gbpsCapacity } = link;

      // Check if the link already exists
      const linkKey = `${fromId}-${toId}`;
      if (existingLinks.has(linkKey)) return;

      // Check if 'fromId' is part of planetary rings and has reached its maximum of 2 links
      const isFromPlanetaryRing = earthMarsRings.includes(
        Object.keys(rings).find((ringName) => rings[ringName].some((sat) => sat.name === fromId))
      );

      if (isFromPlanetaryRing && linkCounts[fromId] >= maxConnectionsPerPlanetarySatellite) {
        return; // Skip if 'fromId' has reached its max links
      }

      // Check if 'toId' has reached its maximum links as per simLinkBudget // marsEarthRings
      if (linkCounts[toId] >= this.simLinkBudget.getMaxLinksPerRing(ringName)) {
        return; // Skip if 'toId' has reached its max links
      }
      // Check if 'fromId' has reached its maximum links as per simLinkBudget // marsEarthRings
      if (linkCounts[fromId] >= this.simLinkBudget.getMaxLinksPerRing(ringName)) {
        return; // Skip if 'fromId' has reached its max links
      }

      // Assign the link
      finalLinks.push({
        fromId,
        toId,
        distanceAU,
        distanceKm,
        latencySeconds,
        gbpsCapacity,
      });

      // Increment link counts
      linkCounts[fromId]++;
      linkCounts[toId]++;

      // Add the new link to the Set to avoid future duplicates
      existingLinks.add(linkKey);
    });

    // **New Implementation Ends Here**

    // Optionally, log the number of potential links and assigned links
    // console.log(`Potential Links: ${potentialLinks.length}`);
    // console.log(`Assigned Links: ${finalLinks.length}`);
  }

  connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks, skipInvert = false) {
    const maxLinksPerSatellite = this.simLinkBudget.maxLinksPerSatellite;
    const isOdd = maxLinksPerSatellite % 2 === 1;
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
      const sortedEccSatellites = eccSatellites.slice().sort((a, b) => (a.position.vpo || 0) - (b.position.vpo || 0));
      for (let i = 0; i < sortedEccSatellites.length; i++) {
        const skipCondition = isOdd && (skipInvert ? i % 2 === 0 : i % 2 === 1);
        if (skipCondition) continue;
        const eccSatellite = sortedEccSatellites[i];
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
      }
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
  getNetworkData(planets, satellites, finalLinks, calctimeMs) {
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

    const maxFlowResult = this.edmondsKarp(graph, capacities, source, sink, perfStart, calctimeMs);
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
  edmondsKarp(graph, capacities, source, sink, perfStart, calctimeMs) {
    const flows = {}; // Edge flows
    let maxFlow = 0;

    while (true) {
      if (performance.now() - perfStart > calctimeMs) return null;
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
  calculateLatencies(networkData, binSize = 60 * 5) {
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
