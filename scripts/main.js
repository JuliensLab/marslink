// Solar System Simulator Configuration - Slider Organization by Sections
// This file contains code to create sliders for the solar system simulator and organizes the sliders into five sections: 'sim', 'costs', 'capability', 'ring 1', and 'ring 2'.

import { solarSystemData } from "./solarSystem.js";
import { SolarSystemScene } from "./threeRender.js";
import { generateSatellites } from "./satellites.js";
import { _3DToAu, auToKm } from "./orbitals.js";

let solarSystemScene;

// Sliders categorized into sections
const slidersData = {
  sim: {
    "time-acceleration-slider": {
      label: "Time Acceleration",
      min: -Math.pow(2, 25),
      max: Math.pow(2, 25),
      value: 1,
      unit: "x",
      scale: "pow2",
      steps: 51,
    },
    "failed-satellites-slider": {
      label: "Satellite failure probability",
      min: 0,
      max: 100,
      value: 0,
      step: 1,
      unit: "%",
      scale: "linear",
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
    },
    "launch-cost-slider": {
      label: "Starship Launch",
      description: "Cost to launch one starship",
      min: 1,
      max: 60,
      value: 20,
      step: 1,
      unit: "m$",
      scale: "linear",
    },
  },
  capability: {
    "sats-per-launch-slider": {
      label: "Satellites per Starship",
      min: 1,
      max: 50,
      value: 20,
      step: 1,
      unit: "",
      scale: "linear",
    },
    "max-link-distance-slider": {
      label: "Link Range",
      min: 0.5,
      max: 2,
      value: 1.0,
      step: 0.01,
      unit: " AU",
      scale: "linear",
    },
  },
  ring1: {
    "satellite-ring-1-distance-sun-slider": {
      label: "Sun Distance",
      min: 0.5,
      max: 2,
      value: 1.3,
      step: 0.01,
      unit: " AU",
      scale: "linear",
    },
    "satellite-ring-1-count-slider": {
      label: "Satellites",
      min: 0,
      max: 50,
      value: 12,
      step: 1,
      unit: "",
      scale: "linear",
    },
  },
  ring2: {
    "satellite-ring-2-distance-sun-slider": {
      label: "Sun Distance",
      min: 0.5,
      max: 2,
      value: 0.7,
      step: 0.01,
      unit: " AU",
      scale: "linear",
    },
    "satellite-ring-2-count-slider": {
      label: "Satellites",
      min: 0,
      max: 50,
      value: 0,
      step: 1,
      unit: "",
      scale: "linear",
    },
  },
};

// Function to map internal slider value to user-facing value for pow2 scale
function mapSliderValueToUserFacing(slider, sliderValue = slider.value) {
  if (slider.scale === "pow2") {
    if (sliderValue == 0) return 0;
    const absValue = Math.abs(sliderValue - 1);
    const result = Math.pow(2, absValue);

    return result * Math.sign(sliderValue);
  } else return sliderValue;
}

