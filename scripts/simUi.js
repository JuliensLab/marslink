// simUi.js

import { slidersData } from "./slidersData.js?v=2.3";

export class SimUi {
  constructor(simMain) {
    this.simMain = simMain;
    this.slidersData = slidersData;
    this.sliders = {}; // To store references to slider elements

    // Create sliders and set up event listeners
    this.createSliders();

    // Initialize simMain with initial slider values
    this.initializeSimMain();
  }

  /**
   * Initializes simMain with the current slider values.
   */
  initializeSimMain() {
    // Set time acceleration factor
    const timeAccelerationSlider = this.slidersData.simulation["time-acceleration-slider"];
    const timeAccelerationValue = this.mapSliderValueToUserFacing(timeAccelerationSlider, timeAccelerationSlider.value);
    this.simMain.setTimeAccelerationFactor(timeAccelerationValue);
    this.simMain.setCosts(this.getGroupsConfig(["costs"]));
    this.simMain.setSatellitesConfig(
      this.getGroupsConfig([
        "capability",
        "simulation",
        "current_technology_performance",
        "technology_improvement",
        "ring_mars",
        "circular_rings",
        "eccentric_rings",
        "ring_earth",
      ])
    );
  }

  /**
   * Maps internal slider value to user-facing value, considering the scale (linear or pow2).
   * @param {Object} slider - The slider configuration object.
   * @param {number} [sliderValue=slider.value] - The internal value of the slider.
   * @returns {number} - The mapped user-facing value.
   */
  mapSliderValueToUserFacing(slider, sliderValue = slider.value) {
    if (slider.scale === "pow2") {
      if (sliderValue === 0) return 0;
      const absValue = Math.abs(sliderValue - 1);
      const result = Math.pow(2, absValue);
      return result * Math.sign(sliderValue);
    } else {
      return sliderValue;
    }
  }

  /**
   * Formats a number into a shorter string with K, M, B suffixes.
   * @param {number} num - The number to format.
   * @returns {string} - The formatted number as a string.
   */
  formatNumber(num) {
    const absNum = Math.abs(num);
    if (absNum >= 1.0e9) {
      // Billion
      return (num / 1.0e9).toFixed(1) + "B";
    } else if (absNum >= 1.0e6) {
      // Million
      return (num / 1.0e6).toFixed(1) + "M";
    } else if (absNum >= 1.0e3) {
      // Thousand
      return (num / 1.0e3).toFixed(1) + "K";
    } else {
      // Less than thousand
      return num.toString();
    }
  }

  formatSimTimeToUTC(simTime) {
    // Create a Date object using the simulated Unix time
    const simDate = new Date(simTime);

    // Format the date to a readable string in UTC
    const formattedDate = simDate.toISOString().replace("T", " ").slice(0, 19) + " UTC";

    return formattedDate;
  }

  /**
   * Creates sliders based on the slidersData configuration.
   * Sets up event listeners to handle user input and dispatch actions to simMain.
   */
  createSliders() {
    const slidersContainer = document.getElementById("sliders-container");

    // Iterate through each section in slidersData
    for (const section in this.slidersData) {
      // Handle other sections (simulation, costs, capability)
      const sectionHeader = document.createElement("h3");
      sectionHeader.className = "slider-section-header";
      sectionHeader.textContent =
        section
          .replace(/_/g, " ") // Replace underscores with spaces
          .charAt(0)
          .toUpperCase() + section.replace(/_/g, " ").slice(1);
      slidersContainer.appendChild(sectionHeader);

      const sectionContent = document.createElement("div");
      sectionContent.className = "slider-section-content";
      slidersContainer.appendChild(sectionContent);

      // Initialize storage for section sliders
      this.sliders[section] = {};

      for (const sliderId in this.slidersData[section]) {
        const slider = this.slidersData[section][sliderId];
        const fullSliderId = `${section}.${sliderId}`;

        // Determine min, max, and step
        let min = slider.min;
        let max = slider.max;
        let step = slider.step;

        if (slider.scale === "pow2") {
          const steps = slider.steps || 101;
          if (slider.min < 0 && slider.max > 0) {
            min = -Math.floor(steps / 2);
            max = Math.floor(steps / 2);
          } else if (slider.min >= 0) {
            min = 0;
            max = steps - 1;
          }
          step = 1;
        }

        // Retrieve saved value from localStorage if available
        const savedValue = localStorage.getItem(fullSliderId);
        let sliderValue = savedValue !== null ? parseFloat(savedValue) : slider.value;

        // Create slider elements
        const sliderContainer = document.createElement("div");
        sliderContainer.className = "slider-container";

        const label = document.createElement("label");
        label.setAttribute("for", fullSliderId);
        label.className = "slider-label";
        label.textContent = slider.label;

        const input = document.createElement("input");
        input.type = "range";
        input.id = fullSliderId;
        input.className = "slider";
        input.min = min;
        input.max = max;
        input.value = sliderValue;
        input.step = step;

        const valueSpan = document.createElement("span");
        valueSpan.id = `${fullSliderId}-value`;

        // Set initial value display
        let displayValue = this.mapSliderValueToUserFacing(slider, sliderValue);
        valueSpan.textContent = this.formatNumber(displayValue) + slider.unit;

        // Append elements
        sliderContainer.appendChild(label);
        sliderContainer.appendChild(input);
        sliderContainer.appendChild(valueSpan);
        sectionContent.appendChild(sliderContainer);

        // Store slider reference
        this.sliders[section][sliderId] = input;

        // Event listener for slider input changes
        input.addEventListener("input", () => {
          let newValue = parseFloat(input.value);
          let displayValue = this.mapSliderValueToUserFacing(slider, newValue);
          valueSpan.textContent = this.formatNumber(displayValue) + slider.unit;
          this.updateValues(fullSliderId, newValue);
        });

        // Update slidersData with the initial value
        slider.value = parseFloat(sliderValue);
      }
    }

    // Optional: Add event listeners to toggle sections
    const headers = document.querySelectorAll(".slider-section-header");
    headers.forEach((header) => {
      header.addEventListener("click", () => {
        const content = header.nextElementSibling;
        if (content.classList.contains("active")) {
          content.classList.remove("active");
        } else {
          // Close all other sections
          document.querySelectorAll(".slider-section-content.active").forEach((activeContent) => {
            activeContent.classList.remove("active");
          });
          // Open the clicked section
          content.classList.add("active");
        }
      });
    });
  }

