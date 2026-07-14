// simDeployment.js

import { calculateHohmannDeltaV_km_s } from "./simDeltaV.js?v=4.35";
import { stationKeepingAccel, ringBaseline, satStationKeeping } from "./simStationKeeping.js?v=4.35";

// Default launch-to-LEO Δv (km/s). Configurable via the Launch Vehicle category
// (see setVehicleConfig); this is the fallback before any config is applied.
const DEFAULT_LAUNCH_TO_LEO_DV_KM_S = 9.5;

// LEO → Earth-SOI escape (C3 = 0). Used by ring_earth flights, which do not
// perform a Hohmann transfer — the launcher just pushes the satellite out of
// Earth's sphere of influence and it ends up in Earth's heliocentric orbit.
export const ESCAPE_BURN_DV_KM_S = 3.2;

// Gravitational constant
const g = 9.81; // m/s^2

export class SimDeployment {
  /**
   * Constructor for SimDeployment class.
   * Vehicle specs default to `vehicleProperties` below and are overridden at
   * runtime by setVehicleConfig (the "Launch Vehicle" config category).
   */
  constructor(planets) {
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
    }

    // Default satellite masses
    this.satelliteEmptyMass = 1000; // kg
    this.laserTerminalMass = 50; // kg
    this.laserPortsPerSatellite = 4;

