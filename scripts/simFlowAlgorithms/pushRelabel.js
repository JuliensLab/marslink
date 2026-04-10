// pushRelabel.js — FIFO Push-Relabel max-flow with gap heuristic and global relabeling.
// Implements the MaxFlow algorithm interface defined in interface.js.
//
// Complexity: O(V²·E) worst case. With global relabel + gap heuristic it is
// empirically sublinear in V on the sparse graphs produced by the Marslink
// topology builder, typically 3-10x faster than Edmonds-Karp for large configs.
//
// IMPORTANT — antisymmetric flow invariant:
// The downstream pipeline (calculateLatencies, desimplifyNetwork, getNetworkData)
// relies on flows["u_v"] = -flows["v_u"] at all times. All flow updates go
// through the central `push()` helper to preserve this. Residual capacity is
// computed as capacities["u_v"] - flows["u_v"], which can range from 0 to 2C
// because capacities are stored in both directions. This matches the
// Edmonds-Karp implementation and keeps output format byte-compatible.

const EPS = 1e-12;

/**
 * @param {import("./interface.js").MaxFlowInput} input
 * @returns {import("./interface.js").MaxFlowResult | null}
 */
export function pushRelabel({ graph, capacities, source, sink, perfStart, calctimeMs }) {
  // --- Live node ID discovery ---
  // After simplifyNetwork, graph keys are sparse. Use max ID for typed-array
  // sizing so deleted IDs are implicitly skipped (they're not in any graph[u]).
  const liveNodeKeys = Object.keys(graph);
  const N = liveNodeKeys.length;
  if (N === 0) return { maxFlow: 0, flows: {} };

  let V = 0;
  const liveNodes = new Array(N);
  for (let i = 0; i < N; i++) {
    const id = +liveNodeKeys[i];
    liveNodes[i] = id;
    if (id + 1 > V) V = id + 1;
  }

  // --- Per-node state ---
  const height = new Int32Array(V);
  const excess = new Float64Array(V);
  const inQueue = new Uint8Array(V);
  const heightCount = new Int32Array(2 * N + 2); // buckets for gap heuristic

  const flows = {};
  const queue = [];
  let qHead = 0;

  // --- Core helpers ---

  /** Enqueue active node (skip source/sink, avoid duplicates). */
  const enqueue = (u) => {
    if (u !== source && u !== sink && !inQueue[u] && excess[u] > EPS) {
      inQueue[u] = 1;
      queue.push(u);
    }
  };

  /** Push f units from u to v. Preserves antisymmetry. */
  const push = (u, v, f) => {
    const fwd = `${u}_${v}`;
    const rev = `${v}_${u}`;
    flows[fwd] = (flows[fwd] || 0) + f;
    flows[rev] = (flows[rev] || 0) - f;
    excess[u] -= f;
    excess[v] += f;
    enqueue(v);
  };

  /** Residual capacity u→v. */
  const residual = (u, v) => {
    const key = `${u}_${v}`;
    return (capacities[key] || 0) - (flows[key] || 0);
  };

  /**
   * Global relabel: reverse BFS from sink over the residual graph.
   * Resets all non-source heights to their true distance to sink.
   * Any node that can't reach sink is marked as height = 2*N ("infinity").
   * This is the dominant performance heuristic for push-relabel.
   */
  const globalRelabel = () => {
    // Reset heights to infinity sentinel
    for (let i = 0; i < N; i++) {
      const u = liveNodes[i];
      if (u !== source) height[u] = 2 * N;
    }
    for (let i = 0; i < heightCount.length; i++) heightCount[i] = 0;

    height[sink] = 0;
    heightCount[0] = 1;

    const bfs = [sink];
    let bfsHead = 0;
    while (bfsHead < bfs.length) {
      const v = bfs[bfsHead++];
      const neighbors = graph[v];
      if (!neighbors) continue;
      const hv = height[v];
      for (let i = 0; i < neighbors.length; i++) {
        const u = neighbors[i];
        if (u === source || height[u] !== 2 * N) continue;
        // Can u push to v? i.e. residual(u, v) > 0
        if (residual(u, v) > EPS) {
          height[u] = hv + 1;
          if (height[u] < heightCount.length) heightCount[height[u]]++;
          bfs.push(u);
          if (excess[u] > EPS) enqueue(u);
        }
      }
    }

    height[source] = N;
    // Don't count source in heightCount
  };

  /**
   * Relabel node u: height[u] = 1 + min(height[v]) over v with residual(u,v) > 0.
   * Applies gap heuristic: if oldHeight's bucket becomes empty, all nodes
   * above oldHeight (and below N) are disconnected from sink → send to infinity.
   */
  const relabel = (u) => {
    const oldHeight = height[u];
    const neighbors = graph[u];
    let minH = 2 * N;
    if (neighbors) {
      for (let i = 0; i < neighbors.length; i++) {
        const v = neighbors[i];
        if (residual(u, v) > EPS && height[v] < minH) {
          minH = height[v];
        }
      }
    }
    const newHeight = minH === 2 * N ? 2 * N : minH + 1;

    // Update bucket count for oldHeight (only if within range and not source)
    if (oldHeight < heightCount.length && oldHeight < 2 * N) {
      heightCount[oldHeight]--;
    }

    // Gap heuristic: if this was the last node at oldHeight and oldHeight < N,
    // send every node between oldHeight and N to infinity (disconnected from sink).
    if (
      oldHeight > 0 &&
      oldHeight < N &&
      oldHeight < heightCount.length &&
      heightCount[oldHeight] === 0
    ) {
      for (let i = 0; i < N; i++) {
        const w = liveNodes[i];
        if (w === source || w === sink) continue;
        const hw = height[w];
        if (hw > oldHeight && hw < N) {
          if (hw < heightCount.length) heightCount[hw]--;
          height[w] = 2 * N; // "infinity" — excluded from further work
        }
      }
    }

    height[u] = newHeight;
    if (newHeight < heightCount.length && newHeight < 2 * N) {
      heightCount[newHeight]++;
    }
  };

  /** Discharge node u: push excess to admissible neighbors, relabeling as needed. */
  const discharge = (u) => {
    const neighbors = graph[u];
    if (!neighbors) return 0;
    let work = 0;
    while (excess[u] > EPS) {
      let pushed = false;
      const hu = height[u];
      for (let i = 0; i < neighbors.length; i++) {
        const v = neighbors[i];
        const r = residual(u, v);
        if (r > EPS && hu === height[v] + 1) {
          const f = excess[u] < r ? excess[u] : r;
          push(u, v, f);
          pushed = true;
          if (excess[u] <= EPS) break;
        }
      }
      if (!pushed) {
        relabel(u);
        work += neighbors.length + 1;
        if (height[u] >= 2 * N) break; // disconnected from sink
      }
    }
    return work;
  };

  // --- INITIALIZATION ---

  // Initial heights via global relabel (BFS from sink)
  globalRelabel();
  height[source] = N;

  // Saturate source outgoing edges. Source has "infinite" excess so we can
  // push full capacity on every outgoing edge.
  const sourceNeighbors = graph[source];
  if (sourceNeighbors) {
    // Set source excess high so push() doesn't run it negative past the
    // point where we care. We'll reset to 0 after.
    excess[source] = Infinity;
    for (let i = 0; i < sourceNeighbors.length; i++) {
      const v = sourceNeighbors[i];
      const cap = capacities[`${source}_${v}`] || 0;
      if (cap > EPS) push(source, v, cap);
    }
    excess[source] = 0;
  }

  // --- MAIN LOOP ---

  let opsSinceTimeoutCheck = 0;
  let workSinceGlobalRelabel = 0;
  const GLOBAL_RELABEL_FREQ = 6 * N;

  while (qHead < queue.length) {
    const u = queue[qHead++];
    inQueue[u] = 0;
    if (excess[u] <= EPS) continue;
    if (u === source || u === sink) continue;

    workSinceGlobalRelabel += discharge(u);

    if (++opsSinceTimeoutCheck >= 1024) {
      if (performance.now() - perfStart > calctimeMs) return null;
      opsSinceTimeoutCheck = 0;
    }

    if (workSinceGlobalRelabel > GLOBAL_RELABEL_FREQ) {
      globalRelabel();
      workSinceGlobalRelabel = 0;
    }
  }

  // --- POST-LOOP: Path decomposition ---
  //
  // PR's source saturation pushes full capacity on every outgoing source edge,
  // even when downstream can't absorb it. The main loop drains what it can to
  // sink, but leftover flow either gets stuck (excess > 0 at internal nodes)
  // or forms internal cycles that never reach the sink. Both inflate the
  // per-link flow values in the `flows` dict beyond their actual contribution
  // to the max-flow.
  //
  // Path decomposition rebuilds `flows` from scratch by repeatedly finding
  // source→sink paths in the positive-flow subgraph and accumulating them.
  // Cycles disappear (no path can use a cycle without entering sink) and
  // stuck flow is naturally excluded. The result: `flows[u_v]` contains
  // exactly the flow that travels source→sink through that edge.
  const pathDecomposition = () => {
    const newFlows = {};
    while (true) {
      // BFS source → sink using only edges where flows[u_v] > EPS
      const parents = new Map();
      parents.set(source, -1);
      const bfsQueue = [source];
      let bfsHead = 0;
      let found = false;
      while (bfsHead < bfsQueue.length) {
        const u = bfsQueue[bfsHead++];
        if (u === sink) { found = true; break; }
        const neighbors = graph[u];
        if (!neighbors) continue;
        for (let j = 0; j < neighbors.length; j++) {
          const v = neighbors[j];
          if (parents.has(v)) continue;
          if ((flows[`${u}_${v}`] || 0) > EPS) {
            parents.set(v, u);
            bfsQueue.push(v);
          }
        }
      }
      if (!found) break;
      // Find min flow along the path
      let pathFlow = Infinity;
      let s = sink;
      while (s !== source) {
        const prev = parents.get(s);
        const f = flows[`${prev}_${s}`] || 0;
        if (f < pathFlow) pathFlow = f;
        s = prev;
      }
      if (pathFlow <= EPS) break;
      // Subtract pathFlow from old flows; accumulate into newFlows
      s = sink;
      while (s !== source) {
        const prev = parents.get(s);
        const fwd = `${prev}_${s}`;
        const rev = `${s}_${prev}`;
        flows[fwd] -= pathFlow;
        flows[rev] += pathFlow;
        newFlows[fwd] = (newFlows[fwd] || 0) + pathFlow;
        newFlows[rev] = (newFlows[rev] || 0) - pathFlow;
        s = prev;
      }
    }
    // Replace flows with the decomposed version (cycles removed)
    for (const key in flows) delete flows[key];
    for (const key in newFlows) flows[key] = newFlows[key];
  };
  pathDecomposition();

  return { maxFlow: excess[sink], flows };
}
