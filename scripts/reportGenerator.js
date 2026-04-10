// reportGenerator.js

import { printTree, SimMissionValidator } from "./simMissionValidator.js?v=4.3";
import {
  createLaunchSchedule,
  renderOrbitChartSVG,
  formatDate,
} from "./hohmannTransfer.js?v=4.3";
import { planLaunches, aggregateRingFromFlights } from "./launchPlanner.js?v=4.3";

// Per-ring flight list stashed by generateReport so the flight slider can
// re-render charts without recomputing the whole schedule.
const ringFlightsByRing = new Map();
// Per-ring target radius lookup (AU) for the slider re-render handler.
let _ringR2ByName = new Map();
// Per-ring orbital elements lookup for drawing real-shape target orbits.
let _ringElementsByName = new Map();
// Earth / Mars elements stashed for the slider re-render handler.
let _earthElementsRef = null;
let _marsElementsRef = null;

/**
 * Build printTree output for a single flight's vehicles by running them
 * through the SimMissionValidator tree-builder. Returns an HTML string.
 *
 * The profile's vehicles are already computed by the planner for the exact
 * sat count of this flight (re-run with maxSatCount when it differs from
 * max capacity), so no patching is needed — masses, propellant, tanker
 * counts are all internally consistent.
 */
function buildFlightTreeHtml(vehicles, satsThisFlight) {
  const dummyProfiles = {
    byOrbit: [{
      ringName: "_flight",
      satCount: satsThisFlight,
      deploymentFlights_count: 1,
      satCountPerDeploymentFlight: satsThisFlight,
      vehicles,
    }],
  };
  const dummyCosts = { costPerLaunch: 0, costPerSatellite: 0, costPerLaserTerminal: 0, laserPortsPerRing: {} };
  const resultTrees = new SimMissionValidator(dummyProfiles, dummyCosts);
  if (!resultTrees || !resultTrees[0] || !resultTrees[0].trees) return "";
  let html = "";
  for (const tree of resultTrees[0].trees) {
    html += printTree("&nbsp;", vehicles, tree, 0).join("<br>") + "<br><br>";
  }
  return html;
}

/**
 * Extract payload capacity % and post-refuel propellant % for a single flight
 * from its profile's vehicles object.
 */
function getFlightCapacityPcts(vehicles, satsThisFlight) {
  const starship = vehicles?.Starship;
  if (!starship) return { payloadPct: 0, refuelPct: 0 };

  // Payload %: actual deployed mass vs Starship's max payload capacity
  let payloadMassKg = 0;
  for (const m of starship.maneuvers) {
    if (m.type === "payload deployment (carrier)" && m.individualPayloadMass_kg) {
      payloadMassKg = m.individualPayloadMass_kg * satsThisFlight;
      break;
    }
  }
  const payloadPct = starship.maxPayloadCapacity_kg > 0
    ? Math.round((payloadMassKg / starship.maxPayloadCapacity_kg) * 100)
    : 0;

  // Post-refuel %: total propellant received from tankers vs Starship tank capacity.
  // The Starship's "propellant transfer (receive)" maneuvers have negative
  // usedPropellantMass_kg — the absolute value is the amount received.
  let tankerTotal = 0;
  for (const m of starship.maneuvers) {
    if (m.type === "propellant transfer (receive)") {
      tankerTotal += Math.abs(m.usedPropellantMass_kg || 0);
    }
  }
  const refuelPct = starship.propellantCapacity_kg > 0
    ? Math.round((tankerTotal / starship.propellantCapacity_kg) * 100)
    : 0;

  return { payloadPct, refuelPct };
}

function orderRingsForReport(resultTrees) {
  // Earth first, Mars second, then original order for the rest.
  const earth = resultTrees.filter((r) => r.ringName === "ring_earth");
  const mars = resultTrees.filter((r) => r.ringName === "ring_mars");
  const others = resultTrees.filter((r) => r.ringName !== "ring_earth" && r.ringName !== "ring_mars");
  return [...earth, ...mars, ...others];
}

