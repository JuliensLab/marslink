export class SimMissionValidator {
  constructor(missionProfiles) {
    const resultTrees = [];
    for (const missionProfile of missionProfiles.byOrbit) {
      const vehicles = missionProfile.vehicles;
      this.vehicles = vehicles;
      const rootVehicles = this.getRootVehicles(vehicles);
      const trees = this.buildTrees(vehicles, rootVehicles);
      // this.displayTrees(this.vehicles, trees);
      resultTrees.push({
        ringName: missionProfile.ringName,
        deploymentFlights_count: missionProfile.deploymentFlights_count,
        satCountPerDeploymentFlight: missionProfile.satCountPerDeploymentFlight,
        satCount: missionProfile.satCount,
        vehicles,
        trees,
      });
    }
    return resultTrees;
  }

  /** Identifies vehicles with a "liftoff" maneuver as root vehicles */
  getRootVehicles(vehicles) {
    const rootVehicles = [];
    for (const vehicleId in vehicles) {
      const vehicle = vehicles[vehicleId];
      if (vehicle.maneuvers) {
        for (const maneuver of vehicle.maneuvers) {
          const typeLower = maneuver.type.toLowerCase();
          const labelLower = maneuver.label.toLowerCase();
          if (typeLower.includes("liftoff") || labelLower.includes("liftoff")) {
            rootVehicles.push(vehicleId);
            break;
          }
        }
      }
    }
    return rootVehicles;
  }

  /** Builds state trees for each root vehicle */
  buildTrees(vehicles, rootVehicles) {
    const trees = [];
    for (const vehicleId of rootVehicles) {
      const initialState = this.getInitialState(vehicles, vehicleId);
      const tree = this.buildStateTree(vehicles, vehicleId, initialState, vehicles[vehicleId].maneuvers, null);
      trees.push(tree);
    }
    return trees;
  }

  /** Initializes the state for a vehicle based on its first maneuver */
  getInitialState(vehicles, vehicleId) {
    const vehicle = vehicles[vehicleId];
    const firstManeuver = vehicle.maneuvers[0];
    let tankerPropellant = 0;
    if (this.hasTankerPayload(vehicle)) {
      tankerPropellant = vehicle.tankerPropellant_kg || 0;
    }
    return {
      mass: firstManeuver.startMass_kg,
      propellant: vehicle.propellantLoaded_kg,
      tankerPropellant: tankerPropellant,
      cumulative_deltaV: 0,
      payload: this.getPayloadForVehicle(vehicles, vehicleId),
    };
  }

  /** Checks if a vehicle has a propellant transfer (send) maneuver */
  hasTankerPayload(vehicle) {
    return vehicle.maneuvers.some((maneuver) => maneuver.type === "propellant transfer (send)");
  }

  /** Determines the payload type or ID for a vehicle */
  getPayloadForVehicle(vehicles, vehicleId) {
    const vehicle = vehicles[vehicleId];
    for (const maneuver of vehicle.maneuvers) {
      if (maneuver.type === "payload deployment (carrier)") {
        return `${maneuver.payloadId}${
          maneuver?.payloadCountPerDeploymentFlight > 1 ? " x" + maneuver.payloadCountPerDeploymentFlight : ""
        }`;
      } else if (maneuver.type === "propellant transfer (send)") {
        return `${Math.round(vehicle.tankerPropellant_kg / 1000)}t`;
      }
    }
    return null;
  }

  /** Recursively builds the state tree for a vehicle */
  buildStateTree(vehicles, vehicleId, currentState, remainingManeuvers, previousEndMass = null) {
    const stateNode = new Node("state", vehicleId, currentState);
    // Check mass consistency with previous maneuver's end mass
    stateNode.massConsistency = previousEndMass === null || Math.abs(currentState.mass - previousEndMass) < 1;
    stateNode.endPropellantPositive = currentState.propellant >= -0.01;
    stateNode.endPropellantWithinCapacity = currentState.propellant <= vehicles[vehicleId].propellantCapacity_kg;
    if (!remainingManeuvers || remainingManeuvers.length === 0) {
      return stateNode;
    }

    const maneuver = remainingManeuvers[0];
    const maneuverNode = new Node("maneuver", vehicleId, null, maneuver);
    stateNode.children.push(maneuverNode);

    const nextState = this.calculateNextState(currentState, maneuver);
    const isp = vehicles[vehicleId].isp_s || 0;
    const calculatedDeltaV = this.calculateDeltaV(maneuver.startMass_kg, maneuver.endMass_kg, isp);
    maneuverNode.deltaVMatch = maneuver.deltaV_km_per_s !== undefined ? Math.abs(calculatedDeltaV - maneuver.deltaV_km_per_s) < 0.02 : true;

    let calculatedEndMass;
    if (maneuver.type === "payload deployment (carrier)") {
      calculatedEndMass = maneuver.startMass_kg - maneuver.payloadMass_kg;
    } else if (maneuver.type === "propellant transfer (send)") {
      calculatedEndMass = maneuver.startMass_kg - maneuver.tankerPropellantOffload_kg;
    } else {
      calculatedEndMass = maneuver.startMass_kg - (maneuver.usedPropellantMass_kg || 0);
    }
    maneuverNode.endMassMatch = Math.abs(calculatedEndMass - maneuver.endMass_kg) < 10;

    maneuverNode.tankerPropellantMatch = true;
    if (maneuver.type === "propellant transfer (send)")
      maneuverNode.tankerPropellantMatch =
        maneuver.tankerPropellantOffload_kg <= vehicles[vehicleId].tankerPropellant_kg &&
        maneuver.tankerPropellantOffload_kg <= vehicles[vehicleId].tankerPropellantCapacity_kg;

    if (maneuver.type === "payload deployment (carrier)") {
      const carrierStateNode = this.buildStateTree(vehicles, vehicleId, nextState, remainingManeuvers.slice(1), maneuver.endMass_kg);
      maneuverNode.children.push(carrierStateNode);

      const deployedVehicleId = maneuver.payloadId;
      const deployedVehicle = vehicles[deployedVehicleId];
      const deployedManeuvers = deployedVehicle.maneuvers;
      const deployedInitialManeuver = deployedManeuvers[0];
      const deployedInitialState = this.getInitialStateForDeployedVehicle(
        vehicles,
        deployedVehicleId,
        deployedInitialManeuver,
        currentState
      );
      const deployedStateNode = this.buildStateTree(vehicles, deployedVehicleId, deployedInitialState, deployedManeuvers.slice(1), null);
      maneuverNode.children.push(deployedStateNode);
    } else {
      const nextStateNode = this.buildStateTree(vehicles, vehicleId, nextState, remainingManeuvers.slice(1), maneuver.endMass_kg);
      maneuverNode.children.push(nextStateNode);
    }

    return stateNode;
  }

  /** Initializes the state for a deployed vehicle */
  getInitialStateForDeployedVehicle(vehicles, vehicleId, initialManeuver, carrierState) {
    const vehicle = vehicles[vehicleId];
    return {
      mass: initialManeuver.startMass_kg,
      propellant: vehicle.propellantLoaded_kg,
      tankerPropellant: 0,
      cumulative_deltaV: carrierState.cumulative_deltaV,
      payload: this.getPayloadForVehicle(vehicles, vehicleId),
    };
  }

  /** Calculates the next state after a maneuver */
  calculateNextState(currentState, maneuver) {
    const nextState = { ...currentState };

    switch (maneuver.type) {
      case "maneuver (delta-V required)":
      case "maneuver (propellant required)":
      case "first stage liftoff":
      case "second stage acceleration to LEO":
      case "single stage liftoff to LEO":
      case "deorbit and landing burn":
        nextState.propellant -= maneuver.usedPropellantMass_kg || 0;
        nextState.cumulative_deltaV += maneuver.deltaV_km_per_s || 0;
        nextState.mass = maneuver.endMass_kg;
        break;
      case "payload deployment (carrier)":
        nextState.payload = null;
        nextState.mass = maneuver.endMass_kg;
        break;
      case "propellant transfer (receive)":
        const receivedPropellant = -maneuver.usedPropellantMass_kg;
        nextState.propellant += receivedPropellant;
        nextState.mass = maneuver.endMass_kg;
        break;
      case "propellant transfer (send)":
        nextState.tankerPropellant -= maneuver.tankerPropellantOffload_kg;
        nextState.mass = maneuver.endMass_kg;
        break;
      case "payload deployment (payload)":
        nextState.mass = maneuver.endMass_kg;
        break;
      default:
        nextState.mass = maneuver.endMass_kg;
    }

    return nextState;
  }

  /** Calculates delta-V using the Tsiolkovsky rocket equation */
  calculateDeltaV(initialMass, finalMass, isp) {
    if (isp === 0 || finalMass === 0 || initialMass <= finalMass) {
      return 0;
    }
    const g0 = 9.80665; // m/s²
    const deltaV_m_per_s = isp * g0 * Math.log(initialMass / finalMass);
    return deltaV_m_per_s / 1000; // Convert to km/s
  }

  /** Displays all trees */
  displayTrees(vehicles, trees) {
    for (const tree of trees) {
      const stringArray = printTree(" ", vehicles, tree, 0);
      //for (let string of stringArray) console.log(string);
      console.log(stringArray.join("\n") + "\n\n");
    }
  }
}

