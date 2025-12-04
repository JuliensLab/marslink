// simSolarSystem.js

import { helioCoords } from "./simOrbits.js?v=4.3";
import { SIM_CONSTANTS } from "./simConstants.js";

export class SimSolarSystem {
  constructor() {
    this.solarSystemData = SIM_CONSTANTS.SOLAR_SYSTEM_DATA;
  }

  getSolarSystemData() {
    return this.solarSystemData;
  }

  updatePlanetsPositions(simDaysSinceStart) {
    for (const [name, object] of Object.entries(this.solarSystemData.planets))
      this.solarSystemData.planets[name].position = helioCoords(object, simDaysSinceStart);
    return this.solarSystemData.planets;
  }
}