// Helper function to get vehicle icon
function getIcon(vehicle) {
  if (vehicle.includes("Satellite")) {
    return "img/hardware/starlink.png";
  } else if (vehicle.includes("Starship")) {
    return "img/hardware/starship.png";
  } else if (vehicle.includes("Booster")) {
    return "img/hardware/booster.png";
  }
  return "";
}
/** Determines the payload type or ID for a vehicle */
function getPayloadForVehicle(vehicles, vehicleId) {
  const vehicle = vehicles[vehicleId];
  for (const maneuver of vehicle.maneuvers) {
    if (maneuver.type === "payload deployment (carrier)") {
      return `${maneuver.payloadId}${maneuver?.payloadCountPerDeploymentFlight > 1 ? " x" + maneuver.payloadCountPerDeploymentFlight : ""}`;
    } else if (maneuver.type === "propellant transfer (send)") {
      return `Propellant ${Math.round(vehicle.tankerPropellant_kg / 1000)}t`;
    }
  }
  return "";
}

function formatNumber(num, precision = 0) {
  // Step 1: Convert to string with specified precision
  let fixed = num.toFixed(precision);

  // Step 2: Split into integer and decimal parts (if precision > 0)
  let parts = fixed.split(".");
  let integerPart = parts[0];
  let formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  // Step 3: Return formatted number, with decimal part only if precision > 0
  if (precision > 0) {
    let decimalPart = parts[1];
    return formattedInteger + "." + decimalPart;
  } else {
    return formattedInteger;
  }
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function generateReport(missionProfiles, resultTrees, costs, satellites, options = {}) {
  const { schedule: scheduleParams, earthElements, marsElements, orbitalElements, simDeployment } = options;
  _earthElementsRef = earthElements || null;
  _marsElementsRef = marsElements || null;

  const portsPerRing = costs.laserPortsPerRing || {};
  const getPortsForRing = (ringName) => {
    if (ringName === "ring_earth") return portsPerRing.ring_earth || 2;
    if (ringName === "ring_mars") return portsPerRing.ring_mars || 2;
    if (ringName.startsWith("ring_circ")) return portsPerRing.circular_rings || 2;
    if (ringName.startsWith("ring_ecce")) return portsPerRing.eccentric_rings || 2;
    if (ringName.startsWith("ring_adapt")) return portsPerRing.adapted_rings || 2;
    return 2;
  };

  // Per-ring orbital elements lookup (for real-shape orbit polylines + per-flight transfer math).
  const ringElementsByName = new Map();
  if (orbitalElements && Array.isArray(orbitalElements)) {
    for (const ele of orbitalElements) {
      if (ele && ele.ringName) ringElementsByName.set(ele.ringName, ele);
    }
  }
  _ringElementsByName = ringElementsByName;

  // Reorder: Earth first, Mars second, then existing order
  const orderedRings = orderRingsForReport(resultTrees);

  // Per-ring target radius (AU) for charting fallbacks.
  const ringR2ByName = new Map();
  for (const tree of orderedRings) {
    const ele = ringElementsByName.get(tree.ringName);
    if (ele && typeof ele.a === "number") {
      ringR2ByName.set(tree.ringName, ele.a);
    } else if (tree.ringName === "ring_mars") {
      ringR2ByName.set(tree.ringName, 1.5236365);
    } else {
      ringR2ByName.set(tree.ringName, 1.0);
    }
  }
  _ringR2ByName = ringR2ByName;

  // Launch schedule
  const schedule = createLaunchSchedule(
    scheduleParams || { startYear: 2028, rampEndYear: 2031, hoursBetweenFlights: 8, scrubFactorPct: 20 }
  );

  // Deficit round-robin launch planner produces a per-flight schedule with
  // per-flight Hohmann transfers (or escape burns for ring_earth) and calls
  // simDeployment for each flight's payload sizing. Ring aggregates are
  // derived from the per-flight profiles that come back.
  let ringFlights;
  if (simDeployment) {
    const planned = planLaunches({
      orderedRings,
      ringElementsByName,
      earthElements,
      schedule,
      simDeployment,
    });
    ringFlights = planned.ringFlights;
  } else {
    // Fallback (shouldn't happen in normal app flow): empty plan.
    ringFlights = new Map(orderedRings.map((t) => [t.ringName, []]));
  }

  // Build ring-level aggregates by summing the per-flight profiles the
  // planner produced. These replace the ring-level data that resultTrees
  // previously carried in the totals tables.
  const ringAggregates = new Map();
  for (const tree of orderedRings) {
    const flights = ringFlights.get(tree.ringName) || [];
    ringAggregates.set(tree.ringName, aggregateRingFromFlights(tree.ringName, flights));
  }

  // Stash for the flight-slider event handler
  ringFlightsByRing.clear();
  for (const [k, v] of ringFlights) ringFlightsByRing.set(k, v);

  let totalsSections = "";
  totalsSections += `<div class="totals-section">`;
  totalsSections += `<h2>Totals</h2>`;

  // Propellant costs from input sliders (fall back to defaults)
  const propellantCostsPerKg = costs.propellantCostsPerKg || { "CH4/O2": 0.3, Argon: 0.5 };

  // Build the orbits object from per-flight aggregates (Earth/Mars first,
  // then the rest). Each ring's propellant/flight counts/tanker counts come
  // from summing the per-flight profiles the planner generated.
  const orbits = {};
  for (const tree of orderedRings) {
    const agg = ringAggregates.get(tree.ringName) || {
      ringName: tree.ringName,
      satCount: 0,
      deploymentFlights_count: 0,
      satCountPerDeploymentFlight: 0,
      tankersPerFlight: 0,
      totalTankerFlights: 0,
      propellant: {},
    };
    orbits[tree.ringName] = {
      deploymentFlights_count: agg.deploymentFlights_count,
      satCountPerDeploymentFlight: agg.satCountPerDeploymentFlight,
      satCount: agg.satCount,
      propellant: agg.propellant,
      tankersPerFlight: agg.tankersPerFlight,
      totalTankerFlights: agg.totalTankerFlights,
    };
  }

  // Get unique propellant types
  const allPropellantTypes = [];
  for (const orbit of Object.values(orbits))
    for (const propellantType of Object.keys(orbit.propellant))
      if (!allPropellantTypes.includes(propellantType)) allPropellantTypes.push(propellantType);

  // Technical Table
  totalsSections += `<h3>Technical Summary</h3>`;
  totalsSections += `<div class="table technical">`;
  totalsSections += `<table>`;
  totalsSections += `<tr>`;
  totalsSections += `<th>Orbit</th>`;
  totalsSections += `<th>Satellites</th>`;
  totalsSections += `<th>Laser Terminals</th>`;
  totalsSections += `<th>Deployment Flights</th>`;
  totalsSections += `<th>Tanker Flights</th>`;
  totalsSections += `<th>Sats / Deployment Flight</th>`;
  totalsSections += `<th>First Launch</th>`;
  totalsSections += `<th>Last Launch</th>`;
  for (let propellantType of allPropellantTypes) totalsSections += `<th>${esc(propellantType)} (t)</th>`;
  totalsSections += `</tr>`;

  let totalDeploymentFlights_count = 0;
  let totalSatCount = 0;
  let totalLaserCount = 0;
  let totalTankerFlights = 0;

  for (const [orbitId, orbitData] of Object.entries(orbits)) {
    totalDeploymentFlights_count += orbitData.deploymentFlights_count;
    totalSatCount += orbitData.satCount;
    totalLaserCount += orbitData.satCount * getPortsForRing(orbitId);
    // With per-flight payload sizing the tanker count varies flight-to-flight,
    // so use the planner's summed total (not avg × flights).
    const totalTankerFlightsForOrbit = orbitData.totalTankerFlights ?? (orbitData.tankersPerFlight * orbitData.deploymentFlights_count);
    totalTankerFlights += totalTankerFlightsForOrbit;

    const flightsForOrbit = ringFlights.get(orbitId) || [];
    const firstLaunch = flightsForOrbit.length > 0 ? formatDate(flightsForOrbit[0].launchDate) : "—";
    const lastLaunch = flightsForOrbit.length > 0 ? formatDate(flightsForOrbit[flightsForOrbit.length - 1].launchDate) : "—";
    totalsSections += `<tr>`;
    totalsSections += `<td>${esc(orbitId)}</td>`;
    totalsSections += `<td>${orbitData.satCount.toLocaleString()}</td>`;
    totalsSections += `<td>${(orbitData.satCount * getPortsForRing(orbitId)).toLocaleString()}</td>`;
    totalsSections += `<td>${orbitData.deploymentFlights_count.toLocaleString()}</td>`;
    totalsSections += `<td>${totalTankerFlightsForOrbit.toLocaleString()}</td>`;
    totalsSections += `<td>${orbitData.satCountPerDeploymentFlight}</td>`;
    totalsSections += `<td>${firstLaunch}</td>`;
    totalsSections += `<td>${lastLaunch}</td>`;
    for (let propellantType of allPropellantTypes) {
      const mass_kg = orbitData.propellant[propellantType]
        ? orbitData.propellant[propellantType].selfPropulsion_kg + orbitData.propellant[propellantType].tankerPropellant_kg
        : 0;
      totalsSections += `<td>${mass_kg ? Math.round(mass_kg / 1000).toLocaleString() : 0}</td>`;
    }
    totalsSections += `</tr>`;
  }

  // Overall first/last launch across all rings
  let overallFirst = null;
  let overallLast = null;
  for (const flights of ringFlights.values()) {
    for (const f of flights) {
      if (!f.launchDate) continue;
      if (!overallFirst || f.launchDate < overallFirst) overallFirst = f.launchDate;
      if (!overallLast || f.launchDate > overallLast) overallLast = f.launchDate;
    }
  }
  totalsSections += `<tr>`;
  totalsSections += `<th>Totals</th>`;
  totalsSections += `<th>${totalSatCount.toLocaleString()}</th>`;
  totalsSections += `<th>${totalLaserCount.toLocaleString()}</th>`;
  totalsSections += `<th>${totalDeploymentFlights_count.toLocaleString()}</th>`;
  totalsSections += `<th>${totalTankerFlights.toLocaleString()}</th>`;
  totalsSections += `<th></th>`;
  totalsSections += `<th>${formatDate(overallFirst)}</th>`;
  totalsSections += `<th>${formatDate(overallLast)}</th>`;
  for (let propellantType of allPropellantTypes) {
    let totalMass_kg = 0;
    for (const orbitData of Object.values(orbits)) {
      totalMass_kg += orbitData.propellant[propellantType]
        ? orbitData.propellant[propellantType].selfPropulsion_kg + orbitData.propellant[propellantType].tankerPropellant_kg
        : 0;
    }
    totalsSections += `<th>${Math.round(totalMass_kg / 1000).toLocaleString()}</th>`;
  }
  totalsSections += `</tr>`;
  totalsSections += `</table>`;
  totalsSections += `</div>`;

  // Financial Table
  totalsSections += `<h3>Financial Summary (in million $)</h3>`;
  totalsSections += `<div class="table financial">`;
  totalsSections += `<table>`;
  totalsSections += `<tr><th>Orbit</th><th>Starships</th><th>Tankers</th><th>Satellites</th><th>Laser Terminals</th>`;

  // Add headers for each propellant type
  for (let propellantType of allPropellantTypes) {
    totalsSections += `<th>${esc(propellantType)}</th>`;
  }
  totalsSections += `<th>Total</th></tr>`;

  // Initialize grand totals
  let grandTotalStarshipCost = 0;
  let grandTotalTankerCost = 0;
  let grandTotalSatelliteCost = 0;
  let grandTotalLaserCost = 0;
  let grandTotalPropellantCosts = {};
  for (let propellantType of allPropellantTypes) {
    grandTotalPropellantCosts[propellantType] = 0;
  }
  let grandTotalCostAll = 0;

  // Calculate total tanker propellant to get accurate tanker count
  let total_tankerPropellant_kg = 0;
  for (const orbitData of Object.values(orbits)) {
    for (const propellantData of Object.values(orbitData.propellant)) {
      total_tankerPropellant_kg += propellantData.tankerPropellant_kg;
    }
  }
  const tankerCapacity_kg = 100000; // kg per tanker launch
  const calculatedTankerCount = Math.ceil(total_tankerPropellant_kg / tankerCapacity_kg);

  // Process each orbit
  for (const [orbitId, orbitData] of Object.entries(orbits)) {
    const starshipCost = orbitData.deploymentFlights_count * costs.costPerLaunchMillionUSD; // $10M per flight
    const tankerFlightsTotal = orbitData.totalTankerFlights ?? (orbitData.tankersPerFlight * orbitData.deploymentFlights_count);
    const tankerCost = tankerFlightsTotal * costs.costPerLaunchMillionUSD; // $10M per flight
    const satelliteCost = orbitData.satCount * costs.costPerSatelliteMillionUSD; // $5M per satellite
    const laserCost = orbitData.satCount * getPortsForRing(orbitId) * costs.costPerLaserTerminalMillionUSD; // Laser terminals cost
    let totalPropellantCost = 0;
    let propellantCostsForOrbit = {};

    // Calculate cost for each propellant type
    for (let propellantType of allPropellantTypes) {
      const mass_kg = orbitData.propellant[propellantType]
        ? orbitData.propellant[propellantType].selfPropulsion_kg + orbitData.propellant[propellantType].tankerPropellant_kg
        : 0;
      const cost = (mass_kg * (propellantCostsPerKg[propellantType] || 0)) / 1000000; // Convert to $M
      propellantCostsForOrbit[propellantType] = cost;
      totalPropellantCost += cost;
      grandTotalPropellantCosts[propellantType] += cost;
    }

    const totalCostForOrbit = starshipCost + tankerCost + satelliteCost + laserCost + totalPropellantCost;
    // Add row for this orbit (updated)
    totalsSections += `<tr>`;
    totalsSections += `<td>${esc(orbitId)}</td>`;
    totalsSections += `<td>${formatNumber(starshipCost)}</td>`;
    totalsSections += `<td>${formatNumber(tankerCost)}</td>`;
    totalsSections += `<td>${formatNumber(satelliteCost)}</td>`;
    totalsSections += `<td>${formatNumber(laserCost)}</td>`;
    for (let propellantType of allPropellantTypes) {
      totalsSections += `<td>${formatNumber(propellantCostsForOrbit[propellantType])}</td>`;
    }
    totalsSections += `<td>${formatNumber(totalCostForOrbit)}</td>`;
    totalsSections += `</tr>`;

    // Update grand totals
    grandTotalStarshipCost += starshipCost;
    grandTotalTankerCost += tankerCost;
    grandTotalSatelliteCost += satelliteCost;
    grandTotalLaserCost += laserCost;
    grandTotalCostAll += totalCostForOrbit;
  }

  // Adjust tanker cost to match actual propellant needs
  const plannedTankerCost = grandTotalTankerCost;
  grandTotalTankerCost = calculatedTankerCount * costs.costPerLaunchMillionUSD;
  const tankerCostAdjustment = grandTotalTankerCost - plannedTankerCost;
  grandTotalCostAll += tankerCostAdjustment;

  // Add grand total row
  totalsSections += `<tr>`;
  totalsSections += `<th>Totals</th>`;
  totalsSections += `<th>${formatNumber(grandTotalStarshipCost)}</th>`;
  totalsSections += `<th>${formatNumber(grandTotalTankerCost)}</th>`;
  totalsSections += `<th>${formatNumber(grandTotalSatelliteCost)}</th>`;
  totalsSections += `<th>${formatNumber(grandTotalLaserCost)}</th>`;
  for (let propellantType of allPropellantTypes) {
    totalsSections += `<th>${formatNumber(grandTotalPropellantCosts[propellantType])}</th>`;
  }
  totalsSections += `<th>${formatNumber(grandTotalCostAll)}</th>`;
  totalsSections += `</tr>`;

  totalsSections += `</table>`;

  // Add assumptions section here
  totalsSections += `<div class="assumptions">`;
  totalsSections += `<h3>Assumptions</h3>`;

  totalsSections += `<h4>Fuel Unit Costs</h4>`;
  totalsSections += `<table>`;
  totalsSections += `<tr><th>Propellant Type</th><th>Cost ($ per kg)</th></tr>`;
  for (let propellantType of allPropellantTypes) {
    const cost = propellantCostsPerKg[propellantType] || 0;
    totalsSections += `<tr><td>${esc(propellantType)}</td><td>${cost.toFixed(2)}</td></tr>`;
  }
  totalsSections += `</table>`;

  totalsSections += `<h4>Hardware Unit Costs</h4>`;
  totalsSections += `<table>`;
  totalsSections += `<tr><th>Item</th><th>Cost ($ million per unit)</th></tr>`;
  totalsSections += `<tr><td>Starship/Tanker flight</td><td>${costs.costPerLaunchMillionUSD}</td></tr>`;
  totalsSections += `<tr><td>Satellite</td><td>${costs.costPerSatelliteMillionUSD}</td></tr>`;
  totalsSections += `<tr><td>Laser port</td><td>${costs.costPerLaserTerminalMillionUSD}</td></tr>`;
  totalsSections += `</table>`;

  totalsSections += `</div>`;
  // Close totals-section
  totalsSections += `</div>`;

  totalsSections += `</div>`;

  // Orbit sections (iterating reordered list)
  let orbitSections = "";
  orderedRings.forEach((orbitTree) => {
    const flights = ringFlights.get(orbitTree.ringName) || [];
    const agg = ringAggregates.get(orbitTree.ringName) || {};
    const aggFlightCount = agg.deploymentFlights_count || 0;
    const aggSatCount = agg.satCount || 0;
    const firstLaunchStr = flights.length ? formatDate(flights[0].launchDate) : "—";
    const lastLaunchStr = flights.length ? formatDate(flights[flights.length - 1].launchDate) : "—";
    // Collapsible per-orbit block (collapsed by default to keep the report compact)
    orbitSections += `<details class="orbit-section">`;
    orbitSections += `<summary><h2>${esc(orbitTree.ringName)}</h2><span class="orbit-summary-meta">${aggSatCount.toLocaleString()} sats · ${aggFlightCount.toLocaleString()} flights · ${firstLaunchStr} → ${lastLaunchStr}</span></summary>`;

    // Propellant totals from the planner's aggregate (summed across per-flight profiles)
    const aggPropellant = agg.propellant || {};
    orbitSections += `<p>${aggFlightCount} deployment flights are required to put all ${aggSatCount} satellites into orbit.</p>`;

    orbitSections += `<div class="table propellant">`;
    orbitSections += `<table>`;
    orbitSections += `<tr><th>Propellant type</th><th>Propellant total (t)</th></tr>`;
    for (let [propellantType, data] of Object.entries(aggPropellant)) {
      const totalKg = (data.selfPropulsion_kg || 0) + (data.tankerPropellant_kg || 0);
      orbitSections += `<tr><td>${esc(propellantType)}</td><td>${Math.round(totalKg / 1000).toLocaleString()}</td></tr>`;
    }
    orbitSections += `</table>`;
    orbitSections += `</div>`;

    // Orbit chart + flight slider
    const r2 = ringR2ByName.get(orbitTree.ringName) || 1;
    const targetElements = ringElementsByName.get(orbitTree.ringName) || null;
    if (flights.length > 0) {
      const firstFlight = flights[0];
      const chartSvg = renderOrbitChartSVG({
        earthElements,
        marsElements,
        targetElements,
        targetAU: r2,
        earthPos: firstFlight.earthPos,
        burn2Pos: firstFlight.burn2Pos,
        width: 320,
        height: 320,
        burn1DateLabel: formatDate(firstFlight.launchDate),
        burn2DateLabel: formatDate(firstFlight.arrivalDate),
        flightLabel: `Flight ${firstFlight.flightIdx} / ${flights.length}`,
      });
      orbitSections += `<div class="orbit-chart" data-ring="${esc(orbitTree.ringName)}">`;
      orbitSections += `<div class="orbit-chart-svg">${chartSvg}</div>`;
      orbitSections += `<div class="orbit-chart-controls">`;
      orbitSections += `<label class="orbit-chart-slider-label">Flight <span class="flight-idx">1</span> / ${flights.length}</label>`;
      orbitSections += `<input type="range" min="1" max="${flights.length}" value="1" step="1" class="flight-slider" data-ring="${esc(orbitTree.ringName)}">`;
      orbitSections += `<div class="flight-meta">Launch: <span class="flight-launch">${formatDate(firstFlight.launchDate)}</span> · Arrival: <span class="flight-arrival">${formatDate(firstFlight.arrivalDate)}</span> · Transfer: ${Math.round(firstFlight.transferDays)} d</div>`;
      orbitSections += `</div>`;
      orbitSections += `</div>`;

      // Per-flight details: each flight is a collapsible <details> with the
      // summary row showing key stats and the expanded body showing the full
      // vehicle tree (launch sequence, separation, refueling, burns).
      orbitSections += `<div class="flight-schedule-list">`;
      orbitSections += `<p class="table-caption">Flight schedule (each flight computed with its own Hohmann transfer). Click a flight to expand launch details.</p>`;
      // Column header row (not clickable)
      orbitSections += `<div class="flight-header-row">`;
      orbitSections += `<span class="fh-num" title="Flight number for this ring">#</span>`;
      orbitSections += `<span class="fh-launch" title="Sequential launch number across all rings (Starship + tankers count as one launch)">Launch #</span>`;
      orbitSections += `<span class="fh-date" title="Earth departure date (Hohmann transfer injection burn)">Launch</span>`;
      orbitSections += `<span class="fh-date" title="Arrival date at target orbit (circularisation burn)">Arrival</span>`;
      orbitSections += `<span class="fh-small" title="Hohmann transfer duration in days">Days</span>`;
      orbitSections += `<span class="fh-small" title="Number of satellites deployed on this flight">Sats</span>`;
      orbitSections += `<span class="fh-small" title="Tanker flights required to refuel Starship in LEO before departure">Tnk</span>`;
      orbitSections += `<span class="fh-dv" title="Total outbound ΔV (km/s): Hohmann departure + arrival + inclination change">ΔV</span>`;
      orbitSections += `<span class="fh-pct" title="Starship payload mass as % of max payload capacity">Payload</span>`;
      orbitSections += `<span class="fh-pct" title="Starship propellant after tanker refuelling as % of tank capacity">Refuel</span>`;
      orbitSections += `</div>`;
      for (const f of flights) {
        const dvTotal = (f.outboundDeltaV?.totalDeltaV ?? 0).toFixed(2);
        const { payloadPct, refuelPct } = getFlightCapacityPcts(f.profile.vehicles, f.satsThisFlight);
        orbitSections += `<details class="flight-row">`;
        orbitSections += `<summary class="flight-summary-row">`;
        orbitSections += `<span class="fh-num">${f.flightIdx}</span>`;
        orbitSections += `<span class="fh-launch">${f.launchNumber.toLocaleString()}</span>`;
        orbitSections += `<span class="fh-date">${formatDate(f.launchDate)}</span>`;
        orbitSections += `<span class="fh-date">${formatDate(f.arrivalDate)}</span>`;
        orbitSections += `<span class="fh-small">${Math.round(f.transferDays)}</span>`;
        orbitSections += `<span class="fh-small">${f.satsThisFlight}</span>`;
        orbitSections += `<span class="fh-small">${f.tankersPerFlight}</span>`;
        orbitSections += `<span class="fh-dv">${dvTotal}</span>`;
        orbitSections += `<span class="fh-pct">${payloadPct}%</span>`;
        orbitSections += `<span class="fh-pct">${refuelPct}%</span>`;
        orbitSections += `</summary>`;
        // Expanded: per-flight vehicle tree
        orbitSections += `<div class="console tree flight-tree">`;
        orbitSections += buildFlightTreeHtml(f.profile.vehicles, f.satsThisFlight);
        orbitSections += `</div>`;
        orbitSections += `</details>`;
      }
      orbitSections += `</div>`;
    }

    orbitSections += `</details>`;
  });

  // Render directly into the in-page report panel.
  const body = document.getElementById("report-panel-body");
  if (!body) {
    console.error("[reportGenerator] #report-panel-body not found in DOM.");
    return;
  }
  body.innerHTML = `<div class="report">${totalsSections}${orbitSections}</div>`;

  // Wire up flight-slider event handlers so moving the slider re-renders the
  // orbit chart for the selected flight.
  body.querySelectorAll("input.flight-slider").forEach((slider) => {
    slider.addEventListener("input", (ev) => {
      const ringName = ev.target.dataset.ring;
      const idx = parseInt(ev.target.value, 10) - 1;
      const flightsForRing = ringFlightsByRing.get(ringName);
      if (!flightsForRing || !flightsForRing[idx]) return;
      const f = flightsForRing[idx];
      const r2 = _ringR2ByName.get(ringName) || 1;
      const targetElementsForSlider = _ringElementsByName.get(ringName) || null;
      const totalFlights = flightsForRing.length;
      const svg = renderOrbitChartSVG({
        earthElements: _earthElementsRef,
        marsElements: _marsElementsRef,
        targetElements: targetElementsForSlider,
        targetAU: r2,
        earthPos: f.earthPos,
        burn2Pos: f.burn2Pos,
        width: 320,
        height: 320,
        burn1DateLabel: formatDate(f.launchDate),
        burn2DateLabel: formatDate(f.arrivalDate),
        flightLabel: `Flight ${f.flightIdx} / ${totalFlights}`,
      });
      const container = ev.target.closest(".orbit-chart");
      if (!container) return;
      const svgHost = container.querySelector(".orbit-chart-svg");
      if (svgHost) svgHost.innerHTML = svg;
      const idxEl = container.querySelector(".flight-idx");
      if (idxEl) idxEl.textContent = String(f.flightIdx);
      const launchEl = container.querySelector(".flight-launch");
      if (launchEl) launchEl.textContent = formatDate(f.launchDate);
      const arrivalEl = container.querySelector(".flight-arrival");
      if (arrivalEl) arrivalEl.textContent = formatDate(f.arrivalDate);
    });
  });

  // Surface the panel and notify any listeners (e.g. mode tabs in simUi).
  const panel = document.getElementById("report-panel");
  if (panel) {
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    document.dispatchEvent(new CustomEvent("marslink:report-rendered"));
  }
}
