// topologyAware.js — Specialized max-flow for the Marslink constellation topology.
//
// Exploits the known structure:
//
//   1. Earth and Mars rings are FULL LOOPS composed of two half-chains joined
//      at the back-side (opposite the planet) by one in-ring link. Naming:
//        ring_earth-N   = positive-side chain (planet → -0 → -1 → ... → -K)
//        ring_earth--N  = negative-side chain
//      The back-side closing link connects the last positive-chain sat to the
//      last negative-chain sat directly.
//
//   2. Each planet connects to exactly 2 ring satellites (one per side).
//
//   3. Adapted-ring routes are pre-computed by the topology builder: each has
//      a known origin (earth-ring entry sat), destination (mars-ring exit sat),
//      an aggregated throughputMbps, and a latencySeconds.
//
// For each relay route we enumerate up to FOUR paths:
//
//     (natural earth side, natural mars side) — direct, low-latency.
//     (opposite earth,    natural mars)       — wrap-around on the earth side.
//     (natural earth,     opposite mars)      — wrap-around on the mars side.
//     (opposite earth,    opposite mars)      — wrap around both (rarely used).
//
// A wrap-around traverses the opposite-side chain forward (planet → tip), the
// back-side bridge link, then the natural-side chain in REVERSE (tip → entry).
// It typically adds ~3/4 of a ring's in-ring latency on top of the direct path,
// so it sinks to the bottom of the latency-sorted pool. The wrap-around only
// grabs flow when the direct path has saturated the natural-side planet link
// while the opposite-side planet link still has capacity. If the configuration
// has `sideExtensionDeg < 180` the back-side link doesn't exist → only the
// direct path is built (same behavior as the old single-path algorithm).
//
// OPTIMIZATION: Ring chain segments between "important" sats (planet
// connection points and adapted-ring exit points) are collapsed into virtual
// edges. Greedy push walks those collapsed segments rather than thousands of
// physical intra-ring edges.
//
// RESIDUAL TRACKING:
//   - Regular edges: standard antisymmetric flows (flows[u_v] = -flows[v_u]).
//   - Segments: SIGNED netFlow per virtualKey. Positive = chain order (fwd,
//     "outward from planet"). Negative = reverse chain order (rev, "inward
//     toward planet"). Residual in fwd direction = cap − netFlow. Residual in
//     rev direction = cap + netFlow. Matches the antisymmetric interpretation
//     used for regular edges: rev traffic "cancels" fwd traffic.
//
// Algorithm: sort all candidate paths by latency, then greedy push.

const EPS = 1e-12;

/**
 * @param {import("./interface.js").MaxFlowInput & { topology: Object, nodeIds: Map<string, number> }} input
 * @returns {import("./interface.js").MaxFlowResult | null}
 */
