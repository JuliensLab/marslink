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
//
// PERFORMANCE (2026-10-18): the solver works on integer edge slots instead of
// "u_v" string keys. Every directed pair (u,v) seen in the adjacency gets one
// slot (duplicates in graph[u] share it), with cap[]/flow[] in Float64Arrays
// and rev[] pointing at the (v,u) slot. Each neighbour list is mirrored by a
// parallel slot list, so iteration order — and therefore every push, relabel,
// BFS and floating-point operation — is exactly the string-keyed algorithm's.
// The path decomposition re-uses one stamp array for "visited" instead of a
// fresh Map per path. Output (maxFlow and the flows dict, including key order)
// is identical to the previous implementation; only the bookkeeping changed.

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

  // --- Edge slots (replaces the "u_v" string keys) ---
  // Pair key u*W+v (exact in a double for any realistic node count).
  let W = V;
  for (let i = 0; i < N; i++) {
    const nb = graph[liveNodes[i]];
    if (nb) for (let j = 0; j < nb.length; j++) if (nb[j] + 1 > W) W = nb[j] + 1;
  }
  if (source + 1 > W) W = source + 1;
  if (sink + 1 > W) W = sink + 1;
  const slotOf = new Map();
  const slotU = [];
  const slotV = [];
  const getSlot = (u, v) => {
    const k = u * W + v;
    let e = slotOf.get(k);
    if (e === undefined) {
      e = slotU.length;
      slotOf.set(k, e);
      slotU.push(u);
      slotV.push(v);
    }
    return e;
  };
  // adjSlots[u][i] = slot of (u, graph[u][i]); built for every node that has a
  // neighbour list (graph[x] is looked up by numeric id exactly as before).
  const adjSlots = new Map();
  for (let i = 0; i < N; i++) {
    const u = liveNodes[i];
    const nb = graph[u];
    if (!nb) continue;
    const sl = new Int32Array(nb.length);
    for (let j = 0; j < nb.length; j++) {
      const v = nb[j];
      sl[j] = getSlot(u, v);
      getSlot(v, u);
    }
    adjSlots.set(u, sl);
  }
  const E = slotU.length;
  const cap = new Float64Array(E);
  const flow = new Float64Array(E);
  const rev = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    const u = slotU[e], v = slotV[e];
    cap[e] = capacities[`${u}_${v}`] || 0;
    rev[e] = slotOf.get(v * W + u);
  }

  // --- Per-node state ---
  const height = new Int32Array(V);
  const excess = new Float64Array(V);
  const inQueue = new Uint8Array(V);
  const heightCount = new Int32Array(2 * N + 2); // buckets for gap heuristic

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

  /** Push f units from u to v along slot e. Preserves antisymmetry. */
  const push = (u, v, e, f) => {
    const r = rev[e];
    flow[e] = flow[e] + f;
    flow[r] = flow[r] - f;
    excess[u] -= f;
    excess[v] += f;
    enqueue(v);
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
      const sl = adjSlots.get(v);
      const hv = height[v];
      for (let i = 0; i < neighbors.length; i++) {
        const u = neighbors[i];
        if (u === source || height[u] !== 2 * N) continue;
        // Can u push to v? i.e. residual(u, v) > 0  (slot (u,v) = rev of (v,u))
        const e = rev[sl[i]];
        if (cap[e] - flow[e] > EPS) {
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
      const sl = adjSlots.get(u);
      for (let i = 0; i < neighbors.length; i++) {
        const v = neighbors[i];
        const e = sl[i];
        if (cap[e] - flow[e] > EPS && height[v] < minH) {
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
    const sl = adjSlots.get(u);
    let work = 0;
    while (excess[u] > EPS) {
      let pushed = false;
      const hu = height[u];
      for (let i = 0; i < neighbors.length; i++) {
        const v = neighbors[i];
        const e = sl[i];
        const r = cap[e] - flow[e];
        if (r > EPS && hu === height[v] + 1) {
          const f = excess[u] < r ? excess[u] : r;
          push(u, v, e, f);
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
    const sl = adjSlots.get(source);
    excess[source] = Infinity;
    for (let i = 0; i < sourceNeighbors.length; i++) {
      const v = sourceNeighbors[i];
      const e = sl[i];
      const c = cap[e];
      if (c > EPS) push(source, v, e, c);
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
  // per-link flow values beyond their actual contribution to the max-flow.
  //
  // Path decomposition rebuilds the flows from scratch by repeatedly finding
  // source→sink paths in the positive-flow subgraph and accumulating them.
  // Cycles disappear (no path can use a cycle without entering sink) and
  // stuck flow is naturally excluded. The result: flows["u_v"] contains
  // exactly the flow that travels source→sink through that edge.
  const newFlows = {};
  {
    const newFlow = new Float64Array(E);
    const hasNew = new Uint8Array(E);
    // Insertion order of the output dict = order slots were first written.
    const order = [];
    const visitStamp = new Int32Array(W);
    const parentNode = new Int32Array(W);
    const parentSlot = new Int32Array(W);
    let stamp = 0;
    const bfsQueue = new Int32Array(W);
    while (true) {
      // BFS source → sink using only edges where flow > EPS
      stamp++;
      visitStamp[source] = stamp;
      parentNode[source] = -1;
      let qLen = 0;
      bfsQueue[qLen++] = source;
      let bfsHead = 0;
      let found = false;
      while (bfsHead < qLen) {
        const u = bfsQueue[bfsHead++];
        if (u === sink) { found = true; break; }
        const neighbors = graph[u];
        if (!neighbors) continue;
        const sl = adjSlots.get(u);
        for (let j = 0; j < neighbors.length; j++) {
          const v = neighbors[j];
          if (visitStamp[v] === stamp) continue;
          const e = sl[j];
          // (flow || 0) > EPS: an untouched slot reads 0 like a missing key
          if (flow[e] > EPS) {
            visitStamp[v] = stamp;
            parentNode[v] = u;
            parentSlot[v] = e;
            bfsQueue[qLen++] = v;
          }
        }
      }
      if (!found) break;
      // Find min flow along the path
      let pathFlow = Infinity;
      let s = sink;
      while (s !== source) {
        const f = flow[parentSlot[s]];
        if (f < pathFlow) pathFlow = f;
        s = parentNode[s];
      }
      if (pathFlow <= EPS) break;
      // Subtract pathFlow from old flows; accumulate into newFlow
      s = sink;
      while (s !== source) {
        const fwd = parentSlot[s];
        const rv = rev[fwd];
        flow[fwd] -= pathFlow;
        flow[rv] += pathFlow;
        if (!hasNew[fwd]) { hasNew[fwd] = 1; order.push(fwd); }
        newFlow[fwd] = newFlow[fwd] + pathFlow;
        if (!hasNew[rv]) { hasNew[rv] = 1; order.push(rv); }
        newFlow[rv] = newFlow[rv] - pathFlow;
        s = parentNode[s];
      }
    }
    for (let k = 0; k < order.length; k++) {
      const e = order[k];
      newFlows[`${slotU[e]}_${slotV[e]}`] = newFlow[e];
    }
  }

  return { maxFlow: excess[sink], flows: newFlows };
}
