// simMaxFlow.js — Thin orchestrator for pluggable max-flow algorithms.
//
// This file re-exports the algorithm-agnostic utilities (simplification,
// latency decomposition) and provides a single computeMaxFlow() entry point
// that dispatches to whichever algorithm is registered in
// ./simFlowAlgorithms/interface.js.
//
// All the actual algorithm implementations live in ./simFlowAlgorithms/.
// Swap algorithms by changing DEFAULT_ALGORITHM in interface.js or by
// passing { algorithm: "push-relabel" | "edmonds-karp" } to computeMaxFlow().

import { simplifyNetwork, desimplifyNetwork } from "./simFlowAlgorithms/networkSimplification.js?v=5.33";
import { calculateLatencies } from "./simFlowAlgorithms/latencies.js?v=5.33";
import { FLOW_ALGORITHMS, DEFAULT_ALGORITHM } from "./simFlowAlgorithms/interface.js?v=5.33";
import { edmondsKarp } from "./simFlowAlgorithms/edmondsKarp.js?v=5.33";
import { pushRelabel } from "./simFlowAlgorithms/pushRelabel.js?v=5.33";
import { topologyAware } from "./simFlowAlgorithms/topologyAware.js?v=5.33";

// Re-exports for existing callers
export { simplifyNetwork, desimplifyNetwork, calculateLatencies };
export { edmondsKarp, pushRelabel, topologyAware };

/**
 * Route-level flow accounting: how many of the capacity step's routes actually
 * carry flow, and how loaded each is relative to its quoted per-route capacity.
 * In a balanced system (the relay network is the bottleneck) both should read
 * 100%; deviations localize problems — unused routes mean starvation upstream
 * of the relay (junctions, planet rings), utilization above 100% means max-flow
 * found lattice paths the route walker didn't quote.
 *
 * Flow is link-level while capacity is quoted per route, so each route's
 * carried flow is read as the MEDIAN flow over its RELAY hops only — hops
 * whose BOTH endpoints are relay-ring satellites. Junction crossings,
 * planetary-ring chain hops, and intermediate junction rings (ring_jct) are
 * excluded: a route's path crosses the junction as a single representative
 * link whose individual capacity is tiny (the quote counts the junction as a
 * BUNDLE), and the planet chains belong to the distribution stage, not the
 * relay route. Median, not the bottleneck hop, because lattice links can
 * add/remove flow mid-chain on concentric routes. A route counts as "used"
 * when that median exceeds max(0.5 Mbps, 1% of the route's capacity).
 *
 * @param {Array<{path: string[], throughputMbps: number}>} routes  routeSummary.routes
 * @param {Array<{fromId, toId, gbpsCapacity, gbpsFlow}>}   links   solved link set
 * @returns {{routeCount, routesUsed, usedPct, utilizationPct, minUtilPct, avgUtilPct, maxUtilPct}|null}
 */
export function routeFlowUtilization(routes, links) {
  if (!Array.isArray(routes) || !routes.length || !Array.isArray(links) || !links.length) return null;
  const flowByPair = new Map();
  for (const l of links) {
    const f = (l.gbpsFlow || 0) * 1000;
    flowByPair.set(l.fromId + "|" + l.toId, f);
    flowByPair.set(l.toId + "|" + l.fromId, f);
  }
  const isRelayNode = (id) => id && id.startsWith("ring_") &&
    !id.startsWith("ring_earth") && !id.startsWith("ring_mars") && !id.startsWith("ring_jct");
  let used = 0, flowSum = 0, capSum = 0;
  const utils = [];
  for (const r of routes) {
    const cap = r.throughputMbps;
    if (!(cap > 0) || !Array.isArray(r.path) || r.path.length < 2) continue;
    const hopFlows = [];
    const allFlows = [];
    for (let i = 0; i < r.path.length - 1; i++) {
      const a = r.path[i], b = r.path[i + 1];
      const f = flowByPair.get(a + "|" + b);
      if (f == null) continue; // hop without a formed link — skip, don't zero the route
      allFlows.push(f);
      if (isRelayNode(a) && isRelayNode(b)) hopFlows.push(f);
    }
    // Fall back to the full hop set only if the path had no relay-relay hops
    // at all (degenerate single-hop routes).
    const flows = hopFlows.length ? hopFlows : allFlows;
    if (!flows.length) continue;
    flows.sort((a, b) => a - b);
    const mid = flows.length >> 1;
    const carried = flows.length % 2 ? flows[mid] : (flows[mid - 1] + flows[mid]) / 2;
    utils.push(carried / cap);
    if (carried > Math.max(0.5, 0.01 * cap)) used++;
    flowSum += carried;
    capSum += cap;
  }
  if (!utils.length) return null;
  utils.sort((a, b) => a - b);
  const pct = (x) => Math.round(x * 1000) / 10;
  return {
    routeCount: utils.length,
    routesUsed: used,
    usedPct: pct(used / utils.length),
    utilizationPct: pct(capSum > 0 ? flowSum / capSum : 0),
    minUtilPct: pct(utils[0]),
    avgUtilPct: pct(utils.reduce((s, v) => s + v, 0) / utils.length),
    maxUtilPct: pct(utils[utils.length - 1]),
  };
}

