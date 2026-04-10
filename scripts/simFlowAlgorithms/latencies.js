// latencies.js — Algorithm-agnostic flow decomposition and latency analysis.
// Walks the flows dict to find source→sink paths with positive flow,
// tracks their latency, and produces a histogram. Runs after any max-flow algorithm.

import { SIM_CONSTANTS } from "../simConstants.js";

/**
 * Calculates latencies for the network flows and aggregates the gbps per latency bin.
 *
 * @param {Object} networkData - The object returned by getNetworkData containing graph, flows, etc.
 * @param {Number} binSize - The size of each latency bin in seconds.
 * @returns {Object|null} - An object containing the latency histogram, best latency, and average latency.
 */
export function calculateLatencies(networkData, binSize = 60 * 5) {
  const { graph, flows, nodeIds } = networkData;
  if (nodeIds === undefined) return null;

  const source = nodeIds.get("Earth");
  const sink = nodeIds.get("Mars");

  // --- Pre-build link latency lookup keyed by numeric edge IDs (not names) ---
  // The original used `${fromName}_${toName}` which forced an inverseNodeIds
  // lookup per edge probe. Numeric keys avoid that and match the same
  // representation already used by `flows`.
  const linkLatencyMap = new Map();
  for (const link of networkData.links) {
    const fromId = nodeIds.get(link.fromId);
    const toId = nodeIds.get(link.toId);
    if (fromId === undefined || toId === undefined) continue;
    linkLatencyMap.set(`${fromId}_${toId}`, link.latencySeconds);
    linkLatencyMap.set(`${toId}_${fromId}`, link.latencySeconds);
  }

  // --- Compute V (max node ID + 1) for typed-array sizing ---
  // Node IDs are dense (assigned sequentially in getNetworkData), so a flat
  // typed array indexed by ID is the cheapest "visited" structure.
  let V = 0;
  for (const k in graph) {
    const id = +k;
    if (id + 1 > V) V = id + 1;
  }

  // --- Build a positive-flow adjacency list ONCE ---
  // Each BFS used to do `flows[`${u}_${v}`] > 0` for every neighbor of every
  // visited node — that's a string concat + dict lookup per probe, dominating
  // the runtime on 25k-sat configs. Pre-walking the flows dict gives us a
  // sparse adjacency list of just the positive-flow edges, then BFS only
  // touches edges that actually carry flow.
  //
  // Layout: for node u, posAdjStart[u] .. posAdjStart[u+1] are indices into
  //   posAdjTo (neighbor) and posAdjFlow (current flow on that edge).
  //   posAdjFlow is mutable so the augment loop can subtract from it.
  const posDegree = new Int32Array(V);
  let totalPositive = 0;
  for (const key in flows) {
    const f = flows[key];
    if (f > 0) {
      const us = key.indexOf("_");
      const u = +key.slice(0, us);
      posDegree[u]++;
      totalPositive++;
    }
  }
  const posAdjStart = new Int32Array(V + 1);
  for (let i = 0; i < V; i++) posAdjStart[i + 1] = posAdjStart[i] + posDegree[i];
  const posAdjTo = new Int32Array(totalPositive);
  const posAdjFlow = new Float64Array(totalPositive);
  // Reuse posDegree as the per-node write cursor
  posDegree.fill(0);
  for (const key in flows) {
    const f = flows[key];
    if (f > 0) {
      const us = key.indexOf("_");
      const u = +key.slice(0, us);
      const v = +key.slice(us + 1);
      const idx = posAdjStart[u] + posDegree[u]++;
      posAdjTo[idx] = v;
      posAdjFlow[idx] = f;
    }
  }
  // Per-node BFS state, allocated once and reset between iterations.
  // parent[u] = -1 means unvisited; parentEdgeIdx[u] is the index in
  // posAdjTo/posAdjFlow used to reach u, so we can reconstruct path edges
  // without an extra lookup.
  const parent = new Int32Array(V);
  const parentEdgeIdx = new Int32Array(V);
  const queue = new Int32Array(V);

  // --- Initialize variables for statistics ---
  const paths = [];
  let totalFlowLatencyProduct = 0;
  let totalFlow = 0;
  let minLatency = Infinity;
  let maxLatency = -Infinity;
  const EPS = 1e-12;

  /**
   * BFS source → sink in the positive-flow subgraph. Returns null if no
   * augmenting path exists. On success, parent[]/parentEdgeIdx[] describe
   * the path back from sink.
   */
  const findPathWithFlow = () => {
    parent.fill(-1);
    parent[source] = source; // sentinel — distinct from -1, won't be revisited
    queue[0] = source;
    let qHead = 0, qTail = 1;
    while (qHead < qTail) {
      const u = queue[qHead++];
      const start = posAdjStart[u];
      const end = posAdjStart[u + 1];
      for (let i = start; i < end; i++) {
        if (posAdjFlow[i] <= EPS) continue;
        const v = posAdjTo[i];
        if (parent[v] !== -1) continue;
        parent[v] = u;
        parentEdgeIdx[v] = i;
        if (v === sink) return true; // early termination
        queue[qTail++] = v;
      }
    }
    return parent[sink] !== -1;
  };

  // --- Augment along source→sink paths until none remain ---
  while (findPathWithFlow()) {
    // First pass: walk the path back to find min flow.
    let minFlow = Infinity;
    let cur = sink;
    while (cur !== source) {
      const idx = parentEdgeIdx[cur];
      if (posAdjFlow[idx] < minFlow) minFlow = posAdjFlow[idx];
      cur = parent[cur];
    }
    if (minFlow <= EPS) break;

    // Second pass: subtract from posAdjFlow, accumulate latency, build path.
    let totalLatency = 0;
    const pathEdges = [];
    cur = sink;
    while (cur !== source) {
      const idx = parentEdgeIdx[cur];
      const u = parent[cur];
      const v = cur;
      posAdjFlow[idx] -= minFlow;
      const lat = linkLatencyMap.get(`${u}_${v}`);
      if (lat !== undefined) totalLatency += lat;
      pathEdges.push({ from: u, to: v });
      cur = u;
    }
    pathEdges.reverse();

    // --- Statistics ---
    totalFlowLatencyProduct += minFlow * totalLatency;
    totalFlow += minFlow;
    if (totalLatency < minLatency) minLatency = totalLatency;
    if (totalLatency > maxLatency) maxLatency = totalLatency;

    paths.push({ path: pathEdges, flow: minFlow, latency: totalLatency });
  }

  // --- Aggregate flows into latency bins ---
  const latencyBins = {};
  paths.forEach(({ flow, latency }) => {
    const bin = Math.floor(latency / binSize) * binSize;
    latencyBins[bin] = (latencyBins[bin] || 0) + flow;
  });

  const sortedBins = Object.keys(latencyBins)
    .map(Number)
    .sort((a, b) => a - b)
    .map((bin) => ({
      latency: bin, // in seconds
      totalGbps: Math.round(latencyBins[bin] * 1e6) / 1e6,
    }));

  const averageLatency = totalFlow > 0 ? totalFlowLatencyProduct / totalFlow : 0;

  return {
    histogram: sortedBins,
    bestLatency: minLatency,
    averageLatency: averageLatency,
    maxLatency: maxLatency === -Infinity ? null : maxLatency,
  };
}
