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
  const SPEED_OF_LIGHT_KM_S = SIM_CONSTANTS.SPEED_OF_LIGHT_KM_S;
  const { graph, flows, nodeIds, capacities } = networkData;
  const inverseNodeIds = new Map();
  if (nodeIds === undefined) return null;
  nodeIds.forEach((id, name) => inverseNodeIds.set(id, name));

  // Pre-build link lookup Map for O(1) edge->latency instead of .find()
  const linkLatencyMap = new Map();
  for (const link of networkData.links) {
    linkLatencyMap.set(`${link.fromId}_${link.toId}`, link.latencySeconds);
    linkLatencyMap.set(`${link.toId}_${link.fromId}`, link.latencySeconds);
  }

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
    const queue = [source];
    let qHead = 0;
    while (qHead < queue.length) {
      const current = queue[qHead++];
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

    // Calculate total latency for the path — O(1) Map lookup per edge
    let totalLatency = 0;
    for (const edge of path) {
      const fromName = inverseNodeIds.get(edge.from);
      const toName = inverseNodeIds.get(edge.to);
      const latency = linkLatencyMap.get(`${fromName}_${toName}`);
      if (latency !== undefined) {
        totalLatency += latency;
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
