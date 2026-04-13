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

import { SimSolarSystem } from "./simSolarSystem.js?v=4.5";
import { SimSatellites } from "./simSatellites.js?v=4.5";
import { SimLinkBudget } from "./simLinkBudget.js?v=4.5";
import { SimNetwork } from "./simNetwork.js?v=4.5";
import { SimDeployment } from "./simDeployment.js?v=4.5";
import { SimMissionValidator } from "./simMissionValidator.js?v=4.5";

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
  simDeployment.setSatelliteMassConfig(
    uiConfig["economics.satellite-empty-mass"],
    uiConfig["laser_technology.laser-terminal-mass"],
    {
      ring_earth: uiConfig["ring_earth.laser-ports-per-satellite"],
      ring_mars: uiConfig["ring_mars.laser-ports-per-satellite"],
      circular_rings: uiConfig["circular_rings.laser-ports-per-satellite"],
      eccentric_rings: uiConfig["eccentric_rings.laser-ports-per-satellite"],
      adapted_rings: uiConfig["adapted_rings.laser-ports-per-satellite"],
    }
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
      routeCount: routeSummary.routeCount,
      minThroughput: routeSummary.minThroughput,
      avgThroughput: routeSummary.avgThroughput,
      maxThroughput: routeSummary.maxThroughput,
      minLatency: routeSummary.minLatency,
      avgLatency: routeSummary.avgLatency,
      maxLatency: routeSummary.maxLatency,
      routes: routeSummary.routes,
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

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "init") {
    ensureState();
    self.postMessage({ type: "ready" });
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
