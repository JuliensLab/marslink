// simNetwork.js — Thin orchestrator delegating to simTopology.js and simMaxFlow.js.

import { TopologyBuilder } from "./simTopology.js";
import { simplifyNetwork, desimplifyNetwork, computeMaxFlow, calculateLatencies } from "./simMaxFlow.js";

export class SimNetwork {
  constructor(simLinkBudget, simSatellites) {
    this.simLinkBudget = simLinkBudget;
    this.simSatellites = simSatellites;
    this.topology = new TopologyBuilder(simLinkBudget, simSatellites);
  }

  /**
   * Generates all possible links between planets and satellites.
   *
   * @param {Array} planets - Array of planet objects, each with properties { name, position: { x, y, z } }.
   * @param {Array} satellites - Array of satellite objects with properties { name, position: { x, y, z } }.
   * @returns {Array} links - Array of link objects with properties:
   *                          {
   *                            fromId: string,
   *                            toId: string,
   *                            distanceAU,
   *                            distanceKm,
   *                            latencySeconds,
   *                            gbpsCapacity
   *                          }
   */
  getPossibleLinks(planets, satellites) {
    const links = this.topology.buildTopology(planets, satellites);
    this.routeSummary = this.topology.routeSummary;
    this.topologyInfo = this.topology.topologyInfo;
    return links;
  }

