// simUi.js
import { slidersData } from "./slidersData.js?v=2.4";

export class SimUi {
  constructor(simMain) {
    this.simMain = simMain;
    this.slidersData = slidersData;
    this.sliders = {};

    this.createSliders();
    this.initializeSimMain();

    this.setupLongTermRunButton();
    this.setupLongTermScenariosRunButton();
  }

  initializeSimMain() {
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
    // Set the initial display type
    const displayType = this.slidersData.simulation["display-type"].value;
    this.simMain.setDisplayType(displayType);

    // Add a report button (adjust container as per your UI structure)
    const reportButton = document.createElement("button");
    reportButton.textContent = "Generate Report";
    reportButton.addEventListener("click", () => {
      this.simMain.generateReport();
    });
    document.getElementById("generateReportDiv").appendChild(reportButton); // Or append to a specific container
  }

  saveToJson(object, fileName) {
    // Convert the object to JSON
    const jsonString = JSON.stringify(object, null, 2);

    // Create a Blob with the JSON content
    const blob = new Blob([jsonString], { type: "application/json" });

    // Create a link element
    const link = document.createElement("a");

    // Set the download attribute with a filename
    link.download = `${fileName}.json`;

    // Create a URL for the Blob and set it as the href
    link.href = URL.createObjectURL(blob);

    // Append the link to the document (this is required for some browsers)
    document.body.appendChild(link);

    // Programmatically click the link to trigger the download
    link.click();

    // Remove the link from the document
    document.body.removeChild(link);
  }

  /**
   * Sets up the Start Long-Term Run button with its event listener.
   */
  setupLongTermRunButton() {
    const startButton = document.getElementById("startLongTermRun");
    const summaryContainer = document.getElementById("long-term-summary-run-text");
    const progressBar = document.getElementById("progress-bar-run"); // Ensure you have a progress bar in your HTML
    const progressText = document.getElementById("progress-text-run"); // And a progress text element

    if (startButton && summaryContainer && progressBar && progressText) {
      startButton.addEventListener("click", async () => {
        // Disable the button to prevent multiple clicks
        startButton.disabled = true;
        startButton.textContent = "Running...";
        progressBar.style.width = "0%";
        progressText.textContent = "Progress: 0%";

        try {
          // Define the simulation dates
          const dates = { from: "2025-01-01", to: "2026-01-01", stepDays: 30 };

          // Run the long-term simulation and await its completion
          const simulationResult = await this.simMain.longTermRun(dates);

          console.log("Long-Term Simulation Result:", simulationResult);
          this.saveToJson(simulationResult, "SimulationResult");

          // Helper function to round numbers to a specified precision
          function rnd(number, precision) {
            const factor = Math.pow(10, precision);
            return Math.round(number * factor) / factor;
          }

          // Display the summary in the UI
          let html = "<h3>Long-Term Run Summary:</h3>";
          html += `${simulationResult.dataSummary.dayCount} samples, every ${simulationResult.dates.stepDays} days`;
          html += "<br>";
          html += `from ${simulationResult.dates.from} to ${simulationResult.dates.to}`;
          html += "<br>";
          html += `Latency avg of avg: ${rnd(simulationResult.dataSummary.avgLatencyMinutes.avg, 1)} minutes`;
          html += "<br>";
          html += `Latency avg of best: ${rnd(simulationResult.dataSummary.bestLatencyMinutes.avg, 1)} minutes`;
          html += "<br>";
          html += `Throughput avg: ${rnd(simulationResult.dataSummary.maxFlowGbps.avg * 1000, 0)} mbps`;
          html += "<br>";
          html += `Throughput worst: ${rnd(simulationResult.dataSummary.maxFlowGbps.min * 1000, 0)} mbps`;

          summaryContainer.innerHTML = html;
        } catch (error) {
          console.error("Error during long-term simulation:", error);
          summaryContainer.textContent = "An error occurred during the simulation.";
        } finally {
          // Re-enable the button after completion
          startButton.disabled = false;
          startButton.textContent = "Start Long-Term Run";
        }
      });
    } else {
      console.error("Start Long-Term Run button or summary container not found.");
    }
  }

