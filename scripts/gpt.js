import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { helioCoords, auTo3D, distance3D } from "./orbitals.js";

import { updateInfo } from "./main.js";

export class SolarSystemScene {
  constructor(solarSystemData) {
    // Properties
    this.solarSystemData = solarSystemData;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.textureLoader = null;
    this.sun = null;
    this.planets = [];
    this.satellites = [];
    this.l1Satellites = []; // Add this line to store L1 satellites
    this.linesToEarth = [];
    this.linesToMars = [];
    this.composer = null;
    this.bloomPass = null;
    this.lastUpdateTime = Date.now(); // Initialize last update time
    this.simTime = Date.now(); // Initialize program start time
    this.timeAccelerationFactor = 0; // Acceleration factor x100
    this.maxLinkDistance3D = 1;
    // Initialize the connections data structure
    this.connections = {};
    this.styles = { links: { connected: { opacity: 0.2, color: 0xffbbbb }, active: { opacity: 1.0, color: 0xff0000 } } };

    // Initialize the scene
    this.loadScene();

    // Handle window resize
    window.addEventListener("resize", this.onWindowResize.bind(this), false);

    // Start the animation loop
    this.animate();
  }

  loadScene() {
    // ... [Existing code remains unchanged]

    // Store references to Earth and Mars
    this.earth = this.planets.find((planet) => planet.params.name === "Earth");
    this.mars = this.planets.find((planet) => planet.params.name === "Mars");
  }

  updateSatellites(satellitesData) {
    // ... [Existing code remains unchanged]
  }

  onWindowResize() {
    // ... [Existing code remains unchanged]
  }

  animate() {
    requestAnimationFrame(this.animate.bind(this));

    // Calculate elapsed time since last frame
    const currentTime = Date.now(); // Current Unix time in milliseconds
    const elapsedMilliseconds = (currentTime - this.lastUpdateTime) * this.timeAccelerationFactor;
    const elapsedSecondsSinceLastUpdate = elapsedMilliseconds / 1000;
    this.lastUpdateTime = currentTime;

    // Update total elapsed simulation time
    this.simTime += elapsedMilliseconds;
    const totalElapsedDays = this.simTime / (1000 * 60 * 60 * 24);

    const dOfs = totalElapsedDays; // Days offset since program start

    // Rotate the sun
    this.sun.rotation.y += (elapsedSecondsSinceLastUpdate / (this.solarSystemData.sun.rotationHours * 60 * 60)) * 2 * Math.PI;

    // Rotate planets and satellites
    this.planets.forEach((planet) => this.updateObjectPosition(planet, dOfs, elapsedSecondsSinceLastUpdate));
    this.satellites.forEach((satellite) => this.updateObjectPosition(satellite, dOfs, elapsedSecondsSinceLastUpdate));

    // Update L1 satellites
    this.l1Satellites.forEach((satellite) => this.updateL1SatellitePosition(satellite, dOfs));

    // Update connections and draw them
    this.updateConnections();
    this.drawConnections();
    const shortestPath = this.calculateShortestPath();
    this.drawShortestPath(shortestPath);
    this.directPathDistance3D = distance3D(this.earth.position, this.mars.position);

    this.controls.update();
    this.composer.render();
    this.renderer.render(this.scene, this.camera);
    updateInfo();
  }

  updateObjectPosition(object, dOfs, elapsedSecondsSinceLastUpdate) {
    const xyz = helioCoords(object.params, dOfs);
    object.position.x = auTo3D(xyz.x);
    object.position.y = auTo3D(xyz.z);
    object.position.z = -auTo3D(xyz.y);

    // object rotation
    object.rotation.y += (elapsedSecondsSinceLastUpdate / (object.params.rotationHours * 60 * 60)) * 2 * Math.PI;
  }

