// simSatellites.js

import { helioCoords, positionFromSolarAngle } from "./simOrbits.js?v=4.3";

export class SimSatellites {
  constructor(simLinkBudget, planets) {
    this.simLinkBudget = simLinkBudget;
    this.Earth = planets.find((p) => p.name === "Earth");
    this.Mars = planets.find((p) => p.name === "Mars");
    this.apsidesEarth = this.calculateApsides(this.Earth.a, this.Earth.e);
    this.apsidesMars = this.calculateApsides(this.Mars.a, this.Mars.e);

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

  getEarth() {
    return this.Earth;
  }

  getMars() {
    return this.Mars;
  }

  getEarthApsis() {
    return this.apsidesEarth;
  }

  getMarsApsis() {
    return this.apsidesMars;
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

    // Initialize suitable to null
    for (const orbitalElement of this.orbitalElements) {
      const ringName = orbitalElement.ringName;
      if (ringName === "ring_earth" || ringName === "ring_mars") continue;
      const crossings = this.ringCrossings.get(ringName);
      crossings.earth.suitable = null;
      crossings.mars.suitable = null;
    }

    // Compute suitable ranges
    this.computeSuitableRanges("earth");
    this.computeSuitableRanges("mars");

    console.log(this.ringCrossings);
  }

  computeSuitableRanges(target) {
    const isEarth = target === "earth";
    const sortedRings = this.orbitalElements
      .filter((e) => e.ringName !== "ring_earth" && e.ringName !== "ring_mars")
      .sort((a, b) => (isEarth ? a.a - b.a : b.a - a.a)); // Near to far for Earth, far to near for Mars

    const crossingsKey = isEarth ? "earth" : "mars";
    const targetOrbit = isEarth
      ? this.orbitalElements.find((ele) => ele.ringName === "ring_earth")
      : this.orbitalElements.find((ele) => ele.ringName === "ring_mars");

    // Shortlist rings with crossings
    let shortlist = sortedRings.filter((r) => {
      const crossings = this.ringCrossings.get(r.ringName)[crossingsKey];
      return crossings.crossings.length > 0;
    });

    // Add the next orbit after the last with crossings
    if (shortlist.length > 0) {
      const lastCrossingRing = shortlist[shortlist.length - 1];
      const lastIndex = sortedRings.findIndex((r) => r.ringName === lastCrossingRing.ringName);
      if (lastIndex + 1 < sortedRings.length) {
        shortlist.push(sortedRings[lastIndex + 1]);
      }
    }

    // If no crossings, assign the entire range to the best ring
    if (shortlist.length === 0) {
      let bestDist = isEarth ? Infinity : -Infinity;
      let bestRing = null;
      for (const ring of sortedRings) {
        const pos = this.getOrbitPositionAtAngle(ring, 0); // Use solar angle 0 for simplicity
        if (pos) {
          const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
          const targetPos = this.getOrbitPositionAtAngle(targetOrbit, 0);
          if (targetPos) {
            const targetDist = Math.sqrt(targetPos.x * targetPos.x + targetPos.y * targetPos.y);
            const condition = isEarth ? dist > targetDist : dist < targetDist;
            if (condition) {
              if (isEarth ? dist < bestDist : dist > bestDist) {
                bestDist = dist;
                bestRing = ring;
              }
            }
          }
        }
      }
      if (bestRing) {
        shortlist = [bestRing];
      }
    }

    // Crossings solar angles
    let crossingsSolarAngles = [0, 360];
    for (const ring of shortlist) {
      const crossings = this.ringCrossings.get(ring.ringName)[crossingsKey].crossings;
      crossingsSolarAngles.push(...crossings);
    }
    crossingsSolarAngles = [...new Set(crossingsSolarAngles)].sort((a, b) => a - b);

    // Create ranges
    let ranges = [];
    for (let i = 0; i < crossingsSolarAngles.length - 1; i++) {
      ranges.push([crossingsSolarAngles[i], crossingsSolarAngles[i + 1]]);
    }

    // Assign ranges to rings
    for (const range of ranges) {
      const midpoint = (range[0] + range[1]) / 2;
      let bestDist = isEarth ? Infinity : -Infinity;
      let bestRing = null;
      for (const ring of shortlist) {
        const pos = this.getOrbitPositionAtAngle(ring, midpoint);
        if (pos) {
          const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
          // Get target's position at midpoint
          const targetPos = this.getOrbitPositionAtAngle(targetOrbit, midpoint);
          if (targetPos) {
            const targetDist = Math.sqrt(targetPos.x * targetPos.x + targetPos.y * targetPos.y);
            const condition = isEarth ? dist > targetDist : dist < targetDist;
            if (condition) {
              if (isEarth ? dist < bestDist : dist > bestDist) {
                bestDist = dist;
                bestRing = ring;
              }
            }
          }
        }
      }
      if (bestRing) {
        const crossings = this.ringCrossings.get(bestRing.ringName)[crossingsKey];
        if (!crossings.suitable) crossings.suitable = [];
        crossings.suitable.push(range);
      }
    }
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
      if (satellite.ringName !== "ring_earth" && satellite.ringName !== "ring_mars") {
        const crossings = this.ringCrossings.get(satellite.ringName);
        if (crossings) {
          const suitable = [];
          if (
            crossings.earth.suitable &&
            crossings.earth.suitable.some((range) => this.isAngleInRange(satellite.position.solarAngle, range))
          ) {
            suitable.push("Earth");
          }
          if (
            crossings.mars.suitable &&
            crossings.mars.suitable.some((range) => this.isAngleInRange(satellite.position.solarAngle, range))
          ) {
            suitable.push("Mars");
          }
          if (suitable.length > 0) {
            satellite.suitable = suitable;
          } else {
            delete satellite.suitable;
          }
        }
      }
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
        // console.log(`No crossings. Source (${sourceDist}) > Target (${targetDist}). Outside.`);
        outside = [0, 360];
      } else {
        // console.log(`No crossings. Source (${sourceDist}) <= Target (${targetDist}). Inside.`);
        inside = [0, 360];
      }
    } else if (unique.length >= 2) {
      // console.log(`Multiple crossings found: ${unique.length} crossings.`);
      // Determine which range is inside by checking distance at midpoint
      const midAngle = (unique[0] + unique[1]) / 2;
      const sourcePos = this.getOrbitPositionAtAngle(sourceEle, midAngle);
      const sourceDist = Math.sqrt(sourcePos.x ** 2 + sourcePos.y ** 2 + sourcePos.z ** 2);
      const targetPos = this.getOrbitPositionAtAngle(targetEle, midAngle);
      const targetDist = Math.sqrt(targetPos.x ** 2 + targetPos.y ** 2 + targetPos.z ** 2);
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

  // Helper: Get position (x,y,z) for a specific orbital element at a specific solar angle
  getOrbitPositionAtAngle(orbitalElement, targetAngle) {
    if (!orbitalElement) return null;
    const pos = positionFromSolarAngle(orbitalElement, targetAngle);
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  // Get radial zone for a satellite
  getRadialZone(satellite, ringName) {
    if (ringName === "ring_earth") return "EARTH_RING";
    if (ringName === "ring_mars") return "MARS_RING";

    if (!this.ringCrossings.has(ringName)) return "ALLOWED 1";
    const crossings = this.ringCrossings.get(ringName);
    if (!crossings) return "ALLOWED 2";

    const solarAngle = satellite.position.solarAngle;
    if (isNaN(solarAngle)) console.log(`NaN solarAngle in getRadialZone for satellite:`, satellite);
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
    } else if (ringType == "Adapted") {
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
    // console.log(ringName, satellites);
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
    } else if (ringType == "Adapted") {
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

  interpolateOrbitalElementNonLinear(a, targetElement) {
    const a_min = this.Earth.a;
    const a_max = this.Mars.a;
    const t_min = 0;
    const t_max = this.Mars[targetElement];
    let interpolatedElement;

    // Calculate interpolatedElement based on a
    if (a <= a_min) {
      interpolatedElement = t_min;
    } else if (a >= a_max) {
      interpolatedElement = t_max;
    } else {
      interpolatedElement = t_min + ((t_max - t_min) * (a - a_min)) / (a_max - a_min);
    }

    return interpolatedElement;
  }

  interpolateOrbitalElement(a, targetElement) {
    const a_min = this.Earth.a;
    const a_max = this.Mars.a;
    const t_min = this.Earth[targetElement];
    const t_max = this.Mars[targetElement];
    let interpolatedElement;

    // Calculate interpolatedElement based on a
    if (a <= a_min) {
      interpolatedElement = t_min;
    } else if (a >= a_max) {
      interpolatedElement = t_max;
    } else {
      interpolatedElement = t_min + ((t_max - t_min) * (a - a_min)) / (a_max - a_min);
    }

    return interpolatedElement;
  }

  addInterpolationBias(interpolatedElement, earthMarsBiasPct, targetElement) {
    const t_min = this.Earth[targetElement];
    const t_max = this.Mars[targetElement];
    // Calculate element value based on earthMarsBiasPct
    let biasedInterpolatedElement;
    if (earthMarsBiasPct <= 50) {
      biasedInterpolatedElement = t_min + (interpolatedElement - t_min) * (earthMarsBiasPct / 50);
    } else {
      biasedInterpolatedElement = interpolatedElement + (t_max - interpolatedElement) * ((earthMarsBiasPct - 50) / 50);
    }

    return biasedInterpolatedElement;
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
        i: this.addInterpolationBias(this.interpolateOrbitalElement(a, "i"), earthMarsInclinationPct, "i"),
        o: this.Mars.o, //RAAN
        p: 0, // arg perigee
        a: a,
        n: n,
        e: eccentricity,
        l: long,
        Dele: this.Mars.Dele, // J2000 epoch
        apsides,
      };
    else if (ringType == "Adapted")
      return {
        i: this.addInterpolationBias(this.interpolateOrbitalElement(a, "i"), 50, "i"),
        o: this.Mars.o, //RAAN
        p: this.Mars.p, //this.interpolateOrbitalElementNonLinear(a, "p"), // arg perigee
        a: a,
        n: n,
        e: this.interpolateOrbitalElementNonLinear(a, "e"),
        l: long,
        Dele: this.Mars.Dele, // J2000 epoch
        apsides,
      };
    else if (ringType == "Eccentric")
      return {
        i: this.addInterpolationBias(this.interpolateOrbitalElement(a, "i"), earthMarsInclinationPct, "i"),
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

  mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0].slice()];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      const curr = ranges[i];
      if (curr[0] <= last[1]) {
        last[1] = Math.max(last[1], curr[1]);
      } else {
        merged.push(curr.slice());
      }
    }
    return merged;
  }

  aggregateRanges(current, newRange) {
    return this.mergeRanges([...current, newRange]);
  }

  isFullRange(ranges) {
    const merged = this.mergeRanges(ranges);
    let total = 0;
    for (const r of merged) {
      total += r[1] - r[0];
    }
    return total >= 360;
  }
}
