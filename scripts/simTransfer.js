// simTransfer.js
//
// Interplanetary transfer flights for the fleet / spacecraft-link simulation.
//
// This wraps the *local* (no-server) transfer model already used by the
// deployment report — the "Hohmann Level 2+3" refined solver
// (`computeHohmannRefined` in hohmannTransfer.js) — and turns each transfer
// into a PROPAGATABLE Keplerian orbit so a ship can be positioned at any
// instant with the same `helioCoords` the planets and satellites use.
//
// It also provides a purely-local departure-window finder: real Earth↔Mars
// opportunities are located by driving the Hohmann phasing error to zero on
// the true ephemeris (no lookup table, no phase-angle constant), which also
// captures the ~15-yr favourable/unfavourable variation from Mars's e=0.093.
//
// Conventions: lengths AU, times ms-since-Unix-epoch (via Date), ΔV km/s.
// The transfer solver is intentionally swappable: every consumer goes through
// `solveTransfer()` / `shipPositionAt()`, so a true position-to-position
// Lambert (local or the nyx API) can replace the refined-Hohmann internals
// without touching the fleet, topology, or UI layers.

import { SIM_CONSTANTS } from "./simConstants.js?v=4.31";
import { helioCoords } from "./simOrbits.js?v=4.31";
import { hohmannGeometry, hohmannEllipsePoints, computeHohmannRefined } from "./hohmannTransfer.js?v=4.31";

const MS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;
const AU_KM = SIM_CONSTANTS.AU_IN_KM;
const MU_SUN = SIM_CONSTANTS.MU_SUN_KM3_S2; // km^3/s^2
const JD_UNIX = SIM_CONSTANTS.JULIAN_DAY_UNIX_EPOCH;
const DEG = Math.PI / 180;

// Mean Earth↔Mars synodic period (days). Used only to step the window finder
// from one opportunity neighbourhood to the next; the actual window date is
// found by root-finding the phasing error, so this is just a stride.
export const SYNODIC_PERIOD_DAYS = 779.94;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function jdFromDate(date) {
  return JD_UNIX + date.getTime() / MS_PER_DAY;
}

/** In-plane heliocentric longitude (deg, 0–360) of an element set at a date. */
function helioLongitudeDeg(ele, date) {
  const p = helioCoords(ele, date);
  return ((Math.atan2(p.y, p.x) / DEG) % 360 + 360) % 360;
}

/** Wrap an angle (deg) to the signed range (-180, 180]. */
function wrap180(deg) {
  return ((deg % 360) + 540) % 360 - 180;
}

/** Mean motion (deg/day) of an orbit with semi-major axis a (AU). */
function meanMotionDegPerDay(a_AU) {
  const a_km = a_AU * AU_KM;
  const periodSec = 2 * Math.PI * Math.sqrt((a_km * a_km * a_km) / MU_SUN);
  return (360 * SECONDS_PER_DAY) / periodSec;
}

// ---------------------------------------------------------------------------
// Build a propagatable transfer orbit
// ---------------------------------------------------------------------------

/**
 * Convert the raw transfer ellipse from `hohmannEllipsePoints` (a, e, i, o, p)
 * into a full marslink element set { a, e, i, o, p, n, l, Dele } that
 * `helioCoords` can propagate, anchored so the ship is at the departure end of
 * the arc at `departureDate`.
 *
 * Outbound (r2 ≥ r1): departure at periapsis  → mean anomaly M0 = 0°.
 * Inbound  (r2 < r1): departure at apoapsis   → mean anomaly M0 = 180°.
 *
 * helioCoords computes M = n·(JD − Dele) + (l − p); at the departure epoch
 * (JD = Dele) that is l − p, so we set l = p + M0 to place the ship correctly.
 */
function buildPropagatableElements(rawEle, departureDate, outbound) {
  const M0 = outbound ? 0 : 180;
  return {
    a: rawEle.a,
    e: rawEle.e,
    i: rawEle.i || 0,
    o: rawEle.o || 0,
    p: rawEle.p,
    n: meanMotionDegPerDay(rawEle.a),
    l: ((rawEle.p + M0) % 360 + 360) % 360,
    Dele: jdFromDate(departureDate),
  };
}

// ---------------------------------------------------------------------------
// Solve a single transfer (departure date fixed)
// ---------------------------------------------------------------------------

/**
 * Solve one transfer leg departing `originEle`'s body at `departureDate`,
 * targeting `destEle`'s body, using the local refined-Hohmann model.
 *
 * @param {Object} originEle - departure body's orbital elements (marslink format)
 * @param {Object} destEle   - destination body's orbital elements
 * @param {Date}   departureDate
 * @returns {{
 *   departureDate: Date, arrivalDate: Date, tofDays: number,
 *   dv1: number, dv2: number, totalDv: number,
 *   r1: number, r2: number, outbound: boolean,
 *   elements: Object   // propagatable transfer orbit for helioCoords()
 * }}
 */
export function solveTransfer(originEle, destEle, departureDate) {
  // Local refined-Hohmann: ΔV (with optimal plane-change split) + arrival epoch.
  const refined = computeHohmannRefined(originEle, destEle, departureDate);
  const arrivalDate = new Date(refined.output.arrival_epoch);
  const tofDays = refined.output.transfer_time_days;
  const dv = refined.overrideDeltaV; // { dv1, dv2, totalDv }

  // Build the propagatable transfer ellipse from the departure geometry.
  const dep = helioCoords(originEle, departureDate);
  const r1 = Math.hypot(dep.x, dep.y);
  const r2 = destEle.a;
  const geom = hohmannGeometry(r1, r2);
  const ell = hohmannEllipsePoints({ x: dep.x, y: dep.y }, r1, r2);
  const elements = buildPropagatableElements(ell.transferElements, departureDate, geom.outbound);

  return {
    departureDate,
    arrivalDate,
    tofDays,
    dv1: dv.dv1,
    dv2: dv.dv2,
    totalDv: dv.totalDv,
    r1,
    r2,
    outbound: geom.outbound,
    elements,
  };
}

