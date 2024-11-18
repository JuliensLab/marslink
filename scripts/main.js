// Solar System Simulator Configuration - Slider Organization by Sections with Unlimited Rings
import { solarSystemData } from "./solarSystem.js";
import { SolarSystemScene } from "./threeRender.js";
import { generateSatellites } from "./satellites.js";
import { _3DToAu, auToKm } from "./orbitals.js";

let solarSystemScene;
let longtermScore;

// Sliders categorized into sections with dynamic rings
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
      updateLongTermScore: false,
    },
    "failed-satellites-slider": {
      label: "Satellite failure probability",
      min: 0,
      max: 100,
      value: 0,
      step: 1,
      unit: "%",
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
      description: "Cost to launch one starship",
      min: 1,
      max: 60,
      value: 20,
      step: 1,
      unit: "m$",
      scale: "linear",
      updateLongTermScore: false,
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
      updateLongTermScore: false,
    },
    "minimum-rate-mbps-slider": {
      label: "Minimum Rate",
      min: 4,
      max: 1000,
      value: 100,
      step: 1,
      unit: " Mbps",
      scale: "linear",
      updateLongTermScore: true,
    },
  },
  rings: [
    // Example Ring Configuration
    {
      id: "ringMars",
      label: "Ring Mars",
      sliders: {
        "side-extension-degrees-slider": {
          label: "Side extension",
          min: 0,
          max: 180,
          value: 0,
          step: 1,
          unit: "°",
          scale: "linear",
          updateLongTermScore: true,
        },
        "satellite-count-slider": {
          label: "Satellites",
          min: 0,
          max: 100,
          value: 12,
          step: 1,
          unit: "",
          scale: "linear",
          updateLongTermScore: true,
        },
      },
    },
    {
      id: "ring2",
      label: "Ring Circular High",
      sliders: {
        "distance-sun-slider": {
          label: "Sun Distance",
          min: 0.5,
          max: 2,
          value: 1.3,
          step: 0.01,
          unit: " AU",
          scale: "linear",
          updateLongTermScore: true,
        },
        "satellite-count-slider": {
          label: "Satellites",
          min: 0,
          max: 100,
          value: 0,
          step: 1,
          unit: "",
          scale: "linear",
          updateLongTermScore: true,
        },
      },
    },
    {
      id: "ring3",
      label: "Ring Circular Low",
      sliders: {
        "distance-sun-slider": {
          label: "Sun Distance",
          min: 0.5,
          max: 2,
          value: 1.3,
          step: 0.01,
          unit: " AU",
          scale: "linear",
          updateLongTermScore: true,
        },
        "satellite-count-slider": {
          label: "Satellites",
          min: 0,
          max: 100,
          value: 0,
          step: 1,
          unit: "",
          scale: "linear",
          updateLongTermScore: true,
        },
      },
    },
    {
      id: "ringEarth",
      label: "Ring Earth",
      sliders: {
        "side-extension-degrees-slider": {
          label: "Side extension",
          min: 0,
          max: 180,
          value: 0,
          step: 1,
          unit: "°",
          scale: "linear",
          updateLongTermScore: true,
        },
        "satellite-count-slider": {
          label: "Satellites",
          min: 0,
          max: 100,
          value: 12,
          step: 1,
          unit: "",
          scale: "linear",
          updateLongTermScore: true,
        },
      },
    },
  ],
};

// Function to map internal slider value to user-facing value for pow2 scale
function mapSliderValueToUserFacing(slider, sliderValue = slider.value) {
  if (slider.scale === "pow2") {
    if (sliderValue === 0) return 0;
    const absValue = Math.abs(sliderValue - 1);
    const result = Math.pow(2, absValue);

    return result * Math.sign(sliderValue);
  } else {
    return sliderValue;
  }
}

