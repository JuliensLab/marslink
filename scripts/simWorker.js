// simWorker.js — Heavy simulation pipeline running in a Web Worker.
//
// Owns its own copies of the simulation state (SimSatellites, SimNetwork,
// SimLinkBudget, SimSolarSystem, SimDeployment) and runs the full pipeline
// on demand for a given (config, simDate) pair. Posts the result back so the
// main thread can cache it in the -1/0/+1 window buffer and display it
// without ever blocking the render loop.
//
// Loaded as an ES module worker:
//   new Worker(new URL("./simWorker.js", import.meta.url), { type: "module" })

import { SimSolarSystem } from "./simSolarSystem.js?v=5.59";
import { SimSatellites } from "./simSatellites.js?v=5.59";
import { SimLinkBudget } from "./simLinkBudget.js?v=5.59";
import { SimNetwork } from "./simNetwork.js?v=5.59";
import { SimDeployment } from "./simDeployment.js?v=5.59";
import { SimMissionValidator } from "./simMissionValidator.js?v=5.59";
import { DEFAULTS as FTRADE_DEFAULTS, terminalForFactor } from "./simFTrade.js?v=5.59";
import { minOf } from "./simMath.js?v=5.59";
import { buildFlowSummary } from "./simMaxFlow.js?v=5.59";
import { linksToThumbData } from "./simThumbs.js?v=5.59";
import { EARTH_MARS_CLOSEST_APPROACH_DEG } from "./simOrbits.js?v=5.59";
import { planetRingRequiredMbps, junctionDeficits } from "./slidersData.js?v=5.59";

// --- State (initialized lazily on the first compute) ---
let simLinkBudget = null;
let simSolarSystem = null;
let simSatellites = null;
let simNetwork = null;
let simDeployment = null;

function ensureState() {
  if (simLinkBudget) return;
  simLinkBudget = new SimLinkBudget();
  simSolarSystem = new SimSolarSystem();
  simDeployment = new SimDeployment(simSolarSystem.getSolarSystemData().planets);
  simSatellites = new SimSatellites(simLinkBudget, simSolarSystem.getSolarSystemData().planets);
  simNetwork = new SimNetwork(simLinkBudget, simSatellites);
}

/**
 * Pure derivation of ringCapacities/interCap from a possibleLinks array.
 * Mirrors SimMain.calculateCapacityInfo exactly.
 */
function calculateCapacityInfo(links) {
  const ringCapacities = {};
  const interCap = {};
  links.forEach((link) => {
    let fromRing = link.fromId.split("-")[0];
    let toRing = link.toId.split("-")[0];
    if (fromRing === "Earth") fromRing = "ring_earth";
    if (fromRing === "Mars") fromRing = "ring_mars";
    if (toRing === "Earth") toRing = "ring_earth";
    if (toRing === "Mars") toRing = "ring_mars";
    const cap = link.gbpsCapacity * 1000;
    if (!ringCapacities[fromRing]) ringCapacities[fromRing] = { inring: [], flows: 0, flowsCount: 0, planetLinks: [] };
    if (!ringCapacities[toRing]) ringCapacities[toRing] = { inring: [], flows: 0, flowsCount: 0, planetLinks: [] };
    if (fromRing === toRing) {
      const isPlanetLink = link.fromId === "Earth" || link.toId === "Earth" || link.fromId === "Mars" || link.toId === "Mars";
      if (isPlanetLink) {
        // Planet-to-satellite ground links — track separately, don't mix into inring.
        // Also keep each side's capacity verbatim (sat-name suffix sign gives the side:
        // "0","1",… prograde → groundPos; "-0","-1",… retrograde → groundNeg) — the
        // capacity card's planet flanks report exactly these two links. Mirrored in
        // SimMain.calculateCapacityInfo.
        if (link.fromId === "Earth" || link.toId === "Earth") {
          const satId = link.fromId === "Earth" ? link.toId : link.fromId;
          const rc = ringCapacities["ring_earth"];
          rc.planetLinks.push({ cap, satId });
          if (satId.slice("ring_earth".length + 1).startsWith("-")) rc.groundNeg = cap;
          else rc.groundPos = cap;
        }
        if (link.fromId === "Mars" || link.toId === "Mars") {
          const satId = link.fromId === "Mars" ? link.toId : link.fromId;
          const rc = ringCapacities["ring_mars"];
          rc.planetLinks.push({ cap, satId });
          if (satId.slice("ring_mars".length + 1).startsWith("-")) rc.groundNeg = cap;
          else rc.groundPos = cap;
        }
      } else {
        ringCapacities[fromRing].inring.push(cap);
      }
    } else {
      const isInterplanetary =
        (fromRing === "ring_earth" && toRing === "ring_mars") || (fromRing === "ring_mars" && toRing === "ring_earth");
      if (isInterplanetary) {
        ringCapacities[fromRing].flows += cap;
        ringCapacities[toRing].flows += cap;
        ringCapacities[fromRing].flowsCount += 1;
        ringCapacities[toRing].flowsCount += 1;
      } else {
        if (fromRing === "ring_earth") ringCapacities["ring_earth"].planetLinks.push({ cap, satId: link.toId });
        if (fromRing === "ring_mars") ringCapacities["ring_mars"].planetLinks.push({ cap, satId: link.toId });
        const key = [fromRing, toRing].sort().join("-");
        if (!interCap[key]) interCap[key] = { sum: 0, count: 0, min: Infinity, max: 0 };
        interCap[key].sum += cap;
        interCap[key].count += 1;
        if (cap < interCap[key].min) interCap[key].min = cap;
        if (cap > interCap[key].max) interCap[key].max = cap;
      }
    }
  });
  return { ringCapacities, interCap };
}

