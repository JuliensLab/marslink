export function helioCoords(ele, date) {
  const PI = Math.PI;
  const DEG_TO_RAD = PI / 180; // Define the constant for degree to radian conversion

  // Julian Day at Unix epoch (1970-01-01 00:00:00 UTC)
  const JULIAN_DAY_UNIX_EPOCH = 2440587.5;

  // Convert the provided date to milliseconds since Unix epoch and then to days
  const millisecondsSinceEpoch = date.getTime();
  const daysSinceEpoch = millisecondsSinceEpoch / (1000 * 60 * 60 * 24);

  // Calculate the Julian Day for the provided date
  const julianDay = JULIAN_DAY_UNIX_EPOCH + daysSinceEpoch;

  // Calculate the number of days since the epoch of the orbital elements
  const D = julianDay - ele.Dele;

  // Calculate the Mean Anomaly (M) in degrees
  let M = (ele.n * D + ele.l - ele.p) % 360;
  if (M < 0) M += 360; // Ensure M is positive

  // Precompute constants for true anomaly calculation
  const e = ele.e;
  const e2 = e * e; // e²
  const e3 = e2 * e; // e³
  const M_rad = M * DEG_TO_RAD; // Mean Anomaly in radians
  const sinM = Math.sin(M_rad);
  const sin2M = Math.sin(2 * M_rad);
  const sin3M = Math.sin(3 * M_rad);

  // Calculate the True Anomaly (v) using a series expansion
  const trueAnomaly = M + (180 / PI) * ((2 * e - e3 / 4) * sinM + (5 / 4) * e2 * sin2M + (13 / 12) * e3 * sin3M);

  // Convert true anomaly to radians once
  const trueAnomaly_rad = trueAnomaly * DEG_TO_RAD;
  const cosTrueAnomaly = Math.cos(trueAnomaly_rad);

  // Calculate the Radius Vector (r) in astronomical units (AU)
  const r = (ele.a * (1 - e2)) / (1 + e * cosTrueAnomaly);

  // Calculate the angle from the ascending node (vpo) in degrees
  let vpo = (trueAnomaly + ele.p - ele.o) % 360;
  if (vpo < 0) vpo += 360; // Ensure vpo is positive

  // Convert angles from degrees to radians for trigonometric functions
  const oRad = ele.o * DEG_TO_RAD;
  const iRad = ele.i * DEG_TO_RAD;
  const vpoRad = vpo * DEG_TO_RAD;

  // Precompute trigonometric functions to avoid redundant calculations
  const cosORad = Math.cos(oRad);
  const sinORad = Math.sin(oRad);
  const cosVpoRad = Math.cos(vpoRad);
  const sinVpoRad = Math.sin(vpoRad);
  const cosIRad = Math.cos(iRad);
  const sinIRad = Math.sin(iRad);

  // Calculate the heliocentric coordinates (X, Y, Z) in AU
  const x = r * (cosORad * cosVpoRad - sinORad * sinVpoRad * cosIRad);
  const y = r * (sinORad * cosVpoRad + cosORad * sinVpoRad * cosIRad);
  const z = r * (sinVpoRad * sinIRad);

  // Calculate rotation angles based on the rotation periods
  const rotation = { x: 0, y: 0, z: 0 };

  if (ele.rotationHours) {
    const elapsedSeconds = D * 24 * 3600; // Convert days to seconds

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
