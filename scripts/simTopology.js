// simTopology.js — Topology building logic extracted from SimNetwork.

import { SIM_CONSTANTS } from "./simConstants.js?v=4.6";

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
    // Both concentric relay families share this radial-backbone construction:
    // adapted concentric (ring_adapt_) and circular (ring_circ_). Only one relay
    // type is active at a time, so merging the prefixes here can't collide ring
    // indices across families in practice.
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_adapt_") || ringName.startsWith("ring_circ_")
    );

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
      // A ring whose satellites all fall outside the between-Earth-and-Mars zone
      // (e.g. an adapted ring pushed inside Earth / outside Mars by the endpoint
      // anchors) is filtered to empty above — skip it so the %-length indexing
      // below can't divide by zero and read .inwards of undefined.
      if (!innerSats.length || !outerSats.length) continue;
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

        // Binary search to the radially-nearest outer sat, then scan a small angular
        // window around it. A purely-radial concentric link is sun-aligned — the inner
        // sat sits between the outer sat and the Sun — so it gets solar-blinded; for
        // plain circular rings the nearest (radial) outer sat is almost always unusable.
        // Scanning a window lets the greedy pick the nearest NON-blinded outer sat: a
        // slightly angularly-offset (diagonal) link that still advances one ring outward
        // and clears the Sun. Adapted rings, whose consecutive rings are phase-shifted by
        // their Earth↔Mars element blend, already find their nearest sat unblinded, so
        // they keep matching it (the window only adds farther fallbacks they don't use).
        let oIdx = 0;
        while (oIdx < outerAngles.length && outerAngles[oIdx] < idealTargetSolarAngle) oIdx++;
        const OUTER_WINDOW = 20;
        const oLen = outerSats.length;
        for (let w = -OUTER_WINDOW; w <= OUTER_WINDOW; w++) {
          const outerSat = outerSats[(((oIdx + w) % oLen) + oLen) % oLen];
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
    // Concentric relay families (ring_circ_, ring_adapt_) attach to the planet rings
    // through their planet-`suitable` sats — the flag (from ring↔planet-orbit
    // crossings) correctly marks the innermost ring as Earth-side and the outermost
    // as Mars-side for nested concentric rings. Eccentric families are NOT handled
    // here: their overlapping ellipses break the "single closest ring" assumption
    // behind `suitable`, so they attach by physical proximity in planetToEccentricRings.
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

      // Scan an angular window around the insertion point rather than just the two
      // immediate neighbours. A planet ring and an adjacent concentric relay ring sit
      // at different radii, so the radially-nearest attachment link is sun-aligned and
      // solar-blinded (worst on the Earth side, where the gap to the first ring is
      // largest). The window exposes slightly angularly-offset (diagonal) destinations
      // that clear the Sun; the greedy below still prefers the shortest of them.
      const DEST_WINDOW = 20;
      const dLen = sortedDestinations.length;
      const maxDistanceAU = this.simLinkBudget.maxDistanceAU;
      const oPos = positions[origin.name];
      const seenDest = new Set();
      for (let w = -DEST_WINDOW; w <= DEST_WINDOW; w++) {
        const di = (((searchIdx + w) % dLen) + dLen) % dLen;
        if (seenDest.has(di)) continue;
        seenDest.add(di);
        const dest = sortedDestinations[di];
        if (!dest) continue;
        const dPos = positions[dest.name];
        const dist = this.calculateDistanceAU(oPos, dPos);
        if (dist > maxDistanceAU) continue;
        if (this.isSolarBlinded(oPos, dPos)) continue;
        candidates.push({ from: origin, to: dest, distanceAU: dist });
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
   * Attaches eccentric relay families (ring_ecce_, ring_adecc_) to a planet ring near
   * each ring's TANGENT POINT with that planet's orbit (the ring sat that comes closest
   * to the planet ring). Rather than a single tangent link, the junction is GROWN from
   * the tangent point outward — adding the next-closest planet-ring↔relay links — until
   * its summed capacity meets the throughput that ring's junction must carry, so the
   * junction never bottlenecks the ring (and isn't wastefully over-provisioned).
   *
   * Per-ring design throughput  D_ring = cRing — the ring's OWN carrying capacity: the
   * combined capacity of its two azimuthal arcs between the Earth-tangent and Mars-tangent
   * sats (each arc capped by its weakest hop). The junction only needs to match what the
   * ring can actually carry; sizing it larger (e.g. to a share of the planet transmit)
   * would over-provision past the ring's own bottleneck for no throughput gain.
   *
   * Only sats within maxDistanceAU of the planet ring qualify (i.e. the tangent region),
   * so growing k naturally walks outward from the closest contact. Uses the relay sat's
   * free radial terminal — the "3rd terminal" after its two azimuthal neighbour links.
   */
  planetToEccentricRings(rings, positions, linkCounts, finalLinks, planetRingName, existingLinks) {
    const planetRingSats = rings[planetRingName] || [];
    if (planetRingSats.length === 0) return;
    const eccRingNames = Object.keys(rings).filter((r) => r.startsWith("ring_ecce") || r.startsWith("ring_adecc"));
    if (eccRingNames.length === 0) return;

    const planetPort = planetRingName === "ring_earth" ? "outwards" : "inwards";
    const relayPort = planetRingName === "ring_earth" ? "inwards" : "outwards";
    const AU_IN_KM = this.AU_IN_KM;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;
    const mbpsAt = (au) => this.calculateGbps(au * AU_IN_KM) * 1000;

    const satByName = new Map();
    Object.values(rings).forEach((rs) => rs.forEach((s) => satByName.set(s.name, s)));

    // Windowed "nearest non-blinded sat of this planet ring" finder (by solar angle).
    const makeFinder = (sats) => {
      const sorted = sats.slice().sort((a, b) => a.position.solarAngle - b.position.solarAngle);
      const angles = sorted.map((s) => s.position.solarAngle);
      const N = sorted.length, WIN = 8;
      return (rPos) => {
        const ang = rPos.solarAngle;
        let lo = 0, hi = N;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (angles[mid] < ang) lo = mid + 1; else hi = mid; }
        let best = null, bestD = Infinity;
        const dlt = (a) => { const d = Math.abs(a - ang) % 360; return d > 180 ? 360 - d : d; };
        for (let step = 0; step < N; step++) {
          const up = (lo + step) % N, dn = (lo - 1 - step + N) % N; let stop = true;
          for (const i of step === 0 ? [up] : [up, dn]) {
            if (dlt(angles[i]) <= WIN) {
              stop = false; const c = sorted[i]; const cp = positions[c.name];
              if (cp && !this.isSolarBlinded(rPos, cp)) { const d = this.calculateDistanceAU(rPos, cp); if (d < bestD) { bestD = d; best = c; } }
            }
          }
          if (stop) break;
        }
        return { sat: best, dist: bestD };
      };
    };
    const earthSats = rings["ring_earth"], marsSats = rings["ring_mars"];
    const findEarth = earthSats && earthSats.length ? makeFinder(earthSats) : null;
    const findMars = marsSats && marsSats.length ? makeFinder(marsSats) : null;
    const findThis = planetRingName === "ring_earth" ? findEarth : findMars;
    if (!findThis) return;

    // Capacity of one azimuthal arc (walk a direction port from→to, weakest hop wins).
    const arcCap = (fromSat, toSat, dir, ringLen) => {
      let cur = fromSat, minMbps = Infinity, guard = 0;
      while (cur && guard++ < ringLen + 2) {
        const nx = cur[dir];
        if (!nx) break;
        const a = positions[cur.name], b = positions[nx];
        if (a && b) minMbps = Math.min(minMbps, mbpsAt(this.calculateDistanceAU(a, b)));
        if (nx === toSat.name) return isFinite(minMbps) ? minMbps : 0;
        cur = satByName.get(nx);
      }
      return 0;
    };

    for (const ringName of eccRingNames) {
      const ringSats = rings[ringName];
      if (!ringSats || !ringSats.length) continue;

      // Earth- and Mars-tangent sats of this ring (closest ring sat to each planet ring).
      let earthTan = null, earthTanD = Infinity, marsTan = null, marsTanD = Infinity;
      for (const s of ringSats) {
        const sp = positions[s.name]; if (!sp) continue;
        if (findEarth) { const e = findEarth(sp); if (e.sat && e.dist < earthTanD) { earthTanD = e.dist; earthTan = s; } }
        if (findMars) { const m = findMars(sp); if (m.sat && m.dist < marsTanD) { marsTanD = m.dist; marsTan = s; } }
      }
      const thisTan = planetRingName === "ring_earth" ? earthTan : marsTan;
      if (!thisTan) continue;

      // cRing: combined capacity of the ring's two arcs (prograde "upsat", retrograde
      // "downsat") between its Earth- and Mars-tangent points.
      let arcUp = 0, arcDn = 0;
      if (earthTan && marsTan && earthTan !== marsTan) {
        arcUp = arcCap(earthTan, marsTan, "prograde", ringSats.length);
        arcDn = arcCap(earthTan, marsTan, "retrograde", ringSats.length);
      }
      const cRing = arcUp + arcDn;
      const dRing = cRing;

      // Candidate junction links: every ring sat within range of the planet ring, paired
      // with its nearest planet-ring sat, sorted closest-first (k grows out of the tangent).
      const cands = [];
      for (const s of ringSats) {
        const sp = positions[s.name]; if (!sp) continue;
        const f = findThis(sp);
        if (f.sat && f.dist <= maxDistanceAU) cands.push({ relay: s, planet: f.sat, dist: f.dist, mbps: mbpsAt(f.dist) });
      }
      cands.sort((a, b) => a.dist - b.dist);

      let served = 0, added = 0;
      for (const c of cands) {
        if (added >= 1 && served >= dRing) break; // always ≥1 link, then stop once the ring's own capacity is matched
        const relay = c.relay, planet = c.planet;
        if (relay[relayPort] !== null || planet[planetPort] !== null) continue;
        if (linkCounts[relay.name] >= this.simLinkBudget.getMaxLinksPerRing(relay.ringName)) continue;
        if (linkCounts[planet.name] >= this.simLinkBudget.getMaxLinksPerRing(planet.ringName)) continue;

        const [fId, tId] = relay.name < planet.name ? [relay.name, planet.name] : [planet.name, relay.name];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;

        const distanceKm = c.dist * AU_IN_KM;
        finalLinks.push({
          fromId: fId,
          toId: tId,
          distanceAU: c.dist,
          distanceKm,
          latencySeconds: this.calculateLatency(distanceKm),
          gbpsCapacity: this.calculateGbps(distanceKm),
        });
        linkCounts[relay.name]++;
        linkCounts[planet.name]++;
        relay[relayPort] = planet.name;
        planet[planetPort] = relay.name;
        existingLinks.add(key);
        served += c.mbps;
        added++;
      }

      // Record per-ring junction/route detail for the capacity card. Called once per
      // planet side; routes (arcs) are the same both calls, junctions are per planet.
      let detail = this.eccRingDetail.get(ringName);
      if (!detail) {
        const argP = ((ringSats[0] && ringSats[0].p) || 0);
        detail = {
          ringName,
          argP: ((argP % 360) + 360) % 360,
          routesCount: (arcUp > 0 ? 1 : 0) + (arcDn > 0 ? 1 : 0),
          routesMbps: cRing,
          earth: { count: 0, mbps: 0 },
          mars: { count: 0, mbps: 0 },
        };
        this.eccRingDetail.set(ringName, detail);
      }
      if (planetRingName === "ring_earth") detail.earth = { count: added, mbps: served };
      else detail.mars = { count: added, mbps: served };
    }
  }

  /**
   * Cross-links between DIFFERENT eccentric relay rings (ring_ecce_, ring_adecc_).
   *
   * Every eccentric ring is a confocal ellipse (Sun at one focus); two rings with
   * different arguments of perihelion intersect when projected onto the ecliptic
   * (xy) plane. At each such crossing this bridges the two rings where their tracks
   * meet, using each satellite's free radial terminal — the "3rd laser" left over
   * after the two azimuthal neighbour links (prograde/retrograde).
   *
   * The crossing points are STATIC geometry (the orbits never change shape), so they
   * are computed ONCE at constellation definition (SimSatellites.computeEccentric-
   * RingCrossings) and stored as { ringA, ringB, solarAngle, requiredMbps }. The solar
   * angle is the time-invariant key the nearest sat is binary-searched against;
   * requiredMbps is the junction's design throughput — the sum of the two rings' in-ring
   * capacities at the crossing.
   *
   * A single laser link may not carry requiredMbps, so the junction is GROWN: starting
   * from the closest sat pair (highest capacity, right at the crossing) and adding the
   * next-closest pairs outward. The number of links needed (requiredLinks) is precomputed
   * with the crossing, so this just places that many closest pairs — no per-build capacity
   * accounting. Runs after planetToEccentricRings so those essential radial links claim
   * their terminals first; crossings only consume what remains free.
   */
  crossEccentricRings(rings, positions, linkCounts, finalLinks, existingLinks) {
    const crossings =
      this.simSatellites && this.simSatellites.getEccentricRingCrossings
        ? this.simSatellites.getEccentricRingCrossings()
        : [];
    if (!crossings.length) return;

    const AU_IN_KM = this.AU_IN_KM;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    // Per-ring satellites sorted by solar angle, built once and memoised — the lookup
    // structure that makes "sats nearest a crossing" an O(log n) binary search + slice.
    const sortedByRing = new Map(); // ringName -> { sats: [...], angles: [...] }
    const ringSorted = (name) => {
      let entry = sortedByRing.get(name);
      if (entry === undefined) {
        const sats = (rings[name] || []).filter((s) => positions[s.name]);
        sats.sort((a, b) => positions[a.name].solarAngle - positions[b.name].solarAngle);
        entry = { sats, angles: sats.map((s) => positions[s.name].solarAngle) };
        sortedByRing.set(name, entry);
      }
      return entry;
    };

    // Circular (wrap-aware) solar-angle distance, degrees.
    const circDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

    // The WIN satellites on `name` closest (by solar angle) to targetAngle — the pool the
    // junction grows through. WIN bounds links-per-crossing (each sat has ≤2 spare radial
    // terminals, so a handful of sats per side is ample for the sum-of-two-rings target).
    const WIN = 6;
    const windowSats = (name, targetAngle) => {
      const { sats, angles } = ringSorted(name);
      const n = angles.length;
      if (n === 0) return [];
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (angles[mid] < targetAngle) lo = mid + 1; else hi = mid; }
      const seen = new Set();
      const idxs = [];
      for (let k = -WIN; k <= WIN; k++) {
        const idx = (((lo + k) % n) + n) % n;
        if (!seen.has(idx)) { seen.add(idx); idxs.push(idx); }
      }
      idxs.sort((i, j) => circDist(angles[i], targetAngle) - circDist(angles[j], targetAngle));
      return idxs.slice(0, WIN).map((i) => sats[i]);
    };

    // The "3rd laser": first free radial terminal (the azimuthal pair is the in-ring loop).
    const freeRadialPort = (sat) => (sat.outwards === null ? "outwards" : sat.inwards === null ? "inwards" : null);

    for (const { ringA, ringB, solarAngle, requiredLinks } of crossings) {
      const winA = windowSats(ringA, solarAngle);
      const winB = windowSats(ringB, solarAngle);
      if (!winA.length || !winB.length) continue;

      // Candidate cross-links near this crossing, shortest (highest-capacity) first.
      const cands = [];
      for (const a of winA) {
        const pa = positions[a.name];
        for (const b of winB) {
          if (a.name === b.name) continue;
          const pb = positions[b.name];
          const distanceAU = this.calculateDistanceAU(pa, pb);
          if (distanceAU > maxDistanceAU) continue;
          if (this.isSolarBlinded(pa, pb)) continue;
          cands.push({ a, b, distanceAU, gbps: this.calculateGbps(distanceAU * AU_IN_KM) });
        }
      }
      cands.sort((x, y) => x.distanceAU - y.distanceAU);

      // Place the precomputed number of links, closest (highest-capacity) pairs first.
      const target = Math.max(1, requiredLinks || 1);
      let added = 0;
      for (const { a, b, distanceAU, gbps } of cands) {
        if (added >= target) break;
        if (linkCounts[a.name] >= this.simLinkBudget.getMaxLinksPerRing(a.ringName)) continue;
        if (linkCounts[b.name] >= this.simLinkBudget.getMaxLinksPerRing(b.ringName)) continue;

        const portA = freeRadialPort(a);
        const portB = freeRadialPort(b);
        if (!portA || !portB) continue;

        const [fId, tId] = a.name < b.name ? [a.name, b.name] : [b.name, a.name];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;

        const distanceKm = distanceAU * AU_IN_KM;
        finalLinks.push({
          fromId: fId,
          toId: tId,
          distanceAU,
          distanceKm,
          latencySeconds: this.calculateLatency(distanceKm),
          gbpsCapacity: gbps,
        });
        linkCounts[a.name]++;
        linkCounts[b.name]++;
        a[portA] = b.name;
        b[portB] = a.name;
        existingLinks.add(key);
        added++;
      }
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

    // Undirected link lookup by endpoint pair, plus a helper that returns the
    // planet-ring endpoint hop for a relay sat: the ring_earth→first-relay-sat link
    // (a relay sat's inward neighbour) and the last-relay-sat→ring_mars link (its
    // outward neighbour). These cross-ring-type links bound the real Earth↔Mars
    // throughput but sit outside the adapted-ring chain the route walks, so they
    // must be folded into the route bottleneck explicitly.
    const linkByPair = new Map();
    finalLinks.forEach((link) => {
      linkByPair.set(link.fromId + "|" + link.toId, link);
      linkByPair.set(link.toId + "|" + link.fromId, link);
    });
    const walkToPlanetRing = (sat, port, planetRingPrefix) => {
      // Walk inward/outward along the radial ports until the planet ring is reached,
      // taking the min link capacity (Mbps) over every hop including the final
      // planet-ring hop. A route's start sat can sit several rings out from the Earth
      // ring (it's merely Earth-suitable), so a single-hop lookup would miss the real
      // ring_earth->relay bottleneck. Returns Infinity if the ring is never reached.
      let cur = sat, minMbps = Infinity, guard = 0;
      while (cur && guard++ < 2000) {
        const nextName = cur[port];
        if (!nextName) break;
        const link = linkByPair.get(cur.name + "|" + nextName);
        if (link) minMbps = Math.min(minMbps, link.gbpsCapacity * 1000);
        if (String(nextName).startsWith(planetRingPrefix)) return minMbps;
        cur = satMap.get(nextName);
      }
      return Infinity;
    };

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
          // Fold in the planet-ring endpoint hops. The relay chain above ignored
          // the ring_earth→first-sat link (startSat's inward neighbour) and the
          // last-sat→ring_mars link (the destination's outward neighbour), which are
          // typically the throughput bottleneck — without them the capacity is
          // wildly overstated (Gbps relay vs Mbps end-to-end).
          const endSat = satMap.get(route.destination);
          const earthCap = walkToPlanetRing(startSat, "inwards", "ring_earth");
          const marsCap = endSat ? walkToPlanetRing(endSat, "outwards", "ring_mars") : Infinity;
          // A route only carries Earth↔Mars traffic if its chain actually reaches BOTH
          // planet rings — the graph links Earth/Mars only to their own ring sats, so a
          // chain that never touches ring_earth (or ring_mars) has no real source/sink
          // and the max-flow sees 0 through it. Such "Earth-suitable but not Earth-
          // connected" chains were silently inflating the displayed capacity.
          if (isFinite(earthCap) && isFinite(marsCap)) {
            route.throughputMbps = Math.min(route.throughputMbps, earthCap, marsCap);
            routes.push(route);
          }
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

  /**
   * Routes for eccentric relay families (ring_ecce_, ring_adecc_). Their topology is
   * different from the concentric radial chain: each ring is a single azimuthal loop
   * tangent to Earth at one point and Mars at another, so it yields exactly TWO routes
   * — the loop's two arcs between the Earth-tangent sat and the Mars-tangent sat (2 ×
   * ring count total). Each route runs:
   *   ring_earth sat → (planet link) → Earth-tangent sat → … azimuthal hops … →
   *   Mars-tangent sat → (planet link) → ring_mars sat
   * with capacity = the smallest-capacity segment and latency = the sum of segments,
   * both planet links included. Returns the same summary shape as the concentric router.
   */
  calculateEccentricRoutes(finalLinks, rings) {
    const satMap = new Map();
    Object.values(rings).forEach((ringSats) => ringSats.forEach((sat) => satMap.set(sat.name, sat)));
    const linkByPair = new Map();
    finalLinks.forEach((link) => {
      linkByPair.set(link.fromId + "|" + link.toId, link);
      linkByPair.set(link.toId + "|" + link.fromId, link);
    });

    const eccRingNames = Object.keys(rings).filter(
      (r) => r.startsWith("ring_ecce") || r.startsWith("ring_adecc")
    );

    const routes = [];
    for (const ringName of eccRingNames) {
      const ringSats = rings[ringName];
      if (!ringSats || ringSats.length === 0) continue;

      // Attachment points (set by planetToEccentricRings): Earth-tangent sat parks its
      // planet link on `inwards`, Mars-tangent sat on `outwards`.
      let earthSat = null, earthRingSat = null, marsSat = null, marsRingSat = null;
      for (const s of ringSats) {
        if (!earthSat && s.inwards && String(s.inwards).startsWith("ring_earth")) {
          earthSat = s; earthRingSat = s.inwards;
        }
        if (!marsSat && s.outwards && String(s.outwards).startsWith("ring_mars")) {
          marsSat = s; marsRingSat = s.outwards;
        }
      }
      if (!earthSat || !marsSat) continue;

      // The two loop arcs: follow prograde one way, retrograde the other.
      for (const dir of ["prograde", "retrograde"]) {
        const path = [earthRingSat, earthSat.name];
        let minMbps = Infinity, sumLat = 0;

        // Junction links count toward LATENCY but NOT capacity: the junction is a parallel
        // bundle of k links (sized ≥ the ring's route capacity, shown separately), so a
        // single tangent link must not cap the route — the route's capacity is its arc.
        const earthLink = linkByPair.get(earthRingSat + "|" + earthSat.name);
        if (earthLink) sumLat += earthLink.latencySeconds;

        let cur = earthSat, reached = false, guard = 0;
        while (cur && guard++ < ringSats.length + 2) {
          const nextName = cur[dir];
          if (!nextName) break;
          const link = linkByPair.get(cur.name + "|" + nextName);
          if (link) { minMbps = Math.min(minMbps, link.gbpsCapacity * 1000); sumLat += link.latencySeconds; }
          path.push(nextName);
          if (nextName === marsSat.name) { reached = true; break; }
          cur = satMap.get(nextName);
        }
        if (!reached) continue;

        const marsLink = linkByPair.get(marsSat.name + "|" + marsRingSat);
        if (marsLink) sumLat += marsLink.latencySeconds; // junction: latency only, not capacity
        path.push(marsRingSat);

        if (isFinite(minMbps)) {
          routes.push({ path, throughputMbps: minMbps, latencySeconds: sumLat, origin: earthRingSat, destination: marsRingSat });
        }
      }
    }

    if (routes.length === 0) return null;

    const totalThroughput = routes.reduce((sum, r) => sum + r.throughputMbps, 0);
    const throughputs = routes.map((r) => r.throughputMbps);
    const latencies = routes.map((r) => r.latencySeconds);
    return {
      totalThroughput,
      routeCount: routes.length,
      minThroughput: Math.min(...throughputs),
      avgThroughput: totalThroughput > 0 ? routes.reduce((s, r) => s + r.throughputMbps * r.throughputMbps, 0) / totalThroughput : 0,
      maxThroughput: Math.max(...throughputs),
      minLatency: Math.min(...latencies),
      avgLatency: totalThroughput > 0 ? routes.reduce((s, r) => s + r.latencySeconds * r.throughputMbps, 0) / totalThroughput : 0,
      maxLatency: Math.max(...latencies),
      routes,
    };
  }

  // UNUSED — not called from buildTopology
  interEccentricRings(rings, positions, linkCounts, finalLinks) {
    // Step 1: Identify valid rings (eccentric and circular rings)
    const eccentricRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_ecce") || ringName.startsWith("ring_adecc")
    );
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
      // A ring whose satellites all fall outside the between-Earth-and-Mars zone
      // (e.g. an adapted ring pushed inside Earth / outside Mars by the endpoint
      // anchors) is filtered to empty above — skip it so the %-length indexing
      // below can't divide by zero and read .inwards of undefined.
      if (!innerSats.length || !outerSats.length) continue;
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
    const eccentricRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_ecce") || ringName.startsWith("ring_adecc")
    );
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
    // Per-ring junction/route detail for the capacity card, populated by
    // planetToEccentricRings (one entry per eccentric relay ring).
    this.eccRingDetail = new Map();

    // Concentric relay rings (circular / adapted concentric) take their radial
    // backbone FIRST so the first two terminals go inward/outward to neighbour
    // rings. intraRing then fills any spare terminals with azimuthal neighbour
    // links. (For 2-port adapted concentric there is nothing left over, so it
    // stays radial-only; 4-port circular gets a radial+azimuthal grid.)
    t = performance.now();
    this.interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks);
    mark("interAdaptedRings", t);

    t = performance.now();
    this.intraRing(rings, positions, linkCounts, finalLinks, existingLinks);
    mark("intraRing", t);

    t = performance.now();
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_mars", targetDepartureAngle, existingLinks);
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_earth", targetDepartureAngle, existingLinks);
    // Eccentric relay families attach to both planet rings by proximity (each ellipse
    // touches Earth at perihelion and Mars at aphelion), not via the concentric
    // `suitable` flag.
    this.planetToEccentricRings(rings, positions, linkCounts, finalLinks, "ring_mars", existingLinks);
    this.planetToEccentricRings(rings, positions, linkCounts, finalLinks, "ring_earth", existingLinks);
    mark("planetToRings", t);

    // Cross-link eccentric rings where their tracks intersect in the xy plane, using
    // each closest sat's spare radial ("3rd") laser. Runs after the planet junctions
    // so those essential radial links claim their terminals first. Gated by the
    // Adapted-eccentric "Cross-ring links" toggle (default on).
    t = performance.now();
    if (this.simLinkBudget.eccentricCrossRingLinks !== false) {
      this.crossEccentricRings(rings, positions, linkCounts, finalLinks, existingLinks);
    }
    mark("crossEccentricRings", t);

    t = performance.now();
    this.planetToRingSatellites(filteredPlanets, rings, positions, linkCounts, finalLinks, existingLinks);
    mark("planetLinks", t);

    t = performance.now();
    // Concentric families (adapted / circular) route radially via the outwards chain;
    // eccentric families (adapted-eccentric / eccentric) route along each ring's
    // azimuthal loop. Only one relay type is active at a time, so pick the matching
    // router (eccentric takes priority if any eccentric ring is present).
    const hasEccentric = Object.keys(rings).some((r) => r.startsWith("ring_ecce") || r.startsWith("ring_adecc"));
    this.routeSummary = hasEccentric
      ? this.calculateEccentricRoutes(finalLinks, rings)
      : this.calculateEarthToMarsRoutes(finalLinks, rings);
    // Surface the per-ring junction/route detail (eccentric families) on the summary so
    // the capacity card can render it. Sorted by the ring's argument-of-perihelion.
    if (this.routeSummary && this.eccRingDetail.size) {
      this.routeSummary.ringDetail = [...this.eccRingDetail.values()].sort((a, b) => a.argP - b.argP);
    }
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
