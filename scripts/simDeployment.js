// simDeployment.js

import { calculateHohmannDeltaV_km_s } from "./simDeltaV.js?v=4.0";

// Define the Starship performance data, including booster data
const starshipPerformance = {
  flight3: {
    starship: {
      dryMass_kg: 120000, // kg
      propellantLoad_kg: 1200000, // kg
      payloadCapacity_kg: 100000, // kg
      deorbitLandingBurnPropellant_kg: 10000, // kg
    },
    booster: {
      dryMass_kg: 200000, // kg (example value)
      propellantLoad_kg: 3650000, // kg (example value)
      deorbitLandingBurnPropellant_kg: 15000, // kg
    },
    engines: {
      IspSeaLevel_s: 330, // seconds
      IspVacuum_s: 380, // seconds
    },
  },
  starship2: {
    starship: {
      dryMass_kg: 120000, // kg
      propellantLoad_kg: 1500000, // kg
      payloadCapacity_kg: 150000, // kg
      deorbitLandingBurnPropellant_kg: 10000, // kg
    },
    booster: {
      dryMass_kg: 200000, // kg (example value)
      propellantLoad_kg: 3650000, // kg (example value)
      deorbitLandingBurnPropellant_kg: 15000, // kg
    },
    engines: {
      IspSeaLevel_s: 330, // seconds
      IspVacuum_s: 380, // seconds
    },
  },
  starship3: {
    starship: {
      dryMass_kg: 120000, // kg
      propellantLoad_kg: 2300000, // kg
      payloadCapacity_kg: 200000, // kg
      deorbitLandingBurnPropellant_kg: 10000, // kg
    },
    booster: {
      dryMass_kg: 200000, // kg (example value)
      propellantLoad_kg: 3650000, // kg (example value)
      deorbitLandingBurnPropellant_kg: 15000, // kg
    },
    engines: {
      IspSeaLevel_s: 330, // seconds
      IspVacuum_s: 380, // seconds
    },
  },
};

const satellites = {
  dryMass_kg: 1500,
  IspVacuum_s: 1800,
};

const launchToLEO_deltaV_km_per_s = 9.5;

// Gravitational constant
const g = 9.81; // m/s^2

export class SimDeployment {
  /**
   * Constructor for SimDeployment class
   * @param {string} variant - Starship variant ('flight3', 'starship2', or 'starship3')
   */
  constructor(planets, variant = "starship3") {
    // Find Earth from the planets array
    this.earth = {};
    for (const planet of planets) {
      if (planet.name === "Earth") {
        this.earth = planet;
        break;
      }
    }
    if (!this.earth.name) {
      throw new Error("Earth not found in planets array.");
    } else {
    } //console.log("Earth", JSON.stringify(this.earth, null, 2));

    if (!starshipPerformance[variant]) {
      throw new Error(`Invalid Starship variant: ${variant}. Choose from 'flight3', 'starship2', or 'starship3'.`);
    }
    this.variant = variant;
    this.starship = starshipPerformance[variant];

    // Default satellite masses
    this.satelliteEmptyMass = 1000; // kg
    this.laserTerminalMass = 50; // kg
    this.laserPortsPerSatellite = 4;
  }

  setSatelliteMassConfig(emptyMass, laserTerminalMass, laserPorts) {
    this.satelliteEmptyMass = emptyMass;
    this.laserTerminalMass = laserTerminalMass;
    this.laserPortsPerSatellite = laserPorts;
    // Update the vehicle properties
    this.vehicleProperties.satellite.dryMass_kg = this.satelliteEmptyMass + this.laserPortsPerSatellite * this.laserTerminalMass;
  }

