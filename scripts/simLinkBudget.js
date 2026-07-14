// simLinkBudget.js

import { SIM_CONSTANTS } from "./simConstants.js?v=4.39";

export class SimLinkBudget {
  constructor() {
    this.baseGbps = SIM_CONSTANTS.DEFAULT_BASE_GBPS;
    this.baseDistanceKm = SIM_CONSTANTS.DEFAULT_BASE_DISTANCE_KM;
    this.techImprovementFactor = 1;
    this.AU_IN_KM = SIM_CONSTANTS.AU_IN_KM;
    this.SPEED_OF_LIGHT_KM_S = SIM_CONSTANTS.SPEED_OF_LIGHT_KM_S;
    // Per-terminal line-rate ceiling (Gbps). The physical link is power-limited
    // (capacity ∝ 1/d²) until the terminal saturates at its electronics line rate;
    // past that, shortening the link no longer buys throughput. Default Infinity =
    // non-binding (pure 1/d², unchanged behaviour); lower it to model the ceiling
    // that makes densification saturate and forces extra rings at scale.
    this.cTermGbps = SIM_CONSTANTS.TERMINAL_LINE_RATE_GBPS ?? Infinity;
  }

  setTechnologyConfig(technologyConfig) {
    this.baseGbps = technologyConfig["laser_technology.current-throughput-gbps"];
    this.baseDistanceKm = technologyConfig["laser_technology.current-distance-km"];
    this.maxDistanceAU = technologyConfig["simulation.maxDistanceAU"];
    this.calctimeMs = technologyConfig["simulation.calctimeSec"] * 1000;
    // Adapted-concentric "Circular lattice": how many laser terminals each sat spends on
    // intra-ring (azimuthal) links — 0 none, 1 half (matching), 2 full ring. Built on top
    // of the fixed radial backbone; computed up here so the adapted port totals below can
    // include it. Mapped from the radio label to a count.
    {
      const opt = technologyConfig["adapted_rings.lattice"] || "Full lattice (2 laser terminals)";
      this.adaptedLattice = opt.startsWith("No") ? 0 : opt.startsWith("Half") ? 1 : 2;
    }

    // The adapted families' port slider was repurposed to mean EXTRA terminals for
    // spacecraft-in-transit links, on TOP of the fixed topology terminals. Total per-sat
    // terminals = topology base + extra:
    //   • adapted concentric: 2 radial  + lattice (0/1/2) + extra
    //   • adapted eccentric:  2 in-ring + 1 junction      + extra
    const adaptExtra = Math.max(0, Math.round(+technologyConfig["adapted_rings.extra-terminals"] || 0));
    const adeccExtra = Math.max(0, Math.round(+technologyConfig["adapted_eccentric_rings.extra-terminals"] || 0));

    this.maxLinksPerRing = {
      ring_earth: technologyConfig["ring_earth.laser-ports-per-satellite"],
      ring_mars: technologyConfig["ring_mars.laser-ports-per-satellite"],
      circular_rings: technologyConfig["circular_rings.laser-ports-per-satellite"],
      eccentric_rings: technologyConfig["eccentric_rings.laser-ports-per-satellite"],
      adapted_rings: 2 + this.adaptedLattice + adaptExtra,
      adapted_eccentric_rings: 2 + 1 + adeccExtra,
    };

    // Global cap = max of all per-ring values (used as fallback and topology cap)
    this.maxLinksPerSatellite = Math.max(...Object.values(this.maxLinksPerRing).filter((v) => v > 0));

    this.techImprovementFactor = Math.pow(2, technologyConfig["laser_technology.improvement-factor"]);

    // Solar exclusion: angular margin (in degrees) from the sun's visible edge
    this.solarExclusionDeg = technologyConfig["simulation.solarExclusionDeg"] || 0;
    this.solarExclusionRad = this.solarExclusionDeg * SIM_CONSTANTS.DEG_TO_RAD;

    // Max-flow solver, now chosen PER RING TYPE: the concentric families have a fast
    // specialized solver, the eccentric families need a general one. Resolve the active
    // relay family's "<section>.flow-solver" (with a per-family code default so legacy
    // configs without the key still pick a working solver).
    const RELAY_SECTION = {
      "Contoured concentric": "adapted_rings",
      "Contoured eccentric": "adapted_eccentric_rings",
      "Circular": "circular_rings",
      "Eccentric": "eccentric_rings",
    };
    const DEFAULT_SOLVER = {
      adapted_rings: "concentric-topology-aware",
      circular_rings: "push-relabel",
      eccentric_rings: "push-relabel",
      adapted_eccentric_rings: "push-relabel",
    };
    const relaySection = RELAY_SECTION[technologyConfig["relay_type.selected"]] || "adapted_rings";
    this.flowAlgorithm = technologyConfig[`${relaySection}.flow-solver`] || DEFAULT_SOLVER[relaySection];

    // Inter-ring (radial backbone) matcher for the concentric families — three variants
    // kept selectable for comparison (see TopologyBuilder.interAdaptedRings).
    this.interRingMatcher = technologyConfig["simulation.interring-matcher"] || "linear-merge";

    // "Route continuity" — a single multi-checkbox carrying both prune toggles (comma-joined).
    //  • Require inner link (default on): drop chains not reaching the Earth ring; also enforced
    //    inline by greedy-nearest (a sat links outward only if it has an inward feed).
    //  • Require outer link (default off): drop chains not reaching the Mars ring.
    // pruneIncompleteRadialChains reads both; greedy-nearest's inline pass reads inner only.
    const routeContinuity = String(technologyConfig["simulation.route-continuity"] ?? "Require inner link");
    this.greedyRadialContinuity = routeContinuity.includes("Require inner link");
    this.greedyRequireOuterLink = routeContinuity.includes("Require outer link");

    // "greedy-merge" matcher: max sun-angle (degrees) the island-merge fork-swap may span from a
    // stalagmite tip. Larger = merges more islands but allows wider lateral shifts; default 3°.
    const swapDeg = parseFloat(technologyConfig["simulation.greedy-merge-swap-degrees"]);
    this.greedyMergeSwapDegrees = Number.isFinite(swapDeg) && swapDeg >= 0 ? swapDeg : 3;

    // Adapted-eccentric "cross-ring links" toggle: link the nearest sat on each of
    // two rings where their tracks cross in the xy plane, using the spare radial
    // laser. Default on (only affects topologies that actually use eccentric rings).
    this.eccentricCrossRingLinks = technologyConfig["adapted_eccentric_rings.cross-ring-links"] !== "no";

    // Invalidate Gbps cache when tech config changes
    this._gbpsCache = new Map();
    // Precompute constant factor: techImprovementFactor * baseGbps * baseDistanceKm²
    this._gbpsFactor = this.techImprovementFactor * this.baseGbps * this.baseDistanceKm * this.baseDistanceKm;
  }