// Function to create sliders dynamically with proper min, max, and scale handling
function createSliders() {
  const slidersContainer = document.getElementById("sliders-container");

  for (const section in slidersData) {
    if (section === "rings") {
      // Iterate through each ring
      slidersData.rings.forEach((ring, ringIndex) => {
        // Create a header for each ring
        const ringHeader = document.createElement("h3");
        ringHeader.className = "slider-section-header";
        ringHeader.textContent = ring.label;
        slidersContainer.appendChild(ringHeader);

        for (const sliderId in ring.sliders) {
          const slider = ring.sliders[sliderId];
          const fullSliderId = `${ring.id}-${sliderId}`;

          // Determine min, max, and step
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
          label.setAttribute("for", fullSliderId);
          label.className = "slider-label";
          label.textContent = slider.label;

          // Create slider input
          const input = document.createElement("input");
          input.type = "range";
          input.id = fullSliderId;
          input.className = "slider";
          input.min = min;
          input.max = max;
          input.value = slider.value;
          input.step = step;

          // Create span to display the value
          const valueSpan = document.createElement("span");
          valueSpan.id = `${fullSliderId}-value`;

          // Set initial value display
          let displayValue = mapSliderValueToUserFacing(slider);
          valueSpan.textContent = displayValue + slider.unit;

          // Append label, slider, and value span to the container
          sliderContainer.appendChild(label);
          sliderContainer.appendChild(input);
          sliderContainer.appendChild(valueSpan);

          // Append the container to the sliders container
          slidersContainer.appendChild(sliderContainer);

          // Event listener for slider input changes (live updates)
          input.addEventListener("input", () => {
            let newValue = parseFloat(input.value);
            let displayValue = mapSliderValueToUserFacing(slider, newValue);
            valueSpan.textContent = displayValue + slider.unit;
            updateValues(fullSliderId, newValue);
          });

          // Event listener for slider change (on release)
          if (slider.updateLongTermScore)
            input.addEventListener("change", () => {
              // Recalculate longtermScore and update info
              longtermScore = null;
              updateInfo();
              setTimeout(function () {
                longtermScore = solarSystemScene.calculateLongtermScore();
                updateInfo();
              }, 50);
            });

          // Load value from local storage if available
          if (localStorage.getItem(fullSliderId)) {
            input.value = localStorage.getItem(fullSliderId);
            let storedValue = parseFloat(input.value);
            let storedDisplayValue = mapSliderValueToUserFacing(slider, storedValue);
            valueSpan.textContent = storedDisplayValue + slider.unit;
            slidersData.rings[ringIndex].sliders[sliderId].value = storedValue;
          }
        }
      });
    } else {
      // Handle other sections (sim, costs, capability) as before
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
        let displayValue = mapSliderValueToUserFacing(slider);
        valueSpan.textContent = displayValue + slider.unit;

        // Append label, slider, and value span to the container
        sliderContainer.appendChild(label);
        sliderContainer.appendChild(input);
        sliderContainer.appendChild(valueSpan);

        // Append the container to the sliders container
        slidersContainer.appendChild(sliderContainer);

        // Event listener for slider input changes (live updates)
        input.addEventListener("input", () => {
          let newValue = parseFloat(input.value);
          let displayValue = mapSliderValueToUserFacing(slider, newValue);
          valueSpan.textContent = displayValue + slider.unit;
          updateValues(sliderId, newValue);
        });

        // Event listener for slider change (on release)
        if (slider.updateLongTermScore)
          input.addEventListener("change", async () => {
            // Recalculate longtermScore and update info
            longtermScore = null;
            updateInfo();
            setTimeout(function () {
              longtermScore = solarSystemScene.calculateLongtermScore();
              updateInfo();
            }, 50);
          });

        // Load value from local storage if available
        if (localStorage.getItem(sliderId)) {
          input.value = localStorage.getItem(sliderId);
          let storedValue = parseFloat(input.value);
          let storedDisplayValue = mapSliderValueToUserFacing(slider, storedValue);
          valueSpan.textContent = storedDisplayValue + slider.unit;
          slidersData[section][sliderId].value = storedValue;
        }
      }
    }
  }
}

// Update values based on the slider id, considering non-linear scales
function updateValues(sliderId, value) {
  // Check if the slider is part of a ring
  const ringMatch = sliderId.match(/^(ring\w+)-(.+)$/);
  if (ringMatch) {
    const [, ringId, specificSliderId] = ringMatch;
    const ring = slidersData.rings.find((r) => r.id === ringId);
    if (ring && ring.sliders[specificSliderId]) {
      let newValue = parseFloat(value);

      // Apply mapping to user-facing value if needed
      newValue = mapSliderValueToUserFacing(ring.sliders[specificSliderId], newValue);

      ring.sliders[specificSliderId].value = newValue; // Update slidersData with the new value
      localStorage.setItem(sliderId, value); // Save to local storage

      // Update satellites without recalculating longtermScore
      solarSystemScene.updateSatellites(generateRings(slidersData.sim["failed-satellites-slider"].value));
      updateInfo();
      return;
    }
  }

  // Handle other sliders not part of rings
  for (const section in slidersData) {
    if (section === "rings") continue; // Skip rings as they are handled above

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

        case "failed-satellites-slider":
          solarSystemScene.updateSatellites(generateRings(newValue));
          break;

        case "minimum-rate-mbps-slider":
          solarSystemScene.setMinimumRateMbps(newValue);
          break;

        case "satellite-cost-slider":
          updateInfo();
          break;

        case "launch-cost-slider":
          updateInfo();
          break;

        case "sats-per-launch-slider":
          updateInfo();
          solarSystemScene.updateSatellites(generateRings(slidersData.sim["failed-satellites-slider"].value));
          break;

        default:
          break;
      }
    }
  }
}

