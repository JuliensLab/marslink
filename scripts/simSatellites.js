// simSatellites.js

import { helioCoords } from "./simOrbits.js?v=2.4";

export class SimSatellites {
  constructor() {
    this.satellites = [];
    this.orbitalElements = [];
  }

  setSatellitesConfig(satellitesConfig) {
    this.satellites = [];
    const newSatellites = [];
    for (let config of satellitesConfig) newSatellites.push(...this.generateSatellites(config));
    this.satellites = newSatellites; //.slice(0, 2000);
    // console.log(`${this.satellites.length} SATELLITES`);
  }

  setOrbitalElements(satellitesConfig) {
    this.orbitalElements = [];
    const newOrbitalElements = [];
    for (let config of satellitesConfig) newOrbitalElements.push(this.generateOrbitalElements(config));
    this.orbitalElements = newOrbitalElements;
    console.log(this.orbitalElements);
  }

  updateSatellitesPositions(simDaysSinceStart) {
    for (const satellite of this.satellites) satellite.position = helioCoords(satellite, simDaysSinceStart);
    return this.satellites;
  }

  generateSatellites(config) {
    const { satCount, satDistanceSun, ringName, ringType, sideExtensionDeg, eccentricity, argPeri, earthMarsInclinationPct } = config;
    if (satCount == 0) return [];
    const satellites = [];
    if (ringType == "Circular") {
      const a = satDistanceSun;
      const n = this.meanMotion(a);
      const orbitdays = 360 / n;
      const longIncrement = 360 / satCount;
      for (let i = 0; i < satCount; i++) {
        const name = `${ringName}-${i}`;
        const long = i * longIncrement;
        const neighbors = [`${ringName}-${(i + 1) % satCount}`, `${ringName}-${(i - 1 + satCount) % satCount}`];
        satellites.push(
          this.generateSatellite(ringName, ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long, orbitdays, name, neighbors)
        );
      }
    } else if (ringType == "Eccentric") {
      const a = satDistanceSun;
      const n = this.meanMotion(a);
      const orbitdays = 360 / n;
      const longIncrement = 360 / satCount;
      for (let i = 0; i < satCount; i++) {
        const name = `${ringName}-${i}`;
        const long = i * longIncrement;
        const neighbors = [`${ringName}-${(i + 1) % satCount}`, `${ringName}-${(i - 1 + satCount) % satCount}`];
        satellites.push(
          this.generateSatellite(ringName, ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long, orbitdays, name, neighbors)
        );
      }
    } else {
      const { a, n } = this.getParams_a_n(ringType);

      const orbitdays = 360 / n;
      const satCountOneSide = Math.ceil(satCount / 2);
      const longIncrement = sideExtensionDeg / satCountOneSide;
      for (let i = 0; i < satCountOneSide; i++) {
        const long = (i + 1) * longIncrement;
        const name = `${ringName}-${i}`;
        let neighbors = [];
        if (i == 0) neighbors.push(`${ringType}`);
        if (i > 0) neighbors.push(`${ringName}-${i - 1}`);
        if (i < satCountOneSide - 1) neighbors.push(`${ringName}-${i + 1}`);
        satellites.push(
          this.generateSatellite(ringName, ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long, orbitdays, name, neighbors)
        );

        if (!(sideExtensionDeg == 180 && i == satCountOneSide - 1)) {
          const name = `${ringName}--${i}`;
          neighbors = [];
          if (i == 0) neighbors.push(`${ringType}`);
          if (i > 0) neighbors.push(`${ringName}--${i - 1}`);
          if (i < satCountOneSide - 1) neighbors.push(`${ringName}--${i + 1}`);
          if (sideExtensionDeg == 180 && i == satCountOneSide - 2) neighbors.push(`${ringName}-${i + 1}`);
          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              -long,
              orbitdays,
              name,
              neighbors
            )
          );
        }
      }
    }
    return satellites;
  }

  generateOrbitalElements(config) {
    const { satCount, satDistanceSun, ringName, ringType, sideExtensionDeg, eccentricity, argPeri, earthMarsInclinationPct } = config;
    if (satCount == 0) return null;
    let orbitalElements = {};
    if (ringType == "Circular") {
      const a = satDistanceSun;
      const n = this.meanMotion(a);
      const long = 0;
      orbitalElements = {
        ringName,
        satCount,
        ...this.getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long),
      };
    } else if (ringType == "Eccentric") {
      const a = satDistanceSun;
      const n = this.meanMotion(a);
      const long = 0;
      orbitalElements = {
        ringName,
        satCount,
        ...this.getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long),
      };
    } else {
      const { a, n } = this.getParams_a_n(ringType);
      const satCountOneSide = Math.ceil(satCount / 2);
      const satCount2 = satCountOneSide * 2 - (sideExtensionDeg == 180 ? 1 : 0);
      const long = 0;
      orbitalElements = {
        ringName,
        satCount: satCount2,
        ...this.getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long),
      };
    }
    return orbitalElements;
  }

  getParams_a_n(ringType) {
    let a, n;
    if (ringType == "Mars") {
      a = 1.5236365;
      n = 0.5240613;
    } else if (ringType == "Earth") {
      a = 1.00002;
      n = 0.9855796;
    }
    return { a, n };
  }

  generateSatellite(ringName, ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long, orbitdays, name, neighbors) {
    const elements = this.getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long);
    const satelliteData = {
      name,
      ...elements,
      diameterKm: 10000,
      orbitdays: orbitdays,
      rotationHours: 0,
      Dele: 2450680.5,
      color: [255, 255, 255],
      long,
      ringName,
      ringType,
      neighbors,
    };
    return satelliteData;
  }

  getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long) {
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
        l: (328.40353 + long + 360) % 360,
      };
    else if (ringType == "Circular")
      return {
        i: (earthMarsInclinationPct / 100) * 1.84992,
        o: 49.5664, //RAAN
        p: 0, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
        l: long,
      };
    else if (ringType == "Eccentric")
      return {
        i: (earthMarsInclinationPct / 100) * 1.84992,
        o: 49.5664, //RAAN
        p: argPeri, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
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

  meanMotion(a, m = 0) {
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
}