/**
 * Sun angles (ecliptic longitude, degrees) of the satellites participating in each
 * planet-ring <-> relay junction, with per-link capacity, plus each planet's own sun
 * angle. Archived with the results so the junction-pair distribution around the
 * tangent/closest-approach point can be measured offline (knee model validation).
 */
function collectJunctionAngles(links, satellites, planets) {
  const ang = (p) => Math.round((Math.atan2(p.y, p.x) * 18000) / Math.PI) / 100; // deg, 0.01 res
  const satAng = new Map();
  for (const s of satellites) if (s && s.name && s.position) satAng.set(s.name, ang(s.position));
  const isRelay = (id) => id && id.startsWith("ring_") && !id.startsWith("ring_earth") && !id.startsWith("ring_mars");
  const out = { earth: { deg: [], relayDeg: [], gbps: [] }, mars: { deg: [], relayDeg: [], gbps: [] } };
  for (const l of links) {
    let planetSide = null, side = null;
    if (l.fromId.startsWith("ring_earth") && isRelay(l.toId)) { planetSide = l.fromId; side = "earth"; }
    else if (l.toId.startsWith("ring_earth") && isRelay(l.fromId)) { planetSide = l.toId; side = "earth"; }
    else if (l.fromId.startsWith("ring_mars") && isRelay(l.toId)) { planetSide = l.fromId; side = "mars"; }
    else if (l.toId.startsWith("ring_mars") && isRelay(l.fromId)) { planetSide = l.toId; side = "mars"; }
    if (!side) continue;
    const relaySide = planetSide === l.fromId ? l.toId : l.fromId;
    const a = satAng.get(planetSide), b = satAng.get(relaySide);
    if (a == null || b == null) continue;
    out[side].deg.push(a);
    out[side].relayDeg.push(b);
    out[side].gbps.push(Math.round((l.gbpsCapacity || 0) * 1000) / 1000);
  }
  for (const p of planets) {
    if (p && p.name === "Earth" && p.position) out.earthPlanetDeg = ang(p.position);
    if (p && p.name === "Mars" && p.position) out.marsPlanetDeg = ang(p.position);
  }
  return out;
}

/**
 * Run the full pipeline for one compute request.
 */