/**
 * Flow-card aggregates from a solved link set: per-planet ground flows, junction
 * flow bundles per side, and the route accounting above. Shared by the worker
 * scenario path and the live capture so every archived flow result — sweep,
 * paper plan, or live sim — records the same shape.
 */
export function buildFlowSummary(links, maxFlowGbps, routes) {
  if (!Array.isArray(links)) return null;
  const isRelay = (id) => id && id.startsWith("ring_") && !id.startsWith("ring_earth") && !id.startsWith("ring_mars");
  const ground = (planet) => {
    const flows = links.filter((l) => l.fromId === planet || l.toId === planet)
      .map((l) => (l.gbpsFlow || 0) * 1000).sort((a, b) => b - a);
    return { side1: Math.round(flows[0] || 0), side2: Math.round(flows[1] || 0), links: flows.length };
  };
  const jct = (prefix) => {
    let sum = 0, n = 0, min = Infinity, max = 0;
    for (const l of links) {
      const isJ = (l.fromId.startsWith(prefix) && isRelay(l.toId)) || (l.toId.startsWith(prefix) && isRelay(l.fromId));
      if (!isJ) continue;
      const f = (l.gbpsFlow || 0) * 1000;
      if (f <= 0) continue;
      sum += f; n++;
      if (f < min) min = f;
      if (f > max) max = f;
    }
    return { sumMbps: Math.round(sum), links: n, min: n ? Math.round(min) : 0,
             avg: n ? Math.round(sum / n) : 0, max: Math.round(max) };
  };
  return {
    maxFlowGbps,
    earthGround: ground("Earth"), marsGround: ground("Mars"),
    earthJunction: jct("ring_earth"), marsJunction: jct("ring_mars"),
    routeUse: routeFlowUtilization(routes, links),
  };
}

/**
 * Compute max flow using the specified algorithm (or default).
 *
 * @param {Object} input
 * @param {Object<number, number[]>} input.graph
 * @param {Object<string, number>}   input.capacities
 * @param {number}                   input.source
 * @param {number}                   input.sink
 * @param {number}                   input.perfStart
 * @param {number}                   input.calctimeMs
 * @param {string}                   [input.algorithm]  - Key in FLOW_ALGORITHMS. Defaults to DEFAULT_ALGORITHM.
 * @param {Object}                   [input.topology]   - Structured topology info (used by concentric-topology-aware).
 * @param {Map<string,number>}       [input.nodeIds]    - name → node ID map (for concentric-topology-aware).
 * @returns {{ maxFlow: number, flows: Object<string, number> } | null}
 */
export function computeMaxFlow({ graph, capacities, source, sink, perfStart, calctimeMs, algorithm, topology, nodeIds }) {
  const name = algorithm || DEFAULT_ALGORITHM;
  const algo = FLOW_ALGORITHMS[name];
  if (!algo) throw new Error(`Unknown max-flow algorithm: ${name}`);
  return algo({ graph, capacities, source, sink, perfStart, calctimeMs, topology, nodeIds });
}
