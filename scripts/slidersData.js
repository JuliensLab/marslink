// slidersData.js

export const slidersData = {
  simulation: {
    "time-acceleration-slider": {
      label: "Time Acceleration",
      min: -Math.pow(2, 25),
      max: Math.pow(2, 25),
      value: 1,
      unit: "",
      scale: "pow2",
      steps: 51,
      updateLongTermScore: false,
    },
    // "failed-satellites-slider": {
    //   label: "Satellite failure probability",
    //   min: 0,
    //   max: 100,
    //   value: 0,
    //   step: 1,
    //   unit: "%",
    //   scale: "linear",
    //   updateLongTermScore: true,
    // },
    maxDistanceAU: {
      label: "Maximum link range AU",
      min: 0,
      max: 2,
      value: 0.2,
      step: 0.01,
      unit: " AU",
      scale: "linear",
      updateLongTermScore: true,
    },
    calctimeSec: {
      label: "Allowed calc time",
      min: 0,
      max: 10,
      value: 0.5,
      step: 0.1,
      unit: " sec",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  costs: {
    "satellite-cost-slider": {
      label: "Satellite Production",
      description: "Cost to produce one satellite",
      min: 0.1,
      max: 50,
      value: 20,
      step: 0.1,
      unit: "m$",
      scale: "linear",
      updateLongTermScore: false,
    },
    "launch-cost-slider": {
      label: "Starship Launch",
      description: "Cost to launch one Starship",
      min: 1,
      max: 60,
      value: 20,
      step: 1,
      unit: "m$",
      scale: "linear",
      updateLongTermScore: false,
    },
    "sats-per-launch-slider": {
      label: "Satellites per Starship",
      min: 1,
      max: 50,
      value: 20,
      step: 1,
      unit: "",
      scale: "linear",
      updateLongTermScore: false,
    },
  },
  capability: {
    "laser-ports-per-satellite": {
      label: "Laser Terminals per Satellite",
      min: 2,
      max: 20,
      value: 6,
      step: 1,
      unit: " ports",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  current_technology_performance: {
    "current-throughput-gbps": {
      label: "Today's throughput",
      min: 1,
      max: 999,
      value: 100,
      step: 1,
      unit: " Gbps",
      scale: "linear",
      updateLongTermScore: true,
    },
    "current-distance-km": {
      label: "Today's distance",
      min: 100,
      max: 10000,
      value: 5400,
      step: 1,
      unit: " km",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  technology_improvement: {
    "telescope-diameter-m": {
      label: "Telescope diameter",
      min: 0.1,
      max: 5,
      value: 0.5,
      step: 0.1,
      unit: " m",
      scale: "linear",
      updateLongTermScore: true,
    },
    "receiver-sensitivity-improvement": {
      label: "Receiver sensitivity improvement",
      min: 1,
      max: 50,
      value: 5,
      step: 1,
      unit: " x",
      scale: "linear",
      updateLongTermScore: true,
    },
    "transmitter-power-improvement": {
      label: "Transmitter power improvement",
      min: 1,
      max: 50,
      value: 5,
      step: 1,
      unit: " x",
      scale: "linear",
      updateLongTermScore: true,
    },
    "modulation-improvement": {
      label: "Other improvements",
      min: 1,
      max: 50,
      value: 3,
      step: 0.1,
      unit: " x",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  ring_earth: {
    "side-extension-degrees-slider": {
      label: "Side extension",
      min: 0,
      max: 180,
      value: 10,
      step: 1,
      unit: "°",
      scale: "linear",
      updateLongTermScore: true,
    },
    "satellite-count-slider": {
      label: "Satellites",
      min: 0,
      max: 200,
      value: 4,
      step: 2,
      unit: "",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  ring_mars: {
    "side-extension-degrees-slider": {
      label: "Side extension",
      min: 0,
      max: 180,
      value: 10,
      step: 1,
      unit: "°",
      scale: "linear",
      updateLongTermScore: true,
    },
    "satellite-count-slider": {
      label: "Satellites",
      min: 0,
      max: 200,
      value: 4,
      step: 2,
      unit: "",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  circular_rings: {
    ringcount: {
      label: "Ring count",
      min: 0,
      max: 10,
      value: 4,
      step: 1,
      unit: "",
      scale: "linear",
      updateLongTermScore: true,
    },
    requiredmbpsbetweensats: {
      label: "Throughput in ring",
      min: 0,
      max: 999,
      value: 50,
      step: 1,
      unit: " Mbps",
      scale: "linear",
      updateLongTermScore: true,
    },
    "distance-sun-slider-outer-au": {
      label: "Sun Distance Outer Ring",
      min: 0.5,
      max: 2,
      value: 1.63,
      step: 0.01,
      unit: " AU",
      scale: "linear",
      updateLongTermScore: true,
    },
    "distance-sun-slider-inner-au": {
      label: "Sun Distance Inner Ring",
      min: 0.5,
      max: 2,
      value: 1.0,
      step: 0.01,
      unit: " AU",
      scale: "linear",
      updateLongTermScore: true,
    },
    "earth-mars-orbit-inclination-pct": {
      label: "Earth vs Mars inclination",
      min: 0,
      max: 100,
      value: 0,
      step: 1,
      unit: " %",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  eccentric_rings: {
    ringcount: {
      label: "Ring count",
      min: 0,
      max: 16,
      value: 0,
      step: 1,
      unit: "",
      scale: "linear",
      updateLongTermScore: true,
    },
    requiredmbpsbetweensats: {
      label: "Average throughput in ring",
      min: 0,
      max: 999,
      value: 0,
      step: 1,
      unit: " Mbps",
      scale: "linear",
      updateLongTermScore: true,
    },
    "distance-sun-average-au": {
      label: "Sun Distance Average",
      min: 0.5,
      max: 2,
      value: 1.5,
      step: 0.01,
      unit: " AU",
      scale: "linear",
      updateLongTermScore: true,
    },
    eccentricity: {
      label: "Eccentricity",
      min: 0,
      max: 1,
      value: 0.1,
      step: 0.01,
      unit: "",
      scale: "linear",
      updateLongTermScore: true,
    },
    "argument-of-perihelion": {
      label: "Argument of Perihelion",
      min: 0,
      max: 360,
      value: 0,
      step: 1,
      unit: " °",
      scale: "linear",
      updateLongTermScore: true,
    },
    "earth-mars-orbit-inclination-pct": {
      label: "Earth vs Mars inclination",
      min: 0,
      max: 100,
      value: 0,
      step: 1,
      unit: " %",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
};
