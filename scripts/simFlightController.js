// simFlightController.js
//
// Main-thread orchestrator for the spacecraft-flight overlay. Owns the fleet
// config + computed ledger (simFleet) and produces per-frame render data
// (ship positions + transfer arcs) for the display, plus an on-demand
// extension-link computation (simShipLinks) when the constellation backbone is
// available. The fleet sim is cheap and deterministic, so it is recomputed only
// when its config changes; per-frame work is just propagating in-transit ships.

import { simulateFleet } from "./simFleet.js?v=4.35";
import { shipPositionAt } from "./simTransfer.js?v=4.35";
import { extractRootedBackbone, buildShipNodes, computeShipAccessStats } from "./simShipLinks.js?v=4.35";

// Default manufacturing ramp (interplanetary Starships built per year). The UI
// (editable chart) will overwrite this; it just makes the overlay show something
// out of the box.
function defaultManufacturing() {
  const m = {};
  for (let y = 2026; y <= 2040; y++) m[y] = Math.min(40, 4 + (y - 2026) * 3);
  return m;
}

export class SimFlightController {
  constructor() {
    this.enabled = true;
    this.showShips = true;  // ship markers (+ extension links)
    this.showPaths = true;  // transfer arcs
    this.config = {
      manufacturingByYear: defaultManufacturing(),
      returnFraction: 0.5,
      flightCap: 1000,
      sigmaDays: 10,
      portsPerShip: 2,
      seed: 1,
      simStart: new Date(Date.UTC(2025, 0, 1)),
      simEnd: new Date(Date.UTC(2050, 0, 1)),
    };
    this.fleet = null;
    this._arcCache = new Map(); // legKey → polyline [{x,y,z}]
    this._lastInTransit = [];
  }

  setEnabled(on) { this.enabled = !!on; }

  /** Merge partial config; invalidates the fleet so it recomputes lazily. */
  setConfig(partial) {
    Object.assign(this.config, partial);
    this.fleet = null;
    this._arcCache.clear();
  }

  /** (Re)build the fleet ledger from elements + config. Cheap; called lazily. */
  ensureFleet(earthEle, marsEle) {
    if (this.fleet || !earthEle || !marsEle) return;
    const c = this.config;
    this.fleet = simulateFleet({
      earth: earthEle, mars: marsEle,
      manufacturingByYear: c.manufacturingByYear,
      returnFraction: c.returnFraction, flightCap: c.flightCap,
      simStart: c.simStart, simEnd: c.simEnd, sigmaDays: c.sigmaDays, seed: c.seed,
    });
  }

  _arc(s) {
    const key = `${s.shipId}:${s.leg.departureDate.getTime()}`;
    let poly = this._arcCache.get(key);
    if (poly) return poly;
    poly = [];
    const N = 48;
    const dep = s.transfer.departureDate.getTime();
    const arr = s.transfer.arrivalDate.getTime();
    for (let i = 0; i <= N; i++) {
      const p = shipPositionAt(s.transfer, new Date(dep + ((arr - dep) * i) / N));
      poly.push({ x: p.x, y: p.y, z: p.z });
    }
    if (this._arcCache.size > 600) this._arcCache.clear();
    this._arcCache.set(key, poly);
    return poly;
  }

  /**
   * Per-frame render data: in-transit ship markers + their transfer arcs.
   * @param {Date} simDate
   * @returns {{ships:Array, arcs:Array, links:Array, count:number}}
   */
  getRenderData(simDate) {
    if (!this.enabled || !this.fleet) return { ships: [], arcs: [], links: [], count: 0 };
    const inTransit = this.fleet.shipsInTransitAt(simDate);
    this._lastInTransit = inTransit;
    const ships = this.showShips ? inTransit.map((s) => {
      const p = shipPositionAt(s.transfer, simDate);
      return { id: s.shipId, x: p.x, y: p.y, z: p.z, direction: s.direction, fraction: s.fraction, connected: undefined };
    }) : [];
    const arcs = this.showPaths ? inTransit.map((s) => this._arc(s)) : [];
    return { ships, arcs, links: [], count: inTransit.length };
  }

  /**
   * Optional: compute the ship extension network against the current backbone.
   * Returns extension links (in AU endpoints) + per-ship access stats. Call this
   * when the constellation topology is available (not necessarily every frame).
   *
   * @param {Object} p { planets, satellites, possibleLinks, simLinkBudget, simDate }
   */
  computeExtension({ planets, satellites, possibleLinks, simLinkBudget, simDate }) {
    if (!this.enabled || !this.fleet || !possibleLinks || !possibleLinks.length) {
      return { links: [], perShip: [], summary: { connected: 0, unconnected: 0, total: 0 } };
    }
    const inTransit = this.fleet.shipsInTransitAt(simDate);
    if (!inTransit.length) return { links: [], perShip: [], summary: { connected: 0, unconnected: 0, total: 0 } };

    const rooted = extractRootedBackbone({ planets, satellites, possibleLinks, simLinkBudget, planetPortBudget: 1e6 });
    const shipNodes = buildShipNodes(inTransit, simDate, this.config.portsPerShip);
    const res = computeShipAccessStats({ rooted, shipNodes, simLinkBudget, maxRangeAU: simLinkBudget.maxDistanceAU, possibleLinks });

    // Resolve allocator links (ids → AU endpoints) for drawing.
    const posById = new Map();
    for (const r of rooted) posById.set(r.id, r.position);
    for (const n of shipNodes) posById.set(n.id, n.position);
    const links = res.alloc.links
      .map((l) => ({ from: posById.get(l.from), to: posById.get(l.to) }))
      .filter((l) => l.from && l.to);

    return { links, perShip: res.perShip, summary: res.summary };
  }
}
