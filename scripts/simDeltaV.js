// Constants
const MU_SUN = 1.32712440018e11; // Sun's gravitational parameter in km³/s²
const AU = 149597870.7; // 1 AU in km
const SECONDS_PER_DAY = 86400;

// Function to calculate delta-V for inclination change
function calculateInclinationDeltaV(v, i1, i2) {
  const deltaI = (Math.abs(i1 - i2) * Math.PI) / 180; // Convert degrees to radians
  return 2 * v * Math.sin(deltaI / 2); // Delta-V for inclination change (km/s)
}

export function calculateDeltaV_km_s(orbit1, orbit2) {
  console.log(orbit1, orbit2);
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

  console.log(
    `${orbit1.ringName ? orbit1.ringName : orbit1.name} to ${orbit2.ringName ? orbit2.ringName : orbit2.name}`,
    deltaV1,
    deltaV2,
    deltaV_inclination
  );

  return {
    deltaV1: Math.round(deltaV1 * 1000) / 1000, // First Hohmann burn (km/s)
    deltaV2: Math.round(deltaV2 * 1000) / 1000, // Second Hohmann burn (km/s)
    deltaV_inclination: Math.round(deltaV_inclination * 1000) / 1000, // Inclination change (km/s)
    totalDeltaV: Math.round(totalDeltaV * 1000) / 1000, // Total (km/s)
  };
}
