// Constants
const MU_SUN = 1.32712440018e11; // Sun's gravitational parameter in km³/s²
const AU = 149597870.7; // 1 AU in km
const SECONDS_PER_DAY = 86400;
const MU_EARTH = 398600.4418; // Earth's gravitational parameter in km³/s²
const R_EARTH_KM = 6378.137; // Earth's equatorial radius in km
export const DEFAULT_LEO_ALTITUDE_KM = 300; // parking orbit for the departure burn

/**
 * Δv for the burn performed FROM a circular LEO parking orbit so that the
 * vehicle leaves Earth's sphere of influence with hyperbolic excess speed
 * `vInf_km_s` (the heliocentric Hohmann Δv1 relative to Earth's orbital
 * velocity). Patched-conics / Oberth:
 *
 *   Δv_LEO = √(v∞² + v_esc²) − v_LEO,   v_esc = √2 · v_LEO
 *
 * With v∞ = 0 this is the plain LEO → escape (C3 = 0) burn, ≈3.20 km/s from
 * 300 km. If `escapeDv_km_s` is given (e.g. the "Earth-escape burn Δv"
 * slider), v_esc is taken as v_LEO + escapeDv_km_s, so the function returns
 * exactly that slider value at v∞ = 0 and stays consistent with it for any v∞.
 *
 * Before this was added, the heliocentric Δv1 was charged directly as the
 * LEO burn, which made reaching a 1.26 AU ring cheaper than merely escaping
 * Earth (audit 2026-10-18, top item 1).
 */
export function leoDepartureDeltaV_km_s(vInf_km_s, escapeDv_km_s, leoAltitudeKm = DEFAULT_LEO_ALTITUDE_KM) {
  const vLeo = Math.sqrt(MU_EARTH / (R_EARTH_KM + leoAltitudeKm));
  const vEsc = Number.isFinite(escapeDv_km_s) ? vLeo + escapeDv_km_s : Math.SQRT2 * vLeo;
  const vInf = Math.abs(vInf_km_s || 0);
  return Math.sqrt(vInf * vInf + vEsc * vEsc) - vLeo;
}

// Function to calculate delta-V for inclination change
function calculateInclinationDeltaV(v, i1, i2) {
  const deltaI = (Math.abs(i1 - i2) * Math.PI) / 180; // Convert degrees to radians
  return 2 * v * Math.sin(deltaI / 2); // Delta-V for inclination change (km/s)
}

export function calculateHohmannDeltaV_km_s(orbit1, orbit2) {
  const start = orbit1;
  const target = orbit2;

  // Convert semi-major axis from AU to km
  const a_start = start.a * AU;
  const a_target = target.a * AU;

  // Eccentricity
  const e_start = start.e;
  const e_target = target.e;

  // Calculate periapsis and apoapsis distances (in km)
  const rp_start = a_start * (1 - e_start); // Periapsis of starting orbit
  const ra_start = a_start * (1 + e_start); // Apoapsis of starting orbit
  const rp_target = a_target * (1 - e_target); // Periapsis of target orbit
  const ra_target = a_target * (1 + e_target); // Apoapsis of target orbit

  // Hohmann transfer
  const v_start = Math.sqrt(MU_SUN * (2 / rp_start - 1 / a_start)); // Velocity at periapsis of starting orbit
  const a_transfer = (rp_start + rp_target) / 2; // Semi-major axis of transfer orbit
  const v_transfer_start = Math.sqrt(MU_SUN * (2 / rp_start - 1 / a_transfer)); // Velocity for transfer orbit at starting periapsis

  // First delta-V (Hohmann burn)
  const deltaV1 = Math.abs(v_transfer_start - v_start);

  // Velocity at target periapsis in transfer orbit
  const v_transfer_target = Math.sqrt(MU_SUN * (2 / rp_target - 1 / a_transfer));
  // Velocity in target orbit at periapsis
  const v_target = Math.sqrt(MU_SUN * (2 / rp_target - 1 / a_target));

  // Second delta-V (Hohmann burn)
  const deltaV2 = Math.abs(v_target - v_transfer_target);

  // Inclination change delta-V (assume performed at v_start)
  const deltaV_inclination = calculateInclinationDeltaV(v_start, start.i, target.i);

  // Total delta-V (Hohmann + inclination)
  const totalDeltaV = deltaV1 + deltaV2 + deltaV_inclination;

  return {
    deltaV1: Math.round(deltaV1 * 1000) / 1000, // First Hohmann burn (km/s)
    deltaV2: Math.round(deltaV2 * 1000) / 1000, // Second Hohmann burn (km/s)
    deltaV_inclination: Math.round(deltaV_inclination * 1000) / 1000, // Inclination change (km/s)
    totalDeltaV: Math.round(totalDeltaV * 1000) / 1000, // Total (km/s)
  };
}
