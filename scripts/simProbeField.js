// simProbeField.js
//
// Monte-Carlo coverage field (Feature B) — the alternative to the spacecraft-
// flight overlay (Feature A, simFlightController). Instead of a fleet flying
// transfer orbits, this scatters N independent "probe" spacecraft uniformly
// through the heliocentric volume where a spacecraft could plausibly be:
//   • radially  — between Earth's and Mars's orbits (their true per-angle conic
//                 bounds; the orbits never cross, so Earth is always the inner
//                 bound and Mars the outer);
//   • vertically — in the wedge between the ecliptic and Mars's orbital plane
//                 (the two inclinations).
//
// Each probe is then measured as if it were the ONLY client present: probes do
// not compete for laser ports and never relay one another. "Available port" =
// a port the backbone topology did not consume. Per probe we find the nearest
// backbone node (Earth, Mars, or a relay sat) that still has a spare port and is
// within laser range, then compose that single access hop with the backbone's
// best path to each planet (widest-path capacity / shortest-latency), reusing
// the same machinery the flight overlay uses (simShipLinks).
//
// Pure geometry/graph logic; seeded RNG keeps a given (count, seed) reproducible.

import { extractRootedBackbone, computeBackboneReach } from "./simShipLinks.js?v=4.35";

const DEG = Math.PI / 180;

// Deterministic PRNG (mulberry32) so a given (count, seed) always yields the
// same cloud — required for reproducible coverage figures.
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Heliocentric distance of a Keplerian orbit at ecliptic true-longitude θ (rad):
//   r(θ) = a(1−e²) / (1 + e·cos(θ − ϖ)),  ϖ = longitude of perihelion (ele.p).
// (The small cos(i) ecliptic-projection factor is neglected — this defines a
// sampling volume, not an exact orbit; Mars's i ≈ 1.85° makes it < 0.1%.)
function orbitRadiusAt(ele, thetaRad) {
  const e = ele.e || 0;
  const varpi = (ele.p || 0) * DEG;
  return (ele.a * (1 - e * e)) / (1 + e * Math.cos(thetaRad - varpi));
}

/**
 * Sample `count` points uniformly in the Earth↔Mars volume. Area-uniform in the
 * radial annulus (so density doesn't pile up near the inner orbit) and uniform
 * across the inclination wedge. Returns AU heliocentric ecliptic {x,y,z}.
 *
 * @param {Object} p
 * @param {Object} p.earth  Earth element object {a,e,i,p,o,...} (from simSatellites.getEarth)
 * @param {Object} p.mars   Mars  element object {a,e,i,p,o,...}
 * @param {number} p.count  number of probe points
 * @param {number} [p.seed=1]
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function sampleProbeVolume({ earth, mars, count, seed = 1 }) {
  if (!earth || !mars || !(count > 0)) return [];
  const rng = mulberry32(seed);
  const tanIMars = Math.tan((mars.i || 0) * DEG);
  const omegaMars = (mars.o || 0) * DEG; // longitude of ascending node Ω
  const points = [];
  for (let k = 0; k < count; k++) {
    const theta = rng() * 2 * Math.PI;
    const rIn = orbitRadiusAt(earth, theta);
    const rOut = orbitRadiusAt(mars, theta);
    const lo = Math.min(rIn, rOut), hi = Math.max(rIn, rOut);
    // Area-uniform radius between the two conic bounds: ρ = √(lo² + u(hi²−lo²)).
    const rho = Math.sqrt(lo * lo + rng() * (hi * hi - lo * lo));
    // Inclination wedge: Mars-plane height at (ρ,θ) is signed (→0 at the nodes);
    // z = f·z_max, f~U[0,1] fills the wedge between the ecliptic and that plane.
    const zMax = rho * tanIMars * Math.sin(theta - omegaMars);
    const z = rng() * zMax;
    points.push({ x: rho * Math.cos(theta), y: rho * Math.sin(theta), z });
  }
  return points;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Measure every probe independently against the current relay backbone. Each
 * probe attaches to the NEAREST rooted backbone node (Earth, Mars, or a relay
 * sat with a spare laser port) within laser range; probes neither consume ports
 * nor see one another. End-to-end capacity/latency to Earth and Mars = the
 * single access hop composed with the backbone's best path from that root.
 *
 * A uniform spatial grid over the rooted nodes (cell = laser range) keeps the
 * nearest-node search local, so cost scales with local density, not N×R.
 *
 * @param {Object} p
 * @param {Array}  p.points         sampled probe positions (AU)
 * @param {Array}  p.planets        planet objects with .name/.position
 * @param {Array}  p.satellites     sat objects with .name/.ringName/.position
 * @param {Array}  p.possibleLinks  backbone links [{fromId,toId,latencySeconds,gbpsCapacity}]
 * @param {Object} p.simLinkBudget  link-budget instance
 * @param {(probePos,rootPos)=>boolean} [p.feasible]  extra test (e.g. not solar-blinded)
 * @returns {{ perProbe:Array, summary:{connected:number,unconnected:number,total:number} }}
 */
