// simMaxFlow.js — Pure graph algorithm functions extracted from SimNetwork.

import { SIM_CONSTANTS } from "./simConstants.js";

/**
 * Simplifies the network by merging series nodes and records the history.
 * @param {Object} graph - Adjacency list of the graph.
 * @param {Object} capacities - Edge capacities.
 * @param {Object} latencies - Edge latencies.
 * @param {number} source - Source node ID.
 * @param {number} sink - Sink node ID.
 * @param {Array} simplificationStack - Array to store merge history.
 */
export function simplifyNetwork(graph, capacities, latencies, source, sink, simplificationStack) {
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
      }
    }
  }
}

/**
 * Restores the graph topology and maps flows from virtual edges back to physical edges.
 * @param {Object} graph - Adjacency list of the graph.
 * @param {Object} flows - Flow per edge.
 * @param {Array} simplificationStack - Array of merge history (processed LIFO).
 */
export function desimplifyNetwork(graph, flows, simplificationStack) {
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
 * @param {number} perfStart - Performance timestamp for timeout checking.
 * @param {number} calctimeMs - Maximum allowed computation time in ms.
 * @returns {Object|null} - { maxFlow, flows } or null if timed out.
 */
export function edmondsKarp(graph, capacities, source, sink, perfStart, calctimeMs) {
  const flows = {}; // Edge flows
  let maxFlow = 0;

  while (true) {
    if (performance.now() - perfStart > calctimeMs) return null;
    // Breadth-First Search (BFS) to find the shortest augmenting path
    const queue = [source];
    let qHead = 0; // Index-based dequeue — O(1) instead of shift()'s O(n)
    const parents = {};
    parents[source] = null;

    while (qHead < queue.length) {
      const current = queue[qHead++];

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
