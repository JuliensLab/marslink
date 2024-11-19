import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { helioCoords, auTo3D, distance3D, _3DToAu, auToKm } from "./orbitals.js";
import { calculateDatarate } from "./linkBudget.js";

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
    this.composer = null;
    this.bloomPass = null;
    this.lastUpdateTime = Date.now(); // Initialize last update time
    this.simTime = Date.now(); // Initialize program start time
    this.timeAccelerationFactor = 0; // Acceleration factor x100
    this.maxLinkDistance3D = 1;
    this.minimumRateMbps = 4; // Initialize minimumRateMbps

    // Initialize the connections data structure
    this.connections = {};
    this.styles = {
      links: {
        connected: { opacity: 0.2, color: 0xffbbbb },
        low_latency: { opacity: 1.0, color: 0xff0000 },
        high_throughput: { opacity: 1.0, color: 0x00ff00 },
      },
    };

    // Initialize line segments
    this.connectionLines = null;
    this.shortestPathLines = null;

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

    // Initialize LineSegments for connections
    const connectionGeometry = new THREE.BufferGeometry();
    connectionGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));

    const connectionMaterial = new THREE.LineBasicMaterial({
      color: this.styles.links.connected.color,
      transparent: true,
      opacity: this.styles.links.connected.opacity,
    });

    this.connectionLines = new THREE.LineSegments(connectionGeometry, connectionMaterial);
    this.scene.add(this.connectionLines);

    // Initialize LineSegments for shortest path
    const shortestPathGeometry = new THREE.BufferGeometry();
    shortestPathGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));

    const shortestPathMaterial = new THREE.LineBasicMaterial({
      // color: this.styles.links.active.color,
      transparent: true,
      // opacity: this.styles.links.active.opacity,
    });

    this.shortestPathLines = new THREE.LineSegments(shortestPathGeometry, shortestPathMaterial);
    this.scene.add(this.shortestPathLines);
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
        color: color, // Set the color of the material
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
      satellite.nodeName = `Satellite${this.satellites.length}`; // Assign a unique name
      this.satellites.push(satellite);
      this.scene.add(satellite);
    }
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Also update composer and bloom pass if needed
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.bloomPass.setSize(window.innerWidth, window.innerHeight);
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
    this.planets.forEach((planet) => this.updateObjectPosition(planet, dOfs, elapsedSecondsSinceLastUpdate, true));
    this.satellites.forEach((satellite) => this.updateObjectPosition(satellite, dOfs, elapsedSecondsSinceLastUpdate, true));

    // Update connections and draw them
    this.updateConnections();
    this.drawConnections(); // Use instanced lines

    const shortestPaths = this.calculateShortestPath();
    // this.drawShortestPath(shortestPaths.shortestPath.path, "low_latency"); // Use instanced lines
    this.drawShortestPath(shortestPaths.pathOfShortestLinks.path, "high_throughput"); // Use instanced lines
    this.shortestPathDistance3D = shortestPaths.shortestPath.distance3D;
    this.directPathDistance3D = distance3D(this.earth.position, this.mars.position);

    this.controls.update();
    this.composer.render();
    this.renderer.render(this.scene, this.camera);
    updateInfo();
  }

  calculateLongtermScore() {
    const years = 10;
    const daysPerYear = 365;
    let totalDays = years * daysPerYear;

    const scores = [];

    // Reset simulation time
    let simTime = 0;

    for (let day = 1; day <= totalDays; day++) {
      // Simulate one day in milliseconds
      const millisecondsPerDay = 24 * 60 * 60 * 1000;
      const elapsedSeconds = millisecondsPerDay / 1000;

      // Update simulation time
      simTime += millisecondsPerDay;

      // Calculate total elapsed days
      const totalElapsedDays = simTime / (1000 * 60 * 60 * 24);

      // Update positions of planets and satellites
      this.planets.forEach((planet) => this.updateObjectPosition(planet, totalElapsedDays, elapsedSeconds));
      this.satellites.forEach((satellite) => this.updateObjectPosition(satellite, totalElapsedDays, elapsedSeconds));

      // Update network connections
      this.updateConnections();

      // Calculate shortest path
      const shortestPathDistance3D = this.calculateShortestPath().shortestPath.distance3D;

      // Calculate direct path distance between Earth and Mars
      const directPathDistance3D = distance3D(this.earth.position, this.mars.position);

      // Collect scores
      scores.push({
        day,
        shortestPathDistance3D,
        directPathDistance3D,
      });
    }

    // Initialize accumulators
    let totalMarslinkLatencySec = 0; // Total latency in seconds for connected days
    let totalDirectLatencySec = 0; // Total latency in seconds for connected days
    let connectedDays = 0; // Number of days with a valid connection
    let disconnectedDays = 0; // Number of days without a connection

    // Iterate through each day's score
    for (let score of scores) {
      if (score.shortestPathDistance3D === Infinity) {
        // Day is disconnected
        disconnectedDays += 1;
      } else if (disconnectedDays == 0) {
        // Day is connected; calculate latency

        // Convert 3D distance to Astronomical Units (AU)
        const marslinkDistanceAu = _3DToAu(score.shortestPathDistance3D);
        const directDistanceAu = _3DToAu(score.directPathDistance3D);

        // Convert AU to kilometers (km)
        const marslinkDistanceKm = auToKm(marslinkDistanceAu);
        const directDistanceKm = auToKm(directDistanceAu);

        // Calculate one-way latency in seconds
        const marslinkLatencySec = marslinkDistanceKm / 300000; // Speed of light ~300,000 km/s
        const directLatencySec = directDistanceKm / 300000; // Speed of light ~300,000 km/s

        // Accumulate the total latency and increment connected days
        totalMarslinkLatencySec += marslinkLatencySec;
        totalDirectLatencySec += directLatencySec;
        connectedDays += 1;
      }
    }

    // Total number of days in the simulation
    totalDays = scores.length;

    // Calculate average latency (only for connected days)
    let averageMarslinkLatencySeconds = connectedDays > 0 ? totalMarslinkLatencySec / connectedDays : 0;
    let averageDirectLatencySeconds = connectedDays > 0 ? totalDirectLatencySec / connectedDays : 0;

    // Calculate disconnected time percentage
    let disconnectedTimePercent = (disconnectedDays / totalDays) * 100;

    // Round the results for better readability (optional)
    averageMarslinkLatencySeconds = Math.round(averageMarslinkLatencySeconds * 100) / 100; // Rounded to 2 decimal places
    averageDirectLatencySeconds = Math.round(averageDirectLatencySeconds * 100) / 100; // Rounded to 2 decimal places
    disconnectedTimePercent = Math.round(disconnectedTimePercent * 100) / 100; // Rounded to 2 decimal places
    return { averageMarslinkLatencySeconds, averageDirectLatencySeconds, disconnectedTimePercent };
  }

  updateObjectPosition(object, dOfs, elapsedSecondsSinceLastUpdate, rotate) {
    const xyz = helioCoords(object.params, dOfs);
    object.position.x = auTo3D(xyz.x);
    object.position.y = auTo3D(xyz.z);
    object.position.z = -auTo3D(xyz.y);

    // object rotation
    if (rotate && object.params.rotationHours) {
      object.rotation.y += (elapsedSecondsSinceLastUpdate / (object.params.rotationHours * 60 * 60)) * 2 * Math.PI;
    }
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
      const nodeName = satellite.nodeName || `Satellite${index}`;
      satellite.nodeName = nodeName; // Ensure nodeName is set
      nodes.push(nodeName);
      positions[nodeName] = satellite.position.clone();
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
        const distance3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const distanceAu = _3DToAu(distance3D);
        const distanceKm = auToKm(distanceAu);
        const nominalRateTbps = 100000;
        const nominalRateMbps = nominalRateTbps * 1000 * 1000;
        const nominalDistanceKm = 1000;
        const rateMbps = calculateDatarate(nominalRateMbps, nominalDistanceKm, distanceKm);
        const minimumRateMbps = this.minimumRateMbps;

        if (rateMbps >= minimumRateMbps) {
          connections[nodeA][nodeB] = distance3D;
          connections[nodeB][nodeA] = distance3D; // undirected
        }
      }
    }

    // Store connections
    this.connections = connections;
  }

  drawConnections() {
    const positions = [];

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
            posA = satA ? satA.position : null;
          }

          if (nodeB === "Earth") {
            posB = this.earth.position;
          } else if (nodeB === "Mars") {
            posB = this.mars.position;
          } else {
            const satB = this.satellites.find((sat) => sat.nodeName === nodeB);
            posB = satB ? satB.position : null;
          }

          if (posA && posB) {
            positions.push(posA.x, posA.y, posA.z);
            positions.push(posB.x, posB.y, posB.z);
          }
        }
      }
    }

    // Update the BufferGeometry
    const positionAttribute = this.connectionLines.geometry.attributes.position;

    if (positions.length !== positionAttribute.count * 3) {
      // If the number of vertices has changed, set a new buffer
      this.connectionLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    } else {
      // Otherwise, update the existing buffer
      positionAttribute.array = new Float32Array(positions);
      positionAttribute.needsUpdate = true;
    }

    // Optionally, adjust the opacity or other material properties if needed
    this.connectionLines.material.opacity = this.styles.links.connected.opacity;
    this.connectionLines.material.color.setHex(this.styles.links.connected.color);
  }

  calculateShortestPath() {
    // Use this.connections to build the graph for Dijkstra's algorithm
    const nodes = Object.keys(this.connections);
    const edges = this.connections;

    // Helper function to perform Dijkstra's algorithm for total distance
    const findShortestTotalDistance = () => {
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

      return { path, distance3D: totalDistance };
    };

    // Helper function to perform Modified Dijkstra's algorithm for minimax path
    const findMinimaxPath = () => {
      const maxEdgeDistances = {};
      const visited = {};
      const previousNodes = {};

      // Initialize maximum edge distances
      nodes.forEach((node) => {
        maxEdgeDistances[node] = Infinity;
        visited[node] = false;
        previousNodes[node] = null;
      });
      maxEdgeDistances["Earth"] = 0;

      while (true) {
        // Find the unvisited node with the smallest maximum edge distance
        let currentNode = null;
        let currentMax = Infinity;
        nodes.forEach((node) => {
          if (!visited[node] && maxEdgeDistances[node] < currentMax) {
            currentMax = maxEdgeDistances[node];
            currentNode = node;
          }
        });

        if (currentNode === null || currentNode === "Mars") {
          break;
        }

        visited[currentNode] = true;

        // Update maximum edge distances to neighboring nodes
        const neighbors = edges[currentNode];
        for (let neighbor in neighbors) {
          if (!visited[neighbor]) {
            // The new path's maximum edge is the max between current max and the new edge
            const tentativeMax = Math.max(maxEdgeDistances[currentNode], neighbors[neighbor]);
            if (tentativeMax < maxEdgeDistances[neighbor]) {
              maxEdgeDistances[neighbor] = tentativeMax;
              previousNodes[neighbor] = currentNode;
            }
          }
        }
      }

      // Retrieve the minimax path
      const path = [];
      let currentNodePath = "Mars";
      while (currentNodePath !== null) {
        path.unshift(currentNodePath);
        currentNodePath = previousNodes[currentNodePath];
      }

      // The total distance for minimax path can be interpreted in different ways.
      // Here, we'll return the maximum single link distance in the path.
      const totalMaxEdge = maxEdgeDistances["Mars"];

      return { path, distance3D: totalMaxEdge };
    };

    // Execute both algorithms
    const shortestPath = findShortestTotalDistance();
    const pathOfShortestLinks = findMinimaxPath();

    // Return the desired object structure
    return {
      shortestPath: shortestPath,
      pathOfShortestLinks: pathOfShortestLinks,
    };
  }

  drawShortestPath(path, pathType) {
    const positions = [];

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
        posA = satA ? satA.position : null;
      }

      if (nodeB === "Earth") {
        posB = this.earth.position;
      } else if (nodeB === "Mars") {
        posB = this.mars.position;
      } else {
        const satB = this.satellites.find((sat) => sat.nodeName === nodeB);
        posB = satB ? satB.position : null;
      }

      if (posA && posB) {
        positions.push(posA.x, posA.y, posA.z);
        positions.push(posB.x, posB.y, posB.z);
      }
    }

    // Update the BufferGeometry
    const positionAttribute = this.shortestPathLines.geometry.attributes.position;

    if (positions.length !== positionAttribute.count * 3) {
      // If the number of vertices has changed, set a new buffer
      this.shortestPathLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    } else {
      // Otherwise, update the existing buffer
      positionAttribute.array = new Float32Array(positions);
      positionAttribute.needsUpdate = true;
    }

    // Optionally, adjust the opacity or other material properties if needed
    this.shortestPathLines.material.opacity = this.styles.links[pathType].opacity;
    this.shortestPathLines.material.color.setHex(this.styles.links[pathType].color);
  }

  setTimeAccelerationFactor(factor) {
    this.timeAccelerationFactor = factor;
  }

  setMaxLinkDistance(maxLinkDistanceAu) {
    this.maxLinkDistance3D = auTo3D(maxLinkDistanceAu);
  }

  setMinimumRateMbps(minimumRateMbps) {
    this.minimumRateMbps = minimumRateMbps;
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
