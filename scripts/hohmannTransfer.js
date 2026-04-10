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
  ${hasInclChange && dviBurnPos ? (() => {
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
  ${hasInclChange ? `<text x="${width - 8}" y="42" class="orbit-chart-legend" fill="#88ddff" text-anchor="end">○ ΔV_i (plane change)</text>` : ""}
  ${isInPlane ? "" : `
  <text x="${width - 8}" y="${height - 50}" class="orbit-chart-legend" fill="#aaa" text-anchor="end">ΔV1 ${transfer.geometry.dv1.toFixed(2)} km/s</text>
  <text x="${width - 8}" y="${height - 36}" class="orbit-chart-legend" fill="#aaa" text-anchor="end">ΔV2 ${transfer.geometry.dv2.toFixed(2)} km/s</text>
  ${dvIncl > 0.001 ? `<text x="${width - 8}" y="${height - 22}" class="orbit-chart-legend" fill="#aaa" text-anchor="end">(${Math.abs(earthIncl - targetIncl).toFixed(1)}°) ΔV_i ${dvIncl.toFixed(2)} km/s</text>` : ""}
  <text x="${width - 8}" y="${height - 8}" class="orbit-chart-legend" fill="#aaa" text-anchor="end">Transfer ${transferDays} d · ΣΔV ${(transfer.geometry.dv1 + transfer.geometry.dv2 + dvIncl).toFixed(2)} km/s</text>
  `}
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