  /**
   * Calculates the total mass of a satellite, including propellant
   * @param {number} deltaV2_km_per_s - Delta-V for the second maneuver (km/s)
   * @param {number} deltaV_inclination_km_per_s - Delta-V for inclination change (km/s)
   * @param {number} m_dry_sat_kg - Dry mass of the satellite (kg)
   * @param {number} I_sp_sat_s - Specific impulse of the satellite's propulsion (s)
   * @returns {Object} Total mass and propellant mass of the satellite
   */
  calculateSatellitePropellantMass(deltaV_km_per_s, m_dry_sat_kg, I_sp_sat_s) {
    const deltaV_sat_m_per_s = deltaV_km_per_s * 1000;
    const m_prop_sat_kg = Math.ceil(m_dry_sat_kg * (Math.exp(deltaV_sat_m_per_s / (I_sp_sat_s * g)) - 1));
    return m_prop_sat_kg;
  }

  /**
   * Calculates the propellant required for the outbound burn
   * @param {number} spaceshipDryMass_kg - Mass of spaceship (kg)
   * @param {number} deltaV_km_per_s - Delta-V for the first maneuver (km/s)
   * @param {number} I_sp_s - Specific impulse of the Starship (s)
   * @returns {number} Propellant mass required for return (kg)
   */
  calculateManeuverPropellant(spaceshipDryMass_kg, deltaV_km_per_s, I_sp_s) {
    const deltaV_m_per_s = deltaV_km_per_s * 1000; // Assuming symmetric Hohmann transfer
    return Math.ceil(spaceshipDryMass_kg * (Math.exp(deltaV_m_per_s / (I_sp_s * g)) - 1));
  }

  calculateDeltaV_km_per_s(spaceshipDryMass_kg, propellant_kg, I_sp_s) {
    const initialMass = spaceshipDryMass_kg + propellant_kg;
    const finalMass = spaceshipDryMass_kg;
    const deltaV_km_per_s = (I_sp_s * g * Math.log(initialMass / finalMass)) / 1000;
    return Math.round(deltaV_km_per_s * 100) / 100; // Round to 2 decimal places
  }

  // Vehicle Properties (in kg and m/s)
  vehicleProperties = {
    booster: {
      dryMass_kg: 200000,
      propellantCapacity_kg: 3000000,
      deorbitLandingPropellant_kg: 50000,
      isp_s: 350,
      propellantType: "CH4/O2",
    },
    starship: {
      dryMass_kg: 120000,
      propellantCapacity_kg: 1200000,
      deorbitLandingPropellant_kg: 20000,
      maxPayloadCapacity_kg: 200000,
      isp_s: 370,
      propellantType: "CH4/O2",
    },
    tanker: {
      dryMass_kg: 120000,
      propellantCapacity_kg: 1200000,
      tankerPropellantCapacity_kg: 200000,
      deorbitLandingPropellant_kg: 20000,
      isp_s: 370,
      propellantType: "CH4/O2",
    },
    satellite: {
      dryMass_kg: 1450,
      solarPanelMass_EarthOrbit_kg: 50,
      propellantCapacity_kg: 1500, // Includes propellant for maneuvers
      isp_s: 2500,
      propellantType: "Argon",
    },
  };

  addVehicle(vehicles, vehicleId, vehicleProperties, additionalMass_kg = 0) {
    vehicles[vehicleId] = {
      ...vehicleProperties,
      propellantLoaded_kg: 0,
      tankerPropellant_kg: 0,
      maneuvers: [],
    };
    vehicles[vehicleId].dryMass_kg += additionalMass_kg;
    vehicles[vehicleId].dryMass_kg = Math.round(vehicles[vehicleId].dryMass_kg);
  }

  getEndMass_kg(vehicles, vehicleId) {
    const endMass_kg = vehicles[vehicleId].maneuvers.length
      ? vehicles[vehicleId].maneuvers[vehicles[vehicleId].maneuvers.length - 1].startMass_kg
      : vehicles[vehicleId].dryMass_kg;
    return endMass_kg;
  }

