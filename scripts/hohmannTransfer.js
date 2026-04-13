// hohmannTransfer.js
//
// Launch scheduling (ramped + scrub-adjusted rate) and Hohmann transfer geometry
// used by the deployment report to compute per-flight launch dates, draw orbit
// charts, and visualise each deployment.
//
// All lengths are in AU, all times in milliseconds since Unix epoch, all rates
// in launches/day. The scheduling math is closed-form; no numerical root-find.

import { SIM_CONSTANTS } from "./simConstants.js?v=4.3";
import { helioCoords, positionFromSolarAngle } from "./simOrbits.js?v=4.3";

const MS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;
const AU_KM = SIM_CONSTANTS.AU_IN_KM;
const MU_SUN = SIM_CONSTANTS.MU_SUN_KM3_S2; // km^3/s^2

// ---------------------------------------------------------------------------
// Launch-rate model
// ---------------------------------------------------------------------------
//
//   r(t) = 0                                               for t < t_start
//   r(t) = r_max * (t - t_start) / (t_end - t_start)       for t_start ≤ t ≤ t_end
//   r(t) = r_max                                           for t > t_end
//
// where r_max = (24 / hoursBetweenFlights) * (1 - scrubFactor).
//
// Cumulative C(t) = ∫_{t_start}^{t} r(τ) dτ is a quadratic up to t_end then
// linear after. Its inverse C^{-1}(N) gives the date of launch #N.

/**
 * Build a schedule object that encapsulates the launch-rate model and lets you
 * query the date of the Nth launch.
 *
 * @param {Object} params
 * @param {number} params.startYear           - Year the ramp begins (Jan 1)
 * @param {number} params.rampEndYear         - Year the ramp reaches steady state (Dec 31)
 * @param {number} params.hoursBetweenFlights - Steady-state cadence in hours
 * @param {number} params.scrubFactorPct      - Scrub loss, 0-100
 */
