// simShipLinks.js
//
// Glue layer that connects the fleet (simFleet) to the relay constellation
// (simSatellites / simTopology) through the no-island allocator (simShipNetwork)
// and reports per-ship access capacity & latency.
//
// Responsibilities:
//   1. extractRootedBackbone() — turn a built constellation + its topology into
//      the rooted-node list the allocator needs: Earth, Mars, and every backbone
//      satellite that is connected to BOTH planets and still has a spare laser
//      port (ports the backbone topology didn't consume).
//   2. buildShipNodes() — position the in-transit ships at a date.
//   3. computeShipAccessStats() — run the allocator and derive each connected
//      ship's access-chain capacity (bottleneck) and latency (Σ light-time) to
//      its backbone root.
//
// "Connected to both Earth and Mars" is read directly from the possibleLinks
// graph (the physical/feasible backbone), independent of the max-flow solve.

import { shipPositionAt } from "./simTransfer.js?v=4.35";
import { allocateShipNetwork, accessChain } from "./simShipNetwork.js?v=4.35";

// ---------------------------------------------------------------------------
// Connectivity helper
// ---------------------------------------------------------------------------

/** Nodes (by name) reachable from `startName` over the undirected link graph. */
function reachable(adj, startName) {
  const seen = new Set();
  if (!adj.has(startName)) return seen;
  const stack = [startName];
  seen.add(startName);
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of adj.get(cur) || []) {
      if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Rooted backbone extraction
// ---------------------------------------------------------------------------

/**
 * @param {Object} p
 * @param {Array}  p.planets         - planet objects with .name and .position
 * @param {Array}  p.satellites      - sat objects with .name, .ringName, .position
 * @param {Array}  p.possibleLinks   - backbone links [{fromId,toId,...}]
 * @param {Object} p.simLinkBudget   - for getMaxLinksPerRing()
 * @param {number} [p.planetPortBudget=Infinity] - access ports Earth/Mars expose
 * @returns {Array<{id, position, freePorts, ringName?}>}
 */
export function extractRootedBackbone({ planets, satellites, possibleLinks, simLinkBudget, planetPortBudget = Infinity }) {
  // Degree (= ports consumed by the backbone) and adjacency, from possibleLinks.
  const degree = new Map();
  const adj = new Map();
  const link = (a, b) => {
    degree.set(a, (degree.get(a) || 0) + 1);
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const l of possibleLinks) { link(l.fromId, l.toId); link(l.toId, l.fromId); }

  // "Connected to both" = in the component that contains Earth AND Mars.
  const fromEarth = reachable(adj, "Earth");
  const fromMars = reachable(adj, "Mars");
  const bothConnected = new Set([...fromEarth].filter((n) => fromMars.has(n)));

  const rooted = [];
  const earth = planets.find((p) => p.name === "Earth");
  const mars = planets.find((p) => p.name === "Mars");
  if (earth && bothConnected.has("Earth")) rooted.push({ id: "Earth", position: earth.position, freePorts: planetPortBudget });
  if (mars && bothConnected.has("Mars")) rooted.push({ id: "Mars", position: mars.position, freePorts: planetPortBudget });

  for (const sat of satellites) {
    if (!bothConnected.has(sat.name)) continue;
    const max = simLinkBudget.getMaxLinksPerRing(sat.ringName);
    const spare = max - (degree.get(sat.name) || 0);
    if (spare > 0) rooted.push({ id: sat.name, position: sat.position, freePorts: spare, ringName: sat.ringName });
  }
  return rooted;
}

// ---------------------------------------------------------------------------
// Ship-node building
// ---------------------------------------------------------------------------

/**
 * Position the in-transit ships at `date`.
 * @param {Array} inTransit - from fleet.shipsInTransitAt(date)
 * @param {Date}  date
 * @param {number} portsPerShip - global 1–3 terminal count
 * @returns {Array<{id, position, ports, meta}>}
 */
export function buildShipNodes(inTransit, date, portsPerShip) {
  return inTransit.map((s) => ({
    id: `ship-${s.shipId}`,
    position: shipPositionAt(s.transfer, date),
    ports: portsPerShip,
    meta: s,
  }));
}

// ---------------------------------------------------------------------------
// Backbone reach (root → Earth / Mars)
// ---------------------------------------------------------------------------

/** Tiny binary heap. `before(a,b)` is true when a should pop before b. */
class Heap {
  constructor(before) { this.a = []; this.before = before; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.before(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0; const n = a.length;
      for (;;) {
        let s = i; const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && this.before(a[l], a[s])) s = l;
        if (r < n && this.before(a[r], a[s])) s = r;
        if (s === i) break;
        [a[i], a[s]] = [a[s], a[i]]; i = s;
      }
    }
    return top;
  }
}