  getUsedPropellantMass_kg(vehicles, vehicleId) {
    const usedPropellantMass_kg = vehicles[vehicleId].maneuvers.reduce((acc, maneuver) => acc + (maneuver.usedPropellantMass_kg || 0), 0);
    return usedPropellantMass_kg;
  }

  addManeuverByPropellantRequired(vehicles, vehicleId, label, usedPropellantMass_kg) {
    const endMass_kg = this.getEndMass_kg(vehicles, vehicleId);
    const deltaV_km_per_s = this.calculateDeltaV_km_per_s(endMass_kg, usedPropellantMass_kg, vehicles[vehicleId].isp_s);
    vehicles[vehicleId].startMass_kg = endMass_kg + usedPropellantMass_kg;
    vehicles[vehicleId].maneuvers.push({
      type: "maneuver (propellant required)",
      label,
      deltaV_km_per_s,
      usedPropellantMass_kg,
      startMass_kg: endMass_kg + usedPropellantMass_kg,
      endMass_kg,
    });
    vehicles[vehicleId].propellantLoaded_kg += usedPropellantMass_kg;
  }

  addManeuverByDeltaVRequired(vehicles, vehicleId, label, deltaV_km_per_s) {
    const endMass_kg = this.getEndMass_kg(vehicles, vehicleId);
    const usedPropellantMass_kg = this.calculateManeuverPropellant(
      endMass_kg, // m_dry_sat_kg = 1500 kg
      deltaV_km_per_s,
      vehicles[vehicleId].isp_s // I_sp_sat_s = 1800 s / electric propulsion
    );

    const startMass_kg = endMass_kg + usedPropellantMass_kg;
    vehicles[vehicleId].maneuvers.push({
      type: "maneuver (delta-V required)",
      label,
      deltaV_km_per_s,
      usedPropellantMass_kg,
      startMass_kg,
      endMass_kg,
    });
    vehicles[vehicleId].propellantLoaded_kg += usedPropellantMass_kg;
    if (vehicles[vehicleId].propellantLoaded_kg > vehicles[vehicleId].propellantCapacity_kg)
      return vehicles[vehicleId].propellantLoaded_kg / vehicles[vehicleId].propellantCapacity_kg; //to the caller with info that the propellant capacity is less than the propellant required for the maneuver
    // throw new Error(
    //   `Propellant capacity is less than the propellant required for ${label}: ${vehicles[vehicleId].propellantLoaded_kg} > ${vehicles[vehicleId].propellantCapacity_kg}`
    // );
    return null;
  }

  addPropellantTransfer(vehicles, targetVehicleId, label, sourceVehicleId, tankerPropellant_kg) {
    if (tankerPropellant_kg > vehicles[sourceVehicleId].tankerPropellantCapacity_kg)
      throw new Error(
        `Tanker propellant capacity is less than the propellant required for ${label}: ${tankerPropellant_kg} > ${vehicles[sourceVehicleId].tankerPropellantCapacity_kg}`
      );

    // target vehicle
    const target_endMass_kg = this.getEndMass_kg(vehicles, targetVehicleId);
    const target_startMass_kg = target_endMass_kg - tankerPropellant_kg;
    vehicles[targetVehicleId].maneuvers.push({
      type: "propellant transfer (receive)",
      label: `${label} from ${sourceVehicleId}`,
      propellantSourceId: sourceVehicleId,
      startMass_kg: target_startMass_kg,
      endMass_kg: target_endMass_kg,
      usedPropellantMass_kg: -tankerPropellant_kg,
    });
    vehicles[targetVehicleId].propellantLoaded_kg -= tankerPropellant_kg;

    // source vehicle
    const source_endMass_kg = this.getEndMass_kg(vehicles, sourceVehicleId);
    const source_startMass_kg = source_endMass_kg + tankerPropellant_kg;
    vehicles[sourceVehicleId].maneuvers.push({
      type: "propellant transfer (send)",
      label: `${label} to ${targetVehicleId}`,
      propellantTargetId: targetVehicleId,
      startMass_kg: source_startMass_kg,
      endMass_kg: source_endMass_kg,
      tankerPropellantOffload_kg: tankerPropellant_kg,
    });
    vehicles[sourceVehicleId].tankerPropellant_kg += tankerPropellant_kg + 100;
  }

