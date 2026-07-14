// simTopology.js — Topology building logic extracted from SimNetwork.

import { SIM_CONSTANTS } from "./simConstants.js?v=4.40";

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

  /**
   * Radial-backbone port budget for a ring. Adapted-concentric rings always use a FIXED
   * radial budget (inward + outward = 2) regardless of the laser-port slider, so raising
   * the port count never changes the backbone — the extra terminals become the circular
   * lattice (intraRing, capped by the lattice setting) and spacecraft-accessible spare
   * ports. Other families use their full port count for the radial pass as before.
   */
  _radialMaxLinks(ringName) {
    const max = this.simLinkBudget.getMaxLinksPerRing(ringName);
    return ringName.startsWith("ring_adapt") ? Math.min(2, max) : max;
  }

  intraRing(rings, positions, linkCounts, finalLinks, existingLinks) {
    // Create neighbor links for all rings (including Mars and Earth)
    // existingLinks is a shared Set of "${fromId}-${toId}" keys, mutated here.

    const AU_IN_KM = this.AU_IN_KM;

    let linksAdded = 0;

    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;
    // Per-satellite count of intra-ring (azimuthal) links, capped by circularCap below.
    const circCount = {};

    // Iterate through each ring
    for (const [ringName, ringSatellites] of Object.entries(rings)) {
      // Cache the ring's max-links value once (was called 3× per inner iteration)
      const maxLinksPerRing = this.simLinkBudget.getMaxLinksPerRing(ringName);
      // Circular (azimuthal/lattice) link cap per satellite:
      //  - Contoured concentric: the "Circular lattice" setting (0 none / 1 half / 2 full).
      //    The radial backbone ran first (interAdaptedRings), so these fill spare ports up
      //    to the cap; terminals left after radial + lattice are spacecraft-accessible.
      //  - Other families: legacy behaviour — skip 2-port rings (all radial), else a full
      //    azimuthal ring (≤2) from whatever ports the radial pass left.
      let circularCap;
      if (ringName.startsWith("ring_adapt")) {
        circularCap = this.simLinkBudget.adaptedLattice || 0;
        if (circularCap === 0) continue;
      } else {
        if (maxLinksPerRing === 2) continue;
        circularCap = 2;
      }

      // Pre-build name->satellite Map for O(1) neighbor lookup
      const satByName = new Map();
      for (const sat of ringSatellites) satByName.set(sat.name, sat);

      for (const satellite of ringSatellites) {
        // Early termination if satellite has reached its port budget or circular cap
        if (linkCounts[satellite.name] >= maxLinksPerRing || (circCount[satellite.name] || 0) >= circularCap) continue;

        // Cache the satellite's position once
        const satPos = positions[satellite.name];
        if (!satPos) continue;
        const satSolar = satPos.solarAngle;
        const satName = satellite.name;

        for (const neighborName of satellite.neighbors) {
          // Cache neighbor position
          const neighPos = positions[neighborName];
          if (!neighPos) continue;

          // Early termination if neighbor has reached its port budget or circular cap
          if (linkCounts[neighborName] >= maxLinksPerRing || (circCount[neighborName] || 0) >= circularCap) continue;

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

          // Increment link counts (total ports + circular-lattice counters)
          linkCounts[satellite.name]++;
          linkCounts[neighborName]++;
          circCount[satName] = (circCount[satName] || 0) + 1;
          circCount[neighborName] = (circCount[neighborName] || 0) + 1;

          // Mark ports as used
          satellite[directionSat] = neighborSat.name;
          neighborSat[directionNeigh] = satellite.name;

          // Add the new link to the Set to avoid future duplicates
          existingLinks.add(linkKey);

          linksAdded++;

          // Early termination if satellite has reached its port budget or circular cap
          if (linkCounts[satName] >= maxLinksPerRing || (circCount[satName] || 0) >= circularCap) {
            break; // Exit the neighbors loop for this satellite
          }
        }
      }
    }

  }

  // Inter-ring radial backbone for the concentric relay families. THREE matchers are kept
  // side-by-side for comparison, selected by Simulation → "Inter-ring matcher"
  // (this.simLinkBudget.interRingMatcher): "linear-merge" (default, current), "monotonic-wrap",
  // and "greedy-nearest". They share identical setup and differ only in how each inner-ring
  // sat is paired with an outer-ring sat. (We'll keep the winner and delete the rest later.)
  interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const args = [rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks];
    const mode = (this.simLinkBudget && this.simLinkBudget.interRingMatcher) || "linear-merge";
    if (mode === "max-throughput") return this._interAdaptedRings_maxThroughput(...args);
    if (mode === "greedy-nearest") return this._interAdaptedRings_greedyWindowed(...args);
    if (mode === "greedy-pairs") return this._interAdaptedRings_greedyPairs(...args);
    if (mode === "greedy-merge") return this._interAdaptedRings_greedyMerge(...args);
    if (mode === "monotonic-wrap") return this._interAdaptedRings_monotonic(...args);
    if (mode === "periapsis-chain") return this._interAdaptedRings_periapsisChain(...args);
    if (mode === "periapsis-radial") return this._interAdaptedRings_periapsisRadial(...args);
    return this._interAdaptedRings_linearMerge(...args);
  }

  // Post-pass for the "Require inner link" / "Require outer link" toggles: strip radial chains
  // that aren't a complete Earth↔Mars route. Runs AFTER planet-attach (so the Earth/Mars planet
  // links are present and get removed as part of an island) and BEFORE the lattice (so freed
  // terminals fall through to the lattice/spare). The radial graph is a union of simple chains
  // (each sat has ≤1 inward + ≤1 outward radial link); walking inwards/outwards — across relay
  // AND planet-ring sats — gives each chain and its two ends. A chain "reaches Earth" if its
  // inner end is an Earth-ring sat OR an innermost-relay-ring sat (Earth-attachable); it "reaches
  // Mars" symmetrically. By the user-chosen connectivity mapping:
  //   • Require inner link  ⇒ remove any chain that does NOT reach Earth (Mars-stubs + floaters);
  //   • Require outer link  ⇒ remove any chain that does NOT reach Mars  (Earth-stubs + floaters).
  // Both on ⇒ only complete Earth↔Mars routes survive. (Inner is also enforced inline by greedy-
  // nearest's radial continuity; this generalises the cleanup to every matcher and the planet
  // links.) Island links carry no Earth↔Mars flow, so removing them never lowers throughput.
  pruneIncompleteRadialChains(rings, linkCounts, finalLinks, existingLinks) {
    const requireInner = this.simLinkBudget.greedyRadialContinuity;
    const requireOuter = this.simLinkBudget.greedyRequireOuterLink;
    if (!requireInner && !requireOuter) return;

    const relayNames = Object.keys(rings).filter((n) => n.startsWith("ring_adapt_") || n.startsWith("ring_circ_"));
    if (relayNames.length === 0) return;
    const parseIndex = (name) => { const m = name.match(/_(\d+)$/); return m ? parseInt(m[1], 10) : -1; };
    const relayIdx = new Map(relayNames.map((n) => [n, parseIndex(n)]));
    const minIdx = Math.min(...relayIdx.values());
    const maxIdx = Math.max(...relayIdx.values());

    // Chains may run into the planet rings, so include their sats in the walk.
    const satByName = new Map();
    for (const n of [...relayNames, "ring_earth", "ring_mars"]) if (rings[n]) for (const s of rings[n]) satByName.set(s.name, s);
    const isReal = (port) => port !== null && port !== "premarked" && satByName.has(port);
    const reachesEarth = (s) => s.ringName === "ring_earth" || relayIdx.get(s.ringName) === minIdx;
    const reachesMars = (s) => s.ringName === "ring_mars" || relayIdx.get(s.ringName) === maxIdx;

    const visited = new Set();
    const removedKeys = new Set();
    for (const seed of satByName.values()) {
      if (visited.has(seed.name)) continue;
      // Walk to the inner end, then sweep outward collecting the whole chain.
      let innerEnd = seed, guard = 0;
      while (isReal(innerEnd.inwards) && guard++ < 1e6) innerEnd = satByName.get(innerEnd.inwards);
      const chain = [innerEnd];
      for (let cur = innerEnd; isReal(cur.outwards); ) { cur = satByName.get(cur.outwards); chain.push(cur); }
      chain.forEach((s) => visited.add(s.name));
      if (chain.length < 2) continue; // lone sat, no radial link

      const outerEnd = chain[chain.length - 1];
      const drop = (requireInner && !reachesEarth(innerEnd)) || (requireOuter && !reachesMars(outerEnd));
      if (!drop) continue;

      for (let k = 0; k + 1 < chain.length; k++) {
        const a = chain[k], b = chain[k + 1];
        const [f, t] = a.name < b.name ? [a.name, b.name] : [b.name, a.name];
        removedKeys.add(`${f}-${t}`);
        existingLinks.delete(`${f}-${t}`);
        linkCounts[a.name]--; linkCounts[b.name]--;
      }
      chain.forEach((s) => { if (isReal(s.inwards)) s.inwards = null; if (isReal(s.outwards)) s.outwards = null; });
    }

    if (removedKeys.size) {
      const keyOf = (l) => (l.fromId < l.toId ? `${l.fromId}-${l.toId}` : `${l.toId}-${l.fromId}`);
      const kept = finalLinks.filter((l) => !removedKeys.has(keyOf(l)));
      finalLinks.length = 0;
      finalLinks.push(...kept);
    }
  }

  _interAdaptedRings_linearMerge(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
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
      ringMaxLinks.set(ring.name, this._radialMaxLinks(ring.name));
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

      // --- Order-preserving (monotonic) matcher ---------------------------------
      // Both rings are sorted by true longitude, so we match them with a LINEAR merge:
      // walk inner sats in ascending longitude and advance an outer pointer that only
      // moves FORWARD (never wraps, never goes back). An inner sat can therefore only
      // match a nearby outer sat — never one belonging to a route already passed, which
      // was the source of the long cross-route links. A purely-radial link is sun-aligned
      // (solar-blinded), so we scan a small window (op-1 .. op+SKIP) for the nearest
      // non-blinded outer; that bounds every link to ~SKIP sats of azimuthal offset.
      // (A handful of sats at the 0°/360° seam may go unmatched — far cheaper than the
      // cross-ring links a wrap-around would let back in.)
      const N = innerSats.length;
      const M = outerSats.length;
      const SKIP = 2; // window half-width: max offset to clear blinding / a taken sat
      const angularOffsetDeg = (Math.atan2((rOuter - rInner) * Math.tan(departureRad), rOuter) * 180) / Math.PI;
      let op = 0;

      for (let ii = 0; ii < N; ii++) {
        const innerSat = innerSats[ii];
        const canConnectOut = isFirstRing && innerMaxLinks === 3 ? ii % 2 === 1 : linkCounts[innerSat.name] < innerMaxLinks;
        if (!canConnectOut || innerSat.outwards !== null) continue;

        const innerPos = positions[innerSat.name];
        if (!innerPos) continue;
        const target = normalizeAngle(innerPos.solarAngle + angularOffsetDeg);

        // Advance to the first outer sat at/after the target longitude (forward only).
        while (op < M && outerAngles[op] < target) op++;

        // Scan a small window straddling the target (op-1 is the nearest below it) for
        // the closest valid, non-blinded, in-budget outer sat.
        let assigned = -1, bestDist = Infinity;
        for (let s = -1; s <= SKIP; s++) {
          const oi = op + s;
          if (oi < 0 || oi >= M) continue;
          const outerSat = outerSats[oi];
          if (outerSat.inwards !== null) continue;
          if (linkCounts[outerSat.name] >= outerMaxLinks) continue;
          const outerPos = positions[outerSat.name];
          if (!outerPos) continue;
          const dAU = this.calculateDistanceAU(innerPos, outerPos);
          if (dAU > maxDistanceAU) continue;
          if (this.isSolarBlinded(innerPos, outerPos)) continue;
          if (dAU < bestDist) { bestDist = dAU; assigned = oi; }
        }
        if (assigned < 0) continue;

        const from = innerSat, to = outerSats[assigned];
        const distanceAU = bestDist;
        const distanceKm = distanceAU * AU_IN_KM;
        const gbps = this.calculateGbps(distanceKm);
        // Keep the assignment monotonic — the pointer never moves backward.
        op = Math.max(op, assigned + 1);

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
      }
    }
  }

  // Matcher "monotonic-wrap": forward outer pointer modulo M with a `consumed` cap (so it
  // never laps past the start) and a SKIP=3 forward window. Predecessor of linear-merge.
  _interAdaptedRings_monotonic(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_adapt_") || ringName.startsWith("ring_circ_")
    );
    if (circularRingNames.length === 0) return;
    const parseIndex = (name) => { const match = name.match(/_(\d+)$/); return match ? parseInt(match[1], 10) : -1; };
    const ringList = circularRingNames
      .map((name) => ({ name, index: parseIndex(name), radius: rings[name][0].a }))
      .filter((r) => r.index >= 0);
    ringList.sort((a, b) => a.index - b.index);
    const AU_IN_KM = this.AU_IN_KM;
    const ringSatellites = {};
    ringList.forEach((ring) => {
      ringSatellites[ring.name] = rings[ring.name]
        .filter((sat) => sat.orbitalZone === "BETWEEN_EARTH_AND_MARS")
        .slice()
        .sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    });
    const ringMaxLinks = new Map();
    ringList.forEach((ring) => { ringMaxLinks.set(ring.name, this._radialMaxLinks(ring.name)); });
    ringList.forEach((ring) => {
      const maxLinks = ringMaxLinks.get(ring.name);
      if (maxLinks !== 3) return;
      ringSatellites[ring.name].forEach((sat, i) => { if (i % 2 === 0) sat.outwards = "premarked"; else sat.inwards = "premarked"; });
    });
    const normalizeAngle = (deg) => ((deg % 360) + 360) % 360;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    for (let i = 0; i < ringList.length - 1; i++) {
      const inner = ringList[i];
      const outer = ringList[i + 1];
      if (outer.index !== inner.index + 1) continue;
      const innerSats = ringSatellites[inner.name];
      const outerSats = ringSatellites[outer.name];
      if (!innerSats.length || !outerSats.length) continue;
      const outerAngles = outerSats.map((s) => s.position.solarAngle);
      const rInner = inner.radius;
      const rOuter = outer.radius;
      const departureRad = (targetDepartureAngle * Math.PI) / 180;
      const innerMaxLinks = ringMaxLinks.get(inner.name);
      const outerMaxLinks = ringMaxLinks.get(outer.name);
      const isFirstRing = inner.index === ringList[0].index;

      const N = innerSats.length;
      const M = outerSats.length;
      const SKIP = 3; // max forward skip to clear blinding / a taken sat
      const angularOffsetDeg = (Math.atan2((rOuter - rInner) * Math.tan(departureRad), rOuter) * 180) / Math.PI;
      const angDist = (oi, target) => { const d = (((outerAngles[oi] - target) % 360) + 360) % 360; return d > 180 ? 360 - d : d; };
      let op = 0;
      {
        const a0 = normalizeAngle((positions[innerSats[0].name]?.solarAngle ?? 0) + angularOffsetDeg);
        let k = 0;
        while (k < M && outerAngles[k] < a0) k++;
        op = k % M;
      }
      let consumed = 0; // outer sats passed; cap at M so we never wrap past the start

      for (let ii = 0; ii < N && consumed < M; ii++) {
        const innerSat = innerSats[ii];
        const canConnectOut = isFirstRing && innerMaxLinks === 3 ? ii % 2 === 1 : linkCounts[innerSat.name] < innerMaxLinks;
        if (!canConnectOut || innerSat.outwards !== null) continue;
        const innerPos = positions[innerSat.name];
        if (!innerPos) continue;
        const target = normalizeAngle(innerPos.solarAngle + angularOffsetDeg);
        while (consumed + 1 < M && angDist((op + 1) % M, target) < angDist(op, target)) { op = (op + 1) % M; consumed++; }
        let assigned = -1, bestDist = Infinity, bestStep = 0;
        for (let s = 0; s <= SKIP && consumed + s < M; s++) {
          const oi = (op + s) % M;
          const outerSat = outerSats[oi];
          if (outerSat.inwards !== null) continue;
          if (linkCounts[outerSat.name] >= outerMaxLinks) continue;
          const outerPos = positions[outerSat.name];
          if (!outerPos) continue;
          const dAU = this.calculateDistanceAU(innerPos, outerPos);
          if (dAU > maxDistanceAU) continue;
          if (this.isSolarBlinded(innerPos, outerPos)) continue;
          if (dAU < bestDist) { bestDist = dAU; assigned = oi; bestStep = s; }
        }
        if (assigned < 0) continue;
        const from = innerSat, to = outerSats[assigned];
        const distanceAU = bestDist;
        const distanceKm = distanceAU * AU_IN_KM;
        const gbps = this.calculateGbps(distanceKm);
        op = (assigned + 1) % M;
        consumed += bestStep + 1;
        const [fId, tId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;
        finalLinks.push({ fromId: fId, toId: tId, distanceAU, distanceKm, latencySeconds: this.calculateLatency(distanceKm), gbpsCapacity: gbps });
        linkCounts[from.name]++;
        linkCounts[to.name]++;
        existingLinks.add(key);
        from.outwards = to.name;
        to.inwards = from.name;
      }
    }
  }

  // Matcher "greedy-nearest": for each inner sat, take the 2 nearest outer sats by solar
  // angle that clear every filter (free port, range, solar-blinding cone), pool them, sort
  // by distance, and greedily assign shortest-first. Capping each inner sat to its 2
  // angular-nearest candidates keeps links local — it cannot emit the long cross-route
  // links the earlier wide-window version produced on phase-shifted rings.
  _interAdaptedRings_greedyWindowed(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_adapt_") || ringName.startsWith("ring_circ_")
    );
    if (circularRingNames.length === 0) return;
    const parseIndex = (name) => { const match = name.match(/_(\d+)$/); return match ? parseInt(match[1], 10) : -1; };
    const ringList = circularRingNames
      .map((name) => ({ name, index: parseIndex(name), radius: rings[name][0].a }))
      .filter((r) => r.index >= 0);
    ringList.sort((a, b) => a.index - b.index);
    const AU_IN_KM = this.AU_IN_KM;
    const ringSatellites = {};
    ringList.forEach((ring) => {
      ringSatellites[ring.name] = rings[ring.name]
        .filter((sat) => sat.orbitalZone === "BETWEEN_EARTH_AND_MARS")
        .slice()
        .sort((a, b) => a.position.solarAngle - b.position.solarAngle);
    });
    const ringMaxLinks = new Map();
    ringList.forEach((ring) => { ringMaxLinks.set(ring.name, this._radialMaxLinks(ring.name)); });
    ringList.forEach((ring) => {
      const maxLinks = ringMaxLinks.get(ring.name);
      if (maxLinks !== 3) return;
      ringSatellites[ring.name].forEach((sat, i) => { if (i % 2 === 0) sat.outwards = "premarked"; else sat.inwards = "premarked"; });
    });
    const normalizeAngle = (deg) => ((deg % 360) + 360) % 360;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    for (let i = 0; i < ringList.length - 1; i++) {
      const inner = ringList[i];
      const outer = ringList[i + 1];
      if (outer.index !== inner.index + 1) continue;
      const innerSats = ringSatellites[inner.name];
      const outerSats = ringSatellites[outer.name];
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
        const canConnectOut = isFirstRing && innerMaxLinks === 3 ? idx % 2 === 1 : linkCounts[innerSat.name] < innerMaxLinks;
        if (!canConnectOut || innerSat.outwards !== null) continue;
        // Radial continuity (Simulation → "Route continuity" → "Require inner link", default on): a sat may
        // only reach outward to ring N+1 if it is already linked inward to ring N-1 (set in the
        // previous inner/outer iteration). This prevents floating outward links from sats with no
        // inner feed. The innermost ring is exempt — its inward feed is the planet (Earth), attached
        // later in planetToCircularRings, so it has no ring N-1 yet at this point. (3-port rings
        // pre-mark their inward port to a sentinel, so those sats stay eligible.)
        if (this.simLinkBudget.greedyRadialContinuity !== false && !isFirstRing && innerSat.inwards === null) continue;
        const innerPos = positions[innerSat.name];
        if (!innerPos) continue;
        const distEst = rOuter - rInner;
        const tanOffset = distEst * Math.tan(departureRad);
        const angularOffsetRad = Math.atan2(tanOffset, rOuter);
        const idealTargetSolarAngle = normalizeAngle(innerPos.solarAngle + (angularOffsetRad * 180) / Math.PI);
        let oIdx = 0;
        while (oIdx < outerAngles.length && outerAngles[oIdx] < idealTargetSolarAngle) oIdx++;
        // Collect up to 2 candidate outer sats — the nearest by solar-angle separation
        // from the ideal target — that pass every filter (free inward port, link budget,
        // range, and the solar-blinding cone). Walk outward from the insertion point in
        // both angular directions, each step advancing whichever frontier is angularly
        // closer. The radially-ideal sat is sun-aligned, so with a non-zero exclusion cone
        // it is blinded and skipped (yielding the two sats flanking the cone); with the
        // cone disabled (solar exclusion = 0) nothing is blinded, so this yields the radial
        // sat plus its nearest neighbour. If fewer than 2 sats clear the filters, only
        // those are kept — no link is forced over-range or through the Sun.
        const oLen = outerSats.length;
        const MAX_OUTER_CANDIDATES = 2;
        const angSep = (a) => { const d = Math.abs(normalizeAngle(a) - idealTargetSolarAngle); return Math.min(d, 360 - d); };
        let hi = ((oIdx % oLen) + oLen) % oLen;        // first sat at/after the ideal angle
        let lo = (((oIdx - 1) % oLen) + oLen) % oLen;  // first sat before it
        let found = 0;
        for (let step = 0; step < oLen && found < MAX_OUTER_CANDIDATES; step++) {
          const useHi = angSep(outerAngles[hi]) <= angSep(outerAngles[lo]);
          const outerSat = outerSats[useHi ? hi : lo];
          if (useHi) hi = (hi + 1) % oLen; else lo = (((lo - 1) % oLen) + oLen) % oLen;
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
          found++;
        }
      }

      candidates.sort((a, b) => a.distanceAU - b.distanceAU);

      const used = new Set();
      for (const { from, to, distanceAU, distanceKm, gbps } of candidates) {
        if (used.has(from.name) || used.has(to.name)) continue;
        if (linkCounts[from.name] >= innerMaxLinks) continue;
        if (linkCounts[to.name] >= outerMaxLinks) continue;
        if (from.outwards !== null || to.inwards !== null) continue;
        const [fId, tId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;
        finalLinks.push({ fromId: fId, toId: tId, distanceAU, distanceKm, latencySeconds: this.calculateLatency(distanceKm), gbpsCapacity: gbps });
        linkCounts[from.name]++;
        linkCounts[to.name]++;
        existingLinks.add(key);
        from.outwards = to.name;
        to.inwards = from.name;
        used.add(from.name);
        used.add(to.name);
      }
    }
  }

  // Matcher "greedy-pairs": a per-ring-pair restructuring of greedy-nearest, built so each adjacent
  // pair (ring N, ring N+1) is an INDEPENDENT unit of work. A pair touches only the inner ring's
  // OUTWARD ports and the outer ring's INWARD ports; adjacent pairs therefore touch disjoint port
  // sets on the shared middle ring, so the pairs could later be farmed out one-per-Web-Worker with no
  // cross-pair contention (each worker proposes links for its pair; the main thread merges them). For
  // now the pairs run in a plain sequential for-loop. The per-pair work (`proposePair`) is kept as a
  // self-contained closure that reads ring geometry + linkCounts but never mutates the shared link
  // state — that mutation happens only in the merge loop below — so it is the natural seam to hand to
  // a worker. Per pair: for every inner sat with a free outward port, take the 3 nearest outer sats by
  // true 3D distance (sqrt(dx²+dy²+dz²)) that clear every filter (free inward port, link budget, range,
  // solar-blinding cone), then pool them, sort shortest-first, and assign greedily within the pair.
  // Candidate selection is distance-only — solar angle is NOT consulted (it is retained solely to
  // order the ring for 3-port premark, which never fires on adapted rings). Unlike greedy-nearest there
  // is no departure-angle tilt and no inline radial-continuity check — pruneIncompleteRadialChains
  // enforces continuity globally afterward.
  _interAdaptedRings_greedyPairs(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_adapt_") || ringName.startsWith("ring_circ_")
    );
    if (circularRingNames.length === 0) return;
    const parseIndex = (name) => { const match = name.match(/_(\d+)$/); return match ? parseInt(match[1], 10) : -1; };
    const ringList = circularRingNames
      .map((name) => ({ name, index: parseIndex(name) }))
      .filter((r) => r.index >= 0);
    ringList.sort((a, b) => a.index - b.index);
    const AU_IN_KM = this.AU_IN_KM;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;
    const normalizeAngle = (deg) => ((deg % 360) + 360) % 360;

    // Initial step: derive each relay sat's solar angle straight from its (x, y) position — the
    // azimuth of the ecliptic-plane projection, z dropped — instead of trusting the stored
    // position.solarAngle (the in-plane true longitude, which diverges from the projected azimuth
    // for inclined orbits). This recalculated angle is the angular key used everywhere below:
    // ring ordering and nearest-angle candidate selection. (For near-coplanar concentric rings the
    // two agree to ~0.01°; the recalculation only matters once rings carry inclination.)
    const solarAngleFromXYZ = (pos) => normalizeAngle((Math.atan2(pos.y, pos.x) * 180) / Math.PI);
    const angleOf = new Map();

    const ringSatellites = {};
    ringList.forEach((ring) => {
      const sats = rings[ring.name].filter((sat) => sat.orbitalZone === "BETWEEN_EARTH_AND_MARS").slice();
      for (const sat of sats) { const pos = positions[sat.name]; if (pos) angleOf.set(sat.name, solarAngleFromXYZ(pos)); }
      sats.sort((a, b) => (angleOf.get(a.name) ?? 0) - (angleOf.get(b.name) ?? 0));
      ringSatellites[ring.name] = sats;
    });
    const ringMaxLinks = new Map();
    ringList.forEach((ring) => { ringMaxLinks.set(ring.name, this._radialMaxLinks(ring.name)); });
    // 3-port rings alternate which port each sat exposes to the radial backbone. Kept for budget
    // correctness; adapted rings have a fixed 2-port radial budget so this never fires for them.
    ringList.forEach((ring) => {
      const maxLinks = ringMaxLinks.get(ring.name);
      if (maxLinks !== 3) return;
      ringSatellites[ring.name].forEach((sat, i) => { if (i % 2 === 0) sat.outwards = "premarked"; else sat.inwards = "premarked"; });
    });
    const satByName = new Map();
    for (const ring of ringList) for (const s of ringSatellites[ring.name]) satByName.set(s.name, s);

    // The independent unit of work for one adjacent ring pair. Returns the proposed links, already
    // greedily de-conflicted WITHIN the pair, as [{ fromName, toName, distanceAU }]. Reads shared
    // ring/link state but never writes it.
    const proposePair = (inner, outer) => {
      const innerSats = ringSatellites[inner.name];
      const outerSats = ringSatellites[outer.name];
      if (!innerSats.length || !outerSats.length) return [];
      const oLen = outerSats.length;
      const innerMaxLinks = ringMaxLinks.get(inner.name);
      const outerMaxLinks = ringMaxLinks.get(outer.name);
      const isFirstRing = inner.index === ringList[0].index;

      const candidates = [];
      for (let idx = 0; idx < innerSats.length; idx++) {
        const innerSat = innerSats[idx];
        const canConnectOut = isFirstRing && innerMaxLinks === 3 ? idx % 2 === 1 : linkCounts[innerSat.name] < innerMaxLinks;
        if (!canConnectOut || innerSat.outwards !== null) continue;
        const innerPos = positions[innerSat.name];
        if (!innerPos) continue;
        // Candidate selection by 3D distance ONLY — solar angle is no longer consulted. Scan every
        // outer sat that clears the cheap filters (free inward port, budget, range), record its true
        // sqrt(dx²+dy²+dz²) distance, sort ascending, then take the 3 nearest that also clear the
        // solar-blinding cone (the cone check is deferred to the shortlist so it runs only a few times
        // per inner sat rather than over the whole ring).
        const reachable = [];
        for (let o = 0; o < oLen; o++) {
          const outerSat = outerSats[o];
          if (outerSat.inwards !== null) continue;
          if (linkCounts[outerSat.name] >= outerMaxLinks) continue;
          const outerPos = positions[outerSat.name];
          if (!outerPos) continue;
          const distanceAU = this.calculateDistanceAU(innerPos, outerPos);
          if (distanceAU > maxDistanceAU) continue;
          reachable.push({ outerSat, distanceAU });
        }
        reachable.sort((a, b) => a.distanceAU - b.distanceAU);
        const MAX_OUTER_CANDIDATES = 3;
        let found = 0;
        for (let k = 0; k < reachable.length && found < MAX_OUTER_CANDIDATES; k++) {
          const { outerSat, distanceAU } = reachable[k];
          if (this.isSolarBlinded(innerPos, positions[outerSat.name])) continue;
          candidates.push({ fromName: innerSat.name, toName: outerSat.name, distanceAU });
          found++;
        }
      }
      // Greedy shortest-first assignment within this pair.
      candidates.sort((a, b) => a.distanceAU - b.distanceAU);
      const used = new Set();
      const proposals = [];
      for (const c of candidates) {
        if (used.has(c.fromName) || used.has(c.toName)) continue;
        proposals.push(c);
        used.add(c.fromName);
        used.add(c.toName);
      }
      return proposals;
    };

    // Sequential loop over pairs (worker-ready: disjoint ports on the shared middle ring make the
    // iterations independent). Merge each pair's proposals into the shared link state.
    for (let i = 0; i < ringList.length - 1; i++) {
      const inner = ringList[i];
      const outer = ringList[i + 1];
      if (outer.index !== inner.index + 1) continue;
      const innerMaxLinks = ringMaxLinks.get(inner.name);
      const outerMaxLinks = ringMaxLinks.get(outer.name);
      const proposals = proposePair(inner, outer);
      for (const { fromName, toName, distanceAU } of proposals) {
        const from = satByName.get(fromName);
        const to = satByName.get(toName);
        if (!from || !to) continue;
        if (from.outwards !== null || to.inwards !== null) continue;
        if (linkCounts[fromName] >= innerMaxLinks || linkCounts[toName] >= outerMaxLinks) continue;
        const [fId, tId] = fromName < toName ? [fromName, toName] : [toName, fromName];
        const key = `${fId}-${tId}`;
        if (existingLinks.has(key)) continue;
        const distanceKm = distanceAU * AU_IN_KM;
        const gbps = this.calculateGbps(distanceKm);
        finalLinks.push({ fromId: fId, toId: tId, distanceAU, distanceKm, latencySeconds: this.calculateLatency(distanceKm), gbpsCapacity: gbps });
        linkCounts[fromName]++;
        linkCounts[toName]++;
        existingLinks.add(key);
        from.outwards = toName;
        to.inwards = fromName;
      }
    }
  }

  // Matcher "greedy-merge": greedy-nearest, then a LOCAL island-merge repair that pairs a stalagmite
  // (mite) with an overlapping stalactite (tite) and joins them at their BEST FORK RING — the ring in
  // their shared (ZOPA) band where the two chains are most aligned in sun-angle, so the new link is as
  // SHORT (= high capacity) as possible. This avoids the long diagonal "cross-over" link a radial walk
  // would make by landing on a far/misaligned tite. Algorithm (per the user's spec):
  //   1. list mites (Earth-rooted, free OUTWARD tip), tites (Mars-rooted, free INWARD tip), floaters.
  //   2. shortlist (mite,tite) pairs within ±swapDeg (circular) that OVERLAP radially (tite tip ring
  //      ≤ mite tip ring + 1 ⇒ they share a ring / are adjacent — a ZOPA).
  //   3. sort pairs by sun-angle distance to the Mars-periapsis angle (nearest periapsis first).
  //   4. for each pair, sequentially, swap at the fork ring r minimising the join-link length:
  //      reconnect mite[r] → tite[r+1] (the short link), orphaning the small leftover stubs.
  // Node-disjoint; premarked ports untouched; only short links are emitted (long ones are rejected).
  // swapDeg = Simulation → "Island-merge swap" (degrees, default 3).
  _interAdaptedRings_greedyMerge(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const relayNames = Object.keys(rings).filter((n) => n.startsWith("ring_adapt_") || n.startsWith("ring_circ_"));
    if (relayNames.length === 0) return;
    const parseIndex = (name) => { const m = name.match(/_(\d+)$/); return m ? parseInt(m[1], 10) : -1; };
    const ringInfo = relayNames.map((name) => ({ name, index: parseIndex(name) })).filter((r) => r.index >= 0);
    ringInfo.sort((a, b) => a.index - b.index);

    // 1) greedy-nearest first (UNTOUCHED) — leaves the mite/tite/floater islands.
    this._interAdaptedRings_greedyWindowed(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks);
    if (ringInfo.length < 2) return;

    const minIdx = ringInfo[0].index, maxIdx = ringInfo[ringInfo.length - 1].index;
    const idxByRing = new Map(ringInfo.map((r) => [r.name, r.index]));
    const AU_IN_KM = this.AU_IN_KM;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;
    const swapDegRaw = this.simLinkBudget.greedyMergeSwapDegrees;
    const swapDeg = (typeof swapDegRaw === "number" && swapDegRaw >= 0) ? swapDegRaw : 3;

    const satByName = new Map();
    for (const r of ringInfo) for (const s of rings[r.name]) if (s.orbitalZone === "BETWEEN_EARTH_AND_MARS" && positions[s.name]) satByName.set(s.name, s);
    const isReal = (p) => p !== null && p !== "premarked" && satByName.has(p);
    const ringIndexOf = (s) => idxByRing.get(s.ringName);
    const angleOf = (s) => s.position.solarAngle;
    const angSep = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
    const reachesMars = (s) => { let cur = s, g = 0; while (g++ < ringInfo.length + 2) { if (ringIndexOf(cur) === maxIdx) return true; if (!isReal(cur.outwards)) return false; cur = satByName.get(cur.outwards); } return false; };
    const reachesEarth = (s) => { let cur = s, g = 0; while (g++ < ringInfo.length + 2) { if (ringIndexOf(cur) === minIdx) return true; if (!isReal(cur.inwards)) return false; cur = satByName.get(cur.inwards); } return false; };
    // ring index -> sat, walking a chain from a tip. dir = "in" (toward Earth) or "out" (toward Mars).
    const chainMap = (tip, dir) => { const m = new Map(); let cur = tip, g = 0; while (cur && g++ < ringInfo.length + 2) { m.set(ringIndexOf(cur), cur); const nxt = dir === "in" ? cur.inwards : cur.outwards; if (!isReal(nxt)) break; cur = satByName.get(nxt); } return m; };

    // Snapshot greedy's radial links BEFORE swapping (NAME PAIRS — never split a hyphenated key).
    const greedyLinks = [];
    for (const s of satByName.values()) if (isReal(s.outwards)) greedyLinks.push([s.name, s.outwards]);
    // Short-link budget: a join may not exceed ~3× the median existing radial link (keeps joins near-radial).
    const lens = greedyLinks.map(([a, b]) => this.calculateDistanceAU(positions[a], positions[b])).sort((x, y) => x - y);
    const medLen = lens.length ? lens[lens.length >> 1] : 0.02;
    const maxJoinAU = Math.min(maxDistanceAU, Math.max(3 * medLen, 1e-6));

    // 2) ANALYSE: mite tips (chain to Earth) + tite tips (chain to Mars) + floater census.
    const mites = [], tites = [];
    let floaterTips = 0;
    for (const s of satByName.values()) {
      const ri = ringIndexOf(s);
      const rE = reachesEarth(s), rM = reachesMars(s);
      if (s.outwards === null && ri < maxIdx) { if (rE && !rM) mites.push(s); else if (!rE && !rM) floaterTips++; }
      if (s.inwards === null && ri > minIdx && rM && !rE) tites.push(s);
    }
    const census = `mites=${mites.length} tites=${tites.length} floaters=${floaterTips}`;
    if (!mites.length || !tites.length) {
      this._greedyMergeRebuild(finalLinks, existingLinks, linkCounts, positions, satByName, isReal, greedyLinks, AU_IN_KM);
      this._greedyMergeDiag = { mites: mites.length, tites: tites.length, floaters: floaterTips, pairs: 0, merged: 0, swapDeg };
      console.info(`[greedy-merge] nothing to pair — ${census}; swapDeg=${swapDeg}`);
      return;
    }

    // Mars periapsis sun angle (process the highest-value region first).
    const mars = this.simSatellites && this.simSatellites.getMars ? this.simSatellites.getMars() : null;
    const theta0 = ((((mars && mars.p) || 0) % 360) + 360) % 360;

    // Bucket tite tips by 1° so each mite only scans a few buckets within ±swapDeg (circular). O(N·k).
    const titeBuckets = new Map();
    const bkt = (deg) => ((Math.floor(deg) % 360) + 360) % 360;
    for (const t of tites) { const b = bkt(angleOf(t)); (titeBuckets.get(b) || titeBuckets.set(b, []).get(b)).push(t); }

    // 3) SHORTLIST pairs: within ±swapDeg, overlapping radially (tite tip ring ≤ mite tip ring + 1), and
    //    with a fork ring whose join-link is short. Record the BEST fork ring (min link length).
    const pairs = [];
    const span = Math.min(180, Math.ceil(swapDeg) + 1);
    for (const mite of mites) {
      const Nm = ringIndexOf(mite), aMite = angleOf(mite);
      const miteChain = chainMap(mite, "in"); // ring -> mite sat, mite tip ring = Nm down to Earth
      const center = bkt(aMite);
      for (let off = -span; off <= span; off++) {
        const arr = titeBuckets.get(((center + off) % 360 + 360) % 360);
        if (!arr) continue;
        for (const tite of arr) {
          if (angSep(aMite, angleOf(tite)) > swapDeg) continue;
          const Nt = ringIndexOf(tite);
          if (Nt > Nm + 1) continue;                 // need overlap / adjacency (share a ring)
          const titeChain = chainMap(tite, "out");   // ring -> tite sat, tite tip ring = Nt up to Mars
          // Best fork ring r: mite has a sat at r, tite has a sat at r+1; minimise dist(mite[r],tite[r+1]).
          let bestR = -1, bestCost = Infinity, bestKm = 0;
          const lo = Math.max(minIdx, Nt - 1), hi = Math.min(Nm, maxIdx - 1);
          for (let r = lo; r <= hi; r++) {
            const a = miteChain.get(r), b = titeChain.get(r + 1);
            if (!a || !b) continue;
            const d = this.calculateDistanceAU(positions[a.name], positions[b.name]);
            if (d > maxJoinAU || d >= bestCost) continue;
            if (this.isSolarBlinded(positions[a.name], positions[b.name])) continue;
            bestCost = d; bestR = r; bestKm = d * AU_IN_KM;
          }
          if (bestR < 0) continue;
          pairs.push({ mite, tite, miteChain, titeChain, r: bestR, cost: bestCost, km: bestKm, mid: angleOf(mite) });
        }
      }
    }
    // Sort: nearest Mars periapsis first, then shortest join.
    const periDist = (deg) => angSep(deg, theta0);
    pairs.sort((p, q) => periDist(p.mid) - periDist(q.mid) || p.cost - q.cost);

    // 4) SWAP each pair, sequentially, at its best fork ring r: reconnect mite[r] → tite[r+1], orphaning
    //    the small leftover stubs (mite above r, tite below r). Re-validate against prior swaps first.
    let merged = 0;
    for (const { mite, tite, miteChain, titeChain, r, km } of pairs) {
      const a = miteChain.get(r), b = titeChain.get(r + 1);
      if (!a || !b) continue;
      const aUp = miteChain.get(r + 1), bDown = titeChain.get(r);
      // Pointers must still be exactly as greedy/the chains left them (a prior swap may have touched them).
      if (a.outwards !== (aUp ? aUp.name : null)) continue;
      if (b.inwards !== (bDown ? bDown.name : null)) continue;
      if (!reachesEarth(a) || reachesMars(a)) continue;       // a must still feed Earth and not already reach Mars
      if (!reachesMars(b) || reachesEarth(b)) continue;       // b must still reach Mars and not already feed Earth
      // Apply the swap (pointer surgery).
      a.outwards = b.name; b.inwards = a.name;                // the short join
      if (aUp) aUp.inwards = null;                            // orphan the mite's stub above r
      if (bDown) bDown.outwards = null;                       // orphan the tite's stub below r
      merged++;
    }

    // 5) DECROSS by LOCAL 2-OPT on actual crossings. For each ring pair, look at the complete Earth→Mars
    //    links and, whenever two of them physically cross (segment a→b intersects segment c→d in the
    //    sun-plane), swap their outer ends: a→d, c→b. Uncrossing two segments STRICTLY shortens their total
    //    length (triangle inequality), so links only get shorter and the pass is guaranteed to converge; it
    //    is purely local — only the two crossing routes change, nothing else. A long join that crosses k
    //    routes cascades neighbour-by-neighbour (8→12 over 9,10,11 ⇒ 8→9, 9→10, 10→11, 11→12). Both routes
    //    stay complete (inner ends still reach Earth, outer ends still reach Mars), so completions and
    //    node-disjointness are preserved. Pre-classify the complete-carrying inner sats once — 2-opt keeps
    //    every route complete, so that set is invariant across passes; only the .outwards pointers move.
    const cross2 = (p1, p2, p3, p4) => { // do open segments p1p2 and p3p4 properly intersect (x-y plane)?
      const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
      return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    };
    const ccByPair = []; // per ring pair: complete-carrying inner sats (invariant under 2-opt)
    for (let i = 0; i < ringInfo.length - 1; i++) {
      const arr = [];
      if (ringInfo[i + 1].index === ringInfo[i].index + 1) {
        const rB = ringInfo[i + 1].index;
        for (const s of rings[ringInfo[i].name]) {
          if (!satByName.has(s.name) || !isReal(s.outwards)) continue;
          const v = satByName.get(s.outwards);
          if (ringIndexOf(v) !== rB) continue;
          if (reachesEarth(s) && reachesMars(v)) arr.push(s);
        }
      }
      ccByPair.push(arr);
    }
    let crossFixed = 0;
    if (swapDeg > 0) {
      for (let pass = 0; pass < 8; pass++) {
        let fixed = 0;
        for (const inn of ccByPair) {
          if (inn.length < 2) continue;
          const links = []; // current complete links {a inner, b outer}, sorted by inner sun-angle
          for (const a of inn) { if (!isReal(a.outwards)) continue; links.push({ a, b: satByName.get(a.outwards) }); }
          links.sort((p, q) => angleOf(p.a) - angleOf(q.a));
          for (let x = 0; x < links.length; x++) {
            for (let y = x + 1; y < links.length && y <= x + 10; y++) { // crossings are angularly local
              const L1 = links[x], L2 = links[y];
              if (L1.b === L2.b) continue;
              if (!cross2(positions[L1.a.name], positions[L1.b.name], positions[L2.a.name], positions[L2.b.name])) continue;
              // Candidate swap a→d, c→b — only if both new links stay in range and sun-clear.
              if (this.calculateDistanceAU(positions[L1.a.name], positions[L2.b.name]) > maxDistanceAU) continue;
              if (this.calculateDistanceAU(positions[L2.a.name], positions[L1.b.name]) > maxDistanceAU) continue;
              if (this.isSolarBlinded(positions[L1.a.name], positions[L2.b.name]) || this.isSolarBlinded(positions[L2.a.name], positions[L1.b.name])) continue;
              L1.a.outwards = L2.b.name; L2.b.inwards = L1.a.name;
              L2.a.outwards = L1.b.name; L1.b.inwards = L2.a.name;
              const t = L1.b; L1.b = L2.b; L2.b = t; // keep local view consistent for the rest of this pass
              fixed++;
            }
          }
        }
        crossFixed += fixed;
        if (!fixed) break; // converged: no crossing left to fix
      }
    }

    // 6) REBUILD finalLinks / existingLinks / linkCounts from the FINAL pointer state.
    this._greedyMergeRebuild(finalLinks, existingLinks, linkCounts, positions, satByName, isReal, greedyLinks, AU_IN_KM);
    this._greedyMergeDiag = { mites: mites.length, tites: tites.length, floaters: floaterTips, pairs: pairs.length, merged, crossFixed, swapDeg };
    console.info(`[greedy-merge] merged ${merged}/${pairs.length} pairs, 2-opt removed ${crossFixed} crossings (±${swapDeg}°); ${census}`);
  }

  // Shared rebuild for greedy-merge: drop greedy's snapshotted radial links and re-emit the FINAL pointer
  // state (authoritative). Decrement/increment linkCounts via sat NAMES (never split a hyphenated key); keep
  // the exact finalLinks element shape and sorted fId<tId convention used everywhere else in this file.
  _greedyMergeRebuild(finalLinks, existingLinks, linkCounts, positions, satByName, isReal, greedyLinks, AU_IN_KM) {
    const keyOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const greedyKeys = new Set(greedyLinks.map(([a, b]) => keyOf(a, b)));
    for (const [a, b] of greedyLinks) {
      const k = keyOf(a, b);
      if (existingLinks.has(k)) { existingLinks.delete(k); if (linkCounts[a] != null) linkCounts[a]--; if (linkCounts[b] != null) linkCounts[b]--; }
    }
    const kept = finalLinks.filter((l) => !greedyKeys.has(keyOf(l.fromId, l.toId)));
    finalLinks.length = 0; finalLinks.push(...kept);
    for (const s of satByName.values()) {
      if (!isReal(s.outwards)) continue;
      const a = s.name, b = s.outwards;
      const [f, t] = a < b ? [a, b] : [b, a];
      const k = `${f}-${t}`;
      if (existingLinks.has(k)) continue;
      const dAU = this.calculateDistanceAU(positions[a], positions[b]);
      const km = dAU * AU_IN_KM;
      finalLinks.push({ fromId: f, toId: t, distanceAU: dAU, distanceKm: km, latencySeconds: this.calculateLatency(km), gbpsCapacity: this.calculateGbps(km) });
      existingLinks.add(k); linkCounts[f] = (linkCounts[f] || 0) + 1; linkCounts[t] = (linkCounts[t] || 0) + 1;
    }
  }

  // Matcher "periapsis-radial": a seed route at the Mars-periapsis sun angle plus a PARALLEL
  // sweep that pulls in every satellite.
  //
  // Seed route — starts on the INNER (Earth-side) ring at the Mars-periapsis angle and chains
  // outward ring by ring; every outward hop picks the nearest available sat to the periapsis
  // angle itself, so the route stays radial.
  // Sweep — on every ring the seed sat's two angular NEIGHBOURS seed two parallel routes (one per
  // side); each newly added sat hands its next free neighbour to the next route, expanding both
  // ways to the anti-periapsis angle until every satellite is in a route. Trades per-route
  // capacity for route count; pairs with "Sat count → routes" at 100% (equal counts ⇒ clean).
  _interAdaptedRings_periapsisRadial(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks) {
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_adapt_") || ringName.startsWith("ring_circ_")
    );
    if (circularRingNames.length === 0) return;
    const parseIndex = (name) => { const m = name.match(/_(\d+)$/); return m ? parseInt(m[1], 10) : -1; };
    const ringList = circularRingNames
      .map((name) => ({ name, index: parseIndex(name), radius: rings[name][0].a }))
      .filter((r) => r.index >= 0);
    ringList.sort((a, b) => a.index - b.index);
    if (ringList.length < 2) return;
    const AU_IN_KM = this.AU_IN_KM;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    // Index-aligned per-ring structures: sats sorted by solar angle, their angles, max links.
    const ringSats = ringList.map((ring) =>
      rings[ring.name]
        .filter((s) => s.orbitalZone === "BETWEEN_EARTH_AND_MARS")
        .slice()
        .sort((a, b) => a.position.solarAngle - b.position.solarAngle)
    );
    const ringAngles = ringSats.map((sats) => sats.map((s) => s.position.solarAngle));
    const ringMax = ringList.map((ring) => this._radialMaxLinks(ring.name));
    ringList.forEach((ring, ri) => {
      if (ringMax[ri] !== 3) return; // pre-mark unavailable ports for 3-port rings
      ringSats[ri].forEach((sat, i) => { if (i % 2 === 0) sat.outwards = "premarked"; else sat.inwards = "premarked"; });
    });

    // Sweep only a consecutive run of rings starting at ringList[0] (the chain breaks at any gap).
    let K = ringList.length;
    for (let i = 1; i < ringList.length; i++) { if (ringList[i].index !== ringList[i - 1].index + 1) { K = i; break; } }
    if (K < 2 || !ringSats[0].length) return;

    // Link ring-ri sat `a` (sends outward) to ring-(ri+1) sat `b` (receives inward).
    const linkPair = (ri, a, aPos, b, bPos) => {
      if (a.outwards !== null || b.inwards !== null) return false;
      if (linkCounts[a.name] >= ringMax[ri] || linkCounts[b.name] >= ringMax[ri + 1]) return false;
      const dAU = this.calculateDistanceAU(aPos, bPos);
      if (dAU > maxDistanceAU || this.isSolarBlinded(aPos, bPos)) return false;
      const [fId, tId] = a.name < b.name ? [a.name, b.name] : [b.name, a.name];
      const key = `${fId}-${tId}`;
      if (existingLinks.has(key)) return false;
      const distanceKm = dAU * AU_IN_KM;
      finalLinks.push({ fromId: fId, toId: tId, distanceAU: dAU, distanceKm, latencySeconds: this.calculateLatency(distanceKm), gbpsCapacity: this.calculateGbps(distanceKm) });
      linkCounts[a.name]++; linkCounts[b.name]++;
      a.outwards = b.name; b.inwards = a.name;
      existingLinks.add(key);
      return true;
    };

    // Insertion index of `angle` on ring ri (first sat at/after it).
    const insertion = (ri, angle) => {
      const angles = ringAngles[ri]; let lo = 0, hi = angles.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (angles[mid] < angle) lo = mid + 1; else hi = mid; }
      return lo;
    };
    // Index on ring ri of the nearest sat to `angle` with a free inward port that forms a valid
    // link to prevPos — expand outward from the insertion point (-1 if none).
    const nearestAvailIndex = (ri, angle, prevPos) => {
      const sats = ringSats[ri], n = sats.length, lo = insertion(ri, angle);
      const ok = (idx) => {
        const sat = sats[idx];
        if (sat.inwards !== null || linkCounts[sat.name] >= ringMax[ri]) return false;
        const pos = positions[sat.name];
        if (!pos || this.isSolarBlinded(prevPos, pos)) return false;
        return this.calculateDistanceAU(prevPos, pos) <= maxDistanceAU;
      };
      for (let step = 0; step <= n; step++) {
        const a = (((lo + step) % n) + n) % n;
        if (ok(a)) return a;
        if (step > 0) { const b = (((lo - step) % n) + n) % n; if (ok(b)) return b; }
      }
      return -1;
    };

    // --- Seed route from the inner ring at the Mars-periapsis sun angle ---
    const mars = this.simSatellites && this.simSatellites.getMars ? this.simSatellites.getMars() : null;
    const theta0 = ((((mars && mars.p) || 0) % 360) + 360) % 360;
    const route0Idx = new Array(K).fill(-1);

    // Anchor: inner sat nearest theta0 with a free outward port.
    {
      const sats = ringSats[0], n = sats.length, lo = insertion(0, theta0);
      for (let step = 0; step <= n && route0Idx[0] < 0; step++) {
        for (const idx of (step === 0 ? [((lo % n) + n) % n] : [(((lo + step) % n) + n) % n, (((lo - step) % n) + n) % n])) {
          const sat = sats[idx];
          if (sat.outwards === null && linkCounts[sat.name] < ringMax[0]) { route0Idx[0] = idx; break; }
        }
      }
    }
    if (route0Idx[0] < 0) return;
    {
      let prev = ringSats[0][route0Idx[0]], prevPos = positions[prev.name];
      for (let ri = 1; ri < K; ri++) {
        const guide = theta0; // radial: every outward hop stays at the periapsis angle
        const idx = nearestAvailIndex(ri, guide, prevPos);
        if (idx < 0 || !linkPair(ri - 1, prev, prevPos, ringSats[ri][idx], positions[ringSats[ri][idx].name])) { K = ri; break; }
        route0Idx[ri] = idx;
        prev = ringSats[ri][idx]; prevPos = positions[prev.name];
      }
    }
    if (K < 2) return;

    // --- Parallel sweep: each ring's seed sat hands its two neighbours to two parallel routes;
    //     each new sat's next free neighbour seeds the next route, both ways to anti-periapsis. ---
    const portFree = (ri, sat) =>
      (ri === 0 ? sat.outwards === null : sat.inwards === null) && linkCounts[sat.name] < ringMax[ri];
    // Advance a per-ring frontier one step in direction d (+1 cw / -1 ccw) to the next free sat.
    const advance = (ri, d, frontier) => {
      const n = ringSats[ri].length;
      let idx = frontier[ri];
      for (let s = 0; s < n; s++) {
        idx = (((idx + d) % n) + n) % n;
        if (portFree(ri, ringSats[ri][idx])) { frontier[ri] = idx; return idx; }
      }
      return -1;
    };
    // Build one parallel route on side d (the neighbour-of-neighbour on every ring); link the chain.
    const sweepRoute = (d, frontier) => {
      const idxs = new Array(K);
      for (let ri = 0; ri < K; ri++) idxs[ri] = advance(ri, d, frontier);
      if (idxs[0] < 0) return false; // inner ring exhausted on this side
      for (let ri = 0; ri < K - 1; ri++) {
        if (idxs[ri] < 0 || idxs[ri + 1] < 0) continue;
        const a = ringSats[ri][idxs[ri]], b = ringSats[ri + 1][idxs[ri + 1]];
        linkPair(ri, a, positions[a.name], b, positions[b.name]);
      }
      return true;
    };
    const cw = route0Idx.slice(0, K), ccw = route0Idx.slice(0, K);
    let cwGoing = true, ccwGoing = true, guard = 0;
    const guardMax = ringSats[0].length * 2 + 10;
    while ((cwGoing || ccwGoing) && guard++ < guardMax) {
      if (cwGoing) cwGoing = sweepRoute(1, cw);
      if (ccwGoing) ccwGoing = sweepRoute(-1, ccw);
    }
  }

  // Matcher "periapsis-chain": identical to "periapsis-radial" except for how the seed route
  // advances. The route still starts on the INNER (Earth-side) ring at the Mars-periapsis angle,
  // but each outward hop picks the nearest available sat to the PREVIOUS sat's solar angle, so the
  // route follows the path of least resistance and may drift away from the periapsis angle as it
  // climbs outward. The parallel sweep is unchanged.
  _interAdaptedRings_periapsisChain(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks) {
    const circularRingNames = Object.keys(rings).filter(
      (ringName) => ringName.startsWith("ring_adapt_") || ringName.startsWith("ring_circ_")
    );
    if (circularRingNames.length === 0) return;
    const parseIndex = (name) => { const m = name.match(/_(\d+)$/); return m ? parseInt(m[1], 10) : -1; };
    const ringList = circularRingNames
      .map((name) => ({ name, index: parseIndex(name), radius: rings[name][0].a }))
      .filter((r) => r.index >= 0);
    ringList.sort((a, b) => a.index - b.index);
    if (ringList.length < 2) return;
    const AU_IN_KM = this.AU_IN_KM;
    const maxDistanceAU = this.simLinkBudget.maxDistanceAU;

    // Index-aligned per-ring structures: sats sorted by solar angle, their angles, max links.
    const ringSats = ringList.map((ring) =>
      rings[ring.name]
        .filter((s) => s.orbitalZone === "BETWEEN_EARTH_AND_MARS")
        .slice()
        .sort((a, b) => a.position.solarAngle - b.position.solarAngle)
    );
    const ringAngles = ringSats.map((sats) => sats.map((s) => s.position.solarAngle));
    const ringMax = ringList.map((ring) => this._radialMaxLinks(ring.name));
    ringList.forEach((ring, ri) => {
      if (ringMax[ri] !== 3) return; // pre-mark unavailable ports for 3-port rings
      ringSats[ri].forEach((sat, i) => { if (i % 2 === 0) sat.outwards = "premarked"; else sat.inwards = "premarked"; });
    });

    // Sweep only a consecutive run of rings starting at ringList[0] (the chain breaks at any gap).
    let K = ringList.length;
    for (let i = 1; i < ringList.length; i++) { if (ringList[i].index !== ringList[i - 1].index + 1) { K = i; break; } }
    if (K < 2 || !ringSats[0].length) return;

    // Link ring-ri sat `a` (sends outward) to ring-(ri+1) sat `b` (receives inward).
    const linkPair = (ri, a, aPos, b, bPos) => {
      if (a.outwards !== null || b.inwards !== null) return false;
      if (linkCounts[a.name] >= ringMax[ri] || linkCounts[b.name] >= ringMax[ri + 1]) return false;
      const dAU = this.calculateDistanceAU(aPos, bPos);
      if (dAU > maxDistanceAU || this.isSolarBlinded(aPos, bPos)) return false;
      const [fId, tId] = a.name < b.name ? [a.name, b.name] : [b.name, a.name];
      const key = `${fId}-${tId}`;
      if (existingLinks.has(key)) return false;
      const distanceKm = dAU * AU_IN_KM;
      finalLinks.push({ fromId: fId, toId: tId, distanceAU: dAU, distanceKm, latencySeconds: this.calculateLatency(distanceKm), gbpsCapacity: this.calculateGbps(distanceKm) });
      linkCounts[a.name]++; linkCounts[b.name]++;
      a.outwards = b.name; b.inwards = a.name;
      existingLinks.add(key);
      return true;
    };

    // Insertion index of `angle` on ring ri (first sat at/after it).
    const insertion = (ri, angle) => {
      const angles = ringAngles[ri]; let lo = 0, hi = angles.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (angles[mid] < angle) lo = mid + 1; else hi = mid; }
      return lo;
    };
    // Index on ring ri of the nearest sat to `angle` with a free inward port that forms a valid
    // link to prevPos — expand outward from the insertion point (-1 if none).
    const nearestAvailIndex = (ri, angle, prevPos) => {
      const sats = ringSats[ri], n = sats.length, lo = insertion(ri, angle);
      const ok = (idx) => {
        const sat = sats[idx];
        if (sat.inwards !== null || linkCounts[sat.name] >= ringMax[ri]) return false;
        const pos = positions[sat.name];
        if (!pos || this.isSolarBlinded(prevPos, pos)) return false;
        return this.calculateDistanceAU(prevPos, pos) <= maxDistanceAU;
      };
      for (let step = 0; step <= n; step++) {
        const a = (((lo + step) % n) + n) % n;
        if (ok(a)) return a;
        if (step > 0) { const b = (((lo - step) % n) + n) % n; if (ok(b)) return b; }
      }
      return -1;
    };

    // --- Seed route from the inner ring at the Mars-periapsis sun angle ---
    const mars = this.simSatellites && this.simSatellites.getMars ? this.simSatellites.getMars() : null;
    const theta0 = ((((mars && mars.p) || 0) % 360) + 360) % 360;
    const route0Idx = new Array(K).fill(-1);

    // Anchor: inner sat nearest theta0 with a free outward port.
    {
      const sats = ringSats[0], n = sats.length, lo = insertion(0, theta0);
      for (let step = 0; step <= n && route0Idx[0] < 0; step++) {
        for (const idx of (step === 0 ? [((lo % n) + n) % n] : [(((lo + step) % n) + n) % n, (((lo - step) % n) + n) % n])) {
          const sat = sats[idx];
          if (sat.outwards === null && linkCounts[sat.name] < ringMax[0]) { route0Idx[0] = idx; break; }
        }
      }
    }
    if (route0Idx[0] < 0) return;
    {
      let prev = ringSats[0][route0Idx[0]], prevPos = positions[prev.name];
      for (let ri = 1; ri < K; ri++) {
        const guide = prevPos.solarAngle; // chain: each outward hop follows the previous sat's solar angle
        const idx = nearestAvailIndex(ri, guide, prevPos);
        if (idx < 0 || !linkPair(ri - 1, prev, prevPos, ringSats[ri][idx], positions[ringSats[ri][idx].name])) { K = ri; break; }
        route0Idx[ri] = idx;
        prev = ringSats[ri][idx]; prevPos = positions[prev.name];
      }
    }
    if (K < 2) return;

    // --- Sweep: every remaining inner-ring sat (expanding both ways from the periapsis seed) starts
    //     its OWN route and chains outward to the NEAREST available sat at each hop — the same rule
    //     as the seed route. Unlike a frontier-to-frontier sweep, this never pairs misaligned
    //     frontiers, so it emits no long cross-links when adjacent rings have different sat counts;
    //     surplus outer sats with no near inner partner are simply left for the intra-ring pass. ---
    const portFree = (ri, sat) =>
      (ri === 0 ? sat.outwards === null : sat.inwards === null) && linkCounts[sat.name] < ringMax[ri];
    // Advance the inner-ring frontier one step in direction d (+1 cw / -1 ccw) to the next free sat.
    const advanceInner = (d, frontier) => {
      const n = ringSats[0].length;
      let idx = frontier[0];
      for (let s = 0; s < n; s++) {
        idx = (((idx + d) % n) + n) % n;
        if (portFree(0, ringSats[0][idx])) { frontier[0] = idx; return idx; }
      }
      return -1;
    };
    // Start a route at the next free inner-ring sat on side d, then chain it outward ring by ring,
    // each hop linking to the nearest available sat on the next ring (nearestAvailIndex skips taken
    // sats and any that would exceed range or hit the Sun, so every link stays as short as possible).
    const sweepRoute = (d, frontier) => {
      const i0 = advanceInner(d, frontier);
      if (i0 < 0) return false; // inner ring exhausted on this side
      let prev = ringSats[0][i0], prevPos = positions[prev.name];
      for (let ri = 1; ri < K; ri++) {
        const idx = nearestAvailIndex(ri, prevPos.solarAngle, prevPos);
        if (idx < 0 || !linkPair(ri - 1, prev, prevPos, ringSats[ri][idx], positions[ringSats[ri][idx].name])) break;
        prev = ringSats[ri][idx]; prevPos = positions[prev.name];
      }
      return true;
    };
    const cw = route0Idx.slice(0, K), ccw = route0Idx.slice(0, K);
    let cwGoing = true, ccwGoing = true, guard = 0;
    const guardMax = ringSats[0].length * 2 + 10;
    while ((cwGoing || ccwGoing) && guard++ < guardMax) {
      if (cwGoing) cwGoing = sweepRoute(1, cw);
      if (ccwGoing) ccwGoing = sweepRoute(-1, ccw);
    }
  }

  // ===========================================================================================
  // Matcher "max-throughput": node-disjoint Earth→Mars relay chains that maximise AGGREGATE
  // throughput = Σ over routes of calculateGbps(route's LONGEST segment). Because routes are
  // node-disjoint series chains and calculateGbps ≈ 1/d², a route's value is set by its single
  // longest hop and a SHORT route is worth quadratically more — so we pack the FATTEST routes
  // (smallest bottleneck) first. Each round runs a lexicographic widest-path DP over the
  // sun-distance DAG, commits the fattest complete route, marks its nodes used, and repeats.
  //
  // Robustness over the previous (removed) version is the whole point:
  //   • Endpoints are decided by sat.suitable ("Earth" start / "Mars" sink), NOT by ring index —
  //     eccentric/adapted rings are NOT monotonic in solar distance R, so a ring index says
  //     nothing about where a sat sits radially. (R-extreme fallback only if suitable is absent.)
  //   • Forward direction is strictly increasing R (real 3D sun distance); the graph is a DAG.
  //   • Candidate next-hops come from a hashed uniform CARTESIAN grid (x,y,z), bounded to an
  //     angular cone around the radial-outward direction — O(N·k), never O(N²), and no (R,θ) seam.
  //   • Edge weight is REAL 3D distance, so a small radial gap between MISALIGNED sats is simply a
  //     long edge; minimising the route's MAX edge finds the true bottleneck wherever it lies.
  //   • Strict node-disjointness, meticulous free-port/"premarked" handling, complete routes only.
  // targetDepartureAngle is UNUSED here (we route on real 3D distances, not an angular offset).
  // No always-on upper bound: a normal build never computes one (the opt-in helper is separate).
  _interAdaptedRings_maxThroughput(rings, positions, linkCounts, finalLinks, targetDepartureAngle = 0, satellites, existingLinks) {
    const relayNames = Object.keys(rings).filter((n) => n.startsWith("ring_adapt_") || n.startsWith("ring_circ_"));
    if (relayNames.length < 1) return;

    const AU_IN_KM = this.AU_IN_KM;
    // Geometric range cap only. routeRequiredGbps stays an OPTIONAL per-segment feasibility floor
    // (not the objective): if set, no hop may exceed L(R)=calculateKm(R), so every route clears R.
    const R = this.simLinkBudget.routeRequiredGbps || 0;
    const Lkm = R > 0 ? this.simLinkBudget.calculateKm(R) : Infinity;
    const maxAU = Math.min(this.simLinkBudget.maxDistanceAU, Lkm / AU_IN_KM);
    if (!(maxAU > 0)) return;

    // --- Relay pool. Tag each node with its real sun distance R and port availability snapshot.
    //     We snapshot once: committing a route only consumes nodes we then mark `used`, so the
    //     flags stay valid for every node still in play (3-port rings expose exactly one side). ---
    const radialMax = (sat) => this._radialMaxLinks(sat.ringName);
    const pool = []; // { sat, pos, R, outFree, inFree, suitEarth, suitMars }
    for (const rn of relayNames) {
      const ringSats = rings[rn];
      if (!ringSats) continue;
      for (const sat of ringSats) {
        if (sat.orbitalZone !== "BETWEEN_EARTH_AND_MARS") continue; // backbone lives between the planets
        const pos = positions[sat.name];
        if (!pos) continue;
        const budget = (linkCounts[sat.name] || 0) < radialMax(sat);
        const outFree = budget && sat.outwards === null; // "premarked"/a name ⇒ TAKEN (non-null)
        const inFree = budget && sat.inwards === null;
        if (!outFree && !inFree) continue; // no usable radial port ⇒ can never be on a route
        const suit = sat.suitable;
        pool.push({
          sat, pos, R: this.calculateDistanceToSunAU(pos), outFree, inFree,
          suitEarth: !!(suit && suit.includes("Earth")),
          suitMars: !!(suit && suit.includes("Mars")),
        });
      }
    }
    const m = pool.length;
    if (m < 2) return;

    // Sun-distance order = topological order of the forward DAG (forward = increasing R). The DP
    // relaxes nodes in this order, so a single linear pass suffices. Stable index = sort position.
    pool.sort((a, b) => a.R - b.R);
    const Rsorted = pool.map((p) => p.R);

    // --- Endpoints by SUITABILITY, with the documented R-extreme fallback. A start needs a free
    //     OUTWARD port (it sends outward); a sink needs a free INWARD port (it receives inward). ---
    const canStart = new Array(m), canEnd = new Array(m);
    let anyStartSuit = false, anyEndSuit = false;
    for (let i = 0; i < m; i++) {
      if (pool[i].suitEarth) anyStartSuit = true;
      if (pool[i].suitMars) anyEndSuit = true;
    }
    // Fallback thresholds: innermost 20% of R are Earth-side starts, outermost 20% Mars-side sinks.
    // Only used for whichever endpoint class carries NO suitable marking at all (defensive).
    const startCutR = Rsorted[Math.max(0, Math.floor(m * 0.2) - 1)];
    const endCutR = Rsorted[Math.min(m - 1, Math.ceil(m * 0.8))];
    for (let i = 0; i < m; i++) {
      const p = pool[i];
      const startOK = anyStartSuit ? p.suitEarth : p.R <= startCutR;
      const endOK = anyEndSuit ? p.suitMars : p.R >= endCutR;
      canStart[i] = startOK && p.outFree;
      canEnd[i] = endOK && p.inFree;
    }

    // --- Cartesian spatial index for K-NEAREST-FORWARD candidate lookup. The cell is sized to the
    //     LOCAL sat spacing (NOT maxAU): a widest-path route only ever wants SHORT hops — a long hop
    //     would be its bottleneck — so each node keeps only its K nearest forward in-range partners.
    //     Sizing the cell to maxAU (≈0.5 AU) was the O(N²) trap: one cell then held thousands of sats.
    //     Here kNN by expanding cell-shells with early termination is O(N·K). ---
    const K_CAND = 8; // nearest forward candidates kept per node
    let rMin = Infinity, rMax = 0;
    for (let i = 0; i < m; i++) { const R = pool[i].R; if (R < rMin) rMin = R; if (R > rMax) rMax = R; }
    const annulusArea = Math.max(Math.PI * (rMax * rMax - rMin * rMin), 1e-6);
    const spacing = Math.sqrt(annulusArea / m);          // ≈ inter-sat spacing ⇒ a few sats per cell
    const cell = Math.min(maxAU, Math.max(spacing, 1e-9)); // never coarser than maxAU, never zero
    // Cap the shell expansion low: the K nearest forward sats are within a couple of spacings, and
    // a hop beyond ~6 spacings would be a ruinous bottleneck we'd never pick. Without this cap, a
    // node with few forward partners (every outer-ring/Mars-sink sat) scans thousands of empty cells.
    const maxRing = Math.min(Math.ceil(maxAU / cell), 6);
    const cellOf = (v) => Math.floor(v / cell);
    const grid = new Map();
    for (let i = 0; i < m; i++) {
      const pos = pool[i].pos, k = `${cellOf(pos.x)},${cellOf(pos.y)},${cellOf(pos.z)}`;
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, (bucket = []));
      bucket.push(i);
    }

    // --- Forward adjacency = the ≤K nearest valid forward hops. Edge i→j needs: j strictly farther
    //     in R, real 3D distance ≤ maxAU, inside a 75° cone of i's radial-outward direction (rejects
    //     sideways links; ring-SKIPS still allowed), not sun-blinded, both ports free, not already
    //     linked. Expand cell-shells around i keeping the K smallest-distance candidates; stop once K
    //     are held and no nearer one can lie in a farther shell. Secondary cost = angular deviation. ---
    const CONE_COS = Math.cos((75 * Math.PI) / 180);
    const adj = Array.from({ length: m }, () => []);
    for (let i = 0; i < m; i++) {
      const a = pool[i];
      if (!a.outFree) continue; // a relays OUTWARD via its outward port
      const ax = a.pos.x, ay = a.pos.y, az = a.pos.z, aR = a.R;
      const cx = cellOf(ax), cy = cellOf(ay), cz = cellOf(az);
      const kept = []; // {j, dAU, dev} — the K smallest-dAU candidates found so far
      let worst = Infinity; // largest dAU in `kept` once it holds K (the displacement threshold)
      for (let r = 0; r <= maxRing; r++) {
        if (kept.length >= K_CAND && (r - 1) * cell > worst) break; // no nearer one can be farther out
        for (let dx = -r; dx <= r; dx++)
          for (let dy = -r; dy <= r; dy++)
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue; // shell only
              const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
              if (!bucket) continue;
              for (let t = 0; t < bucket.length; t++) {
                const j = bucket[t];
                if (j === i) continue;
                const b = pool[j];
                if (b.R <= aR || !b.inFree) continue; // strictly outward; b receives inward
                const ddx = b.pos.x - ax, ddy = b.pos.y - ay, ddz = b.pos.z - az;
                const dAU = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
                if (dAU > maxAU || dAU <= 0) continue;
                if (kept.length >= K_CAND && dAU >= worst) continue; // cannot displace a kept one
                const radialCos = (ddx * ax + ddy * ay + ddz * az) / (dAU * (aR || 1e-12));
                if (radialCos < CONE_COS) continue; // sideways ⇒ rejected
                if (this.isSolarBlinded(a.pos, b.pos)) continue; // expensive checks last
                const nm = a.sat.name < b.sat.name ? `${a.sat.name}-${b.sat.name}` : `${b.sat.name}-${a.sat.name}`;
                if (existingLinks.has(nm)) continue;
                const dev = Math.acos(Math.max(-1, Math.min(1, radialCos)));
                kept.push({ j, dAU, dev });
                if (kept.length > K_CAND) { // drop the current farthest, keep K
                  let wi = 0; for (let q = 1; q < kept.length; q++) if (kept[q].dAU > kept[wi].dAU) wi = q;
                  kept.splice(wi, 1);
                }
                if (kept.length >= K_CAND) { worst = 0; for (let q = 0; q < kept.length; q++) if (kept[q].dAU > worst) worst = kept[q].dAU; }
              }
            }
      }
      adj[i] = kept;
    }

    // --- Periapsis-outward sweep order for the START nodes. Build the highest-value routes near
    //     the Mars-periapsis sun angle first (sweeping both angular directions), so the fattest
    //     geometry is claimed before its nodes get consumed by lesser routes. solarAngle is in
    //     degrees [0,360); angular distance is the wrapped separation from theta0. ---
    const mars = this.simSatellites && this.simSatellites.getMars ? this.simSatellites.getMars() : null;
    const theta0 = ((((mars && mars.p) || 0) % 360) + 360) % 360;
    const angDist = (deg) => { const d = Math.abs((((deg - theta0) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };
    const startOrder = [];
    for (let i = 0; i < m; i++) if (canStart[i]) startOrder.push(i);
    startOrder.sort((a, b) => angDist(pool[a].pos.solarAngle) - angDist(pool[b].pos.solarAngle));

    // --- Link emission. Match the canonical 6-field shape; from = lower-R (Earth-side) endpoint. ---
    const emitLink = (fromIdx, toIdx, dAU) => {
      const from = pool[fromIdx].sat, to = pool[toIdx].sat;
      const distanceKm = dAU * AU_IN_KM;
      const [fId, tId] = from.name < to.name ? [from.name, to.name] : [to.name, from.name];
      const key = `${fId}-${tId}`;
      if (existingLinks.has(key)) return; // belt-and-braces; adjacency already excluded these
      finalLinks.push({
        fromId: fId, toId: tId, distanceAU: dAU, distanceKm,
        latencySeconds: this.calculateLatency(distanceKm), gbpsCapacity: this.calculateGbps(distanceKm),
      });
      linkCounts[from.name] = (linkCounts[from.name] || 0) + 1;
      linkCounts[to.name] = (linkCounts[to.name] || 0) + 1;
      existingLinks.add(key);
      from.outwards = to.name; to.inwards = from.name; // from is nearer the Sun (Earth-side)
    };

    // --- Per-start lexicographic widest-path DP over not-yet-used nodes. Key per node =
    //     (bottleneck = max edge AU so far, secondary = Σ angular deviation + anti-island drift).
    //     We touch ONLY each start's reachable wedge: a forward DFS collects it, then we relax in
    //     ascending-index (= topological) order. Persistent scratch + a generation stamp avoid the
    //     per-start O(m) realloc/scan that made the naive version O(starts·m). ---
    const used = new Array(m).fill(false);
    const EPS = 1e-9; // two bottlenecks within EPS are a "tie" / decision point
    const STRIP_DEG = 25; // max sun-angle drift of a route from its start (bounds each wedge size)
    const angSep = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; };
    // Anti-island bias: prefer staying angularly near the PREVIOUS committed route's mean angle.
    let prevRouteAngle = null;
    const angleNear = (deg) => prevRouteAngle === null ? 0 : (() => {
      const d = Math.abs((((deg - prevRouteAngle) % 360) + 360) % 360); return (d > 180 ? 360 - d : d) / 180;
    })();

    const diag = { routeCount: 0, islandCount: 0, forkCount: 0, totalGbps: 0, bottlenecksAU: [], forksPerRoute: [] };

    // Persistent DP scratch reused across starts; stamp[i] === gen ⇒ i is in this start's wedge.
    const bott = new Float64Array(m);
    const sec = new Float64Array(m);
    const pred = new Int32Array(m);
    const stamp = new Int32Array(m);
    let gen = 0;
    const stack = [], touched = [];

    for (let s = 0; s < startOrder.length; s++) {
      const src = startOrder[s];
      if (used[src] || !canStart[src]) continue;
      gen++;

      // Discover the reachable wedge (forward DFS over not-yet-used nodes), bounded to an angular
      // STRIP around the start. The 75° per-hop cone alone lets the wedge balloon across the whole
      // disc (so the "localized" DP degenerates to O(m) per start); a near-radial route never drifts
      // far in sun angle, and any larger drift means long sideways hops = a worse bottleneck, so the
      // strip discards no fat route while keeping each wedge a thin band.
      const startAngle = pool[src].pos.solarAngle;
      touched.length = 0; stack.length = 0;
      stack.push(src); stamp[src] = gen;
      while (stack.length) {
        const u = stack.pop(); touched.push(u);
        const list = adj[u];
        for (let k = 0; k < list.length; k++) {
          const j = list[k].j;
          if (used[j] || stamp[j] === gen) continue;
          if (angSep(pool[j].pos.solarAngle, startAngle) > STRIP_DEG) continue; // outside the strip
          stamp[j] = gen; stack.push(j);
        }
      }
      // Initialise only the wedge, then relax in topological (ascending-index) order.
      for (let t = 0; t < touched.length; t++) { const u = touched[t]; bott[u] = Infinity; sec[u] = Infinity; pred[u] = -1; }
      bott[src] = 0; sec[src] = 0;
      touched.sort((a, b) => a - b);

      let forks = 0;
      for (let t = 0; t < touched.length; t++) {
        const i = touched[t];
        if (bott[i] === Infinity) continue;
        const bi = bott[i], si = sec[i], list = adj[i];
        // Best-two child bottlenecks ⇒ near-tied fork (decision point).
        let best1 = Infinity, best2 = Infinity;
        for (let k = 0; k < list.length; k++) {
          const e = list[k], j = e.j;
          if (used[j]) continue;
          const cand = bi > e.dAU ? bi : e.dAU;          // bottleneck = max(parent, this edge)
          const candSec = si + e.dev + angleNear(pool[j].pos.solarAngle);
          if (cand < best1) { best2 = best1; best1 = cand; } else if (cand < best2) { best2 = cand; }
          if (cand < bott[j] - EPS || (Math.abs(cand - bott[j]) <= EPS && candSec < sec[j])) {
            bott[j] = cand; sec[j] = candSec; pred[j] = i;
          }
        }
        if (best1 !== Infinity && best2 !== Infinity && Math.abs(best1 - best2) <= EPS) forks++;
      }

      // Best reachable Mars-suitable sink: smallest bottleneck, then smallest secondary cost.
      // Exclude src itself — a dual-suitable ["Earth","Mars"] start (bott=0) must reach a REAL
      // farther Mars-suitable sink, never form a zero-hop self-route.
      let sink = -1, sinkB = Infinity, sinkS = Infinity;
      for (let t = 0; t < touched.length; t++) {
        const i = touched[t];
        if (i === src || !canEnd[i] || bott[i] === Infinity) continue;
        if (bott[i] < sinkB - EPS || (Math.abs(bott[i] - sinkB) <= EPS && sec[i] < sinkS)) {
          sinkB = bott[i]; sinkS = sec[i]; sink = i;
        }
      }
      if (sink === -1) { diag.islandCount++; continue; } // ISLAND: count it, commit nothing.

      // Recover the route (pred chain stays inside the wedge, all not-used), commit, mark used.
      const path = [];
      for (let v = sink; v !== -1; v = pred[v]) path.push(v);
      if (path.length < 2) { diag.islandCount++; continue; }
      path.reverse(); // src … sink (ascending R)

      let maxKm = 0, angleSum = 0;
      for (let p = 0; p < path.length - 1; p++) {
        const a = path[p], b = path[p + 1];
        const dAU = this.calculateDistanceAU(pool[a].pos, pool[b].pos);
        emitLink(a, b, dAU);
        const km = dAU * AU_IN_KM; if (km > maxKm) maxKm = km;
      }
      for (let p = 0; p < path.length; p++) { used[path[p]] = true; angleSum += pool[path[p]].pos.solarAngle; }
      prevRouteAngle = angleSum / path.length; // anti-island anchor for the next route

      const gbps = this.calculateGbps(maxKm);
      diag.totalGbps += gbps;
      diag.routeCount++;
      diag.forkCount += forks;
      diag.bottlenecksAU.push(maxKm / AU_IN_KM);
      diag.forksPerRoute.push(forks);
    }

    // --- Decision-point / island diagnostics. NO upper bound here (that is an opt-in helper). ---
    this._maxThroughputDiag = {
      routeCount: diag.routeCount,
      islandCount: diag.islandCount,
      forkCount: diag.forkCount,
      totalGbps: diag.totalGbps,
      nodeCount: m,
      bottlenecksAU: diag.bottlenecksAU,
      forksPerRoute: diag.forksPerRoute,
      meanBottleneckAU: diag.bottlenecksAU.length
        ? diag.bottlenecksAU.reduce((acc, x) => acc + x, 0) / diag.bottlenecksAU.length : 0,
      maxBottleneckAU: diag.bottlenecksAU.length ? Math.max(...diag.bottlenecksAU) : 0,
    };
    console.info(
      `[max-throughput] ${diag.totalGbps.toFixed(1)} Gbps over ${diag.routeCount} routes` +
      ` (${diag.islandCount} islands, ${diag.forkCount} forks, ${m} relay nodes)`
    );
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

    // Create a map from satellite name to satellite object
    const satMap = new Map();
    Object.values(rings).forEach((ringSats) => {
      ringSats.forEach((sat) => satMap.set(sat.name, sat));
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
            // Find the link to get metrics. Links are keyed lexicographically
            // (fromId < toId) regardless of the outward walk direction, so look the
            // segment up UNDIRECTED. A directed lookup (linkMap by fromId) silently
            // missed every reverse-stored hop, dropping it from the route's min and
            // inflating per-route throughput (and understating latency).
            const outwardLink = linkByPair.get(currentSat.name + "|" + nextSatName);
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
            // Relay-intrinsic capacity: the chain's own bottleneck BEFORE the planet-ring
            // hops are folded in. The Earth/Mars auto-sizer must consume THIS number —
            // sizing the planet rings from the planet-hop-inclusive total feeds the
            // previous planet-ring size back into the next sizing (hysteresis, with a
            // downward ratchet). Routing/optimization effects are still captured: this is
            // measured on the real routed graph, not a formula.
            route.relayOnlyMbps = isFinite(route.throughputMbps)
              ? route.throughputMbps
              : Math.min(earthCap, marsCap);
            route.throughputMbps = Math.min(route.throughputMbps, earthCap, marsCap);
            routes.push(route);
          }
        }
      }
    });

    // Calculate and return summary + individual routes
    if (routes.length > 0) {
      const totalThroughput = routes.reduce((sum, r) => sum + r.throughputMbps, 0);
      // Intrinsic relay-network capacity (planet-ring gateway hops excluded) — the
      // deterministic sizing input for the Earth/Mars auto-sizer.
      const relayOnlyThroughput = routes.reduce(
        (sum, r) => sum + (isFinite(r.relayOnlyMbps) ? r.relayOnlyMbps : r.throughputMbps), 0);
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
        relayOnlyThroughput,
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
      // Eccentric routes already exclude the junction hops from capacity (latency-only
      // above), so the total IS the relay-intrinsic number; alias it for a uniform API.
      relayOnlyThroughput: totalThroughput,
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
      const maxLinks = this._radialMaxLinks(ring.name);
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

    // Concentric relay rings (circular / adapted concentric) take their radial backbone
    // FIRST (interAdaptedRings), THEN their planet-ring connections, and only THEN the
    // azimuthal lattice (intraRing) fills any spare terminals. Ordering the planet links
    // BEFORE the lattice is essential: a dense lattice would otherwise consume the spare
    // terminals the planet-ring links need, leaving the relay disconnected from Earth/Mars.
    // What remains after radial + planet + lattice is the spacecraft-accessible spare.
    t = performance.now();
    this.interAdaptedRings(rings, positions, linkCounts, finalLinks, targetDepartureAngle, satellites, existingLinks);
    mark("interAdaptedRings", t);

    t = performance.now();
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_mars", targetDepartureAngle, existingLinks);
    this.planetToCircularRings(rings, positions, linkCounts, finalLinks, "ring_earth", targetDepartureAngle, existingLinks);
    // Strip incomplete radial chains (incl. their planet links) once both planet rings are
    // attached — "Require inner link" drops chains not reaching Earth, "Require outer link" those
    // not reaching Mars. No-op unless a toggle is set. Before intraRing so freed ports feed the lattice.
    this.pruneIncompleteRadialChains(rings, linkCounts, finalLinks, existingLinks);
    mark("planetToCircularRings", t);

    t = performance.now();
    this.intraRing(rings, positions, linkCounts, finalLinks, existingLinks);
    mark("intraRing", t);

    t = performance.now();
    // Eccentric relay families attach to both planet rings by proximity (each ellipse
    // touches Earth at perihelion and Mars at aphelion), not via the concentric
    // `suitable` flag. (Kept after intraRing so eccentric azimuthal ordering is unchanged.)
    this.planetToEccentricRings(rings, positions, linkCounts, finalLinks, "ring_mars", existingLinks);
    this.planetToEccentricRings(rings, positions, linkCounts, finalLinks, "ring_earth", existingLinks);
    mark("planetToEccentricRings", t);

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
   * Captures structured topology info for the concentric-topology-aware max-flow algorithm.
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
