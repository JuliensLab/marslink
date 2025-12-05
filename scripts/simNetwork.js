// simNetwork.js

import { SIM_CONSTANTS } from "./simConstants.js";

/*
We need to rework this. We start over.

Start with creating a function that checks if a satellite is between sun and earth orbit (SEO), between earth and mars orbits (EMO) or beyond Mars orbit (BMO).

Create links between satellites of the same ring (one on either side), only if the number of laser terminals on the ring is > 2.

Next, go through Earth ring satellites, and mark them all as out facing. Next, go through each Mars ring satellite, and mark them all as sun facing.
Next, if the circular rings have exactly 3 laser terminals per satellite, then go through each cicular ring, go through each satellite, and mark every other as sun facing (the others as out facing).
If circular rings have 2 or 4+ laser terminals per satellite, then mark all as out facing and sun facing (two ports dedicated to that, one for out facing and one for sun facing).
We're assigning ports to satellites and keeping track of direction facing and used or not.
Going through circular rings, we mark all satellites that are SEO or BMO as unused (for now at least).

Then, we take the first circular ring (nearest to the sun). For each satellite, we check if it has unused sun facing ports. If so, we find the nearest satellite in the earth ring and mark the solar angle range that is covered.
The solar angle range is: we look at the preceeding and following satellites in the same ring (which have sun facing ports, might be N+1 or N+2 (if 3 ports). If the N-1 (or N-2) sat has a solar angle of 30 and the N+1 (or N+2) sat has a solar angle of 50, 
then the solar angle range covered by our satellite is 35 to 45 (midpoint between neighbors). 
We mark this range as covered. We connect this satellite to the nearest earth ring satellite (may use solar angle to find it quickly, keep in mind its modulo 360).
Any uncovered solar angle range after exhausting all satellites of the first circular ring requires to move to the next circular ring. Once all solar angle ranges are covered 
(be careful about the value precision, we don't want 45.001 to be uncovered because of rounding errors), we move to the next step.
After we achieve this part, we should have the earth ring connected to the sun facing satellites of the nearest out satellites.

We do the same for Mars but in reverse. We start with the furthest circular ring from the sun, and connect its out facing satellites to Mars ring satellites.
In all these steps, we ensure an out-facing port connects to a sun-facing port.

Finally, we need to connect circular rings together. We take the ring that has the least number of satellites, and connect it to the nearest ring, using solar angle to find the nearest satellite in the next ring.
We keep going until all circular rings are connected. We don't need to connect SEO or BMO satellites (but we still want to have their intra-ring connections if more than 2 ports).



*/

export class SimNetwork {
  constructor(simLinkBudget, simSatellites) {
    this.AU_IN_KM = SIM_CONSTANTS.AU_IN_KM; // 1 AU in kilometers
    this.SPEED_OF_LIGHT_KM_S = SIM_CONSTANTS.SPEED_OF_LIGHT_KM_S; // Speed of light in km/s
    this.simLinkBudget = simLinkBudget;
    this.simSatellites = simSatellites;
  }

  // Helper: counts how many crossing points are to the left (CCW) of the current angle
  countCrossingsLeftOf(angle, crossingList) {
    if (crossingList.length === 0) return 0;
    let count = 0;
    for (const c of crossingList) {
      const cn = ((c % 360) + 360) % 360;
      if (cn < angle || cn + 360 < angle) count++;
    }
    return count;
  }

