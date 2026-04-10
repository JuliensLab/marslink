// simConstants.js - Centralized constants for the MarsLink simulation

export const SIM_CONSTANTS = {
  // Astronomical constants
  AU_IN_KM: 149597871, // 1 AU in kilometers
  SPEED_OF_LIGHT_KM_S: 299792, // Speed of light in km/s
  DEG_TO_RAD: Math.PI / 180, // Degree to radian conversion
  JULIAN_DAY_UNIX_EPOCH: 2440587.5, // Julian Day at Unix epoch (1970-01-01 00:00:00 UTC)
  MU_SUN_KM3_S2: 1.32712440018e11, // Sun's gravitational parameter in km^3/s^2

  // Link budget constants
  DEFAULT_BASE_DISTANCE_KM: 3000, // Default base distance for link calculations in km
  DEFAULT_BASE_GBPS: 100, // Default base throughput in Gbps
  DEFAULT_MAX_DISTANCE_AU: 0.5, // Default maximum link range in AU

  // Sun physical constants
  SUN_RADIUS_KM: 696350, // Solar radius in km
  SUN_RADIUS_AU: 696350 / 149597871, // Solar radius in AU (~0.00465)

  // Display constants
  SUN_SCALE_FACTOR: 1,
  PLANET_SCALE_FACTOR: 1,
  SATELLITE_SCALE_FACTOR: 1,
};
