import { solarSystemData } from "./solarSystem.js";
import { SolarSystemScene } from "./threeRender.js";
import { generateSatellites } from "./satellites.js";
import { _3DToAu, auToKm } from "./orbitals.js";

let solarSystemScene;

const timeAccelerationSlider = document.getElementById("time-acceleration-slider");
const satelliteCountSlider = document.getElementById("satellite-count-slider");
const satelliteDistanceSunSlider = document.getElementById("satellite-distance-sun-slider");
const maxLinkDistanceSlider = document.getElementById("max-link-distance-slider");
const satelliteCostSlider = document.getElementById("satellite-cost-slider");

// Load values from local storage and set sliders
if (localStorage.getItem("timeAccelerationFactor")) {
  timeAccelerationSlider.value = localStorage.getItem("timeAccelerationFactor");
}

if (localStorage.getItem("satCount")) {
  satelliteCountSlider.value = localStorage.getItem("satCount");
}

if (localStorage.getItem("satDistanceSun")) {
  satelliteDistanceSunSlider.value = localStorage.getItem("satDistanceSun");
}

if (localStorage.getItem("maxLinkDistance")) {
  maxLinkDistanceSlider.value = localStorage.getItem("maxLinkDistance");
}

if (localStorage.getItem("satelliteCost")) {
  satelliteCostSlider.value = localStorage.getItem("satelliteCost");
}

// Initialize time acceleration factor and satellite count
let timeAccelerationFactor = updateTimeAccelerationFactor();
let satCount = updateSatCount();
let satDistanceSun = updateSatDistanceSun();
let maxLinkDistance = updateMaxLinkDistance();
let satelliteCost = updateSatelliteCost();

// Instantiate the SolarSystemScene with solarSystemData
solarSystemScene = new SolarSystemScene(solarSystemData);
solarSystemScene.setTimeAccelerationFactor(timeAccelerationFactor);
solarSystemScene.updateSatellites(generateSatellites(satCount, satDistanceSun));
solarSystemScene.setMaxLinkDistance(maxLinkDistance);

timeAccelerationSlider.addEventListener("input", (event) => {
  timeAccelerationFactor = updateTimeAccelerationFactor();
  solarSystemScene.setTimeAccelerationFactor(timeAccelerationFactor);
});

satelliteCountSlider.addEventListener("input", (event) => {
  satCount = updateSatCount();
  solarSystemScene.updateSatellites(generateSatellites(satCount, satDistanceSun));
});

satelliteDistanceSunSlider.addEventListener("input", (event) => {
  satDistanceSun = updateSatDistanceSun();
  solarSystemScene.updateSatellites(generateSatellites(satCount, satDistanceSun));
});

maxLinkDistanceSlider.addEventListener("input", (event) => {
  maxLinkDistance = updateMaxLinkDistance();
  solarSystemScene.setMaxLinkDistance(maxLinkDistance);
});

satelliteCostSlider.addEventListener("input", (event) => {
  satelliteCost = updateSatelliteCost();
});

function updateTimeAccelerationFactor() {
  const timeAccelerationValue = document.getElementById("time-acceleration-value");
  let timeAccelerationFactor = parseInt(timeAccelerationSlider.value);
  timeAccelerationValue.textContent = timeAccelerationFactor + "x";
  // Save to local storage
  localStorage.setItem("timeAccelerationFactor", timeAccelerationFactor);
  return timeAccelerationFactor;
}

function updateSatCount() {
  const satelliteCountValue = document.getElementById("satellite-count-value");
  let satCount = parseInt(satelliteCountSlider.value);
  satelliteCountValue.textContent = satCount;
  // Save to local storage
  localStorage.setItem("satCount", satCount);
  return satCount;
}

function updateSatDistanceSun() {
  const satelliteDistanceSunValue = document.getElementById("satellite-distance-sun-value");
  let satelliteDistanceSun = parseFloat(satelliteDistanceSunSlider.value);
  satelliteDistanceSunValue.textContent = satelliteDistanceSun;
  // Save to local storage
  localStorage.setItem("satDistanceSun", satelliteDistanceSun);
  return satelliteDistanceSun;
}

function updateMaxLinkDistance() {
  const maxLinkDistanceValue = document.getElementById("max-link-distance-value");
  let maxLinkDistance = parseFloat(maxLinkDistanceSlider.value);
  maxLinkDistanceValue.textContent = maxLinkDistance;
  // Save to local storage
  localStorage.setItem("maxLinkDistance", maxLinkDistance);
  return maxLinkDistance;
}

function updateSatelliteCost() {
  const satelliteCostValue = document.getElementById("satellite-cost-value");
  const satelliteCost = parseFloat(satelliteCostSlider.value);
  satelliteCostValue.textContent = `$${Math.round(satelliteCost / 1) * 1}m`;
  localStorage.setItem("satelliteCost", satelliteCost);
  return satelliteCost;
}

export function updateInfoArea() {
  if (solarSystemScene) {
    let html = "";
    html += `Earth-Mars latency: ${convertSecToText(Math.round(auToKm(_3DToAu(solarSystemScene.getShortestPathDistance())) / 300000))}`;
    html += "<br>";
    html += `Total cost $${Math.round((satelliteCost * satCount) / 1) * 1}m`;
    document.getElementById("info-area").innerHTML = html;
  }
}

function convertSecToText(seconds) {
  if (seconds === Infinity) return "No link";
  let minutes = Math.floor(seconds / 60);
  let remainingSeconds = seconds % 60;

  let text = `${minutes}m ${remainingSeconds}s`;
  return text;
}
