export function generateSatellites(satCount, satDistanceSun) {
  const satellites = [];
  const a = satDistanceSun;
  const n = meanMotion(a);
  const orbitdays = 360 / n;
  const longIncrement = 360 / satCount;
  for (let long = 0; long < 360; long += longIncrement) {
    satellites.push({
      name: long,
      i: 0,
      o: 0,
      p: 0,
      a: a,
      n: n,
      e: 0,
      l: long,
      diameterKm: 50,
      orbitdays: orbitdays,
      rotationHours: 0,
      Dele: 2450680.5,
      color: [255, 255, 255],
    });
  }
  return satellites;
}

// i = inclination in degrees
// a = semi major axis (distance between sun and planet) in AU
// e = eccentricity dimensionless
// o = Longitude of the Ascending Node in degrees (RAAN)
// p = Argument of Perihelion in degrees
// n = Mean Motion in degrees per day
// l = Mean Longitude in degrees

function meanMotion(a, m = 0) {
  // Calculates the mean motion (n) in degrees per day
  // a: Semi-major axis in astronomical units (AU)
  // m: Mass of the orbiting body in kilograms (kg), default is 0

  // Constants
  const G = 6.6743e-11; // Gravitational constant in m^3 kg^-1 s^-2
  const M_sun = 1.98847e30; // Mass of the Sun in kg
  const AU_in_meters = 1.495978707e11; // 1 AU in meters
  const seconds_per_day = 86400; // Number of seconds in a day
  const radians_to_degrees = 180 / Math.PI; // Conversion factor from radians to degrees

  // Convert semi-major axis from AU to meters
  const a_meters = a * AU_in_meters;

  // Total mass (Sun + orbiting body) in kg
  const total_mass = M_sun + m;

  // Calculate mean motion in radians per second
  const n_rad_per_sec = Math.sqrt((G * total_mass) / Math.pow(a_meters, 3));

  // Convert mean motion to degrees per day
  const n_deg_per_day = n_rad_per_sec * seconds_per_day * radians_to_degrees;

  return n_deg_per_day;
}
