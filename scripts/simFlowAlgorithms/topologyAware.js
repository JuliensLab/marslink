// topologyAware.js — Specialized max-flow for the Marslink constellation topology.
//
// Unlike generic algorithms (Edmonds-Karp, Push-Relabel), this one exploits
// the known structure:
//
//   1. Earth and Mars rings are TWO LINEAR CHAINS (not loops) branching from
//      each planet, one per angular side. Naming convention:
//        ring_earth-N   = positive-side chain (planet -> -0 -> -1 -> ... -> -K)
//        ring_earth--N  = negative-side chain
//
//   2. Each planet connects to exactly 2 ring satellites (one per side).
//
//   3. Adapted-ring routes are already collapsed: each route has a known
//      origin (earth-ring sat), destination (mars-ring sat), aggregated
//      throughputMbps, and latencySeconds.
//
// OPTIMIZATION: Ring chain segments between "important" sats (planet
// connection points and adapted-ring exit points) are collapsed into
// virtual edges. This avoids iterating thousands of intra-ring edges per
// route, since most of the chain is pure degree-2 walk.
//
// Path structure after collapsing:
//
//   Earth -> planetLink -> [segment 0] -> [segment 1] -> ... -> earthEntrySat
//         -> [collapsed adapted route edges] ->
//         marsExitSat -> [segment] -> ... -> planetLink -> Mars
//
// Algorithm: enumerate paths, sort by latency, greedy push.

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

  const earthRingSet = new Set([...earthChains.positive, ...earthChains.negative]);
  const marsRingSet = new Set([...marsChains.positive, ...marsChains.negative]);

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

  // --- Step 2: Index segments by their "important" endpoints.
  // For each collapsed chain, build a map from sat name to segment index.
  // Segments are ordered from chain[0] outward; a segment connects an
  // "important" sat at index `s` to the next "important" sat at index `s+1`.
  //
  // To walk from chain[0] (planet entry) to an earth entry sat:
  //   find the segment index where `to === earthEntrySat`, then collect
  //   segments [0..that index] (inclusive).
  const buildSegmentIndex = (segments) => {
    const byTo = new Map(); // "to" sat name -> segment index
    for (let i = 0; i < segments.length; i++) {
      byTo.set(segments[i].to, i);
    }
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

  // Which side of the earth ring does a given sat belong to?
  const earthSideOf = (satName) => {
    if (earthSegsPosByTo.has(satName)) return "positive";
    if (earthSegsNegByTo.has(satName)) return "negative";
    return null;
  };
  const marsSideOf = (satName) => {
    if (marsSegsPosByTo.has(satName)) return "positive";
    if (marsSegsNegByTo.has(satName)) return "negative";
    return null;
  };

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

  // --- Step 4: Build a directed path for each route ---
  //
  // Internal path representation: an array of "items". Each item is either
  //   { kind: "edge", key, revKey }
  //   { kind: "segment", segment }  (uses segment.virtualKey for residual tracking)
  //
  // Residual for an edge uses capacities[key] - flows[key] (standard).
  // Residual for a segment uses segment.capacity - segmentFlows[virtualKey].
  const paths = [];

  const makeEdge = (fromName, toName) => {
    const fromId = nodeIds.get(fromName);
    const toId = nodeIds.get(toName);
    if (fromId === undefined || toId === undefined) return null;
    const link = linkByKey.get(`${fromName}_${toName}`);
    if (!link) return null;
    return {
      kind: "edge",
      key: `${fromId}_${toId}`,
      revKey: `${toId}_${fromId}`,
      latency: link.latencySeconds,
    };
  };

  const makeSegment = (segment) => ({
    kind: "segment",
    segment,
    latency: segment.latency,
  });

  for (const route of routes) {
    const earthEntrySat = earthRingEntryForAdapted.get(route.origin);
    const marsExitSat = marsRingExitForAdapted.get(route.destination);
    if (!earthEntrySat || !marsExitSat) continue;

    const eSide = earthSideOf(earthEntrySat);
    const mSide = marsSideOf(marsExitSat);
    if (!eSide || !mSide) continue;

    const earthChain = earthChains[eSide];
    const marsChain = marsChains[mSide];
    const earthPlanetLink = earthSideLinks[eSide];
    const marsPlanetLink = marsSideLinks[mSide];
    if (!earthPlanetLink || !marsPlanetLink) continue;

    const earthSegs = eSide === "positive" ? earthSegsPos : earthSegsNeg;
    const marsSegs = mSide === "positive" ? marsSegsPos : marsSegsNeg;
    const earthSegByTo = eSide === "positive" ? earthSegsPosByTo : earthSegsNegByTo;
    const marsSegByTo = mSide === "positive" ? marsSegsPosByTo : marsSegsNegByTo;

    const items = [];
    let totalLatency = 0;
    let valid = true;

    // 1. Earth planet link: Earth → earthChain[0]
    const e0 = makeEdge("Earth", earthChain[0]);
    if (!e0) continue;
    items.push(e0);
    totalLatency += e0.latency;

    // 2. Walk segments from earth chain[0] to earthEntrySat (inclusive).
    //    The segment with `to === earthEntrySat` ends at the entry sat.
    //    Segment with `to === chain[0]` only exists if chain[0] is important
    //    AND had a preceding segment (usually not the case — chain[0] is the
    //    first important sat and segment[0].from === chain[0]).
    //
    //    Special case: earthEntrySat might equal chain[0] (first important
    //    sat IS the route entry). In that case, no segments to walk.
    if (earthEntrySat !== earthChain[0]) {
      const targetIdx = earthSegByTo.get(earthEntrySat);
      if (targetIdx === undefined) { valid = false; }
      else {
        for (let i = 0; i <= targetIdx; i++) {
          const seg = earthSegs[i];
          items.push(makeSegment(seg));
          totalLatency += seg.latency;
        }
      }
    }
    if (!valid) continue;

    // 3. Ring-to-adapted entry link: earthEntrySat → route.origin
    const entryLink = makeEdge(earthEntrySat, route.origin);
    if (!entryLink) continue;
    items.push(entryLink);
    totalLatency += entryLink.latency;

    // 4. Walk the adapted-ring route.path
    for (let i = 0; i < route.path.length - 1; i++) {
      const e = makeEdge(route.path[i], route.path[i + 1]);
      if (!e) { valid = false; break; }
      items.push(e);
      totalLatency += e.latency;
    }
    if (!valid) continue;

    // 5. Adapted-to-ring exit link: route.destination → marsExitSat
    const exitLink = makeEdge(route.destination, marsExitSat);
    if (!exitLink) continue;
    items.push(exitLink);
    totalLatency += exitLink.latency;

    // 6. Walk mars segments from marsExitSat back to marsChain[0].
    //    Same trick: find segment whose `to === marsExitSat`, then walk
    //    segments [targetIdx..0] in reverse order.
    if (marsExitSat !== marsChain[0]) {
      const targetIdx = marsSegByTo.get(marsExitSat);
      if (targetIdx === undefined) { valid = false; }
      else {
        for (let i = targetIdx; i >= 0; i--) {
          const seg = marsSegs[i];
          items.push(makeSegment(seg));
          totalLatency += seg.latency;
        }
      }
    }
    if (!valid) continue;

    // 7. Mars planet link: marsChain[0] → Mars
    const mLast = makeEdge(marsChain[0], "Mars");
    if (!mLast) continue;
    items.push(mLast);
    totalLatency += mLast.latency;

    paths.push({ items, latency: totalLatency });
  }

  // --- Step 5: Sort paths by latency ascending ---
  paths.sort((a, b) => a.latency - b.latency);

  // --- Step 6: Greedy push ---
  //
  // Two separate residual stores:
  //   flows[key]                     — physical edge flows (output)
  //   segmentFlows[segment.virtualKey] — collapsed segment flow (internal)
  //
  // After the algorithm finishes, segment flows are propagated into the
  // physical-edge flows dict so downstream code sees correct per-link flows.
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
        const used = segmentFlows.get(item.segment.virtualKey) || 0;
        residual = cap - used;
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
        segmentFlows.set(k, (segmentFlows.get(k) || 0) + available);
      }
    }
    maxFlow += available;

    if (++opsSinceTimeoutCheck >= 64) {
      if (performance.now() - perfStart > calctimeMs) return null;
      opsSinceTimeoutCheck = 0;
    }
  }

  // --- Step 7: Propagate segment flows to physical edges ---
  //
  // For each collapsed segment with non-zero flow, write that flow to every
  // physical intra-ring edge inside the segment so downstream code
  // (calculateLatencies, getNetworkData output) sees the expected per-link
  // flow values.
  //
  // Antisymmetry: flows[u_v] = +f, flows[v_u] = -f.
  for (const [virtualKey, flow] of segmentFlows) {
    if (flow === 0) continue;
    // Find the segment. We need to look it up — collect all segments into
    // a single map for O(1) access, or scan all four arrays. Scan is fine
    // because total segment count is small compared to paths.
    let segment = null;
    for (const segs of [earthSegsPos, earthSegsNeg, marsSegsPos, marsSegsNeg]) {
      for (const s of segs) {
        if (s.virtualKey === virtualKey) { segment = s; break; }
      }
      if (segment) break;
    }
    if (!segment) continue;

    for (const pe of segment.physicalEdges) {
      const fromId = nodeIds.get(pe.from);
      const toId = nodeIds.get(pe.to);
      if (fromId === undefined || toId === undefined) continue;
      const fwdKey = `${fromId}_${toId}`;
      const revKey = `${toId}_${fromId}`;
      flows[fwdKey] = (flows[fwdKey] || 0) + flow;
      flows[revKey] = (flows[revKey] || 0) - flow;
    }
  }

  return { maxFlow, flows };
}