  convertAUtoKM(AU) {
    return AU * this.AU_IN_KM;
  }

  // Function to calculate Gbps capacity based on distance
  // Bucketed cache: distances rounded to 100km share the same result
  calculateGbps(distanceKm) {
    if (isNaN(distanceKm) || distanceKm <= 0) return 0;
    const bucket = (distanceKm / 100) | 0; // 100km buckets
    const cached = this._gbpsCache.get(bucket);
    if (cached !== undefined) return cached;
    // Power-limited capacity (∝ 1/d²), clamped at the terminal line rate.
    const result = Math.min(this.cTermGbps, this._gbpsFactor / (distanceKm * distanceKm));
    this._gbpsCache.set(bucket, result);
    return result;
  }

  // Function to calculate distance based on Gbps capacity
  calculateKm(gbps) {
    if (gbps <= 0) return Infinity;
    return Math.round(this.baseDistanceKm * Math.sqrt((this.techImprovementFactor * this.baseGbps) / gbps));
  }

  // Function to calculate latency based on distance
  calculateLatencySeconds(distanceKm) {
    return distanceKm / this.SPEED_OF_LIGHT_KM_S;
  }

  // Function to calculate distance between two positions
  calculateDistance(a, b) {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2) + Math.pow(a.z - b.z, 2));
  }

  getMaxLinksPerSatellite() {
    return this.maxLinksPerSatellite;
  }

  getMaxLinksPerRing(ringName) {
    if (!ringName) return this.maxLinksPerSatellite;
    if (ringName === "ring_earth") return this.maxLinksPerRing.ring_earth;
    if (ringName === "ring_mars") return this.maxLinksPerRing.ring_mars;
    if (ringName.startsWith("ring_circ")) return this.maxLinksPerRing.circular_rings;
    if (ringName.startsWith("ring_adecc")) return this.maxLinksPerRing.adapted_eccentric_rings || this.maxLinksPerSatellite;
    if (ringName.startsWith("ring_ecce")) return this.maxLinksPerRing.eccentric_rings;
    if (ringName.startsWith("ring_adapt")) return this.maxLinksPerRing.adapted_rings || this.maxLinksPerSatellite;
    return this.maxLinksPerSatellite; // fallback
  }
}
