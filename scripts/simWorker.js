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

import { SimSolarSystem } from "./simSolarSystem.js?v=4.38";
import { SimSatellites } from "./simSatellites.js?v=4.38";
import { SimLinkBudget } from "./simLinkBudget.js?v=4.38";
import { SimNetwork } from "./simNetwork.js?v=4.38";
import { SimDeployment } from "./simDeployment.js?v=4.38";
import { SimMissionValidator } from "./simMissionValidator.js?v=4.38";
import { minOf } from "./simMath.js?v=4.38";
import { EARTH_MARS_CLOSEST_APPROACH_DEG } from "./simOrbits.js?v=4.38";

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
        if (link.fromId === "Earth" || link.toId === "Earth") {
          const satId = link.fromId === "Earth" ? link.toId : link.fromId;
          ringCapacities["ring_earth"].planetLinks.push({ cap, satId });
        }
        if (link.fromId === "Mars" || link.toId === "Mars") {
          const satId = link.fromId === "Mars" ? link.toId : link.fromId;
          ringCapacities["ring_mars"].planetLinks.push({ cap, satId });
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
        if (!interCap[key]) interCap[key] = { sum: 0, count: 0 };
        interCap[key].sum += cap;
        interCap[key].count += 1;
      }
    }
  });
  return { ringCapacities, interCap };
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
      costPerLaserTerminal: uiConfig["economics.laser-terminal-cost-slider"],
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
function runScenario({ requestId, scenarioId, uiConfig, simDate, sizingDate, flowCalctimeMs = 20000, maxIterations = 15, sizingBudgetMs = 6000, objectiveOnly = false, earthAngleOffset = null, marsAngleOffset = null, includeLinks = false }) {
  ensureState();
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

  // 2. Feedback ring-sizing loop (mirrors the old simUi sensitivity loop, but
  //    bounded: a low iteration cap, a wall-clock budget, and cycle detection so
  //    a non-converging config can't spin ~100 expensive iterations — each rebuilds
  //    the full constellation + topology, which both hangs the sweep and grows the
  //    worker's share of the shared V8 heap cage until the renderer OOMs).
  buildAndApply();
  let iterations = 0;
  let prevEarthMin = -1, prevMarsMin = -1;
  const seenStates = new Set();
  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    if (performance.now() - t0 > sizingBudgetMs) {
      console.log(`[ScenarioSizing] #${scenarioId} BUDGET-STOP after ${i} update(s), elapsed=${Math.round(performance.now() - t0)}ms of ${sizingBudgetMs}ms`);
      break; // wall-clock guard
    }
    const planets = Object.values(simSolarSystem.updatePlanetsPositions(sizeDate));
    const satellites = simSatellites.updateSatellitesPositions(sizeDate);
    const links = simNetwork.getPossibleLinks(planets, satellites);
    const rs = simNetwork.routeSummary;
    if (!rs || !rs.totalThroughput || rs.totalThroughput <= 0) break;
    const capInfo = calculateCapacityInfo(links);

    const eInring = capInfo.ringCapacities?.["ring_earth"]?.inring || [];
    const mInring = capInfo.ringCapacities?.["ring_mars"]?.inring || [];
    const curEarth = eInring.length ? Math.round(2 * minOf(eInring)) : 0;
    const curMars = mInring.length ? Math.round(2 * minOf(mInring)) : 0;
    if (curEarth === prevEarthMin && curMars === prevMarsMin) break; // no-progress (period-1)
    // Oscillation guard: if we revisit a measured state, the config is cycling
    // (e.g. A→B→A) and will never settle in the band — stop on the current build.
    const stateKey = `${curEarth},${curMars}`;
    if (seenStates.has(stateKey)) break;
    seenStates.add(stateKey);
    prevEarthMin = curEarth;
    prevMarsMin = curMars;

    // _feedbackStep, integer-Mbps form
    if (eInring.length === 0 || mInring.length === 0) break; // skip
    const target = rs.totalThroughput;
    const earthMin = 2 * minOf(eInring);
    const marsMin = 2 * minOf(mInring);
    const lo = target * 1.02, hi = target * 1.04;
    if (earthMin >= lo && earthMin <= hi && marsMin >= lo && marsMin <= hi) break; // converged

    const oldEarth = uiConfig["ring_earth.requiredmbpsbetweensats"];
    const oldMars = uiConfig["ring_mars.requiredmbpsbetweensats"];
    const aim = target * 1.03;
    const newEarth = earthMin > 0 ? Math.max(1, Math.round(oldEarth * aim / earthMin)) : oldEarth;
    const newMars = marsMin > 0 ? Math.max(1, Math.round(oldMars * aim / marsMin)) : oldMars;
    console.log(`[ScenarioSizing] #${scenarioId} it=${i} target=${Math.round(target)} earthMin=${Math.round(earthMin)} marsMin=${Math.round(marsMin)} rate E ${Math.round(oldEarth)}->${newEarth} M ${Math.round(oldMars)}->${newMars} elapsed=${Math.round(performance.now() - t0)}ms`);
    if (newEarth === oldEarth && newMars === oldMars) break; // converged (no slider move)

    uiConfig["ring_earth.requiredmbpsbetweensats"] = newEarth;
    uiConfig["ring_mars.requiredmbpsbetweensats"] = newMars;
    buildAndApply(); // rebuild for the next measurement
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

  // 3. Final scenario compute (mirrors SimMain.longTermRun for a single date).
  const planetsObj = simSolarSystem.updatePlanetsPositions(date);
  applyGeometryOffsets(earthAngleOffset, marsAngleOffset);
  const planets = Object.values(planetsObj);
  const satellites = simSatellites.updateSatellitesPositions(date);
  const satellitesCount = satellites.length;

  let missionProfilesData = null, resultTreesData = null;
  try {
    missionProfilesData = simDeployment.getMissionProfile(simSatellites.getOrbitalElements());
    resultTreesData = new SimMissionValidator(missionProfilesData, {
      costPerLaunch: uiConfig["economics.launch-cost-slider"],
      costPerSatellite: uiConfig["economics.satellite-cost-slider"],
      costPerLaserTerminal: uiConfig["economics.laser-terminal-cost-slider"],
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

  const fullNetworkData = simNetwork.getNetworkData(planets, satellites, possibleLinks, flowCalctimeMs);
  // A timed-out max-flow solve is "too large to solve", NOT "0 Gbps achievable" — flag it
  // so the caller can show a gap instead of a misleading drop to zero (see buildScenarioMetrics).
  const flowError = fullNetworkData.error || null;
  const maxFlowGbps = flowError ? 0 : (fullNetworkData.maxFlowGbps || 0);
  let latencyData = null;
  if (!fullNetworkData.error) latencyData = simNetwork.calculateLatencies(fullNetworkData);

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
      minLatency: routeSummary.minLatency,
      avgLatency: routeSummary.avgLatency,
      maxLatency: routeSummary.maxLatency,
      ringDetail: routeSummary.ringDetail, // per-ring junction/route detail (eccentric families)
    };
  }

  return {
    type: "scenario-result",
    requestId,
    scenarioId,
    satellitesCount,
    maxFlowGbps,
    // Solved links (flow-annotated when the flow finished) — opt-in ONLY: the in-process
    // main-thread sensitivity path uses them to display each scenario's routes during the
    // dwell. The worker/pool path never sets includeLinks (postMessage clone weight).
    possibleLinks: includeLinks ? ((fullNetworkData.links && fullNetworkData.links.length) ? fullNetworkData.links : possibleLinks) : undefined,
    // In-process display mode also gets the mission profiles (right-panel costs need them
    // for the fuel/report paths). By reference — never crosses postMessage.
    missionProfilesData: includeLinks ? missionProfilesData : undefined,
    flowError,
    capacityInfo,
    routeSummary: routeSummaryClone,
    resultTreesData,
    latencyData: includeLinks
      ? latencyData // in-process display mode: full object so the latency chart can render
      : latencyData
        ? { bestLatency: latencyData.bestLatency, medianLatency: latencyData.medianLatency, averageLatency: latencyData.averageLatency }
        : null,
    sizedConfig: {
      "ring_earth.requiredmbpsbetweensats": uiConfig["ring_earth.requiredmbpsbetweensats"],
      "ring_mars.requiredmbpsbetweensats": uiConfig["ring_mars.requiredmbpsbetweensats"],
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
