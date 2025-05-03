// reportGenerator.js

import { printTree } from "./simMissionValidator.js?v=2.4";

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

export async function generateReport(missionProfiles, resultTrees) {
  console.log("missionProfiles", missionProfiles);
  console.log("resultTrees", resultTrees);
  const response = await fetch("reportTemplate.html");
  let template = await response.text();

  let totalsSections = "";
  totalsSections += `<div class="totals-section">`;
  totalsSections += `<h2>Totals</h2>`;

  // Define propellant costs
  const propellantCostsPerKg = {
    "CH4/O2": 0.3, // $0.3 per kg
    Argon: 0.5, // $0.5 per kg
  };

  // Initialize orbits object
  const orbits = {};
  resultTrees.forEach((orbitTree) => {
    orbits[orbitTree.ringName] = {
      deploymentFlights_count: orbitTree.deploymentFlights_count,
      satCountPerDeploymentFlight: orbitTree.satCountPerDeploymentFlight,
      satCount: orbitTree.satCount,
      propellant: {},
      tankersPerFlight: 0,
    };
    for (let data of Object.values(orbitTree.vehicles)) {
      if (!Object.keys(orbits[orbitTree.ringName].propellant).includes(data.propellantType))
        orbits[orbitTree.ringName].propellant[data.propellantType] = { selfPropulsion_kg: 0, tankerPropellant_kg: 0 };
      orbits[orbitTree.ringName].propellant[data.propellantType].selfPropulsion_kg +=
        (data.count ? data.count * data.propellantLoaded_kg : data.propellantLoaded_kg) * orbitTree.deploymentFlights_count;
      orbits[orbitTree.ringName].propellant[data.propellantType].tankerPropellant_kg +=
        (data.count ? data.count * data.tankerPropellant_kg : data.tankerPropellant_kg) * orbitTree.deploymentFlights_count;
    }
    orbits[orbitTree.ringName].tankersPerFlight = Object.values(orbitTree.vehicles).reduce((sum, data) => {
      if (data.tankerPropellant_kg > 0) {
        return sum + (data.count ? data.count : 1);
      }
      return sum;
    }, 0);
  });

  // Get unique propellant types
  const allPropellantTypes = [];
  for (const orbit of Object.values(orbits))
    for (const propellantType of Object.keys(orbit.propellant))
      if (!allPropellantTypes.includes(propellantType)) allPropellantTypes.push(propellantType);

  // Technical Table (unchanged)
  totalsSections += `<h3>Technical Summary</h3>`;
  totalsSections += `<div class="table technical">`;
  totalsSections += `<table>`;
  totalsSections += `<tr>`;
  totalsSections += `<th>Orbit</th>`;
  totalsSections += `<th>Total Satellites</th>`;
  totalsSections += `<th>Deployment Flights</th>`;
  totalsSections += `<th>Tanker Flights</th>`;
  totalsSections += `<th>Sats / Deployment Flight</th>`;
  for (let propellantType of allPropellantTypes) totalsSections += `<th>${propellantType} (t)</th>`;
  totalsSections += `</tr>`;

  let totalDeploymentFlights_count = 0;
  let totalSatCount = 0;
  let totalTankerFlights = 0;

  for (const [orbitId, orbitData] of Object.entries(orbits)) {
    totalDeploymentFlights_count += orbitData.deploymentFlights_count;
    totalSatCount += orbitData.satCount;
    const totalTankerFlightsForOrbit = orbitData.tankersPerFlight * orbitData.deploymentFlights_count;
    totalTankerFlights += totalTankerFlightsForOrbit;

    totalsSections += `<tr>`;
    totalsSections += `<td>${orbitId}</td>`;
    totalsSections += `<td>${orbitData.satCount.toLocaleString()}</td>`;
    totalsSections += `<td>${orbitData.deploymentFlights_count.toLocaleString()}</td>`;
    totalsSections += `<td>${totalTankerFlightsForOrbit.toLocaleString()}</td>`;
    totalsSections += `<td>${orbitData.satCountPerDeploymentFlight}</td>`;
    for (let propellantType of allPropellantTypes) {
      const mass_kg = orbitData.propellant[propellantType]
        ? orbitData.propellant[propellantType].selfPropulsion_kg + orbitData.propellant[propellantType].tankerPropellant_kg
        : 0;
      totalsSections += `<td>${mass_kg ? Math.round(mass_kg / 1000).toLocaleString() : 0}</td>`;
    }
    totalsSections += `</tr>`;
  }

  totalsSections += `<tr>`;
  totalsSections += `<th>Totals</th>`;
  totalsSections += `<th>${totalSatCount.toLocaleString()}</th>`;
  totalsSections += `<th>${totalDeploymentFlights_count.toLocaleString()}</th>`;
  totalsSections += `<th>${totalTankerFlights.toLocaleString()}</th>`;
  totalsSections += `<th></th>`;
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
  totalsSections += `<tr><th>Orbit</th><th>Starships</th><th>Tankers</th><th>Satellites</th>`;

  // Add headers for each propellant type
  for (let propellantType of allPropellantTypes) {
    totalsSections += `<th>${propellantType}</th>`;
  }
  totalsSections += `<th>Total</th></tr>`;

  // Initialize grand totals
  let grandTotalStarshipCost = 0;
  let grandTotalTankerCost = 0;
  let grandTotalSatelliteCost = 0;
  let grandTotalPropellantCosts = {};
  for (let propellantType of allPropellantTypes) {
    grandTotalPropellantCosts[propellantType] = 0;
  }
  let grandTotalCostAll = 0;

  // Process each orbit
  for (const [orbitId, orbitData] of Object.entries(orbits)) {
    const starshipCost = orbitData.deploymentFlights_count * 10; // $10M per flight
    const tankerCost = orbitData.tankersPerFlight * orbitData.deploymentFlights_count * 10; // $10M per flight
    const satelliteCost = orbitData.satCount * 5; // $5M per satellite
    let totalPropellantCost = 0;
    let propellantCostsForOrbit = {};

    // Calculate cost for each propellant type
    for (let propellantType of allPropellantTypes) {
      const mass_kg = orbitData.propellant[propellantType]
        ? orbitData.propellant[propellantType].selfPropulsion_kg + orbitData.propellant[propellantType].tankerPropellant_kg
        : 0;
      const cost = (mass_kg * (propellantCostsPerKg[propellantType] || 0)) / 1000000; // Convert to $M
      console.log(orbitId, propellantType, propellantCostsPerKg[propellantType], mass_kg, cost);
      propellantCostsForOrbit[propellantType] = cost;
      totalPropellantCost += cost;
      grandTotalPropellantCosts[propellantType] += cost;
    }

    const totalCostForOrbit = starshipCost + tankerCost + satelliteCost + totalPropellantCost;
    // Add row for this orbit (updated)
    totalsSections += `<tr>`;
    totalsSections += `<td>${orbitId}</td>`;
    totalsSections += `<td>${formatNumber(starshipCost)}</td>`;
    totalsSections += `<td>${formatNumber(tankerCost)}</td>`;
    totalsSections += `<td>${formatNumber(satelliteCost)}</td>`;
    for (let propellantType of allPropellantTypes) {
      totalsSections += `<td>${formatNumber(propellantCostsForOrbit[propellantType])}</td>`;
    }
    totalsSections += `<td>${formatNumber(totalCostForOrbit)}</td>`;
    totalsSections += `</tr>`;

    // Update grand totals
    grandTotalStarshipCost += starshipCost;
    grandTotalTankerCost += tankerCost;
    grandTotalSatelliteCost += satelliteCost;
    grandTotalCostAll += totalCostForOrbit;
  }

  // Add grand total row
  totalsSections += `<tr>`;
  totalsSections += `<th>Totals</th>`;
  totalsSections += `<th>${formatNumber(grandTotalStarshipCost)}</th>`;
  totalsSections += `<th>${formatNumber(grandTotalTankerCost)}</th>`;
  totalsSections += `<th>${formatNumber(grandTotalSatelliteCost)}</th>`;
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
    totalsSections += `<tr><td>${propellantType}</td><td>${cost.toFixed(2)}</td></tr>`;
  }
  totalsSections += `</table>`;

  totalsSections += `<h4>Hardware Unit Costs</h4>`;
  totalsSections += `<table>`;
  totalsSections += `<tr><th>Item</th><th>Cost ($ million per unit)</th></tr>`;
  totalsSections += `<tr><td>Starship flight</td><td>10.0</td></tr>`;
  totalsSections += `<tr><td>Tanker flight</td><td>10.0</td></tr>`;
  totalsSections += `<tr><td>Satellite</td><td>5.0</td></tr>`;
  totalsSections += `</table>`;

  totalsSections += `</div>`;
  // Close totals-section
  totalsSections += `</div>`;

  totalsSections += `</div>`;

  // Orbit sections (unchanged)
  let orbitSections = "";
  resultTrees.forEach((orbitTree) => {
    orbitSections += `<div class="orbit-section">`;
    orbitSections += `<h2>${orbitTree.ringName}</h2>`;
    const propellants = {};
    for (let data of Object.values(orbitTree.vehicles)) {
      if (!Object.keys(propellants).includes(data.propellantType))
        propellants[data.propellantType] = { selfPropulsion_kg: 0, tankerPropellant_kg: 0 };
      propellants[data.propellantType].selfPropulsion_kg += data.count ? data.count * data.propellantLoaded_kg : data.propellantLoaded_kg;
      propellants[data.propellantType].tankerPropellant_kg += data.count ? data.count * data.tankerPropellant_kg : data.tankerPropellant_kg;
    }
    orbitSections += `${orbitTree.deploymentFlights_count} deployment flights are required to put all ${orbitTree.satCount} satellites into orbit.`;
    orbitSections += `<div class="table propellant">`;
    orbitSections += `<table>`;
    orbitSections += `<tr><th>Propellant type</th><th>Propellant used for<br>one deployment flight (t)</th><th>Propellant used for<br>all ${orbitTree.deploymentFlights_count} deployment flights (t)</th></tr>`;
    for (let [propellantType, data] of Object.entries(propellants))
      orbitSections += `<tr><td>${propellantType}</td><td>${Math.round(
        (data.selfPropulsion_kg + data.tankerPropellant_kg) / 1000
      ).toLocaleString()}</td><td>${Math.round(
        (orbitTree.deploymentFlights_count * (data.selfPropulsion_kg + data.tankerPropellant_kg)) / 1000
      ).toLocaleString()}</td></tr>`;
    orbitSections += `</table>`;
    orbitSections += `<div class="table vehicles">`;
    orbitSections += `<table>`;
    orbitSections += `Table below valid for one deployment flight.`;
    orbitSections += `<tr><th>Vehicle</th><th>Propellant type</th><th>ISP (s)</th><th>Empty mass<br>(t)</th><th>Propellant used for<br>self propulsion (t)</th><th>Payload</th></tr>`;
    for (let [vehicleId, data] of Object.entries(orbitTree.vehicles))
      orbitSections += `<tr><td>${vehicleId}${data.count ? " x" + data.count : ""}</td><td>${data.propellantType}</td><td>${
        data.isp_s
      }</td><td>${
        data.count ? data.dryMass_kg / 1000 + " (single)<br>" + (data.count * data.dryMass_kg) / 1000 + " (all)" : data.dryMass_kg / 1000
      }</td><td>${
        data.count
          ? data.propellantLoaded_kg / 1000 + " (single)<br>" + (data.count * data.propellantLoaded_kg) / 1000 + " (all)"
          : data.propellantLoaded_kg / 1000
      }</td><td>${getPayloadForVehicle(orbitTree.vehicles, vehicleId)}</td></tr>`;
    orbitSections += `</table>`;
    orbitSections += `</div>`;
    orbitSections += `<div class="console tree">`;
    console.log(orbitTree.vehicles);
    for (let tree of orbitTree.trees) {
      orbitSections += printTree("&nbsp;", orbitTree.vehicles, tree, 0).join("<br>");
      orbitSections += "<br><br>";
    }
    orbitSections += `</div>`;
    orbitSections += `</div>`;
    orbitSections += `</div>`;
  });

  template = template.replace("{{totalsSections}}", totalsSections);
  template = template.replace("{{orbitSections}}", orbitSections);

  const newWindow = window.open("", "_blank");
  if (newWindow) {
    newWindow.document.write(template);
    newWindow.document.close();
  } else {
    console.error("Failed to open new window. Check if pop-ups are blocked.");
  }
}