  /**
   * Sets up the Start Long-Term Scenarios Run button with its event listener.
   */
  setupLongTermScenariosRunButton() {
    const startButton = document.getElementById("startLongTermScenariosRun");
    const summaryContainer = document.getElementById("long-term-summary-run-text");
    const progressBar = document.getElementById("progress-bar-run"); // Ensure you have a progress bar in your HTML
    const progressText = document.getElementById("progress-text-run"); // And a progress text element

    if (startButton && summaryContainer && progressBar && progressText) {
      startButton.addEventListener("click", async () => {
        // Disable the button to prevent multiple clicks
        startButton.disabled = true;
        startButton.textContent = "Running...";
        progressBar.style.width = "0%";
        progressText.textContent = "Progress: 0%";

        try {
          // Define the simulation dates
          const dates = { from: "2025-01-01", to: "2030-01-01", stepDays: 30 };

          // Define the input ranges for scenarios
          const circularRingsCountInputs = { from: 1, to: 6, step: 1 };
          const circularRingsMbpsInputs = { from: 1, to: 310, step: 50 };

          // Calculate total number of scenarios for progress tracking
          const totalScenarios =
            Math.ceil((circularRingsCountInputs.to - circularRingsCountInputs.from) / circularRingsCountInputs.step + 1) *
            Math.ceil((circularRingsMbpsInputs.to - circularRingsMbpsInputs.from) / circularRingsMbpsInputs.step + 1);
          let completedScenarios = 0;

          // Initialize satellitesConfig
          const satellitesConfig = this.getGroupsConfig([
            "capability",
            "simulation",
            "current_technology_performance",
            "technology_improvement",
            "ring_mars",
            "circular_rings",
            "eccentric_rings",
            "ring_earth",
          ]);

          const resultArray = [];

          // Iterate over each combination of circularRingsCount and circularRingsMbps
          for (
            let circularRingsCount = circularRingsCountInputs.from;
            circularRingsCount <= circularRingsCountInputs.to;
            circularRingsCount += circularRingsCountInputs.step
          ) {
            for (
              let circularRingsMbps = circularRingsMbpsInputs.from;
              circularRingsMbps <= circularRingsMbpsInputs.to;
              circularRingsMbps += circularRingsMbpsInputs.step
            ) {
              // Update satellitesConfig with current scenario parameters
              satellitesConfig["circular_rings.ringcount"] = circularRingsCount;
              satellitesConfig["circular_rings.requiredmbpsbetweensats"] = circularRingsMbps;

              // Apply the new satellites configuration
              this.simMain.setSatellitesConfig(satellitesConfig);

              // Run the long-term simulation and await its completion
              const result = await this.simMain.longTermRun(dates, (progress) => {
                // Optionally, you can update scenario-specific progress here
                // For simplicity, we're tracking overall scenario progress
              });

              result.satellitesConfig = JSON.parse(JSON.stringify(satellitesConfig));
              // Push the result to the resultArray
              resultArray.push(result);

              // Update progress
              completedScenarios++;
              const overallProgress = completedScenarios / totalScenarios;
              const percent = Math.round(overallProgress * 100);
              progressBar.style.width = `${percent}%`;
              progressText.textContent = `Progress: ${percent}%`;
            }
          }

          console.log("Long-Term Scenarios Simulation Result:", resultArray);
          this.saveToJson(resultArray, "SimulationScenariosResult");

          // Helper function to round numbers to a specified precision
          function rnd(number, precision) {
            const factor = Math.pow(10, precision);
            return Math.round(number * factor) / factor;
          }

          // Generate a summary for all scenarios
          let html = "<h3>Scenarios Run Summary:</h3>";
          html += `<p>Total Scenarios: ${resultArray.length}</p>`;

          // Optionally, iterate over each result and display individual summaries
          resultArray.forEach((simulationResult, index) => {
            html += `<h4>Scenario ${index + 1}:</h4>`;
            html += `<p>Rings Count: ${simulationResult.dates.stepDays}</p>`; // Adjust as needed
            html += `${simulationResult.dataSummary.dayCount} samples, every ${simulationResult.dates.stepDays} days`;
            html += "<br>";
            html += `From ${simulationResult.dates.from} to ${simulationResult.dates.to}`;
            html += "<br>";
            html += `Latency avg of avg: ${rnd(simulationResult.dataSummary.avgLatencyMinutes.avg, 1)} minutes`;
            html += "<br>";
            html += `Latency avg of best: ${rnd(simulationResult.dataSummary.bestLatencyMinutes.avg, 1)} minutes`;
            html += "<br>";
            html += `Throughput avg: ${rnd(simulationResult.dataSummary.maxFlowGbps.avg * 1000, 0)} mbps`;
            html += "<br>";
            html += `Throughput worst: ${rnd(simulationResult.dataSummary.maxFlowGbps.min * 1000, 0)} mbps`;
            html += "<br><br>";
          });

          summaryContainer.innerHTML = html;
        } catch (error) {
          console.error("Error during long-term scenarios simulation:", error);
          summaryContainer.textContent = "An error occurred during the simulation.";
        } finally {
          // Re-enable the button after completion
          startButton.disabled = false;
          startButton.textContent = "Start Scenarios Run";
        }
      });
    } else {
      console.error("Start Scenarios Run button, summary container, or progress elements not found.");
    }
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

    for (const section in this.slidersData) {
      const sectionHeader = document.createElement("h3");
      sectionHeader.className = "slider-section-header";
      sectionHeader.textContent = section.replace(/_/g, " ").charAt(0).toUpperCase() + section.replace(/_/g, " ").slice(1);
      slidersContainer.appendChild(sectionHeader);

      const sectionContent = document.createElement("div");
      sectionContent.className = "slider-section-content";
      slidersContainer.appendChild(sectionContent);

      this.sliders[section] = {};

      for (const sliderId in this.slidersData[section]) {
        const slider = this.slidersData[section][sliderId];
        const fullSliderId = `${section}.${sliderId}`;

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

        const savedValue = localStorage.getItem(fullSliderId);
        let sliderValue =
          savedValue !== null
            ? slider.type === "select" || slider.type === "dropdown" || slider.type === "radio"
              ? savedValue
              : parseFloat(savedValue)
            : slider.value;

        const sliderContainer = document.createElement("div");
        sliderContainer.className = "slider-container";

        const label = document.createElement("label");
        label.setAttribute("for", fullSliderId);
        label.className = "slider-label";
        label.textContent = slider.label;

        let input;
        let displayValue;

        if (slider.type === "select" || slider.type === "dropdown") {
          input = document.createElement("select");
          input.id = fullSliderId;
          input.className = "slider";
          for (const option of slider.options) {
            const optionElem = document.createElement("option");
            optionElem.value = option;
            optionElem.textContent = option;
            if (option === sliderValue) {
              optionElem.selected = true;
            }
            input.appendChild(optionElem);
          }
          displayValue = sliderValue;
        } else if (slider.type === "radio") {
          const radioContainer = document.createElement("div");
          radioContainer.className = "radio-container";
          slider.options.forEach((option) => {
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = fullSliderId;
            radio.value = option;
            radio.id = `${fullSliderId}-${option}`;
            if (option === sliderValue) {
              radio.checked = true;
            }
            const radioLabel = document.createElement("label");
            radioLabel.setAttribute("for", radio.id);
            radioLabel.textContent = option;
            radioContainer.appendChild(radio);
            radioContainer.appendChild(radioLabel);

            radio.addEventListener("change", () => {
              if (radio.checked) {
                const newValue = radio.value;
                // No valueSpan to update for "radio"
                this.updateValues(fullSliderId, newValue);
              }
            });
          });
          input = radioContainer;
          // Do not set displayValue for "radio"
        } else {
          input = document.createElement("input");
          input.type = "range";
          input.id = fullSliderId;
          input.className = "slider";
          input.min = min;
          input.max = max;
          input.step = step;
          input.value = sliderValue;
          displayValue = this.mapSliderValueToUserFacing(slider, sliderValue);
        }

        // Create valueSpan only if the slider type is not "radio"
        let valueSpan;
        if (slider.type !== "radio") {
          valueSpan = document.createElement("span");
          valueSpan.id = `${fullSliderId}-value`;
          if (slider.type === "select" || slider.type === "dropdown") {
            valueSpan.textContent = displayValue + slider.unit;
          } else {
            valueSpan.textContent = this.formatNumber(displayValue) + slider.unit;
          }
        }

        // Append elements to the slider container
        sliderContainer.appendChild(label);
        sliderContainer.appendChild(input);
        if (slider.type !== "radio") {
          sliderContainer.appendChild(valueSpan);
        }
        sectionContent.appendChild(sliderContainer);

        this.sliders[section][sliderId] = input;

        if (slider.type === "select" || slider.type === "dropdown") {
          input.addEventListener("change", () => {
            const newValue = input.value;
            valueSpan.textContent = newValue + slider.unit;
            this.updateValues(fullSliderId, newValue);
          });
        } else if (slider.type !== "radio") {
          input.addEventListener("input", () => {
            let newValue = parseFloat(input.value);
            let displayValue = this.mapSliderValueToUserFacing(slider, newValue);
            valueSpan.textContent = this.formatNumber(displayValue) + slider.unit;
            this.updateValues(fullSliderId, newValue);
          });
        }

        slider.value =
          slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" ? sliderValue : parseFloat(sliderValue);
      }
    }

    // Add section toggle event listeners
    const headers = document.querySelectorAll(".slider-section-header");
    headers.forEach((header) => {
      header.addEventListener("click", () => {
        const content = header.nextElementSibling;
        if (content.classList.contains("active")) {
          content.classList.remove("active");
        } else {
          document.querySelectorAll(".slider-section-content.active").forEach((activeContent) => {
            activeContent.classList.remove("active");
          });
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

    const [section, specificSliderId] = sliderId.split(".");
    if (this.slidersData[section] && this.slidersData[section][specificSliderId]) {
      const slider = this.slidersData[section][specificSliderId];
      let newValue = slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" ? value : parseFloat(value);

      if (!(slider.type === "select" || slider.type === "dropdown" || slider.type === "radio")) {
        newValue = this.mapSliderValueToUserFacing(slider, newValue);
      }
      slider.value = newValue;

      // Dispatch actions based on slider ID
      switch (sliderId) {
        case "simulation.display-type":
          this.simMain.setDisplayType(newValue);
          break;
        case "simulation.time-acceleration-slider":
          this.simMain.setTimeAccelerationFactor(newValue);
          break;

        case "current_technology_performance.current-throughput-gbps":
        case "current_technology_performance.current-distance-km":
        case "technology_improvement.telescope-diameter-m":
        case "technology_improvement.receiver-sensitivity-improvement":
        case "technology_improvement.transmitter-power-improvement":
        case "technology_improvement.efficiency-improvement":
        case "capability.laser-ports-per-satellite":
        case "simulation.maxDistanceAU":
        case "simulation.calctimeMs":
        case "simulation.failed-satellites-slider":
        case "ring_mars.side-extension-degrees-slider":
        case "ring_mars.requiredmbpsbetweensats":
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
        case "ring_earth.requiredmbpsbetweensats":
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
          break;

        default:
          break;
      }
    }
  }

  getGroupsConfig(categoryKeys) {
    const config = {};
    for (const categoryKey of categoryKeys) {
      const group = this.slidersData[categoryKey];
      for (const [sliderKey, sliderData] of Object.entries(group)) {
        config[`${categoryKey}.${sliderKey}`] = this.sliders[categoryKey][sliderKey]
          ? parseFloat(this.sliders[categoryKey][sliderKey].value)
          : sliderData.value;
      }
    }
    return config;
  }

  updateSimTime(simTime) {
    const utcTime = this.formatSimTimeToUTC(simTime);
    document.getElementById("simTime").innerHTML = utcTime;
  }

  updateInfoAreaData(html) {
    document.getElementById("info-area-data").innerHTML = html;
  }

  updateInfoAreaCosts(html) {
    document.getElementById("info-area-costs").innerHTML = html;
  }

  /**
   * Updates the long-term run summary in the UI.
   * @param {Object} summary - The summarized simulation data.
   */
  updateLongTermSummary(summary) {
    const summaryContainer = document.getElementById("long-term-summary");
    if (summaryContainer) {
      summaryContainer.textContent = JSON.stringify(summary, null, 2);
    }
  }
}
