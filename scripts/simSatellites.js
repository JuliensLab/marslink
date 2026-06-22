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
    // Eccentric ring↔ring crossings, precomputed once per constellation definition.
    // Each entry: { ringA, ringB, solarAngle } — the solar angle is the time-invariant
    // key the topology builder binary-searches to find the nearest sat on each ring.
    this.eccentricRingCrossings = [];
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
    // Exactly one relay family is active, chosen by the relay_type selector. Build only
    // that one (falling back to adapted concentric for legacy configs without the key).
    const relayType = uiConfig["relay_type.selected"] || "Adapted concentric";
    const relayBuilders = {
      "Circular": () => this._buildCircularRings(uiConfig),
      "Eccentric": () => this._buildEccentricRings(uiConfig),
      "Adapted concentric": () => this._buildAdaptedRings(uiConfig),
      "Adapted eccentric": () => this._buildAdaptedEccentricRings(uiConfig),
    };
    const build = relayBuilders[relayType] || relayBuilders["Adapted concentric"];
    satellitesConfig.push(...build());
    if (uiConfig["ring_mars.side-extension-degrees-slider"]) satellitesConfig.push(...this._buildPlanetRing(uiConfig, "ring_mars"));
    if (uiConfig["ring_earth.side-extension-degrees-slider"]) satellitesConfig.push(...this._buildPlanetRing(uiConfig, "ring_earth"));
    return satellitesConfig;
  }

  _buildCircularRings(uiConfig) {
    let ringCount = uiConfig["relay_type.ringcount"];
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
    const ringCount = uiConfig["relay_type.ringcount"];
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
    // Worst-case (perihelion) sizing: sats are evenly spaced in mean longitude, so
    // their physical spacing is widest at perihelion (the ring sweeps fastest there),
    // exceeding the average by √((1+e)/(1−e)). Size the count so even that widest link
    // meets the target, guaranteeing the rate everywhere on the orbit (mirrors the
    // planet-ring worst-case branch).
    const periapsisFactor = Math.sqrt((1 + eccentricity) / (1 - eccentricity));
    for (let ringId = 0; ringId < ringCount; ringId++) {
      const ringType = "Eccentric";
      const circumferenceAu = 2 * Math.PI * distAverageAu * periapsisFactor;
      const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);
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

  // Adapted Eccentric rings: each ring is an ellipse that is TANGENT to both planet
  // orbits — it kisses Earth's orbit once (from outside) and Mars's orbit once (from
  // inside), so a ring never crosses either orbit (no satellites inside Earth / beyond
  // Mars). The earlier "pin perihelion to Earth, aphelion to Mars" rule touched at the
  // apsides but, because a fixed-shape Keplerian ellipse meets Mars's eccentric orbit
  // with a slope mismatch, it crossed Mars TWICE just off the aphelion. Tangency
  // removes that second crossing.
  //
  // The construction is closed-form in u = 1/r, where every confocal orbit is a pure
  // sinusoid u(θ) = A + V·(cosθ, sinθ), with A = 1/p (p = a(1−e²)) and V = (e/p) at the
  // perihelion longitude ϖ. Ring and planet meet where u_ring = u_planet, i.e. a single
  // sinusoid = const → generically TWO roots; it collapses to ONE tangency exactly when
  // amplitude = offset: |A_r − A_p| = |V_r − V_p|. Requiring tangency to Mars (inside)
  // and Earth (outside) and adding the two equations eliminates A_r:
  //     |V_r − V_M| + |V_r − V_E| = (A_E − A_M) − c          (= S, a constant)
  // so V_r lies on an ELLIPSE in eccentricity-vector space with foci V_E, V_M. Each ring
  // is one point on it: pick the apsis direction ϖ_r (spread evenly from the start
  // angle), intersect that ray with the locus for |V_r|, then recover a_r, e_r. Clearance
  // c shrinks the locus so the ring sits strictly inside Mars / outside Earth by a margin
  // instead of touching. Emits ringType "Eccentric" with a distinct ring_adecc_ name.
  // (Worked in the 2-D ecliptic projection — inclination only tilts out of plane.)
  _buildAdaptedEccentricRings(uiConfig) {
    const ringCount = uiConfig["relay_type.ringcount"];
    const mbpsBetweenSats = uiConfig["adapted_eccentric_rings.requiredmbpsbetweensats"];
    if (ringCount == 0 || mbpsBetweenSats == 0) return [];
    const argPeriStart = uiConfig["adapted_eccentric_rings.argument-of-perihelion"];
    const earthMarsInclinationPct = uiConfig["adapted_eccentric_rings.earth-mars-orbit-inclination-pct"];
    const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
    const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;

    // Reciprocal-radius (u = 1/r) parameters of a planet's orbit: A = 1/p and the
    // eccentricity vector V = (e/p)·(cos ϖ, sin ϖ), ϖ = perihelion longitude (= .p here).
    const uParams = (planet) => {
      const e = planet.e, a = planet.a, w = ((planet.p || 0) * Math.PI) / 180;
      const p = a * (1 - e * e) || 1e-9;
      const ev = e / p;
      return { A: 1 / p, Vx: ev * Math.cos(w), Vy: ev * Math.sin(w) };
    };
    const M = uParams(this.Mars), E = uParams(this.Earth);

    // Clearance is a RADIAL gap in AU — a fixed absolute distance set directly by the
    // slider, NOT a multiple of the (varying) in-ring spacing. It maps to a u-space margin
    // by du ≈ dr·A², but A (=1/r) at the planet's MEAN radius is only a seed — each ring
    // touches at a different radius. So we Newton-refine each ring's margin (closed form,
    // no sampling) until the realized radial gap equals the slider value.
    const num = (v, d) => (typeof v === "number" && !Number.isNaN(v) ? v : d);
    const marsMargin = num(uiConfig["adapted_eccentric_rings.mars-side-clearance-x"], 0); // AU
    const earthMargin = num(uiConfig["adapted_eccentric_rings.earth-side-clearance-x"], 0); // AU
    const fociDist = Math.hypot(M.Vx - E.Vx, M.Vy - E.Vy);
    // Exact u-margin c giving a radial gap g at a contact with reciprocal-radius u*:
    //   Mars (ring inside):   g = 1/u* − 1/(u*+c) ⇒ c = g·u*² / (1 − g·u*)
    //   Earth (ring outside): g = 1/(u*−c) − 1/u* ⇒ c = g·u*² / (1 + g·u*)
    const marginForGap = (g, uStar, inside) =>
      g <= 0 ? 0 : (g * uStar * uStar) / (inside ? Math.max(1e-6, 1 - g * uStar) : 1 + g * uStar);

    const satellitesConfig = [];
    for (let ringId = 0; ringId < ringCount; ringId++) {
      const argPeri = (((argPeriStart + (ringId * 360) / ringCount) % 360) + 360) % 360;
      const wr = (argPeri * Math.PI) / 180, dx = Math.cos(wr), dy = Math.sin(wr);
      // Seed the margins from the mean-radius linearization, then refine. A tangent ring
      // (both margins 0) needs no refinement and stays exact in a single pass.
      let cM = marsMargin * M.A * M.A, cE = earthMargin * E.A * E.A, v = 0, Ar = M.A;
      const passes = marsMargin > 0 || earthMargin > 0 ? 4 : 1;
      for (let it = 0; it < passes; it++) {
        // Along the apsis ray V_r = v·(dx,dy), solve |V_r−V_M| + |V_r−V_E| = S. The summed
        // distance grows monotonically with v past the origin, so bisect.
        const S = Math.max(fociDist + 1e-6, E.A - M.A - cM - cE);
        const f = (vv) => Math.hypot(vv * dx - M.Vx, vv * dy - M.Vy) + Math.hypot(vv * dx - E.Vx, vv * dy - E.Vy) - S;
        let lo = 0, hi = 1;
        while (f(hi) < 0 && hi < 16) hi *= 2;
        for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
        v = (lo + hi) / 2;
        Ar = M.A + Math.hypot(v * dx - M.Vx, v * dy - M.Vy) + cM; // A_r = A_M + |V_r−V_M| + c_M
        if (it === passes - 1) break;
        // Closed-form contact longitudes (where ring & planet are closest) → planet u
        // there → exact margins for the next pass.
        const tM = Math.atan2(M.Vy - v * dy, M.Vx - v * dx);
        const tE = Math.atan2(v * dy - E.Vy, v * dx - E.Vx);
        const uM = M.A + M.Vx * Math.cos(tM) + M.Vy * Math.sin(tM);
        const uE = E.A + E.Vx * Math.cos(tE) + E.Vy * Math.sin(tE);
        cM = marginForGap(marsMargin, uM, true);
        cE = marginForGap(earthMargin, uE, false);
      }
      const ringE = Math.min(0.97, Math.max(0, v / Ar)); // e = |V_r|/A_r = v/Ar
      const ringA = 1 / Ar / (1 - ringE * ringE); // a = p/(1−e²)
      // Worst-case (perihelion) sizing: in-ring spacing is widest at perihelion,
      // exceeding the average by √((1+e)/(1−e)), so size the count to that link.
      const periapsisFactor = Math.sqrt((1 + ringE) / (1 - ringE));
      const circumferenceAu = 2 * Math.PI * ringA * periapsisFactor;
      const satCount = Math.ceil(circumferenceAu / distanceAuBetweenSats);
      satellitesConfig.push({
        satCount: satCount,
        satDistanceSun: ringA,
        ringName: "ring_adecc_" + ringId,
        ringType: "Eccentric",
        sideExtensionDeg: null,
        eccentricity: ringE,
        raan: 0,
        argPeri,
        earthMarsInclinationPct,
      });
    }
    return satellitesConfig;
  }

  _buildAdaptedRings(uiConfig) {
    const userRingCount = uiConfig["relay_type.ringcount"];
    if (userRingCount == 0) return [];
    let ringCount = userRingCount + 2;

    // Endpoint rings: ringId 0 sits at Earth's orbit (R_in) and ringId
    // ringCount-1 at Mars's orbit (R_out). They coincide with the planet rings,
    // so they're dropped by default. The two checkmarks gate that removal —
    // checked (the default) drops the endpoint, unchecking it enables the ring.
    const trimRings = String(uiConfig["adapted_rings.trim-rings"] || "");
    const removeFirstRing = trimRings.includes("Remove first ring");
    const removeLastRing = trimRings.includes("Remove last ring");

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
    // Per-`a` blend curves (anchor arrays from the chart editors): when present they
    // override the constant scalar above, so the Earth↔Mars mix can vary by ring.
    const raanCurve = uiConfig["adapted_rings.raan-curve"];
    const argPeriCurve = uiConfig["adapted_rings.argperi-curve"];
    const eccentricityCurve = uiConfig["adapted_rings.eccentricity-curve"];
    const inclinationCurve = uiConfig["adapted_rings.inclination-curve"];

    // --- Radial range + distribution -----------------------------------------
    const num = (v, d) => (typeof v === "number" && !Number.isNaN(v) ? v : d);
    const earthAnchor = uiConfig["adapted_rings.earth-endpoint-anchor"] || "a";
    const marsAnchor = uiConfig["adapted_rings.mars-endpoint-anchor"] || "a";
    const spaceBy = uiConfig["adapted_rings.space-by-radius"] || "a";
    const earthOffset = num(uiConfig["adapted_rings.earth-side-offset-pct"], 0.6);
    const marsOffset = num(uiConfig["adapted_rings.mars-side-offset-pct"], 0);
    // Endpoint distances: the planet's chosen radius (perihelion a(1-e) / a /
    // apohelion a(1+e)) nudged by the side offset. These sit at ringId 0 and
    // ringCount-1, which the loop skips — keeping the rings between the planet rings.
    const planetRadius = (p, anchor) =>
      anchor === "perihelion" ? p.a * (1 - p.e) : anchor === "apohelion" ? p.a * (1 + p.e) : p.a;
    const R_in = planetRadius(this.getEarth(), earthAnchor) * (1 + earthOffset / 100);
    const R_out = planetRadius(this.getMars(), marsAnchor) * (1 + marsOffset / 100);

    // Distribution equalizer: the ring-density curve across the Earth→Mars span is
    // defined by control anchors {x∈[0,1], y≥0}, linearly interpolated (held flat
    // outside the end anchors). The chart editor produces them; a flat 2-anchor
    // default (uniform spacing) is used when absent. Rings are placed by this
    // density's inverse-CDF below, so the curve shape sets where rings cluster.
    let anchors = uiConfig["adapted_rings.density-anchors"];
    if (!Array.isArray(anchors) || anchors.length < 2) anchors = [{ x: 0, y: 50 }, { x: 1, y: 50 }];
    anchors = anchors
      .map((a) => ({ x: Math.min(1, Math.max(0, +a.x || 0)), y: Math.max(0, +a.y || 0) }))
      .sort((a, b) => a.x - b.x);
    if (anchors.reduce((s, a) => s + a.y, 0) <= 0) anchors = [{ x: 0, y: 1 }, { x: 1, y: 1 }];
    const density = (u) => this.densityFromAnchors(anchors, u);

    // Cumulative-density table → inverse-CDF: maps an even mass fraction t∈(0,1) to
    // the radial coordinate u, so ring spacing comes out ∝ 1/ρ (dense where boosted,
    // sparse where cut, varying smoothly). Exactly N rings regardless of weights.
    const M = 2000;
    const cdf = new Float64Array(M + 1);
    let prevD = density(0);
    for (let m = 1; m <= M; m++) {
      const d = density(m / M);
      cdf[m] = cdf[m - 1] + (prevD + d) / 2; // trapezoid
      prevD = d;
    }
    const total = cdf[M] || 1;
    const cdfInverse = (t) => {
      const target = Math.min(1, Math.max(0, t)) * total;
      let lo = 0, hi = M;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < target) lo = mid;
        else hi = mid;
      }
      const span = cdf[hi] - cdf[lo] || 1;
      return (lo + (target - cdf[lo]) / span) / M;
    };

    const warpR = (t) => R_in + cdfInverse(t) * (R_out - R_in);

    // Solve the semi-major axis whose "space-by" radius equals R.
    const solveA = (R) => {
      if (spaceBy === "a") return R;
      const sign = spaceBy === "apohelion" ? 1 : -1; // perihelion a(1-e) | apohelion a(1+e)
      let a = R;
      for (let i = 0; i < 5; i++) a += R - a * (1 + sign * this.interpolateOrbitalElementNonLinear(a, "e"));
      return a;
    };

    const satellitesConfig = [];

    const startId = removeFirstRing ? 1 : 0;
    const endId = removeLastRing ? ringCount - 2 : ringCount - 1;
    for (let ringId = startId; ringId <= endId; ringId++) {
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
        raanCurve,
        argPeriCurve,
        eccentricityCurve,
        inclinationCurve,
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

    // The planet ring can "match" the circular relay rings' radial spacing — only
    // meaningful when Circular is the active relay family. The relay ring count now
    // lives on the shared relay_type.ringcount; treat it as 0 (match disabled) otherwise.
    const circularRingCount = uiConfig["relay_type.selected"] === "Circular" ? uiConfig["relay_type.ringcount"] : 0;

    let satCount = 0;
    let gradientOneSideStartMbps = null;
    if (matchCircularRings == "gradient") {
      let ringCount = circularRingCount;
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
      circularRingCount > 0
    ) {
      let ringCount = circularRingCount;
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
      // Worst-case sizing. The planet ring follows the planet's eccentric orbit and
      // its sats are evenly spaced in mean longitude, so their physical spacing is not
      // uniform: it is widest at periapsis, where the planet sweeps fastest (the arc
      // per unit mean anomaly scales as a²·√(1−e²)/r, maximal at r = a(1−e)). Sizing
      // the count so the AVERAGE link meets the target would under-serve the periapsis
      // links. Instead size so the widest (periapsis) link meets it, which guarantees
      // the throughput everywhere on the orbit. The periapsis spacing exceeds the
      // average by exactly √((1+e)/(1−e)), so we inflate the effective circumference by
      // that factor.
      const e = ringType === "Mars" ? this.Mars.e : this.Earth.e;
      const periapsisFactor = Math.sqrt((1 + e) / (1 - e));
      const distAverageAu = a;
      const distanceKmBetweenSats = this.simLinkBudget.calculateKm(mbpsBetweenSats / 1000);
      const distanceAuBetweenSats = distanceKmBetweenSats / SIM_CONSTANTS.AU_IN_KM;
      const circumferenceAu = 2 * Math.PI * distAverageAu * periapsisFactor;
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
    // Per-`a` blend curves (anchor arrays) — override the scalars above when present.
    const arr = (v) => (Array.isArray(v) && v.length >= 2 ? v : null);
    this.adaptedRaanCurve = adaptedCfg ? arr(adaptedCfg.raanCurve) : null;
    this.adaptedArgPeriCurve = adaptedCfg ? arr(adaptedCfg.argPeriCurve) : null;
    this.adaptedEccentricityCurve = adaptedCfg ? arr(adaptedCfg.eccentricityCurve) : null;
    this.adaptedInclinationCurve = adaptedCfg ? arr(adaptedCfg.inclinationCurve) : null;
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

    // Precompute eccentric ring↔ring crossings (static geometry → done once here, at
    // constellation definition, and reused on every topology build).
    this.eccentricRingCrossings = this.computeEccentricRingCrossings();
  }

  /**
   * Crossing points between every pair of eccentric relay rings (ring_ecce_,
   * ring_adecc_), in the ecliptic (xy) projection. Two such rings are confocal conics,
   * so they intersect at the (≤2) solar angles where 1/ρ_i(θ) = 1/ρ_j(θ) — the same
   * single-sinusoid root solved by findAllRadialCrossings from each ring's radialCoeffs.
   *
   * A crossing is a fixed point in inertial space (the orbits don't change shape), so it
   * is stored as { ringA, ringB, solarAngle, requiredMbps, requiredLinks }. The solar
   * angle is the time-invariant key: satellites orbit, but the one nearest a crossing is
   * always the one whose current solar angle is closest to it — an O(log n) binary search
   * per ring at link time.
   *
   * requiredMbps is the junction's design throughput: the SUM of the two rings' in-ring
   * link capacities at the crossing, so the junction never bottlenecks either ring where
   * they meet. Satellites are evenly spaced in mean anomaly, so a ring's in-ring chord at
   * solar angle θ is |v|·Δt = a·(2π/N)·√(1+2e·cosν+e²)/√(1−e²) with ν = θ − ϖ (ϖ = ring.p).
   *
   * requiredLinks is how many cross-ring laser links it takes to carry requiredMbps —
   * precomputed here so the topology builder just places that many (no per-build capacity
   * accounting). A single laser link can't span 0 distance, so a representative nearest
   * cross-link has each ring's closest sat ~half a spacing off the crossing, giving
   * length d ≈ ½·√(chordA²+chordB²); requiredLinks = ceil(requiredMbps / capacity(d)).
   * All three quantities are static geometry, so they're computed once at definition time.
   */
  computeEccentricRingCrossings() {
    const eccRings = this.orbitalElements.filter(
      (el) => el.ringName && (el.ringName.startsWith("ring_ecce") || el.ringName.startsWith("ring_adecc"))
    );

    const AU_IN_KM = SIM_CONSTANTS.AU_IN_KM;
    const DEG_TO_RAD = SIM_CONSTANTS.DEG_TO_RAD;
    const MAX_CROSS_LINKS = 6; // safety cap; keep ≤ the topology builder's window (WIN)
    const mbpsFromAU = (au) => this.calculateGbps(au * AU_IN_KM) * 1000;
    // In-ring chord (AU) of `ring` between two mean-anomaly-adjacent sats at solar angle θ.
    const inRingChordAU = (ring, thetaDeg) => {
      const N = ring.satCount, e = ring.e || 0;
      if (!N || N < 2 || ring.a == null || e >= 1) return Infinity;
      const nu = (thetaDeg - (ring.p || 0)) * DEG_TO_RAD;
      return ring.a * ((2 * Math.PI) / N) * Math.sqrt(1 + 2 * e * Math.cos(nu) + e * e) / Math.sqrt(1 - e * e);
    };

    const crossings = [];
    for (let i = 0; i < eccRings.length; i++) {
      for (let j = i + 1; j < eccRings.length; j++) {
        const { crossings: angles } = this.findAllRadialCrossings(eccRings[i], eccRings[j]);
        for (const solarAngle of angles) {
          const chA = inRingChordAU(eccRings[i], solarAngle);
          const chB = inRingChordAU(eccRings[j], solarAngle);
          const requiredMbps = mbpsFromAU(chA) + mbpsFromAU(chB);
          // Capacity of one representative nearest cross-link (each ring's closest sat
          // ~half a spacing off the crossing), then how many such links carry requiredMbps.
          const linkMbps = mbpsFromAU(0.5 * Math.sqrt(chA * chA + chB * chB));
          const requiredLinks =
            linkMbps > 0 ? Math.min(MAX_CROSS_LINKS, Math.max(1, Math.ceil(requiredMbps / linkMbps))) : 1;
          crossings.push({ ringA: eccRings[i].ringName, ringB: eccRings[j].ringName, solarAngle, requiredMbps, requiredLinks });
        }
      }
    }
    return crossings;
  }

  getEccentricRingCrossings() {
    return this.eccentricRingCrossings || [];
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
    if (!denom) return { A: 0, B: 0, C: 0 };
    // In this element set `p` IS the longitude of perihelion ϖ (= Ω+ω already),
    // and `o` is the RAAN — so ϖ = p (the node only tilts the plane, it doesn't
    // shift the perihelion's ecliptic longitude in the 2D radial profile).
    // Exact for an in-ecliptic conic (i=0); validated once against a least-squares
    // fit of the projected positions (Δϖ 0.007°, Δ(1/p) 0.03% at Mars's 1.85°).
    const varpi = ((orbitalElement.p || 0) * Math.PI) / 180;
    return { A: 1 / denom, B: (e * Math.cos(varpi)) / denom, C: (e * Math.sin(varpi)) / denom };
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

  // Per adapted-eccentric ring: how it sits against the planet orbits, for the
  // right-panel "closeness" charts. Each ring is built so its perihelion touches
  // Earth's orbit at ecliptic longitude argPeri (el.p) and its aphelion touches Mars's
  // orbit at argPeri+180 — optionally pulled back by the clearance margins.
  //
  // We report two things per ring:
  //  • apsis values (peri/apo): the ring's distance and the planet's distance at the
  //    apsidal longitude — these draw the two "breathing" curves. NOTE the gap here is
  //    flat (= the clearance margin), because the apsis is pinned to the planet orbit.
  //  • worst clearance (worstEarth/worstMars): the MINIMUM signed gap sampled over the
  //    ring's whole orbit. The real overshoot happens OFF the apsis (the ellipse bulges
  //    past the eccentric planet orbit just to one side of the tangent point), so this
  //    is what reveals satellites straying inside Earth / beyond Mars: gap < 0 = stray.
  getAdaptedEccentricApsides() {
    const rAt = (orbit, angleDeg) => positionFromSolarAngle(orbit, ((angleDeg % 360) + 360) % 360).r;
    // Planet radius on a shared angular grid (sampled once, reused for every ring).
    const STEP = 3, N = Math.round(360 / STEP);
    const earthRGrid = new Float64Array(N), marsRGrid = new Float64Array(N);
    for (let i = 0; i < N; i++) { const a = i * STEP; earthRGrid[i] = rAt(this.Earth, a); marsRGrid[i] = rAt(this.Mars, a); }
    const rows = [];
    for (const el of this.orbitalElements) {
      if (!el.ringName || !el.ringName.startsWith("ring_adecc")) continue;
      const argPeri = typeof el.p === "number" ? el.p : 0; // ecliptic longitude of perihelion
      const periAngle = ((argPeri % 360) + 360) % 360;
      const apoAngle = ((argPeri + 180) % 360 + 360) % 360;
      const rPeri = el.apsides ? el.apsides.periapsis : el.a * (1 - el.e);
      const rApo = el.apsides ? el.apsides.apoapsis : el.a * (1 + el.e);
      // Sweep the ring's orbit; track where it comes closest to crossing each planet
      // orbit (+ = clearance, − = the ring's satellites are inside Earth / beyond Mars).
      let wEarth = Infinity, wEarthAng = periAngle, wMars = Infinity, wMarsAng = apoAngle;
      for (let i = 0; i < N; i++) {
        const rr = rAt(el, i * STEP);
        const eg = rr - earthRGrid[i]; // Earth side: + = outside Earth (good)
        const mg = marsRGrid[i] - rr;  // Mars side:  + = inside Mars  (good)
        if (eg < wEarth) { wEarth = eg; wEarthAng = i * STEP; }
        if (mg < wMars) { wMars = mg; wMarsAng = i * STEP; }
      }
      rows.push({
        ringName: el.ringName,
        peri: { angle: periAngle, ringR: rPeri, planetR: rAt(this.Earth, periAngle), gap: rPeri - rAt(this.Earth, periAngle) },
        apo: { angle: apoAngle, ringR: rApo, planetR: rAt(this.Mars, apoAngle), gap: rAt(this.Mars, apoAngle) - rApo },
        worstEarth: { gap: wEarth, angle: wEarthAng },
        worstMars: { gap: wMars, angle: wMarsAng },
      });
    }
    return rows;
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

  /**
   * Ring-density value at u∈[0,1] from control anchors {x∈[0,1], y≥0}, assumed sorted
   * by x. Piecewise-linear between anchors, held flat before the first / after the
   * last. Shared by the ring placement, the chart editor and the distribution card so
   * all three draw the exact same curve.
   */
  densityFromAnchors(anchors, u) {
    const n = anchors ? anchors.length : 0;
    if (!n) return 1;
    if (n === 1) return anchors[0].y;
    if (u <= anchors[0].x) return anchors[0].y;
    if (u >= anchors[n - 1].x) return anchors[n - 1].y;
    for (let i = 0; i < n - 1; i++) {
      const a = anchors[i], b = anchors[i + 1];
      if (u >= a.x && u <= b.x) {
        const span = b.x - a.x;
        return span <= 0 ? a.y : a.y + (b.y - a.y) * ((u - a.x) / span);
      }
    }
    return anchors[n - 1].y;
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
      // RAAN, arg-perigee, eccentricity and inclination each blend Earth↔Mars by a
      // per-`a` percentage via addInterpolationBias over the natural per-`a`
      // interpolation: 0% = Earth value, 50% = the natural interpolation, 100% = Mars
      // value. That percentage is itself a curve over the ring's position u =
      // (a−aEarth)/(aMars−aEarth): the chart editor supplies the anchors; if absent we
      // fall back to the constant scalar (the old single-slider behaviour).
      const u = Math.min(1, Math.max(0, (a - this.Earth.a) / ((this.Mars.a - this.Earth.a) || 1)));
      const pctOf = (curve, fallback) =>
        Array.isArray(curve) && curve.length >= 2
          ? Math.min(100, Math.max(0, this.densityFromAnchors(curve, u)))
          : fallback;
      return {
        i: this.addInterpolationBias(this.interpolateOrbitalElement(a, "i"), pctOf(this.adaptedInclinationCurve, earthMarsInclinationPct), "i"),
        o: this.addInterpolationBias(this.interpolateOrbitalElement(a, "o"), pctOf(this.adaptedRaanCurve, this.adaptedRaanPct ?? 100), "o"), // RAAN
        p: this.addInterpolationBias(this.interpolateOrbitalElement(a, "p"), pctOf(this.adaptedArgPeriCurve, this.adaptedArgPeriPct ?? 100), "p"), // arg perigee
        a: a,
        n: n,
        e: this.addInterpolationBias(this.interpolateOrbitalElement(a, "e"), pctOf(this.adaptedEccentricityCurve, this.adaptedEccentricityPct ?? 100), "e"),
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