  // Get radial zone for a satellite
  getRadialZone(satellite, ringName) {
    if (!this.simSatellites.ringCrossings.has(ringName)) return "ALLOWED";
    const crossings = this.simSatellites.ringCrossings.get(ringName);
    if (!crossings) return "ALLOWED";

    // If there are no Earth or Mars crossings (no Earth/Mars rings), allow all
    if ((!crossings.earth || crossings.earth.crossings.length === 0) && (!crossings.mars || crossings.mars.crossings.length === 0)) {
      return "ALLOWED";
    }

    const solarAngle = satellite.position.solarAngle;
    const angle = ((solarAngle % 360) + 360) % 360;

    const outsideEarth =
      crossings.earth && crossings.earth.crossings.length > 0
        ? this.countCrossingsLeftOf(angle, crossings.earth.crossings) % 2 === 1
        : false;
    const outsideMars =
      crossings.mars && crossings.mars.crossings.length > 0 ? this.countCrossingsLeftOf(angle, crossings.mars.crossings) % 2 === 1 : false;

    if (!outsideEarth) return "INSIDE_EARTH";
    if (outsideEarth && !outsideMars) return "BETWEEN_EARTH_AND_MARS";
    if (outsideMars) return "OUTSIDE_MARS";

    return "UNKNOWN";
  }

