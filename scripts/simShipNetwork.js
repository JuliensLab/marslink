// simShipNetwork.js
//
// Network extension at the constellation edge by in-transit ships.
//
// Ships extend the relay network only by attaching to something already
// connected to the Earth↔Mars backbone — either a backbone node with a spare
// laser port, or a ship that is itself already rooted. They never attach to a
// not-yet-rooted ship, so no isolated ship-to-ship islands can form. A link
// costs one laser port on each endpoint; a ship with N ports spends one to
// connect upstream and can then serve (N-1) further ships:
//   1 port → leaf, 2 ports → relays one more, 3 ports → junction to two.
//
// Allocation is a Prim-like frontier growth: repeatedly take the shortest
// feasible link from the rooted frontier (any rooted node with a free port) to
// an unrooted ship (with a free port), allocate it, and move that ship into the
// frontier. Ships that can never reach the frontier are left unconnected — a
// measured "no link this snapshot" outcome, not an island.
//
// Pure geometry/graph logic; feasibility (max range, solar blinding) is injected
// so this stays decoupled from the link-budget / topology layers.

const AU = 1; // positions are already in AU; kept for readability

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * @param {Object} params
 * @param {Array<{id:*, position:{x,y,z}, freePorts:number}>} params.rootedNodes
 *   Backbone anchors already connected to BOTH Earth and Mars (Earth, Mars, and
 *   backbone sats in the connected component) that have a spare port. `freePorts`
 *   is how many of their ports are still available after the backbone is built.
 * @param {Array<{id:*, position:{x,y,z}, ports:number}>} params.shipNodes
 *   In-transit ships to attach. `ports` is the global per-ship terminal count (1–3).
 * @param {number} [params.maxRangeAU=Infinity]  Laser max link distance (AU).
 * @param {(aPos,bPos)=>boolean} [params.feasible]  Extra feasibility test
 *   (e.g. not solar-blinded). Defaults to range-only.
 * @returns {{
 *   links: Array<{from:*, to:*, distanceAU:number}>,   // to = the attached ship
 *   attachment: Map<*, {parent:*, distanceAU:number, depth:number}>, // shipId → uplink
 *   connected: Array<*>,    // ship ids that reached the backbone
 *   unconnected: Array<*>,  // ship ids left with no path (no island formed)
 * }}
 */
export function allocateShipNetwork({ rootedNodes, shipNodes, maxRangeAU = Infinity, feasible }) {
  const inRange = (a, b) => dist(a, b) <= maxRangeAU && (!feasible || feasible(a, b));

  // Frontier = rooted nodes with at least one free port. Use a working copy of
  // port counts so we never mutate the caller's objects.
  const frontier = rootedNodes.map((n) => ({
    id: n.id, position: n.position, freePorts: n.freePorts, isShip: false, depth: 0,
  }));

  // Unattached ships, each with its own free-port budget.
  const pending = new Map(); // shipId → { id, position, freePorts }
  for (const s of shipNodes) pending.set(s.id, { id: s.id, position: s.position, freePorts: s.ports });

  const links = [];
  const attachment = new Map();
  const connected = [];

  // Greedy frontier growth.
  while (pending.size > 0) {
    let best = null; // { rootRef, ship, d }
    for (const r of frontier) {
      if (r.freePorts <= 0) continue;
      for (const ship of pending.values()) {
        if (ship.freePorts <= 0) continue; // (ships always have ≥1 here)
        if (!inRange(r.position, ship.position)) continue;
        const d = dist(r.position, ship.position);
        if (!best || d < best.d) best = { rootRef: r, ship, d };
      }
    }
    if (!best) break; // remaining ships can't reach the frontier → unconnected

    const { rootRef, ship, d } = best;
    // Spend a port on each endpoint.
    rootRef.freePorts -= 1;
    const remaining = ship.freePorts - 1;

    links.push({ from: rootRef.id, to: ship.id, distanceAU: d });
    attachment.set(ship.id, { parent: rootRef.id, distanceAU: d, depth: rootRef.depth + 1 });
    connected.push(ship.id);

    // Promote the ship into the frontier with its leftover ports (relay/junction).
    pending.delete(ship.id);
    frontier.push({ id: ship.id, position: ship.position, freePorts: remaining, isShip: true, depth: rootRef.depth + 1 });
  }

  return { links, attachment, connected, unconnected: [...pending.keys()] };
}

/**
 * Trace a connected ship's access chain up to its backbone root, returning the
 * ordered hop distances (AU). Lets the link layer compute the access-path
 * latency (Σ light-time) and the bottleneck capacity (min over hops), so a
 * relay ship correctly shares its uplink with everything behind it.
 *
 * @param {*} shipId
 * @param {Map} attachment  from allocateShipNetwork
 * @returns {{ hops: number[], rootId:* }|null}  null if the ship is unconnected
 */
export function accessChain(shipId, attachment) {
  if (!attachment.has(shipId)) return null;
  const hops = [];
  let cur = shipId;
  let guard = 0;
  while (attachment.has(cur) && guard++ < 10000) {
    const a = attachment.get(cur);
    hops.push(a.distanceAU);
    cur = a.parent;
  }
  return { hops, rootId: cur }; // cur is the first non-ship (backbone) ancestor
}
