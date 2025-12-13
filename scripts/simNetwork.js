// simNetwork.js

import { SIM_CONSTANTS } from "./simConstants.js";

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
      satellite.prograde = null;
      satellite.retrograde = null;
      satellite.outwards = null;
      satellite.inwards = null;
    });

    // Constants
    const planetsOptions = ["Earth", "Mars"];

    // Filter planets based on the provided options
    const filteredPlanets = planets.filter((planet) => planetsOptions.includes(planet.name));

    // Collect planet positions
    filteredPlanets.forEach((planet) => {
      positions[planet.name] = planet.position;
      linkCounts[planet.name] = 0;
      planet.prograde = null;
      planet.retrograde = null;
      planet.outwards = null;
      planet.inwards = null;
    });

    const finalLinks = []; // Final list of links to return
    const targetDepartureAngle = 0; // Bias for geometric angle in inter-ring connections

    this.intraRing(rings, positions, linkCounts, finalLinks);

    // this.marsEarthRings(rings, positions, linkCounts, finalLinks);

    this.interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites);
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_mars", targetDepartureAngle);
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_earth", targetDepartureAngle);
    // this.interEccentricRings(rings, positions, linkCounts, finalLinks);

    // this.connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks);

    // Calculate Earth to Mars routes
    this.calculateEarthToMarsRoutes(finalLinks, rings);

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
          const neighborSat = ringSatellites.find((s) => s.name === neighborName);
          if (!neighborSat) continue;
          if (satellite[directionSat] !== null || neighborSat[directionNeigh] !== null) continue;

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
          satellite[directionSat] = neighborSat.name;
          neighborSat[directionNeigh] = satellite.name;

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
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_circ") || ringName.startsWith("ring_adapt")
    );
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

  interCircularRings(rings, positions, linkCounts, finalLinks, portUsage, targetDepartureAngle = 0) {
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ_"));

    if (circularRingNames.length === 0) return;

    // Extract numeric index from ring name: ring_circ_5 → 5, ring_adapt_12 → 12
    const parseIndex = (name) => {
      const match = name.match(/_(\d+)$/);
      return match ? parseInt(match[1], 10) : -1;
    };

    // Create list of { name, index, radius }
    const ringList = circularRingNames
      .map((name) => ({
        name,
        index: parseIndex(name),
        radius: rings[name][0].a, // using semi-major axis as radius proxy
      }))
      .filter((r) => r.index >= 0);

    // Sort by index (Earth → Mars direction)
    ringList.sort((a, b) => a.index - b.index);

    const existingLinks = new Set(finalLinks.map((l) => `${l.fromId}-${l.toId}`));
    const AU_IN_KM = this.AU_IN_KM;

    // Precompute sorted satellites per ring
    const ringSatellites = {};
    ringList.forEach((ring) => {
      ringSatellites[ring.name] = rings[ring.name].slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    });

    // Pre-mark unavailable ports for 3-port rings
    ringList.forEach((ring) => {
      const maxLinks = this.simLinkBudget.getMaxLinksPerRing(ring.name);
      if (maxLinks !== 3) return;
      ringSatellites[ring.name].forEach((sat, i) => {
        if (i % 2 === 0) sat.outwards = "premarked";
        else sat.inwards = "premarked";
      });
    });

    const normalizeAngle = (deg) => ((deg % 360) + 360) % 360;

    // Now: Only connect each ring to its IMMEDIATE NEXT (index +1)
    for (let i = 0; i < ringList.length - 1; i++) {
      const inner = ringList[i];
      const outer = ringList[i + 1];

      // Critical check: Only connect if indices are consecutive!
      if (outer.index !== inner.index + 1) {
        console.log(`Skipping non-consecutive rings: ${inner.name} (${inner.index}) → ${outer.name} (${outer.index})`);
        continue;
      }

      console.log(`Connecting consecutive rings: ${inner.name} (#${inner.index}) → ${outer.name} (#${outer.index})`);

      const innerSats = ringSatellites[inner.name];
      const outerSats = ringSatellites[outer.name];
      const outerAngles = outerSats.map((s) => s.position.solarAngle);

      const rInner = inner.radius;
      const rOuter = outer.radius;
      const departureRad = (targetDepartureAngle * Math.PI) / 180;

      const candidates = [];

      innerSats.forEach((innerSat) => {
        // Port & link budget checks
        const maxLinks = this.simLinkBudget.getMaxLinksPerRing(innerSat.ringName);
        const isFirstRing = inner.index === ringList[0].index;
        const canConnectOut = isFirstRing && maxLinks === 3 ? innerSats.indexOf(innerSat) % 2 === 1 : linkCounts[innerSat.name] < maxLinks;

        if (!canConnectOut || innerSat.outwards !== null) return;

        // Approximate ideal target solar angle using geometry
        const distEst = rOuter - rInner;
        const tanOffset = distEst * Math.tan(departureRad);
        const angularOffsetRad = Math.atan2(tanOffset, rOuter);
        const idealTargetSolarAngle = normalizeAngle(innerSat.position.solarAngle + (angularOffsetRad * 180) / Math.PI);

        // Binary search for closest satellites
        let idx = 0;
        while (idx < outerAngles.length && outerAngles[idx] < idealTargetSolarAngle) idx++;
        const neighbors = [outerSats[(idx - 1 + outerSats.length) % outerSats.length], outerSats[idx % outerSats.length]];

        neighbors.forEach((outerSat) => {
          if (outerSat.inwards !== null) return;
          if (linkCounts[outerSat.name] >= this.simLinkBudget.getMaxLinksPerRing(outerSat.ringName)) return;

          const distanceAU = this.calculateDistanceAU(positions[innerSat.name], positions[outerSat.name]);
          if (distanceAU > this.simLinkBudget.maxDistanceAU) return;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbps = this.calculateGbps(distanceKm);

          candidates.push({ from: innerSat, to: outerSat, distanceAU, distanceKm, gbps });
        });
      });

      // Sort by distance (shortest = best)
      candidates.sort((a, b) => a.distanceAU - b.distanceAU);

      // Greedily assign non-conflicting links
      const used = new Set();
      let linksAdded = 0;

      for (const { from, to, distanceAU, distanceKm, gbps } of candidates) {
        if (used.has(from.name) || used.has(to.name)) continue;
        if (linkCounts[from.name] >= this.simLinkBudget.getMaxLinksPerRing(from.ringName)) continue;
        if (linkCounts[to.name] >= this.simLinkBudget.getMaxLinksPerRing(to.ringName)) continue;
        if (from.outwards !== null || to.inwards !== null) continue;

        const [fId, tId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;

        finalLinks.push({
          fromId: fId,
          toId: tId,
          distanceAU,
          distanceKm,
          latencySeconds: this.calculateLatency(distanceKm),
          gbpsCapacity: gbps,
        });

        linkCounts[from.name]++;
        linkCounts[to.name]++;
        existingLinks.add(key);
        from.outwards = to.name;
        to.inwards = from.name;
        used.add(from.name);
        used.add(to.name);
        linksAdded++;
      }

      console.log(`→ ${linksAdded} inter-ring links added between ${inner.name} and ${outer.name}`);
    }
  }

  interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites) {
    /* modify function to keep track of 'routes', which are a series of links going from lower index rings to high index rings. 
       When a link is created between two satellites of neighbor rings, and if the inward port of the satellite on the lower index ring isn't used, this is the beginning of a route. (we look at the satellite in the lower index ring, so the satellite uses the outward port for this link).
       We add this to a new route map, with as origin the satellite id or name or object (whatever is used to retrieve them). We look at the other satellite (the inward port is used for this link) of the link
       and we add this link to the route. We continue by looking at the outward port of the latter satellite, and if there is a link, we follow it in the same way as we just did.
       This will build a route in the route map. As we build the route, we keep 'metadata' about each route in the route map. This includes the route throughput_mbps and latency_seconds.  
       The throughput is calculated by taking the throuhgput of lowest link of the route. The latency is calculated by adding the latencies of each link. This should be done during the route building, filling the metadata. The metadata also must contain the origin
       and destination of the route (satellite id or whatever is used as id), and this is also done during the route building (origin set with the first link, destination set with the last link, when the next satellite has no link with the outward port)
       Once this is completed, we want to calculate a summary in a new summary dictionnary. This should include the aggregate throughput_mbps (sum of all the individual routes throughputs) and latencies (min, max, average weighted by throuhgput).
      This summary should be displayed in the new div 'info-area-capacity', preceeded by the words 'Adapted rings'
    */
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_adapt_"));

    if (circularRingNames.length === 0) return;

    // Extract numeric index from ring name: ring_circ_5 → 5, ring_adapt_12 → 12
    const parseIndex = (name) => {
      const match = name.match(/_(\d+)$/);
      return match ? parseInt(match[1], 10) : -1;
    };

    // Create list of { name, index, radius }
    const ringList = circularRingNames
      .map((name) => ({
        name,
        index: parseIndex(name),
        radius: rings[name][0].a, // using semi-major axis as radius proxy
      }))
      .filter((r) => r.index >= 0);

    // Sort by index (Earth → Mars direction)
    ringList.sort((a, b) => a.index - b.index);

    const existingLinks = new Set(finalLinks.map((l) => `${l.fromId}-${l.toId}`));
    const AU_IN_KM = this.AU_IN_KM;

    // Precompute sorted satellites per ring
    const ringSatellites = {};
    ringList.forEach((ring) => {
      ringSatellites[ring.name] = rings[ring.name]
        .filter((sat) => sat.orbitalZone === "BETWEEN_EARTH_AND_MARS")
        .slice()
        .sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    });

    // Pre-mark unavailable ports for 3-port rings
    ringList.forEach((ring) => {
      const maxLinks = this.simLinkBudget.getMaxLinksPerRing(ring.name);
      if (maxLinks !== 3) return;
      ringSatellites[ring.name].forEach((sat, i) => {
        if (i % 2 === 0) sat.outwards = "premarked";
        else sat.inwards = "premarked";
      });
    });

    const normalizeAngle = (deg) => ((deg % 360) + 360) % 360;

    // Now: Only connect each ring to its IMMEDIATE NEXT (index +1)
    for (let i = 0; i < ringList.length - 1; i++) {
      const inner = ringList[i];
      const outer = ringList[i + 1];

      // Critical check: Only connect if indices are consecutive!
      if (outer.index !== inner.index + 1) {
        console.log(`Skipping non-consecutive rings: ${inner.name} (${inner.index}) → ${outer.name} (${outer.index})`);
        continue;
      }

      // console.log(`Connecting consecutive rings: ${inner.name} (#${inner.index}) → ${outer.name} (#${outer.index})`);

      const innerSats = ringSatellites[inner.name];
      const outerSats = ringSatellites[outer.name];
      const outerAngles = outerSats.map((s) => s.position.solarAngle);

      const rInner = inner.radius;
      const rOuter = outer.radius;
      const departureRad = (targetDepartureAngle * Math.PI) / 180;

      const candidates = [];

      innerSats.forEach((innerSat) => {
        // Port & link budget checks
        const maxLinks = this.simLinkBudget.getMaxLinksPerRing(innerSat.ringName);
        const isFirstRing = inner.index === ringList[0].index;
        const canConnectOut = isFirstRing && maxLinks === 3 ? innerSats.indexOf(innerSat) % 2 === 1 : linkCounts[innerSat.name] < maxLinks;

        if (!canConnectOut || innerSat.outwards !== null) return;

        // Approximate ideal target solar angle using geometry
        const distEst = rOuter - rInner;
        const tanOffset = distEst * Math.tan(departureRad);
        const angularOffsetRad = Math.atan2(tanOffset, rOuter);
        const idealTargetSolarAngle = normalizeAngle(innerSat.position.solarAngle + (angularOffsetRad * 180) / Math.PI);

        // Binary search for closest satellites
        let idx = 0;
        while (idx < outerAngles.length && outerAngles[idx] < idealTargetSolarAngle) idx++;
        const neighbors = [outerSats[(idx - 1 + outerSats.length) % outerSats.length], outerSats[idx % outerSats.length]];

        neighbors.forEach((outerSat) => {
          if (outerSat.inwards !== null) return;
          if (linkCounts[outerSat.name] >= this.simLinkBudget.getMaxLinksPerRing(outerSat.ringName)) return;

          const distanceAU = this.calculateDistanceAU(positions[innerSat.name], positions[outerSat.name]);
          if (distanceAU > this.simLinkBudget.maxDistanceAU) return;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbps = this.calculateGbps(distanceKm);

          candidates.push({ from: innerSat, to: outerSat, distanceAU, distanceKm, gbps });
        });
      });

      // Sort by distance (shortest = best)
      candidates.sort((a, b) => a.distanceAU - b.distanceAU);

      // Greedily assign non-conflicting links
      const used = new Set();
      let linksAdded = 0;

      for (const { from, to, distanceAU, distanceKm, gbps } of candidates) {
        if (used.has(from.name) || used.has(to.name)) continue;
        if (linkCounts[from.name] >= this.simLinkBudget.getMaxLinksPerRing(from.ringName)) continue;
        if (linkCounts[to.name] >= this.simLinkBudget.getMaxLinksPerRing(to.ringName)) continue;
        if (from.outwards !== null || to.inwards !== null) continue;

        const [fId, tId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;

        finalLinks.push({
          fromId: fId,
          toId: tId,
          distanceAU,
          distanceKm,
          latencySeconds: this.calculateLatency(distanceKm),
          gbpsCapacity: gbps,
        });

        linkCounts[from.name]++;
        linkCounts[to.name]++;
        existingLinks.add(key);
        from.outwards = to.name;
        to.inwards = from.name;
        used.add(from.name);
        used.add(to.name);
        linksAdded++;
      }

      // console.log(`→ ${linksAdded} inter-ring links added between ${inner.name} and ${outer.name}`);
    }
  }

  planetToCircularRings(rings, positions, linkCounts, finalLinks, planetRingName, targetDepartureAngle = 0) {
    // Setup
    const planetRingSatellites = rings[planetRingName] || [];
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_circ") || ringName.startsWith("ring_adapt")
    );
    const planetPort = planetRingName === "ring_earth" ? "outwards" : "inwards";
    const circularPort = planetRingName === "ring_earth" ? "inwards" : "outwards";
    const AU_IN_KM = this.AU_IN_KM;
    const planetName = planetRingName === "ring_earth" ? "Earth" : "Mars";

    // Collect destinations: all suitable satellites from circular rings
    let destinations = [];
    for (const circRingName of circularRingNames) {
      rings[circRingName].forEach((sat) => {
        if (sat.suitable && sat.suitable.includes(planetName)) {
          destinations.push(sat);
        }
      });
    }

    if (destinations.length === 0 || planetRingSatellites.length === 0) return;

    // Sort destinations and origins by solarAngle
    const sortedDestinations = destinations.sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    const sortedOrigins = planetRingSatellites.slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);

    // Generate candidates
    const candidates = [];
    let searchIdx = 0;
    for (const origin of sortedOrigins) {
      const targetAngle = origin.position.solarAngle;

      // Advance searchIdx to the first destination with solarAngle >= targetAngle
      while (searchIdx < sortedDestinations.length && sortedDestinations[searchIdx].position.solarAngle < targetAngle) {
        searchIdx++;
      }

      // Find the two closest: one before and one after, considering circular wrap
      let idx1 = searchIdx - 1;
      let idx2 = searchIdx;

      // Handle wrap-around
      if (idx1 < 0) idx1 = sortedDestinations.length - 1;
      if (idx2 >= sortedDestinations.length) idx2 = 0;

      const dest1 = sortedDestinations[idx1];
      const dest2 = sortedDestinations[idx2];

      // Add candidates if distance is within limit
      if (dest1) {
        const dist1 = this.calculateDistanceAU(positions[origin.name], positions[dest1.name]);
        if (dist1 <= this.simLinkBudget.maxDistanceAU) {
          candidates.push({ from: origin, to: dest1, distanceAU: dist1 });
        }
      }
      if (dest2 && dest2 !== dest1) {
        const dist2 = this.calculateDistanceAU(positions[origin.name], positions[dest2.name]);
        if (dist2 <= this.simLinkBudget.maxDistanceAU) {
          candidates.push({ from: origin, to: dest2, distanceAU: dist2 });
        }
      }
    }

    // Sort candidates by distance ascending
    candidates.sort((a, b) => a.distanceAU - b.distanceAU);

    // Assign links greedily
    const existingLinks = new Set(finalLinks.map((link) => `${link.fromId}-${link.toId}`));
    let linksAdded = 0;
    for (const cand of candidates) {
      const from = cand.from;
      const to = cand.to;

      // Check link counts
      if (linkCounts[from.name] >= this.simLinkBudget.getMaxLinksPerRing(from.ringName)) continue;
      if (linkCounts[to.name] >= this.simLinkBudget.getMaxLinksPerRing(to.ringName)) continue;

      // Check ports
      if (from[planetPort] !== null || to[circularPort] !== null) continue;

      // Check for existing link
      const [fId, tId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
      const key = `${fId}-${tId}`;
      if (existingLinks.has(key)) continue;

      // Calculate metrics
      const distanceKm = cand.distanceAU * AU_IN_KM;
      const gbps = this.calculateGbps(distanceKm);

      // Add link
      finalLinks.push({
        fromId: fId,
        toId: tId,
        distanceAU: cand.distanceAU,
        distanceKm,
        latencySeconds: this.calculateLatency(distanceKm),
        gbpsCapacity: gbps,
      });

      // Update counts and ports
      linkCounts[from.name]++;
      linkCounts[to.name]++;
      from[planetPort] = to.name;
      to[circularPort] = from.name;
      existingLinks.add(key);
      linksAdded++;
    }

    console.log(`${planetRingName} <-> circular rings: ${linksAdded} connections`);
  }

  calculateEarthToMarsRoutes(finalLinks, rings) {
    // Build routes from Earth to Mars through adapted rings
    const routes = [];
    const linkMap = new Map();

    // Create a map from satellite name to satellite object
    const satMap = new Map();
    Object.values(rings).forEach((ringSats) => {
      ringSats.forEach((sat) => satMap.set(sat.name, sat));
    });

    // Create a map from satellite to its outward links
    finalLinks.forEach((link) => {
      if (!linkMap.has(link.fromId)) linkMap.set(link.fromId, []);
      linkMap.get(link.fromId).push(link);
    });

    // Start from satellites suitable for Earth with outward ports used
    const earthSuitableSats = [];
    Object.values(rings).forEach((ringSats) => {
      ringSats.forEach((sat) => {
        if (sat.suitable && sat.suitable.includes("Earth")) {
          earthSuitableSats.push(sat);
        }
      });
    });

    earthSuitableSats.forEach((startSat) => {
      if (startSat.outwards !== null) {
        // Start a route from this satellite
        const route = {
          path: [startSat.name],
          throughputMbps: Infinity,
          latencySeconds: 0,
          origin: startSat.name,
          destination: null,
        };

        let currentSat = startSat;
        let foundMars = false;

        while (currentSat && !foundMars) {
          // Follow the outward link
          if (currentSat.outwards !== null) {
            const nextSatName = currentSat.outwards;
            route.path.push(nextSatName);
            // Find the link to get metrics
            const links = linkMap.get(currentSat.name) || [];
            const outwardLink = links.find((link) => link.toId === nextSatName);
            if (outwardLink) {
              route.throughputMbps = Math.min(route.throughputMbps, outwardLink.gbpsCapacity * 1000); // convert to Mbps
              route.latencySeconds += outwardLink.latencySeconds;
            }

            // Check if nextSat is suitable for Mars
            const nextSat = satMap.get(nextSatName);
            if (nextSat && nextSat.suitable && nextSat.suitable.includes("Mars")) {
              route.destination = nextSatName;
              foundMars = true;
            }

            currentSat = nextSat;
          } else {
            break; // No outward link, end route
          }
        }

        if (route.destination) {
          routes.push(route);
        }
      }
    });

    // Calculate summary
    if (routes.length > 0) {
      const totalThroughput = routes.reduce((sum, r) => sum + r.throughputMbps, 0);
      const throughputs = routes.map((r) => r.throughputMbps);
      const minThroughput = Math.min(...throughputs);
      const maxThroughput = Math.max(...throughputs);
      const weightedAvgThroughput = routes.reduce((sum, r) => sum + r.throughputMbps * r.throughputMbps, 0) / totalThroughput;
      const latencies = routes.map((r) => r.latencySeconds);
      const minLatency = Math.min(...latencies);
      const maxLatency = Math.max(...latencies);
      const weightedAvgLatency = routes.reduce((sum, r) => sum + r.latencySeconds * r.throughputMbps, 0) / totalThroughput;

      // Helper function to format throughput
      const formatThroughput = (value) => {
        if (value >= 1000) {
          return `${(value / 1000).toFixed(1)} Gbps`;
        } else {
          return `${value.toFixed(0)} Mbps`;
        }
      };

      // Display in info-area-capacity
      const infoDiv = document.getElementById("info-area-capacity");
      if (infoDiv) {
        infoDiv.innerHTML = "";
        infoDiv.innerHTML += `<div>Adapted rings:<br>${formatThroughput(totalThroughput)} via ${routes.length} routes`;
        infoDiv.innerHTML += `Route ${minThroughput.toFixed(1)} | ${weightedAvgThroughput.toFixed(1)} | ${maxThroughput.toFixed(
          1
        )} Mbps<br>`;
        infoDiv.innerHTML += `Latency ${(minLatency / 60).toFixed(1)} | ${(weightedAvgLatency / 60).toFixed(1)} | ${(
          maxLatency / 60
        ).toFixed(1)} minutes</div>`;
      }
    }
  }

  connectEccentricAndCircularRings(rings, positions, linkCounts, finalLinks) {
    // Step 1: Identify eccentric rings and circular rings
    const eccentricRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_ecce"));
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_circ") || ringName.startsWith("ring_adapt")
    );

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
    const latencies = {}; // Edge latencies
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
    const addEdge = (fromId, toId, capacity, latency) => {
      if (!graph[fromId].includes(toId)) {
        graph[fromId].push(toId);
      }
      if (!graph[toId].includes(fromId)) {
        graph[toId].push(fromId);
      }
      const edgeKey = `${fromId}_${toId}`;
      capacities[edgeKey] = capacity;
      latencies[edgeKey] = latency;
      const reverseEdgeKey = `${toId}_${fromId}`;
      capacities[reverseEdgeKey] = capacity; // Same capacity in reverse
      latencies[reverseEdgeKey] = latency; // Same latency in reverse
    };

    // Add All Links (Bidirectional)
    finalLinks.forEach((link) => {
      const { fromId, toId, gbpsCapacity, latencySeconds } = link;

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

      addEdge(fromNodeId, toNodeId, gbpsCapacity, latencySeconds);
    });

    console.log("Graph Construction Complete:", graph);

    // Implement the Edmonds-Karp Algorithm
    const source = nodeIds.get("Earth");
    const sink = nodeIds.get("Mars");

    // --- STEP 1: SIMPLIFY ---
    const simplificationStack = []; // Initialize Stack
    const linksBefore = Object.keys(capacities).length / 2;

    // Pass the stack to the function
    this.simplifyNetwork(graph, capacities, latencies, source, sink, simplificationStack);

    const linksAfter = Object.keys(capacities).length / 2;
    console.log(`Graph simplification: ${linksBefore} -> ${linksAfter} links`);

    // --- STEP 2: RUN MAX FLOW ---
    // Max flow runs on the simplified graph (very fast)
    const maxFlowResult = this.edmondsKarp(graph, capacities, source, sink, perfStart, calctimeMs);

    if (maxFlowResult === null) return { links: [], maxFlowGbps: 0, error: "timed out" };

    // --- STEP 3: DESIMPLIFY ---
    // Restore the graph structure and map flows back to physical satellites
    this.desimplifyNetwork(graph, maxFlowResult.flows, simplificationStack);

    // --- STEP 4: OUTPUT GENERATION ---
    // Now graph and flows match the original physical satellites.
    // calculateLatencies and visualization will work normally.

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
          gbpsFlow: Math.round(netFlow * 1e6) / 1e6,
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
          gbpsFlow: Math.round(-netFlow * 1e6) / 1e6,
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
   * Simplifies the network by merging series nodes and records the history.
   * @param {Array} simplificationStack - Array to store merge history (passed from getNetworkData).
   */
  simplifyNetwork(graph, capacities, latencies, source, sink, simplificationStack) {
    const nodesBefore = Object.keys(graph).length;
    const edgesBefore = Object.keys(capacities).length / 2;
    let changed = true;

    while (changed) {
      changed = false;
      const nodes = Object.keys(graph);

      for (const nodeKey of nodes) {
        const node = parseInt(nodeKey);

        // Safety Checks
        if (node === source || node === sink) continue;
        if (!graph[node]) continue;

        const neighbors = graph[node];

        // Identify Series Candidate (Degree 2)
        if (neighbors.length === 2) {
          const u = neighbors[0];
          const v = neighbors[1];

          if (u === v || u === node || v === node) continue;

          // --- DEFINE KEYS ---
          const u_B = `${u}_${node}`;
          const B_v = `${node}_${v}`;
          const v_B = `${v}_${node}`;
          const B_u = `${node}_${u}`;

          const u_v = `${u}_${v}`; // New Virtual Edge
          const v_u = `${v}_${u}`;

          // --- 1. RECORD HISTORY (For Desimplification) ---
          simplificationStack.push({
            removedNode: node,
            u: u,
            v: v,
            // We only strictly need to know which nodes were involved,
            // but tracking keys helps debugging.
            u_v_key: u_v,
            v_u_key: v_u,
          });

          // --- 2. CALCULATE NEW ATTRIBUTES ---
          // U -> V
          const cap_u_v = Math.min(capacities[u_B] || 0, capacities[B_v] || 0);
          const lat_u_v = (latencies[u_B] || 0) + (latencies[B_v] || 0);

          // V -> U
          const cap_v_u = Math.min(capacities[v_B] || 0, capacities[B_u] || 0);
          const lat_v_u = (latencies[v_B] || 0) + (latencies[B_u] || 0);

          // --- 3. UPDATE TOPOLOGY ---

          // Remove B from U, Add V to U
          graph[u] = graph[u].filter((n) => n !== node);
          if (!graph[u].includes(v)) graph[u].push(v);

          // Remove B from V, Add U to V
          graph[v] = graph[v].filter((n) => n !== node);
          if (!graph[v].includes(u)) graph[v].push(u);

          // --- 4. UPDATE CAPACITIES/LATENCIES ---
          capacities[u_v] = (capacities[u_v] || 0) + cap_u_v;
          latencies[u_v] = lat_u_v;

          capacities[v_u] = (capacities[v_u] || 0) + cap_v_u;
          latencies[v_u] = lat_v_u;

          // --- 5. CLEANUP ---
          delete graph[node];
          delete capacities[u_B];
          delete capacities[B_v];
          delete capacities[v_B];
          delete capacities[B_u];
          delete latencies[u_B];
          delete latencies[B_v];
          delete latencies[v_B];
          delete latencies[B_u];

          changed = true;
          // Restart loop is safer to avoid index issues with Object.keys
          // But purely for performance in JS engines, we can often continue
          // if we check if graph[node] exists.
          // For safety in this specific algorithm, break is good.
          // break;
        }
      }
    }
  }
  /**
   * Restores the graph topology and maps flows from virtual edges back to physical edges.
   */
  desimplifyNetwork(graph, flows, simplificationStack) {
    // Process the stack LIFO (Last In, First Out)
    while (simplificationStack.length > 0) {
      const operation = simplificationStack.pop();
      const { removedNode, u, v, u_v_key, v_u_key } = operation;
      const b = removedNode;

      // --- 1. GET CALCULATED FLOW ON VIRTUAL EDGE ---
      const flow_u_v = flows[u_v_key] || 0;
      const flow_v_u = flows[v_u_key] || 0;

      // --- 2. RESTORE TOPOLOGY ---
      // Re-add B to graph
      graph[b] = [u, v];

      // Re-connect U to B, Disconnect U from V
      // Note: We assume U and V were only connected via B.
      // If a parallel edge existed, we simply remove the virtual link instance.
      graph[u] = graph[u].filter((n) => n !== v);
      graph[u].push(b);

      // Re-connect V to B, Disconnect V from U
      graph[v] = graph[v].filter((n) => n !== u);
      graph[v].push(b);

      // --- 3. DISTRIBUTE FLOW ---
      // The flow that went U -> V must now go U -> B -> V

      // Assign Forward Flow (U -> B -> V)
      const u_b = `${u}_${b}`;
      const b_v = `${b}_${v}`;
      flows[u_b] = (flows[u_b] || 0) + flow_u_v;
      flows[b_v] = (flows[b_v] || 0) + flow_u_v;

      // Assign Reverse Flow (V -> B -> U)
      const v_b = `${v}_${b}`;
      const b_u = `${b}_${u}`;
      flows[v_b] = (flows[v_b] || 0) + flow_v_u;
      flows[b_u] = (flows[b_u] || 0) + flow_v_u;

      // --- 4. CLEANUP VIRTUAL FLOW KEYS ---
      // We remove the flow from the virtual shortcut so the visualizer doesn't draw it
      delete flows[u_v_key];
      delete flows[v_u_key];
    }
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