  /**
   * Updates internal values based on slider input and dispatches actions to simMain.
   * @param {string} sliderId - The unique ID of the slider.
   * @param {number} value - The internal slider value from the input element.
   */
  updateValues(sliderId, value) {
    // Save the new internal value to localStorage
    localStorage.setItem(sliderId, value);

    // Handle other sliders not part of rings
    const [section, specificSliderId] = sliderId.split(".");
    if (this.slidersData[section] && this.slidersData[section][specificSliderId]) {
      const slider = this.slidersData[section][specificSliderId];
      let newValue = parseFloat(value); // Internal value

      // Map to user-facing value
      newValue = this.mapSliderValueToUserFacing(slider, newValue);

      // Update slidersData with the new user-facing value
      slider.value = newValue;

      // Dispatch actions based on slider ID
      switch (sliderId) {
        case "simulation.time-acceleration-slider":
          this.simMain.setTimeAccelerationFactor(newValue);
          break;

        case "current_technology_performance.current-throughput-gbps":
        case "current_technology_performance.current-distance-km":
        case "technology_improvement.telescope-diameter-m":
        case "technology_improvement.receiver-sensitivity-improvement":
        case "technology_improvement.transmitter-power-improvement":
        case "technology_improvement.modulation-improvement":
        case "capability.laser-ports-per-satellite":
        case "simulation.maxDistanceAU":
        case "simulation.calctimeMs":
        case "simulation.failed-satellites-slider":
        case "ring_mars.side-extension-degrees-slider":
        case "ring_mars.satellite-count-slider":
        case "circular_rings.ringcount":
        case "circular_rings.requiredmbpsbetweensats":
        case "circular_rings.distance-sun-slider-outer-au":
        case "circular_rings.distance-sun-slider-inner-au":
        case "circular_rings.earth-mars-orbit-inclination-pct":
        case "eccentric_rings.ringcount":
        case "eccentric_rings.requiredmbpsbetweensats":
        case "eccentric_rings.distance-sun-average-au":
        case "eccentric_rings.eccentricity":
        case "eccentric_rings.argument-of-perihelion":
        case "eccentric_rings.earth-mars-orbit-inclination-pct":
        case "ring_earth.side-extension-degrees-slider":
        case "ring_earth.satellite-count-slider":
          this.simMain.setSatellitesConfig(
            this.getGroupsConfig([
              "capability",
              "simulation",
              "current_technology_performance",
              "technology_improvement",
              "ring_mars",
              "circular_rings",
              "eccentric_rings",
              "ring_earth",
            ])
          );
          break;

        case "costs.satellite-cost-slider":
        case "costs.launch-cost-slider":
        case "costs.sats-per-launch-slider":
          this.simMain.setCosts(this.getGroupsConfig(["costs"]));

        // Add other cases as needed
        default:
          break;
      }
    }
  }

  getGroupsConfig(categoryKeys) {
    const config = [];
    for (const categoryKey of categoryKeys) {
      const group = this.slidersData[categoryKey];
      for (const [sliderKey, sliderData] of Object.entries(group)) {
        config[`${categoryKey}.${sliderKey}`] = this.slidersData[categoryKey][sliderKey]?.value;
      }
    }
    return config;
  }

  updateSimTime(simTime) {
    const utcTime = this.formatSimTimeToUTC(simTime);
    document.getElementById("simTime").innerHTML = utcTime;
  }

  updateInfoArea(info) {
    document.getElementById("info-area-data").innerHTML = info;
  }
}
