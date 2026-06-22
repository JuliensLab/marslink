/***********************************************
 * simStationKeeping.js
 *
 * Station-keeping acceleration field from planetary gravity.
 * A co-orbital relay satellite rides the Sun's orbit, so solar gravity is
 * (radially) balanced; what it must thrust against is the perturbing gravity
 * of the nearby massive bodies. We account for Earth, Mars and Jupiter
 * (Jupiter is the dominant external perturber and sets the far-field floor).
 *
 *   a(point) = | Σ_b  -G·M_b · (point - r_b) / |point - r_b|³ |     [m/s²]
 *
 * Positions are heliocentric AU; the returned acceleration is in m/s².
 * Used to colour satellites by station-keeping cost and to draw iso-thrust
 * zones in the 2D view.
 ***********************************************/

const AU_M = 149597870700; // 1 AU in metres

// Standard gravitational parameters G·M (m³/s²)
export const BODY_GM = {
  Earth: 3.986004418e14,
  Mars: 4.282837e13,
  Jupiter: 1.26686534e17,
};

// Full G·M table (m³/s²) including the Sun, for the user-selectable iso-thrust
// field in the 2D view. The Sun is NOT in BODY_GM (the satellite station-keeping
// colouring excludes it — a co-orbital relay already balances solar gravity).
export const GM = {
  Sun: 1.32712440018e20,
  Venus: 3.24859e14,
  Earth: 3.986004418e14,
  Mars: 4.282837e13,
  Jupiter: 1.26686534e17,
};

// Log colour range (m/s²): A_MIN ~ Jupiter far-field floor in the Earth–Mars
// zone; A_MAX ~ a few million km from a planet (where SK becomes unaffordable).
export const A_MIN = 1e-7;
export const A_MAX = 1e-3;

// Number of discrete bins for the 3D (instanced) palette.
export const THRUST_BINS = 8;

/**
 * Net station-keeping acceleration at a heliocentric point (AU), summing the
 * gravitational pull of Earth, Mars and Jupiter as vectors.
 * @param {{x:number,y:number,z?:number}} point - position in AU
 * @param {Object} bodyPositions - { Earth:{x,y,z?}, Mars:{...}, Jupiter:{...} } in AU
 * @returns {number} acceleration magnitude in m/s²
 */
export function stationKeepingAccel(point, bodyPositions) {
  if (!point || !bodyPositions) return 0;
  let ax = 0, ay = 0, az = 0;
  for (const name in BODY_GM) {
    const b = bodyPositions[name];
    if (!b) continue;
    const dx = (point.x - b.x) * AU_M;
    const dy = (point.y - b.y) * AU_M;
    const dz = ((point.z || 0) - (b.z || 0)) * AU_M;
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 < 1) continue; // avoid singularity at the body itself
    const r = Math.sqrt(r2);
    const g = BODY_GM[name] / r2; // magnitude toward the body
    ax -= g * dx / r;
    ay -= g * dy / r;
    az -= g * dz / r;
  }
  return Math.sqrt(ax * ax + ay * ay + az * az);
}

/** Map an acceleration (m/s²) to t ∈ [0,1] on a log scale. */
export function thrustT(a) {
  if (!(a > A_MIN)) return 0;
  if (a >= A_MAX) return 1;
  return (Math.log10(a) - Math.log10(A_MIN)) / (Math.log10(A_MAX) - Math.log10(A_MIN));
}

/** Gradient colour for t ∈ [0,1]: green (cheap) → yellow → red (expensive). Returns a hex int. */
export function thrustHexForT(t) {
  const r = Math.round(255 * Math.min(1, t * 2));
  const g = Math.round(255 * Math.min(1, (1 - t) * 2));
  return (r << 16) | (g << 8) | 0;
}

/** Continuous CSS colour string for a 2D satellite at acceleration a. */
export function thrustColorRGB(a) {
  const t = thrustT(a);
  const r = Math.round(255 * Math.min(1, t * 2));
  const g = Math.round(255 * Math.min(1, (1 - t) * 2));
  return `rgb(${r},${g},0)`;
}

/** Discrete bin index in [0, nLevels-1] for acceleration a (log scale). */
export function thrustBinIndex(a, nLevels) {
  const t = thrustT(a);
  return Math.max(0, Math.min(nLevels - 1, Math.floor(t * nLevels)));
}

