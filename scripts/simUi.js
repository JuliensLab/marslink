// simUi.js
import { slidersData } from "./slidersData.js?v=4.3";

export class SimUi {
  constructor(simMain) {
    this.simMain = simMain;
    this.slidersData = slidersData;
    this.sliders = {};

    this.createSliders();
    this.initializeSimMain();

    // Remove unwanted buttons if they exist
    const longTermButton = document.getElementById("startLongTermRun");
    if (longTermButton) longTermButton.remove();

    const scenariosButton = document.getElementById("startLongTermScenariosRun");
    if (scenariosButton) scenariosButton.remove();

    this.setupFullRunButton();
  }

  initializeSimMain() {
    const timeAccelerationSlider = this.slidersData.simulation["time-acceleration-slider"];
    const timeAccelerationValue = this.mapSliderValueToUserFacing(timeAccelerationSlider, timeAccelerationSlider.value);
    this.simMain.setTimeAccelerationFactor(timeAccelerationValue);
    this.simMain.setCosts(this.getGroupsConfig(["economics"]));
    this.simMain.setSatellitesConfig(
      this.getGroupsConfig(["economics", "simulation", "laser_technology", "ring_mars", "circular_rings", "eccentric_rings", "ring_earth"])
    );
    console.log(
      "Initial satellitesConfig set, improvement-factor:",
      this.simMain.satellitesConfig ? this.simMain.satellitesConfig["laser_technology.improvement-factor"] : "not set yet"
    );
    // Set the initial display type
    const linksColors = this.slidersData.simulation["links-colors"].value;
    this.simMain.setLinksColors(linksColors);
    const displayType = this.slidersData.simulation["display-type"].value;
    this.simMain.setDisplayType(displayType);

    // Add a report button (adjust container as per your UI structure)
    const reportButton = document.createElement("button");
    reportButton.textContent = "Deployment Report";
    reportButton.classList = "large-button";
    reportButton.addEventListener("click", () => {
      this.simMain.generateReport();
    });
    document.getElementById("generateReportDiv").appendChild(reportButton); // Or append to a specific container

    // Add collapsible input area
    const collapsibleContainer = document.createElement("div");
    collapsibleContainer.style.marginTop = "10px";

    const collapsibleHeader = document.createElement("div");
    collapsibleHeader.style.cursor = "pointer";
    collapsibleHeader.style.display = "flex";
    collapsibleHeader.style.alignItems = "center";
    collapsibleHeader.innerHTML = '<span id="arrow">▶</span> <span>Full Run Parameters</span>';

    const collapsibleContent = document.createElement("div");
    collapsibleContent.style.display = "none";
    collapsibleContent.style.marginTop = "10px";

    // Load saved parameters from localStorage or use defaults
    const savedImprovementScores = localStorage.getItem("fullRunImprovementScores") || "256,512,1024";
    const savedDates = localStorage.getItem("fullRunDates") || "2034-08-19,2027-02-19";
    const savedRingCounts = localStorage.getItem("fullRunRingCounts") || "2,3,4,5,6";
    const savedMbps = localStorage.getItem("fullRunMbps") || "25,50,100";

    collapsibleContent.innerHTML = `
       <div style="margin-bottom: 10px;">
        <label>Improvement Scores (comma-separated): </label>
        <input type="text" id="fullRunImprovementScores" value="${savedImprovementScores}" style="width: 300px;">
      </div>
      <div style="margin-bottom: 10px;">
        <label>Dates (yyyy-mm-dd, comma-separated): </label>
        <input type="text" id="fullRunDates" value="${savedDates}" style="width: 300px;">
      </div>
      <div style="margin-bottom: 10px;">
        <label>Ring Counts (comma-separated): </label>
        <input type="text" id="fullRunRingCounts" value="${savedRingCounts}" style="width: 300px;">
      </div>
      <div style="margin-bottom: 10px;">
        <label>In-ring Mbps (comma-separated): </label>
        <input type="text" id="fullRunMbps" value="${savedMbps}" style="width: 300px;">
      </div>
    
    `;

    collapsibleHeader.addEventListener("click", () => {
      const arrow = document.getElementById("arrow");
      if (collapsibleContent.style.display === "none") {
        collapsibleContent.style.display = "block";
        arrow.textContent = "▼";
      } else {
        collapsibleContent.style.display = "none";
        arrow.textContent = "▶";
      }
    });

    collapsibleContainer.appendChild(collapsibleHeader);
    collapsibleContainer.appendChild(collapsibleContent);

    document.getElementById("generateReportDiv").appendChild(collapsibleContainer);

    // Add event listeners to save parameters on input change
    const saveParameters = () => {
      const datesInput = document.getElementById("fullRunDates").value;
      const ringCountsInput = document.getElementById("fullRunRingCounts").value;
      const mbpsInput = document.getElementById("fullRunMbps").value;
      const improvementScoresInput = document.getElementById("fullRunImprovementScores").value;

      localStorage.setItem("fullRunDates", datesInput);
      localStorage.setItem("fullRunRingCounts", ringCountsInput);
      localStorage.setItem("fullRunMbps", mbpsInput);
      localStorage.setItem("fullRunImprovementScores", improvementScoresInput);
    };

    // Save on blur (when user clicks away) and Enter key press
    ["fullRunDates", "fullRunRingCounts", "fullRunMbps", "fullRunImprovementScores"].forEach((id) => {
      const input = document.getElementById(id);
      input.addEventListener("blur", saveParameters);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          saveParameters();
        }
      });
    });

    // Add the Full Run button
    const fullRunButton = document.createElement("button");
    fullRunButton.textContent = "Start Full Run";
    fullRunButton.id = "startFullRun";
    fullRunButton.classList = "large-button";
    document.getElementById("generateReportDiv").appendChild(fullRunButton);
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
   * Sets up the Start Full Run button with its event listener.
   */
  setupFullRunButton() {
    const startButton = document.getElementById("startFullRun");
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
          // Get input values
          const datesInput = document.getElementById("fullRunDates").value;
          const dates = datesInput.split(",").map((d) => d.trim());

          const ringCountsInput = document.getElementById("fullRunRingCounts").value;
          const ringCounts = ringCountsInput.split(",").map((r) => parseInt(r.trim()));

          const mbpsInput = document.getElementById("fullRunMbps").value;
          const throughputs = mbpsInput.split(",").map((m) => parseInt(m.trim()));

          const improvementScoresInput = document.getElementById("fullRunImprovementScores").value;
          const improvementScores = improvementScoresInput.split(",").map((s) => parseFloat(s.trim()));

          // Calculate total number of scenarios for progress tracking
          const totalScenarios = dates.length * ringCounts.length * throughputs.length * improvementScores.length;
          let completedScenarios = 0;

          // Get base configuration (excluding overridden parameters)
          const baseConfig = this.getGroupsConfig([
            "economics",
            "simulation",
            "laser_technology",
            "ring_mars",
            "circular_rings",
            "eccentric_rings",
            "ring_earth",
          ]);

          // Remove parameters that are overridden by the simulation
          delete baseConfig["circular_rings.ringcount"];
          delete baseConfig["circular_rings.requiredmbpsbetweensats"];
          delete baseConfig["eccentric_rings.ringcount"];
          delete baseConfig["simulation.calctimeSec"];
          delete baseConfig["laser_technology.improvement-factor"];

          // Initialize satellitesConfig
          const satellitesConfig = this.getGroupsConfig([
            "economics",
            "simulation",
            "laser_technology",
            "ring_mars",
            "circular_rings",
            "eccentric_rings",
            "ring_earth",
          ]);

          const resultArray = [];

          // Iterate over each combination of improvementScore, ringCount, throughput, and date
          for (const improvementScore of improvementScores) {
            for (const ringCount of ringCounts) {
              for (const throughput of throughputs) {
                for (const date of dates) {
                  // Update satellitesConfig with current scenario parameters
                  satellitesConfig["circular_rings.ringcount"] = ringCount;
                  satellitesConfig["circular_rings.requiredmbpsbetweensats"] = throughput;
                  satellitesConfig["eccentric_rings.ringcount"] = 0;
                  satellitesConfig["simulation.calctimeSec"] = 100; // No limit
                  satellitesConfig["laser_technology.improvement-factor"] = Math.log2(improvementScore);
                  console.log(
                    "Setting improvement-factor in full run:",
                    satellitesConfig["laser_technology.improvement-factor"],
                    "for improvementScore:",
                    improvementScore
                  );
                  console.log("////", "improvementScore", improvementScore, satellitesConfig["laser_technology.improvement-factor"]);
                  console.log("Running simulation with config:", satellitesConfig);

                  // Set simTime to the date for deployment
                  const originalSimTime = this.simMain.simTime.getDate();
                  const targetDate = new Date(date);
                  this.simMain.simTime.simMsSinceStart = targetDate.getTime() - this.simMain.simTime.initDate.getTime();
                  this.simMain.simTime.previousRealMs = performance.now();

                  // Apply the new satellites configuration
                  this.simMain.setSatellitesConfig(satellitesConfig);

                  // Run the simulation for the specific date
                  const result = await this.simMain.longTermRun({ from: date, to: date, stepDays: 1 });

                  // Restore original simTime and update display
                  this.simMain.simTime.simMsSinceStart = originalSimTime.getTime() - this.simMain.simTime.initDate.getTime();
                  this.simMain.simTime.previousRealMs = performance.now();
                  this.simMain.updateLoop();

                  result.scenario = { date, ringCount, throughputMbps: throughput, improvementScore };
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
            }
          }

          const data = { config: baseConfig, results: resultArray };

          // Store data in localStorage for the results page
          localStorage.setItem("marslinkFullRunResults", JSON.stringify(data));
          console.log("Full Run Simulation Result:", data);

          // Open the results webpage
          window.open("results/fullrun/index.html");
        } catch (error) {
          console.error("Error during full run simulation:", error);
          summaryContainer.textContent = "An error occurred during the simulation.";
        } finally {
          // Re-enable the button after completion
          startButton.disabled = false;
          startButton.textContent = "Start Full Run";
        }
      });
    } else {
      console.error("Start Full Run button or summary container not found.");
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
      return Math.pow(2, sliderValue);
    } else if (slider.scale === "pow10") {
      return Math.pow(10, sliderValue);
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
          if (slider.min < 0) {
            const steps = slider.steps || 101;
            min = -Math.floor(steps / 2);
            max = Math.floor(steps / 2);
          } else {
            // use the min max from data
            min = slider.min;
            max = slider.max;
          }
          step = 1;
        } else if (slider.scale === "pow10") {
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
        let validSavedValue = savedValue;
        if (savedValue !== null) {
          if (slider.type === "select" || slider.type === "dropdown" || slider.type === "radio") {
            if (!slider.options || !slider.options.includes(savedValue)) {
              validSavedValue = null;
            }
          } else {
            const num = parseFloat(savedValue);
            if (isNaN(num)) {
              validSavedValue = null;
            } else if (slider.scale === "pow2" || slider.scale === "pow10") {
              if (!Number.isInteger(num) || num < min || num > max) {
                validSavedValue = null;
              }
            } else {
              if (num < min || num > max) {
                validSavedValue = null;
              }
            }
          }
          if (validSavedValue === null && fullSliderId === "laser_technology.improvement-factor") {
            console.log("Invalid saved value for improvement-factor:", savedValue, "resetting to default");
          }
        }
        let sliderValue =
          validSavedValue !== null
            ? slider.type === "select" || slider.type === "dropdown" || slider.type === "radio"
              ? validSavedValue
              : parseFloat(validSavedValue)
            : slider.value;

        if (fullSliderId === "laser_technology.improvement-factor") {
          console.log(
            "Creating slider for improvement-factor, savedValue:",
            savedValue,
            "validSavedValue:",
            validSavedValue,
            "sliderValue:",
            sliderValue,
            "slider.value from data:",
            slider.value
          );
        }

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
          if (fullSliderId === "simulation.calctimeSec") {
            // For calctimeSec, update display on input, but update value only on change (release)
            input.addEventListener("input", () => {
              let newValue = parseFloat(input.value);
              let displayValue = this.mapSliderValueToUserFacing(slider, newValue);
              valueSpan.textContent = this.formatNumber(displayValue) + slider.unit;
            });
            input.addEventListener("change", () => {
              let newValue = parseFloat(input.value);
              this.updateValues(fullSliderId, newValue);
            });
          } else {
            input.addEventListener("input", () => {
              let newValue = parseFloat(input.value);
              let displayValue = this.mapSliderValueToUserFacing(slider, newValue);
              valueSpan.textContent = this.formatNumber(displayValue) + slider.unit;
              this.updateValues(fullSliderId, newValue);
            });
          }
        }

        slider.value =
          slider.type === "select" || slider.type === "dropdown" || slider.type === "radio" ? sliderValue : parseFloat(sliderValue);

        if (fullSliderId === "laser_technology.improvement-factor") {
          console.log("After setting slider.value for improvement-factor:", slider.value);
        }
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
        case "simulation.links-colors":
          this.simMain.setLinksColors(newValue);
          break;
        case "simulation.time-acceleration-slider":
          this.simMain.setTimeAccelerationFactor(newValue);
          break;
        case "simulation.sun-size-factor":
          this.simMain.setSunSizeFactor(newValue);
          break;
        case "simulation.planets-size-factor":
          this.simMain.setPlanetsSizeFactor(newValue);
          break;

        case "laser_technology.current-throughput-gbps":
        case "laser_technology.current-distance-km":
        case "laser_technology.improvement-factor":
          if (sliderId === "laser_technology.improvement-factor") {
            console.log("Dispatching update for improvement-factor, newValue:", newValue);
          }
        case "laser_technology.laser-ports-per-satellite":
        case "economics.satellite-empty-mass":
        case "laser_technology.laser-terminal-mass":
        case "simulation.maxDistanceAU":
        case "simulation.maxSatCount":
        case "simulation.calctimeSec":
        case "simulation.failed-satellites-slider":
        case "ring_mars.match-circular-rings":
        case "ring_mars.side-extension-degrees-slider":
        case "ring_mars.requiredmbpsbetweensats":
        case "circular_rings.ringcount":
        case "circular_rings.requiredmbpsbetweensats":
        case "circular_rings.distance-sun-slider-outer-au":
        case "circular_rings.distance-sun-slider-inner-au":
        case "circular_rings.inring-interring-bias-pct":
        case "circular_rings.earth-mars-orbit-inclination-pct":
        case "eccentric_rings.ringcount":
        case "eccentric_rings.requiredmbpsbetweensats":
        case "eccentric_rings.distance-sun-average-au":
        case "eccentric_rings.eccentricity":
        case "eccentric_rings.argument-of-perihelion":
        case "eccentric_rings.earth-mars-orbit-inclination-pct":
        case "ring_earth.match-circular-rings":
        case "ring_earth.side-extension-degrees-slider":
        case "ring_earth.requiredmbpsbetweensats":
          this.simMain.setSatellitesConfig(
            this.getGroupsConfig([
              "economics",
              "simulation",
              "laser_technology",
              "ring_mars",
              "circular_rings",
              "eccentric_rings",
              "ring_earth",
            ])
          );
          break;

        case "economics.satellite-cost-slider":
        case "economics.launch-cost-slider":
        case "economics.laser-terminal-cost-slider":
        case "economics.satellite-empty-mass":
          this.simMain.setCosts(this.getGroupsConfig(["economics"]));
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
        // Safely access the value, defaulting to sliderData.value if undefined
        const value =
          this.sliders?.[categoryKey]?.[sliderKey]?.value !== undefined ? this.sliders[categoryKey][sliderKey].value : sliderData.value;

        if (categoryKey === "laser_technology" && sliderKey === "improvement-factor") {
          console.log(
            "Getting config for improvement-factor, value:",
            value,
            "from sliders:",
            this.sliders?.[categoryKey]?.[sliderKey]?.value,
            "from data:",
            sliderData.value
          );
        }

        // Check the type from slidersData to determine how to handle the value
        if (sliderData.type === "radio" || typeof sliderData.value === "string") {
          // Keep strings as strings
          config[`${categoryKey}.${sliderKey}`] = value;
        } else if (typeof sliderData.value === "boolean") {
          // Keep booleans as booleans
          config[`${categoryKey}.${sliderKey}`] = value;
        } else {
          // Parse numbers as float
          config[`${categoryKey}.${sliderKey}`] = parseFloat(value);
        }
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
    const arrows = ["capacity", "cost"];
    for (const arrow of arrows) {
      const capacityArrow = document.getElementById(`${arrow}-arrow`);
      if (capacityArrow) {
        const capacityContent = document.getElementById(`${arrow}-content`);
        capacityArrow.parentElement.addEventListener("click", () => {
          if (capacityContent.style.display === "none") {
            capacityContent.style.display = "block";
            capacityArrow.textContent = "▼";
          } else {
            capacityContent.style.display = "none";
            capacityArrow.textContent = "▶";
          }
        });
      }
    }
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
