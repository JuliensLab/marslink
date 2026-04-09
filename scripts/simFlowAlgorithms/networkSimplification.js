// networkSimplification.js — Algorithm-agnostic graph preprocessing.
// Merges degree-2 nodes before running max-flow, then reverses the merge
// to map flows back to physical edges. Used by all max-flow algorithms.

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
