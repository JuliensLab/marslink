// simSatellites.js

import { helioCoords, positionFromSolarAngle } from "./simOrbits.js?v=4.6";
import { SIM_CONSTANTS } from "./simConstants.js?v=4.6";

export class SimSatellites {
  constructor(simLinkBudget, planets) {
    this.simLinkBudget = simLinkBudget;
    this.Earth = planets.find((p) => p.name === "Earth");
    this.Mars = planets.find((p) => p.name === "Mars");
    this.apsidesEarth = this.calculateApsides(this.Earth.a, this.Earth.e);
    this.apsidesMars = this.calculateApsides(this.Mars.a, this.Mars.e);

    this.satellites = [];
    this.orbitalElements = [];
    // Adapted-ring orbital-plane blends: 0% = Earth's value, 100% = Mars's.
    // Set per-build (from the ring config) in setSatellitesConfig; read in
    // getOrbitaElements. RAAN and argument of perigee are independent sliders.
    this.adaptedRaanPct = 100;
    this.adaptedArgPeriPct = 100;
    this.adaptedEccentricityPct = 100;
    this.maxSatCount = 20000; // Default high limit
    this.requestedSatelliteCount = 0; // sats requested before the maxSatCount cap
    this.satellitesTruncated = false; // true when the cap clipped the constellation
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

  safeAsin(x) {
    return Math.asin(Math.max(-1, Math.min(1, x)));
  }

  /**
   * Build the full satellitesConfig array from a user-facing uiConfig.
   *
   * Single source of truth for the array shape: SimMain.setSatellitesConfig
   * (live path) and simWorker (parallel sensitivity scenarios) both call this.
   * Pure with respect to instance geometry (simLinkBudget + planet elements);
   * does not mutate satellite state.
   */
  buildConfigFromUi(uiConfig) {
    const satellitesConfig = [];
    satellitesConfig.push(...this._buildCircularRings(uiConfig));
    satellitesConfig.push(...this._buildAdaptedRings(uiConfig));
    satellitesConfig.push(...this._buildEccentricRings(uiConfig));
    if (uiConfig["ring_mars.side-extension-degrees-slider"]) satellitesConfig.push(...this._buildPlanetRing(uiConfig, "ring_mars"));
    if (uiConfig["ring_earth.side-extension-degrees-slider"]) satellitesConfig.push(...this._buildPlanetRing(uiConfig, "ring_earth"));
    return satellitesConfig;
  }

  _buildCircularRings(uiConfig) {
    let ringCount = uiConfig["circular_rings.ringcount"];
    if (ringCount == 0) return [];
    ringCount += 2;
    const mbpsBetweenSats = uiConfig["circular_rings.requiredmbpsbetweensats"];
    if (mbpsBetweenSats == 0) return [];
    const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
    const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
    const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
    const earthMarsInclinationPct = uiConfig["circular_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
    const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
    const satellitesConfig = [];
    for (let ringId = 1; ringId < ringCount - 1; ringId++) {
      const ringType = "Circular";
      let satDistanceSunAu = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
      let satDistanceSunAuBias =
        Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);
      const satCount = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias)));
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: satDistanceSunAu,
        ringName: "ring_circ_" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
        eccentricity: 0,
        raan: 0,
        argPeri: 0,
        earthMarsInclinationPct,
      });
    }
    return satellitesConfig;
  }

  _buildEccentricRings(uiConfig) {
    const ringCount = uiConfig["eccentric_rings.ringcount"];
    const mbpsBetweenSats = uiConfig["eccentric_rings.requiredmbpsbetweensats"];
    if (ringCount == 0 || mbpsBetweenSats == 0) return [];
    const distAverageAu = uiConfig["eccentric_rings.distance-sun-average-au"];
    const eccentricity = uiConfig["eccentric_rings.eccentricity"];
    if (eccentricity >= 1) return [];
    const argPeriStart = uiConfig["eccentric_rings.argument-of-perihelion"];
    const earthMarsInclinationPct = uiConfig["eccentric_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
    const satellitesConfig = [];
    for (let ringId = 0; ringId < ringCount; ringId++) {
      const ringType = "Eccentric";
      const satCount = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * distAverageAu)));
      const argPeri = (argPeriStart + (ringId * 360) / ringCount) % 360;
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: distAverageAu,
        ringName: "ring_ecce_" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
        eccentricity,
        raan: 0,
        argPeri,
        earthMarsInclinationPct,
      });
    }
    return satellitesConfig;
  }

  _buildAdaptedRings(uiConfig) {
    const userRingCount = uiConfig["adapted_rings.ringcount"];
    if (userRingCount == 0) return [];
    let ringCount = userRingCount + 2;

    let routeCount;
    if (uiConfig["adapted_rings.auto_route_count"] === "yes") {
      const rM = this.getMars().a;
      const rE = this.getEarth().a;
      const Dem = rM - rE;
      routeCount = Math.round((userRingCount * Math.sqrt(3) * Math.PI * rM) / Dem);
    } else {
      routeCount = uiConfig["adapted_rings.route_count"];
    }
    if (routeCount == 0) return [];

    const linearSatCountIncrease = uiConfig["adapted_rings.linear_satcount_increase"];
    // Orbital-plane blends (RAAN and arg-perigee, independent): 0% = Earth,
    // 100% = Mars. Carried on the config so any consumer (main display +
    // workers) applies them.
    const raanRaw = uiConfig["adapted_rings.earth-mars-raan-pct"];
    const argPeriRaw = uiConfig["adapted_rings.earth-mars-argperi-pct"];
    const eccRaw = uiConfig["adapted_rings.earth-mars-eccentricity-pct"];
    const inclRaw = uiConfig["adapted_rings.earth-mars-orbit-inclination-pct"];
    const raanPct = typeof raanRaw === "number" ? raanRaw : 100;
    const argPeriPct = typeof argPeriRaw === "number" ? argPeriRaw : 100;
    const eccentricityPct = typeof eccRaw === "number" ? eccRaw : 100;
    // Inclination uses the same scheme as circular rings: addInterpolationBias
    // with a 0–100 slider (middle stop at 50 = the natural distance interpolation).
    const inclinationPct = typeof inclRaw === "number" ? inclRaw : 50;

    // --- Radial range + distribution -----------------------------------------
    const num = (v, d) => (typeof v === "number" && !Number.isNaN(v) ? v : d);
    const earthAnchor = uiConfig["adapted_rings.earth-endpoint-anchor"] || "a";
    const marsAnchor = uiConfig["adapted_rings.mars-endpoint-anchor"] || "a";
    const spaceBy = uiConfig["adapted_rings.space-by-radius"] || "a";
    const earthOffset = num(uiConfig["adapted_rings.earth-side-offset-pct"], 0.6);
    const marsOffset = num(uiConfig["adapted_rings.mars-side-offset-pct"], 0);
    const middlePct = num(uiConfig["adapted_rings.distribution-middle-pct"], 50);
    const innerFracPct = num(uiConfig["adapted_rings.distribution-inner-fraction-pct"], 50);

    // Endpoint distances: the planet's chosen radius (perihelion a(1-e) / a /
    // apohelion a(1+e)) nudged by the side offset. These sit at ringId 0 and
    // ringCount-1, which the loop skips — keeping the rings between the planet rings.
    const planetRadius = (p, anchor) =>
      anchor === "perihelion" ? p.a * (1 - p.e) : anchor === "apohelion" ? p.a * (1 + p.e) : p.a;
    const R_in = planetRadius(this.getEarth(), earthAnchor) * (1 + earthOffset / 100);
    const R_out = planetRadius(this.getMars(), marsAnchor) * (1 + marsOffset / 100);

    // Skew: piecewise-linear warp of the even parameter u∈(0,1). innerFraction of
    // the rings land in [R_in, R_mid] (even), the rest in [R_mid, R_out] (even).
    // innerFraction = middle% ⇒ uniform.
    const R_mid = R_in + (middlePct / 100) * (R_out - R_in);
    const F = Math.min(0.999, Math.max(0.001, innerFracPct / 100));
    const warpR = (u) =>
      u <= F ? R_in + (u / F) * (R_mid - R_in) : R_mid + ((u - F) / (1 - F)) * (R_out - R_mid);

    // Solve the semi-major axis whose "space-by" radius equals R.
    const solveA = (R) => {
      if (spaceBy === "a") return R;
      const sign = spaceBy === "apohelion" ? 1 : -1; // perihelion a(1-e) | apohelion a(1+e)
      let a = R;
      for (let i = 0; i < 5; i++) a += R - a * (1 + sign * this.interpolateOrbitalElementNonLinear(a, "e"));
      return a;
    };

    const satellitesConfig = [];

    for (let ringId = 1; ringId < ringCount - 1; ringId++) {
      const ringType = "Adapted";
      const satDistanceSunAu = solveA(warpR(ringId / (ringCount - 1)));
      let satCount = Math.ceil(routeCount * (1 + (linearSatCountIncrease * ringId) / ringCount));
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: satDistanceSunAu,
        ringName: "ring_adapt_" + ringId,
        ringType: ringType,
        sideExtensionDeg: null,
        eccentricity: null,
        raan: null,
        argPeri: null,
        earthMarsInclinationPct: inclinationPct,
        raanPct,
        argPeriPct,
        eccentricityPct,
      });
    }
    return satellitesConfig;
  }

  _buildPlanetRing(uiConfig, ringName) {
    const satellitesConfig = [];
    const mbpsBetweenSats = uiConfig[ringName + ".requiredmbpsbetweensats"];
    let sideExtensionDeg = uiConfig[ringName + ".side-extension-degrees-slider"];
    let matchCircularRings = uiConfig[ringName + ".match-circular-rings"];
    if (sideExtensionDeg == 0 || (mbpsBetweenSats == 0 && matchCircularRings == "no")) return satellitesConfig;

    let ringType = ringName == "ring_mars" ? "Mars" : "Earth";

    let satCount = 0;
    let gradientOneSideStartMbps = null;
    if (matchCircularRings == "gradient") {
      let ringCount = uiConfig["circular_rings.ringcount"];
      if (ringCount == 0) {
        matchCircularRings = "no";
      } else {
        ringCount += 2;
        const mbpsBetweenSatsCircular = uiConfig["circular_rings.requiredmbpsbetweensats"];
        if (mbpsBetweenSatsCircular == 0) return [];
        const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
        const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
        const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
        const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSatsCircular / 1000);
        const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
        const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
        gradientOneSideStartMbps = 9999999999;
        for (let ringId = 1; ringId < ringCount - 2; ringId++) {
          let satDistanceSunAu1 = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId;
          let satDistanceSunAu2 = Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * (ringId + 1);
          let satDistanceSunAuBias1 =
            Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);
          const satCount1 = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias1)));
          let satDistanceSunAuBias2 =
            Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * (ringId + 1) * ((100 - inringIntraringBiasPct) / 100);
          const satCount2 = Math.ceil(Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias2)));
          const distanceThisRingToNextAU = Math.abs(satDistanceSunAu1 - satDistanceSunAu2);
          const distanceThisRingToNextKm = this.simLinkBudget.convertAUtoKM(distanceThisRingToNextAU);
          const throughputThisRingToNextMbpsOneSat = this.simLinkBudget.calculateGbps(distanceThisRingToNextKm) * 1000;
          const throughputThisRingToNextMbpsAllSats = throughputThisRingToNextMbpsOneSat * Math.min(satCount1, satCount2);
          const throughputOneSideOfPlanet = throughputThisRingToNextMbpsAllSats / 2;
          if (throughputOneSideOfPlanet < gradientOneSideStartMbps) gradientOneSideStartMbps = Math.ceil(throughputOneSideOfPlanet);
        }
      }
    }
    if (
      matchCircularRings != "no" &&
      uiConfig["circular_rings.requiredmbpsbetweensats"] > 0 &&
      uiConfig["circular_rings.ringcount"] > 0
    ) {
      let ringCount = uiConfig["circular_rings.ringcount"];
      ringCount += 2;
      const mbpsBetweenSats = uiConfig["circular_rings.requiredmbpsbetweensats"];
      const distOuterAu = uiConfig["circular_rings.distance-sun-slider-outer-au"];
      const distInnerAu = uiConfig["circular_rings.distance-sun-slider-inner-au"];
      const inringIntraringBiasPct = uiConfig["circular_rings.inring-interring-bias-pct"];
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
      const distanceAuBetweenRings = Math.abs(distOuterAu - distInnerAu) / (ringCount - 1);
      const ringId = 1;
      let satDistanceSunAuBias =
        Math.min(distInnerAu, distOuterAu) + distanceAuBetweenRings * ringId * ((100 - inringIntraringBiasPct) / 100);
      satCount = Math.ceil(((Math.PI / this.safeAsin(distanceAuBetweenSats / (2 * satDistanceSunAuBias))) * sideExtensionDeg) / 180);
    } else {
      const { a, n } = this.getParams_a_n(ringType);
      const distAverageAu = a;
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
      const circumferenceAu = 2 * Math.PI * distAverageAu;
      const actualCircumferenceAu = (circumferenceAu * sideExtensionDeg * 2) / 360;
      satCount = Math.ceil(actualCircumferenceAu / distanceAuBetweenSats);
    }

    satellitesConfig.push({
      satCount: satCount,
      satDistanceSun: null,
      ringName: ringName,
      ringType: ringType,
      sideExtensionDeg: sideExtensionDeg,
      eccentricity: 0,
      raan: 0,
      argPeri: 0,
      earthMarsInclinationPct: 0,
      gradientOneSideStartMbps,
    });

    return satellitesConfig;
  }

  /**
   * Seed value: the requiredmbpsbetweensats (user-facing Mbps) that yields an
   * in-ring planet-link capacity near targetMbps. The sensitivity feedback loop
   * refines from here. Mirrors the former simUi._mbpsBetweenSatsForTargetCapacity.
   */
  mbpsBetweenSatsForTargetCapacity(targetMbps, ringType) {
    const lb = this.simLinkBudget;
    const AU_IN_KM = SIM_CONSTANTS.AU_IN_KM;
    const { a } = this.getParams_a_n(ringType);
    const e = ringType === "Mars" ? 0.0934231 : 0.0166967;
    const apo = a * (1 + e);

    const targetPerLinkGbps = targetMbps / 2 / 1000;
    if (targetPerLinkGbps <= 0) return 50;

    const gbpsFactor = lb._gbpsFactor;
    const worstDistKm = Math.sqrt(gbpsFactor / targetPerLinkGbps);
    const worstDistAu = worstDistKm / AU_IN_KM;

    const sinHalf = worstDistAu / (2 * apo);
    if (sinHalf >= 1) return 50;
    const halfSpacingRad = Math.asin(sinHalf);
    let satCount = Math.ceil(Math.PI / halfSpacingRad);

    const maxDistanceAU = lb.maxDistanceAU;
    if (maxDistanceAU > 0) {
      const sinConnect = maxDistanceAU / (2 * apo);
      if (sinConnect > 0 && sinConnect < 1) {
        const nConnect = Math.ceil(Math.PI / Math.asin(sinConnect));
        if (nConnect > satCount) satCount = nConnect;
      }
    }
    if (satCount < 2) return 50;

    const circumferenceAu = 2 * Math.PI * a;
    const distAuBetweenSats = circumferenceAu / satCount;
    const distKmBetweenSats = distAuBetweenSats * AU_IN_KM;

    const gbps = gbpsFactor / (distKmBetweenSats * distKmBetweenSats);
    return Math.max(1, Math.round(gbps * 1000));
  }

  setSatellitesConfig(satellitesConfig) {
    // Pull the adapted-ring orbital-plane blends off the config so getOrbitaElements
    // can read them (set here so every consumer — main display + workers — applies them).
    const adaptedCfg = satellitesConfig.find((c) => c.ringType === "Adapted");
    this.adaptedRaanPct = adaptedCfg && typeof adaptedCfg.raanPct === "number" ? adaptedCfg.raanPct : 100;
    this.adaptedArgPeriPct = adaptedCfg && typeof adaptedCfg.argPeriPct === "number" ? adaptedCfg.argPeriPct : 100;
    this.adaptedEccentricityPct = adaptedCfg && typeof adaptedCfg.eccentricityPct === "number" ? adaptedCfg.eccentricityPct : 100;
    // Cheap pre-count from the config (each ring carries its satCount) so we can
    // refuse an over-cap build instead of generating then discarding a huge array.
    const requested = satellitesConfig.reduce((sum, c) => sum + (c.satCount || 0), 0);
    this.requestedSatelliteCount = requested;
    this.satellitesTruncated = requested > this.maxSatCount;
    if (this.satellitesTruncated) {
      // Opinionated: a slice(0, cap) constellation yields misleading topology/flow,
      // so don't build or run it. The orchestrator surfaces an error on the view
      // telling the user to raise the cap or reduce the driving parameters.
      this.satellites = [];
      this.orbitalElements = [];
      return;
    }
    const newSatellites = [];
    // NOTE: push one-by-one, not push(...arr) — spreading a large ring's array
    // into call arguments overflows the stack past ~65k elements ("Maximum call
    // stack size exceeded"), which big planet rings can exceed.
    for (let config of satellitesConfig) {
      const sats = this.generateSatellites(config);
      for (let i = 0; i < sats.length; i++) newSatellites.push(sats[i]);
    }
    this.satellites = newSatellites;
    this.setOrbitalElements(satellitesConfig);
  }

  setOrbitalElements(satellitesConfig) {
    this.orbitalElements = [];
    const newOrbitalElements = [];
    for (let config of satellitesConfig) {
      const orbitalElement = this.generateOrbitalElements(config);
      if (orbitalElement) {
        // Precompute positions along the orbit at solar angle steps
        orbitalElement.precomputedPositions = this.precomputeOrbitPositions(orbitalElement);
        // Radial coefficients for analytic zone crossings: 1/ρ(θ) ≈ A + B·cosθ + C·sinθ
        orbitalElement.radialCoeffs = this.computeRadialCoeffs(orbitalElement);
        newOrbitalElements.push(orbitalElement);
      }
    }
    this.orbitalElements = newOrbitalElements;

    // Diagnostic (main thread only): how far the i=0 "elements" model is from a
    // best-fit conic to the actual projected positions — i.e. the impact of the
    // low-inclination / drop-z assumption. Lets us judge elements vs fit.
    if (typeof window !== "undefined") {
      let maxRelA = 0, maxDe = 0, maxDvarpi = 0, worst = null;
      for (const el of this.orbitalElements) {
        const rc = el.radialCoeffs;
        if (!rc || !rc.fit) continue;
        const eE = Math.hypot(rc.B, rc.C) / (rc.A || 1);
        const eF = Math.hypot(rc.fit.B, rc.fit.C) / (rc.fit.A || 1);
        const vE = (Math.atan2(rc.C, rc.B) * 180) / Math.PI;
        const vF = (Math.atan2(rc.fit.C, rc.fit.B) * 180) / Math.PI;
        const dV = Math.abs(((vE - vF + 540) % 360) - 180);
        const relA = Math.abs(rc.A - rc.fit.A) / (Math.abs(rc.fit.A) || 1);
        if (relA > maxRelA) { maxRelA = relA; worst = el.ringName; }
        maxDe = Math.max(maxDe, Math.abs(eE - eF));
        maxDvarpi = Math.max(maxDvarpi, dV);
      }
      // Silent unless the i=0 elements model drifts notably from the projected
      // fit — a sign of a convention/projection problem (this is what caught the
      // earlier ϖ = o+p vs ϖ = p bug). Normal low-inclination drift is well under these.
      if (worst && (maxRelA > 0.005 || maxDe > 1e-3 || maxDvarpi > 1)) {
        console.warn(`[Zones] elements-vs-fit drift: Δ(1/p)=${(maxRelA * 100).toFixed(3)}%, Δe=${maxDe.toFixed(5)}, Δϖ=${maxDvarpi.toFixed(3)}° (worst ${worst})`);
      }
    }

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

  // Projected polar coefficients so that 1/ρ(θ) = A + B·cosθ + C·sinθ, where
  // ρ = ecliptic-plane radius √(x²+y²) and θ = solar angle. For a focus-centred
  // conic this is exact (i=0); `fit` is a least-squares fit to the actual
  // projected positions, so elem-vs-fit reveals the low-inclination error.
  computeRadialCoeffs(orbitalElement) {
    const a = orbitalElement.a, e = orbitalElement.e;
    const denom = a * (1 - e * e);
    // In this element set `p` IS the longitude of perihelion ϖ (= Ω+ω already),
    // and `o` is the RAAN — so ϖ = p (the node only tilts the plane, it doesn't
    // shift the perihelion's ecliptic longitude in the 2D radial profile).
    const varpi = ((orbitalElement.p || 0) * Math.PI) / 180;
    const elem = denom ? { A: 1 / denom, B: (e * Math.cos(varpi)) / denom, C: (e * Math.sin(varpi)) / denom } : { A: 0, B: 0, C: 0 };

    // Least-squares fit of 1/ρ = A + B cosθ + C sinθ over the precomputed positions.
    let fit = null;
    const pts = orbitalElement.precomputedPositions;
    if (pts && pts.length >= 3) {
      let n = 0, sC = 0, sS = 0, sCC = 0, sSS = 0, sCS = 0, sR = 0, sRC = 0, sRS = 0;
      for (const p of pts) {
        const rho = Math.hypot(p.x, p.y);
        if (!(rho > 0)) continue;
        const th = (p.solarAngle * Math.PI) / 180;
        const c = Math.cos(th), s = Math.sin(th), inv = 1 / rho;
        n++; sC += c; sS += s; sCC += c * c; sSS += s * s; sCS += c * s; sR += inv; sRC += inv * c; sRS += inv * s;
      }
      fit = this.solve3x3([[n, sC, sS], [sC, sCC, sCS], [sS, sCS, sSS]], [sR, sRC, sRS]);
    }
    return { ...elem, fit };
  }

  solve3x3(M, b) {
    const det = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-15) return null;
    const col = (i) => M.map((row, r) => row.map((v, c) => (c === i ? b[r] : v)));
    return { A: det(col(0)) / D, B: det(col(1)) / D, C: det(col(2)) / D };
  }

  // Build an angular range [start, end] (end may exceed 360 for wrap-around,
  // which isAngleInRange handles) centred on centerDeg with the given half-width.
  arcRange(centerDeg, halfWidthDeg) {
    const start = (((centerDeg - halfWidthDeg) % 360) + 360) % 360;
    return [start, start + 2 * halfWidthDeg];
  }

  // Crossing solar angles + inside/outside arcs of the source orbit relative to a
  // target orbit (Earth or Mars), computed ANALYTICALLY. Both share the sun's
  // focus, so f(θ) = 1/ρ_source − 1/ρ_target = ΔA + ΔB·cosθ + ΔC·sinθ — a single
  // sinusoid with at most two roots. f>0 ⇔ source is INSIDE target at θ.
  findAllRadialCrossings(sourceEle, targetEle) {
    if (!sourceEle || !targetEle) {
      if (!sourceEle) console.warn("Source orbit is missing, no crossings.");
      if (!targetEle) console.warn("Target orbit is missing, no crossings.");
      return { crossings: [], inside: null, outside: null };
    }
    const sc = sourceEle.radialCoeffs, tc = targetEle.radialCoeffs;
    if (!sc || !tc) return { crossings: [], inside: null, outside: null };

    const dA = sc.A - tc.A, dB = sc.B - tc.B, dC = sc.C - tc.C;
    const M = Math.hypot(dB, dC);
    const TANGENT_ARC_DEG = 1.0; // arcs narrower than this are treated as grazing (no split)
    const FLAT_TOL = 1e-9 * Math.max(Math.abs(sc.A), Math.abs(tc.A), 1e-12);

    // Same shape & orientation → f ≈ constant = dA (the two orbits never cross).
    if (M <= FLAT_TOL) {
      if (dA > FLAT_TOL) return { crossings: [], inside: [0, 360], outside: null };
      if (dA < -FLAT_TOL) return { crossings: [], inside: null, outside: [0, 360] };
      return { crossings: [], inside: null, outside: null }; // coincident → between
    }

    const k = -dA / M; // cos(θ − φ) = k at the crossings
    const alpha = Math.abs(k) < 1 ? Math.acos(k) : 0; // radians, half-arc
    const insideWidthDeg = 2 * alpha * (180 / Math.PI);
    // No real crossing (entirely one side), or a graze thinner than the tangent
    // width → assign the whole ring to the dominant (sign(dA)) side.
    if (Math.abs(k) >= 1 || Math.min(insideWidthDeg, 360 - insideWidthDeg) < TANGENT_ARC_DEG) {
      if (dA > 0) return { crossings: [], inside: [0, 360], outside: null };
      return { crossings: [], inside: null, outside: [0, 360] };
    }

    // Two crossings at φ ± α. Inside (f>0) = arc centred on φ, half-width α.
    const phiDeg = ((Math.atan2(dC, dB) * 180) / Math.PI + 360) % 360;
    const alphaDeg = (alpha * 180) / Math.PI;
    const c1 = (((phiDeg - alphaDeg) % 360) + 360) % 360;
    const c2 = (((phiDeg + alphaDeg) % 360) + 360) % 360;
    return {
      crossings: [c1, c2].sort((a, b) => a - b),
      inside: this.arcRange(phiDeg, alphaDeg),
      outside: this.arcRange(phiDeg + 180, 180 - alphaDeg),
    };
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
    if (isNaN(solarAngle)) return "UNKNOWN";
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
        let perInterringLinkMbps = gradientOneSideStartMbps ? gradientOneSideStartMbps / (satCountIfFullRing / 2) : null;
        let requiredThroughputMbps = gradientOneSideStartMbps;

        let satId = 0;
        let longiDeg = 0;
        while (longiDeg < sideExtensionDeg - longIncrement) {
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
          const selectedIncrement = longIncrement;
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
    else if (ringType == "Adapted") {
      // RAAN, arg-perigee, eccentricity and inclination all blend identically to
      // the circular-ring inclination: addInterpolationBias over the linear per-`a`
      // interpolation. 0% = Earth value (every sat), 50% = the natural per-`a`
      // interpolation (Earth near Earth, Mars near Mars), 100% = Mars value (every sat).
      return {
        i: this.addInterpolationBias(this.interpolateOrbitalElement(a, "i"), earthMarsInclinationPct, "i"),
        o: this.addInterpolationBias(this.interpolateOrbitalElement(a, "o"), this.adaptedRaanPct ?? 100, "o"), // RAAN
        p: this.addInterpolationBias(this.interpolateOrbitalElement(a, "p"), this.adaptedArgPeriPct ?? 100, "p"), // arg perigee
        a: a,
        n: n,
        e: this.addInterpolationBias(this.interpolateOrbitalElement(a, "e"), this.adaptedEccentricityPct ?? 100, "e"),
        l: long,
        Dele: this.Mars.Dele, // J2000 epoch
        apsides,
      };
    }
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