// ---- Satellite mass/thrust colour schemes (Accel / Thrust / Thrust% / Time) ----
export const G0 = 9.80665;                 // m/s²
export const SECONDS_PER_YEAR = 31557600;  // Julian year
export const F_MIN = 1e-4, F_MAX = 1;      // thrust-required colour range, N (0.1–1000 mN)
export const T_MIN = 1, T_MAX = 100;       // time-available colour range, years
export const M_MIN = 1000, M_MAX = 1500;   // satellite-mass colour range, kg
export const OVER_BUDGET_HEX = 0xff00ff;   // >100% of available thrust — distinct
export const OVER_BUDGET_RGB = "rgb(255,0,255)";

export const THRUST_SCHEMES = ["Accel", "Thrust", "Thrust%", "Thrusters", "Time", "Mass", "Lasers", "SKprop", "Totprop"];
export function isThrustScheme(mode) {
  return THRUST_SCHEMES.indexOf(mode) !== -1;
}

function logFrac(v, lo, hi) {
  if (!(v > lo)) return 0;
  if (v >= hi) return 1;
  return (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
}

/**
 * Colour fraction t∈[0,1] (green→amber→red) + over-budget flag for a satellite
 * colour scheme.
 * @param {string} scheme - "Accel" | "Thrust" | "Thrust%" | "Time"
 * @param {Object} ctx - { a (m/s²), m (kg = dry + SK propellant), skProp (kg),
 *                         favail (N, available thrust), isp (s) }
 */
export function satSchemeT(scheme, ctx) {
  const a = ctx.a || 0;
  if (scheme === "Accel") return { t: thrustT(a), over: false };
  if (scheme === "Thrust") return { t: logFrac(ctx.m * a, F_MIN, F_MAX), over: false };
  if (scheme === "Thrust%") {
    const frac = ctx.favail > 0 ? (ctx.m * a) / ctx.favail : Infinity;
    if (frac > 1) return { t: 1, over: true };
    return { t: frac, over: false }; // 0..1 linear, green→red
  }
  if (scheme === "Time") {
    // Rocket equation: years to cancel a until SK propellant is spent.
    // T = (Isp·g0/a)·ln(m / mThr), mThr = m − skProp (mass once SK prop is gone).
    const mThr = ctx.m - (ctx.skProp || 0);
    const yr = (a > 0 && mThr > 0) ? ((ctx.isp * G0) / a) * Math.log(ctx.m / mThr) / SECONDS_PER_YEAR : Infinity;
    return { t: 1 - logFrac(yr, T_MIN, T_MAX), over: false }; // more time = greener
  }
  if (scheme === "Mass") {
    const t = (ctx.m - M_MIN) / (M_MAX - M_MIN);
    return { t: Math.max(0, Math.min(1, t)), over: false }; // light (low) → heavy (high)
  }
  if (scheme === "Thrusters") {
    const nMax = ctx.nMax || 1;
    const t = nMax > 1 ? Math.log(ctx.n || 1) / Math.log(nMax) : 0; // log scale: 1 → green, fleet-max → red
    return { t: Math.max(0, Math.min(1, t)), over: false };
  }
  if (scheme === "Lasers") {
    const pMax = ctx.lasersMax || 1;
    const t = pMax > 1 ? Math.log(ctx.ports || 1) / Math.log(pMax) : 0; // log scale: few → green, fleet-max → red
    return { t: Math.max(0, Math.min(1, t)), over: false };
  }
  if (scheme === "SKprop" || scheme === "Totprop") {
    const cap = ctx.capacity || 1500;
    const kg = scheme === "SKprop" ? (ctx.skProp || 0) : (ctx.totProp != null ? ctx.totProp : (ctx.nonSkFuel || 0) + (ctx.skProp || 0));
    const t = cap > 1 ? Math.log(Math.max(1, kg)) / Math.log(cap) : 0; // log scale: light → green, full tank → red
    return { t: Math.max(0, Math.min(1, t)), over: false };
  }
  return { t: 0, over: false };
}

/** CSS rgb() for colour fraction t (shared green→amber→red ramp). */
export function rampRGB(t) {
  const r = Math.round(255 * Math.min(1, t * 2));
  const g = Math.round(255 * Math.min(1, (1 - t) * 2));
  return `rgb(${r},${g},0)`;
}
/** Hex int for colour fraction t. */
export function rampHex(t) {
  const r = Math.round(255 * Math.min(1, t * 2));
  const g = Math.round(255 * Math.min(1, (1 - t) * 2));
  return (r << 16) | (g << 8) | 0;
}

/**
 * Number of thrusters so total thrust N·fThruster exceeds the station-keeping
 * requirement m·a, accounting for the mass each thruster adds:
 *   N·fThruster > (m0 + N·mThruster)·a  ⟹  N = ⌈ m0·a / (fThruster − mThruster·a) ⌉.
 * If a thruster can't outpace its own added requirement (fThruster ≤ mThruster·a),
 * no count suffices → returns maxN.
 * @param {number} m0 - base mass (dry + SK propellant), kg
 */
export function autoThrusterCount(m0, a, fThruster, mThruster, maxN = 64) {
  if (!(a > 0) || !(fThruster > 0)) return 1;
  const denom = fThruster - mThruster * a;
  if (denom <= 0) return maxN;
  return Math.max(1, Math.min(maxN, Math.ceil((m0 * a) / denom)));
}

/**
 * SK propellant (kg) to continuously cancel acceleration a for n years, via the
 * rocket equation: Δv = a·n·yr = Isp·g0·ln(m0/mThr) with m0 = mThr + skProp, so
 *   skProp = mThr·(exp(Δv/(Isp·g0)) − 1).
 * The exponential (not the linear Δv·mThr/(Isp·g0)) accounts for the propellant's
 * OWN mass — otherwise the heavier loaded vehicle exhausts it before n years.
 * @param {number} mThr - dry mass once SK propellant is spent (bus + thrusters), kg
 */
export function skPropForYears(mThr, a, cfg) {
  if (!(a > 0)) return 0;
  return mThr * (Math.exp((a * cfg.n * SECONDS_PER_YEAR) / (cfg.isp * G0)) - 1);
}

/**
 * Per-ring baseline: thruster count + n-year SK propellant from the ring's AVERAGE
 * station-keeping acceleration. cfg = { F (N), tm (kg), maxN, n (yr), isp (s),
 * capacity (kg) }. Returns { nRing, skPropRing, aThreshold } where aThreshold is
 * the acceleration above which a sat's thrust need exceeds the ring's N thrusters.
 */
export function ringBaseline(aAvg, dry, cfg) {
  const N = autoThrusterCount(dry, aAvg, cfg.F, cfg.tm, cfg.maxN);
  const mThr = dry + N * cfg.tm;
  const skProp = skPropForYears(mThr, aAvg, cfg);
  const aThreshold = mThr > 0 ? (N * cfg.F) / mThr : Infinity;
  return { nRing: N, skPropRing: skProp, aThreshold };
}

/**
 * Per-satellite station-keeping sizing → { N, skProp, m }. Planetary-ring sats
 * whose a exceeds the ring threshold get individually-sized thrusters (capped at
 * cfg.maxN) and n-year propellant (capped at cfg.capacity); every other sat uses
 * the ring baseline. m = dry + N·tm + skProp.
 * @param {{nRing:number, skPropRing:number, aThreshold:number}} ring - baseline
 */
export function satStationKeeping(a, dry, ring, isPlanetary, cfg) {
  let N, skProp;
  if (isPlanetary) {
    // Planetary rings: EVERY sat is sized to its OWN a (not the ring average) — its
    // own thruster count (≥ ring baseline, refined above the threshold) and its own
    // n-year propellant, capped at what the tank leaves after transfer/deorbit.
    N = a > ring.aThreshold ? autoThrusterCount(dry, a, cfg.F, cfg.tm, cfg.maxN) : ring.nRing;
    const mThr = dry + N * cfg.tm;
    const cap = ring.capAvailable != null ? ring.capAvailable : cfg.capacity; // capacity − other prop
    skProp = Math.min(skPropForYears(mThr, a, cfg), cap);
  } else {
    N = ring.nRing;
    skProp = ring.skPropRing;
  }
  return { N, skProp, m: dry + N * cfg.tm + skProp };
}

/**
 * Total propellant on board (kg) for one satellite.
 *  - Planetary rings (Earth/Mars): PER-SAT. Transfer+deorbit propellant scales with
 *    THIS sat's mass, which includes its own skProp, so total = skProp + (dry+skProp)·k,
 *    where k = nonSkFuel/(dry+skPropRing) is the ring's transfer+deorbit propellant
 *    factor. Capped sats converge to ~capacity (consistent with capAvailable).
 *  - Other rings: PER-RING. skProp + nonSkFuel = the deployment's propellantLoaded.
 */
export function satTotalProp(ring, skProp, isPlanetary) {
  const nonSk = ring.nonSkFuel || 0;
  if (!isPlanetary) return skProp + nonSk;
  const k = nonSk / Math.max(1, ring.dryMass + (ring.skPropRing || 0));
  return skProp + (ring.dryMass + skProp) * k;
}

/**
 * Log-spaced iso-thrust contour levels (m/s²) between A_MIN and A_MAX.
 * Returns n interior levels (endpoints excluded) — i.e. n zone boundaries.
 */
export function thrustContourLevels(n) {
  const levels = [];
  const lnMin = Math.log10(A_MIN);
  const lnMax = Math.log10(A_MAX);
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    levels.push(Math.pow(10, lnMin + t * (lnMax - lnMin)));
  }
  return levels;
}

