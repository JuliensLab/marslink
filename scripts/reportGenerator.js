export async function generateReport(reportData) {
  // Fetch the HTML template
  const response = await fetch("reportTemplate.html");
  let template = await response.text();

  // Replace total summary placeholders
  template = template.replace("{{totalSatellites}}", reportData.totals.satellites_count);
  template = template.replace("{{totalDeploymentFlights}}", reportData.totals.totalDeploymentFlights_count);
  template = template.replace("{{totalIndividualFlights}}", reportData.totals.totalIndividualFlights_count);
  template = template.replace("{{totalRocketPropellant}}", reportData.totals.totalRocketProp_tons.toLocaleString());
  template = template.replace("{{totalSatellitePropellant}}", reportData.totals.totalSatelliteProp_tons.toLocaleString());

  // Initialize orbit sections
  let orbitSections = "";

  // Helper function to determine counts for maneuver entries
  function getCounts(maneuver, orbit) {
    const vehicle = maneuver.vehicle;
    const payload = maneuver.payload;
    const totalDeploymentFlights = orbit.deployment.totalDeploymentFlights_count;
    const tankerLaunchesPerDeployment = orbit.deployment.tankerLaunchesPerDeploymentFlight_count;
    const satCount = orbit.satCount;
    const satellitesPerFlight = orbit.deployment.satellitesPerDeploymentFlight_count;

    if (vehicle === "Satellite") {
      return {
        totalCount: satCount,
        countPerDeployment: satellitesPerFlight,
      };
    } else if (vehicle === "Starship" || vehicle === "Starship (payload)") {
      return {
        totalCount: totalDeploymentFlights,
        countPerDeployment: 1,
      };
    } else if (vehicle === "Starship (tanker)") {
      return {
        totalCount: tankerLaunchesPerDeployment * totalDeploymentFlights,
        countPerDeployment: tankerLaunchesPerDeployment,
      };
    } else if (vehicle === "Booster") {
      if (payload === "Starship (tanker)") {
        return {
          totalCount: tankerLaunchesPerDeployment * totalDeploymentFlights,
          countPerDeployment: tankerLaunchesPerDeployment,
        };
      } else if (payload === "Starship (payload)") {
        return {
          totalCount: totalDeploymentFlights,
          countPerDeployment: 1,
        };
      }
    }
    return {
      totalCount: "-",
      countPerDeployment: "-",
    };
  }

  // Helper function to get vehicle icon
  function getIcon(vehicle) {
    if (vehicle.includes("Satellite")) {
      return "img/hardware/starlink.png";
    } else if (vehicle.includes("Starship")) {
      return "img/hardware/starship.png";
    } else if (vehicle === "Booster") {
      return "img/hardware/booster.png";
    }
    return "";
  }

  // Generate HTML for each orbit
  reportData.byOrbit.forEach((orbit) => {
    // Generate mission profile rows
    let missionProfileRows = "";
    orbit.missionProfile.forEach((entry, index) => {
      if (entry.type === "maneuver") {
        const counts = getCounts(entry, orbit);
        const icon = getIcon(entry.vehicle);
        const item = `<img src="${icon}" class="hardware-icon"> ${entry.vehicle}`;
        const maneuverLabel = entry.label || "-";
        const payload = entry.payload || "-";
        const deltaV = entry.deltaV_km_per_s !== null ? entry.deltaV_km_per_s.toFixed(2) : "-";
        const propellant = entry.prop_kg !== null ? (entry.prop_kg / 1000).toFixed(1) : "-";
        missionProfileRows += `
          <tr>
            <td>${index + 1}</td>
            <td>${counts.totalCount}</td>
            <td>${counts.countPerDeployment}</td>
            <td>${item}</td>
            <td>${maneuverLabel}</td>
            <td>${payload}</td>
            <td>${deltaV}</td>
            <td>${propellant}</td>
          </tr>
        `;
      } else if (entry.type === "non-maneuver") {
        // Non-maneuver entry: display as a note with merged columns and grey background
        missionProfileRows += `
          <tr class="non-maneuver-note">
            <td colspan="8">${entry.label}</td>
          </tr>
        `;
      }
    });

    // Orbit section HTML
    orbitSections += `
      <div class="orbit-section">
        <h2>${orbit.ringName}</h2>
        
        <!-- Mission Profile Table -->
        <h3>Mission Profile</h3>
        <table>
          <tr>
            <th>Order</th>
            <th>Total Count</th>
            <th>Count per<br>Deployment Flight</th>
            <th>Item</th>
            <th>Maneuver Label</th>
            <th>Payload</th>
            <th>Delta-V (km/s)</th>
            <th>Propellant (tons)</th>
          </tr>
          ${missionProfileRows}
        </table>

        <!-- Satellites Table -->
        <h3>Satellites</h3>
        <table>
          <tr><th>Metric</th><th>Value</th></tr>
          <tr><td>Count</td><td>${orbit.satCount}</td></tr>
          <tr><td>Mass per Satellite</td><td>${orbit.satellites.totalMass_kg} kg</td></tr>
          <tr><td>Propellant per Satellite</td><td>${orbit.satellites.propMass_kg} kg</td></tr>
          <tr><td>Delta-V</td><td>${orbit.satellites.satellite_deltaV_available_km_per_s.toFixed(2)} km/s</td></tr>
        </table>

        <!-- Starships with Payloads Table -->
        <h3>Starships with Payloads</h3>
        <div class="starship-svg"><img src="img/hardware/starship.png" height="30" style="height:30px;width:auto"></div>
        <table>
          <tr><th>Metric</th><th>Value</th></tr>
          <tr><td>Count</td><td>${orbit.deployment.totalDeploymentFlights_count}</td></tr>
          <tr><td>Payload Mass</td><td>${orbit.starship.payloadMass_kg.toLocaleString()} kg</td></tr>
          <tr><td>Outbound Propellant</td><td>${orbit.starship.outboundPropellant_kg.toLocaleString()} kg</td></tr>
          <tr><td>Return Propellant</td><td>${orbit.starship.returnPropellant_kg.toLocaleString()} kg</td></tr>
          <tr><td>Outbound Delta-V</td><td>${orbit.starship.starship_postLEO_payload_deltaV_available_km_per_s.toFixed(2)} km/s</td></tr>
          <tr><td>Return Delta-V</td><td>${orbit.starship.starship_postLEO_postPayload_deltaV_available_km_per_s.toFixed(2)} km/s</td></tr>
        </table>

        <!-- Tanker Starships Table -->
        <h3>Tanker Starships</h3>
        <div class="starship-svg"><img src="img/hardware/starship.png" height="30" style="height:30px;width:auto"></div>
        <table>
          <tr><th>Metric</th><th>Value</th></tr>
          <tr><td>Tankers per Deployment</td><td>${orbit.deployment.tankerLaunchesPerDeploymentFlight_count}</td></tr>
          <tr><td>Total Tanker Launches</td><td>${
            orbit.deployment.tankerLaunchesPerDeploymentFlight_count * orbit.deployment.totalDeploymentFlights_count
          }</td></tr>
          <tr><td>Propellant per Launch</td><td>${orbit.deployment.rocketPropellant.perIndividualLaunch_tons.toLocaleString()} tons</td></tr>
          <tr><td>Total Propellant</td><td>${orbit.deployment.rocketPropellant.total_tons.toLocaleString()} tons</td></tr>
        </table>
      </div>
    `;
  });

  // Insert orbit sections into the template
  template = template.replace("{{orbitSections}}", orbitSections);

  // Open a new window with the report
  const newWindow = window.open("", "_blank");
  if (newWindow) {
    newWindow.document.write(template);
    newWindow.document.close();
  } else {
    console.error("Failed to open new window. Check if pop-ups are blocked.");
  }
}
