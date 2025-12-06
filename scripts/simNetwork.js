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

    // Initialize port usage
    const portUsage = {};
    satellites.forEach((satellite) => {
      portUsage[satellite.name] = { prograde: false, retrograde: false, outwards: false, inwards: false };
    });

    // Constants
    const planetsOptions = ["Earth", "Mars"];

    // Filter planets based on the provided options
    const filteredPlanets = planets.filter((planet) => planetsOptions.includes(planet.name));

    // Collect planet positions
    filteredPlanets.forEach((planet) => {
      positions[planet.name] = planet.position;
      linkCounts[planet.name] = 0;
      portUsage[planet.name] = { prograde: false, retrograde: false, outwards: false, inwards: false };
    });

    const finalLinks = []; // Final list of links to return

    this.intraRing(rings, positions, linkCounts, finalLinks, portUsage);

    // this.marsEarthRings(rings, positions, linkCounts, finalLinks);

    this.interCircularRings(rings, positions, linkCounts, finalLinks, portUsage);
    this.marsToCircularRings(rings, positions, linkCounts, finalLinks, portUsage);
    this.earthToCircularRings(rings, positions, linkCounts, finalLinks, portUsage);

    // this.interEccentricRings(rings, positions, linkCounts, finalLinks);

    // this.connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks);

    return finalLinks;
  }

  intraRing(rings, positions, linkCounts, finalLinks, portUsage) {
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

          // Determine directions (considering circular solar angles)
          const satSolar = positions[satellite.name].solarAngle;
          const neighSolar = positions[neighborName].solarAngle;
          const delta = (neighSolar - satSolar + 360) % 360;
          let directionSat, directionNeigh;
          if (delta <= 180) {
            directionSat = "prograde";
            directionNeigh = "retrograde";
          } else {
            directionSat = "retrograde";
            directionNeigh = "prograde";
          }

          // Check if ports are available
          if (portUsage[satellite.name][directionSat] || portUsage[neighborName][directionNeigh]) continue;

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

          // Mark ports as used
          portUsage[satellite.name][directionSat] = true;
          portUsage[neighborName][directionNeigh] = true;

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

  interCircularRings(rings, positions, linkCounts, finalLinks, portUsage) {
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

    // For rings with 3 ports, alternate marking ports as unavailable
    sortedCircularRings.forEach((ringName) => {
      const maxLinks = this.simLinkBudget.getMaxLinksPerRing(ringName);
      if (maxLinks === 3) {
        ringSatellites[ringName].forEach((sat, index) => {
          if (index % 2 === 0) {
            portUsage[sat.name].outwards = true; // mark outwards unavailable
          } else {
            portUsage[sat.name].inwards = true; // mark inwards unavailable
          }
        });
      }
    });

    // Iterate through each circular ring
    for (let i = 0; i < sortedCircularRings.length; i++) {
      if (i + 1 < sortedCircularRings.length) {
        const currentRingName = sortedCircularRings[i];
        const nextRingName = sortedCircularRings[i + 1];
        const currentRingSatellites = ringSatellites[currentRingName];
        const nextRingSatellites = ringSatellites[nextRingName];

        const candidates = [];

        // From current to next
        currentRingSatellites.forEach((currentSatellite, j) => {
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

          const sortedNextSolarAngleList = nextRingSatellites.map((sat) => sat.position.solarAngle);
          const currentSolarAngle = currentSatellite.position.solarAngle % 360;

          let nextIndex = 0;
          while (nextIndex < sortedNextSolarAngleList.length && sortedNextSolarAngleList[nextIndex] < currentSolarAngle) {
            nextIndex++;
          }

          const nearestHigher = nextRingSatellites[nextIndex % sortedNextSolarAngleList.length];
          const nearestLower = nextRingSatellites[(nextIndex - 1 + sortedNextSolarAngleList.length) % sortedNextSolarAngleList.length];

          // Add both as candidates if zones match
          const zoneCurrent = currentSatellite.orbitalZone;
          if (zoneCurrent === "BETWEEN_EARTH_AND_MARS") {
            if (nearestLower.orbitalZone === "BETWEEN_EARTH_AND_MARS") {
              const distanceAU = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestLower.name]);
              candidates.push({ from: currentSatellite, to: nearestLower, distanceAU });
            }
            if (nearestHigher.orbitalZone === "BETWEEN_EARTH_AND_MARS") {
              const distanceAU = this.calculateDistanceAU(positions[currentSatellite.name], positions[nearestHigher.name]);
              candidates.push({ from: currentSatellite, to: nearestHigher, distanceAU });
            }
          }
        });

        // From next to current
        nextRingSatellites.forEach((nextSatellite) => {
          const sortedCurrentSolarAngleList = currentRingSatellites.map((sat) => sat.position.solarAngle);
          const nextSolarAngle = nextSatellite.position.solarAngle % 360;

          let currentIndex = 0;
          while (currentIndex < sortedCurrentSolarAngleList.length && sortedCurrentSolarAngleList[currentIndex] < nextSolarAngle) {
            currentIndex++;
          }

          const nearestHigher = currentRingSatellites[currentIndex % sortedCurrentSolarAngleList.length];
          const nearestLower =
            currentRingSatellites[(currentIndex - 1 + sortedCurrentSolarAngleList.length) % sortedCurrentSolarAngleList.length];

          // Add both as candidates if zones match
          const zoneNext = nextSatellite.orbitalZone;
          if (zoneNext === "BETWEEN_EARTH_AND_MARS") {
            if (nearestLower.orbitalZone === "BETWEEN_EARTH_AND_MARS") {
              const distanceAU = this.calculateDistanceAU(positions[nextSatellite.name], positions[nearestLower.name]);
              candidates.push({ from: nextSatellite, to: nearestLower, distanceAU });
            }
            if (nearestHigher.orbitalZone === "BETWEEN_EARTH_AND_MARS") {
              const distanceAU = this.calculateDistanceAU(positions[nextSatellite.name], positions[nearestHigher.name]);
              candidates.push({ from: nextSatellite, to: nearestHigher, distanceAU });
            }
          }
        });

        // Sort candidates by distanceAU ascending
        candidates.sort((a, b) => a.distanceAU - b.distanceAU);

        // Assign links
        const unavailable = new Set();
        let ringLinksAdded = 0;
        for (const candidate of candidates) {
          const { from, to, distanceAU } = candidate;
          if (unavailable.has(from.name) || unavailable.has(to.name)) continue;
          if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;
          if (
            linkCounts[from.name] >= this.simLinkBudget.getMaxLinksPerRing(from.ringName) ||
            linkCounts[to.name] >= this.simLinkBudget.getMaxLinksPerRing(to.ringName)
          )
            continue;

          const [orderedFromId, orderedToId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
          const linkKey = `${orderedFromId}-${orderedToId}`;
          if (existingLinks.has(linkKey)) continue;

          // Determine directions
          const fromA = rings[from.ringName][0].a;
          const toA = rings[to.ringName][0].a;
          const directionFrom = fromA < toA ? "outwards" : "inwards";
          const directionTo = toA < fromA ? "outwards" : "inwards";

          // Check if ports are available
          if (portUsage[from.name][directionFrom] || portUsage[to.name][directionTo]) continue;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbpsCapacity = this.calculateGbps(distanceKm);
          const latencySeconds = this.calculateLatency(distanceKm);

          finalLinks.push({
            fromId: orderedFromId,
            toId: orderedToId,
            distanceAU,
            distanceKm,
            latencySeconds,
            gbpsCapacity,
          });

          linkCounts[from.name]++;
          linkCounts[to.name]++;
          existingLinks.add(linkKey);
          unavailable.add(from.name);
          unavailable.add(to.name);

          // Mark ports as used
          portUsage[from.name][directionFrom] = true;
          portUsage[to.name][directionTo] = true;
          ringLinksAdded++;
        }

        console.log(`Processing ring pair ${currentRingName} and ${nextRingName}: ${ringLinksAdded} connections made`);
      }
    }
  }

  marsToCircularRings(rings, positions, linkCounts, finalLinks, portUsage) {
    // Get Mars ring satellites
    const marsRingSatellites = rings["ring_mars"] || [];

    // Identify circular rings
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));

    // Sort circular rings from furthest to closest (descending 'a')
    const sortedCircularRings = circularRingNames.slice().sort((a, b) => {
      const aDist = rings[a][0].a;
      const bDist = rings[b][0].a;
      return bDist - aDist;
    });

    // For each circular ring paired with Mars ring
    sortedCircularRings.forEach((circRingName) => {
      const circRingSatellites = rings[circRingName];

      // Sort satellites by solar angle
      const sortedMarsSats = marsRingSatellites.slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);
      const sortedCircSats = circRingSatellites.slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);

      const candidates = [];

      // From Mars ring to circular ring
      marsRingSatellites.forEach((marsSat) => {
        if (!portUsage[marsSat.name].inwards) {
          const marsSolarAngle = marsSat.position.solarAngle % 360;

          // Find insertion index in sortedCircSats
          let index = 0;
          while (index < sortedCircSats.length && sortedCircSats[index].position.solarAngle < marsSolarAngle) {
            index++;
          }

          const nearestHigher = sortedCircSats[index % sortedCircSats.length];
          const nearestLower = sortedCircSats[(index - 1 + sortedCircSats.length) % sortedCircSats.length];

          // Add both as candidates if conditions met
          [nearestLower, nearestHigher].forEach(circSat => {
            if (circSat && circSat.orbitalZone === "BETWEEN_EARTH_AND_MARS" && !portUsage[circSat.name].outwards) {
              const distanceAU = this.calculateDistanceAU(positions[marsSat.name], positions[circSat.name]);
              candidates.push({ from: marsSat, to: circSat, distanceAU });
            }
          });
        }
      });

      // From circular ring to Mars ring
      circRingSatellites.forEach((circSat) => {
        if (circSat.orbitalZone === "BETWEEN_EARTH_AND_MARS" && !portUsage[circSat.name].outwards) {
          const circSolarAngle = circSat.position.solarAngle % 360;

          // Find insertion index in sortedMarsSats
          let index = 0;
          while (index < sortedMarsSats.length && sortedMarsSats[index].position.solarAngle < circSolarAngle) {
            index++;
          }

          const nearestHigher = sortedMarsSats[index % sortedMarsSats.length];
          const nearestLower = sortedMarsSats[(index - 1 + sortedMarsSats.length) % sortedMarsSats.length];

          // Add both as candidates if conditions met
          [nearestLower, nearestHigher].forEach(marsSat => {
            if (marsSat && !portUsage[marsSat.name].inwards) {
              const distanceAU = this.calculateDistanceAU(positions[circSat.name], positions[marsSat.name]);
              candidates.push({ from: circSat, to: marsSat, distanceAU });
            }
          });
        }
      });

      // Sort candidates by distanceAU ascending
      candidates.sort((a, b) => a.distanceAU - b.distanceAU);

      // Assign links
      const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));
      const AU_IN_KM = this.AU_IN_KM;

      let linksAdded = 0;
      const unavailable = new Set();
      for (const candidate of candidates) {
        const { from, to, distanceAU } = candidate;
        if (unavailable.has(from.name) || unavailable.has(to.name)) continue;
        if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;
        if (
          linkCounts[from.name] >= this.simLinkBudget.getMaxLinksPerRing(from.ringName) ||
          linkCounts[to.name] >= this.simLinkBudget.getMaxLinksPerRing(to.ringName)
        )
          continue;

        // Check ports: inwards for Mars ring sat, outwards for circular sat
        const directionFrom = from.ringName === "ring_mars" ? "inwards" : "outwards";
        const directionTo = to.ringName === "ring_mars" ? "inwards" : "outwards";
        if (portUsage[from.name][directionFrom] || portUsage[to.name][directionTo]) continue;

        const [fromId, toId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
        const linkKey = `${fromId}-${toId}`;
        if (existingLinks.has(linkKey)) continue;

        const distanceKm = distanceAU * AU_IN_KM;
        const gbpsCapacity = this.calculateGbps(distanceKm);
        const latencySeconds = this.calculateLatency(distanceKm);

        finalLinks.push({
          fromId,
          toId,
          distanceAU,
          distanceKm,
          latencySeconds,
          gbpsCapacity,
        });

        linkCounts[from.name]++;
        linkCounts[to.name]++;
        existingLinks.add(linkKey);
        unavailable.add(from.name);
        unavailable.add(to.name);

        // Mark ports as used
        portUsage[from.name][directionFrom] = true;
        portUsage[to.name][directionTo] = true;

        linksAdded++;
      }

      console.log(`Mars ring <-> ${circRingName}: ${linksAdded} connections made`);
    });
  }

  earthToCircularRings(rings, positions, linkCounts, finalLinks, portUsage) {
    // Get orbital elements
    const orbitalElements = this.simSatellites.getOrbitalElements();
    console.log('Orbital elements:', orbitalElements);

    // Get Earth ring satellites
    const earthRingSatellites = rings["ring_earth"] || [];

    // Identify circular rings
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ"));

    // Sort circular rings from closest to furthest (ascending 'a')
    const sortedCircularRings = circularRingNames.slice().sort((a, b) => {
      const aDist = rings[a][0].a;
      const bDist = rings[b][0].a;
      return aDist - bDist;
    });

    // Initialize taken ranges
    let takenRanges = [];
    console.log('Starting with taken ranges:', takenRanges);

    // Helper to check if ranges cover full 360 degrees
    const isFullCoverage = (ranges) => {
      if (ranges.length === 0) return false;
      const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
      const merged = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i][0] <= last[1]) {
          last[1] = Math.max(last[1], sorted[i][1]);
        } else {
          merged.push(sorted[i]);
        }
      }
      return merged.length === 1 && merged[0][0] <= 0 && merged[0][1] >= 360;
    };

    // Process each ring
    for (const circRingName of sortedCircularRings) {
      const crossings = this.simSatellites.getRingCrossings().get(circRingName);
      if (!crossings || !crossings.earth) {
        console.log(`No earth crossings for ${circRingName}`);
        continue;
      }

      const outsideRange = crossings.earth.outside;
      if (!outsideRange) {
        console.log(`No outside range for ${circRingName}`);
        continue;
      }

      console.log(`Processing ring ${circRingName}, outside range: ${outsideRange}`);

      const circRingSatellites = rings[circRingName];

      // Filter valid satellites: in outside range and not in takenRanges
      const validSats = circRingSatellites.filter(sat => {
        const angle = sat.position.solarAngle;
        const inOutside = angle >= outsideRange[0] && angle <= outsideRange[1];
        const inTaken = takenRanges.some(range => angle >= range[0] && angle <= range[1]);
        return inOutside && !inTaken;
      });

      console.log(`Valid satellites for ${circRingName}: ${validSats.length} out of ${circRingSatellites.length}`);

      if (validSats.length === 0) {
        console.log(`No valid satellites, skipping`);
        continue;
      }

      // Sort satellites by solar angle
      const sortedEarthSats = earthRingSatellites.slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);
      const sortedCircSats = validSats.slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);

      const candidates = [];

      // From Earth ring to circular ring
      earthRingSatellites.forEach((earthSat) => {
        if (!portUsage[earthSat.name].outwards) {
          const earthSolarAngle = earthSat.position.solarAngle % 360;

          // Find insertion index in sortedCircSats
          let index = 0;
          while (index < sortedCircSats.length && sortedCircSats[index].position.solarAngle < earthSolarAngle) {
            index++;
          }

          const nearestHigher = sortedCircSats[index % sortedCircSats.length];
          const nearestLower = sortedCircSats[(index - 1 + sortedCircSats.length) % sortedCircSats.length];

          // Add both as candidates if conditions met
          [nearestLower, nearestHigher].forEach(circSat => {
            if (circSat && circSat.orbitalZone === "BETWEEN_EARTH_AND_MARS" && !portUsage[circSat.name].inwards) {
              const distanceAU = this.calculateDistanceAU(positions[earthSat.name], positions[circSat.name]);
              candidates.push({ from: earthSat, to: circSat, distanceAU });
            }
          });
        }
      });

      // From circular ring to Earth ring
      validSats.forEach((circSat) => {
        if (circSat.orbitalZone === "BETWEEN_EARTH_AND_MARS" && !portUsage[circSat.name].inwards) {
          const circSolarAngle = circSat.position.solarAngle % 360;

          // Find insertion index in sortedEarthSats
          let index = 0;
          while (index < sortedEarthSats.length && sortedEarthSats[index].position.solarAngle < circSolarAngle) {
            index++;
          }

          const nearestHigher = sortedEarthSats[index % sortedEarthSats.length];
          const nearestLower = sortedEarthSats[(index - 1 + sortedEarthSats.length) % sortedEarthSats.length];

          // Add both as candidates if conditions met
          [nearestLower, nearestHigher].forEach(earthSat => {
            if (earthSat && !portUsage[earthSat.name].outwards) {
              const distanceAU = this.calculateDistanceAU(positions[circSat.name], positions[earthSat.name]);
              candidates.push({ from: circSat, to: earthSat, distanceAU });
            }
          });
        }
      });

      // Sort candidates by distanceAU ascending
      candidates.sort((a, b) => a.distanceAU - b.distanceAU);

      // Assign links
      const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));
      const AU_IN_KM = this.AU_IN_KM;

      let linksAdded = 0;
      const unavailable = new Set();
      for (const candidate of candidates) {
        const { from, to, distanceAU } = candidate;
        if (unavailable.has(from.name) || unavailable.has(to.name)) continue;
        if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;
        if (
          linkCounts[from.name] >= this.simLinkBudget.getMaxLinksPerRing(from.ringName) ||
          linkCounts[to.name] >= this.simLinkBudget.getMaxLinksPerRing(to.ringName)
        )
          continue;

        // Check ports: outwards for Earth ring sat, inwards for circular sat
        const directionFrom = from.ringName === "ring_earth" ? "outwards" : "inwards";
        const directionTo = to.ringName === "ring_earth" ? "outwards" : "inwards";
        if (portUsage[from.name][directionFrom] || portUsage[to.name][directionTo]) continue;

        const [fromId, toId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
        const linkKey = `${fromId}-${toId}`;
        if (existingLinks.has(linkKey)) continue;

        const distanceKm = distanceAU * AU_IN_KM;
        const gbpsCapacity = this.calculateGbps(distanceKm);
        const latencySeconds = this.calculateLatency(distanceKm);

        finalLinks.push({
          fromId,
          toId,
          distanceAU,
          distanceKm,
          latencySeconds,
          gbpsCapacity,
        });

        linkCounts[from.name]++;
        linkCounts[to.name]++;
        existingLinks.add(linkKey);
        unavailable.add(from.name);
        unavailable.add(to.name);

        // Mark ports as used
        portUsage[from.name][directionFrom] = true;
        portUsage[to.name][directionTo] = true;

        linksAdded++;
      }

      console.log(`Earth ring <-> ${circRingName}: ${linksAdded} connections made`);

      // Add outsideRange to takenRanges
      takenRanges.push(outsideRange);
      console.log(`Taken ranges after adding ${circRingName}:`, takenRanges);

      // Check if takenRanges cover full 360
      if (isFullCoverage(takenRanges)) {
        console.log('Full coverage reached, stopping further rings');
        break;
      }
    }
  }

  marsEarthRings(rings, positions, linkCounts, finalLinks, portUsage) {
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

              // Check radial zone for inter-ring connection allowance
              const zone = targetSat.orbitalZone;
              if (zone === "INSIDE_EARTH" || zone === "OUTSIDE_MARS") return;

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

      // Determine directions
      const fromA = fromId === "Earth" || fromId === "Mars" ? 0 : rings[fromRing][0].a;
      const toA = toId === "Earth" || toId === "Mars" ? 0 : rings[toRing][0].a;
      const directionFrom = fromA < toA ? "outwards" : "inwards";
      const directionTo = toA < fromA ? "outwards" : "inwards";

      // Check if ports are available
      if (portUsage[fromId][directionFrom] || portUsage[toId][directionTo]) return;

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

      // Mark ports as used
      portUsage[fromId][directionFrom] = true;
      portUsage[toId][directionTo] = true;

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
