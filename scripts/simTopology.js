// simTopology.js — Topology building logic extracted from SimNetwork.

import { SIM_CONSTANTS } from "./simConstants.js";

export class TopologyBuilder {
  constructor(simLinkBudget, simSatellites) {
    this.AU_IN_KM = SIM_CONSTANTS.AU_IN_KM;
    this.SPEED_OF_LIGHT_KM_S = SIM_CONSTANTS.SPEED_OF_LIGHT_KM_S;
    this.simLinkBudget = simLinkBudget;
    this.simSatellites = simSatellites;
  }

  // Helper Functions

  calculateDistanceAU(a, b) {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
  }

  calculateGbps(distanceKm) {
    return this.simLinkBudget.calculateGbps(distanceKm);
  }

  calculateLatency(distanceKm) {
    return distanceKm / this.SPEED_OF_LIGHT_KM_S;
  }

  calculateDistanceToSunAU(position) {
    return Math.sqrt(Math.pow(position.x, 2) + Math.pow(position.y, 2) + Math.pow(position.z, 2));
  }

  // Returns true if the link between posA and posB is blinded by the sun.
  // A link is blinded when, from either endpoint's perspective, the other
  // endpoint appears within (sun angular radius + margin) of the sun center.
  isSolarBlinded(posA, posB) {
    const marginRad = this.simLinkBudget.solarExclusionRad || 0;
    if (marginRad <= 0) return false;
    const sunR = SIM_CONSTANTS.SUN_RADIUS_AU;

    const checkEndpoint = (p, other) => {
      // Vector from p to sun (origin) = -p
      const distToSun = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      if (distToSun <= sunR) return true; // inside the sun (shouldn't happen)
      // Vector from p to other
      const dx = other.x - p.x, dy = other.y - p.y, dz = other.z - p.z;
      const distToOther = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distToOther === 0) return false;
      // Angle between (-p) and (other - p) — dot product / magnitudes
      const dot = -p.x * dx - p.y * dy - p.z * dz;
      const cosAngle = dot / (distToSun * distToOther);
      // Sun angular radius from p
      const sunAngularRad = Math.asin(Math.min(1, sunR / distToSun));
      const threshold = Math.cos(sunAngularRad + marginRad);
      return cosAngle > threshold;
    };

