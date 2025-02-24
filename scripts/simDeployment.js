// simDeployment.js

// Import the delta-V calculation function
import { calculateDeltaV_km_s } from "./simDeltaV.js?v=2.4";

// Define the Starship performance data, including booster data
const starshipPerformance = {
  flight3: {
    starship: {
      dryMass_kg: 120000, // kg
      propellantLoad_kg: 1200000, // kg
      payloadCapacity_kg: 100000, // kg
      landingBurnPropellant_kg: 10000, // kg
    },
    booster: {
      dryMass_kg: 200000, // kg (example value)
      propellantLoad_kg: 3650000, // kg (example value)
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
      landingBurnPropellant_kg: 10000, // kg
    },
    booster: {
      dryMass_kg: 200000, // kg (example value)
      propellantLoad_kg: 3650000, // kg (example value)
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
      landingBurnPropellant_kg: 10000, // kg
    },
    booster: {
      dryMass_kg: 200000, // kg (example value)
      propellantLoad_kg: 3650000, // kg (example value)
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

// Gravitational constant
const g = 9.81; // m/s^2

export class SimDeployment {
  /**
   * Constructor for SimDeployment class
   * @param {string} variant - Starship variant ('flight3', 'starship2', or 'starship3')
   */
  constructor(variant = "starship3") {
    if (!starshipPerformance[variant]) {
      throw new Error(`Invalid Starship variant: ${variant}. Choose from 'flight3', 'starship2', or 'starship3'.`);
    }
    this.variant = variant;
    this.starship = starshipPerformance[variant];
    this.orbitalElements = [];
    this.deltaV_results = [];
  }

  /**
   * Sets the orbital elements and calculates delta-V for each plane
   * @param {Array} targetOrbitElementsArray - Array of orbital elements for each ring
   * @param {Array} planets - Array of planet objects, including Earth
   */
  setOrbitalElements(targetOrbitElementsArray, planets) {
    this.orbitalElements = targetOrbitElementsArray;
    console.log("Orbital Elements Input:", JSON.stringify(targetOrbitElementsArray, null, 2));

    // Find Earth from the planets array
    let earth = {};
    for (const planet of planets) {
      if (planet.name === "Earth") {
        earth = planet;
        break;
      }
    }

    if (!earth.name) {
      throw new Error("Earth not found in planets array.");
    }

    const deltaV_results = [];
    for (const targetOrbitElements of targetOrbitElementsArray) {
      // Calculate outbound and inbound delta-V using the imported function
      const outboundDeltaV_km_per_s = calculateDeltaV_km_s(earth, targetOrbitElements);
      const inboundDeltaV_km_per_s = calculateDeltaV_km_s(targetOrbitElements, earth);

      // Log the results for debugging
      console.log(`Ring: ${targetOrbitElements.ringName}`);
      console.log("  Outbound Delta-V:", outboundDeltaV_km_per_s);
      console.log("  Inbound Delta-V:", inboundDeltaV_km_per_s);

      // Store the results
      deltaV_results.push({
        ringName: targetOrbitElements.ringName,
        ringType: targetOrbitElements.ringType,
        satCount: targetOrbitElements.satCount,
        outboundDeltaV_km_per_s: outboundDeltaV_km_per_s,
        inboundDeltaV_km_per_s: inboundDeltaV_km_per_s,
      });
    }
    this.deltaV_results = this.calculateDeployment(deltaV_results);
    console.log("Final Results:", JSON.stringify(this.deltaV_results, null, 2));
    return this.deltaV_results;
  }

  getDeltaVResults() {
    return this.deltaV_results;
  }

  /**
   * Calculates the total mass of a satellite, including propellant
   * @param {number} deltaV2_km_per_s - Delta-V for the second maneuver (km/s)
   * @param {number} deltaV_inclination_km_per_s - Delta-V for inclination change (km/s)
   * @param {number} m_dry_sat_kg - Dry mass of the satellite (kg)
   * @param {number} I_sp_sat_s - Specific impulse of the satellite's propulsion (s)
   * @returns {Object} Total mass and propellant mass of the satellite
   */
  calculateSatelliteMass(deltaV2_km_per_s, deltaV_inclination_km_per_s, m_dry_sat_kg, I_sp_sat_s) {
    const deltaV_sat_m_per_s = (deltaV2_km_per_s + deltaV_inclination_km_per_s) * 1000;
    const m_prop_sat_kg = Math.ceil(m_dry_sat_kg * (Math.exp(deltaV_sat_m_per_s / (I_sp_sat_s * g)) - 1));
    return { total_kg: m_dry_sat_kg + m_prop_sat_kg, prop_kg: m_prop_sat_kg };
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

  calculateDeltaV_m_per_s(spaceshipDryMass_kg, propellant_kg, I_sp_s) {
    const initialMass = spaceshipDryMass_kg + propellant_kg;
    const finalMass = spaceshipDryMass_kg;
    const deltaV_m_per_s = I_sp_s * g * Math.log(initialMass / finalMass);
    return Math.round(deltaV_m_per_s); // Convert to m/s
  }

  /**
   * Calculates the resources needed for all orbital planes
   * @param {Array} deltaV_results - Array of delta-V results for each orbital plane
   * @returns {Array} Array of results for each orbital plane
   */
  calculateDeployment(deltaV_results) {
    const results = [];
    for (const deltaV_result of deltaV_results) {
      const { ringName, satCount, outboundDeltaV_km_per_s, inboundDeltaV_km_per_s } = deltaV_result;

      const outboundDeltaV1 = deltaV_result.ringType == "Eccentric" ? outboundDeltaV_km_per_s.deltaV2 : outboundDeltaV_km_per_s.deltaV1;
      const outboundDeltaV2 = deltaV_result.ringType == "Eccentric" ? outboundDeltaV_km_per_s.deltaV1 : outboundDeltaV_km_per_s.deltaV2;

      // Calculate satellite prop and total mass
      const { total_kg: m_total_sat_kg, prop_kg: m_prop_sat_kg } = this.calculateSatelliteMass(
        outboundDeltaV2,
        outboundDeltaV_km_per_s.deltaV_inclination,
        satellites.dryMass_kg, // m_dry_sat_kg = 1500 kg
        satellites.IspVacuum_s // I_sp_sat_s = 1800 s / electric propulsion
      );
      const satellite_deltaV_km_per_s = this.calculateDeltaV_m_per_s(satellites.dryMass_kg, m_prop_sat_kg, satellites.IspVacuum_s) / 1000;

      // Calculate how many satellites fit based on mass
      if (m_total_sat_kg <= 0) throw new Error("Satellite total mass must be positive.");
      const satellitesPerDeploymentFlight_count = Math.floor(this.starship.starship.payloadCapacity_kg / m_total_sat_kg);

      // Calculate actual payload mass
      const m_payload_mass_kg = satellitesPerDeploymentFlight_count * m_total_sat_kg;

      // Calculate return propellant to return from delta-V 1 with no satellites on board
      const I_sp_starship_s = this.starship.engines.IspVacuum_s; // Use vacuum Isp for in-space maneuvers
      const m_prop_return_kg = this.calculateManeuverPropellant(this.starship.starship.dryMass_kg, outboundDeltaV1, I_sp_starship_s);

      // Calculate delta-V 1 for Starship with satellites onboard
      const m_prop_outbound_kg = this.calculateManeuverPropellant(
        this.starship.starship.dryMass_kg + m_payload_mass_kg + m_prop_return_kg + this.starship.starship.landingBurnPropellant_kg,
        outboundDeltaV1,
        I_sp_starship_s
      );

      // Calculate how much fuel is needed for starship to bring its max payload capacity to delta-V 1 and return and land
      const m_prop_total_kg = m_prop_outbound_kg + m_prop_return_kg + this.starship.starship.landingBurnPropellant_kg;
      if (m_prop_total_kg > this.starship.starship.propellantLoad_kg)
        throw new Error("Starship doesn't have enough propellant capacity to perform 1st Hohmann burn and return to land");

      const starship_postLEO_payload_deltaV_km_per_s =
        this.calculateDeltaV_m_per_s(
          this.starship.starship.dryMass_kg + m_payload_mass_kg + m_prop_return_kg + this.starship.starship.landingBurnPropellant_kg,
          m_prop_outbound_kg,
          I_sp_starship_s
        ) / 1000;

      const starship_postLEO_postPayload_deltaV_km_per_s =
        this.calculateDeltaV_m_per_s(
          this.starship.starship.dryMass_kg,
          m_prop_return_kg + this.starship.starship.landingBurnPropellant_kg,
          I_sp_starship_s
        ) / 1000;

      // Calculate required number of tanker launches for 1 deployment flight
      const tankerLaunchesPerDeploymentFlight_count = Math.ceil(m_prop_total_kg / this.starship.starship.payloadCapacity_kg);
      // this could be optimized to avoid bringing excess fuel, where not all tankers bring full fuel

      // Calculate total propellant per launch (including booster)
      const totalPropellantPerIndividualLaunch_kg = this.starship.booster.propellantLoad_kg + this.starship.starship.propellantLoad_kg;

      // Propellant per deployment flight
      const totalPropellantPerDeploymentFlight_kg = totalPropellantPerIndividualLaunch_kg * (1 + tankerLaunchesPerDeploymentFlight_count);

      // Calculate total launches needed for the orbital plane
      if (satellitesPerDeploymentFlight_count <= 0) throw new Error("Satellites per launch must be positive.");
      const totalDeploymentFlights_count = Math.ceil(satCount / satellitesPerDeploymentFlight_count);
      const totalIndividualFlights_count = (1 + tankerLaunchesPerDeploymentFlight_count) * totalDeploymentFlights_count;

      // Total fuel
      const totalPropellant_kg = totalPropellantPerDeploymentFlight_kg * totalDeploymentFlights_count;

      // Store results
      const result = {
        ringName,
        satCount,
        satellites: {
          totalMass_kg: m_total_sat_kg,
          propMass_kg: m_prop_sat_kg,
          dryMass_kg: satellites.dryMass_kg,
          IspVacuum_s: satellites.IspVacuum_s,
          satellite_deltaV_km_per_s,
        },
        starship: {
          payloadMass_kg: m_payload_mass_kg,
          outboundPropellant_kg: m_prop_outbound_kg,
          returnPropellant_kg: m_prop_return_kg,
          landingPropellant_kg: this.starship.starship.landingBurnPropellant_kg,
          starship_postLEO_payload_deltaV_km_per_s,
          starship_postLEO_postPayload_deltaV_km_per_s,
        },
        deployment: {
          totalDeploymentFlights_count,
          satellitesPerDeploymentFlight_count,
          tankerLaunchesPerDeploymentFlight_count,
          totalIndividualFlights_count,
          rocketPropellant: {
            perIndividualLaunch_tons: Math.round(totalPropellantPerIndividualLaunch_kg / 1000),
            perDeploymentFlight_tons: Math.round(totalPropellantPerDeploymentFlight_kg / 1000),
            total_tons: Math.round(totalPropellant_kg / 1000),
          },
          satellitePropellant: {
            perLaunch_tons: Math.round((satellitesPerDeploymentFlight_count * m_prop_sat_kg) / 1000),
            total_tons: Math.round((satCount * m_prop_sat_kg) / 1000),
          },
        },
        orbits: {
          outboundDeltaV_km_per_s,
          inboundDeltaV_km_per_s,
        },
      };
      results.push(result);
      console.log(result);
    }

    // Calculate total rocket propellant
    const totalRocketProp_tons = results.reduce((sum, ring) => {
      return sum + ring.deployment.rocketPropellant.total_tons;
    }, 0);

    // Calculate total satellite propellant
    const totalSatelliteProp_tons = results.reduce((sum, ring) => {
      return sum + ring.deployment.satellitePropellant.total_tons;
    }, 0);

    const totalDeploymentFlights_count = results.reduce((sum, ring) => {
      return sum + ring.deployment.totalDeploymentFlights_count;
    }, 0);

    const totalIndividualFlights_count = results.reduce((sum, ring) => {
      return sum + ring.deployment.totalIndividualFlights_count;
    }, 0);

    const satellites_count = results.reduce((sum, ring) => {
      return sum + ring.satCount;
    }, 0);

    return {
      totals: {
        totalRocketProp_tons,
        totalSatelliteProp_tons,
        totalDeploymentFlights_count,
        totalIndividualFlights_count,
        satellites_count,
      },
      byOrbit: results,
    };
  }
}