/** Represents a node in the state tree */
class Node {
  constructor(type, vehicleId = null, state = null, maneuver = null) {
    this.type = type;
    this.vehicleId = vehicleId;
    this.state = state;
    this.maneuver = maneuver;
    this.children = [];
    this.massConsistency = false; // For state nodes
    this.deltaVMatch = false; // For maneuver nodes
    this.endMassMatch = false; // For maneuver nodes
  }
}

/** Prints the state tree with validation symbols and messages */
export function printTree(spaceChar, vehicles, node, level, previousEndMass = null, stringArray = []) {
  const prefix = `${spaceChar}${spaceChar}│${spaceChar}`;

  if (node.type === "state") {
    let initialString;
    if (node.children.length === 0) initialString = `${prefix.repeat(level - 1)}${spaceChar}${spaceChar}╰${spaceChar}`;
    else if (level === 0) {
      stringArray.push(`<b>Launchpad [${node.vehicleId}]</b>`);
      initialString = `├─╮${spaceChar}`;
    } else initialString = `${prefix.repeat(level)}`;

    let stateString = `${initialString}${node.vehicleId || "Unknown"}${
      typeof node.state?.propellant === "number"
        ? ` ⋅ Prop ${
            Math.abs(node.state.propellant) >= 1000
              ? (node.state.propellant / 1000).toFixed(0) + "t"
              : node.state.propellant.toFixed(0) + "kg"
          } (${((node.state.propellant / vehicles[node.vehicleId].propellantCapacity_kg) * 100).toFixed(0)}%)`
        : ""
    }${
      typeof node.state?.tankerPropellant === "number" && node.state.tankerPropellant > 0
        ? ` ⋅ Tanker Prop ${
            Math.abs(node.state.tankerPropellant) >= 1000
              ? (node.state.tankerPropellant / 1000).toFixed(0) + "t"
              : node.state.tankerPropellant.toFixed(0) + "kg"
          }`
        : ""
    }${typeof node.state?.cumulative_deltaV === "number" ? ` ⋅ ∑ΔV ${node.state.cumulative_deltaV.toFixed(1)} km/s` : ""}${
      node.state?.payload ? ` [${node.state.payload}]` : ""
    }`;

    if (node.massConsistency && node.endPropellantPositive && node.endPropellantWithinCapacity) stateString += " ✅";
    else stateString += " ❌";
    stringArray.push(stateString);

    if (!node.massConsistency) {
      if (previousEndMass !== null) {
        stringArray.push(
          `${prefix.repeat(level)}⚠ Mass inconsistency for ${node.vehicleId}: Expected ${previousEndMass.toFixed(
            0
          )} kg, but got ${node.state.mass.toFixed(0)} kg.`
        );
      }
    }
    if (!node.endPropellantPositive) {
      stringArray.push(`${prefix.repeat(level)}⚠ Propellant used exceeds propellant available.`);
    }
    if (!node.endPropellantWithinCapacity) {
      stringArray.push(`${prefix.repeat(level)}⚠ Propellant on board exceeds propellant capacity.`);
    }
    if (level === 0) level++;
  }

  if (node.type === "maneuver") {
    let initialString;
    if (node.maneuver.type === "payload deployment (carrier)") {
      initialString = `${prefix.repeat(level - 1)}${spaceChar}${spaceChar}├───╮${spaceChar}`;
      level++;
    } else if (node.maneuver.type === "propellant transfer (send)") {
      initialString = `${prefix.repeat(level - 1)}${spaceChar}${spaceChar}│⛽🠖${spaceChar}`;
    } else if (node.maneuver.type === "propellant transfer (receive)") {
      initialString = `${prefix.repeat(level - 1)}${spaceChar}${spaceChar}│🠔⛽${spaceChar}`;
    } else initialString = `${prefix.repeat(level)}🚀 `;

    let maneuverString = "";
    maneuverString += `${initialString}`;
    maneuverString += "<b>";
    maneuverString += `${node.maneuver.label}${
      typeof node.maneuver.usedPropellantMass_kg === "number"
        ? ` ⋅ Prop ${Math.sign(node.maneuver.usedPropellantMass_kg) === -1 ? "+" : "-"}${
            Math.abs(node.maneuver.usedPropellantMass_kg) >= 1000
              ? (Math.abs(node.maneuver.usedPropellantMass_kg) / 1000).toFixed(0) + "t"
              : node.maneuver.usedPropellantMass_kg.toFixed(0) + "kg"
          }`
        : ""
    }${typeof node.maneuver.deltaV_km_per_s === "number" ? ` ⋅ ΔV +${node.maneuver.deltaV_km_per_s.toFixed(1)} km/s` : ""}${
      typeof node.maneuver.tankerPropellantOffload_kg === "number"
        ? ` ⋅ Offload ${
            Math.abs(node.maneuver.tankerPropellantOffload_kg) >= 1000
              ? (node.maneuver.tankerPropellantOffload_kg / 1000).toFixed(0) + "t"
              : node.maneuver.tankerPropellantOffload_kg.toFixed(0) + "kg"
          }`
        : ""
    }`;
    maneuverString += "</b>";

    if (node.deltaVMatch && node.endMassMatch && node.tankerPropellantMatch) maneuverString += " ✅";
    else maneuverString += " ❌";
    stringArray.push(maneuverString);

    if (!node.deltaVMatch) {
      const calculatedDeltaV = this.calculateDeltaV(
        node.maneuver.startMass_kg,
        node.maneuver.endMass_kg,
        vehicles[node.vehicleId]?.isp_s || 0
      );
      stringArray.push(
        `${prefix.repeat(level)}⚠ Delta-V mismatch for maneuver "${node.maneuver.label}": Calculated ${calculatedDeltaV.toFixed(
          2
        )} km/s, but listed ${node.maneuver.deltaV_km_per_s.toFixed(2)} km/s.`
      );
    }
    if (!node.endMassMatch) {
      let calculatedEndMass =
        node.maneuver.type === "payload deployment (carrier)"
          ? node.maneuver.startMass_kg - node.maneuver.payloadMass_kg
          : node.maneuver.type === "propellant transfer (send)"
          ? node.maneuver.startMass_kg - node.maneuver.tankerPropellantOffload_kg
          : node.maneuver.startMass_kg - (maneuver.usedPropellantMass_kg || 0);
      stringArray.push(
        `${prefix.repeat(level)}⚠ End mass mismatch for maneuver "${node.maneuver.label}": Calculated ${calculatedEndMass.toFixed(
          0
        )} kg, but listed ${node.maneuver.endMass_kg.toFixed(0)} kg.`
      );
    }
    if (!node.tankerPropellantMatch) {
      stringArray.push(
        `${prefix.repeat(level)}⚠ Tanker propellant mismatch: Propellant available ${vehicles[node.vehicleId].tankerPropellant_kg.toFixed(
          0
        )}t, but listed ${node.maneuver.tankerPropellantOffload_kg.toFixed(0)}t. Max capacity ${vehicles[
          node.vehicleId
        ].tankerPropellantCapacity_kg.toFixed(0)}t.`
      );
    }
  }

  if (node.children.length === 2) {
    printTree(spaceChar, vehicles, node.children[1], level, node.maneuver?.endMass_kg, stringArray); // Deployed vehicle
    level--;
    printTree(spaceChar, vehicles, node.children[0], level, node.maneuver?.endMass_kg, stringArray); // Carrier
  } else if (node.children.length === 1) {
    printTree(spaceChar, vehicles, node.children[0], level, node.maneuver?.endMass_kg, stringArray);
  }
  return stringArray;
}