  // Function to calculate Euclidean distance in 2D AU between two satellites
  calculateDistance2DAU = (pos1, pos2) => {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Function to calculate Euclidean distance in 3D AU between two satellites
  calculateDistance3DAU = (pos1, pos2) => {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    const dz = pos1.z - pos2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  // Function to determin if a satellite is inside or outside an orbit (inside meaning inside the circle of the orbit, so between the orbit and the sun).
  // For eccentric orbits, use precomputed crossing points for accurate radial zone detection.
  calculateIfInsideOrbitRing = (satellite, ringOrbitalElements) => {
    // Use the general radial zone detection
    return this.getRadialZone(satellite, satellite.ringName);
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

  calculateDistanceToSunAU = (position) => {
    return Math.sqrt(Math.pow(position.x, 2) + Math.pow(position.y, 2) + Math.pow(position.z, 2));
  };

  /**
   * Generates all possible links between planets and satellites.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @param {Array|Object} ringsOrbitalElements - Array of orbital elements objects for each ring, or object with planet names as keys.
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
  getPossibleLinks(planets, satellites) {
    console.log(satellites);
    // Group satellites by ringName
    const rings = {}; // { ringName: [satellite1, satellite2, ...] }

    satellites.forEach((satellite) => {
      const ringName = satellite.ringName;
      if (!rings[ringName]) rings[ringName] = [];
      rings[ringName].push(satellite);
    });

    // Ring crossings are precomputed in simSatellites

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

    this.interCircularRings(rings, positions, linkCounts, finalLinks);

    this.interEccentricRings(rings, positions, linkCounts, finalLinks);

    this.connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks);

    return finalLinks;
  }

  intraRing(rings, positions, linkCounts, finalLinks) {
    // Create neighbor links for all rings (including Mars and Earth)

    // Initialize a Set for existing links for O(1) lookup
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));

    // Precompute AU to KM conversion if not already done
    const AU_IN_KM = this.AU_IN_KM; // Assuming this is a constant

    let linksAdded = 0;

    // Iterate through each ring
    for (const [ringName, ringSatellites] of Object.entries(rings)) {
      // Skip rings with satellites that have exactly 2 ports
      if (this.simLinkBudget.getMaxLinksPerRing(ringName) === 2) continue;

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

          linksAdded++;

          // Early termination if satellite has reached max links after adding
          if (linkCounts[satellite.name] >= this.simLinkBudget.getMaxLinksPerRing(satellite.ringName)) {
            break; // Exit the neighbors loop for this satellite
          }
        }
      }
    }

    console.log(
      `Intra-ring links (${Object.values(rings).reduce((sum, sats) => sum + sats.length, 0)} satellites): ${linksAdded} connections made`
    );
  }

  interEccentricRings(rings, positions, linkCounts, finalLinks) {
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

      for (const eccSatellite of eccSatellites) {
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

            // Check radial zones for inter-ring connection allowance
            const zoneEcc = this.getRadialZone(eccSatellite, eccentricRingName);
            const zoneTarget = this.getRadialZone(targetSatellite, targetRingName);
            if (zoneEcc === "INSIDE_EARTH" || zoneEcc === "OUTSIDE_MARS" || zoneTarget === "INSIDE_EARTH" || zoneTarget === "OUTSIDE_MARS")
              continue;

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
    let linksAdded = 0;
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

      linksAdded++;

      // Optional: Early termination if desired
      // If there's a limit on the number of links to assign, implement it here
    }

    console.log(
      `Inter-eccentric ring links (${eccentricRingNames.length} rings, ${eccentricRingNames.reduce(
        (sum, name) => sum + rings[name].length,
        0
      )} satellites): ${linksAdded} connections made`
    );
  }

  /**
   * Finds the indices of the nearest lower and higher solar angle satellites relative to a given solar angle.
   * @param {number[]} sortedSolarAngleList - A sorted array of solar angle values in ascending order.
   * @param {number} targetSolarAngle - The solar angle value to find neighbors for.
   * @returns {Object} An object containing the indices of the nearest lower and higher satellites.
   */
  findNearestSolarAngleIndices(sortedSolarAngleList, targetSolarAngle) {
    let left = 0;
    let right = sortedSolarAngleList.length - 1;
    let mid;
    let lower = sortedSolarAngleList.length - 1; // Default to the last index (wrap-around)
    let higher = 0; // Default to the first index (wrap-around)

    while (left <= right) {
      mid = Math.floor((left + right) / 2);
      if (sortedSolarAngleList[mid] <= targetSolarAngle) {
        lower = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    // The higher index is the next one after lower, with wrap-around
    higher = (lower + 1) % sortedSolarAngleList.length;

    return { lower, higher };
  }

  interCircularRings(rings, positions, linkCounts, finalLinks) {
    // Step 2: Add Links for Circular Rings Based on `a` and `solar angle` (Excluding Mars and Earth Rings)

    // Identify circular rings (exclude 'ring_mars' and 'ring_earth')
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));

    // Sort circular rings from closest to furthest based on 'a' (ascending order)
    const sortedCircularRings = circularRingNames.slice().sort((a, b) => {
      const aDistance = rings[a][0].a; // 'a' is the distance from the sun in AU
      const bDistance = rings[b][0].a;
      return aDistance - bDistance; // Ascending order: closest first
    });

    // Initialize a Set for existing links for O(1) lookup
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));

    // Precompute AU to KM conversion if not already done
    const AU_IN_KM = this.AU_IN_KM; // Assuming this is a constant

    // Precompute sorted satellites for each ring
    const ringSatellites = {};
    sortedCircularRings.forEach((ringName) => {
      ringSatellites[ringName] = rings[ringName].slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    });

    // Iterate through each circular ring
    for (let i = 0; i < sortedCircularRings.length; i++) {
      const currentRingName = sortedCircularRings[i];
      let ringLinksAdded = 0;
      const currentRingSatellites = ringSatellites[currentRingName];
      const sortedCurrentRingSatellites = currentRingSatellites; // already sorted

      const prevRingName = i > 0 ? sortedCircularRings[i - 1] : null;
      const nextRingName = i < sortedCircularRings.length - 1 ? sortedCircularRings[i + 1] : null;

      // For each satellite in the current ring
      sortedCurrentRingSatellites.forEach((currentSatellite, j) => {
        // Determine if this satellite should attempt to connect to the next ring
        let shouldConnectToNext = false;
        const maxLinks = this.simLinkBudget.getMaxLinksPerRing(currentSatellite.ringName);
        if (i === 0 && maxLinks === 3) {
          // For the first ring with 3 ports, only odd satellites connect to n+1
          shouldConnectToNext = j % 2 === 1;
        } else {
          // For other rings or 4 ports, all satellites with ports available connect to n+1
          shouldConnectToNext = linkCounts[currentSatellite.name] < maxLinks;
        }

        if (!shouldConnectToNext) return;

        // Try to connect to the next ring (i+1) if it exists
        if (i + 1 < sortedCircularRings.length) {
          const nextRingIndex = i + 1;
          const nextRingName = sortedCircularRings[nextRingIndex];
          const nextRingSatellites = ringSatellites[nextRingName];
          const sortedNextSolarAngleList = nextRingSatellites.map((sat) => sat.position.solarAngle);

          const currentSolarAngle = currentSatellite.position.solarAngle % 360; // Ensure solar angle is within [0, 360)

          // Sweep to find the nearest higher solar angle satellite
          let nextIndex = 0;
          while (nextIndex < sortedNextSolarAngleList.length && sortedNextSolarAngleList[nextIndex] < currentSolarAngle) {
            nextIndex++;
          }

          // Determine nearest lower and higher satellites with wrap-around
          const nearestHigher = nextRingSatellites[nextIndex % sortedNextSolarAngleList.length];
          const nearestLower = nextRingSatellites[(nextIndex - 1 + sortedNextSolarAngleList.length) % sortedNextSolarAngleList.length];

          // Calculate distances
          const distanceAULower = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestLower.name]);
          const distanceAUHigher = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestHigher.name]);

          // Collect candidates, sorted by distance
          const candidates = [
            { satellite: nearestLower, distanceAU: distanceAULower },
            { satellite: nearestHigher, distanceAU: distanceAUHigher },
          ].sort((a, b) => a.distanceAU - b.distanceAU);

          // Select the closest candidate that has ports available
          let targetSatellite = null;
          for (const candidate of candidates) {
            if (linkCounts[candidate.satellite.name] < this.simLinkBudget.getMaxLinksPerRing(candidate.satellite.ringName)) {
              // Check radial zones for inter-ring connection allowance
              const zoneCurrent = this.getRadialZone(currentSatellite, currentRingName);
              const zoneTarget = this.getRadialZone(candidate.satellite, nextRingName);
              if (
                zoneCurrent === "INSIDE_EARTH" ||
                zoneCurrent === "OUTSIDE_MARS" ||
                zoneTarget === "INSIDE_EARTH" ||
                zoneTarget === "OUTSIDE_MARS"
              )
                continue;
              targetSatellite = candidate;
              break;
            }
          }

          if (targetSatellite) {
            // Enforce maximum distance constraint
            const distanceAU = targetSatellite.distanceAU;
            if (distanceAU <= this.simLinkBudget.maxDistanceAU) {
              // Verify ports are still available before adding the link
              if (
                linkCounts[currentSatellite.name] >= this.simLinkBudget.getMaxLinksPerRing(currentSatellite.ringName) ||
                linkCounts[targetSatellite.satellite.name] >= this.simLinkBudget.getMaxLinksPerRing(targetSatellite.satellite.ringName)
              ) {
                return;
              }

              const distanceKm = distanceAU * AU_IN_KM;
              const gbpsCapacity = this.calculateGbps(distanceKm);
              const latencySeconds = this.calculateLatency(distanceKm);

              // Order the IDs lexicographically to avoid duplicate links
              const [orderedFromId, orderedToId] =
                currentSatellite.name < targetSatellite.satellite.name
                  ? [currentSatellite.name, targetSatellite.satellite.name]
                  : [targetSatellite.satellite.name, currentSatellite.name];
              const linkKey = `${orderedFromId}-${orderedToId}`;

              // Check if the link already exists using the Set
              if (!existingLinks.has(linkKey)) {
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
                linkCounts[currentSatellite.name]++;
                linkCounts[targetSatellite.satellite.name]++;

                // Add the new link to the Set
                existingLinks.add(linkKey);

                ringLinksAdded++;
              }
            }
          }
        }
      });

      console.log(
        `Processing ring ${currentRingName} (index ${i}, ${currentRingSatellites.length} satellites): ${ringLinksAdded} connections made`
      );
    }
  }

  marsEarthRings(rings, positions, linkCounts, finalLinks) {
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
              if (targetRingConnectionCounts[targetSat.name] >= this.simLinkBudget.getMaxLinksPerRing(targetSat.ringName)) {
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
          // Check radial zone for inter-ring connection allowance
          const zone = this.getRadialZone(nearestSatellite, nearestSatellite.ringName);
          if (zone === "INSIDE_EARTH" || zone === "OUTSIDE_MARS") return;

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

    let linksAdded = 0;
    let marsLinksAdded = 0;
    let earthLinksAdded = 0;
    potentialLinks.forEach((link) => {
      const { fromId, toId, distanceAU, distanceKm, latencySeconds, gbpsCapacity } = link;

      // Check if the link already exists
      const linkKey = `${fromId}-${toId}`;
      if (existingLinks.has(linkKey)) return;

      // Check if 'fromId' is part of planetary rings and has reached its maximum of 2 links
      const fromRing = Object.keys(rings).find((ringName) => rings[ringName].some((sat) => sat.name === fromId));
      const isFromPlanetaryRing = earthMarsRings.includes(fromRing);

      if (isFromPlanetaryRing && linkCounts[fromId] >= maxConnectionsPerPlanetarySatellite) {
        return; // Skip if 'fromId' has reached its max links
      }

      // Determine toRing
      const toRing = toId === "Earth" ? "ring_earth" : "ring_mars";

      // Check if 'toId' has reached its maximum links as per simLinkBudget // marsEarthRings
      if (linkCounts[toId] >= this.simLinkBudget.getMaxLinksPerRing(toRing)) {
        return; // Skip if 'toId' has reached its max links
      }
      // Check if 'fromId' has reached its maximum links as per simLinkBudget // marsEarthRings
      if (linkCounts[fromId] >= this.simLinkBudget.getMaxLinksPerRing(fromRing) - 1) {
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

      linksAdded++;

      // Count Mars and Earth links
      if (fromId === "Mars") marsLinksAdded++;
      else if (fromId === "Earth") earthLinksAdded++;
    });

    // **New Implementation Ends Here**

    // Optionally, log the number of potential links and assigned links
    // console.log(`Potential Links: ${potentialLinks.length}`);
    // console.log(`Assigned Links: ${finalLinks.length}`);

    const marsRing = rings["ring_mars"];
    const earthRing = rings["ring_earth"];
    console.log(`Mars ring links (${marsRing ? marsRing.length : 0} satellites): ${marsLinksAdded} connections made`);
    console.log(`Earth ring links (${earthRing ? earthRing.length : 0} satellites): ${earthLinksAdded} connections made`);
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

          // Check radial zones for inter-ring connection allowance
          const zoneEcc = this.getRadialZone(eccSatellite, ecceRingName);
          const circRingName = circularRingNames.find((r) => rings[r].includes(circSatellite));
          const zoneCirc = this.getRadialZone(circSatellite, circRingName);
          if (zoneEcc === "INSIDE_EARTH" || zoneEcc === "OUTSIDE_MARS" || zoneCirc === "INSIDE_EARTH" || zoneCirc === "OUTSIDE_MARS")
            return;

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

    let linksAdded = 0;
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

      linksAdded++;
    });

    console.log(
      `Eccentric to circular ring connections (${eccentricRingNames.length} eccentric rings, ${
        circularRingNames.length
      } circular rings, ${eccentricRingNames.reduce((sum, name) => sum + rings[name].length, 0)} + ${circularRingNames.reduce(
        (sum, name) => sum + rings[name].length,
        0
      )} satellites): ${linksAdded} connections made`
    );
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
    let maxLatency = -Infinity;

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
      if (totalLatency > maxLatency) {
        maxLatency = totalLatency;
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
      maxLatency: maxLatency === -Infinity ? null : maxLatency,
    };
  }
}
