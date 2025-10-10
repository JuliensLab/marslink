// simSatellites.js

import { helioCoords } from "./simOrbits.js?v=4.3";

export class SimSatellites {
  constructor(simLinkBudget) {
    this.simLinkBudget = simLinkBudget;
    this.satellites = [];
    this.orbitalElements = [];
  }

  calculateGbps = (distanceKm) => {
    return this.simLinkBudget.calculateGbps(distanceKm);
  };

  calculateKm = (gbps) => {
    return this.simLinkBudget.calculateKm(gbps);
  };

  convertAUtoKM = (distanceAU) => {
    return this.simLinkBudget.convertAUtoKM(distanceAU);
  };

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
    // console.log(this.orbitalElements);
  }

  updateSatellitesPositions(simDaysSinceStart) {
    for (const satellite of this.satellites) satellite.position = helioCoords(satellite, simDaysSinceStart);
    return this.satellites;
  }

  generateSatellites(config) {
    const {
      satCount,
      satDistanceSun,
      ringName,
      ringType,
      sideExtensionDeg,
      eccentricity,
      argPeri,
      earthMarsInclinationPct,
      gradientOneSideStartMbps,
    } = config;
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
      const { a, n } = this.getParams_a_n(ringType); //Earth or Mars

      const orbitdays = 360 / n;
      const satCountOneSide = Math.ceil(satCount / 2);
      const longIncrement = sideExtensionDeg / satCountOneSide;

      if (gradientOneSideStartMbps) {
        // change to take the worst distance (orbit point with longest distance from sun) instead of average. This needs to calculate the straight line distance, not the circular distance.
        const satCountIfFullRing = Math.round(360 / longIncrement);
        const orbitCircumferenceKm = 2 * Math.PI * this.convertAUtoKM(a);
        const inringAvgDistKm = gradientOneSideStartMbps ? orbitCircumferenceKm / satCountIfFullRing : null;
        const inringAvgMbps = gradientOneSideStartMbps ? this.calculateGbps(inringAvgDistKm) * 1000 : null;
        // if (gradientOneSideStartMbps) console.log("inringAvgDistKm", inringAvgDistKm, "inringAvgMbps", inringAvgMbps);
        let perInterringLinkMbps = gradientOneSideStartMbps ? gradientOneSideStartMbps / (satCountIfFullRing / 2) : null;
        let requiredThroughputMbps = gradientOneSideStartMbps;

        // console.log(
        //   ringType,
        //   "satCountOneSide",
        //   satCountOneSide,
        //   "satCountIfFullRing",
        //   satCountIfFullRing,
        //   "orbitCircumferenceKm",
        //   orbitCircumferenceKm,
        //   "sideExtensionDeg",
        //   sideExtensionDeg,
        //   "longIncrement",
        //   longIncrement,
        //   "gradientOneSideStartMbps",
        //   gradientOneSideStartMbps,
        //   "inringAvgDistKm",
        //   inringAvgDistKm,
        //   "inringAvgMbps",
        //   inringAvgMbps,
        //   "requiredThroughputMbps",
        //   requiredThroughputMbps
        // );

        let satId = 0;
        let longiDeg = 0;
        while (longiDeg < sideExtensionDeg - longIncrement) {
          // console.log("longiDeg", longiDeg, "sideExtensionDeg", sideExtensionDeg);
          // calculate next distance
          const nextDistKm = this.calculateKm(requiredThroughputMbps / 1000);
          // convert to degrees
          const longIncrementGradient = (360 * nextDistKm) / orbitCircumferenceKm;
          const selectedIncrement = Math.min(longIncrementGradient, longIncrement);
          longiDeg += selectedIncrement;

          // console.log(
          //   "nextDistKm",
          //   nextDistKm,
          //   "longIncrementGradient",
          //   longIncrementGradient,
          //   "selectedIncrement",
          //   selectedIncrement,
          //   "longiDeg",
          //   longiDeg
          // );

          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              longiDeg,
              orbitdays,
              `${ringName}-${satId}`,
              [satId == 0 ? `${ringType}` : `${ringName}-${satId - 1}`, `${ringName}-${satId + 1}`]
            )
          );
          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              -longiDeg,
              orbitdays,
              `${ringName}--${satId}`,
              [satId == 0 ? `${ringType}` : `${ringName}--${satId - 1}`, `${ringName}--${satId + 1}`]
            )
          );

          // decrease required throughput by the amount of one interring link.
          requiredThroughputMbps -= perInterringLinkMbps;
          satId++;
          if (longIncrementGradient > longIncrement) break;
        }

        while (longiDeg < sideExtensionDeg - longIncrement) {
          // console.log("longiDeg", longiDeg, "sideExtensionDeg", sideExtensionDeg);
          const selectedIncrement = longIncrement;
          longiDeg += selectedIncrement;

          // console.log("selectedIncrement", selectedIncrement, "longiDeg", longiDeg);

          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              longiDeg,
              orbitdays,
              `${ringName}-${satId}`,
              [`${ringName}-${satId - 1}`, `${ringName}-${satId + 1}`]
            )
          );
          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              -longiDeg,
              orbitdays,
              `${ringName}--${satId}`,
              [`${ringName}--${satId - 1}`, `${ringName}--${satId + 1}`]
            )
          );

          // decrease required throughput by the amount of one interring link.
          requiredThroughputMbps -= perInterringLinkMbps;
          satId++;
        }

        longiDeg += longIncrement;

        // final sat of the chain
        if (sideExtensionDeg == 180) {
          const long = 180;

          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              long,
              orbitdays,
              `${ringName}-${satId}`,
              [`${ringName}-${satId - 1}`, `${ringName}--${satId - 1}`]
            )
          );
        } else {
          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              longiDeg,
              orbitdays,
              `${ringName}-${satId}`,
              [`${ringName}-${satId - 1}`]
            )
          );
          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              -longiDeg,
              orbitdays,
              `${ringName}--${satId}`,
              [`${ringName}--${satId - 1}`]
            )
          );
        }
      } else {
        let satId = 0;
        for (let i = 0; i < satCountOneSide; i++) {
          // positive side
          const long = (i + 1) * longIncrement;
          const name = `${ringName}-${satId}`;
          const neighbors = [];
          if (satId == 0) neighbors.push(`${ringType}`);
          if (satId > 0) neighbors.push(`${ringName}-${satId - 1}`);
          if (i < satCountOneSide - 1) neighbors.push(`${ringName}-${satId + 1}`);
          satellites.push(
            this.generateSatellite(
              ringName,
              ringType,
              a,
              n,
              eccentricity,
              argPeri,
              earthMarsInclinationPct,
              long,
              orbitdays,
              name,
              neighbors
            )
          );
          if (!(sideExtensionDeg == 180 && i == satCountOneSide - 1)) {
            // negative side with same longitude
            const name = `${ringName}--${satId}`;
            const neighbors = [];
            if (satId == 0) neighbors.push(`${ringType}`);
            if (satId > 0) neighbors.push(`${ringName}--${satId - 1}`);
            if (i < satCountOneSide - 1) neighbors.push(`${ringName}--${satId + 1}`);
            if (sideExtensionDeg == 180 && i == satCountOneSide - 2) neighbors.push(`${ringName}-${satId + 1}`);
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
          satId++;
        }
      }
      console.log(ringType, satellites);
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

  calculateInclination(a, earthMarsInclinationPct) {
    const a_min = 1.00002;
    const a_max = 1.5236365;
    const i_min = 0.00041;
    const i_max = 1.84992;
    let properInclination;

    // Calculate properInclination based on a
    if (a <= a_min) {
      properInclination = i_min;
    } else if (a >= a_max) {
      properInclination = i_max;
    } else {
      properInclination = i_min + ((i_max - i_min) * (a - a_min)) / (a_max - a_min);
    }

    // Calculate inclination based on earthMarsInclinationPct
    let inclination;
    if (earthMarsInclinationPct <= 50) {
      inclination = i_min + (properInclination - i_min) * (earthMarsInclinationPct / 50);
    } else {
      inclination = properInclination + (i_max - properInclination) * ((earthMarsInclinationPct - 50) / 50);
    }

    return inclination;
  }

  calculateApsides(a, e) {
    const periapsis = a * (1 - e);
    const apoapsis = a * (1 + e);
    return { periapsis, apoapsis };
  }
  apsidesEarth = this.calculateApsides(1.00002, 0.0166967);

  getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long) {
    const apsides = this.calculateApsides(a, eccentricity);
    apsides.apo_pctEarth = apsides.apoapsis / this.apsidesEarth.apoapsis;
    if (ringType == "Mars")
      return {
        i: 1.84992,
        o: 49.5664,
        p: 336.0882,
        a: a ? a : 1.5236365,
        n: n ? n : 0.5240613,
        e: 0.0934231,
        l: (262.42784 + long + 360) % 360,
        apsides,
      };
    else if (ringType == "Earth")
      return {
        i: 0.00041,
        o: 349.2,
        p: 102.8517,
        a: a ? a : 1.00002,
        n: n ? n : 0.9855796,
        e: 0.0166967,
        l: (328.40353 + long + 360) % 360,
        apsides,
      };
    else if (ringType == "Circular")
      return {
        i: this.calculateInclination(a, earthMarsInclinationPct),
        o: 49.5664, //RAAN
        p: 0, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
        l: long,
        apsides,
      };
    else if (ringType == "Eccentric")
      return {
        i: this.calculateInclination(a, earthMarsInclinationPct),
        o: 49.5664, //RAAN
        p: argPeri, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
        l: long,
        apsides,
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