function runPipeline({ requestId, windowIdx, configEpoch, uiConfig, satellitesConfig, simDate, computeFlow }) {
  ensureState();
  const t0 = performance.now();
  const timings = {};
  const mark = (name, start) => { timings[name] = Math.round(performance.now() - start); };

  // 1. Sync technology + deployment config
  simLinkBudget.setTechnologyConfig(uiConfig);
  simDeployment.setVehicleConfig(uiConfig);
  simDeployment.setSatelliteMassConfig(
    uiConfig["satellite.satellite-empty-mass"],
    uiConfig["laser_technology.laser-terminal-mass"],
    simLinkBudget.maxLinksPerRing
  );

  // 2. Apply satellite config
  let t = performance.now();
  simSatellites.setMaxSatCount(uiConfig["simulation.maxSatCount"]);
  simSatellites.setSatellitesConfig(satellitesConfig);
  mark("setSatellitesConfig", t);

  // 3. Compute positions for the requested simDate
  t = performance.now();
  // Main-UI geometry placement: mirror the live override from uiConfig so the
  // worker's window computes place Earth/Mars exactly like the main thread does
  // (simMain.setSatellitesConfig applies the same maps to its own instances).
  // The planetary rings rotate rigidly with their pinned planet — same map on
  // simSatellites (see setPlanetAngleOverrides).
  const pinMap =
    uiConfig && uiConfig["simulation.planet-placement"] === "Geometry"
      ? {
          Earth: EARTH_MARS_CLOSEST_APPROACH_DEG + (parseFloat(uiConfig["simulation.earth-angle-offset-deg"]) || 0),
          Mars: EARTH_MARS_CLOSEST_APPROACH_DEG + (parseFloat(uiConfig["simulation.mars-angle-offset-deg"]) || 0),
        }
      : null;
  simSolarSystem.setAngleOverrides(pinMap);
  simSatellites.setPlanetAngleOverrides(pinMap);
  const planetsObj = simSolarSystem.updatePlanetsPositions(simDate);
  const planets = Object.values(planetsObj);
  const satellites = simSatellites.updateSatellitesPositions(simDate);
  const satellitesCount = satellites.length;
  mark("updatePositions", t);

  // 3b. Run the station-keeping model (avg thruster count + n-year propellant per
  //     ring, with per-sat sizing on planetary rings) so the deployment dry mass +
  //     SK propellant — and therefore launch flights & cost — reflect it.
  {
    const bodyPos = {};
    for (const p of planets) if (p && p.position) bodyPos[p.name] = p.position;
    const skCfg = {
      F: (uiConfig["satellite.satellite-thrust"] || 170) / 1000,
      tm: uiConfig["satellite.thruster-system-mass"] >= 0 ? uiConfig["satellite.thruster-system-mass"] : 15,
      maxN: uiConfig["satellite.max-thrusters"] >= 1 ? uiConfig["satellite.max-thrusters"] : 64,
      n: uiConfig["satellite.sk-years"] >= 1 ? uiConfig["satellite.sk-years"] : 5,
      isp: uiConfig["satellite.satellite-isp"] || 2500,
      capacity: uiConfig["satellite.satellite-propellant-capacity"] || 1500,
    };
    simDeployment.computeStationKeeping(satellites, simSatellites.getOrbitalElements(), bodyPos, skCfg);
  }

  // 4. Mission profile + cost trees
  let missionProfilesData = null;
  let resultTreesData = null;
  try {
    t = performance.now();
    missionProfilesData = simDeployment.getMissionProfile(simSatellites.getOrbitalElements());
    mark("getMissionProfile", t);
    t = performance.now();
    resultTreesData = new SimMissionValidator(missionProfilesData, {
      costPerLaunch: uiConfig["economics.launch-cost-slider"],
      costPerSatellite: uiConfig["economics.satellite-cost-slider"],
      costPerLaserTerminal: (() => { // paper Appendix A component model at current f
        const lr = Number.isFinite(simLinkBudget.cTermGbps) ? simLinkBudget.cTermGbps : FTRADE_DEFAULTS.lineRateGbps;
        const t = terminalForFactor(simLinkBudget.techImprovementFactor,
          { ...FTRADE_DEFAULTS, termVolM: uiConfig["economics.laser-terminal-cost-slider"], lineRateGbps: lr });
        return t.hwM + t.busM;
      })(),
      laserPortsPerSatellite: simLinkBudget.maxLinksPerSatellite,
    });
    mark("missionValidator", t);
  } catch (e) {
    console.warn("[Worker] mission profile failed:", e.message);
  }

  // 5. Topology
  t = performance.now();
  const possibleLinks = simNetwork.getPossibleLinks(planets, satellites);
  const routeSummary = simNetwork.routeSummary;
  mark("getPossibleLinks", t);
  // Capture per-phase topology breakdown from the builder
  const topologyTimings = simNetwork.topology?.lastTopologyTimings || null;

  // 6. Capacity info
  t = performance.now();
  const capacityInfo = calculateCapacityInfo(possibleLinks);
  capacityInfo.junctionAngles = collectJunctionAngles(possibleLinks, satellites, planets);
  mark("calculateCapacityInfo", t);

  // 7. Strip routeSummary to clonable data
  let routeSummaryClone = null;
  if (routeSummary) {
    routeSummaryClone = {
      totalThroughput: routeSummary.totalThroughput,
      // Relay-intrinsic capacity (planet-ring hops excluded) — the deterministic input
      // for the Earth/Mars auto-sizer; must survive the clone or the sizer falls back
      // to the planet-hop-contaminated total (the satCount-hysteresis bug).
      relayOnlyThroughput: routeSummary.relayOnlyThroughput,
      routeCount: routeSummary.routeCount,
      minThroughput: routeSummary.minThroughput,
      avgThroughput: routeSummary.avgThroughput,
      maxThroughput: routeSummary.maxThroughput,
      relayOnlyMin: routeSummary.relayOnlyMin,
      relayOnlyAvg: routeSummary.relayOnlyAvg,
      relayOnlyMax: routeSummary.relayOnlyMax,
      minLatency: routeSummary.minLatency,
      avgLatency: routeSummary.avgLatency,
      maxLatency: routeSummary.maxLatency,
      routes: routeSummary.routes,
      ringDetail: routeSummary.ringDetail, // per-ring junction/route detail (eccentric families)
    };
  }

  // ── EARLY DELIVERY: send links immediately so the main thread can
  //    display the constellation while flow is still computing. ──
  const linksMs = Math.round(performance.now() - t0);
  self.postMessage({
    type: "links-ready",
    requestId,
    windowIdx,
    configEpoch,
    satellitesCount,
    possibleLinks,
    capacityInfo,
    routeSummary: routeSummaryClone,
    missionProfilesData,
    resultTreesData,
    topologyTimings,
    linksMs,
  });

  // 8. Flow + latencies (the slow part — runs AFTER links are delivered)
  let networkData = null;
  let latencyData = null;
  if (computeFlow) {
    t = performance.now();
    const fullNetworkData = simNetwork.getNetworkData(planets, satellites, possibleLinks, simLinkBudget.calctimeMs);
    mark("getNetworkData", t);
    if (!fullNetworkData.error) {
      t = performance.now();
      latencyData = simNetwork.calculateLatencies(fullNetworkData, 60 * 5);
      mark("calculateLatencies", t);
    }
    networkData = {
      links: fullNetworkData.links,
      maxFlowGbps: fullNetworkData.maxFlowGbps,
      error: fullNetworkData.error || null,
    };
  }

  return {
    type: "result",
    requestId,
    windowIdx,
    configEpoch,
    satellitesCount,
    possibleLinks,
    capacityInfo,
    routeSummary: routeSummaryClone,
    missionProfilesData,
    resultTreesData,
    networkData,
    latencyData,
    topologyTimings,
    timings,
    totalMs: Math.round(performance.now() - t0),
  };
}

