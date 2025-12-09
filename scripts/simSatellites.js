// simSatellites.js

import { helioCoords } from "./simOrbits.js?v=4.3";

export class SimSatellites {
  constructor(simLinkBudget, planets) {
    this.simLinkBudget = simLinkBudget;
    this.Earth = planets.find((p) => p.name === "Earth");
    this.Mars = planets.find((p) => p.name === "Mars");
    this.apsidesEarth = this.calculateApsides(this.Earth.a, this.Earth.e);

    this.satellites = [];
    this.orbitalElements = [];
    this.maxSatCount = 20000; // Default high limit
    this.solarAngleStep = 1.0; // Degrees for precomputing positions along orbit
    this.ringCrossings = new Map(); // ringName -> { earth: [...], mars: [...] }
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

  setMaxSatCount(maxSatCount) {
    this.maxSatCount = maxSatCount;
  }

  getSatellites() {
    return this.satellites;
  }

  getOrbitalElements() {
    return this.orbitalElements;
  }

  getRingCrossings() {
    return this.ringCrossings;
  }

  setSatellitesConfig(satellitesConfig) {
    this.satellites = [];
    const newSatellites = [];
    for (let config of satellitesConfig) newSatellites.push(...this.generateSatellites(config));
    this.satellites = newSatellites.slice(0, this.maxSatCount);
    this.setOrbitalElements(satellitesConfig);
    // console.log(`${this.satellites.length} SATELLITES`);
  }

  setOrbitalElements(satellitesConfig) {
    this.orbitalElements = [];
    const newOrbitalElements = [];
    for (let config of satellitesConfig) {
      const orbitalElement = this.generateOrbitalElements(config);
      if (orbitalElement) {
        // Precompute positions along the orbit at solar angle steps
        orbitalElement.precomputedPositions = this.precomputeOrbitPositions(orbitalElement);
        newOrbitalElements.push(orbitalElement);
      }
    }
    this.orbitalElements = newOrbitalElements;
    console.log(this.orbitalElements);

    // Precompute ring crossings
    this.ringCrossings = new Map();
    const earthOrbit = this.orbitalElements.find((ele) => ele.ringName === "ring_earth");
    const marsOrbit = this.orbitalElements.find((ele) => ele.ringName === "ring_mars");
    for (const orbitalElement of this.orbitalElements) {
      const ringName = orbitalElement.ringName;
      if (ringName === "ring_earth" || ringName === "ring_mars") continue;
      const earthCrossings = this.findAllRadialCrossings(orbitalElement, earthOrbit);
      const marsCrossings = this.findAllRadialCrossings(orbitalElement, marsOrbit);
      this.ringCrossings.set(ringName, { earth: earthCrossings, mars: marsCrossings });
    }
    console.log(this.ringCrossings);
  }

  precomputeOrbitPositions(orbitalElement) {
    const positions = [];
    const steps = 360 / this.solarAngleStep; // Number of steps around the orbit

    // Use J2000 epoch as reference date
    const baseDate = new Date("2000-01-01T12:00:00Z");

    // Vary the mean longitude to get positions at different solar angles
    for (let step = 0; step < steps; step++) {
      const meanLongitude = (step * this.solarAngleStep) % 360;

      // Create a dummy satellite object with modified mean longitude
      const dummySatellite = {
        ...orbitalElement,
        l: meanLongitude,
      };

      const position = helioCoords(dummySatellite, baseDate);
      const distanceToSun = Math.sqrt(position.x * position.x + position.y * position.y + position.z * position.z);

      positions.push({
        solarAngle: position.solarAngle,
        distanceToSun: distanceToSun,
        x: position.x,
        y: position.y,
        z: position.z,
      });
    }

    // Sort by solar angle
    positions.sort((a, b) => a.solarAngle - b.solarAngle);

    return positions;
  }

  updateSatellitesPositions(simDaysSinceStart) {
    for (const satellite of this.satellites) {
      satellite.position = helioCoords(satellite, simDaysSinceStart);
      satellite.orbitalZone = this.getRadialZone(satellite, satellite.ringName);
    }
    return this.satellites;
  }

  // Find crossings between two orbits by comparing distances to sun
  distanceToSunAtSolarAngle(sourceEle, targetEle) {
    const crossings = [];
    const sourcePositions = sourceEle.precomputedPositions;
    const targetPositions = targetEle.precomputedPositions;

    if (!sourcePositions || !targetPositions) return crossings;

    let prevSourceDist = sourcePositions[0].distanceToSun;
    let prevTargetDist = targetPositions[0].distanceToSun;

    // Iterate through all solar angles
    for (let i = 1; i < sourcePositions.length; i++) {
      const sourceDist = sourcePositions[i].distanceToSun;
      const targetDist = targetPositions[i].distanceToSun;

      // Check for crossing (sign change in distance difference)
      const prevDiff = prevSourceDist - prevTargetDist;
      const currDiff = sourceDist - targetDist;

      if (prevDiff * currDiff <= 0) {
        // Find the exact crossing point using linear interpolation
        const solarAngle = sourcePositions[i].solarAngle;
        crossings.push(solarAngle);
      }

      prevSourceDist = sourceDist;
      prevTargetDist = targetDist;
    }

    // Remove duplicates and sort
    const unique = [];
    for (const c of crossings) {
      if (!unique.some((u) => Math.abs(u - c) < 0.01)) unique.push(c);
    }
    unique.sort((a, b) => a - b);

    return unique;
  }

  // Find all radial crossing solar angle angles (on source orbit) with target orbit
  findAllRadialCrossings(sourceEle, targetEle) {
    // Handle case where source or target orbit doesn't exist (no Earth/Mars rings)
    if (!sourceEle || !targetEle) {
      if (!sourceEle) console.warn("Source orbit is missing, no crossings.");
      if (!targetEle) console.warn("Target orbit is missing, no crossings.");
      return { crossings: [], inside: null, outside: null };
    }

    const crossings = [];
    const sourcePositions = sourceEle.precomputedPositions;
    const targetPositions = targetEle.precomputedPositions;

    if (!sourcePositions || !targetPositions || sourcePositions.length < 2 || targetPositions.length < 2) {
      console.warn("Insufficient precomputed positions for crossing calculation.");
      return { crossings: [], inside: null, outside: null };
    }

    // Find crossings between line segments of the two orbits
    for (let i = 0; i < sourcePositions.length; i++) {
      const source1 = sourcePositions[i];
      const source2 = sourcePositions[(i + 1) % sourcePositions.length];

      for (let j = 0; j < targetPositions.length; j++) {
        const target1 = targetPositions[j];
        const target2 = targetPositions[(j + 1) % targetPositions.length];

        // Check if line segments intersect (using XY coordinates only)
        const intersection = this.lineSegmentIntersection(
          { x: source1.x, y: source1.y },
          { x: source2.x, y: source2.y },
          { x: target1.x, y: target1.y },
          { x: target2.x, y: target2.y }
        );

        if (intersection) {
          // Calculate solar angle at intersection point
          // Interpolate between the two solar angles based on position along the line
          const solarAngle = this.interpolateSolarAngle(source1, source2, intersection);
          crossings.push(solarAngle % 360);
        }
      }
    }

    // Remove duplicates and sort
    const unique = [];
    for (const c of crossings) {
      if (!unique.some((u) => Math.abs(u - c) < 0.01)) unique.push(c);
    }
    unique.sort((a, b) => a - b);

    // Determine inside and outside ranges (simplified version)
    let inside = null;
    let outside = null;

    if (unique.length === 0) {
      // No crossings - determine based on distance at solar angle 0
      const sourceDist = sourcePositions[0].distanceToSun;
      const targetDist = targetPositions[0].distanceToSun;
      if (sourceDist > targetDist) {
        console.log(`No crossings. Source (${sourceDist}) > Target (${targetDist}). Outside.`);
        outside = [0, 360];
      } else {
        console.log(`No crossings. Source (${sourceDist}) <= Target (${targetDist}). Inside.`);
        inside = [0, 360];
      }
    } else if (unique.length >= 2) {
      console.log(`Multiple crossings found: ${unique.length} crossings.`);
      // Determine which range is inside by checking distance at midpoint
      const midAngle = (unique[0] + unique[1]) / 2;
      const sourceDist = this.getOrbitDistanceAtAngle(sourceEle, midAngle);
      const targetDist = this.getOrbitDistanceAtAngle(targetEle, midAngle);
      if (sourceDist < targetDist) {
        // Source is closer to sun, so inside
        inside = [unique[0], unique[1]];
        outside = [unique[1], unique[0] + 360];
      } else {
        // Source is farther, so outside
        inside = [unique[1], unique[0] + 360];
        outside = [unique[0], unique[1]];
      }
    }

    return { crossings: unique, inside, outside };
  }

  // Line segment intersection using XY coordinates
  lineSegmentIntersection(p1, p2, p3, p4) {
    const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(denom) < 1e-10) return null; // Parallel lines

    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom;
    const u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / denom;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      // Intersection point
      return {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y),
      };
    }

    return null;
  }

  // Interpolate solar angle between two positions
  interpolateSolarAngle(pos1, pos2, intersectionPoint) {
    // Calculate parameter t along the line from pos1 to pos2
    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    const length = Math.sqrt(dx * dx + dy * dy);

    if (length < 1e-10) return pos1.solarAngle;

    const dxIntersect = intersectionPoint.x - pos1.x;
    const dyIntersect = intersectionPoint.y - pos1.y;
    const distAlongLine = Math.sqrt(dxIntersect * dxIntersect + dyIntersect * dyIntersect);

    const t = distAlongLine / length;
    const solarAngleDiff = pos2.solarAngle - pos1.solarAngle;

    // Handle wrap-around at 360 degrees
    let adjustedDiff = solarAngleDiff;
    if (Math.abs(solarAngleDiff) > 180) {
      adjustedDiff = solarAngleDiff > 0 ? solarAngleDiff - 360 : solarAngleDiff + 360;
    }

    return (pos1.solarAngle + t * adjustedDiff) % 360;
  }

  // Helper: Check if angle is within a range, handling wrap-around
  isAngleInRange(angle, range) {
    if (!range) return false;
    let [start, end] = range;
    angle = ((angle % 360) + 360) % 360;
    if (end <= 360) {
      return angle >= start && angle <= end;
    } else {
      // Wrap-around case
      return angle >= start || angle <= end - 360;
    }
  }

  // Helper: Get distance to sun for a specific orbital element at a specific solar angle
  getOrbitDistanceAtAngle(orbitalElement, targetAngle) {
    if (!orbitalElement || !orbitalElement.precomputedPositions) return null;

    const positions = orbitalElement.precomputedPositions;
    // Normalize angle to 0-360
    let angle = ((targetAngle % 360) + 360) % 360;

    // optimization: since we know solarAngleStep is 1.0 and array is sorted,
    // we can guess the index. But to be safe and robust against changing step sizes:
    // specific implementation for finding the two surrounding points.

    // Find index where positions[i].solarAngle <= angle
    // Since it's sorted, we could use binary search, but linear is fine for <1000 items
    // or simplified index mapping if step is fixed.

    let index = -1;
    // Assuming sorted array from precomputeOrbitPositions
    if (this.solarAngleStep === 1.0 && positions.length >= 360) {
      // Fast lookup if step is 1 degree
      index = Math.floor(angle);
      // Safety clamp in case of float weirdness or array length mismatch
      if (index >= positions.length) index = positions.length - 1;
    } else {
      // Fallback search
      for (let i = 0; i < positions.length; i++) {
        if (positions[i].solarAngle <= angle) {
          index = i;
        } else {
          break;
        }
      }
    }

    if (index === -1) index = positions.length - 1; // Wrap around case handled below

    const p1 = positions[index];
    const p2 = positions[(index + 1) % positions.length];

    // Handle wrap around for interpolation (e.g. angle 359.5 to 0.5)
    let ang1 = p1.solarAngle;
    let ang2 = p2.solarAngle;
    if (ang2 < ang1) ang2 += 360;
    let calcAngle = angle;
    if (calcAngle < ang1) calcAngle += 360;

    // Linear Interpolation of distance
    const t = ang2 - ang1 === 0 ? 0 : (calcAngle - ang1) / (ang2 - ang1);

    return p1.distanceToSun + t * (p2.distanceToSun - p1.distanceToSun);
  }

  // Get radial zone for a satellite
  getRadialZone(satellite, ringName) {
    if (ringName === "ring_earth") return "EARTH_RING";
    if (ringName === "ring_mars") return "MARS_RING";

    if (!this.ringCrossings.has(ringName)) return "ALLOWED 1";
    const crossings = this.ringCrossings.get(ringName);
    if (!crossings) return "ALLOWED 2";

    const solarAngle = satellite.position.solarAngle;
    const angle = ((solarAngle % 360) + 360) % 360;

    const insideEarth = this.isAngleInRange(angle, crossings.earth.inside);
    const outsideMars = this.isAngleInRange(angle, crossings.mars.outside);

    if (insideEarth) return "INSIDE_EARTH";
    if (outsideMars) return "OUTSIDE_MARS";
    return "BETWEEN_EARTH_AND_MARS";
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
    }
    console.log(ringName, satellites);
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
      a = this.Mars.a;
      n = this.Mars.n;
    } else if (ringType == "Earth") {
      a = this.Earth.a;
      n = this.Earth.n;
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
      Dele: this.Mars.Dele,
      color: [255, 255, 255],
      long,
      ringName,
      ringType,
      neighbors,
    };
    return satelliteData;
  }

  calculateInclination(a, earthMarsInclinationPct) {
    const a_min = this.Earth.a;
    const a_max = this.Mars.a;
    const i_min = this.Earth.i;
    const i_max = this.Mars.i;
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

  getOrbitaElements(ringType, a, n, eccentricity, argPeri, earthMarsInclinationPct, long) {
    const apsides = this.calculateApsides(a, eccentricity);
    apsides.apo_pctEarth = apsides.apoapsis / this.apsidesEarth.apoapsis;
    if (ringType == "Mars")
      return {
        i: this.Mars.i,
        o: this.Mars.o,
        p: this.Mars.p,
        a: a ? a : this.Mars.a,
        n: n ? n : this.Mars.n,
        e: this.Mars.e,
        l: (this.Mars.l + long + 360) % 360,
        Dele: this.Mars.Dele, // J2000 epoch
        apsides,
      };
    else if (ringType == "Earth")
      return {
        i: this.Earth.i,
        o: this.Earth.o,
        p: this.Earth.p,
        a: a ? a : this.Earth.a,
        n: n ? n : this.Earth.n,
        e: this.Earth.e,
        l: (this.Earth.l + long + 360) % 360,
        Dele: this.Earth.Dele, // J2000 epoch
        apsides,
      };
    else if (ringType == "Circular")
      return {
        i: this.calculateInclination(a, earthMarsInclinationPct),
        o: this.Mars.o, //RAAN
        p: 0, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
        l: long,
        Dele: this.Mars.Dele, // J2000 epoch
        apsides,
      };
    else if (ringType == "Eccentric")
      return {
        i: this.calculateInclination(a, earthMarsInclinationPct),
        o: this.Mars.o, //RAAN
        p: argPeri, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
        l: long,
        Dele: this.Mars.Dele, // J2000 epoch
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
