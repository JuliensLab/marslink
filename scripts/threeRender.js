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
    // Scene setup
    this.scene = new THREE.Scene();

    // Camera setup
    // Create a perspective camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

    // Set the camera position to 45 degrees from the top
    const distance = 140; // Adjust this distance as needed
    const angle = Math.PI / 4; // 45 degrees in radians

    // Calculate x, y, z based on the angle
    this.camera.position.x = distance * Math.cos(angle);
    this.camera.position.y = distance * Math.sin(angle);
    this.camera.position.z = distance * Math.sin(angle);

    // Point the camera towards the origin (0, 0, 0)
    this.camera.lookAt(0, 0, 0);

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true; // Enable shadow maps in the renderer
    document.body.appendChild(this.renderer.domElement);

    // OrbitControls for zoom and rotation
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // Smoothes camera movement

    // Texture Loader
    this.textureLoader = new THREE.TextureLoader();

    // Starry Background
    const starTexture = this.textureLoader.load(this.solarSystemData.background.texturePath);
    const starsGeometry = new THREE.SphereGeometry(
      500, //this.solarSystemData.convertRadius(this.solarSystemData.background.diameterKm / 2),
      64,
      64
    );
    const starsMaterial = new THREE.MeshBasicMaterial({
      map: starTexture,
      side: THREE.BackSide,
      color: 0x444444, // Darker color to reduce brightness
    });
    const starField = new THREE.Mesh(starsGeometry, starsMaterial);
    this.scene.add(starField);

    // Sun
    const sunTexture = this.textureLoader.load(this.solarSystemData.sun.texturePath);
    const sunGeometry = new THREE.SphereGeometry(this.solarSystemData.convertRadius(this.solarSystemData.sun.diameterKm / 2), 32, 32);
    const sunMaterial = new THREE.MeshBasicMaterial({
      map: sunTexture,
      color: 0xffffff, // Ensure the color doesn't tint the texture
    });
    this.sun = new THREE.Mesh(sunGeometry, sunMaterial);
    this.sun.position.set(0, 0, 0);
    this.sun.castShadow = false; // Sun does not need to cast shadows
    this.scene.add(this.sun);

    // Sun As Light Source
    const sunlight = new THREE.PointLight(0xffffff, 20000, 20000); // color, strength, distance
    sunlight.position.set(0, 0, 0);
    sunlight.castShadow = true; // Enable shadow casting from the light
    sunlight.shadow.mapSize.width = 1024; // Shadow map resolution
    sunlight.shadow.mapSize.height = 1024;
    sunlight.shadow.camera.near = 0.5;
    sunlight.shadow.camera.far = 1500;
    this.scene.add(sunlight);

    // Ambient Light (to see planets dark sides too)
    const ambientLight = new THREE.AmbientLight(0x888888); // Dim ambient light
    this.scene.add(ambientLight);

    // Set Up Composer and Bloom Pass
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5, // strength
      0.4, // radius
      0.85 // threshold
    );
    this.composer.addPass(this.bloomPass);

    // Planet function to create planets
    const createPlanet = (planetParams, convertRadius) => {
      const geometry = new THREE.SphereGeometry(convertRadius(planetParams.diameterKm / 2), 32, 32);
      const texture = this.textureLoader.load(planetParams.texturePath);
      const material = new THREE.MeshPhongMaterial({
        map: texture,
        shininess: 10, // Adjust shininess for specular highlights
        specular: new THREE.Color(0x333333),
      });
      const planet = new THREE.Mesh(geometry, material);
      planet.params = planetParams;
      planet.castShadow = true; // Planet casts shadows
      planet.receiveShadow = true; // Planet receives shadows
      return planet;
    };

    for (let planetData of this.solarSystemData.planets) {
      const planet = createPlanet(planetData, this.solarSystemData.convertRadius);
      this.planets.push(planet);
      this.scene.add(planet);
    }

    // Store references to Earth and Mars
    this.earth = this.planets.find((planet) => planet.params.name === "Earth");
    this.mars = this.planets.find((planet) => planet.params.name === "Mars");
  }

  updateSatellites(satellitesData) {
    // Planet function to create planets easily
    const createSatellite = (satelliteParams, convertRadius) => {
      const radius = convertRadius(satelliteParams.diameterKm / 2);
      const geometry = new THREE.CylinderGeometry(radius, radius, radius * 3, 6);

      // Convert the RGB color array to a THREE.Color object
      const colorArray = satelliteParams.color; // [R, G, B] values between 0 and 255
      const color = new THREE.Color(colorArray[0] / 255, colorArray[1] / 255, colorArray[2] / 255);

      const material = new THREE.MeshPhongMaterial({
        color: color, // Set the color of the material          // Set opacity to 50%
        shininess: 10, // Adjust shininess for specular highlights
        specular: new THREE.Color(0x333333),
      });

      const satellite = new THREE.Mesh(geometry, material);
      satellite.params = satelliteParams;
      satellite.castShadow = false; // Planet casts shadows
      satellite.receiveShadow = true; // Planet receives shadows
      return satellite;
    };

    // Check if the satellites array exists and has satellites
    if (this.satellites && this.satellites.length > 0) {
      for (let satellite of this.satellites) {
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
      // Clear the satellites array
      this.satellites.length = 0;
    } else {
      // Initialize the satellites array if it doesn't exist
      this.satellites = [];
    }

    for (let satData of satellitesData) {
      const satellite = createSatellite(satData, this.solarSystemData.convertRadius);
      this.satellites.push(satellite);
      this.scene.add(satellite);
    }
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
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
    // Nodes: Earth, Mars, satellites
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
          let posA, posB;

          if (nodeA === "Earth") {
            posA = this.earth.position;
          } else if (nodeA === "Mars") {
            posA = this.mars.position;
          } else {
            const satA = this.satellites.find((sat) => sat.nodeName === nodeA);
            posA = satA.position;
          }

          if (nodeB === "Earth") {
            posB = this.earth.position;
          } else if (nodeB === "Mars") {
            posB = this.mars.position;
          } else {
            const satB = this.satellites.find((sat) => sat.nodeName === nodeB);
            posB = satB.position;
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
    // Use this.connections to build the graph for Dijkstra's algorithm
    const nodes = Object.keys(this.connections);
    const edges = this.connections;

    // Now, implement Dijkstra's algorithm
    const shortestDistances = {};
    const visited = {};
    const previousNodes = {};

    // Initialize distances
    nodes.forEach((node) => {
      shortestDistances[node] = Infinity;
      visited[node] = false;
      previousNodes[node] = null;
    });
    shortestDistances["Earth"] = 0;

    while (true) {
      // Find the unvisited node with the smallest distance
      let closestNode = null;
      let closestDistance = Infinity;
      nodes.forEach((node) => {
        if (!visited[node] && shortestDistances[node] < closestDistance) {
          closestDistance = shortestDistances[node];
          closestNode = node;
        }
      });

      if (closestNode === null || closestNode === "Mars") {
        break;
      }

      visited[closestNode] = true;

      // Update distances to neighboring nodes
      const neighbors = edges[closestNode];
      for (let neighbor in neighbors) {
        if (!visited[neighbor]) {
          const tentativeDistance = shortestDistances[closestNode] + neighbors[neighbor];
          if (tentativeDistance < shortestDistances[neighbor]) {
            shortestDistances[neighbor] = tentativeDistance;
            previousNodes[neighbor] = closestNode;
          }
        }
      }
    }

    // Retrieve the shortest path
    const path = [];
    let currentNode = "Mars";
    while (currentNode !== null) {
      path.unshift(currentNode);
      currentNode = previousNodes[currentNode];
    }

    // Calculate the total distance
    const totalDistance = shortestDistances["Mars"];

    // Store the total distance
    this.shortestPathDistance3D = totalDistance;
    return path;
  }

  drawShortestPath(path, edges) {
    // Remove old shortest path lines
    if (this.shortestPathLines) {
      this.shortestPathLines.forEach((line) => {
        this.scene.remove(line);
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
      });
    }
    this.shortestPathLines = [];

    // Draw new lines for the shortest path
    for (let i = 0; i < path.length - 1; i++) {
      const nodeA = path[i];
      const nodeB = path[i + 1];

      let posA, posB;

      if (nodeA === "Earth") {
        posA = this.earth.position;
      } else if (nodeA === "Mars") {
        posA = this.mars.position;
      } else {
        const satA = this.satellites.find((sat) => sat.nodeName === nodeA);
        posA = satA.position;
      }

      if (nodeB === "Earth") {
        posB = this.earth.position;
      } else if (nodeB === "Mars") {
        posB = this.mars.position;
      } else {
        const satB = this.satellites.find((sat) => sat.nodeName === nodeB);
        posB = satB.position;
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
        color: this.styles.links.active.color,
        transparent: true,
        opacity: this.styles.links.active.opacity,
      });
      const line = new THREE.Line(geometry, material);
      this.scene.add(line);
      this.shortestPathLines.push(line);
    }
  }

  setTimeAccelerationFactor(factor) {
    this.timeAccelerationFactor = factor;
  }

  setMaxLinkDistance(maxLinkDistanceAu) {
    this.maxLinkDistance3D = auTo3D(maxLinkDistanceAu);
  }

  // Add a method to get the shortest path distance
  getShortestPathDistance3D() {
    return this.shortestPathDistance3D;
  }

  // Add a method to get the shortest path distance
  getDirectPathDistance3D() {
    return this.directPathDistance3D;
  }

  getSimTime() {
    return this.simTime;
  }
}