/** Undirected adjacency from possibleLinks: id → [{to, lat, cap}]. */
function buildBackboneAdj(possibleLinks) {
  const adj = new Map();
  const add = (from, to, lat, cap) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, lat, cap });
  };
  for (const l of possibleLinks) {
    const lat = l.latencySeconds || 0;
    const cap = l.gbpsCapacity || 0;
    add(l.fromId, l.toId, lat, cap);
    add(l.toId, l.fromId, lat, cap);
  }
  return adj;
}

/** Min-sum shortest path (latency) from `source` to every node. */
function shortestLatencyFrom(adj, source) {
  const dist = new Map([[source, 0]]);
  const h = new Heap((x, y) => x.key < y.key);
  h.push({ id: source, key: 0 });
  while (h.size) {
    const { id, key } = h.pop();
    if (key > (dist.has(id) ? dist.get(id) : Infinity)) continue;
    for (const e of adj.get(id) || []) {
      const nd = key + e.lat;
      if (nd < (dist.has(e.to) ? dist.get(e.to) : Infinity)) { dist.set(e.to, nd); h.push({ id: e.to, key: nd }); }
    }
  }
  return dist;
}

/** Max-min widest path (bottleneck capacity) from `source` to every node. */
function widestPathFrom(adj, source) {
  const wide = new Map([[source, Infinity]]);
  const h = new Heap((x, y) => x.key > y.key); // max-heap on bottleneck
  h.push({ id: source, key: Infinity });
  while (h.size) {
    const { id, key } = h.pop();
    if (key < (wide.has(id) ? wide.get(id) : -Infinity)) continue;
    for (const e of adj.get(id) || []) {
      const nb = Math.min(key, e.cap);
      if (nb > (wide.has(e.to) ? wide.get(e.to) : -Infinity)) { wide.set(e.to, nb); h.push({ id: e.to, key: nb }); }
    }
  }
  return wide;
}

/**
 * Best-path reach of the physical backbone from a ship's attach root all the way
 * to each planet: shortest-latency path (Σ light-time) and widest path (min-link
 * bottleneck capacity) from Earth and from Mars to every backbone node. The graph
 * is undirected, so "from Earth to root" == "from root to Earth". This is the
 * single-best-path idealization (no contention with the constellation's own
 * Earth↔Mars traffic or with other ships), consistent with the access-chain stats.
 *
 * @param {Array} possibleLinks  backbone links [{fromId,toId,latencySeconds,gbpsCapacity}]
 * @returns {{latEarth:Map, latMars:Map, capEarth:Map, capMars:Map}}
 */
export function computeBackboneReach(possibleLinks) {
  const adj = buildBackboneAdj(possibleLinks);
  return {
    latEarth: shortestLatencyFrom(adj, "Earth"),
    latMars: shortestLatencyFrom(adj, "Mars"),
    capEarth: widestPathFrom(adj, "Earth"),
    capMars: widestPathFrom(adj, "Mars"),
  };
}

