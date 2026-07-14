// simFleet.js
//
// Fleet population model for the Earth↔Mars spacecraft-link simulation.
//
// A yearly Starship manufacturing chart feeds an Earth pool. At each Earth→Mars
// opportunity every eligible Earth-pool ship launches (departure dates spread as
// a normal around the window centre, each leg solved by simTransfer). Ships
// arriving at Mars join the Mars pool; at each Mars→Earth opportunity a
// deterministic fraction of the Mars pool returns. Returnees rejoin the Earth
// pool and re-launch next window. Ships retire once their leg count reaches a
// cap. Every ship is tracked as an individual lightweight record with its full
// leg history, so any moment can be queried (in-transit set, pool counts).
//
// All transfer geometry is delegated to simTransfer (local refined-Hohmann);
// this module owns only the discrete-event population dynamics. Pure logic, no
// DOM — runnable/testable in Node.

import { solveTransfer, findDepartureWindows } from "./simTransfer.js?v=4.34";

const MS_PER_DAY = 86400000;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + Gaussian, so fleets are reproducible across runs
// and shareable via presets.
// ---------------------------------------------------------------------------

export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Box-Muller standard normal.
  next.gaussian = (mean = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// ---------------------------------------------------------------------------
// Fleet simulation
// ---------------------------------------------------------------------------

/**
 * @param {Object} cfg
 * @param {Object} cfg.earth                - Earth orbital elements
 * @param {Object} cfg.mars                 - Mars orbital elements
 * @param {Object<number,number>} cfg.manufacturingByYear - { year: shipsBuilt }
 * @param {number} cfg.returnFraction       - 0..1 of the Mars pool that returns each window
 * @param {number} cfg.flightCap            - retire a ship once its leg count reaches this
 * @param {Date}   cfg.simStart
 * @param {Date}   cfg.simEnd
 * @param {number} [cfg.sigmaDays=7]         - std-dev (days) of departure spread around a window
 * @param {number} [cfg.seed=1]
 * @returns {Fleet}
 */
export function simulateFleet(cfg) {
  const {
    earth, mars, manufacturingByYear,
    returnFraction, flightCap,
    simStart, simEnd, sigmaDays = 7, seed = 1,
  } = cfg;
  const rng = makeRng(seed);

  // Opportunity window centres for each direction (purely local finder).
  const emWindows = findDepartureWindows(earth, mars, simStart, simEnd);
  const meWindows = findDepartureWindows(mars, earth, simStart, simEnd);

  // Chronologically-ordered launch events across both directions.
  const windowEvents = [
    ...emWindows.map((d) => ({ date: d, dir: "EM" })),
    ...meWindows.map((d) => ({ date: d, dir: "ME" })),
  ].sort((a, b) => a.date - b.date);

  // Manufacturing events (ships built on Earth at the start of each year).
  const manuEvents = Object.entries(manufacturingByYear)
    .map(([y, n]) => ({ date: new Date(Date.UTC(+y, 0, 1)), n: Math.max(0, Math.round(n)) }))
    .filter((m) => m.n > 0 && m.date >= simStart && m.date <= simEnd)
    .sort((a, b) => a.date - b.date);

  /** @type {Ship[]} */
  const ships = [];
  let nextId = 0;
  const earthPool = new Set(); // ship ids available on Earth
  const marsPool = new Set();  // ship ids available on Mars
  const pendingArrivals = [];  // { arrivalMs, shipId, to }

  let manuIdx = 0;

  const drainManufacturing = (uptoMs) => {
    while (manuIdx < manuEvents.length && manuEvents[manuIdx].date.getTime() <= uptoMs) {
      const m = manuEvents[manuIdx++];
      for (let k = 0; k < m.n; k++) {
        const ship = { id: nextId++, manufactureDate: m.date, legs: [], flightCount: 0, retiredDate: null };
        ships.push(ship);
        earthPool.add(ship.id);
      }
    }
  };

  const drainArrivals = (uptoMs) => {
    // Process every arrival that has completed by uptoMs (order among them is
    // irrelevant — each just moves a ship into a pool / retires it).
    const due = pendingArrivals.filter((a) => a.arrivalMs <= uptoMs);
    if (!due.length) return;
    due.sort((a, b) => a.arrivalMs - b.arrivalMs);
    for (const a of due) {
      const ship = ships[a.shipId];
      ship.flightCount += 1;
      if (ship.flightCount >= flightCap) {
        ship.retiredDate = new Date(a.arrivalMs);
      } else if (a.to === "mars") {
        marsPool.add(ship.id);
      } else {
        earthPool.add(ship.id);
      }
    }
    // Remove processed arrivals.
    for (let i = pendingArrivals.length - 1; i >= 0; i--) {
      if (pendingArrivals[i].arrivalMs <= uptoMs) pendingArrivals.splice(i, 1);
    }
  };

  const launch = (ship, originEle, destEle, windowCentre, toName) => {
    const depMs = windowCentre.getTime() + rng.gaussian(0, sigmaDays) * MS_PER_DAY;
    const departureDate = new Date(depMs);
    const transfer = solveTransfer(originEle, destEle, departureDate);
    ship.legs.push({
      dir: toName === "mars" ? "EM" : "ME",
      to: toName,
      departureDate,
      arrivalDate: transfer.arrivalDate,
      transfer,
    });
    pendingArrivals.push({ arrivalMs: transfer.arrivalDate.getTime(), shipId: ship.id, to: toName });
  };

  // Walk the merged event timeline.
  for (const ev of windowEvents) {
    const evMs = ev.date.getTime();
    drainManufacturing(evMs);
    drainArrivals(evMs);

    if (ev.dir === "EM") {
      // Every eligible Earth-pool ship launches.
      const eligible = [...earthPool].sort((a, b) => a - b);
      for (const id of eligible) {
        earthPool.delete(id);
        launch(ships[id], earth, mars, ev.date, "mars");
      }
    } else {
      // A deterministic, rounded fraction of the Mars pool returns. Choose the
      // ships with the most flights first (cycle them home before they idle).
      const pool = [...marsPool].sort((a, b) => ships[b].flightCount - ships[a].flightCount || a - b);
      const nReturn = Math.round(returnFraction * pool.length);
      for (let k = 0; k < nReturn; k++) {
        const id = pool[k];
        marsPool.delete(id);
        launch(ships[id], mars, earth, ev.date, "earth");
      }
    }
  }
  // Finish manufacturing/arrival bookkeeping out to the sim end (so late-sim
  // queries see the final pool state). Leg history already covers queries.
  drainManufacturing(simEnd.getTime());
  drainArrivals(simEnd.getTime());

  return makeFleet(ships, { emWindows, meWindows, simStart, simEnd, cfg });
}

// ---------------------------------------------------------------------------
// Queryable fleet view (derived from each ship's leg history)
// ---------------------------------------------------------------------------

function makeFleet(ships, meta) {
  /** Location of a ship at a date: status + (if transiting) its active leg. */
  const stateOf = (ship, ms) => {
    if (ms < ship.manufactureDate.getTime()) return { status: "none" };
    if (ship.retiredDate && ms >= ship.retiredDate.getTime()) return { status: "retired" };
    // Active leg?
    for (const leg of ship.legs) {
      if (ms >= leg.departureDate.getTime() && ms < leg.arrivalDate.getTime()) {
        return { status: leg.to === "mars" ? "transit_to_mars" : "transit_to_earth", leg };
      }
    }
    // Between legs: at the destination of the most recent completed leg, else Earth.
    let loc = "earth";
    for (const leg of ship.legs) {
      if (leg.arrivalDate.getTime() <= ms) loc = leg.to;
    }
    return { status: loc };
  };

  return {
    ships,
    ...meta,

    /** Ships mid-flight at `date`, with fraction complete (for rendering/links). */
    shipsInTransitAt(date) {
      const ms = date.getTime();
      const out = [];
      for (const ship of ships) {
        const st = stateOf(ship, ms);
        if (st.status === "transit_to_mars" || st.status === "transit_to_earth") {
          const leg = st.leg;
          const frac = (ms - leg.departureDate.getTime()) / (leg.arrivalDate.getTime() - leg.departureDate.getTime());
          out.push({ shipId: ship.id, status: st.status, direction: leg.dir, leg, transfer: leg.transfer, fraction: frac });
        }
      }
      return out;
    },

    /** Population counts at `date`. */
    poolCountsAt(date) {
      const ms = date.getTime();
      const c = { onEarth: 0, onMars: 0, transitToMars: 0, transitToEarth: 0, retired: 0, total: 0 };
      for (const ship of ships) {
        const st = stateOf(ship, ms);
        switch (st.status) {
          case "earth": c.onEarth++; c.total++; break;
          case "mars": c.onMars++; c.total++; break;
          case "transit_to_mars": c.transitToMars++; c.total++; break;
          case "transit_to_earth": c.transitToEarth++; c.total++; break;
          case "retired": c.retired++; c.total++; break;
          default: break; // not yet manufactured
        }
      }
      return c;
    },
  };
}