export function createLaunchSchedule({ startYear, rampEndYear, hoursBetweenFlights, scrubFactorPct }) {
  const startDate = new Date(Date.UTC(startYear, 0, 1)); // Jan 1, startYear
  // ramp ends Jan 1 of (rampEndYear + 1), i.e. inclusive of the whole rampEndYear
  const rampEndDate = new Date(Date.UTC(rampEndYear + 1, 0, 1));
  const tStartDays = startDate.getTime() / MS_PER_DAY;
  const tEndDays = rampEndDate.getTime() / MS_PER_DAY;
  const rampDurationDays = Math.max(1e-9, tEndDays - tStartDays);

  const nominalRate = hoursBetweenFlights > 0 ? 24 / hoursBetweenFlights : 0;
  const scrub = Math.max(0, Math.min(1, scrubFactorPct / 100));
  const rMax = nominalRate * (1 - scrub); // effective launches/day at steady state

  // Total cumulative launches at the end of the ramp: (1/2) * r_max * rampDuration
  const rampTotal = 0.5 * rMax * rampDurationDays;

  return {
    startDate,
    rampEndDate,
    tStartDays,
    tEndDays,
    rampDurationDays,
    rMax,
    rampTotal,
    hoursBetweenFlights,
    scrubFactorPct,

    /**
     * Return the calendar Date for launch number N (1-based).
     * Returns null if rMax is zero (infinite launch date).
     */
    dateForLaunchNumber(N) {
      if (rMax <= 0) return null;
      if (N <= 0) return new Date(startDate.getTime());

      if (N <= rampTotal) {
        // On the ramp: solve (1/2) * (r_max / rampDuration) * Δt² = N  →  Δt = sqrt(2 N rampDuration / r_max)
        const dtDays = Math.sqrt((2 * N * rampDurationDays) / rMax);
        return new Date((tStartDays + dtDays) * MS_PER_DAY);
      } else {
        // Past the ramp: rampTotal launches used up, remainder at constant r_max
        const remainder = N - rampTotal;
        const dtDays = rampDurationDays + remainder / rMax;
        return new Date((tStartDays + dtDays) * MS_PER_DAY);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Heliocentric Cartesian state from marslink orbital elements
// ---------------------------------------------------------------------------

/**
 * Compute full heliocentric Cartesian state (position in km, velocity in km/s)
 * from marslink-style orbital elements at a given Date.
 *
 * @param {Object} ele - Marslink element object { a, e, i, o, p, l, n, Dele, ... }
 * @param {Date} date  - JavaScript Date for the computation
 * @returns {{ x_km, y_km, z_km, vx_km_s, vy_km_s, vz_km_s }}
 */
export function helioCartesianState(ele, date) {
  const DEG = Math.PI / 180;
  const JULIAN_DAY_UNIX_EPOCH = 2440587.5;
  const julianDay = JULIAN_DAY_UNIX_EPOCH + date.getTime() / 86400000;
  const D = julianDay - ele.Dele;
  const Cy = D / 36525;

  const a_au = ele.a + (ele.a_rate || 0) * Cy;
  const ecc = ele.e + (ele.e_rate || 0) * Cy;
  const inc = (ele.i + (ele.i_rate || 0) * Cy) * DEG;
  const pLon = (ele.p + (ele.p_rate || 0) * Cy) * DEG; // longitude of perihelion
  const omega = (ele.o + (ele.o_rate || 0) * Cy) * DEG; // RAAN
  const lMean = (ele.l + (ele.l_rate || 0) * Cy) * DEG; // mean longitude
  const argPeri = pLon - omega; // argument of periapsis

  // Mean anomaly
  let M = (ele.n * D * DEG + lMean - pLon);
  M = M % (2 * Math.PI);
  if (M < 0) M += 2 * Math.PI;

  // Kepler's equation → eccentric anomaly
  let E = M;
  for (let iter = 0; iter < 20; iter++) {
    const dE = (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }

  // True anomaly
  const nu = 2 * Math.atan2(
    Math.sqrt(1 + ecc) * Math.sin(E / 2),
    Math.sqrt(1 - ecc) * Math.cos(E / 2)
  );

  // Distance and speed in orbital plane
  const a_km = a_au * AU_KM;
  const p_km = a_km * (1 - ecc * ecc); // semi-latus rectum
  const r = p_km / (1 + ecc * Math.cos(nu));
  const mu = MU_SUN;

  // Position and velocity in perifocal frame
  const cosNu = Math.cos(nu), sinNu = Math.sin(nu);
  const r_pf_x = r * cosNu;
  const r_pf_y = r * sinNu;
  const sqrtMuP = Math.sqrt(mu / p_km);
  const v_pf_x = -sqrtMuP * sinNu;
  const v_pf_y = sqrtMuP * (ecc + cosNu);

  // Rotation: perifocal → ecliptic (3-1-3: Ω, i, ω)
  const cO = Math.cos(omega), sO = Math.sin(omega);
  const ci = Math.cos(inc), si = Math.sin(inc);
  const cw = Math.cos(argPeri), sw = Math.sin(argPeri);

  const r11 = cO * cw - sO * sw * ci;
  const r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci;
  const r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si;
  const r32 = cw * si;

  return {
    x_km: r11 * r_pf_x + r12 * r_pf_y,
    y_km: r21 * r_pf_x + r22 * r_pf_y,
    z_km: r31 * r_pf_x + r32 * r_pf_y,
    vx_km_s: r11 * v_pf_x + r12 * v_pf_y,
    vy_km_s: r21 * v_pf_x + r22 * v_pf_y,
    vz_km_s: r31 * v_pf_x + r32 * v_pf_y,
  };
}

// ---------------------------------------------------------------------------
// Lambert solver (nyx-space API)
// ---------------------------------------------------------------------------

const _lambertCache = new Map(); // key: "ringName:flightIdx" → { dv1, dv2, totalDv }

// Lambert API endpoint — local PHP proxy to nyx-space MCP platform.
const _lambertApiUrl = "api/nyx/lambert.php";

/**
 * Call the nyx-space Lambert solver API for a specific flight.
 * Uses the /api/nyx/lambert endpoint on the marslink-nyx server.
 * Returns { dv1, dv2, totalDv } in km/s. Results are cached in RAM.
 *
 * @param {Object} earthEle - Earth's orbital elements (marslink format)
 * @param {Object} targetEle - Target ring orbital elements (marslink format)
 * @param {Date} launchDate - Departure date
 * @param {Date} arrivalDate - Arrival date
 * @param {string} cacheKey - Unique key for caching (e.g. "ring_adapt_5:3")
 * @returns {Promise<{dv1: number, dv2: number, totalDv: number} | null>}
 */
export async function callLambertSolver(earthEle, targetEle, launchDate, arrivalDate, cacheKey) {
  if (_lambertCache.has(cacheKey)) {
    const cached = _lambertCache.get(cacheKey);
    // Preserve the legacy contract: callers see `null` on failure. Debug
    // info for failures is still accessible via getLambertDebugEntry().
    return cached && cached.error ? null : cached;
  }

  const departState = helioCartesianState(earthEle, launchDate);
  const arriveState = helioCartesianState(targetEle, arrivalDate);

  const departEpoch = launchDate.toISOString();
  const arriveEpoch = arrivalDate.toISOString();

  const requestBody = {
    initial_state: {
      epoch: departEpoch,
      x_km: departState.x_km, y_km: departState.y_km, z_km: departState.z_km,
      vx_km_s: departState.vx_km_s, vy_km_s: departState.vy_km_s, vz_km_s: departState.vz_km_s,
      center_object: 10, ref_frame: 1,
    },
    final_state: {
      epoch: arriveEpoch,
      x_km: arriveState.x_km, y_km: arriveState.y_km, z_km: arriveState.z_km,
      vx_km_s: arriveState.vx_km_s, vy_km_s: arriveState.vy_km_s, vz_km_s: arriveState.vz_km_s,
      center_object: 10, ref_frame: 1,
    },
  };

  try {
    const resp = await fetch(_lambertApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    console.log("[Lambert] raw response:", JSON.stringify(data).slice(0, 500));
    const r = data.result?.structuredContent ?? data.result?.content?.[0]?.text;
    const parsed = typeof r === "string" ? JSON.parse(r) : r;
    if (parsed?.v_init_x_km_s == null) {
      console.warn("[Lambert] parsed result missing v_init_x_km_s:", parsed);
      throw new Error("No lambert result");
    }

    // Delta-V = difference between Lambert solution velocity and actual orbital velocity
    const dv1 = Math.sqrt(
      (parsed.v_init_x_km_s - departState.vx_km_s) ** 2 +
      (parsed.v_init_y_km_s - departState.vy_km_s) ** 2 +
      (parsed.v_init_z_km_s - departState.vz_km_s) ** 2
    );
    const dv2 = Math.sqrt(
      (arriveState.vx_km_s - parsed.v_final_x_km_s) ** 2 +
      (arriveState.vy_km_s - parsed.v_final_y_km_s) ** 2 +
      (arriveState.vz_km_s - parsed.v_final_z_km_s) ** 2
    );

    const result = {
      dv1,
      dv2,
      totalDv: dv1 + dv2,
      debug: { request: requestBody, response: data, parsed },
    };
    _lambertCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`Lambert solver failed for ${cacheKey}:`, err.message);
    // Cache failures (with debug payload) to avoid retrying, while still
    // letting the UI inspect what was sent/received.
    const failure = {
      error: err.message,
      debug: { request: requestBody, response: null },
    };
    _lambertCache.set(cacheKey, failure);
    return null;
  }
}

/**
 * Expose the full cached Lambert entry (including debug request/response) for
 * a given cache key. Returns null if no entry exists.
 */
export function getLambertDebugEntry(cacheKey) {
  return _lambertCache.has(cacheKey) ? _lambertCache.get(cacheKey) : null;
}

/**
 * Build a debug payload for the local Hohmann calculation.
 *
 * Unlike the Lambert solver — which takes *both* endpoint states (epoch +
 * position + velocity) as genuine boundary conditions — a Hohmann transfer is
 * fully determined by just `(r1, r2, Δi)`. Everything else (transfer time,
 * arrival epoch, ΔVs, transfer-orbit elements) is a *result*.
 *
 * `input` therefore only lists the values the Hohmann math actually consumes:
 *   - the departure epoch (to evaluate r1 and Earth's heliocentric longitude)
 *   - r1 (Earth's heliocentric radius at that epoch)
 *   - r2 (the target ring's semi-major axis — Hohmann assumes circular orbits)
 *   - the inclination change (Δi)
 *   - the departure longitude (orients the transfer ellipse for the chart)
 *
 * `output` lists what the math produces: transfer-orbit elements, ΔVs, the
 * transfer time, and the resulting arrival epoch.
 *
 * @param {Object} earthEle  - Earth orbital elements (marslink format)
 * @param {Object} targetEle - Target ring orbital elements
 * @param {Date} launchDate  - Departure epoch (the one real time input)
 * @returns {{ input: Object, output: Object }}
 */
export function computeHohmannDebug(earthEle, targetEle, launchDate) {
  // --- Inputs Hohmann actually consumes ---
  const departState = helioCartesianState(earthEle, launchDate);
  const r1_AU = Math.sqrt(
    (departState.x_km / AU_KM) ** 2 +
    (departState.y_km / AU_KM) ** 2 +
    (departState.z_km / AU_KM) ** 2
  );
  // Target radius = semi-major axis of the target's orbit. Hohmann assumes
  // circular orbits, so the target's instantaneous position at arrival is
  // irrelevant to the ΔV math; only its mean radius matters.
  const r2_AU = targetEle?.a ?? 0;

  const earthIncl_deg = earthEle?.i || 0;
  const targetIncl_deg = targetEle?.i || 0;
  const deltaIncl_deg = Math.abs(earthIncl_deg - targetIncl_deg);

  // Earth's heliocentric longitude at launch (orients the transfer ellipse).
  const earthLongitude_deg = ((Math.atan2(departState.y_km, departState.x_km) * 180 / Math.PI) % 360 + 360) % 360;

  const input = {
    launch_epoch: launchDate.toISOString(),
    r1_AU,
    r2_AU,
    delta_inclination_deg: deltaIncl_deg,
    earth_heliocentric_longitude_deg: earthLongitude_deg,
    assumptions: "circular coplanar orbits; plane change performed at r1",
  };

  // --- Compute outputs ---
  const geom = hohmannGeometry(r1_AU, r2_AU);

  // Inclination change ΔV: ΔV_i = 2·v·sin(Δi/2) at the departure radius.
  const deltaI_rad = deltaIncl_deg * Math.PI / 180;
  const vAtDeparture_km = Math.sqrt(MU_SUN / (r1_AU * AU_KM));
  const dvIncl = 2 * vAtDeparture_km * Math.sin(deltaI_rad / 2);

  // Transfer-orbit Keplerian elements (same orientation logic as
  // hohmannEllipsePoints — used for the ϖ label in the chart).
  const peri_deg = geom.outbound
    ? earthLongitude_deg
    : ((earthLongitude_deg - 180) % 360 + 360) % 360;

  // Arrival epoch = launch epoch + transfer time (half the transfer ellipse's period).
  const arrivalDate = new Date(launchDate.getTime() + geom.transferTimeDays * 86400 * 1000);

  const output = {
    arrival_epoch: arrivalDate.toISOString(),
    transfer_time_days: geom.transferTimeDays,
    transferElements: {
      a_AU: geom.a,
      e: geom.e,
      peri_deg,
      i_deg: 0,
    },
    dv1_km_s: geom.dv1,
    dv2_km_s: geom.dv2,
    dvIncl_km_s: dvIncl,
    totalDv_km_s: geom.dv1 + geom.dv2 + dvIncl,
  };

  return { input, output };
}

/**
 * Refined Hohmann (Level 2 + Level 3 — display-only):
 *
 *   Level 2: use the *actual* instantaneous speed of the departure body at
 *            launch epoch and of the target body at arrival epoch (from
 *            helioCartesianState), instead of circular-velocity approximations.
 *            This captures Earth's and the target's eccentricity.
 *
 *   Level 3: combine the plane change with the in-plane burns using the
 *            "rotated burn" formula
 *                 ΔV = √(v_a² + v_b² − 2·v_a·v_b·cos(Δi_burn))
 *            and split Δi optimally between the two burns via a small 1-D
 *            search. For Δi = 0 this collapses to the scalar |v_a − v_b|
 *            formulation (identical to the textbook result).
 *
 * This is NOT used anywhere in the fuel / vehicle / launch planner chain —
 * the existing Level-0 `hohmannGeometry` + `simDeltaV.js` path remains the
 * authoritative source for mission planning numbers. This function exists
 * only to populate the middle debug panel for side-by-side comparison.
 *
 * @param {Object} earthEle  - Earth (or departure ring) orbital elements
 * @param {Object} targetEle - Target ring orbital elements
 * @param {Date} launchDate  - Departure epoch
 * @returns {{ input: Object, output: Object }}
 */
export function computeHohmannRefined(earthEle, targetEle, launchDate) {
  const departState = helioCartesianState(earthEle, launchDate);

  // r1 = actual instantaneous Earth radius at launch (accounts for Earth's e).
  const r1_AU = Math.sqrt(
    (departState.x_km / AU_KM) ** 2 +
    (departState.y_km / AU_KM) ** 2 +
    (departState.z_km / AU_KM) ** 2
  );
  // r2 still = target's semi-major axis (the target's mean radius). A fully
  // general fix would iterate to rendezvous; Lambert handles that exactly and
  // we want to preserve the Hohmann/Lambert distinction.
  const r2_AU = targetEle?.a ?? 0;

  // Transfer ellipse geometry (still coplanar, still half-ellipse from r1→r2).
  const geom = hohmannGeometry(r1_AU, r2_AU);
  const transferSeconds = geom.transferTimeDays * 86400;
  const arrivalDate = new Date(launchDate.getTime() + transferSeconds * 1000);

  // Actual departure and arrival body speeds (scalar, km/s) — from the same
  // Kepler propagator the rest of the sim uses. These replace √(μ/r).
  const v1_earth_actual = Math.sqrt(
    departState.vx_km_s ** 2 + departState.vy_km_s ** 2 + departState.vz_km_s ** 2
  );
  const arriveState = helioCartesianState(targetEle, arrivalDate);
  const v2_target_actual = Math.sqrt(
    arriveState.vx_km_s ** 2 + arriveState.vy_km_s ** 2 + arriveState.vz_km_s ** 2
  );

  // Transfer-orbit velocities (scalar) at r1 and r2, from vis-viva.
  // Outbound: depart at periapsis (r1), arrive at apoapsis (r2).
  // Inbound : depart at apoapsis  (r1), arrive at periapsis (r2).
  const r1_km = r1_AU * AU_KM;
  const r2_km = r2_AU * AU_KM;
  const a_t_km = ((r1_AU + r2_AU) / 2) * AU_KM;
  const v_t_depart = Math.sqrt(MU_SUN * (2 / r1_km - 1 / a_t_km));
  const v_t_arrive = Math.sqrt(MU_SUN * (2 / r2_km - 1 / a_t_km));

  // Plane change total (radians) between departure and target orbital planes.
  const earthIncl_deg = earthEle?.i || 0;
  const targetIncl_deg = targetEle?.i || 0;
  const deltaIncl_deg = Math.abs(earthIncl_deg - targetIncl_deg);
  const deltaIncl_rad = deltaIncl_deg * Math.PI / 180;

  // Rotated-burn ΔV formulas — α is the fraction of the total plane change
  // done at departure, (1 − α) at arrival.
  const burnDv = (v_a, v_b, dAngle) =>
    Math.sqrt(v_a * v_a + v_b * v_b - 2 * v_a * v_b * Math.cos(dAngle));
  const totalDvForSplit = (alpha) => {
    const dv1 = burnDv(v1_earth_actual, v_t_depart, alpha * deltaIncl_rad);
    const dv2 = burnDv(v_t_arrive, v2_target_actual, (1 - alpha) * deltaIncl_rad);
    return { dv1, dv2, total: dv1 + dv2 };
  };

  // Search α ∈ [0, 1] for the minimum total ΔV. With Δi = 0 every α gives
  // the same result, so we just pick α = 1 (all at departure) for stability.
  let bestAlpha = 1;
  let bestResult = totalDvForSplit(1);
  if (deltaIncl_rad > 1e-6) {
    const STEPS = 200;
    for (let k = 0; k <= STEPS; k++) {
      const alpha = k / STEPS;
      const r = totalDvForSplit(alpha);
      if (r.total < bestResult.total) {
        bestAlpha = alpha;
        bestResult = r;
      }
    }
  }

  const earthLongitude_deg = ((Math.atan2(departState.y_km, departState.x_km) * 180 / Math.PI) % 360 + 360) % 360;

  const input = {
    launch_epoch: launchDate.toISOString(),
    r1_AU,
    r2_AU,
    delta_inclination_deg: deltaIncl_deg,
    v1_earth_actual_km_s: v1_earth_actual,
    v2_target_actual_km_s: v2_target_actual,
    earth_heliocentric_longitude_deg: earthLongitude_deg,
    assumptions: "target orbit assumed circular at r2=a_target; plane change split optimally between the two burns (rotated-burn formula)",
  };

  // Baseline (Level-0) values for comparison inside the output block.
  const v_circ_r1 = Math.sqrt(MU_SUN / r1_km);
  const v_circ_r2 = Math.sqrt(MU_SUN / r2_km);
  const level0_dv1 = Math.abs(v_t_depart - v_circ_r1);
  const level0_dv2 = Math.abs(v_circ_r2 - v_t_arrive);
  const level0_dvIncl = 2 * v_circ_r1 * Math.sin(deltaIncl_rad / 2);
  const level0_total = level0_dv1 + level0_dv2 + level0_dvIncl;

  const output = {
    arrival_epoch: arrivalDate.toISOString(),
    transfer_time_days: geom.transferTimeDays,
    v_transfer_depart_km_s: v_t_depart,
    v_transfer_arrive_km_s: v_t_arrive,
    plane_change_split: {
      alpha_at_departure: bestAlpha,
      delta_inclination_deg_at_departure: bestAlpha * deltaIncl_deg,
      delta_inclination_deg_at_arrival: (1 - bestAlpha) * deltaIncl_deg,
    },
    dv1_km_s: bestResult.dv1,
    dv2_km_s: bestResult.dv2,
    totalDv_km_s: bestResult.total,
    comparison_vs_level0: {
      level0_dv1_km_s: level0_dv1,
      level0_dv2_km_s: level0_dv2,
      level0_dvIncl_km_s: level0_dvIncl,
      level0_total_km_s: level0_total,
      savings_km_s: level0_total - bestResult.total,
    },
  };

  // Expose the numbers in the shape `renderOrbitChartSVG` expects for its
  // overrideDeltaV parameter, so the middle chart can draw the refined labels
  // without re-doing any of this math.
  const overrideDeltaV = {
    dv1: bestResult.dv1,
    dv2: bestResult.dv2,
    totalDv: bestResult.total,
    color: "#8fe39b", // green — distinct from Lambert blue and Level-0 grey
  };

  return { input, output, overrideDeltaV };
}

// ---------------------------------------------------------------------------
// Hohmann transfer geometry
// ---------------------------------------------------------------------------

/**
 * Hohmann transfer ellipse geometry between two coplanar circular orbits of
 * radii r1 and r2 (both in AU).
 */
export function hohmannGeometry(r1_AU, r2_AU) {
  const r1 = Math.abs(r1_AU);
  const r2 = Math.abs(r2_AU);
  const a = (r1 + r2) / 2; // AU
  const e = Math.abs(r2 - r1) / (r1 + r2);
  // Transfer time: half the orbital period of the transfer ellipse.
  // T_full = 2π sqrt(a³/μ). Convert a from AU to km.
  const a_km = a * AU_KM;
  const r1_km = r1 * AU_KM;
  const r2_km = r2 * AU_KM;
  const transferTimeSeconds = Math.PI * Math.sqrt((a_km * a_km * a_km) / MU_SUN);
  const transferTimeDays = transferTimeSeconds / SECONDS_PER_DAY;

  // Per-burn ΔV (km/s):
  //   v_circ(r) = √(μ/r)
  //   v_transfer_peri = √(μ(2/r_peri - 1/a))   (vis-viva at periapsis)
  //   v_transfer_apo  = √(μ(2/r_apo  - 1/a))   (vis-viva at apoapsis)
  //   ΔV1 = |v_transfer_peri - v_circ(r1)|   (departure burn)
  //   ΔV2 = |v_circ(r2) - v_transfer_apo|    (arrival / circularisation burn)
  const rPeri_km = Math.min(r1_km, r2_km);
  const rApo_km = Math.max(r1_km, r2_km);
  const vCircR1 = Math.sqrt(MU_SUN / r1_km);
  const vCircR2 = Math.sqrt(MU_SUN / r2_km);
  const vTransferPeri = Math.sqrt(MU_SUN * (2 / rPeri_km - 1 / a_km));
  const vTransferApo = Math.sqrt(MU_SUN * (2 / rApo_km - 1 / a_km));
  const dv1 = Math.abs(vTransferPeri - vCircR1); // km/s
  const dv2 = Math.abs(vCircR2 - vTransferApo);  // km/s

  return {
    a,
    e,
    transferTimeDays,
    periAU: Math.min(r1, r2),
    apoAU: Math.max(r1, r2),
    outbound: r2 >= r1, // true if going outward from r1
    dv1, // km/s
    dv2, // km/s
  };
}

/**
 * Sample points along the Hohmann transfer orbit as a real Keplerian arc.
 *
 * Computes the transfer orbit's orbital elements from the departure radius
 * (r1), arrival radius (r2), and Earth's heliocentric angle at launch. Then
 * uses `positionFromSolarAngle` — the same function used to draw Earth's and
 * Mars's orbits — to sample 180° of the transfer orbit (periapsis to apoapsis
 * for outbound, or apoapsis to periapsis for inbound). The result is a true
 * section of an elliptical orbit, not a synthetic curve.
 *
 * @param {{x:number,y:number}} earthPos  - Heliocentric position (AU) at Burn 1
 * @param {number} r1_AU  - Departure orbital radius
 * @param {number} r2_AU  - Arrival orbital radius
 * @param {number} numSegments - Polyline resolution
 * @param {{x:number,y:number}} [burn2Pos] - (unused, kept for API compat)
 * @returns {{ points: Array<{x:number,y:number}>, arrival:{x:number,y:number} }}
 */
export function hohmannEllipsePoints(earthPos, r1_AU, r2_AU, numSegments = 64, burn2Pos = null) {
  const geom = hohmannGeometry(r1_AU, r2_AU);

  // Earth's heliocentric angle at departure (degrees, 0–360).
  const earthAngleDeg = ((Math.atan2(earthPos.y, earthPos.x) * 180 / Math.PI) % 360 + 360) % 360;

  // --- Build Keplerian elements for the transfer orbit ---
  //
  // For outbound (r2 ≥ r1):
  //   Perihelion at Earth (ν=0), aphelion at arrival (ν=180°).
  //   Longitude of perihelion ϖ = earthAngle.
  //   solarAngle at departure = ϖ + 0  = earthAngle.
  //   solarAngle at arrival   = ϖ + 180 = earthAngle + 180.
  //
  // For inbound (r2 < r1):
  //   Aphelion at Earth (ν=180°), perihelion at arrival (ν=0°).
  //   Longitude of perihelion ϖ = earthAngle - 180.
  //   solarAngle at departure = ϖ + 180 = earthAngle.
  //   solarAngle at arrival   = ϖ + 0   = earthAngle - 180.
  const transferElements = {
    a: geom.a,
    e: geom.e,
    i: 0,       // coplanar with ecliptic
    o: 0,       // ascending node irrelevant at i=0
    p: geom.outbound ? earthAngleDeg : ((earthAngleDeg - 180) % 360 + 360) % 360,
  };

  // --- Sample the arc (180° of the transfer orbit) ---
  //
  // The spacecraft sweeps from departure solarAngle to arrival solarAngle,
  // always going prograde (CCW, increasing solarAngle).
  const startAngle = earthAngleDeg;
  const endAngle = earthAngleDeg + 180; // always +180° for a Hohmann half-orbit

  const points = [];
  for (let s = 0; s <= numSegments; s++) {
    const solarAngle = startAngle + (endAngle - startAngle) * (s / numSegments);
    const pos = positionFromSolarAngle(transferElements, solarAngle);
    points.push({ x: pos.x, y: pos.y });
  }

  const arrival = points[points.length - 1];
  return { points, arrival, geometry: geom, transferElements };
}

// ---------------------------------------------------------------------------
// SVG orbit chart renderer
// ---------------------------------------------------------------------------

/**
 * Sample a closed orbit as a polyline of (x, y) heliocentric points (AU).
 * Uses the project's own `positionFromSolarAngle` so the drawn shape matches
 * whatever Keplerian elements the simulator is using. The z-component is
 * discarded (we view the solar system from above).
 *
 * @param {Object} ele - Keplerian orbital elements
 * @param {number} segments - Number of polyline segments (default 180)
 */
export function orbitPolylineXY(ele, segments = 180) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const solarAngle = (i / segments) * 360;
    const p = positionFromSolarAngle(ele, solarAngle);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

/**
 * Render an SVG string showing the geometry of a single Hohmann transfer:
 *   - Sun at origin
 *   - Departure orbit: Earth's orbit (always)
 *   - Mars orbit: drawn as a reference (always)
 *   - Target orbit: the ring being deployed to
 *   - Transfer trajectory: the half-ellipse traced between Burn 1 and Burn 2
 *   - Burn 1 point: departure from Earth's orbit
 *   - Burn 2 point: circularization at the target orbit
 *
 * Orbits are sampled from their real Keplerian elements (x,y only — z is
 * projected out), so eccentric / adapted rings render with correct shape.
 *
 * @param {Object} opts
 * @param {Object} opts.earthElements   - Earth's Keplerian elements
 * @param {Object} opts.marsElements    - Mars's Keplerian elements
 * @param {Object} opts.targetElements  - Target ring's Keplerian elements
 * @param {number} opts.targetAU        - Target semi-major axis (fallback for Hohmann math)
 * @param {{x:number,y:number}} opts.earthPos - Earth's heliocentric position at Burn 1 (AU)
 * @param {number} opts.width           - SVG width in px
 * @param {number} opts.height          - SVG height in px
 * @param {string} opts.burn1DateLabel  - ISO date for Burn 1
 * @param {string} opts.burn2DateLabel  - ISO date for Burn 2
 */
export function renderOrbitChartSVG({
  earthElements,
  marsElements,
  targetElements,
  targetAU,
  earthPos,
  burn2Pos,
  width = 320,
  height = 320,
  burn1DateLabel,
  burn2DateLabel,
  flightLabel,
  overrideDeltaV,
}) {
  // Sample each orbit as a polyline in heliocentric XY (AU). positionFromSolarAngle
  // returns the real-shape ellipse from the stored Keplerian elements.
  const earthPts = earthElements ? orbitPolylineXY(earthElements, 180) : [];
  const marsPts = marsElements ? orbitPolylineXY(marsElements, 180) : [];
  const targetPts = targetElements ? orbitPolylineXY(targetElements, 180) : [];

  // Hohmann transfer arc (approximation: circular r1 → circular r2 using the
  // flight's instantaneous radii). If burn2Pos is supplied, use |burn2Pos| as
  // r2 so the arc ends where the target actually is.
  const r1 = earthPos ? Math.sqrt(earthPos.x * earthPos.x + earthPos.y * earthPos.y) : 1;
  let r2;
  if (burn2Pos) {
    r2 = Math.sqrt(burn2Pos.x * burn2Pos.x + burn2Pos.y * burn2Pos.y);
  } else if (typeof targetAU === "number") {
    r2 = targetAU;
  } else {
    r2 = 1;
  }
  const transfer = hohmannEllipsePoints(earthPos, r1, r2, 96, burn2Pos);

  // Inclination change ΔV: ΔV_incl = 2·v·sin(Δi/2), performed at departure.
  // Uses the same formula as simDeltaV.js calculateInclinationDeltaV().
  const earthIncl = earthElements ? (earthElements.i || 0) : 0;
  const targetIncl = targetElements ? (targetElements.i || 0) : 0;
  const deltaI_rad = Math.abs(earthIncl - targetIncl) * Math.PI / 180;
  const vAtDeparture_km = Math.sqrt(MU_SUN / (r1 * AU_KM));
  const dvIncl = 2 * vAtDeparture_km * Math.sin(deltaI_rad / 2); // km/s
  const hasInclChange = dvIncl > 0.001;
  // Lambert solver folds any plane change into its two impulses, so suppress
  // the separate ΔV_i burn marker + legend on Lambert charts. The line of
  // nodes is still drawn for context.
  const showInclBurn = hasInclChange && !overrideDeltaV;

  // Line of nodes: where the departure plane (ecliptic / Earth) and the
  // target plane intersect. This is a line through the Sun at the target's
  // longitude of ascending node Ω. The optimal plane-change burn happens
  // where the transfer arc crosses this line.
  const nodeAngleDeg = targetElements ? (targetElements.o || 0) : 0;
  const nodeAngleRad = nodeAngleDeg * Math.PI / 180;
  // The node line extends in both directions from the Sun.
  // Find where the transfer arc crosses the node line — the ΔV_i burn point.
  // Use the ascending node direction; the optimal burn is at whichever node
  // the transfer arc passes through.
  let dviBurnPos = null;
  if (hasInclChange && !isNaN(nodeAngleRad)) {
    // Two node directions: Ω and Ω+180°. Pick the one closest to the
    // midpoint of the transfer arc (between earthAngle and earthAngle+180°).
    const earthAngleRad = Math.atan2(earthPos.y, earthPos.x);
    const midArcAngle = earthAngleRad + Math.PI / 2; // midpoint of 180° sweep
    // Normalized angular distance from midArcAngle to each node
    const dist1 = Math.abs(Math.atan2(Math.sin(nodeAngleRad - midArcAngle), Math.cos(nodeAngleRad - midArcAngle)));
    const dist2 = Math.abs(Math.atan2(Math.sin(nodeAngleRad + Math.PI - midArcAngle), Math.cos(nodeAngleRad + Math.PI - midArcAngle)));
    const bestNodeRad = dist1 <= dist2 ? nodeAngleRad : nodeAngleRad + Math.PI;
    // Get the transfer orbit's radius at this node angle using positionFromSolarAngle
    if (transfer.transferElements) {
      const bestNodeDeg = ((bestNodeRad * 180 / Math.PI) % 360 + 360) % 360;
      const nodePos = positionFromSolarAngle(transfer.transferElements, bestNodeDeg);
      dviBurnPos = { x: nodePos.x, y: nodePos.y };
    }
  }

  // Auto-scale: include every sampled point so real ellipse shapes fit.
  let maxAbs = 0;
  const consider = (p) => {
    const m = Math.max(Math.abs(p.x), Math.abs(p.y));
    if (m > maxAbs) maxAbs = m;
  };
  earthPts.forEach(consider);
  marsPts.forEach(consider);
  targetPts.forEach(consider);
  transfer.points.forEach(consider);
  if (earthPos) consider(earthPos);
  if (burn2Pos) consider(burn2Pos);
  if (maxAbs <= 0) maxAbs = 1.5; // sane fallback

  const maxR = maxAbs * 1.15;
  const cx = width / 2;
  const cy = height / 2;
  const scale = Math.min(width, height) / (2 * maxR);

  // Convert heliocentric AU (+x right, +y up) to SVG pixels (+x right, +y down)
  const toPx = (x, y) => ({ px: cx + x * scale, py: cy - y * scale });

  const ptsToSvg = (arr) =>
    arr
      .map((p) => {
        const q = toPx(p.x, p.y);
        return `${q.px.toFixed(2)},${q.py.toFixed(2)}`;
      })
      .join(" ");

  const earthPoly = ptsToSvg(earthPts);
  const marsPoly = ptsToSvg(marsPts);
  const targetPoly = ptsToSvg(targetPts);
  // For ring_earth flights the departure and target radii are equal, and the
  // Hohmann "arc" collapses into a half-circle that would incorrectly look
  // like a half-orbit around the Sun. Skip the arc in that case — the two
  // burn markers coincide and the chart shows Earth's orbit + Burn 1 only.
  const isInPlane = Math.abs(r1 - r2) < 1e-4;
  const transferPoly = isInPlane ? "" : ptsToSvg(transfer.points);

  const burn1Px = toPx(earthPos.x, earthPos.y);
  // Prefer the caller-supplied burn2 position (target's real heliocentric
  // position at arrival) over the geometric arrival on the Hohmann ellipse.
  const effectiveBurn2 = burn2Pos || transfer.arrival;
  const burn2Px = toPx(effectiveBurn2.x, effectiveBurn2.y);

  const sunR = 4;
  const transferDays = Math.round(transfer.geometry.transferTimeDays);

  const earthOrbitSvg = earthPts.length
    ? `<polyline points="${earthPoly}" fill="none" stroke="#4a90e2" stroke-width="1.4" opacity="0.9" />`
    : "";
  const marsOrbitSvg = marsPts.length
    ? `<polyline points="${marsPoly}" fill="none" stroke="#e0623a" stroke-width="1" opacity="0.75" stroke-dasharray="2 4" />`
    : "";
  const targetOrbitSvg = targetPts.length
    ? `<polyline points="${targetPoly}" fill="none" stroke="#c78aff" stroke-width="1.6" opacity="0.95" />`
    : "";

  return `
<svg class="orbit-chart-svg-el" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Hohmann transfer from Earth to target ring">
  <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
  ${earthOrbitSvg}
  ${marsOrbitSvg}
  ${targetOrbitSvg}
  <!-- Line of nodes: where departure and target orbital planes intersect -->
  ${hasInclChange ? (() => {
    const nodeExtent = maxR; // extend to chart edge
    const n1 = toPx(nodeExtent * Math.cos(nodeAngleRad), nodeExtent * Math.sin(nodeAngleRad));
    const n2 = toPx(-nodeExtent * Math.cos(nodeAngleRad), -nodeExtent * Math.sin(nodeAngleRad));
    return `<line x1="${n1.px.toFixed(2)}" y1="${n1.py.toFixed(2)}" x2="${n2.px.toFixed(2)}" y2="${n2.py.toFixed(2)}" stroke="#88ddff" stroke-width="0.7" stroke-dasharray="3 5" opacity="0.5" />`;
  })() : ""}
  <!-- Radial lines from Sun to each burn -->
  <line x1="${cx}" y1="${cy}" x2="${burn1Px.px.toFixed(2)}" y2="${burn1Px.py.toFixed(2)}" stroke="#7bdc7b" stroke-width="0.8" opacity="0.5" />
  ${isInPlane ? "" : `<line x1="${cx}" y1="${cy}" x2="${burn2Px.px.toFixed(2)}" y2="${burn2Px.py.toFixed(2)}" stroke="#ff6b6b" stroke-width="0.8" opacity="0.5" />`}
  ${isInPlane ? "" : `<polyline points="${transferPoly}" fill="none" stroke="#ffa94d" stroke-width="1.8" stroke-dasharray="5 3" />`}
  <circle cx="${cx}" cy="${cy}" r="${sunR}" fill="#ffd24a" />
  <circle cx="${burn1Px.px.toFixed(2)}" cy="${burn1Px.py.toFixed(2)}" r="5" fill="#7bdc7b" stroke="#000" stroke-width="0.75" />
  ${isInPlane ? "" : `<circle cx="${burn2Px.px.toFixed(2)}" cy="${burn2Px.py.toFixed(2)}" r="5" fill="#ff6b6b" stroke="#000" stroke-width="0.75" />`}
  <!-- ΔV_i burn point: where the transfer arc crosses the line of nodes -->
  ${showInclBurn && dviBurnPos ? (() => {
    const dviPx = toPx(dviBurnPos.x, dviBurnPos.y);
    return `<circle cx="${dviPx.px.toFixed(2)}" cy="${dviPx.py.toFixed(2)}" r="4" fill="none" stroke="#88ddff" stroke-width="1.5" />
    <line x1="${cx}" y1="${cy}" x2="${dviPx.px.toFixed(2)}" y2="${dviPx.py.toFixed(2)}" stroke="#88ddff" stroke-width="0.6" opacity="0.4" />`;
  })() : ""}
  ${flightLabel ? `<text x="${cx}" y="${cy + sunR + 14}" class="orbit-chart-legend" fill="#ddd" text-anchor="middle" font-weight="bold">${flightLabel}</text>` : ""}
  <text x="8" y="14" class="orbit-chart-legend" fill="#4a90e2">— Departure (Earth)</text>
  <text x="8" y="28" class="orbit-chart-legend" fill="#e0623a">- - Mars (ref)</text>
  <text x="8" y="42" class="orbit-chart-legend" fill="#c78aff">— Target</text>
  ${isInPlane ? "" : `<text x="8" y="56" class="orbit-chart-legend" fill="#ffa94d">- - Transfer</text>`}
  <text x="${width - 8}" y="14" class="orbit-chart-legend" fill="#7bdc7b" text-anchor="end">● Burn 1 ${burn1DateLabel || ""}</text>
  ${isInPlane ? `<text x="${width - 8}" y="28" class="orbit-chart-legend" fill="#aaa" text-anchor="end">(escape only, no transfer)</text>` : `<text x="${width - 8}" y="28" class="orbit-chart-legend" fill="#ff6b6b" text-anchor="end">● Burn 2 ${burn2DateLabel || ""}</text>`}
  ${showInclBurn ? `<text x="${width - 8}" y="42" class="orbit-chart-legend" fill="#88ddff" text-anchor="end">○ ΔV_i (plane change)</text>` : ""}
  ${isInPlane ? "" : (() => {
    const d1 = overrideDeltaV ? overrideDeltaV.dv1 : transfer.geometry.dv1;
    const d2 = overrideDeltaV ? overrideDeltaV.dv2 : transfer.geometry.dv2;
    const dTotal = overrideDeltaV ? overrideDeltaV.totalDv : (transfer.geometry.dv1 + transfer.geometry.dv2 + dvIncl);
    const dvColor = overrideDeltaV ? (overrideDeltaV.color || "#88ddff") : "#aaa";
    return `
  <text x="${width - 8}" y="${height - 50}" class="orbit-chart-legend" fill="${dvColor}" text-anchor="end">ΔV1 ${d1.toFixed(2)} km/s</text>
  <text x="${width - 8}" y="${height - 36}" class="orbit-chart-legend" fill="${dvColor}" text-anchor="end">ΔV2 ${d2.toFixed(2)} km/s</text>
  ${!overrideDeltaV && dvIncl > 0.001 ? `<text x="${width - 8}" y="${height - 22}" class="orbit-chart-legend" fill="${dvColor}" text-anchor="end">(${Math.abs(earthIncl - targetIncl).toFixed(1)}°) ΔV_i ${dvIncl.toFixed(2)} km/s</text>` : ""}
  <text x="${width - 8}" y="${height - 8}" class="orbit-chart-legend" fill="${dvColor}" text-anchor="end">Transfer ${transferDays} d · ΣΔV ${dTotal.toFixed(2)} km/s</text>
  `;
  })()}
  ${isInPlane || !transfer.transferElements ? "" : `<text x="8" y="${height - 22}" class="orbit-chart-legend" fill="#ffa94d" font-size="8">a=${transfer.transferElements.a.toFixed(3)} e=${transfer.transferElements.e.toFixed(3)} ϖ=${transfer.transferElements.p.toFixed(1)}°</text><text x="8" y="${height - 8}" class="orbit-chart-legend" fill="#ffa94d" font-size="8">r1=${r1.toFixed(3)} r2=${r2.toFixed(3)} AU</text>`}
</svg>`;
}

// ---------------------------------------------------------------------------
// Utility: get Earth's heliocentric XY at a given date, using orbital elements.
// ---------------------------------------------------------------------------
export function earthPositionAt(earthElements, date) {
  const { x, y } = helioCoords(earthElements, date);
  return { x, y };
}

/**
 * Format a Date as an ISO date string (YYYY-MM-DD) for report display.
 */
export function formatDate(d) {
  if (!d || isNaN(d.getTime())) return "—";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
