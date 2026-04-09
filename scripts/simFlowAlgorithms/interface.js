// interface.js — Max-flow algorithm interface and registry.
//
// Every max-flow algorithm in this directory must export a single function
// matching the MaxFlowAlgorithm type: same input and output shape, same
// semantic invariants. This makes them interchangeable — swap algorithms
// by changing DEFAULT_ALGORITHM below or passing { algorithm: "name" }
// to computeMaxFlow() in simMaxFlow.js.
//
// ============================================================
//  TYPE DEFINITIONS
// ============================================================
//
// /**
//  * @typedef {Object} MaxFlowInput
//  * @property {Object<number, number[]>} graph       - Adjacency list: graph[nodeId] = [neighborIds...]
//  * @property {Object<string, number>}   capacities  - Edge capacities: capacities["${u}_${v}"] = number
//  * @property {number}                   source      - Source node ID (typically Earth = 0)
//  * @property {number}                   sink        - Sink node ID (typically Mars = 1)
//  * @property {number}                   perfStart   - performance.now() at start (for timeout)
//  * @property {number}                   calctimeMs  - Maximum allowed compute time in ms
//  */
//
// /**
//  * @typedef {Object} MaxFlowResult
//  * @property {number}                 maxFlow  - Total max flow value from source to sink
//  * @property {Object<string, number>} flows    - Signed flow per directed edge
//  */
//
// /**
//  * @typedef {(input: MaxFlowInput) => MaxFlowResult | null} MaxFlowAlgorithm
//  * Returns null on timeout.
//  */
//
// ============================================================
//  INVARIANTS ALL ALGORITHMS MUST MAINTAIN
// ============================================================
//
//  1. Antisymmetry:      flows["u_v"] = -flows["v_u"] after completion.
//                        All flow writes MUST go through a central helper
//                        that writes both directions.
//
//  2. Flow conservation: For every node except source/sink, the signed
//                        sum of all outgoing flows is 0.
//
//  3. Capacity feasible: flows["u_v"] ≤ capacities["u_v"] for every edge.
//
//  4. Timeout behavior:  Return null if performance.now() - perfStart > calctimeMs.
//                        Check at reasonable intervals, not per-op
//                        (performance.now() has non-trivial overhead).
//
//  5. Edge key format:   "${u}_${v}" where u, v are numeric node IDs.
//                        Missing entries in flows dict are treated as 0.
//
// ============================================================

import { edmondsKarp } from "./edmondsKarp.js";
import { pushRelabel } from "./pushRelabel.js";
import { topologyAware } from "./topologyAware.js";

/** Registry of available max-flow algorithms. */
export const FLOW_ALGORITHMS = {
  "edmonds-karp": edmondsKarp,
  "push-relabel": pushRelabel,
  "topology-aware": topologyAware,
};

/** The algorithm used when none is explicitly specified. */
export const DEFAULT_ALGORITHM = "topology-aware";