  addPayloadDeployment(vehicles, vehicleId, payloadId, totalPayloadCount, label, maxSatCountPerDeploymentFlight_fromLoop = Infinity) {
    const individualPayloadMass_kg = vehicles[payloadId].maneuvers.length
      ? vehicles[payloadId].maneuvers[vehicles[payloadId].maneuvers.length - 1].startMass_kg
      : vehicles[payloadId].dryMass_kg;
    const maxPayloadCountPerDeploymentFlight =
      totalPayloadCount == 1
        ? 1
        : Math.min(
            maxSatCountPerDeploymentFlight_fromLoop,
            Math.floor(vehicles[vehicleId].maxPayloadCapacity_kg / individualPayloadMass_kg)
          );
    let payloadCountPerDeploymentFlight = totalPayloadCount;
    let totalDeploymentFlights_count = 1;
    if (totalPayloadCount > maxPayloadCountPerDeploymentFlight) {
      totalDeploymentFlights_count = Math.ceil(totalPayloadCount / maxPayloadCountPerDeploymentFlight);
      payloadCountPerDeploymentFlight = Math.ceil(totalPayloadCount / totalDeploymentFlights_count);
    }

    const payloadMass_kg = individualPayloadMass_kg * payloadCountPerDeploymentFlight;
    const endMass_kg = vehicles[vehicleId].maneuvers.length
      ? vehicles[vehicleId].maneuvers[vehicles[vehicleId].maneuvers.length - 1].startMass_kg
      : vehicles[vehicleId].dryMass_kg;
    const startMass_kg = endMass_kg + payloadMass_kg;
    vehicles[vehicleId].maneuvers.push({
      type: "payload deployment (carrier)",
      label,
      payloadId,
      payloadCountPerDeploymentFlight,
      individualPayloadMass_kg,
      payloadMass_kg,
      startMass_kg,
      endMass_kg,
    });
    vehicles[payloadId].maneuvers.push({
      type: "payload deployment (payload)",
      label: payloadCountPerDeploymentFlight > 1 ? `${label} x${payloadCountPerDeploymentFlight}` : label,
      vehicleId,
      startMass_kg: individualPayloadMass_kg,
      endMass_kg: individualPayloadMass_kg,
    });
    return { payloadCountPerDeploymentFlight, totalDeploymentFlights_count };
  }