function generateRings(failedSatellitesPct) {
  const satellites = slidersData.rings.flatMap((ring) =>
    generateSatellites(
      ring.sliders["satellite-count-slider"].value,
      ring.sliders["distance-sun-slider"] ? ring.sliders["distance-sun-slider"].value : null,
      ring.id,
      ring.id == "ringMars" ? "Mars" : ring.id == "ringEarth" ? "Earth" : "Circular",
      ring.sliders["side-extension-degrees-slider"] ? ring.sliders["side-extension-degrees-slider"].value : null,
      failedSatellitesPct
    )
  );
  return satellites;
}

createSliders();
solarSystemScene = new SolarSystemScene(solarSystemData);
solarSystemScene.updateSatellites(generateRings(slidersData.sim["failed-satellites-slider"].value));
// solarSystemScene.setMaxLinkDistance(mapSliderValueToUserFacing(slidersData.capability["max-link-distance-slider"]));
solarSystemScene.setMinimumRateMbps(mapSliderValueToUserFacing(slidersData.capability["minimum-rate-mbps-slider"]));
solarSystemScene.setTimeAccelerationFactor(mapSliderValueToUserFacing(slidersData.sim["time-acceleration-slider"]));
longtermScore = solarSystemScene.calculateLongtermScore();

export function updateInfo() {
  if (solarSystemScene) {
    const simTime = solarSystemScene.getSimTime();
    document.getElementById("simTime").innerHTML = formatSimTimeToUTC(simTime);
    let launchCounts = [];
    let costTotal = 0;
    for (let ring of slidersData.rings) {
      const sats = ring.sliders["satellite-count-slider"].value;
      const satsPerLaunch = slidersData.capability["sats-per-launch-slider"].value;
      const launchCountRing = Math.ceil(sats / satsPerLaunch);
      const costRing =
        sats * slidersData.costs["satellite-cost-slider"].value + launchCountRing * slidersData.costs["launch-cost-slider"].value;
      launchCounts.push(launchCountRing);
      costTotal += costRing;
    }
    const launchCount = launchCounts.reduce((acc, curr) => acc + curr, 0);
    const totalSatellites = slidersData.rings.reduce((sum, ring) => sum + ring.sliders["satellite-count-slider"].value, 0);
    const marslinkLatencySeconds = auToKm(_3DToAu(solarSystemScene.getShortestPathDistance3D())) / 300000;
    const directLatencySeconds = auToKm(_3DToAu(solarSystemScene.getDirectPathDistance3D())) / 300000;
    const pctLonger = (marslinkLatencySeconds / directLatencySeconds - 1) * 100;
    let html = "";
    if (marslinkLatencySeconds !== Infinity) html += `Marslink latency `;
    html += `${convertSecToText(marslinkLatencySeconds)}`;
    if (marslinkLatencySeconds !== Infinity) html += ` (+${pctLonger.toFixed(0)}%)`;
    html += "<br>";
    html += `${totalSatellites} sats,`;
    html += ` ${launchCount} launch${launchCount > 1 ? "es" : ""} (${launchCounts.join("+")})`;
    html += "<br>";
    html += `Total cost $${formatMillions(costTotal)}`;
    if (longtermScore) {
      html += "<br>";
      html += "<br>";
      html += `<b>10-year analysis</b>`;
      html += "<br>";
      if (longtermScore.disconnectedTimePercent > 0) {
        html += `Disconnected ${longtermScore.disconnectedTimePercent.toFixed(2)}% of time`;
      } else {
        const pctLonger = (longtermScore.averageMarslinkLatencySeconds / longtermScore.averageDirectLatencySeconds - 1) * 100;

        html += `Average latency ${convertSecToText(longtermScore.averageMarslinkLatencySeconds)} (+${pctLonger.toFixed(0)}%)`;
        html += "<br>";
        html += `Score ${((costTotal * longtermScore.averageMarslinkLatencySeconds) / 1000).toFixed(1)} k$.second`;
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
