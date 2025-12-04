// simOrbits.js

import { SIM_CONSTANTS } from "./simConstants.js";

/**
 * Computes heliocentric coordinates and rotation angles for an object based on its Keplerian orbital elements.
 * @param {Object} ele - Orbital elements object with properties:
 *   - a: Semi-major axis (AU)
 *   - e: Eccentricity (dimensionless)
 *   - i: Inclination (degrees)
 *   - l: Mean longitude (degrees)
 *   - p: Longitude of perihelion (degrees)
 *   - o: Longitude of ascending node (degrees)
 *   - n: Mean motion (degrees/day)
 *   - Dele: Epoch Julian Day (e.g., 2451545.0 for J2000)
 *   - a_rate: Rate of semi-major axis change (AU/century, optional)
 *   - e_rate: Rate of eccentricity change (dimensionless/century, optional)
 *   - i_rate: Rate of inclination change (degrees/century, optional)
 *   - p_rate: Rate of perihelion longitude change (degrees/century, optional)
 *   - o_rate: Rate of ascending node longitude change (degrees/century, optional)
 *   - l_rate: Rate of mean longitude change (degrees/century, optional; typically included in n)
 *   - rotationHours: Object with x, y, z rotation periods (hours)
 * @param {Date} date - JavaScript Date object for position calculation
 * @returns {Object} - { x, y, z, rotation, vpo } where:
 *   - x, y, z: Heliocentric coordinates in AU
 *   - rotation: Object with x, y, z rotation angles in radians
 *   - vpo: Argument of latitude (degrees)
 */
export function helioCoords(ele, date) {
  const PI = Math.PI;
  const DEG_TO_RAD = SIM_CONSTANTS.DEG_TO_RAD;

  // Julian Day at Unix epoch (1970-01-01 00:00:00 UTC)
  const JULIAN_DAY_UNIX_EPOCH = SIM_CONSTANTS.JULIAN_DAY_UNIX_EPOCH;

  // Convert the provided date to milliseconds since Unix epoch and then to days
  const millisecondsSinceEpoch = date.getTime();
  const daysSinceEpoch = millisecondsSinceEpoch / (1000 * 60 * 60 * 24);

  // Calculate the Julian Day for the provided date
  const julianDay = JULIAN_DAY_UNIX_EPOCH + daysSinceEpoch;

  // Calculate the number of days and centuries since the epoch of the orbital elements
  const D = julianDay - ele.Dele;
  const Cy = D / 36525; // Centuries since epoch (36525 days = 1 Julian century)

  // Adjust orbital elements using rates (defaults to 0 if rate not provided)
  const a = ele.a + (ele.a_rate || 0) * Cy; // Semi-major axis in AU
  const e = ele.e + (ele.e_rate || 0) * Cy; // Eccentricity (dimensionless)
  const i = ele.i + (ele.i_rate || 0) * Cy; // Inclination in degrees
  const p = ele.p + (ele.p_rate || 0) * Cy; // Longitude of perihelion in degrees
  const o = ele.o + (ele.o_rate || 0) * Cy; // Longitude of ascending node in degrees
  const l = ele.l + (ele.l_rate || 0) * Cy; // Mean longitude in degrees (rate typically in n)

  // Calculate the Mean Anomaly (M) in degrees
  let M = (ele.n * D + l - p) % 360; // M = n * D + M0, where M0 = l - p at epoch
  if (M < 0) M += 360; // Ensure M is positive

  // Precompute constants for true anomaly calculation
  const e2 = e * e; // e²
  const e3 = e2 * e; // e³
  const M_rad = M * DEG_TO_RAD; // Mean Anomaly in radians
  const sinM = Math.sin(M_rad);
  const sin2M = Math.sin(2 * M_rad);
  const sin3M = Math.sin(3 * M_rad);

  // Calculate the True Anomaly (v) using a series expansion
  // Note: This is a low-order approximation, suitable for low eccentricities (e < 0.3).
  // For high-eccentricity orbits (e.g., comets), consider solving Kepler's equation iteratively.
  const trueAnomaly = M + (180 / PI) * ((2 * e - e3 / 4) * sinM + (5 / 4) * e2 * sin2M + (13 / 12) * e3 * sin3M);

  // Convert true anomaly to radians once
  const trueAnomaly_rad = trueAnomaly * DEG_TO_RAD;
  const cosTrueAnomaly = Math.cos(trueAnomaly_rad);

  // Calculate the Radius Vector (r) in astronomical units (AU)
  const r = (a * (1 - e2)) / (1 + e * cosTrueAnomaly);

  // Calculate the angle from the ascending node (vpo) in degrees (argument of latitude)
  let vpo = (trueAnomaly + p - o) % 360;
  if (vpo < 0) vpo += 360; // Ensure vpo is positive

  // Convert angles from degrees to radians for trigonometric functions
  const oRad = o * DEG_TO_RAD;
  const iRad = i * DEG_TO_RAD;
  const vpoRad = vpo * DEG_TO_RAD;

  // Precompute trigonometric functions to avoid redundant calculations
  const cosORad = Math.cos(oRad);
  const sinORad = Math.sin(oRad);
  const cosVpoRad = Math.cos(vpoRad);
  const sinVpoRad = Math.sin(vpoRad);
  const cosIRad = Math.cos(iRad);
  const sinIRad = Math.sin(iRad);

  // Calculate the heliocentric coordinates (X, Y, Z) in AU relative to the ecliptic
  const x = r * (cosORad * cosVpoRad - sinORad * sinVpoRad * cosIRad);
  const y = r * (sinORad * cosVpoRad + cosORad * sinVpoRad * cosIRad);
  const z = r * (sinVpoRad * sinIRad);

  // Calculate rotation angles based on the rotation periods
  const rotation = { x: 0, y: 0, z: 0 };
  if (ele.rotationHours) {
    const elapsedSeconds = D * 24 * 3600; // Convert days to seconds

    /**
     * Computes rotation angle in radians based on period and elapsed time.
     * @param {number} rotationPeriodHours - Rotation period in hours
     * @param {number} elapsedSeconds - Time elapsed in seconds
     * @returns {number} - Angle in radians
     */
    function computeRotationAngle(rotationPeriodHours, elapsedSeconds) {
      if (!rotationPeriodHours) return 0; // Default to zero if not provided or zero
      const rotationPeriodInSeconds = rotationPeriodHours * 3600;
      const fraction = elapsedSeconds / rotationPeriodInSeconds - Math.floor(elapsedSeconds / rotationPeriodInSeconds);
      const angle = fraction * 2 * PI;
      return angle;
    }

    if (ele.rotationHours.x) rotation.x = computeRotationAngle(ele.rotationHours.x, elapsedSeconds);
    if (ele.rotationHours.y) rotation.y = computeRotationAngle(ele.rotationHours.y, elapsedSeconds);
    if (ele.rotationHours.z) rotation.z = computeRotationAngle(ele.rotationHours.z, elapsedSeconds);
  }

  return { x, y, z, rotation, vpo };
}