    return checkEndpoint(posA, posB) || checkEndpoint(posB, posA);
  }

  // Active topology methods

  intraRing(rings, positions, linkCounts, finalLinks, existingLinks) {
    // Create neighbor links for all rings (including Mars and Earth)
    // existingLinks is a shared Set of "${fromId}-${toId}" keys, mutated here.

    const AU_IN_KM = this.AU_IN_KM;

    let linksAdded = 0;

    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    // Iterate through each ring
    for (const [ringName, ringSatellites] of Object.entries(rings)) {
      // Cache the ring's max-links value once (was called 3× per inner iteration)
      const maxLinksPerRing = this.simLinkBudget.getMaxLinksPerRing(ringName);
      if (maxLinksPerRing === 2) continue;

      // Pre-build name->satellite Map for O(1) neighbor lookup
      const satByName = new Map();
      for (const sat of ringSatellites) satByName.set(sat.name, sat);

      for (const satellite of ringSatellites) {
        // Early termination if satellite has reached max links
        if (linkCounts[satellite.name] >= maxLinksPerRing) continue;

        // Cache the satellite's position once
        const satPos = positions[satellite.name];
        if (!satPos) continue;
        const satSolar = satPos.solarAngle;
        const satName = satellite.name;

        for (const neighborName of satellite.neighbors) {
          // Cache neighbor position
          const neighPos = positions[neighborName];
          if (!neighPos) continue;

          // Early termination if neighbor has reached max links
          if (linkCounts[neighborName] >= maxLinksPerRing) continue;

          // Order the IDs lexicographically to avoid duplicate links
          const [fromId, toId] = satName < neighborName ? [satName, neighborName] : [neighborName, satName];

          const linkKey = `${fromId}-${toId}`;

          // Check if the link already exists using the Set
          if (existingLinks.has(linkKey)) continue;

          // Determine directions (considering circular solar angles)
          const neighSolar = neighPos.solarAngle;
          const delta = (neighSolar - satSolar + 360) % 360;
          let directionSat, directionNeigh;
          if (delta <= 180) {
            directionSat = "prograde";
            directionNeigh = "retrograde";
          } else {
            directionSat = "retrograde";
            directionNeigh = "prograde";
          }

          // Check if ports are available — O(1) Map lookup instead of .find()
          const neighborSat = satByName.get(neighborName);
          if (!neighborSat) continue;
          if (satellite[directionSat] !== null || neighborSat[directionNeigh] !== null) continue;

          // Calculate distances and other metrics
          const distanceAU = this.calculateDistanceAU(satPos, neighPos);

          // Enforce maximum distance constraint
          if (distanceAU > maxDistanceAU) continue;
          // Solar blinding check
          if (this.isSolarBlinded(satPos, neighPos)) continue;

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
          if (linkCounts[satName] >= maxLinksPerRing) {
            break; // Exit the neighbors loop for this satellite
          }
        }
      }
    }

  }

  interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_adapt_"));

    if (circularRingNames.length === 0) return;

    // Extract numeric index from ring name: ring_circ_5 -> 5, ring_adapt_12 -> 12
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

    // Sort by index (Earth -> Mars direction)
    ringList.sort((a, b) => a.index - b.index);

    const AU_IN_KM = this.AU_IN_KM;

    // Precompute sorted satellites per ring
    const ringSatellites = {};
    ringList.forEach((ring) => {
      ringSatellites[ring.name] = rings[ring.name]
        .filter((sat) => sat.orbitalZone === "BETWEEN_EARTH_AND_MARS")
        .slice()
        .sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    });

    // Cache max-links per ring once (avoids repeated lookups in hot loops)
    const ringMaxLinks = new Map();
    ringList.forEach((ring) => {
      ringMaxLinks.set(ring.name, this.simLinkBudget.getMaxLinksPerRing(ring.name));
    });

    // Pre-mark unavailable ports for 3-port rings
    ringList.forEach((ring) => {
      const maxLinks = ringMaxLinks.get(ring.name);
      if (maxLinks !== 3) return;
      ringSatellites[ring.name].forEach((sat, i) => {
        if (i % 2 === 0) sat.outwards = "premarked";
        else sat.inwards = "premarked";
      });
    });

    const normalizeAngle = (deg) => ((deg % 360) + 360) % 360;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    // Now: Only connect each ring to its IMMEDIATE NEXT (index +1)
    for (let i = 0; i < ringList.length - 1; i++) {
      const inner = ringList[i];
      const outer = ringList[i + 1];

      // Critical check: Only connect if indices are consecutive!
      if (outer.index !== inner.index + 1) {
        continue;
      }

      const innerSats = ringSatellites[inner.name];
      const outerSats = ringSatellites[outer.name];
      const outerAngles = outerSats.map((s) => s.position.solarAngle);

      const rInner = inner.radius;
      const rOuter = outer.radius;
      const departureRad = (targetDepartureAngle * Math.PI) / 180;
      const innerMaxLinks = ringMaxLinks.get(inner.name);
      const outerMaxLinks = ringMaxLinks.get(outer.name);
      const isFirstRing = inner.index === ringList[0].index;

      const candidates = [];

      for (let idx = 0; idx < innerSats.length; idx++) {
        const innerSat = innerSats[idx];
        // Port & link budget checks
        const canConnectOut = isFirstRing && innerMaxLinks === 3 ? idx % 2 === 1 : linkCounts[innerSat.name] < innerMaxLinks;

        if (!canConnectOut || innerSat.outwards !== null) continue;

        // Cache inner sat position once
        const innerPos = positions[innerSat.name];
        if (!innerPos) continue;

        // Approximate ideal target solar angle using geometry
        const distEst = rOuter - rInner;
        const tanOffset = distEst * Math.tan(departureRad);
        const angularOffsetRad = Math.atan2(tanOffset, rOuter);
        const idealTargetSolarAngle = normalizeAngle(innerPos.solarAngle + (angularOffsetRad * 180) / Math.PI);

        // Binary search for closest satellites
        let oIdx = 0;
        while (oIdx < outerAngles.length && outerAngles[oIdx] < idealTargetSolarAngle) oIdx++;
        const n1 = outerSats[(oIdx - 1 + outerSats.length) % outerSats.length];
        const n2 = outerSats[oIdx % outerSats.length];

        for (const outerSat of [n1, n2]) {
          if (outerSat.inwards !== null) continue;
          if (linkCounts[outerSat.name] >= outerMaxLinks) continue;

          const outerPos = positions[outerSat.name];
          if (!outerPos) continue;

          const distanceAU = this.calculateDistanceAU(innerPos, outerPos);
          if (distanceAU > maxDistanceAU) continue;
          if (this.isSolarBlinded(innerPos, outerPos)) continue;

          const distanceKm = distanceAU * AU_IN_KM;
          const gbps = this.calculateGbps(distanceKm);

          candidates.push({ from: innerSat, to: outerSat, distanceAU, distanceKm, gbps });
        }
      }

      // Sort by distance (shortest = best)
      candidates.sort((a, b) => a.distanceAU - b.distanceAU);

      // Greedily assign non-conflicting links
      const used = new Set();
      let linksAdded = 0;

      for (const { from, to, distanceAU, distanceKm, gbps } of candidates) {
        if (used.has(from.name) || used.has(to.name)) continue;
        if (linkCounts[from.name] >= innerMaxLinks) continue;
        if (linkCounts[to.name] >= outerMaxLinks) continue;
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

    }
  }

  planetToCircularRings(rings, positions, linkCounts, finalLinks, planetRingName, targetDepartureAngle = 0, existingLinks) {
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

      // Add candidates if distance is within limit and not solar-blinded
      if (dest1) {
        const dist1 = this.calculateDistanceAU(positions[origin.name], positions[dest1.name]);
        if (dist1 <= this.simLinkBudget.maxDistanceAU && !this.isSolarBlinded(positions[origin.name], positions[dest1.name])) {
          candidates.push({ from: origin, to: dest1, distanceAU: dist1 });
        }
      }
      if (dest2 && dest2 !== dest1) {
        const dist2 = this.calculateDistanceAU(positions[origin.name], positions[dest2.name]);
        if (dist2 <= this.simLinkBudget.maxDistanceAU && !this.isSolarBlinded(positions[origin.name], positions[dest2.name])) {
          candidates.push({ from: origin, to: dest2, distanceAU: dist2 });
        }
      }
    }

    // Sort candidates by distance ascending
    candidates.sort((a, b) => a.distanceAU - b.distanceAU);

    // Assign links greedily
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

  }

  /**
   * Connects Earth and Mars planets to their closest ring satellites.
   * Without these links, the max-flow algorithm has no source/sink edges.
   *
   * Earth connects to the closest ring_earth satellites.
   * Mars connects to the closest ring_mars satellites.
   * Uses high capacity (effectively infinite) so the bottleneck is the constellation, not the ground link.
   */
  planetToRingSatellites(filteredPlanets, rings, positions, linkCounts, finalLinks, existingLinks) {
    const AU_IN_KM = this.AU_IN_KM;

    const planetRingMap = {
      Earth: "ring_earth",
      Mars: "ring_mars",
    };

    for (const planet of filteredPlanets) {
      const ringName = planetRingMap[planet.name];
      if (!ringName || !rings[ringName]) continue;

      const ringSats = rings[ringName];
      const planetPos = positions[planet.name];
      if (!planetPos) continue;

      // Connect to the 2 closest ring satellites — one on each angular side of the planet
      const planetAngle = planetPos.solarAngle || 0;
      let bestBefore = null; // closest sat with angle < planet angle
      let bestAfter = null;  // closest sat with angle >= planet angle
      let minDistBefore = Infinity;
      let minDistAfter = Infinity;

      for (const sat of ringSats) {
        const satPos = positions[sat.name];
        if (!satPos) continue;
        const dist = this.calculateDistanceAU(planetPos, satPos);
        const satAngle = satPos.solarAngle || 0;
        const angleDiff = ((satAngle - planetAngle) % 360 + 360) % 360;

        if (angleDiff > 0 && angleDiff <= 180) {
          if (dist < minDistAfter) { minDistAfter = dist; bestAfter = { sat, distanceAU: dist }; }
        } else {
          if (dist < minDistBefore) { minDistBefore = dist; bestBefore = { sat, distanceAU: dist }; }
        }
      }

      const candidates = [bestBefore, bestAfter].filter(Boolean);

      let linksAdded = 0;
      for (const { sat, distanceAU } of candidates) {
        const [fromId, toId] = planet.name < sat.name ? [planet.name, sat.name] : [sat.name, planet.name];
        const key = `${fromId}-${toId}`;
        if (existingLinks.has(key)) continue;
        if (this.isSolarBlinded(planetPos, positions[sat.name])) continue;

        const distanceKm = distanceAU * AU_IN_KM;
        const gbpsCapacity = this.calculateGbps(distanceKm);
        const latencySeconds = this.calculateLatency(distanceKm);

        finalLinks.push({ fromId, toId, distanceAU, distanceKm, latencySeconds, gbpsCapacity });
        existingLinks.add(key);
        linkCounts[planet.name]++;
        linkCounts[sat.name]++;
        linksAdded++;
      }

    }
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

    // Calculate and return summary + individual routes
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

      return {
        totalThroughput,
        routeCount: routes.length,
        minThroughput,
        avgThroughput: weightedAvgThroughput,
        maxThroughput,
        minLatency,
        avgLatency: weightedAvgLatency,
        maxLatency,
        routes, // individual routes: { path, throughputMbps, latencySeconds, origin, destination }
      };
    }
    return null;
  }

  // UNUSED — not called from buildTopology
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
    const AU_IN_KM = this.AU_IN_KM;

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
            const zoneEcc = this.simSatellites.getRadialZone(eccSatellite, eccentricRingName);
            const zoneTarget = this.simSatellites.getRadialZone(targetSatellite, targetRingName);
            if (zoneEcc === "INSIDE_EARTH" || zoneEcc === "OUTSIDE_MARS" || zoneTarget === "INSIDE_EARTH" || zoneTarget === "OUTSIDE_MARS")
              continue;

            // Calculate distanceAU
            const distanceAU = this.calculateDistanceAU(positions[eccSatellite.name], positions[targetSatellite.name]);

            // Enforce maximum distance constraint
            if (distanceAU > this.simLinkBudget.maxDistanceAU) continue;
            if (this.isSolarBlinded(positions[eccSatellite.name], positions[targetSatellite.name])) continue;

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
    }

  }

  // UNUSED — not called from buildTopology
  interCircularRings(rings, positions, linkCounts, finalLinks, portUsage, targetDepartureAngle = 0) {
    const circularRingNames = Object.keys(rings).filter((ringName) => ringName.startsWith("ring_circ_"));

    if (circularRingNames.length === 0) return;

    // Extract numeric index from ring name: ring_circ_5 -> 5, ring_adapt_12 -> 12
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

    // Sort by index (Earth -> Mars direction)
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
        continue;
      }

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
          if (this.isSolarBlinded(positions[innerSat.name], positions[outerSat.name])) return;

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

    }
  }

  // UNUSED — not called from buildTopology
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
          const zoneEcc = this.simSatellites.getRadialZone(eccSatellite, ecceRingName);
          const circRingName = circularRingNames.find((r) => rings[r].includes(circSatellite));
          const zoneCirc = this.simSatellites.getRadialZone(circSatellite, circRingName);
          if (zoneEcc === "INSIDE_EARTH" || zoneEcc === "OUTSIDE_MARS" || zoneCirc === "INSIDE_EARTH" || zoneCirc === "OUTSIDE_MARS")
            return;

          const distanceAU = this.calculateDistanceAU(positions[eccSatellite.name], positions[circSatellite.name]);
          // Enforce maximum distance constraint
          if (distanceAU > this.simLinkBudget.maxDistanceAU) return;
          if (this.isSolarBlinded(positions[eccSatellite.name], positions[circSatellite.name])) return;

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

    // Pre-build existing link Set for O(1) duplicate checking
    const existingLinkSet = new Set(finalLinks.map((l) => `${l.fromId}-${l.toId}`));

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

      // Check if the link already exists — O(1) Set lookup instead of .some()
      if (existingLinkSet.has(`${orderedFromId}-${orderedToId}`)) return;

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
      existingLinkSet.add(`${orderedFromId}-${orderedToId}`);

      linksAdded++;
    });

  }

  /**
   * Generates all possible links between planets and satellites.
   * This is the orchestration logic previously in SimNetwork.getPossibleLinks().
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @returns {Array} links - Array of link objects.
   */
  buildTopology(planets, satellites) {
    const t0 = performance.now();
    const timings = {};
    const mark = (name, start) => { timings[name] = Math.round(performance.now() - start); };

    let t = performance.now();
    const rings = {};
    satellites.forEach((satellite) => {
      const ringName = satellite.ringName;
      if (!rings[ringName]) rings[ringName] = [];
      rings[ringName].push(satellite);
    });
    const positions = {};
    satellites.forEach((satellite) => { positions[satellite.name] = satellite.position; });
    const linkCounts = {};
    satellites.forEach((satellite) => {
      linkCounts[satellite.name] = 0;
      satellite.prograde = null;
      satellite.retrograde = null;
      satellite.outwards = null;
      satellite.inwards = null;
    });
    const filteredPlanets = planets.filter((planet) => planet.name === "Earth" || planet.name === "Mars");
    filteredPlanets.forEach((planet) => {
      positions[planet.name] = planet.position;
      linkCounts[planet.name] = 0;
      planet.prograde = null;
      planet.retrograde = null;
      planet.outwards = null;
      planet.inwards = null;
    });
    mark("setup", t);

    const finalLinks = [];
    const existingLinks = new Set();
    const targetDepartureAngle = 0;

    t = performance.now();
    this.intraRing(rings, positions, linkCounts, finalLinks, existingLinks);
    mark("intraRing", t);

    t = performance.now();
    this.interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks);
    mark("interAdaptedRings", t);

    t = performance.now();
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_mars", targetDepartureAngle, existingLinks);
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_earth", targetDepartureAngle, existingLinks);
    mark("planetToRings", t);

    t = performance.now();
    this.planetToRingSatellites(filteredPlanets, rings, positions, linkCounts, finalLinks, existingLinks);
    mark("planetLinks", t);

    t = performance.now();
    this.routeSummary = this.calculateEarthToMarsRoutes(finalLinks, rings);
    mark("routes", t);

    t = performance.now();
    this.topologyInfo = this.captureTopologyInfo(rings, finalLinks);
    mark("captureTopology", t);

    timings.total = Math.round(performance.now() - t0);
    timings.links = finalLinks.length;
    this.lastTopologyTimings = timings;

    return finalLinks;
  }

  /**
   * Captures structured topology info for the topology-aware max-flow algorithm.
   * Returns ring chains (ordered from planet-connected sat outward), planet links,
   * and individual routes. Returns null if structure is incomplete.
   *
   * Ring naming convention:
   *   ring_earth-N    = positive-side chain  (planet → -0 → -1 → ... → -K)
   *   ring_earth--N   = negative-side chain  (planet → --0 → --1 → ... → --K)
   *
   * @param {Object} rings - { ringName: [satellite objects...] }
   * @param {Array} finalLinks
   * @returns {Object|null}
   */
  captureTopologyInfo(rings, finalLinks) {
    const earthRing = rings["ring_earth"] || [];
    const marsRing = rings["ring_mars"] || [];
    if (earthRing.length === 0 || marsRing.length === 0) return null;
    if (!this.routeSummary || !this.routeSummary.routes) return null;

    // Build ordered chains by parsing sat names.
    // A name like "ring_earth-3" has suffix "-3" (positive side).
    // A name like "ring_earth--3" has suffix "--3" (negative side).
    const buildChains = (ringSats, ringName) => {
      const positive = new Map(); // idx -> name
      const negative = new Map();
      const prefix = ringName + "-";
      for (const sat of ringSats) {
        const name = sat.name;
        if (!name.startsWith(prefix)) continue;
        const suffix = name.slice(prefix.length);
        if (suffix.startsWith("-")) {
          // Negative side: "-N" → N
          const idx = parseInt(suffix.slice(1));
          if (!isNaN(idx)) negative.set(idx, name);
        } else {
          // Positive side: "N"
          const idx = parseInt(suffix);
          if (!isNaN(idx)) positive.set(idx, name);
        }
      }
      const toOrderedList = (map) => {
        const keys = Array.from(map.keys()).sort((a, b) => a - b);
        return keys.map((k) => map.get(k));
      };
      return {
        positive: toOrderedList(positive),
        negative: toOrderedList(negative),
      };
    };

    const earthChains = buildChains(earthRing, "ring_earth");
    const marsChains = buildChains(marsRing, "ring_mars");

    // Find planet links (Earth→sat and Mars→sat)
    const earthPlanetLinks = finalLinks.filter((l) => l.fromId === "Earth" || l.toId === "Earth");
    const marsPlanetLinks = finalLinks.filter((l) => l.fromId === "Mars" || l.toId === "Mars");

    // Build a lookup map for quick link retrieval
    const linkByKey = new Map();
    for (const link of finalLinks) {
      linkByKey.set(`${link.fromId}_${link.toId}`, link);
      linkByKey.set(`${link.toId}_${link.fromId}`, link);
    }

    // --- Collapse ring chains into segments between "important" sats ---
    // A ring sat is "important" if it has a connection outside intra-ring:
    //   - planet link (ring_earth-0 → Earth)
    //   - outwards/inwards link to an adapted ring sat
    // Segments between important sats are pure degree-2 chains that can be
    // collapsed into a single virtual edge with capacity=min and latency=sum.
    const hasExtraRingLink = (satName, ringPrefix) => {
      // Look for any link from satName to a non-ring sat
      const neighbors = [];
      const linkKey1 = linkByKey.get(`${satName}_`);
      // Scan linkByKey is expensive; instead iterate finalLinks filtered by satName.
      // Build an outgoing-link index once instead (below).
      return neighbors;
    };

    // Build per-sat outgoing link index for the ring sats
    const satOutgoing = new Map(); // satName -> [link, ...]
    for (const link of finalLinks) {
      const a = link.fromId;
      const b = link.toId;
      if (!satOutgoing.has(a)) satOutgoing.set(a, []);
      satOutgoing.get(a).push(link);
      if (!satOutgoing.has(b)) satOutgoing.set(b, []);
      satOutgoing.get(b).push(link);
    }

    // Collapse a single chain (e.g. earthChains.positive) into segments.
    // Returns array of segments: [{ from, to, capacity, latency, physicalEdges: [...], virtualKey }]
    // where physicalEdges is the list of edge keys (both directions) in the segment.
    // `from` is the important sat closer to the planet (index 0 side).
    // The first segment may start at chain[0] if it's important.
    const collapseChain = (chain, ringPrefix, ringSegmentPrefix) => {
      if (chain.length === 0) return [];

      // Identify important sats: any sat in the chain with a link to a non-chain neighbor.
      // Chain neighbors are predictable: chain[i-1] and chain[i+1] in the same chain.
      const chainSet = new Set(chain);
      const importantIndices = [];
      for (let i = 0; i < chain.length; i++) {
        const satName = chain[i];
        const outgoing = satOutgoing.get(satName) || [];
        let hasExtra = false;
        for (const link of outgoing) {
          const other = link.fromId === satName ? link.toId : link.fromId;
          if (!chainSet.has(other)) {
            hasExtra = true;
            break;
          }
        }
        if (hasExtra) importantIndices.push(i);
      }

      // Build segments between consecutive important sats.
      // Also: if chain[0] is important, we need a "segment" that's just the sat itself
      // (the planet link connects to it). Segments only cover intra-ring walks.
      const segments = [];
      let segmentId = 0;
      for (let s = 0; s < importantIndices.length - 1; s++) {
        const startIdx = importantIndices[s];
        const endIdx = importantIndices[s + 1];
        // Walk intra-ring links from chain[startIdx] to chain[endIdx]
        let minCap = Infinity;
        let sumLat = 0;
        const physicalEdges = [];
        let valid = true;
        for (let i = startIdx; i < endIdx; i++) {
          const key = `${chain[i]}_${chain[i + 1]}`;
          const link = linkByKey.get(key);
          if (!link) { valid = false; break; }
          if (link.gbpsCapacity < minCap) minCap = link.gbpsCapacity;
          sumLat += link.latencySeconds;
          physicalEdges.push({ from: chain[i], to: chain[i + 1] });
        }
        if (!valid || minCap === Infinity) continue;
        segments.push({
          from: chain[startIdx],
          to: chain[endIdx],
          capacity: minCap,
          latency: sumLat,
          physicalEdges,
          virtualKey: `${ringSegmentPrefix}_${segmentId++}`,
        });
      }
      return segments;
    };

    const earthCollapsed = {
      positive: collapseChain(earthChains.positive, "ring_earth", "seg_earth_pos"),
      negative: collapseChain(earthChains.negative, "ring_earth", "seg_earth_neg"),
    };
    const marsCollapsed = {
      positive: collapseChain(marsChains.positive, "ring_mars", "seg_mars_pos"),
      negative: collapseChain(marsChains.negative, "ring_mars", "seg_mars_neg"),
    };

    return {
      earthChains, // { positive: [...names], negative: [...names] }
      marsChains,
      earthCollapsed, // { positive: [...segments], negative: [...segments] }
      marsCollapsed,
      earthPlanetLinks,
      marsPlanetLinks,
      linkByKey,
      allLinks: finalLinks,
      routes: this.routeSummary.routes,
    };
  }
}