  updateConnections() {
    // Build the connections between nodes based on maxLinkDistance3D
    // Nodes: Earth, Mars, satellites, L1 satellites
    // Store the connections and distances

    const nodes = []; // node names
    const positions = {}; // node positions
    const connections = {}; // adjacency list with distances

    // Add Earth and Mars
    nodes.push("Earth");
    positions["Earth"] = this.earth.position.clone();
    nodes.push("Mars");
    positions["Mars"] = this.mars.position.clone();

    // Add satellites
    this.satellites.forEach((satellite, index) => {
      satellite.nodeName = `Satellite${index}`;
      nodes.push(satellite.nodeName);
      positions[satellite.nodeName] = satellite.position.clone();
    });

    // Add L1 satellites
    this.l1Satellites.forEach((satellite) => {
      nodes.push(satellite.nodeName);
      positions[satellite.nodeName] = satellite.position.clone();
    });

    // Initialize connections
    nodes.forEach((node) => {
      connections[node] = {};
    });

    // For each pair of nodes, if distance <= maxLinkDistance3D, add connection
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeA = nodes[i];
        const nodeB = nodes[j];
        const posA = positions[nodeA];
        const posB = positions[nodeB];
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const dz = posA.z - posB.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance <= this.maxLinkDistance3D) {
          connections[nodeA][nodeB] = distance;
          connections[nodeB][nodeA] = distance; // undirected
        }
      }
    }

    // Store connections
    this.connections = connections;
  }

  drawConnections() {
    // Remove old lines
    if (this.allLines) {
      this.allLines.forEach((line) => {
        this.scene.remove(line);
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
      });
    }
    this.allLines = [];

    // Draw lines based on connections
    for (let nodeA in this.connections) {
      for (let nodeB in this.connections[nodeA]) {
        // To avoid duplicate lines, ensure nodeA < nodeB
        if (nodeA < nodeB) {
          const posA = this.getNodePosition(nodeA);
          const posB = this.getNodePosition(nodeB);
          if (!posA || !posB) {
            continue; // skip if positions not found
          }

          const geometry = new THREE.BufferGeometry();
          const positions = new Float32Array(6); // 2 points x 3 coordinates
          positions[0] = posA.x;
          positions[1] = posA.y;
          positions[2] = posA.z;
          positions[3] = posB.x;
          positions[4] = posB.y;
          positions[5] = posB.z;
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          const material = new THREE.LineBasicMaterial({
            color: this.styles.links.connected.color,
            transparent: true,
            opacity: this.styles.links.connected.opacity,
          });
          const line = new THREE.Line(geometry, material);
          this.scene.add(line);
          this.allLines.push(line);
        }
      }
    }
  }

  calculateShortestPath() {
    // ... [Existing code remains unchanged]
  }

  drawShortestPath(path) {
    // ... [Existing code remains unchanged, but use getNodePosition method]
  }

  getNodePosition(nodeName) {
    if (nodeName === "Earth") {
      return this.earth.position;
    } else if (nodeName === "Mars") {
      return this.mars.position;
    } else {
      const sat = this.satellites.find((sat) => sat.nodeName === nodeName);
      if (sat) {
        return sat.position;
      } else {
        const l1Sat = this.l1Satellites.find((sat) => sat.nodeName === nodeName);
        if (l1Sat) {
          return l1Sat.position;
        }
      }
    }
    return null;
  }

  setTimeAccelerationFactor(factor) {
    this.timeAccelerationFactor = factor;
  }

  setMaxLinkDistance(maxLinkDistanceAu) {
    this.maxLinkDistance3D = auTo3D(maxLinkDistanceAu);
  }

  setL1SatsCount(countByPlanet) {
    this.countByPlanet = countByPlanet;
    this.setL1Sats();
  }

  setL1Sats() {
    // Remove existing L1 satellites from the scene
    if (this.l1Satellites && this.l1Satellites.length > 0) {
      for (let satellite of this.l1Satellites) {
        // Remove the satellite from the scene
        this.scene.remove(satellite);

        // Dispose of the satellite's geometry and material to free up memory
        if (satellite.geometry) satellite.geometry.dispose();
        if (satellite.material) {
          // If the material has a map (texture), dispose of it as well
          if (satellite.material.map) satellite.material.map.dispose();
          satellite.material.dispose();
        }
      }
      // Clear the l1Satellites array
      this.l1Satellites.length = 0;
    } else {
      // Initialize the l1Satellites array if it doesn't exist
      this.l1Satellites = [];
    }

    // For each planet in countByPlanet
    for (let planetName in this.countByPlanet) {
      const count = this.countByPlanet[planetName];
      const planet = this.getPlanet(planetName);
      if (!planet) {
        console.warn(`Planet ${planetName} not found.`);
        continue;
      }

      // Ensure planet position is up to date
      const dOfs = this.simTime / (1000 * 60 * 60 * 24); // totalElapsedDays
      this.updateObjectPosition(planet, dOfs, 0);

      // Get planet position
      const planetPos = planet.position.clone();

      // Vector from planet to sun (which is at (0,0,0))
      const sunPos = new THREE.Vector3(0, 0, 0);
      const planetToSun = sunPos.clone().sub(planetPos);

      // Normalize the vector
      const unitVector = planetToSun.clone().normalize();

      // Distance from planet to L1 point
      const dAU = 0.01; // Approximate distance from planet to L1 point
      const d3D = auTo3D(dAU);

      // L1 position
      const l1Pos = planetPos.clone().add(unitVector.clone().multiplyScalar(d3D));

      // For count satellites, distribute them around the L1 point
      for (let i = 0; i < count; i++) {
        // Calculate offset if count > 1
        let offset = new THREE.Vector3(0, 0, 0);
        if (count > 1) {
          const angle = (i / count) * 2 * Math.PI;
          const radius = auTo3D(0.001); // small radius around L1 point
          // Create a perpendicular vector
          const axis = new THREE.Vector3(0, 1, 0); // arbitrary axis
          if (axis.dot(unitVector) > 0.99) {
            // If unitVector is parallel to axis, choose another axis
            axis.set(1, 0, 0);
          }
          const perpVector = unitVector.clone().cross(axis).normalize();
          offset = perpVector.clone().applyAxisAngle(unitVector, angle).multiplyScalar(radius);
        }

        // Create satellite at satellitePos
        const satelliteParams = {
          diameterKm: 100,
          color: [255, 255, 0], // yellow
          name: `${planetName}_L1_Satellite${i}`,
          rotationHours: 24, // arbitrary rotation period
        };
        const satellitePos = l1Pos.clone().add(offset);
        const satellite = this.createSatelliteAtPosition(satellitePos, satelliteParams);
        satellite.offset = offset;
        satellite.associatedPlanet = planet;
        satellite.nodeName = satelliteParams.name;
        satellite.params = satelliteParams;
        this.l1Satellites.push(satellite);
        this.scene.add(satellite);
      }
    }
  }

  updateL1SatellitePosition(satellite, dOfs) {
    const planet = satellite.associatedPlanet;
    // Ensure planet position is up to date
    this.updateObjectPosition(planet, dOfs, 0);
    // Get planet position
    const planetPos = planet.position.clone();
    // Vector from planet to sun
    const sunPos = new THREE.Vector3(0, 0, 0);
    const planetToSun = sunPos.clone().sub(planetPos);
    const unitVector = planetToSun.clone().normalize();
    // Distance from planet to L1 point
    const dAU = 0.01;
    const d3D = auTo3D(dAU);
    // L1 position
    const l1Pos = planetPos.clone().add(unitVector.clone().multiplyScalar(d3D));

    // Apply the offset if any
    let satellitePos = l1Pos.clone();
    if (satellite.offset) {
      satellitePos.add(satellite.offset);
    }
    satellite.position.copy(satellitePos);

    // Rotate satellite if needed
    const elapsedSecondsSinceLastUpdate = (this.lastUpdateTime - this.simTime) / 1000;
    satellite.rotation.y += (elapsedSecondsSinceLastUpdate / (satellite.params.rotationHours * 60 * 60)) * 2 * Math.PI;
  }

  createSatelliteAtPosition(position, satelliteParams) {
    const radius = this.solarSystemData.convertRadius(satelliteParams.diameterKm / 2);
    const geometry = new THREE.CylinderGeometry(radius, radius, radius * 3, 6);

    // Convert the RGB color array to a THREE.Color object
    const colorArray = satelliteParams.color; // [R, G, B] values between 0 and 255
    const color = new THREE.Color(colorArray[0] / 255, colorArray[1] / 255, colorArray[2] / 255);

    const material = new THREE.MeshPhongMaterial({
      color: color,
      shininess: 10,
      specular: new THREE.Color(0x333333),
    });

    const satellite = new THREE.Mesh(geometry, material);
    satellite.position.copy(position);
    satellite.params = satelliteParams;
    satellite.castShadow = false;
    satellite.receiveShadow = true;
    return satellite;
  }

  getPlanet(planetName) {
    return this.planets.find((planet) => planet.params.name === planetName);
  }

  // ... [Other existing methods remain unchanged]

  // Add methods to get distances
  getShortestPathDistance3D() {
    return this.shortestPathDistance3D;
  }

  getDirectPathDistance3D() {
    return this.directPathDistance3D;
  }

  getSimTime() {
    return this.simTime;
  }
}