// Function to create sliders dynamically with proper min, max, and scale handling
function createSliders() {
  const slidersContainer = document.getElementById("sliders-container");

  for (const section in slidersData) {
    // Create a header for each section
    const sectionHeader = document.createElement("h3");
    sectionHeader.className = "slider-section-header";
    sectionHeader.textContent = section.charAt(0).toUpperCase() + section.slice(1);
    slidersContainer.appendChild(sectionHeader);

    for (const sliderId in slidersData[section]) {
      const slider = slidersData[section][sliderId];

      // Determine min, max, and step for the slider
      let min = slider.min;
      let max = slider.max;
      let step = slider.step;

      if (slider.scale === "pow2") {
        const steps = slider.steps || 101; // Default to 101 if steps are not defined

        if (slider.min < 0 && slider.max > 0) {
          // Mirrored around 0, e.g., -1000 to +1000
          min = -Math.floor(steps / 2);
          max = Math.floor(steps / 2);
        } else if (slider.min >= 0) {
          // Only positive values, e.g., 1 to 1000
          min = 0;
          max = steps - 1;
        }
        step = 1; // Always set step to 1 for pow2 scale
      }

      // Create container for each slider
      const sliderContainer = document.createElement("div");
      sliderContainer.className = "slider-container";

      // Create label for the slider
      const label = document.createElement("label");
      label.setAttribute("for", sliderId);
      label.className = "slider-label";
      label.textContent = slider.label;

      // Create slider input
      const input = document.createElement("input");
      input.type = "range";
      input.id = sliderId;
      input.className = "slider";
      input.min = min;
      input.max = max;
      input.value = slider.value;
      input.step = step;

      // Create span to display the value
      const valueSpan = document.createElement("span");
      valueSpan.id = `${sliderId}-value`;

      // Set initial value display
      let displayValue = slider.value;
      displayValue = mapSliderValueToUserFacing(slider);
      valueSpan.textContent = displayValue + slider.unit;

      // Append label, slider, and value span to the container
      sliderContainer.appendChild(label);
      sliderContainer.appendChild(input);
      sliderContainer.appendChild(valueSpan);

      // Append the container to the sliders container
      slidersContainer.appendChild(sliderContainer);

      // Event listener for slider input changes
      input.addEventListener("input", () => {
        let newValue = parseFloat(input.value);
        let displayValue = newValue;
        displayValue = mapSliderValueToUserFacing(slider, newValue);
        valueSpan.textContent = displayValue + slider.unit;
        updateValues(sliderId, newValue);
      });

      // Load value from local storage if available
      if (localStorage.getItem(sliderId)) {
        input.value = localStorage.getItem(sliderId);
        let storedValue = parseFloat(input.value);
        let storedDisplayValue = storedValue;
        storedDisplayValue = mapSliderValueToUserFacing(slider, storedValue);
        valueSpan.textContent = storedDisplayValue + slider.unit;
        slidersData[section][sliderId].value = parseFloat(input.value);
      }
    }
  }
}

// Update values based on the slider id, considering non-linear scales
function updateValues(sliderId, value) {
  for (const section in slidersData) {
    if (sliderId in slidersData[section]) {
      const slider = slidersData[section][sliderId];
      let newValue = parseFloat(value);

      // Apply mapping to user-facing value if needed
      newValue = mapSliderValueToUserFacing(slider, newValue);

      slidersData[section][sliderId].value = newValue; // Update slidersData with the new value
      localStorage.setItem(sliderId, value); // Save to local storage

      switch (sliderId) {
        case "time-acceleration-slider":
          solarSystemScene.setTimeAccelerationFactor(newValue);
          break;

        case "satellite-ring-1-count-slider":
        case "satellite-ring-1-distance-sun-slider":
        case "satellite-ring-2-count-slider":
        case "satellite-ring-2-distance-sun-slider":
        case "failed-satellites-slider":
          solarSystemScene.updateSatellites(generateRings(slidersData.sim["failed-satellites-slider"].value));
          resetTimerLongtermScore();
          break;

        case "max-link-distance-slider":
          solarSystemScene.setMaxLinkDistance(newValue);
          resetTimerLongtermScore();
          break;

        case "satellite-cost-slider":
          updateInfo();
          break;

        default:
          break;
      }
    }
  }
}

function generateRings(failedSatellitesPct) {
  const satellites = [
    ...generateSatellites(
      slidersData.ring1["satellite-ring-1-count-slider"].value,
      slidersData.ring1["satellite-ring-1-distance-sun-slider"].value,
      1,
      failedSatellitesPct
    ),
    ...generateSatellites(
      slidersData.ring2["satellite-ring-2-count-slider"].value,
      slidersData.ring2["satellite-ring-2-distance-sun-slider"].value,
      2,
      failedSatellitesPct
    ),
  ];
  return satellites;
}

createSliders();
solarSystemScene = new SolarSystemScene(solarSystemData);
solarSystemScene.updateSatellites(generateRings(slidersData.sim["failed-satellites-slider"].value));
solarSystemScene.setMaxLinkDistance(mapSliderValueToUserFacing(slidersData.capability["max-link-distance-slider"]));
solarSystemScene.setTimeAccelerationFactor(mapSliderValueToUserFacing(slidersData.sim["time-acceleration-slider"]));
let longtermScore = solarSystemScene.calculateLongtermScore();