export function topologyAware({ graph, capacities, source, sink, perfStart, calctimeMs, topology, nodeIds }) {
  if (!topology || !topology.routes || topology.routes.length === 0) {
    return { maxFlow: 0, flows: {} };
  }

  const {
    earthChains,
    marsChains,
    earthCollapsed,
    marsCollapsed,
    earthPlanetLinks,
    marsPlanetLinks,
    linkByKey,
    allLinks,
    routes,
  } = topology;

  // --- Step 1: Build reverse lookups from "route origin" (adapted ring sat)
  //     to the earth-ring sat that connects into it, and similarly for mars.
  const earthRingEntryForAdapted = new Map(); // adaptedSatName -> earthRingSatName
  const marsRingExitForAdapted = new Map();   // adaptedSatName -> marsRingSatName

  const earthPosSet = new Set(earthChains.positive || []);
  const earthNegSet = new Set(earthChains.negative || []);
  const marsPosSet = new Set(marsChains.positive || []);
  const marsNegSet = new Set(marsChains.negative || []);
  const earthRingSet = new Set([...earthPosSet, ...earthNegSet]);
  const marsRingSet = new Set([...marsPosSet, ...marsNegSet]);

  const ADAPT = "ring_adapt_";
  for (const link of allLinks || []) {
    const { fromId, toId } = link;
    const fromIsAdapt = fromId.startsWith(ADAPT);
    const toIsAdapt = toId.startsWith(ADAPT);
    if (!fromIsAdapt && !toIsAdapt) continue;
    if (earthRingSet.has(fromId) && toIsAdapt) earthRingEntryForAdapted.set(toId, fromId);
    else if (earthRingSet.has(toId) && fromIsAdapt) earthRingEntryForAdapted.set(fromId, toId);
    else if (marsRingSet.has(fromId) && toIsAdapt) marsRingExitForAdapted.set(toId, fromId);
    else if (marsRingSet.has(toId) && fromIsAdapt) marsRingExitForAdapted.set(fromId, toId);
  }

  // --- Step 2: Index segments by their "to" endpoint. Segment i has
  //     from=chain[importantIdx[i]] and to=chain[importantIdx[i+1]].
  //     Walking natural direction from chain[0] to an entry sat: collect
  //     segments [0..byTo.get(entrySat)]. Walking in the opposite chain
  //     direction (tip inward to entry sat): collect segments
  //     [byTo.get(entrySat)+1..last] used in reverse.
  const buildSegmentIndex = (segments) => {
    const byTo = new Map();
    for (let i = 0; i < segments.length; i++) byTo.set(segments[i].to, i);
    return byTo;
  };

  const earthSegsPos = earthCollapsed?.positive || [];
  const earthSegsNeg = earthCollapsed?.negative || [];
  const marsSegsPos = marsCollapsed?.positive || [];
  const marsSegsNeg = marsCollapsed?.negative || [];
  const earthSegsPosByTo = buildSegmentIndex(earthSegsPos);
  const earthSegsNegByTo = buildSegmentIndex(earthSegsNeg);
  const marsSegsPosByTo = buildSegmentIndex(marsSegsPos);
  const marsSegsNegByTo = buildSegmentIndex(marsSegsNeg);

  // Which side of the ring does a given sat belong to?
  // Use chain membership rather than `segsByTo` so chain[0] (planet-entry sat)
  // still resolves correctly if ever used as an adapted-ring entry point.
  const earthSideOf = (satName) =>
    earthPosSet.has(satName) ? "positive" : earthNegSet.has(satName) ? "negative" : null;
  const marsSideOf = (satName) =>
    marsPosSet.has(satName) ? "positive" : marsNegSet.has(satName) ? "negative" : null;

  // --- Step 3: Find the planet→sat link for each side ---
  const planetSideLink = (planetName, planetLinks, chains) => {
    const sides = { positive: null, negative: null };
    for (const link of planetLinks) {
      const satName = link.fromId === planetName ? link.toId : link.fromId;
      if (chains.positive.length > 0 && chains.positive[0] === satName) sides.positive = link;
      else if (chains.negative.length > 0 && chains.negative[0] === satName) sides.negative = link;
    }
    return sides;
  };
  const earthSideLinks = planetSideLink("Earth", earthPlanetLinks, earthChains);
  const marsSideLinks = planetSideLink("Mars", marsPlanetLinks, marsChains);

  // --- Step 4: Locate the back-side bridge link closing each ring loop ---
  //
  // In both the odd-count (shared 180° sat) and even-count (two symmetric
  // back-side sats) cases, the bridge is a single in-ring link between
  // positive-chain[last] and negative-chain[last]. Returns true if the bridge
  // exists (so wrap-around paths are feasible), false otherwise.
  const hasBridge = (chains) => {
    const pos = chains.positive;
    const neg = chains.negative;
    if (!pos || !neg || pos.length === 0 || neg.length === 0) return false;
    const lastPos = pos[pos.length - 1];
    const lastNeg = neg[neg.length - 1];
    if (lastPos === lastNeg) return false; // shouldn't happen with current naming
    const link = linkByKey.get(`${lastPos}_${lastNeg}`) || linkByKey.get(`${lastNeg}_${lastPos}`);
    return !!link;
  };
  const earthHasBridge = hasBridge(earthChains);
  const marsHasBridge = hasBridge(marsChains);

  // --- Step 5: Helpers for building path items ---
  //
  // Each path is an ordered array of items; each item is either:
  //   { kind: "edge",    key, revKey, latency }
  //   { kind: "segment", segment, direction: "fwd"|"rev", latency }
  const makeEdge = (fromName, toName) => {
    const fromId = nodeIds.get(fromName);
    const toId = nodeIds.get(toName);
    if (fromId === undefined || toId === undefined) return null;
    const link = linkByKey.get(`${fromName}_${toName}`) || linkByKey.get(`${toName}_${fromName}`);
    if (!link) return null;
    return {
      kind: "edge",
      key: `${fromId}_${toId}`,
      revKey: `${toId}_${fromId}`,
      latency: link.latencySeconds,
    };
  };

  const makeSegItem = (segment, direction) => ({
    kind: "segment",
    segment,
    direction,
    latency: segment.latency,
  });

  const earthSegsOn = (side) => (side === "positive" ? earthSegsPos : earthSegsNeg);
  const earthSegsByToOn = (side) => (side === "positive" ? earthSegsPosByTo : earthSegsNegByTo);
  const marsSegsOn = (side) => (side === "positive" ? marsSegsPos : marsSegsNeg);
  const marsSegsByToOn = (side) => (side === "positive" ? marsSegsPosByTo : marsSegsNegByTo);

  /**
   * Build the earth-side portion of a path: Earth → planet link → walk to
   * earthEntrySat using the chosen eSide (natural or wrap-around).
   *
   * Direct (eSide === naturalESide):
   *   Earth → eSide.chain[0] → walk forward → earthEntrySat
   *
   * Wrap-around (eSide !== naturalESide):
   *   Earth → eSide.chain[0] → walk forward to eSide.chain[last] →
   *   bridge → naturalESide.chain[last] → walk reverse to earthEntrySat
   */
  const buildEarthSide = (earthEntrySat, naturalESide, eSide) => {
    const items = [];
    let latency = 0;
    const startChain = earthChains[eSide];
    if (!startChain || startChain.length === 0) return null;

    // Planet link (always the eSide planet link)
    const planetLink = makeEdge("Earth", startChain[0]);
    if (!planetLink) return null;
    items.push(planetLink);
    latency += planetLink.latency;

    if (eSide === naturalESide) {
      // Direct walk: forward segments from chain[0] to earthEntrySat
      if (earthEntrySat !== startChain[0]) {
        const segs = earthSegsOn(eSide);
        const byTo = earthSegsByToOn(eSide);
        const targetIdx = byTo.get(earthEntrySat);
        if (targetIdx === undefined) return null;
        for (let i = 0; i <= targetIdx; i++) {
          items.push(makeSegItem(segs[i], "fwd"));
          latency += segs[i].latency;
        }
      }
      return { items, latency };
    }

    // Wrap-around
    if (!earthHasBridge) return null;

    // 1. Walk eSide (opposite) chain FORWARD from chain[0] to chain[last]
    const oppSegs = earthSegsOn(eSide);
    for (let i = 0; i < oppSegs.length; i++) {
      items.push(makeSegItem(oppSegs[i], "fwd"));
      latency += oppSegs[i].latency;
    }

    // 2. Bridge link: opposite chain[last] → natural chain[last]
    const natChain = earthChains[naturalESide];
    const oppLast = startChain[startChain.length - 1];
    const natLast = natChain[natChain.length - 1];
    const bridge = makeEdge(oppLast, natLast);
    if (!bridge) return null;
    items.push(bridge);
    latency += bridge.latency;

    // 3. Walk natural chain REVERSE from chain[last] to earthEntrySat.
    //    Natural segments used: [entryIdx+1 .. last] in reverse order,
    //    each with direction = "rev".
    const natSegs = earthSegsOn(naturalESide);
    const natByTo = earthSegsByToOn(naturalESide);
    let entryIdx;
    if (earthEntrySat === natChain[0]) {
      entryIdx = -1; // walk all segments
    } else {
      entryIdx = natByTo.get(earthEntrySat);
      if (entryIdx === undefined) return null;
    }
    for (let i = natSegs.length - 1; i > entryIdx; i--) {
      items.push(makeSegItem(natSegs[i], "rev"));
      latency += natSegs[i].latency;
    }

    return { items, latency };
  };

  /**
   * Build the mars-side portion of a path: walk from marsExitSat to Mars using
   * the chosen mSide. Mirror of buildEarthSide but traversed "backwards"
   * (from ring to planet instead of planet to ring).
   *
   * Direct (mSide === naturalMSide):
   *   marsExitSat → walk reverse → mSide.chain[0] → mars planet link → Mars
   *
   * Wrap-around (mSide !== naturalMSide):
   *   marsExitSat → walk forward → naturalMSide.chain[last] →
   *   bridge → mSide.chain[last] → walk reverse → mSide.chain[0] → Mars
   */
  const buildMarsSide = (marsExitSat, naturalMSide, mSide) => {
    const items = [];
    let latency = 0;

    if (mSide === naturalMSide) {
      const natChain = marsChains[mSide];
      if (!natChain || natChain.length === 0) return null;
      // Walk segments from exitSat back to chain[0] in reverse direction
      if (marsExitSat !== natChain[0]) {
        const segs = marsSegsOn(mSide);
        const byTo = marsSegsByToOn(mSide);
        const targetIdx = byTo.get(marsExitSat);
        if (targetIdx === undefined) return null;
        for (let i = targetIdx; i >= 0; i--) {
          items.push(makeSegItem(segs[i], "rev"));
          latency += segs[i].latency;
        }
      }
      // Mars planet link on this side
      const planetLink = makeEdge(natChain[0], "Mars");
      if (!planetLink) return null;
      items.push(planetLink);
      latency += planetLink.latency;
      return { items, latency };
    }

    // Wrap-around
    if (!marsHasBridge) return null;

    const natChain = marsChains[naturalMSide];
    const oppChain = marsChains[mSide];
    if (!natChain || natChain.length === 0 || !oppChain || oppChain.length === 0) return null;

    // 1. Walk natural chain FORWARD from marsExitSat to chain[last].
    //    Natural segments used: [startIdx+1 .. last] in fwd order.
    const natSegs = marsSegsOn(naturalMSide);
    const natByTo = marsSegsByToOn(naturalMSide);
    let startIdx;
    if (marsExitSat === natChain[0]) {
      startIdx = -1; // walk all segments (start at index 0)
    } else {
      startIdx = natByTo.get(marsExitSat);
      if (startIdx === undefined) return null;
    }
    for (let i = startIdx + 1; i < natSegs.length; i++) {
      items.push(makeSegItem(natSegs[i], "fwd"));
      latency += natSegs[i].latency;
    }

    // 2. Bridge link: natural chain[last] → opposite chain[last]
    const natLast = natChain[natChain.length - 1];
    const oppLast = oppChain[oppChain.length - 1];
    const bridge = makeEdge(natLast, oppLast);
    if (!bridge) return null;
    items.push(bridge);
    latency += bridge.latency;

    // 3. Walk opposite chain REVERSE from chain[last] to chain[0]
    const oppSegs = marsSegsOn(mSide);
    for (let i = oppSegs.length - 1; i >= 0; i--) {
      items.push(makeSegItem(oppSegs[i], "rev"));
      latency += oppSegs[i].latency;
    }

    // 4. Mars planet link on opposite side
    const planetLink = makeEdge(oppChain[0], "Mars");
    if (!planetLink) return null;
    items.push(planetLink);
    latency += planetLink.latency;
    return { items, latency };
  };

  // --- Step 6: Enumerate paths (up to 4 per route) ---
  const paths = [];

  for (const route of routes) {
    const earthEntrySat = earthRingEntryForAdapted.get(route.origin);
    const marsExitSat = marsRingExitForAdapted.get(route.destination);
    if (!earthEntrySat || !marsExitSat) continue;

    const naturalESide = earthSideOf(earthEntrySat);
    const naturalMSide = marsSideOf(marsExitSat);
    if (!naturalESide || !naturalMSide) continue;

    // The adapted-ring middle (entry link → route path → exit link) is the
    // same for all 4 side combinations; build it once and clone.
    const middleItems = [];
    let middleLatency = 0;
    let middleValid = true;

    const entryLink = makeEdge(earthEntrySat, route.origin);
    if (!entryLink) continue;
    middleItems.push(entryLink);
    middleLatency += entryLink.latency;

    for (let i = 0; i < route.path.length - 1; i++) {
      const e = makeEdge(route.path[i], route.path[i + 1]);
      if (!e) { middleValid = false; break; }
      middleItems.push(e);
      middleLatency += e.latency;
    }
    if (!middleValid) continue;

    const exitLink = makeEdge(route.destination, marsExitSat);
    if (!exitLink) continue;
    middleItems.push(exitLink);
    middleLatency += exitLink.latency;

    for (const eSide of ["positive", "negative"]) {
      const earth = buildEarthSide(earthEntrySat, naturalESide, eSide);
      if (!earth) continue;
      for (const mSide of ["positive", "negative"]) {
        const mars = buildMarsSide(marsExitSat, naturalMSide, mSide);
        if (!mars) continue;
        const items = earth.items.concat(middleItems, mars.items);
        const latency = earth.latency + middleLatency + mars.latency;
        paths.push({ items, latency });
      }
    }
  }

  // --- Step 7: Sort paths by latency ascending ---
  paths.sort((a, b) => a.latency - b.latency);

  // --- Step 8: Greedy push ---
  //
  // Signed residuals:
  //   - Regular edges: flows[u_v] antisymmetric with flows[v_u].
  //     Residual fwd = capacities[u_v] - flows[u_v].
  //   - Segments: segmentFlows[virtualKey] is SIGNED netFlow.
  //     Residual fwd = cap - netFlow. Residual rev = cap + netFlow.
  const flows = {};
  const segmentFlows = new Map();
  let maxFlow = 0;
  let opsSinceTimeoutCheck = 0;

  for (const path of paths) {
    // Find min residual along the path
    let available = Infinity;
    for (const item of path.items) {
      let residual;
      if (item.kind === "edge") {
        const cap = capacities[item.key] || 0;
        const used = flows[item.key] || 0;
        residual = cap - used;
      } else {
        const cap = item.segment.capacity;
        const netFlow = segmentFlows.get(item.segment.virtualKey) || 0;
        residual = item.direction === "fwd" ? cap - netFlow : cap + netFlow;
      }
      if (residual < available) available = residual;
      if (available <= EPS) break;
    }
    if (available <= EPS) continue;

    // Push `available` along the path
    for (const item of path.items) {
      if (item.kind === "edge") {
        flows[item.key] = (flows[item.key] || 0) + available;
        flows[item.revKey] = (flows[item.revKey] || 0) - available;
      } else {
        const k = item.segment.virtualKey;
        const sign = item.direction === "fwd" ? 1 : -1;
        segmentFlows.set(k, (segmentFlows.get(k) || 0) + sign * available);
      }
    }
    maxFlow += available;

    if (++opsSinceTimeoutCheck >= 64) {
      if (performance.now() - perfStart > calctimeMs) return null;
      opsSinceTimeoutCheck = 0;
    }
  }

  // --- Step 9: Propagate segment netFlow to physical edges ---
  //
  // For each segment with nonzero netFlow, write the magnitude onto every
  // physical intra-ring edge in the appropriate direction:
  //   netFlow > 0 → chain order    (pe.from → pe.to)
  //   netFlow < 0 → reverse order  (pe.to → pe.from)
  // Antisymmetry: flows[fwd] = +|f|, flows[rev] = -|f|.
  const segByKey = new Map();
  for (const segs of [earthSegsPos, earthSegsNeg, marsSegsPos, marsSegsNeg]) {
    for (const s of segs) segByKey.set(s.virtualKey, s);
  }

  for (const [virtualKey, netFlow] of segmentFlows) {
    if (Math.abs(netFlow) <= EPS) continue;
    const segment = segByKey.get(virtualKey);
    if (!segment) continue;
    const reverseDirection = netFlow < 0;
    const magnitude = Math.abs(netFlow);
    for (const pe of segment.physicalEdges) {
      const fromName = reverseDirection ? pe.to : pe.from;
      const toName = reverseDirection ? pe.from : pe.to;
      const fromId = nodeIds.get(fromName);
      const toId = nodeIds.get(toName);
      if (fromId === undefined || toId === undefined) continue;
      const fwdKey = `${fromId}_${toId}`;
      const revKey = `${toId}_${fromId}`;
      flows[fwdKey] = (flows[fwdKey] || 0) + magnitude;
      flows[revKey] = (flows[revKey] || 0) - magnitude;
    }
  }

  return { maxFlow, flows };
}