// ---------------------------------------------------------------------------
// Per-ship access stats
// ---------------------------------------------------------------------------

/**
 * Allocate the ship network and compute, for each connected ship, the
 * access-chain capacity (bottleneck Gbps over its hops to the backbone root)
 * and latency (Σ light-time over those hops). The root→Earth/Mars leg is left
 * to the existing max-flow layer; this is the ship-access portion.
 *
 * @param {Object} p
 * @param {Array}  p.rooted        - from extractRootedBackbone
 * @param {Array}  p.shipNodes     - from buildShipNodes
 * @param {Object} p.simLinkBudget
 * @param {number} p.maxRangeAU
 * @param {Function} [p.feasible]  - (aPos,bPos)=>bool extra test (e.g. not solar-blinded)
 * @returns {{
 *   alloc: ReturnType<typeof allocateShipNetwork>,
 *   perShip: Array<{shipId, connected, capacityGbps, accessLatencySec, hops, rootId,
 *                   capEarthGbps, capMarsGbps, latEarthSec, latMarsSec}>,
 *   summary: {connected:number, unconnected:number, total:number}
 * }}
 */
export function computeShipAccessStats({ rooted, shipNodes, simLinkBudget, maxRangeAU, feasible, possibleLinks }) {
  const alloc = allocateShipNetwork({ rootedNodes: rooted, shipNodes, maxRangeAU, feasible });
  const auToKm = (au) => simLinkBudget.convertAUtoKM(au);

  // End-to-end reach is access-chain (ship→root) composed with the backbone's
  // best path (root→Earth / root→Mars). Compute the backbone half once.
  const reach = possibleLinks && possibleLinks.length ? computeBackboneReach(possibleLinks) : null;
  const get = (m, id) => (m && m.has(id) ? m.get(id) : undefined);

  const perShip = [];
  for (const node of shipNodes) {
    const chain = accessChain(node.id, alloc.attachment);
    if (!chain) {
      perShip.push({
        shipId: node.meta.shipId, connected: false, capacityGbps: 0, accessLatencySec: Infinity, hops: 0, rootId: null,
        capEarthGbps: 0, capMarsGbps: 0, latEarthSec: Infinity, latMarsSec: Infinity,
      });
      continue;
    }
    let capacity = Infinity;
    let latency = 0;
    for (const hopAU of chain.hops) {
      const km = auToKm(hopAU);
      capacity = Math.min(capacity, simLinkBudget.calculateGbps(km));
      latency += simLinkBudget.calculateLatencySeconds(km);
    }

    // Compose the access half with the backbone half (root → planet). A root that
    // IS a planet has reach 0 latency / Infinity capacity there, so end-to-end
    // collapses to the access-chain value — exactly right.
    const entry = {
      shipId: node.meta.shipId,
      connected: true,
      capacityGbps: capacity,
      accessLatencySec: latency,
      hops: chain.hops.length,
      rootId: chain.rootId,
      capEarthGbps: 0, capMarsGbps: 0, latEarthSec: Infinity, latMarsSec: Infinity,
    };
    if (reach) {
      const bbLatE = get(reach.latEarth, chain.rootId);
      const bbLatM = get(reach.latMars, chain.rootId);
      const bbCapE = get(reach.capEarth, chain.rootId);
      const bbCapM = get(reach.capMars, chain.rootId);
      if (bbLatE !== undefined) entry.latEarthSec = latency + bbLatE;
      if (bbLatM !== undefined) entry.latMarsSec = latency + bbLatM;
      if (bbCapE !== undefined) entry.capEarthGbps = Math.min(capacity, bbCapE);
      if (bbCapM !== undefined) entry.capMarsGbps = Math.min(capacity, bbCapM);
    }
    perShip.push(entry);
  }

  return {
    alloc,
    perShip,
    summary: { connected: alloc.connected.length, unconnected: alloc.unconnected.length, total: shipNodes.length },
  };
}