  addSurfaceLiftoffToLEO(vehicles, vehicleId) {
    const endMass_kg = this.getEndMass_kg(vehicles, vehicleId);
    const propellantRequired_kg = Math.ceil(
      this.calculateManeuverPropellant(endMass_kg, launchToLEO_deltaV_km_per_s, vehicles[vehicleId].isp_s)
    );
    // get vehicle propellant already used in future maneuvers
    const usedPropellantMass_kg = Math.ceil(this.getUsedPropellantMass_kg(vehicles, vehicleId));
    const maxPropellantForThisManeuver_kg = vehicles[vehicleId].propellantCapacity_kg - usedPropellantMass_kg;
    // console.log("vehicle", vehicleId, JSON.stringify(vehicles[vehicleId], null, 2));
    // console.log("usedPropellantMass_kg", usedPropellantMass_kg);
    // console.log("vehicles[vehicleId].propellantCapacity_kg", vehicles[vehicleId].propellantCapacity_kg);
    // console.log("maxPropellantForThisManeuver_kg", maxPropellantForThisManeuver_kg);
    // console.log("propellantRequired_kg", propellantRequired_kg);
    if (propellantRequired_kg > maxPropellantForThisManeuver_kg) {
      // booster flight required, just use the propellant capacity of the vehicle
      const secondStage_usedPropellant_kg = maxPropellantForThisManeuver_kg;
      const secondStage_DeltaV_km_per_s = this.calculateDeltaV_km_per_s(
        endMass_kg,
        secondStage_usedPropellant_kg,
        vehicles[vehicleId].isp_s
      );
      vehicles[vehicleId].maneuvers.push({
        type: "second stage acceleration to LEO",
        label: "Second stage acceleration to LEO",
        deltaV_km_per_s: secondStage_DeltaV_km_per_s,
        usedPropellantMass_kg: secondStage_usedPropellant_kg,
        startMass_kg: endMass_kg + secondStage_usedPropellant_kg,
        endMass_kg: endMass_kg,
      });
      vehicles[vehicleId].propellantLoaded_kg += secondStage_usedPropellant_kg;

      // add booster flight
      const boosterId = `Booster-${vehicleId}`;
      this.addVehicle(vehicles, boosterId, this.vehicleProperties.booster);
      const firstStage_endMass_kg = this.getEndMass_kg(vehicles, boosterId);
      const firstStage_deltaV_required_km_per_s = launchToLEO_deltaV_km_per_s - secondStage_DeltaV_km_per_s;
      const firstStage_propellantRequired_kg = this.calculateManeuverPropellant(
        firstStage_endMass_kg,
        firstStage_deltaV_required_km_per_s,
        vehicles[boosterId].isp_s
      );
      const firstStage_startMass_kg = firstStage_endMass_kg + firstStage_propellantRequired_kg;

      vehicles[boosterId].maneuvers.push({
        type: "deorbit and landing burn",
        label: "Deorbit and landing burn",
        usedPropellantMass_kg: vehicles[boosterId].deorbitLandingPropellant_kg,
        startMass_kg: firstStage_endMass_kg,
        endMass_kg: firstStage_endMass_kg - vehicles[boosterId].deorbitLandingPropellant_kg,
      });
      vehicles[boosterId].propellantLoaded_kg += vehicles[boosterId].deorbitLandingPropellant_kg;
      this.addPayloadDeployment(vehicles, boosterId, vehicleId, 1, "Separation");
      vehicles[boosterId].maneuvers.push({
        type: "first stage liftoff",
        label: "First stage liftoff",
        deltaV_km_per_s: firstStage_deltaV_required_km_per_s,
        usedPropellantMass_kg: firstStage_propellantRequired_kg,
        startMass_kg: firstStage_startMass_kg,
        endMass_kg: firstStage_endMass_kg,
      });
      vehicles[boosterId].propellantLoaded_kg += firstStage_propellantRequired_kg;
    } else {
      vehicles[vehicleId].maneuvers.push({
        type: "single stage liftoff to LEO",
        label: "Single stage liftoff to LEO",
        deltaV_km_per_s: launchToLEO_deltaV_km_per_s,
        usedPropellantMass_kg: propellantRequired_kg,
        startMass_kg: endMass_kg + propellantRequired_kg,
        endMass_kg: endMass_kg,
      });
      vehicles[vehicleId].propellantLoaded_kg += propellantRequired_kg;
    }
  }