/**
 * Sample the combined gravitational acceleration magnitude (m/s²) on a regular
 * grid in the ecliptic plane (z = 0), summing only the bodies named in
 * `gmByName`. Fills `out[j*nx + i]` for the point (x0 + i*dx, y0 + j*dy).
 * Inlined (no per-sample allocation) for speed.
 * @param {Float32Array} out - destination, length nx*ny
 * @param {Object} bodyPositions - { name: {x,y,z?} } in AU (must cover gmByName)
 * @param {Object} gmByName - { name: G·M } for the bodies to include
 */
export function sampleThrustField(out, nx, ny, x0, y0, dx, dy, bodyPositions, gmByName) {
  const names = Object.keys(gmByName);
  const nb = names.length;
  for (let j = 0; j < ny; j++) {
    const py = y0 + j * dy;
    const rowBase = j * nx;
    for (let i = 0; i < nx; i++) {
      const px = x0 + i * dx;
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < nb; k++) {
        const b = bodyPositions[names[k]];
        if (!b) continue;
        const ddx = (px - b.x) * AU_M;
        const ddy = (py - b.y) * AU_M;
        const ddz = (0 - (b.z || 0)) * AU_M;
        const r2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (r2 < 1) continue;
        const r = Math.sqrt(r2);
        const g = gmByName[names[k]] / r2;
        ax -= g * ddx / r;
        ay -= g * ddy / r;
        az -= g * ddz / r;
      }
      out[rowBase + i] = Math.sqrt(ax * ax + ay * ay + az * az);
    }
  }
}

