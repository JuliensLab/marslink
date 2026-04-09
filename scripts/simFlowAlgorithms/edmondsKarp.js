// edmondsKarp.js — Classic BFS augmenting-path max-flow algorithm.
// O(VE²) complexity. Simple and correct; slower than push-relabel on large graphs.
// Implements the MaxFlow algorithm interface defined in interface.js.

/**
 * Edmonds-Karp algorithm to find the maximum flow in a flow network.
 *
 * @param {import("./interface.js").MaxFlowInput} input
 * @returns {import("./interface.js").MaxFlowResult | null}
 */
export function edmondsKarp({ graph, capacities, source, sink, perfStart, calctimeMs }) {
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