  /**
   * Gets the mission profile for a given target orbit
   * @param {Array} targetOrbitElementsArray - Array of orbital elements for each ring
   * @returns {Object} Mission profile for the given target orbit
   */
  getMissionProfile(targetOrbitElementsArray) {
    const results_by_orbit = [];
    for (const targetOrbitElements of targetOrbitElementsArray) {
      if (targetOrbitElements == null) {
        console.log("targetOrbitElements is null, skipping");
        continue;
      }
      let counter = 0;
      let maxSatCountPerDeploymentFlight_fromLoop = Infinity;
      let missionProfile;
      do {
        if (counter++ > 10) throw new Error("Too many iterations");
        missionProfile = this.getMissionProfileOneOrbit(targetOrbitElements, maxSatCountPerDeploymentFlight_fromLoop);
        if (missionProfile.error) {
          // console.log(
          //   "Error: ",
          //   missionProfile.excess,
          //   "with ",
          //   missionProfile.satCountPerDeploymentFlight,
          //   "now using ",
          //   missionProfile.satCountPerDeploymentFlight - 1,
          //   "satellites per deployment flight"
          // );
          maxSatCountPerDeploymentFlight_fromLoop = missionProfile.satCountPerDeploymentFlight - 1;
        } else {
          // console.log("OK, using ", missionProfile.result.satCountPerDeploymentFlight);
        }
        if (maxSatCountPerDeploymentFlight_fromLoop <= 0) {
          throw new Error("Max satellites per deployment flight is less than 1");
        }
      } while (missionProfile.error);
      const result = {
        ringName: targetOrbitElements.ringName,
        satCount: targetOrbitElements.satCount,
        deploymentFlights_count: missionProfile.result.deploymentFlights_count,
        satCountPerDeploymentFlight: missionProfile.result.satCountPerDeploymentFlight,
        vehicles: missionProfile.result.vehicles,
        orbits: missionProfile.result.orbits,
      };
      results_by_orbit.push(result);
      // console.log(result);
    }
    return { byOrbit: results_by_orbit };
  }