/**
 * Marching-squares iso-contour for a scalar field on a regular grid. Appends
 * line segments as flat [ax, ay, bx, by, ...] (in the field's x/y units) to
 * `segs` for the iso-line at `level`. Ambiguous saddle cases emit two segments.
 */
export function marchingSquares(field, nx, ny, x0, y0, dx, dy, level, segs) {
  for (let j = 0; j < ny - 1; j++) {
    const base = j * nx;
    for (let i = 0; i < nx - 1; i++) {
      const v0 = field[base + i];          // bottom-left  (xL, yB)
      const v1 = field[base + i + 1];      // bottom-right (xR, yB)
      const v2 = field[base + nx + i + 1]; // top-right    (xR, yT)
      const v3 = field[base + nx + i];     // top-left     (xL, yT)
      let cse = 0;
      if (v0 > level) cse |= 1;
      if (v1 > level) cse |= 2;
      if (v2 > level) cse |= 4;
      if (v3 > level) cse |= 8;
      if (cse === 0 || cse === 15) continue;
      const xL = x0 + i * dx, xR = xL + dx, yB = y0 + j * dy, yT = yB + dy;
      const bX = xL + dx * (level - v0) / (v1 - v0); // bottom edge crossing x
      const rY = yB + dy * (level - v1) / (v2 - v1); // right edge crossing y
      const tX = xL + dx * (level - v3) / (v2 - v3); // top edge crossing x
      const lY = yB + dy * (level - v0) / (v3 - v0); // left edge crossing y
      switch (cse) {
        case 1: case 14: segs.push(xL, lY, bX, yB); break;
        case 2: case 13: segs.push(bX, yB, xR, rY); break;
        case 3: case 12: segs.push(xL, lY, xR, rY); break;
        case 4: case 11: segs.push(xR, rY, tX, yT); break;
        case 6: case 9:  segs.push(bX, yB, tX, yT); break;
        case 7: case 8:  segs.push(xL, lY, tX, yT); break;
        case 5:  segs.push(xL, lY, bX, yB, xR, rY, tX, yT); break;
        case 10: segs.push(bX, yB, xR, rY, xL, lY, tX, yT); break;
      }
    }
  }
}
