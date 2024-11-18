export function generateSatellites(satCount, satDistanceSun, ringName, ringType, marsSideExtensionDeg, failedSatellitesPct) {
  if (satCount == 0) return [];
  const satellites = [];
  if (ringType == "Circular") {
    const a = satDistanceSun;
    const n = meanMotion(a);
    const orbitdays = 360 / n;
    const longIncrement = 360 / satCount;
    for (let i = 0; i < satCount; i++)
      if (Math.random() >= failedSatellitesPct / 100)
        satellites.push(generateSatellite(ringName, ringType, a, n, i * longIncrement, orbitdays));
  } else {
    let a;
    let n;
    if (ringType == "Mars") {
      a = 1.5236365;
      n = 0.5240613;
    } else if (ringType == "Earth") {
      a = 1.00002;
      n = 0.9855796;
    }
    const orbitdays = 360 / n;
    const satCountOneSide = Math.ceil(satCount / 2);
    const longIncrement = marsSideExtensionDeg / satCountOneSide;
    for (let i = 0; i < satCountOneSide; i++) {
      if (Math.random() >= failedSatellitesPct / 100) {
        satellites.push(generateSatellite(ringName, ringType, a, n, (i + 1) * longIncrement, orbitdays));
        satellites.push(generateSatellite(ringName, ringType, a, n, -(i + 1) * longIncrement, orbitdays));
      }
    }
  }
  return satellites;
}

function generateSatellite(ringName, ringType, a, n, long, orbitdays) {
  const elements = getOrbitaElements(ringType, a, n, long);
  const satelliteData = {
    name: `${ringName}-${long}`,
    ...elements,
    diameterKm: 10000,
    orbitdays: orbitdays,
    rotationHours: 0,
    Dele: 2450680.5,
    color: [255, 255, 255],
  };
  return satelliteData;
}

function getOrbitaElements(ringType, a, n, long) {
  if (ringType == "Mars")
    return {
      i: 1.84992,
      o: 49.5664,
      p: 336.0882,
      a: 1.5236365,
      n: 0.5240613,
      e: 0.0934231,
      l: (262.42784 + long + 360) % 360,
    };
  else if (ringType == "Earth")
    return {
      i: 0.00041,
      o: 349.2,
      p: 102.8517,
      a: 1.00002,
      n: 0.9855796,
      e: 0.0166967,
      l: (328.40353 + +long + 360) % 360,
    };
  else
    return {
      i: 0,
      o: 49.5664,
      p: 336.0882,
      a: a,
      n: n,
      e: 0.05,
      l: long,
    };
}

// {
//   name: "Mars",
//   i: 1.84992,
//   o: 49.5664,
//   p: 336.0882,
//   a: 1.5236365,
//   n: 0.5240613,
//   e: 0.0934231,
//   l: 262.42784,
//   diameterKm: 6794,
//   massKg: 0.642e24,
//   orbitdays: 687,
//   rotationHours: 24.6,
//   Dele: 2450680.5,
//   color: [200, 20, 20],
//   texturePath: "img/textures/2k_mars.jpg",
// },

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