export function measureProbes({ points, planets, satellites, possibleLinks, simLinkBudget, feasible }) {
  const total = points ? points.length : 0;
  if (!total || !possibleLinks || !possibleLinks.length) {
    return {
      perProbe: (points || []).map((pt) => ({ x: pt.x, y: pt.y, z: pt.z, connected: false, rootId: null })),
      summary: { connected: 0, unconnected: total, total },
    };
  }

  const rooted = extractRootedBackbone({ planets, satellites, possibleLinks, simLinkBudget, planetPortBudget: 1e9 });
  const reach = computeBackboneReach(possibleLinks);
  const maxRange = simLinkBudget.maxDistanceAU || Infinity;
  const auToKm = (au) => simLinkBudget.convertAUtoKM(au);
  const get = (m, id) => (m && m.has(id) ? m.get(id) : undefined);

  // Spatial grid over rooted nodes with a spare port (only valid for finite range).
  const cell = isFinite(maxRange) && maxRange > 0 ? maxRange : 0;
  let grid = null;
  if (cell > 0) {
    grid = new Map();
    for (let idx = 0; idx < rooted.length; idx++) {
      const r = rooted[idx];
      if (r.freePorts <= 0) continue;
      const pos = r.position;
      const key = `${Math.floor(pos.x / cell)},${Math.floor(pos.y / cell)},${Math.floor(pos.z / cell)}`;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(idx);
    }
  }

  const consider = (pt, idx, state) => {
    const r = rooted[idx];
    if (r.freePorts <= 0) return;
    const d = dist(pt, r.position);
    if (d > maxRange) return;
    if (feasible && !feasible(pt, r.position)) return;
    if (d < state.bestD) { state.bestD = d; state.best = r; }
  };

  const perProbe = [];
  let connected = 0;
  for (const pt of points) {
    const state = { best: null, bestD: Infinity };
    if (grid) {
      const bx = Math.floor(pt.x / cell), by = Math.floor(pt.y / cell), bz = Math.floor(pt.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const arr = grid.get(`${bx + dx},${by + dy},${bz + dz}`);
            if (!arr) continue;
            for (const idx of arr) consider(pt, idx, state);
          }
        }
      }
    } else {
      for (let idx = 0; idx < rooted.length; idx++) consider(pt, idx, state);
    }

    if (!state.best) {
      perProbe.push({ x: pt.x, y: pt.y, z: pt.z, connected: false, rootId: null });
      continue;
    }

    const km = auToKm(state.bestD);
    const accessCap = simLinkBudget.calculateGbps(km);
    const accessLat = simLinkBudget.calculateLatencySeconds(km);
    const entry = {
      x: pt.x, y: pt.y, z: pt.z,
      connected: true,
      rootId: state.best.id,
      rootPos: state.best.position, // for drawing the access link
      accessDistAU: state.bestD,
      capacityGbps: accessCap,
      accessLatencySec: accessLat,
      capEarthGbps: 0, capMarsGbps: 0, latEarthSec: Infinity, latMarsSec: Infinity,
    };
    const bbLatE = get(reach.latEarth, state.best.id), bbLatM = get(reach.latMars, state.best.id);
    const bbCapE = get(reach.capEarth, state.best.id), bbCapM = get(reach.capMars, state.best.id);
    if (bbLatE !== undefined) entry.latEarthSec = accessLat + bbLatE;
    if (bbLatM !== undefined) entry.latMarsSec = accessLat + bbLatM;
    if (bbCapE !== undefined) entry.capEarthGbps = Math.min(accessCap, bbCapE);
    if (bbCapM !== undefined) entry.capMarsGbps = Math.min(accessCap, bbCapM);
    perProbe.push(entry);
    connected++;
  }

  return { perProbe, summary: { connected, unconnected: total - connected, total } };
}
