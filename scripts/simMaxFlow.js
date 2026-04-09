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

import { simplifyNetwork, desimplifyNetwork } from "./simFlowAlgorithms/networkSimplification.js";
import { calculateLatencies } from "./simFlowAlgorithms/latencies.js";
import { FLOW_ALGORITHMS, DEFAULT_ALGORITHM } from "./simFlowAlgorithms/interface.js";
import { edmondsKarp } from "./simFlowAlgorithms/edmondsKarp.js";
import { pushRelabel } from "./simFlowAlgorithms/pushRelabel.js";
import { topologyAware } from "./simFlowAlgorithms/topologyAware.js";

// Re-exports for existing callers
export { simplifyNetwork, desimplifyNetwork, calculateLatencies };
export { edmondsKarp, pushRelabel, topologyAware };

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
 * @param {Object}                   [input.topology]   - Structured topology info (used by topology-aware algorithm).
 * @param {Map<string,number>}       [input.nodeIds]    - name → node ID map (for topology-aware).
 * @returns {{ maxFlow: number, flows: Object<string, number> } | null}
 */
export function computeMaxFlow({ graph, capacities, source, sink, perfStart, calctimeMs, algorithm, topology, nodeIds }) {
  const name = algorithm || DEFAULT_ALGORITHM;
  const algo = FLOW_ALGORITHMS[name];
  if (!algo) throw new Error(`Unknown max-flow algorithm: ${name}`);
  return algo({ graph, capacities, source, sink, perfStart, calctimeMs, topology, nodeIds });
}