  /**
   * Constructs the network graph based on precomputed finalLinks and computes the maximum flow.
   *
   * @param {Array} planets - Array of planet objects (e.g., Earth, Mars) with properties like name and position.
   * @param {Array} satellites - Array of satellite objects with properties like name, ringName, position, neighbors, and 'a'.
   * @param {Array} finalLinks - Array of link objects precomputed by getPossibleLinks, each containing fromId, toId, distanceAU, distanceKm, latencySeconds, and gbpsCapacity.
   * @param {number} calctimeMs - Maximum allowed computation time in ms.
   * @returns {Object} - An object containing the established links with flow information and the total maximum flow.
   */
  getNetworkData(planets, satellites, finalLinks, calctimeMs) {
    const perfStart = performance.now();

    // Node ID Assignment
    const nodeIds = new Map(); // Map to store node IDs
    let nodeIdCounter = 0;

    // Add Earth and Mars to node IDs
    const earth = planets.find((planet) => planet.name === "Earth");
    const mars = planets.find((planet) => planet.name === "Mars");

    if (!earth || !mars) {
      console.warn("Earth or Mars position is not available.");
      return { links: [], maxFlow: 0 };
    }

    nodeIds.set("Earth", nodeIdCounter++);
    nodeIds.set("Mars", nodeIdCounter++);

    // Add Satellites to node IDs (single node per satellite, no splitting)
    satellites.forEach((satellite) => {
      nodeIds.set(satellite.name, nodeIdCounter++);
    });

    // Build the Graph
    const graph = {}; // Adjacency list representation
    const capacities = {}; // Edge capacities
    const latencies = {}; // Edge latencies

    // Initialize graph nodes as empty adjacency lists
    nodeIds.forEach((id) => {
      graph[id] = [];
    });

    // Helper Function to Add Edges (Bidirectional capacity for undirected links)
    // Both directions get capacity C — max-flow selects whichever direction is needed.
    // The NET directed flow on each physical link is still ≤ C after the algorithm
    // completes (because any real reverse flow cancels forward flow).
    //
    // Note: finalLinks is deduplicated upstream in buildTopology (via existingLinks
    // Set), so we can skip the includes() check and push directly.
    const addEdge = (fromId, toId, capacity, latency) => {
      graph[fromId].push(toId);
      graph[toId].push(fromId);
      const edgeKey = `${fromId}_${toId}`;
      const reverseEdgeKey = `${toId}_${fromId}`;
      capacities[edgeKey] = capacity;
      capacities[reverseEdgeKey] = capacity;
      latencies[edgeKey] = latency;
      latencies[reverseEdgeKey] = latency;
    };

    // Add All Links (Bidirectional)
    finalLinks.forEach((link) => {
      const { fromId, toId, gbpsCapacity, latencySeconds } = link;

      // Validate Node IDs
      if (!nodeIds.has(fromId)) {
        console.warn(`fromId "${fromId}" not found among planets or satellites.`);
        return;
      }
      if (!nodeIds.has(toId)) {
        console.warn(`toId "${toId}" not found among planets or satellites.`);
        return;
      }

      const fromNodeId = nodeIds.get(fromId);
      const toNodeId = nodeIds.get(toId);

      addEdge(fromNodeId, toNodeId, gbpsCapacity, latencySeconds);
    });

    const source = nodeIds.get("Earth");
    const sink = nodeIds.get("Mars");

    const algorithm = this.simLinkBudget.flowAlgorithm;
    // Topology-aware skips simplification — it needs the original ring chains.
    const useSimplification = algorithm !== "topology-aware";

    // --- STEP 1: SIMPLIFY ---
    const simplificationStack = [];
    if (useSimplification) {
      simplifyNetwork(graph, capacities, latencies, source, sink, simplificationStack);
    }

    // --- STEP 2: RUN MAX FLOW ---
    // Uses the algorithm selected in simLinkBudget.flowAlgorithm (from the
    // Simulation section UI), falling back to the default in
    // simFlowAlgorithms/interface.js if unset.
    const maxFlowResult = computeMaxFlow({
      graph,
      capacities,
      source,
      sink,
      perfStart,
      calctimeMs,
      algorithm,
      topology: this.topologyInfo,
      nodeIds,
    });

    if (maxFlowResult === null) return { links: [], maxFlowGbps: 0, error: "timed out" };

    // --- STEP 3: DESIMPLIFY ---
    if (useSimplification) {
      desimplifyNetwork(graph, maxFlowResult.flows, simplificationStack);
    }

    // --- STEP 4: OUTPUT GENERATION ---
    // Now graph and flows match the original physical satellites.
    // calculateLatencies and visualization will work normally.

    // Extract the Flows on Each Link
    const flows = maxFlowResult.flows;

    // Prepare the Output Links with flow > 0
    const outputLinks = [];

    finalLinks.forEach((link) => {
      const { fromId, toId, distanceAU, distanceKm, latencySeconds, gbpsCapacity } = link;

      // Retrieve Node IDs
      const fromNodeId = nodeIds.get(fromId);
      const toNodeId = nodeIds.get(toId);

      // Define Edge Keys
      const forwardEdgeKey = `${fromNodeId}_${toNodeId}`;
      const reverseEdgeKey = `${toNodeId}_${fromNodeId}`;

      // Net directed flow: flows[forwardEdgeKey] already contains the NET signed
      // flow (positive = fromId→toId, negative = toId→fromId) because residual
      // updates at augmentation time naturally compute it.
      const netFlow = flows[forwardEdgeKey] || 0;
      const absFlow = Math.abs(netFlow);

      if (absFlow > 0) {
        const flowDir = netFlow >= 0;
        outputLinks.push({
          fromId: flowDir ? fromId : toId,
          toId: flowDir ? toId : fromId,
          distanceAU: Math.round(distanceAU * 1e6) / 1e6,
          distanceKm: Math.round(distanceKm),
          latencySeconds: Math.round(latencySeconds * 10) / 10,
          gbpsCapacity: Math.round(gbpsCapacity * 1e6) / 1e6,
          gbpsFlow: Math.round(absFlow * 1e6) / 1e6,
        });
      }
    });
    return {
      links: outputLinks,
      maxFlowGbps: maxFlowResult.maxFlow,
      graph, // Adjacency list
      capacities, // Edge capacities
      flows, // Flow per edge
      nodeIds, // Map of node names to IDs
      error: null,
    };
  }

  /**
   * Calculates latencies for the network flows and aggregates the gbps per latency bin.
   *
   * @param {Object} networkData - The object returned by getNetworkData containing graph, flows, etc.
   * @param {Number} binSize - The size of each latency bin in seconds.
   * @returns {Object} - An object containing the latency histogram, best latency, and average latency.
   */
  calculateLatencies(networkData, binSize = 60 * 5) {
    return calculateLatencies(networkData, binSize);
  }
}