/**
 * Geometry-sampling mode (optimizer + sensitivity "geometry" planet placement):
 * relocate Earth & Mars to explicit orbital longitudes, decoupled from `date`. Angles
 * are measured from the Earth–Mars closest-approach direction (the narrowest part of
 * the gap the relay must bridge) — EARTH_MARS_CLOSEST_APPROACH_DEG — NOT Mars's
 * perihelion as before. The relay satellites stay at `date` (a fixed reference phase
 * set by the caller); the dense rings are ~rotation-invariant, so the score reflects
 * the planet geometry. No-op unless both offsets are provided.
 */
function applyGeometryOffsets(earthAngleOffset, marsAngleOffset) {
  if (earthAngleOffset == null || marsAngleOffset == null) return;
  const ref = EARTH_MARS_CLOSEST_APPROACH_DEG;
  simSolarSystem.setPlanetSolarAngle("Earth", ref + earthAngleOffset);
  simSolarSystem.setPlanetSolarAngle("Mars", ref + marsAngleOffset);
  // Persist the pin so (a) any later updatePlanetsPositions keeps the planets
  // placed, and (b) the NEXT updateSatellitesPositions rotates the planetary
  // rings rigidly with their planet (the ring's hub gap must sit AT the pinned
  // planet, not at the ephemeris position the ring was phased to). runScenario
  // clears both maps on entry, so this never leaks across scenarios.
  const pinMap = { Earth: ref + earthAngleOffset, Mars: ref + marsAngleOffset };
  simSolarSystem.setAngleOverrides(pinMap);
  simSatellites.setPlanetAngleOverrides(pinMap);
}

/**
 * Run ONE full sensitivity scenario end-to-end in the worker: the iterative
 * ring-sizing feedback loop followed by the flow/latency compute. This mirrors
 * the former main-thread sweep (simUi feedback loop + SimMain.longTermRun) so a
 * pool of workers can compute scenarios in parallel.
 *
 * The feedback loop runs in integer user-facing Mbps. Because requiredmbpsbetweensats
 * is a pow10 slider whose stored value is round(10^log10(mbps)) === round(mbps),
 * working directly in integer Mbps is bit-identical to the old slider-position path.
 *
 * @param {object} msg.uiConfig          scenario config (ring/tech baked + seed requiredmbps)
 * @param {string} msg.simDate           ISO date string for this scenario
 * @param {number} msg.flowCalctimeMs    max-flow time budget (longTermRun uses 20000)
 * @param {number} msg.maxIterations     feedback-loop cap (100, matching the serial path)
 */