    // Launch Δv (km/s) — configurable via setVehicleConfig.
    this.launchToLEO_deltaVKmS = DEFAULT_LAUNCH_TO_LEO_DV_KM_S;
    this.escapeBurnDvKmS = ESCAPE_BURN_DV_KM_S;
  }

  /**
   * Apply the Launch Vehicle config category to the live vehicle specs + launch Δv.
   * Each value falls back to the current default when its slider is absent.
   */
  setVehicleConfig(uiConfig) {
    const g = (key, dflt) => {
      const v = uiConfig?.[`launch_vehicle.${key}`];
      return typeof v === "number" && !isNaN(v) ? v : dflt;
    };
    const gs = (key, dflt) => {
      const v = uiConfig?.[`satellite.${key}`];
      return typeof v === "number" && !isNaN(v) ? v : dflt;
    };
    const vp = this.vehicleProperties;
    vp.booster.dryMass_kg = g("booster-dry-mass", vp.booster.dryMass_kg);
    vp.booster.propellantCapacity_kg = g("booster-propellant-capacity", vp.booster.propellantCapacity_kg);
    vp.booster.deorbitLandingPropellant_kg = g("booster-deorbit-propellant", vp.booster.deorbitLandingPropellant_kg);
    vp.booster.isp_s = g("booster-isp", vp.booster.isp_s);
    vp.starship.dryMass_kg = g("starship-dry-mass", vp.starship.dryMass_kg);
    vp.starship.propellantCapacity_kg = g("starship-propellant-capacity", vp.starship.propellantCapacity_kg);
    vp.starship.deorbitLandingPropellant_kg = g("starship-deorbit-propellant", vp.starship.deorbitLandingPropellant_kg);
    vp.starship.maxPayloadCapacity_kg = g("starship-max-payload", vp.starship.maxPayloadCapacity_kg);
    vp.starship.isp_s = g("starship-isp", vp.starship.isp_s);
    vp.tanker.dryMass_kg = g("tanker-dry-mass", vp.tanker.dryMass_kg);
    vp.tanker.propellantCapacity_kg = g("tanker-propellant-capacity", vp.tanker.propellantCapacity_kg);
    vp.tanker.tankerPropellantCapacity_kg = g("tanker-transfer-capacity", vp.tanker.tankerPropellantCapacity_kg);
    vp.tanker.deorbitLandingPropellant_kg = g("tanker-deorbit-propellant", vp.tanker.deorbitLandingPropellant_kg);
    vp.tanker.isp_s = g("tanker-isp", vp.tanker.isp_s);
    // satellite.dryMass_kg is derived (setSatelliteMassConfig); only its propulsion specs are exposed.
    vp.satellite.propellantCapacity_kg = gs("satellite-propellant-capacity", vp.satellite.propellantCapacity_kg);
    vp.satellite.isp_s = gs("satellite-isp", vp.satellite.isp_s);
    // Solar panel mass at Earth orbit = power (kW) × specific mass (kg/kW); the
    // deployment later scales it by distance² for outer rings.
    vp.satellite.solarPanelMass_EarthOrbit_kg = gs("satellite-power-kw", 5) * gs("solar-mass-per-kw", 10);
    this.launchToLEO_deltaVKmS = g("launch-to-leo-dv", this.launchToLEO_deltaVKmS);
    this.escapeBurnDvKmS = g("escape-burn-dv", this.escapeBurnDvKmS);
  }

  setSatelliteMassConfig(emptyMass, laserTerminalMass, ringPorts) {
    this.satelliteEmptyMass = emptyMass;
    this.laserTerminalMass = laserTerminalMass;
    this.dryMasses = {
      ring_earth: emptyMass + ringPorts.ring_earth * laserTerminalMass,
      ring_mars: emptyMass + ringPorts.ring_mars * laserTerminalMass,
      circular_rings: emptyMass + ringPorts.circular_rings * laserTerminalMass,
      eccentric_rings: emptyMass + ringPorts.eccentric_rings * laserTerminalMass,
      adapted_rings: emptyMass + (ringPorts.adapted_rings || 0) * laserTerminalMass,
      adapted_eccentric_rings: emptyMass + (ringPorts.adapted_eccentric_rings || 0) * laserTerminalMass,
    };
    // Update the vehicle properties to the maximum dry mass for compatibility
    this.vehicleProperties.satellite.dryMass_kg = Math.max(...Object.values(this.dryMasses));
  }

  /**
   * Solar-array mass (kg) for a satellite on a ring. The array is sized for a
   * fixed power, so its area/mass grows with the inverse-square solar-flux
   * falloff: mass = (power-kW × specific-mass) × (apoapsis / Earth apoapsis)².
   * Rings closer to the Sun carry smaller arrays, rings farther out larger.
   * @param {number} apo_pctEarth - apoapsis as a fraction of Earth's apoapsis
   */
  solarPanelMassKg(apo_pctEarth) {
    return this.vehicleProperties.satellite.solarPanelMass_EarthOrbit_kg * Math.pow(apo_pctEarth || 1, 2);
  }

  // Both eccentric families are transfer ellipses that meet Earth's orbit at
  // perihelion, so the Earth→ring Hohmann's LARGER burn happens first — the
  // reverse of circular/adapted (concentric) rings. ring_adecc = Adapted
  // Eccentric (apsides fitted to the planets' true orbits); ring_ecce = Eccentric.
  _isEccentricRing(ringName) {
    return ringName.startsWith("ring_ecce") || ringName.startsWith("ring_adecc");
  }

  getDryMassForRing(ringName) {
    if (ringName === "ring_earth") return this.dryMasses.ring_earth;
    if (ringName === "ring_mars") return this.dryMasses.ring_mars;
    if (ringName.startsWith("ring_circ")) return this.dryMasses.circular_rings;
    if (ringName.startsWith("ring_adecc")) return this.dryMasses.adapted_eccentric_rings;
    if (ringName.startsWith("ring_ecce")) return this.dryMasses.eccentric_rings;
    if (ringName.startsWith("ring_adapt")) return this.dryMasses.adapted_rings;
    return this.satelliteEmptyMass; // fallback
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
    // Use raw max capacity per flight — the caller (launch planner) handles
    // distributing across flights with Math.min(maxSats, remainingInRing).
    // The old "balanced rounding" (ceil(total / ceil(total/max))) caused a
    // discontinuity: a 1-sat drop in max capacity could collapse the per-
    // flight count by 25% when the division rounded up to one more flight.
    let payloadCountPerDeploymentFlight = Math.min(totalPayloadCount, maxPayloadCountPerDeploymentFlight);
    let totalDeploymentFlights_count = Math.ceil(totalPayloadCount / payloadCountPerDeploymentFlight);

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
      this.calculateManeuverPropellant(endMass_kg, this.launchToLEO_deltaVKmS, vehicles[vehicleId].isp_s)
    );
    // get vehicle propellant already used in future maneuvers
    const usedPropellantMass_kg = Math.ceil(this.getUsedPropellantMass_kg(vehicles, vehicleId));
    const maxPropellantForThisManeuver_kg = vehicles[vehicleId].propellantCapacity_kg - usedPropellantMass_kg;
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
      const firstStage_deltaV_required_km_per_s = this.launchToLEO_deltaVKmS - secondStage_DeltaV_km_per_s;
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
        deltaV_km_per_s: this.launchToLEO_deltaVKmS,
        usedPropellantMass_kg: propellantRequired_kg,
        startMass_kg: endMass_kg + propellantRequired_kg,
        endMass_kg: endMass_kg,
      });
      vehicles[vehicleId].propellantLoaded_kg += propellantRequired_kg;
    }
  }

  /**
   * Adds station-keeping argon budget for the design lifetime
   * Includes Jupiter secular, SRP, and Earth/Mars co-orbital penalty
   */
  /**
   * Pure station-keeping argon budget (kg) for a 10-yr (default) lifetime, from
   * Jupiter secular + SRP + Earth/Mars co-orbital Δv. Single source of truth —
   * reused by the display for the satellite mass/thrust colour schemes.
   * @param {number} r_au - orbit semi-major axis (AU)
   * @param {string} ringType - "Earth" | "Mars" | other
   * @param {number} i_deg - inclination (deg)
   * @param {number} dryMass_kg - satellite dry mass
   */
  stationKeepingArgonKg(r_au, ringType, i_deg, dryMass_kg, lifetime_years = 10) {
    if (!(r_au > 0) || !(dryMass_kg > 0)) return 0;
    const isEarthRing = ringType === "Earth";
    const isMarsRing = ringType === "Mars";

    // 1. Jupiter secular Δv (Laskar 1988 envelope; m/s/yr)
    const base_dv = 15; // At 1 AU, low i
    let jupiter_dv = base_dv * Math.pow(1.0 / r_au, 1.5); // Scale with a^{-3/2}
    jupiter_dv = Math.max(12, Math.min(18, jupiter_dv)); // Clip to envelope
    if (i_deg > 10) jupiter_dv *= 0.9; // Inclination damping factor

    // 2. Solar Radiation Pressure (A/m = 0.04 m²/kg average for 50 m² panels on 1250 kg sat)
    const srp_at_1au = 36; // m/s per year at A/m = 0.02
    const area_to_mass = 50 / dryMass_kg; // ~0.04 m²/kg
    const srp_dv = srp_at_1au * (0.02 / area_to_mass) * Math.pow(1.0 / r_au, 2);

    // 3. Earth/Mars co-orbital penalty (gravity gradient + differential SRP)
    const proximity_penalty = isEarthRing || isMarsRing ? 20 : 0; // m/s per year

    const total_dv_ms = (jupiter_dv + srp_dv + proximity_penalty) * lifetime_years;

    // Rocket equation with 30% margin (thruster inefficiency, off-nominal, contingency)
    const isp = 4500; // argon gridded ion thruster (realistic 2030)
    const argon_kg = dryMass_kg * (Math.exp(total_dv_ms / (isp * 9.80665)) - 1);
    return Math.ceil(argon_kg * 1.3);
  }

  /**
   * Station-keeping model (replaces the Δv argon budget). For each ring it averages
   * the per-sat station-keeping acceleration → thruster count + n-year propellant
   * (ringBaseline). Planetary-ring sats above the ring's threshold are individually
   * sized (satStationKeeping, capped at cfg.maxN thrusters and cfg.capacity kg).
   * Stores per-ring baselines (this.ringStationKeeping, read by the display) and the
   * sat-count-weighted averages for cost: this.thrusterMassByRing (avg N·tm) and
   * this.skPropByRing (avg propellant). Also tracks max/distinct thruster counts.
   * @param {Object} cfg - { F (N), tm (kg), maxN, n (yr), isp (s), capacity (kg) }
   */
  computeStationKeeping(satellites, orbitalElements, bodyPositions, cfg) {
    // Per-ring dry mass (bus + lasers + distance-scaled solar).
    const dryByRing = {};
    for (const el of orbitalElements || []) {
      if (!el || !el.ringName) continue;
      dryByRing[el.ringName] = this.getDryMassForRing(el.ringName) + this.solarPanelMassKg(el.apsides ? el.apsides.apo_pctEarth : 1);
    }
    // Per-ring average station-keeping acceleration (sample the sats).
    const sumA = {}, count = {};
    for (const sat of satellites || []) {
      const rn = sat && sat.ringName;
      if (!rn || dryByRing[rn] === undefined || !sat.position) continue;
      sumA[rn] = (sumA[rn] || 0) + stationKeepingAccel(sat.position, bodyPositions);
      count[rn] = (count[rn] || 0) + 1;
    }
    // Per-ring baseline: thruster count, n-year propellant, refinement threshold.
    const ringData = {};
    for (const rn in dryByRing) {
      const aAvg = count[rn] ? sumA[rn] / count[rn] : 0;
      const dry = dryByRing[rn];
      ringData[rn] = { dryMass: dry, aAvg, ...ringBaseline(aAvg, dry, cfg) };
    }
    // Per-sat sizing → sat-count-weighted ring averages (cost) + max/distinct N.
    const sumN = {}, sumProp = {}, nSet = new Set();
    let maxN = 1;
    for (const sat of satellites || []) {
      const rn = sat && sat.ringName;
      if (!rn || !ringData[rn] || !sat.position) continue;
      const rd = ringData[rn];
      const isPlanetary = rn === "ring_earth" || rn === "ring_mars";
      const s = satStationKeeping(stationKeepingAccel(sat.position, bodyPositions), rd.dryMass, rd, isPlanetary, cfg);
      sumN[rn] = (sumN[rn] || 0) + s.N;
      sumProp[rn] = (sumProp[rn] || 0) + s.skProp;
      if (s.N > maxN) maxN = s.N;
      nSet.add(s.N);
    }
    const thrusterMassByRing = {}, skPropByRing = {};
    for (const rn in ringData) {
      const c = count[rn] || 0;
      thrusterMassByRing[rn] = (c ? sumN[rn] / c : ringData[rn].nRing) * cfg.tm;
      skPropByRing[rn] = c ? sumProp[rn] / c : ringData[rn].skPropRing;
    }
    this.ringStationKeeping = ringData;
    this.thrusterMassByRing = thrusterMassByRing;
    this.skPropByRing = skPropByRing;
    this.maxThrusterCount = maxN;
    this.thrusterCounts = [...nSet].sort((a, b) => a - b);
    return ringData;
  }

  addStationKeepingPropellant(vehicles, vehicleId, targetOrbitElements, lifetime_years = 10) {
    const sat = vehicles[vehicleId];
    if (!sat || sat.propellantType !== "Argon") return;

    // SK propellant comes from the thrust-based model (computeStationKeeping), which
    // must run before getMissionProfile; fall back to 0 if it hasn't.
    const argon_kg = Math.ceil((this.skPropByRing && this.skPropByRing[targetOrbitElements.ringName]) || 0);

    this.addManeuverByPropellantRequired(vehicles, vehicleId, "Station keeping", argon_kg);
    sat.stationKeepingArgon_kg = argon_kg; // for reporting
    sat.propellantCapacity_kg = Math.max(sat.propellantCapacity_kg, sat.propellantLoaded_kg);
  }

  /**
   * Adds deorbit maneuver (reverse Hohmann + inclination change) using argon
   */
  addDeorbitManeuver(vehicles, vehicleId, targetOrbitElements) {
    const sat = vehicles[vehicleId];
    if (!sat || sat.propellantType !== "Argon") return;

    const outbound = calculateHohmannDeltaV_km_s(this.earth, targetOrbitElements);

    // Deorbit is symmetric: same Δv as outbound, but in reverse order
    const deorbitDeltaV1 = this._isEccentricRing(targetOrbitElements.ringName)
      ? outbound.deltaV1 // eccentric: first burn is larger
      : outbound.deltaV2;
    const deorbitDeltaV2 = this._isEccentricRing(targetOrbitElements.ringName) ? outbound.deltaV2 : outbound.deltaV1;

    // Add burns in reverse chronological order (last maneuver first in code)
    this.addManeuverByDeltaVRequired(vehicles, vehicleId, "Deorbit burn 2 (circularization at Earth)", deorbitDeltaV2);
    this.addManeuverByDeltaVRequired(vehicles, vehicleId, "Deorbit burn 1 (departure from ring)", deorbitDeltaV1);
    this.addManeuverByDeltaVRequired(vehicles, vehicleId, "Deorbit inclination change", outbound.deltaV_inclination);
  }

  /**
   * Gets the mission profile for a given target orbit
   * @param {Array} targetOrbitElementsArray - Array of orbital elements for each ring
   * @returns {Object} Mission profile for the given target orbit
   */
  /**
   * Largest-feasible-payload mission profile for one ring.
   *
   * getMissionProfileOneOrbit returns { error:true, satCountPerDeploymentFlight } when the
   * per-flight payload makes the outbound burn exceed vehicle propellant capacity.
   * Feasibility is MONOTONIC in sats-per-flight (fewer sats ⇒ less mass ⇒ feasible), so we
   * BINARY-search the largest feasible count. The previous code decremented the cap by one
   * each iteration with a 10-try limit, so a high-Δv ring that only fits ~100 sats/flight
   * (e.g. an eccentric ring whose perihelion velocity is high) never converged and threw
   * "Too many iterations" — which nuked the entire cost computation for every ring.
   */
  _searchFeasibleProfile(targetOrbitElements, outboundDeltaVOverride, maxSatCap = Infinity) {
    const run = (cap) => this.getMissionProfileOneOrbit(targetOrbitElements, cap, outboundDeltaVOverride);

    // The common low-Δv case fits the largest allowed payload immediately.
    const top = run(maxSatCap);
    if (!top.error) return top.result;

    // Errored: the count it tried is an infeasible upper bound. A flight must carry at
    // least one satellite — if even that overflows, the ring genuinely can't be deployed.
    let hi = top.satCountPerDeploymentFlight;
    const single = run(1);
    if (single.error) {
      throw new Error(
        `Cannot deploy ${targetOrbitElements.ringName}: a single-satellite flight exceeds vehicle capacity by ${Math.round(single.excess)} kg`
      );
    }

    // Largest feasible sats-per-flight in [1, hi).
    let lo = 1, best = single.result;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      const m = run(mid);
      if (m.error) hi = mid;
      else { lo = mid; best = m.result; }
    }
    return best;
  }

  getMissionProfile(targetOrbitElementsArray) {
    const results_by_orbit = [];
    for (const targetOrbitElements of targetOrbitElementsArray) {
      if (targetOrbitElements == null) continue;
      const result = this._searchFeasibleProfile(targetOrbitElements);
      results_by_orbit.push({
        ringName: targetOrbitElements.ringName,
        satCount: targetOrbitElements.satCount,
        deploymentFlights_count: result.deploymentFlights_count,
        satCountPerDeploymentFlight: result.satCountPerDeploymentFlight,
        vehicles: result.vehicles,
        orbits: result.orbits,
      });
    }
    return { byOrbit: results_by_orbit };
  }

  /**
   * Compute a single deployment-flight profile for a given ring with the
   * supplied outbound delta-V. Mirrors the retry loop of `getMissionProfile`
   * but returns just one profile (the caller is scheduling one flight at a
   * time). The returned object has `satCountPerDeploymentFlight`, `vehicles`,
   * and `orbits` — identical in shape to `getMissionProfileOneOrbit`'s result.
   *
   * @param {Object} targetOrbitElements - Target ring's Keplerian elements (must include ringName, satCount, apsides)
   * @param {Object} outboundDeltaV - { deltaV1, deltaV2, deltaV_inclination, totalDeltaV }
   * @returns {Object} { satCountPerDeploymentFlight, vehicles, orbits }
   */
  getFlightProfile(targetOrbitElements, outboundDeltaV, maxSatCount = Infinity) {
    return this._searchFeasibleProfile(targetOrbitElements, outboundDeltaV, maxSatCount);
  }

  /**
   * Compute a single mission profile for one ring. By default the outbound
   * delta-V is derived from the standard Earth→target Hohmann; callers that
   * want per-flight delta-V (e.g. the launch planner with instantaneous
   * heliocentric radii) can supply `outboundDeltaVOverride` with the shape
   * `{ deltaV1, deltaV2, deltaV_inclination, totalDeltaV }`.
   *
   * @param {Object} targetOrbitElements - Target ring's Keplerian elements + satCount
   * @param {number} maxSatCountPerDeploymentFlight_fromLoop - Cap used by the retry loop
   * @param {Object} [outboundDeltaVOverride]
   */
  getMissionProfileOneOrbit(targetOrbitElements, maxSatCountPerDeploymentFlight_fromLoop, outboundDeltaVOverride) {
    // Calculate outbound delta-V using the imported function (or use an injected override)
    const outboundDeltaV_km_per_s =
      outboundDeltaVOverride || calculateHohmannDeltaV_km_s(this.earth, targetOrbitElements);

    const outboundDeltaV1 = this._isEccentricRing(targetOrbitElements.ringName)
      ? outboundDeltaV_km_per_s.deltaV2
      : outboundDeltaV_km_per_s.deltaV1;
    const outboundDeltaV2 = this._isEccentricRing(targetOrbitElements.ringName)
      ? outboundDeltaV_km_per_s.deltaV1
      : outboundDeltaV_km_per_s.deltaV2;

    const vehicles = {};

    const solarPanelMass_kg = this.solarPanelMassKg(targetOrbitElements.apsides.apo_pctEarth);
    const baseDryMass =
      this.getDryMassForRing(targetOrbitElements.ringName) +
      ((this.thrusterMassByRing && this.thrusterMassByRing[targetOrbitElements.ringName]) || 0);
    const satelliteProps = { ...this.vehicleProperties.satellite, dryMass_kg: baseDryMass };
    this.addVehicle(vehicles, "Satellites", satelliteProps, solarPanelMass_kg);

    // End-of-life deorbit back to Earth (responsible disposal)
    this.addDeorbitManeuver(vehicles, "Satellites", targetOrbitElements);

    // Station-keeping for 15 years (Jupiter + SRP + proximity)
    this.addStationKeepingPropellant(vehicles, "Satellites", targetOrbitElements, 10);

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
    const tankerLaunchesPerDeploymentFlight_count = Math.ceil(
      totalStarshipPropellantRequired_kg / this.vehicleProperties.tanker.tankerPropellantCapacity_kg
    );
    const tankerPropellantRequired_kg = totalStarshipPropellantRequired_kg / tankerLaunchesPerDeploymentFlight_count;
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