let longtermScoreTimerId;
const LONGTERM_SCORE_INTERVAL_MS = 800;
function resetTimerLongtermScore() {
  longtermScore = null;
  if (longtermScoreTimerId) {
    clearTimeout(longtermScoreTimerId);
  }
  longtermScoreTimerId = setTimeout(timerLongtermScoreElapsed, LONGTERM_SCORE_INTERVAL_MS);
}

function timerLongtermScoreElapsed() {
  longtermScore = solarSystemScene.calculateLongtermScore();
}

export function updateInfo() {
  if (solarSystemScene) {
    const simTime = solarSystemScene.getSimTime();
    document.getElementById("simTime").innerHTML = formatSimTimeToUTC(simTime);
    let launchCountRing1 = Math.ceil(
      slidersData.ring1["satellite-ring-1-count-slider"].value / slidersData.capability["sats-per-launch-slider"].value
    );
    let launchCountRing2 = Math.ceil(
      slidersData.ring2["satellite-ring-2-count-slider"].value / slidersData.capability["sats-per-launch-slider"].value
    );
    let costRing1 =
      slidersData.ring1["satellite-ring-1-count-slider"].value * slidersData.costs["satellite-cost-slider"].value +
      launchCountRing1 * slidersData.costs["launch-cost-slider"].value;
    let costRing2 =
      slidersData.ring2["satellite-ring-2-count-slider"].value * slidersData.costs["satellite-cost-slider"].value +
      launchCountRing2 * slidersData.costs["launch-cost-slider"].value;
    let totalCost = costRing1 + costRing2;
    const marslinkLatencySeconds = auToKm(_3DToAu(solarSystemScene.getShortestPathDistance3D())) / 300000;
    const directLatencySeconds = auToKm(_3DToAu(solarSystemScene.getDirectPathDistance3D())) / 300000;
    const pctLonger = (marslinkLatencySeconds / directLatencySeconds - 1) * 100;
    let html = "";
    if (marslinkLatencySeconds !== Infinity) html += `Marslink latency `;
    html += `${convertSecToText(marslinkLatencySeconds)}`;
    if (marslinkLatencySeconds !== Infinity) html += ` (+${pctLonger.toFixed(0)}%)`;
    html += "<br>";
    html += `${launchCountRing1 + launchCountRing2} launch${
      launchCountRing1 + launchCountRing2 > 1 ? "es" : ""
    } (${launchCountRing1} + ${launchCountRing2})`;

    html += "<br>";
    html += `Total cost $${formatMillions(totalCost)}`;
    if (longtermScore) {
      html += "<br>";
      html += "<br>";
      html += `<b>10-year analysis</b>`;
      html += "<br>";
      if (longtermScore.disconnectedTimePercent > 0) html += `Disconnected ${longtermScore.disconnectedTimePercent.toFixed(2)}% of time`;
      else {
        const pctLonger = (longtermScore.averageMarslinkLatencySeconds / longtermScore.averageDirectLatencySeconds - 1) * 100;

        html += `Average latency ${convertSecToText(longtermScore.averageMarslinkLatencySeconds)} (+${pctLonger.toFixed(0)}%)`;
        html += "<br>";
        html += `Score ${((totalCost * longtermScore.averageMarslinkLatencySeconds) / 1000).toFixed(1)} k$.second`;
        html += "<br>";
        html += `(lower is better)`;
      }
    }
    document.getElementById("info-area").innerHTML = html;
  }
}

function convertSecToText(seconds) {
  if (seconds === Infinity) return "No link";
  seconds = Math.round(seconds);
  let minutes = Math.floor(seconds / 60);
  let remainingSeconds = seconds % 60;

  let text = `${minutes}m ${remainingSeconds}s`;
  return text;
}

function formatMillions(amountInMillions) {
  if (amountInMillions >= 1000) {
    return (amountInMillions / 1000).toFixed(1) + "b";
  } else {
    return amountInMillions.toFixed(0) + "m";
  }
}

function formatSimTimeToUTC(simTime) {
  // Create a Date object using the simulated Unix time
  const simDate = new Date(simTime);

  // Format the date to a readable string in UTC
  const formattedDate = simDate.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  return formattedDate;
}