/**
 * Heliocentric position (AU) of a ship on a solved transfer at `date`.
 * The date is clamped to [departureDate, arrivalDate] so the ship stays put at
 * the endpoints rather than continuing around the transfer ellipse (it has
 * captured at the destination / not yet launched).
 *
 * @param {ReturnType<typeof solveTransfer>} transfer
 * @param {Date} date
 * @returns {{ x:number, y:number, z:number, clamped: ("pre"|"post"|null) }}
 */
export function shipPositionAt(transfer, date) {
  const t = date.getTime();
  const dep = transfer.departureDate.getTime();
  const arr = transfer.arrivalDate.getTime();
  let clamped = null;
  let useT = t;
  if (t <= dep) { useT = dep; clamped = "pre"; }
  else if (t >= arr) { useT = arr; clamped = "post"; }
  const pos = helioCoords(transfer.elements, new Date(useT));
  return { x: pos.x, y: pos.y, z: pos.z, clamped };
}

// ---------------------------------------------------------------------------
// Departure-window finder (purely local)
// ---------------------------------------------------------------------------

/**
 * Hohmann phasing error (deg, signed) for a departure at `departureDate`:
 * the angular gap between where the Hohmann arc arrives (180° around from the
 * departure longitude, at the destination radius) and where the destination
 * body actually is at the arrival epoch. Zero ⇒ a real opportunity.
 */
export function phasingErrorDeg(originEle, destEle, departureDate) {
  const dep = helioCoords(originEle, departureDate);
  const depLon = ((Math.atan2(dep.y, dep.x) / DEG) % 360 + 360) % 360;
  const r1 = Math.hypot(dep.x, dep.y);
  const r2 = destEle.a;
  const geom = hohmannGeometry(r1, r2);
  const arrivalDate = new Date(departureDate.getTime() + geom.transferTimeDays * MS_PER_DAY);
  // The half-ellipse arrives 180° around from departure (outbound or inbound).
  const arriveLon = (depLon + 180) % 360;
  const destLon = helioLongitudeDeg(destEle, arrivalDate);
  return wrap180(destLon - arriveLon);
}

/**
 * Find Earth↔Mars departure opportunities in [fromDate, toDate] by detecting
 * sign changes of the phasing error and bisecting each to the zero crossing.
 * Returns the window-centre dates (ascending) for departures from `originEle`'s
 * body to `destEle`'s body. Works for both directions (swap the arguments).
 *
 * @param {Object} originEle
 * @param {Object} destEle
 * @param {Date} fromDate
 * @param {Date} toDate
 * @param {number} [coarseStepDays=10]
 * @returns {Date[]}
 */
export function findDepartureWindows(originEle, destEle, fromDate, toDate, coarseStepDays = 10) {
  const windows = [];
  const stepMs = coarseStepDays * MS_PER_DAY;
  let prevT = fromDate.getTime();
  let prevErr = phasingErrorDeg(originEle, destEle, new Date(prevT));
  for (let t = prevT + stepMs; t <= toDate.getTime(); t += stepMs) {
    const err = phasingErrorDeg(originEle, destEle, new Date(t));
    // A real crossing is the descending one through 0 within a small band
    // (the error also jumps ±360 elsewhere; ignore those large jumps).
    if (prevErr <= 0 && err > 0 && Math.abs(err - prevErr) < 180) {
      windows.push(new Date(bisectZero(originEle, destEle, prevT, t)));
    } else if (prevErr > 0 && err <= 0 && Math.abs(err - prevErr) < 180) {
      windows.push(new Date(bisectZero(originEle, destEle, prevT, t)));
    }
    prevT = t;
    prevErr = err;
  }
  return windows;
}

/** Bisection on phasingErrorDeg between two epochs bracketing a sign change. */
function bisectZero(originEle, destEle, tLoMs, tHiMs) {
  let lo = tLoMs, hi = tHiMs;
  let fLo = phasingErrorDeg(originEle, destEle, new Date(lo));
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    const fMid = phasingErrorDeg(originEle, destEle, new Date(mid));
    if (Math.abs(fMid) < 1e-4 || (hi - lo) < MS_PER_DAY * 0.01) return mid;
    if ((fLo <= 0 && fMid <= 0) || (fLo > 0 && fMid > 0)) { lo = mid; fLo = fMid; }
    else { hi = mid; }
  }
  return (lo + hi) / 2;
}

/**
 * Refine a window centre to the minimum-ΔV departure date within ±halfWidthDays
 * of `centreDate`, by sampling the local refined-Hohmann ΔV. Returns the best
 * solved transfer. Useful because the energetically-cheapest departure is a few
 * days off the pure phasing-zero date (Earth/Mars eccentricity).
 */
export function refineWindowToMinDv(originEle, destEle, centreDate, halfWidthDays = 20, stepDays = 1) {
  let best = null;
  for (let d = -halfWidthDays; d <= halfWidthDays; d += stepDays) {
    const dep = new Date(centreDate.getTime() + d * MS_PER_DAY);
    const t = solveTransfer(originEle, destEle, dep);
    if (!best || t.totalDv < best.totalDv) best = t;
  }
  return best;
}