function runScenario({ requestId, scenarioId, uiConfig, simDate, sizingDate, flowCalctimeMs = 20000, maxIterations = 15, sizingBudgetMs = 6000, objectiveOnly = false, earthAngleOffset = null, marsAngleOffset = null, includeLinks = false, computeFlow = true, captureThumbs = false }) {
  ensureState();
  // Scenarios place planets explicitly (applyGeometryOffsets after each position
  // update) — clear any persistent main-UI override a prior runPipeline left on
  // this worker's shared solar system so it can't leak into scenario results.
  // applyGeometryOffsets re-establishes both maps for this scenario's own pin.
  simSolarSystem.setAngleOverrides(null);
  simSatellites.setPlanetAngleOverrides(null);
  const t0 = performance.now();
  const date = new Date(simDate);
  // The constellation is sized once (serial path sizes at dateValues[0]); flow is
  // then computed at this scenario's own date.
  const sizeDate = new Date(sizingDate || simDate);

  // 1. Sync technology + deployment config (once — these don't change during sizing).
  simLinkBudget.setTechnologyConfig(uiConfig);
  simDeployment.setVehicleConfig(uiConfig);
  simDeployment.setSatelliteMassConfig(
    uiConfig["satellite.satellite-empty-mass"],
    uiConfig["laser_technology.laser-terminal-mass"],
    simLinkBudget.maxLinksPerRing
  );
  simSatellites.setMaxSatCount(uiConfig["simulation.maxSatCount"]);

  const buildAndApply = () => {
    simSatellites.setSatellitesConfig(simSatellites.buildConfigFromUi(uiConfig));
  };

  // Auto junction rings (Contoured transfer): sizing is EMPIRICAL — measure the
  // built topology, grow the failing side (step 2b below). Start every scenario
  // from 0/0 so the planetary sizing measures a junction-free base and the
  // growth is deterministic. Manual mode keeps the configured counts.
  const jctAuto =
    uiConfig["adapted_eccentric_rings.junction-ring-mode"] === "auto" &&
    uiConfig["relay_type.selected"] === "Contoured transfer";
  if (jctAuto) {
    uiConfig["adapted_eccentric_rings.junction-ring-count"] = 0;
    uiConfig["adapted_eccentric_rings.junction-ring-count-mars"] = 0;
  }

  // Measurement seed: the relay aggregate (relayOnlyThroughput) is relay-INTRINSIC —
  // planet-ring size plays no part in it — so measure on MINIMAL planet rings. The
  // analytic UI seed can overshoot the sat cap and blank the first build (concentric
  // 61 rings @100k cap: 102,913-seed-sat fleet -> blanked -> aggregate 0 -> the sizing
  // guard skipped -> scenario returned 0 sats), while the properly SIZED fleet fits.
  if (uiConfig["relay_type.planet_sizing"] !== "off") {
    uiConfig["ring_earth.requiredmbpsbetweensats"] = 1;
    uiConfig["ring_mars.requiredmbpsbetweensats"] = 1;
  }

  // 2. Planetary sizing — the canonical measure→size step, ITERATED TO ITS FIXED
  //    POINT (2026-07-27; supersedes the 2026-07-21 single-shot). The single-shot
  //    premise — "relayOnlyThroughput is relay-intrinsic, planet-ring size plays no
  //    part in it" — is false at MEASUREMENT time: routes anchor on planet-ring
  //    satellites, so the minimal 1 Mbps measurement fleet starves the junction
  //    pairing and under-measures the aggregate (concentric R=10: 88 Mbps measured
  //    on minimal rings vs 150 Mbps on sized rings → rate 45 instead of ~75 → the
  //    under-built planet rings' ground links become the max-flow min-cut at ~55%
  //    of routed — THE sweep flow-collapse bug). Fix: after sizing + rebuild,
  //    re-measure and re-size until the rate stops moving (≤1 Mbps or 1%) — the
  //    same fixed point the live auto-sizer converges to over its sizing rounds.
  //    The 1 Mbps first pass stays: it is guaranteed buildable (the analytic seed
  //    can overshoot the sat cap and blank the build) and the loop recovers from
  //    it. The first 3 passes run regardless of sizingBudgetMs (2 are needed for
  //    correctness, 3 to confirm convergence); beyond that the budget applies.
  //    planet_sizing === "off" now really means off — manual rates are honored,
  //    matching the live selector's semantics (the old code re-sized them anyway).
  buildAndApply();
  let iterations = 1;
  if (uiConfig["relay_type.planet_sizing"] !== "off") {
    let prevRate = null;
    while (iterations < Math.max(3, maxIterations) && (iterations < 3 || performance.now() - t0 < sizingBudgetMs)) {
      const planets = Object.values(simSolarSystem.updatePlanetsPositions(sizeDate));
      const satellites = simSatellites.updateSatellitesPositions(sizeDate);
      simNetwork.getPossibleLinks(planets, satellites);
      const rs = simNetwork.routeSummary;
      const relayAggregate = rs ? (rs.relayOnlyThroughput ?? rs.totalThroughput) : 0;
      if (!(relayAggregate > 0)) break;
      const rate = planetRingRequiredMbps(relayAggregate);
      console.log(`[ScenarioSizing] #${scenarioId} pass ${iterations}: relayAggregate=${Math.round(relayAggregate)} -> planet rate ${Math.round(rate)} Mbps, elapsed=${Math.round(performance.now() - t0)}ms`);
      const converged = prevRate != null && Math.abs(rate - prevRate) <= Math.max(1, 0.01 * prevRate);
      uiConfig["ring_earth.requiredmbpsbetweensats"] = rate;
      uiConfig["ring_mars.requiredmbpsbetweensats"] = rate;
      buildAndApply(); // rebuild at the new rate (also what the junction links attach against)
      iterations++;
      prevRate = rate;
      if (converged) break;
    }
  }

  // Fast path for optimizers: the adapted-ring relay capacity (routeSummary
  // .totalThroughput) comes straight from the topology builder and is independent
  // of both the planet-ring sizing loop and the max-flow solve. So skip the
  // mission profile, cost trees, max-flow and latencies — just build the topology
  // once and return the relay throughput. Orders of magnitude cheaper per eval.
  if (objectiveOnly) {
    const planetsArr = simSolarSystem.updatePlanetsPositions(date);
    applyGeometryOffsets(earthAngleOffset, marsAngleOffset);
    const planets = Object.values(planetsArr);
    const satellites = simSatellites.updateSatellitesPositions(date);
    simNetwork.getPossibleLinks(planets, satellites);
    const rs = simNetwork.routeSummary;
    // Zone counts so the optimizer can constrain rings to stay between the planet
    // orbits (no satellite inside Earth's orbit or outside Mars's).
    let insideEarth = 0, outsideMars = 0;
    for (const s of satellites) {
      if (s.orbitalZone === "INSIDE_EARTH") insideEarth++;
      else if (s.orbitalZone === "OUTSIDE_MARS") outsideMars++;
    }
    return {
      type: "scenario-result",
      requestId,
      scenarioId,
      satellitesCount: satellites.length,
      zoneCounts: { insideEarth, outsideMars },
      maxFlowGbps: 0,
      capacityInfo: null,
      routeSummary: rs
        ? {
            totalThroughput: rs.totalThroughput, routeCount: rs.routeCount,
            minThroughput: rs.minThroughput, avgThroughput: rs.avgThroughput, maxThroughput: rs.maxThroughput,
            // Latency stats are produced by the topology route builder (no max-flow
            // needed), so they ride the fast path for the optimizer's latency goal.
            minLatency: rs.minLatency, avgLatency: rs.avgLatency, maxLatency: rs.maxLatency,
          }
        : null,
      resultTreesData: null,
      latencyData: null,
      iterations,
      totalMs: Math.round(performance.now() - t0),
    };
  }

  // 2b. Auto junction-ring growth — EMPIRICAL (Julien's rule, 2026-07-22): measure
  //     each ring's junction bundle against its own two-route capacity on the BUILT
  //     topology (the shared slidersData.junctionDeficits test); while a side has
  //     any shortfall, add one ring to it and re-run ONLY the junction stage — the
  //     base topology (relay + planetary rings and all their links) is built once
  //     and reused. Junction rings regenerate per step (they re-space at j/(k+1))
  //     via a scratch SimSatellites; they are the cheap part.
  if (jctAuto) {
    const MAX_JCT = 8; // matches the junction-ring-count slider max
    const planets = Object.values(simSolarSystem.updatePlanetsPositions(sizeDate));
    const baseSats = simSatellites.updateSatellitesPositions(sizeDate); // fleet is k=0 here
    const ctx = simNetwork.prepareBaseTopology(planets, baseSats);
    const scratch = new SimSatellites(simLinkBudget, simSolarSystem.getSolarSystemData().planets);
    scratch.setMaxSatCount(uiConfig["simulation.maxSatCount"]);
    const jctSatsFor = () => {
      const cfgs = scratch.buildConfigFromUi(uiConfig).filter((c) => (c.ringName || "").startsWith("ring_jct"));
      scratch.setSatellitesConfig(cfgs);
      return scratch.updateSatellitesPositions(sizeDate);
    };
    let kE = 0, kM = 0;
    let rs = simNetwork.applyJunctionStage(ctx, []);
    for (;;) {
      const fail = junctionDeficits(rs && rs.ringDetail);
      const eGrow = fail.earth && kE < MAX_JCT;
      const mGrow = fail.mars && kM < MAX_JCT;
      if (!eGrow && !mGrow) break;
      if (eGrow) kE++;
      if (mGrow) kM++;
      uiConfig["adapted_eccentric_rings.junction-ring-count"] = kE;
      uiConfig["adapted_eccentric_rings.junction-ring-count-mars"] = kM;
      simNetwork.revertJunctionStage(ctx);
      rs = simNetwork.applyJunctionStage(ctx, jctSatsFor());
      iterations++;
      console.log(`[ScenarioSizing] #${scenarioId} junction shortfall -> rings E${kE}/M${kM} (incremental, ${Math.round(performance.now() - t0)}ms)`);
    }
    // One full fleet build with the settled counts so the final compute (step 3, at
    // the scenario's own date) sees the real constellation. 0/0 needs nothing —
    // the fleet already matches.
    if (kE > 0 || kM > 0) buildAndApply();
  }

  // 3. Final scenario compute (mirrors SimMain.longTermRun for a single date).
  const planetsObj = simSolarSystem.updatePlanetsPositions(date);
  applyGeometryOffsets(earthAngleOffset, marsAngleOffset);
  const planets = Object.values(planetsObj);
  const satellites = simSatellites.updateSatellitesPositions(date);
  const satellitesCount = satellites.length;
  // Fleet-cap truncation must ride the result: a capped build measures a
  // partial constellation and its numbers are NOT the configuration's.
  const satsRequested = simSatellites.requestedSatelliteCount || satellitesCount;
  const satsTruncated = !!simSatellites.satellitesTruncated;

  let missionProfilesData = null, resultTreesData = null;
  try {
    missionProfilesData = simDeployment.getMissionProfile(simSatellites.getOrbitalElements());
    resultTreesData = new SimMissionValidator(missionProfilesData, {
      costPerLaunch: uiConfig["economics.launch-cost-slider"],
      costPerSatellite: uiConfig["economics.satellite-cost-slider"],
      costPerLaserTerminal: (() => { // paper Appendix A component model at current f
        const lr = Number.isFinite(simLinkBudget.cTermGbps) ? simLinkBudget.cTermGbps : FTRADE_DEFAULTS.lineRateGbps;
        const t = terminalForFactor(simLinkBudget.techImprovementFactor,
          { ...FTRADE_DEFAULTS, termVolM: uiConfig["economics.laser-terminal-cost-slider"], lineRateGbps: lr });
        return t.hwM + t.busM;
      })(),
      laserPortsPerRing: simLinkBudget.maxLinksPerRing,
      propellantCostsPerKg: {
        "CH4/O2": uiConfig["economics.fuel-cost-ch4o2"],
        Argon: uiConfig["economics.fuel-cost-argon"],
      },
      wrightsLawFactor: (uiConfig["economics.wrights-law-factor"] || 100) / 100,
    });
  } catch (e) {
    console.warn("[Worker] scenario mission profile failed:", e.message);
  }

  const possibleLinks = simNetwork.getPossibleLinks(planets, satellites);
  const routeSummary = simNetwork.routeSummary;
  const capacityInfo = calculateCapacityInfo(possibleLinks);
  capacityInfo.junctionAngles = collectJunctionAngles(possibleLinks, satellites, planets);

  // Max-flow is optional: once the design process is relay-network-first (planet rings
  // sized to match the relay capacity), the solve just re-derives routeSummary's
  // throughput — skipping it makes sweeps far cheaper. maxFlowGbps === null then means
  // "not computed" (vs 0 = solved to zero), and consumers fall back to routeSummary.
  let fullNetworkData = null, flowError = null, maxFlowGbps = null, latencyData = null, flowSummary = null;
  if (computeFlow) {
    fullNetworkData = simNetwork.getNetworkData(planets, satellites, possibleLinks, flowCalctimeMs);
    // A timed-out max-flow solve is "too large to solve", NOT "0 Gbps achievable" — flag it
    // so the caller can show a gap instead of a misleading drop to zero (see buildScenarioMetrics).
    flowError = fullNetworkData.error || null;
    maxFlowGbps = flowError ? 0 : (fullNetworkData.maxFlowGbps || 0);
    if (!fullNetworkData.error) latencyData = simNetwork.calculateLatencies(fullNetworkData);
    // Flow-card aggregates (ground/junction flows + ROUTE-USE accounting): the links
    // they derive from never cross postMessage in sweeps, so summarize here. Shared
    // with the live capture via buildFlowSummary so every archived flow result —
    // sweep, paper plan, or live — records the same shape, including how many of
    // the capacity step's routes carried flow and at what fraction of capacity.
    if (!flowError && Array.isArray(fullNetworkData.links)) {
      flowSummary = buildFlowSummary(fullNetworkData.links, maxFlowGbps, routeSummary?.routes);
    }
  }

  let routeSummaryClone = null;
  if (routeSummary) {
    routeSummaryClone = {
      totalThroughput: routeSummary.totalThroughput,
      // Relay-intrinsic capacity (planet-ring hops excluded) — the deterministic input
      // for the Earth/Mars auto-sizer; must survive the clone or the sizer falls back
      // to the planet-hop-contaminated total (the satCount-hysteresis bug).
      relayOnlyThroughput: routeSummary.relayOnlyThroughput,
      routeCount: routeSummary.routeCount,
      minThroughput: routeSummary.minThroughput,
      avgThroughput: routeSummary.avgThroughput,
      maxThroughput: routeSummary.maxThroughput,
      relayOnlyMin: routeSummary.relayOnlyMin,
      relayOnlyAvg: routeSummary.relayOnlyAvg,
      relayOnlyMax: routeSummary.relayOnlyMax,
      minLatency: routeSummary.minLatency,
      avgLatency: routeSummary.avgLatency,
      maxLatency: routeSummary.maxLatency,
      ringDetail: routeSummary.ringDetail, // per-ring junction/route detail (eccentric families)
    };
  }

  // Thumbnail geometry (opt-in): compact [x1,y1,x2,y2,capMbps,flowMbps] segments
  // + planet positions, extracted HERE because link-endpoint positions only
  // exist in this scope. The main thread renders the two images (canvas is
  // DOM-only) and stores them on the archive entry.
  let thumbData;
  if (captureThumbs) {
    const pos = new Map();
    for (const s of satellites) if (s && s.name && s.position) pos.set(s.name, s.position);
    for (const p of planets) if (p && p.name && p.position) pos.set(p.name, p.position);
    const thumbLinks = (fullNetworkData && fullNetworkData.links && fullNetworkData.links.length) ? fullNetworkData.links : possibleLinks;
    thumbData = linksToThumbData(thumbLinks, (id) => pos.get(id), planets) || undefined;
  }

  return {
    type: "scenario-result",
    requestId,
    scenarioId,
    satellitesCount,
    satsRequested,
    satsTruncated,
    maxFlowGbps,
    thumbData,
    // Solved links (flow-annotated when the flow finished) — opt-in ONLY: the in-process
    // main-thread sensitivity path uses them to display each scenario's routes during the
    // dwell. The worker/pool path never sets includeLinks (postMessage clone weight).
    possibleLinks: includeLinks ? ((fullNetworkData && fullNetworkData.links && fullNetworkData.links.length) ? fullNetworkData.links : possibleLinks) : undefined,
    // In-process display mode also gets the mission profiles (right-panel costs need them
    // for the fuel/report paths). By reference — never crosses postMessage.
    missionProfilesData: includeLinks ? missionProfilesData : undefined,
    flowError,
    // Flow-card aggregates (null when the solve was skipped, errored, or links missing).
    flowSummary,
    capacityInfo,
    routeSummary: routeSummaryClone,
    resultTreesData,
    latencyData: includeLinks
      ? latencyData // in-process display mode: full object so the latency chart can render
      : latencyData
        ? { bestLatency: latencyData.bestLatency, medianLatency: latencyData.medianLatency,
            averageLatency: latencyData.averageLatency,
            // Latency-card histogram: [{latency (bin start, s), totalGbps}] — small, archived.
            histogram: latencyData.histogram || null }
        : null,
    sizedConfig: {
      "ring_earth.requiredmbpsbetweensats": uiConfig["ring_earth.requiredmbpsbetweensats"],
      "ring_mars.requiredmbpsbetweensats": uiConfig["ring_mars.requiredmbpsbetweensats"],
      // Auto mode records the grown count so the archive and the display rebuild
      // show what the scenario actually flew; manual echoes the configured value.
      "adapted_eccentric_rings.junction-ring-count": uiConfig["adapted_eccentric_rings.junction-ring-count"],
      "adapted_eccentric_rings.junction-ring-count-mars": uiConfig["adapted_eccentric_rings.junction-ring-count-mars"],
    },
    iterations,
    totalMs: Math.round(performance.now() - t0),
  };
}

// Exported so the main thread can run the IDENTICAL scenario pipeline in-process
// (sensitivity "Main thread" mode) instead of dispatching to a worker. These use this
// module's own sim-state singletons, independent of SimMain's display instances.
export { ensureState, runScenario };

// Only wire the worker message handler in a real Worker context — when this module is
// imported on the main thread (for "Main thread" sweeps) `self` is `window`, and we must
// not hijack window.onmessage.
const inWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
if (inWorker) self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "init") {
    ensureState();
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "computeScenario") {
    try {
      self.postMessage(runScenario(msg));
    } catch (err) {
      self.postMessage({
        type: "scenario-error",
        requestId: msg.requestId,
        scenarioId: msg.scenarioId,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
      });
    }
    return;
  }

  if (msg.type === "compute") {
    try {
      const result = runPipeline(msg);
      self.postMessage(result);
    } catch (err) {
      self.postMessage({
        type: "error",
        requestId: msg.requestId,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
      });
    }
    return;
  }
};