  /**
   * Sets the orbital elements and calculates delta-V for each plane
   * @param {Array} targetOrbitElementsArray - Array of orbital elements for each ring
   * @param {Array} planets - Array of planet objects, including Earth
   */
  getMissionProfileOneOrbit(targetOrbitElements, maxSatCountPerDeploymentFlight_fromLoop) {
    // Calculate outbound delta-V using the imported function
    const outboundDeltaV_km_per_s = calculateHohmannDeltaV_km_s(this.earth, targetOrbitElements);

    const outboundDeltaV1 = targetOrbitElements.ringName.startsWith("ring_ecce")
      ? outboundDeltaV_km_per_s.deltaV2
      : outboundDeltaV_km_per_s.deltaV1;
    const outboundDeltaV2 = targetOrbitElements.ringName.startsWith("ring_ecce")
      ? outboundDeltaV_km_per_s.deltaV1
      : outboundDeltaV_km_per_s.deltaV2;

    const vehicles = {};

    const solarPanelMass_kg =
      this.vehicleProperties.satellite.solarPanelMass_EarthOrbit_kg * Math.pow(targetOrbitElements.apsides.apo_pctEarth, 2);
    this.addVehicle(vehicles, "Satellites", this.vehicleProperties.satellite, solarPanelMass_kg);
    this.addManeuverByDeltaVRequired(vehicles, "Satellites", "Inclination change", outboundDeltaV_km_per_s.deltaV_inclination);
    this.addManeuverByDeltaVRequired(vehicles, "Satellites", "2nd Hohmann maneuver", outboundDeltaV2);
    this.addVehicle(vehicles, "Starship", this.vehicleProperties.starship);
    this.addManeuverByPropellantRequired(
      vehicles,
      "Starship",
      "Deorbit and landing burn",
      this.vehicleProperties.starship.deorbitLandingPropellant_kg
    );
    this.addManeuverByDeltaVRequired(vehicles, "Starship", "1st Hohmann maneuver (return)", outboundDeltaV1);
    const { payloadCountPerDeploymentFlight, totalDeploymentFlights_count } = this.addPayloadDeployment(
      vehicles,
      "Starship",
      "Satellites",
      targetOrbitElements.satCount,
      "Deploy satellites",
      maxSatCountPerDeploymentFlight_fromLoop
    );
    vehicles.Satellites.count = payloadCountPerDeploymentFlight;
    const outboundHohmannResult = this.addManeuverByDeltaVRequired(
      vehicles,
      "Starship",
      "1st Hohmann maneuver (outbound)",
      outboundDeltaV1
    );
    if (outboundHohmannResult != null) {
      return {
        error: true,
        step: "1st Hohmann maneuver (outbound)",
        excess: outboundHohmannResult,
        satCountPerDeploymentFlight: payloadCountPerDeploymentFlight,
      };
    }

    // compute number of tanker launches required
    const totalStarshipPropellantRequired_kg = this.getUsedPropellantMass_kg(vehicles, "Starship");
    // console.log("totalStarshipPropellantRequired_kg", totalStarshipPropellantRequired_kg);
    const tankerLaunchesPerDeploymentFlight_count = Math.ceil(
      totalStarshipPropellantRequired_kg / this.vehicleProperties.tanker.tankerPropellantCapacity_kg
    );
    // console.log("tankerLaunchesPerDeploymentFlight_count", tankerLaunchesPerDeploymentFlight_count);
    const tankerPropellantRequired_kg = totalStarshipPropellantRequired_kg / tankerLaunchesPerDeploymentFlight_count;
    // console.log("tankerLaunchesPerDeploymentFlight_count", tankerLaunchesPerDeploymentFlight_count);
    for (let i = tankerLaunchesPerDeploymentFlight_count - 1; i >= 0; i--) {
      this.addVehicle(vehicles, `Tanker${i}`, this.vehicleProperties.tanker);
      this.addManeuverByPropellantRequired(
        vehicles,
        `Tanker${i}`,
        "Deorbit and landing burn",
        this.vehicleProperties.tanker.deorbitLandingPropellant_kg
      );
      this.addPropellantTransfer(vehicles, "Starship", `In-orbit propellant transfer`, `Tanker${i}`, tankerPropellantRequired_kg);
    }
    this.addSurfaceLiftoffToLEO(vehicles, "Starship");
    for (let i = 0; i < tankerLaunchesPerDeploymentFlight_count; i++) this.addSurfaceLiftoffToLEO(vehicles, `Tanker${i}`);

    // for each vehicle, invert the order of the maneuvers
    for (const vehicleId in vehicles) {
      vehicles[vehicleId].maneuvers.reverse();
    }

    const result = {
      deploymentFlights_count: totalDeploymentFlights_count,
      satCountPerDeploymentFlight: payloadCountPerDeploymentFlight,
      vehicles,
      orbits: {
        targetOrbitElements,
        deltaV_km_per_s: outboundDeltaV_km_per_s,
      },
    };
    return { error: false, result };
  }

  convertToGraph(missionProfiles) {
    const nodes = {};
    const edges = {};
    const firstOrbit = missionProfiles.byOrbit[0];

    // Add nodes for each vehicle
    for (const [vehicleId, vehicle] of Object.entries(firstOrbit.vehicles)) {
      nodes[vehicleId] = {
        id: vehicleId,
        label: vehicleId,
        group: vehicleId.startsWith("Tanker") ? "tanker" : vehicleId.toLowerCase(),
        title: `Dry Mass: ${vehicle.dryMass_kg} kg\nPropellant Capacity: ${vehicle.propellantCapacity_kg} kg`,
      };
    }

    // Add edges for each maneuver
    for (const [vehicleId, vehicle] of Object.entries(firstOrbit.vehicles)) {
      for (const maneuver of vehicle.maneuvers) {
        const edgeId = `${vehicleId}-${maneuver.label}`;
        edges[edgeId] = {
          id: edgeId,
          from: vehicleId,
          to: maneuver.type.includes("payload") ? maneuver.payloadId || maneuver.vehicleId : vehicleId,
          label: maneuver.label,
          title: `Delta-V: ${maneuver.deltaV_km_per_s || 0} km/s\nPropellant: ${maneuver.usedPropellantMass_kg || 0} kg`,
          arrows: "to",
        };
      }
    }

    return { nodes, edges };
  }
}
