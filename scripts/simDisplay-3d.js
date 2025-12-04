// simDisplay-3d.js

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js?v=4.3";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js?v=4.3";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js?v=4.3";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js?v=4.3";
import { SimSolarSystem } from "./simSolarSystem.js?v=4.3";
import { createCarModel } from "./modelCar.js?v=4.3";

/**
 * Converts astronomical units (AU) to 3D units using a scale factor.
 *
 * @param {number} au - Distance in astronomical units.
 * @returns {number} Distance in 3D units
 */

import { SIM_CONSTANTS } from "./simConstants.js";

export let sunScaleFactor = SIM_CONSTANTS.SUN_SCALE_FACTOR;
export let planetScaleFactor = SIM_CONSTANTS.PLANET_SCALE_FACTOR;

export function auTo3D(au) {
  return au;
}

export function kmToAu(km) {
  return km / SIM_CONSTANTS.AU_IN_KM;
}

/**
 * Converts kilometers to 3D units using the same scale factor.
 *
 * @param {number} km - Distance in kilometers.
 * @returns {number} Distance in 3D units.
 */
export function kmTo3D(km) {
  return kmToAu(km);
}

/**
 * SimDisplay class handles the 3D rendering of planets, satellites, and links using Three.js.
 * It provides functionalities to update the positions of these objects dynamically.
 */
export class SimDisplay {
  /**
   * Creates an instance of SimDisplay.
   *
   * @param {HTMLElement} container - The DOM element to which the renderer will be appended.
   *                                   Defaults to document.body if not provided.
   */
  constructor(container = document.body) {
    this.stopAnimation = false; // Flag to stop animation
    this.sunSizeFactor = 1;
    this.planetSizeFactor = 1;
    // === Styles ===
    this.styles = {
      links: {
        inactive: { color: 0xbbbbbb, opacity: 0.05 },
        active: {
          color_0: 0x0033ff,
          color_fixed: 0xff3300,
          color_max: 0xff9900,
          opacity: 0.8,
          gbpsmax: 1,
          gbpsmin: 0.1,
        },
      },
    };

    // === Scene Setup ===
    this.scene = new THREE.Scene();

    // === Camera Setup ===
    const fov = 75;
    const aspect = window.innerWidth / window.innerHeight;
    const near = 0.01;
    const far = 1000;
    this.camera = new THREE.PerspectiveCamera(fov, aspect, near, far);

    // Set the camera position to 45 degrees from the top
    const distance = 2; // Adjust this distance as needed
    const angle = Math.PI / 4; // 45 degrees in radians

    // Calculate x, y, z based on the angle
    this.camera.position.x = distance * Math.cos(angle);
    this.camera.position.y = distance * Math.sin(angle);
    this.camera.position.z = distance * Math.sin(angle);

    // Point the camera towards the origin (0, 0, 0)
    this.camera.lookAt(0, 0, 0);

    // === Renderer Setup ===
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true; // Enable shadows
    container.appendChild(this.renderer.domElement);

    // === Controls Setup ===
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // Smooth controls
    this.controls.dampingFactor = 0.05;
    this.controls.enablePan = true;
    this.controls.minDistance = 0.05; // Minimum zoom distance
    this.controls.maxDistance = 50; // Maximum zoom distance

    // === Texture Loader ===
    this.textureLoader = new THREE.TextureLoader();

    // === Solar System Data ===
    this.simSolarSystem = new SimSolarSystem();
    this.solarSystemData = this.simSolarSystem.getSolarSystemData();

    // === Object Containers ===
    this.planets = {}; // Store planet meshes
    this.satellitesGroup = new THREE.Group();
    this.scene.add(this.satellitesGroup);
    this.linksGroup = new THREE.Group();
    this.scene.add(this.linksGroup);
    this.linkLabelsGroup = new THREE.Group();
    this.scene.add(this.linkLabelsGroup);

    // Initialize links arrays
    this.possibleLinks = [];
    this.activeLinks = [];
    this.linkLabels = [];
    this.showLinkLabels = false; // Flag for 'L' key press

    // === Load Scene Elements ===
    this.loadScene();

    // === Resize Listener ===
    window.addEventListener("resize", this.onWindowResize.bind(this), false);

    // === Keyboard Listeners ===
    window.addEventListener("keydown", this.onKeyDown.bind(this), false);

    // === Bind Animate Method ===
    this.animate = this.animate.bind(this);

    // === Animation Loop ===
    this.animate();
  }

  /**
   * Loads the scene elements including background, lights, sun, and planets.
   */
  loadScene() {
    // === Starry Background ===
    const starTexture = this.textureLoader.load(this.solarSystemData.background.texturePath);
    const starsGeometry = new THREE.SphereGeometry(500, 64, 64);
    const starsMaterial = new THREE.MeshBasicMaterial({
      map: starTexture,
      side: THREE.BackSide,
      color: 0x444444, // Darker color to reduce brightness
    });
    const starField = new THREE.Mesh(starsGeometry, starsMaterial);
    this.scene.add(starField);

    // === Sun ===
    const sunData = this.solarSystemData.sun;
    const sunTexture = this.textureLoader.load(sunData.texturePath);
    const sunGeometry = new THREE.SphereGeometry(kmTo3D(sunData.diameterKm / 2), 64, 64);
    const sunMaterial = new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xffffff });
    const sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);
    sunMesh.scale.set(sunScaleFactor, sunScaleFactor, sunScaleFactor);
    sunMesh.position.set(0, 0, 0);
    sunMesh.castShadow = false;
    sunMesh.receiveShadow = false;
    this.scene.add(sunMesh);
    this.sunMesh = sunMesh; // Store reference for updates if needed

    // === Sun as Light Source ===
    const sunlightIntensity = 2;
    const sunlightDistance = 100;
    const sunlight = new THREE.PointLight(0xffffff, sunlightIntensity, sunlightDistance);
    sunlight.position.set(0, 0, 0);
    sunlight.castShadow = true;
    sunlight.shadow.mapSize.width = 1024;
    sunlight.shadow.mapSize.height = 1024;
    sunlight.shadow.camera.near = 0.5;
    sunlight.shadow.camera.far = 1500;
    this.scene.add(sunlight);

    // === Ambient Light ===
    const ambientLight = new THREE.AmbientLight(0xbbbbbb); // Dim ambient light
    this.scene.add(ambientLight);

    // === Set Up Composer and Bloom Pass ===
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.5, // strength
      0.4, // radius
      0.85 // threshold
    );
    this.composer.addPass(this.bloomPass);

    // === Initialize Links LineSegments ===
    // MODIFY MATERIAL TO ENABLE VERTEX COLORS
    this.linksMaterial = new THREE.LineBasicMaterial({
      vertexColors: true, // Enable vertex colors
      transparent: true,
      opacity: 1.0, // Full opacity; control transparency via color if needed
    });

    this.linksGeometry = new THREE.BufferGeometry();
    this.linksLineSegments = new THREE.LineSegments(this.linksGeometry, this.linksMaterial);
    this.linksLineSegments.frustumCulled = false; // Optional
    this.scene.add(this.linksLineSegments);

    // === Load Planets ===
    this.loadPlanets();
  }

  /**
   * Loads planet meshes into the scene using the solar system data.
   */
  loadPlanets() {
    // Load Planets
    for (const planetData of this.solarSystemData.planets) {
      if (planetData.shape === "sphere") {
        // Create a sphere for spherical planets
        const geometry = new THREE.SphereGeometry(kmTo3D(planetData.diameterKm / 2), 32, 32);
        const texture = this.textureLoader.load(planetData.texturePath);
        const material = new THREE.MeshPhongMaterial({
          map: texture,
          shininess: 2,
          specular: new THREE.Color(0x111111),
        });
        const planetMesh = new THREE.Mesh(geometry, material);
        planetMesh.scale.set(planetScaleFactor, planetScaleFactor, planetScaleFactor);
        planetMesh.castShadow = true;
        planetMesh.receiveShadow = true;
        planetMesh.params = planetData; // Store parameters if needed
        this.scene.add(planetMesh);
        this.planets[planetData.name] = planetMesh;
      } else if (planetData.shape === "car") {
        // Use the helper function to create the car model
        createCarModel(THREE, planetData, this.scene, this.planets, planetScaleFactor);
      }
    }
  }

  setLinksColors(type) {
    // Set the links material based on the type
    this.linksColorsType = type;
  }

  /**
   * Creates a sprite with text for displaying link capacity.
   *
   * @param {string} text - The text to display.
   * @returns {THREE.Sprite} The text sprite.
   */
  createTextSprite(text) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const fontSize = 24;
    context.font = `${fontSize}px Arial`;
    const textWidth = context.measureText(text).width;
    canvas.width = textWidth + 20;
    canvas.height = fontSize + 20;
    context.fillStyle = "rgba(255, 255, 255, 1)";
    context.fillText(text, 10, fontSize + 5);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(0.01, 0.01, 1); // Adjust scale as needed
    return sprite;
  }

  /**
   * Sets the size factors for sun and planets.
   *
   * @param {number} sunFactor - Multiplier for sun size.
   * @param {number} planetsFactor - Multiplier for planets size.
   */
  setSizeFactors(sunFactor, planetsFactor) {
    const sunRatio = sunFactor / this.sunSizeFactor;
    const planetRatio = planetsFactor / this.planetSizeFactor;

    this.sunSizeFactor = sunFactor;
    this.planetSizeFactor = planetsFactor;

    sunScaleFactor = SIM_CONSTANTS.SUN_SCALE_FACTOR * sunFactor;
    planetScaleFactor = SIM_CONSTANTS.PLANET_SCALE_FACTOR * planetsFactor;

    // Update existing meshes
    if (this.sunMesh) {
      this.sunMesh.scale.set(sunScaleFactor, sunScaleFactor, sunScaleFactor);
    }
    for (const planetName in this.planets) {
      const planetMesh = this.planets[planetName];
      if (planetMesh) {
        if (planetMesh.type === "Mesh") {
          planetMesh.scale.set(planetScaleFactor, planetScaleFactor, planetScaleFactor);
        } else if (planetMesh.type === "Group") {
          // For car models
          planetMesh.scale.set(0.001 * planetsFactor, 0.001 * planetsFactor, 0.001 * planetsFactor);
        }
      }
    }
  }

  /**
   * Sets up satellites using instanced meshes for efficiency.
   * Cleans up any previous instanced objects if needed.
   *
   * @param {Array} satellites - Array of satellite objects with properties:
   *                             { color } (only color is used here).
   */
  setSatellites(satellites) {
    // Cleanup existing satellites group
    this.clearGroup(this.satellitesGroup);

    if (satellites.length === 0) return;

    const scale = 0.002;
    // Satellite geometry: Cylinder (adjust dimensions as needed)
    const geometry = new THREE.CylinderGeometry(
      scale, // Radius (top and bottom)
      scale,
      scale * 2, // Height
      6 // Number of segments (hexagonal cylinder)
    );

    // Satellite material: Supports per-instance colors
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff, // Default white color
      shininess: 10, // Adds a subtle shine to the satellites
      specular: new THREE.Color(0x333333), // Specular reflection color
      vertexColors: true, // Enable per-instance coloring
      emissive: new THREE.Color(0x444444), // Add an emissive color
      emissiveIntensity: 0.5, // Adjust emissive intensity as needed
      transparent: false, // No transparency for now
      opacity: 1.0, // Fully opaque
    });

    // Create Instanced Mesh: Shared geometry and material for all satellites
    const instancedMesh = new THREE.InstancedMesh(geometry, material, satellites.length);
    instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // Optimized for frequent updates
    instancedMesh.castShadow = false; // Satellites do not cast shadows
    instancedMesh.receiveShadow = true; // Satellites receive shadows

    // Set instance color and initialize transformations
    const dummy = new THREE.Object3D(); // Temporary object for matrix transformations
    satellites.forEach((satellite, index) => {
      // Set a grey color for all instances
      const color = new THREE.Color(0.9, 0.9, 0.9);
      instancedMesh.setColorAt(index, color);

      // Initial position (to be updated in updateData)
      const position = satellite.position;
      dummy.position.set(
        auTo3D(position.x),
        auTo3D(position.z), // Swap y and z axes if needed
        -auTo3D(position.y)
      ); // Default position
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(index, dummy.matrix); // Save initial transformation matrix
    });

    // Add the instanced mesh to the scene
    this.satellitesGroup.add(instancedMesh);
    this.satelliteMesh = instancedMesh; // Save reference for later updates
  }

  /**
   * Updates the 3D scene with new planets positions, satellites, and links data.
   *
   * @param {Object} planetsPositions - An object mapping planet names to positions { x, y, z }.
   * @param {Array} satellitesPositions - Array of satellite position objects [{ x, y, z }, ...].
   * @param {Array} links - Array of link objects with properties:
   *                        { fromId: string, toId: string, gbpsFlowActual: number, ... }.
   */
  updatePositions(planets, satellites) {
    // === Update Planet Positions ===
    this.planetPositions = {};
    for (let planet of Object.values(planets)) {
      const position = planet.position;
      const name = planet.name;
      const mesh = this.planets[name];
      if (mesh) {
        mesh.position.set(
          auTo3D(position.x),
          auTo3D(position.z), // Swap y and z axes if needed
          -auTo3D(position.y)
        );
        // Store position
        this.planetPositions[name] = {
          x: mesh.position.x,
          y: mesh.position.y,
          z: mesh.position.z,
        };
        // Update rotation if provided
        if (position.rotation) {
          mesh.rotation.set(position.rotation.x || 0, position.rotation.y || 0, position.rotation.z || 0);
        } else {
          // Reset rotation if not provided
          mesh.rotation.set(0, 0, 0);
        }
      } else {
        if (name != "Tesla") console.warn(`Mesh for planet "${name}" not found.`);
      }
    }

    // === Update Satellite Positions ===
    this.satellitePositions = {};
    if (this.satelliteMesh && satellites.length > 0) {
      const dummy = new THREE.Object3D();
      satellites.forEach((satellite, index) => {
        const position = satellite.position;
        dummy.position.set(
          auTo3D(position.x),
          auTo3D(position.z), // Swap y and z axes if needed
          -auTo3D(position.y)
        );
        // Update rotation if provided
        if (position.rotation) {
          dummy.rotation.set(position.rotation.x || 0, position.rotation.y || 0, position.rotation.z || 0);
        } else {
          // Reset rotation if not provided
          dummy.rotation.set(0, 0, 0);
        }
        dummy.updateMatrix();
        this.satelliteMesh.setMatrixAt(index, dummy.matrix); // Update matrix

        // Store position
        this.satellitePositions[satellite.name] = {
          x: dummy.position.x,
          y: dummy.position.y,
          z: dummy.position.z,
        };
      });
      this.satelliteMesh.instanceMatrix.needsUpdate = true; // Notify Three.js of the update
    }

    // === Update Links Positions ===
    this.updateLinksPositions();
  }

  updatePossibleLinks(links) {
    this.possibleLinks = links;
  }

  updateActiveLinks(links) {
    this.activeLinks = links;
  }

  updateLinksPositions() {
    const activeLinkSet = new Set(this.activeLinks.map((link) => link.fromId + "_" + link.toId));

    // Filter out active links from possible links
    const inactiveLinks = this.possibleLinks.filter(
      (link) => !activeLinkSet.has(link.fromId + "_" + link.toId) && !activeLinkSet.has(link.toId + "_" + link.fromId)
    );
    // Combine all links
    const allLinks = [...this.activeLinks, ...inactiveLinks];

    // Filter to only links with valid positions
    const validLinks = allLinks.filter((link) => {
      const fromPosition = this.planetPositions[link.fromId] || this.satellitePositions[link.fromId];
      const toPosition = this.planetPositions[link.toId] || this.satellitePositions[link.toId];
      return (
        fromPosition &&
        toPosition &&
        !isNaN(fromPosition.x) &&
        !isNaN(fromPosition.y) &&
        !isNaN(fromPosition.z) &&
        !isNaN(toPosition.x) &&
        !isNaN(toPosition.y) &&
        !isNaN(toPosition.z)
      );
    });

    const numLinks = validLinks.length;
    const positions = new Float32Array(numLinks * 2 * 3);
    const colors = new Float32Array(numLinks * 2 * 3);

    // Calculate min and max flow for color mapping (for active links only)
    let flows = [];
    if (this.linksColorsType === "actual") {
      flows = this.activeLinks
        .filter((link) => {
          const fromPosition = this.planetPositions[link.fromId] || this.satellitePositions[link.fromId];
          const toPosition = this.planetPositions[link.toId] || this.satellitePositions[link.toId];
          return (
            fromPosition &&
            toPosition &&
            !isNaN(fromPosition.x) &&
            !isNaN(fromPosition.y) &&
            !isNaN(fromPosition.z) &&
            !isNaN(toPosition.x) &&
            !isNaN(toPosition.y) &&
            !isNaN(toPosition.z)
          );
        })
        .map((link) => link.gbpsFlowActual);
    } else if (this.linksColorsType === "capacity") {
      flows = validLinks.map((link) => link.gbpsCapacity);
    }

    const maxFlow = flows.length > 0 ? Math.max(...flows) : 1;
    const minFlow = flows.length > 0 ? Math.min(...flows) : 0;

    // const maxFlow = this.styles.links.active.gbpsmax;
    // const minFlow = this.styles.links.active.gbpsmin;
    // console.log(this.linksColorsType, maxFlow, minFlow);

    for (let i = 0; i < numLinks; i++) {
      const link = validLinks[i];
      const isActive = activeLinkSet.has(link.fromId + "_" + link.toId);

      // Get 'from' and 'to' positions
      const fromPosition = this.planetPositions[link.fromId] || this.satellitePositions[link.fromId];
      const toPosition = this.planetPositions[link.toId] || this.satellitePositions[link.toId];

      // Set positions
      positions[i * 6] = fromPosition.x;
      positions[i * 6 + 1] = fromPosition.y;
      positions[i * 6 + 2] = fromPosition.z;

      positions[i * 6 + 3] = toPosition.x;
      positions[i * 6 + 4] = toPosition.y;
      positions[i * 6 + 5] = toPosition.z;

      // Set colors
      let color = new THREE.Color(this.styles.links.inactive.color);
      if ((this.linksColorsType === "actual" && isActive) || this.linksColorsType === "capacity") {
        // Active link: interpolate color based on flow
        let t = 0;
        let valFlow = this.linksColorsType === "actual" ? link.gbpsFlowActual : link.gbpsCapacity;
        if (maxFlow > minFlow) {
          t = (valFlow - minFlow) / (maxFlow - minFlow);
        }
        t = isNaN(t) ? 0 : t;

        // Map t (0-1) to the range of values (0 to max)
        let value = t * (maxFlow - minFlow) + minFlow;

        // Define color stops and their corresponding values
        const colorStops = [
          { value: 0, color: new THREE.Color(this.styles.links.active.color_0) },
          { value: 0.02, color: new THREE.Color(this.styles.links.active.color_fixed) },
          { value: maxFlow, color: new THREE.Color(this.styles.links.active.color_max) },
        ];

        // Find the appropriate color segment
        for (let i = 0; i < colorStops.length - 1; i++) {
          if (value >= colorStops[i].value && value <= colorStops[i + 1].value) {
            // Calculate interpolation factor within this segment
            let segmentT = (value - colorStops[i].value) / (colorStops[i + 1].value - colorStops[i].value);
            segmentT = isNaN(segmentT) ? 0 : segmentT;
            color.lerpColors(colorStops[i].color, colorStops[i + 1].color, segmentT);
            break;
          }
        }
      }

      // Set color for both vertices
      colors[i * 6] = color.r;
      colors[i * 6 + 1] = color.g;
      colors[i * 6 + 2] = color.b;

      colors[i * 6 + 3] = color.r;
      colors[i * 6 + 4] = color.g;
      colors[i * 6 + 5] = color.b;
    }

    // Update the geometry
    this.linksGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.linksGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.linksGeometry.attributes.position.needsUpdate = true;
    this.linksGeometry.attributes.color.needsUpdate = true;
    this.linksGeometry.computeBoundingSphere();

    // Update link labels
    this.updateLinkLabels(validLinks);
  }

  /**
   * Updates the text labels for links based on screen distance and zoom level.
   *
   * @param {Array} validLinks - Array of valid links.
   */
  updateLinkLabels(validLinks) {
    // Clear existing labels
    this.linkLabels.forEach((label) => {
      this.linkLabelsGroup.remove(label);
      if (label.material.map) label.material.map.dispose();
      label.material.dispose();
    });
    this.linkLabels = [];

    // Only show labels when 'L' key is pressed
    if (!this.showLinkLabels) return;

    validLinks.forEach((link) => {
      const fromPosition = this.planetPositions[link.fromId] || this.satellitePositions[link.fromId];
      const toPosition = this.planetPositions[link.toId] || this.satellitePositions[link.toId];

      const fromPos = new THREE.Vector3(fromPosition.x, fromPosition.y, fromPosition.z);
      const toPos = new THREE.Vector3(toPosition.x, toPosition.y, toPosition.z);

      // Project to screen space
      const fromScreen = fromPos.clone().project(this.camera);
      const toScreen = toPos.clone().project(this.camera);

      // Check if at least one endpoint is in viewport (NDC -1 to 1)
      const fromInViewport =
        fromScreen.x >= -1 && fromScreen.x <= 1 && fromScreen.y >= -1 && fromScreen.y <= 1 && fromScreen.z >= -1 && fromScreen.z <= 1;
      const toInViewport =
        toScreen.x >= -1 && toScreen.x <= 1 && toScreen.y >= -1 && toScreen.y <= 1 && toScreen.z >= -1 && toScreen.z <= 1;
      if (!fromInViewport && !toInViewport) return; // Skip if both endpoints are off-screen

      // Calculate screen distance in pixels
      const screenDist = Math.sqrt(
        Math.pow(((fromScreen.x - toScreen.x) * window.innerWidth) / 2, 2) +
          Math.pow(((fromScreen.y - toScreen.y) * window.innerHeight) / 2, 2)
      );

      if (screenDist > 50) {
        // Create label at midpoint
        const midPoint = new THREE.Vector3().addVectors(fromPos, toPos).multiplyScalar(0.5);
        const capacityMbps = Math.round(link.gbpsCapacity * 1000); // Convert Gbps to Mbps
        const label = this.createTextSprite(`${capacityMbps}`);
        label.position.copy(midPoint);
        this.linkLabelsGroup.add(label);
        this.linkLabels.push(label);
      }
    });
  }

  /**
   * Handles window resize events to adjust camera, renderer, and post-processing effects.
   */
  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.bloomPass.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * Handles keydown events.
   *
   * @param {KeyboardEvent} event - The keyboard event.
   */
  onKeyDown(event) {
    if (event.key.toLowerCase() === "l") {
      this.showLinkLabels = !this.showLinkLabels;
    }
  }

  /**
   * Animation loop that renders the scene and updates controls.
   * Positions are updated via updateData(), so we only need to handle rendering here.
   */
  animate() {
    if (this.stopAnimation) return; // Stop if flagged
    requestAnimationFrame(this.animate.bind(this));
    this.controls.update();
    this.composer.render();
  }

  dispose() {
    this.stopAnimation = true; // Prevent further animation frames

    // Dispose of OrbitControls
    if (this.controls) {
      this.controls.dispose();
    }

    // Dispose of bloom pass (post-processing)
    if (this.bloomPass) {
      this.bloomPass.dispose();
    }

    // Dispose of composer passes
    if (this.composer) {
      for (let pass of this.composer.passes) {
        if (pass.dispose) pass.dispose();
      }
    }

    // Dispose of renderer and force context loss
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss(); // Optional, ensures context is fully released
      this.renderer.domElement.remove(); // Remove DOM element
    }

    // Clear groups (e.g., satellites, links)
    this.clearGroup(this.satellitesGroup);
    this.clearGroup(this.linksGroup);
    this.clearGroup(this.linkLabelsGroup);

    // Dispose of planet meshes
    for (let planetMesh of Object.values(this.planets)) {
      if (planetMesh.geometry) planetMesh.geometry.dispose();
      if (planetMesh.material) {
        if (Array.isArray(planetMesh.material)) {
          planetMesh.material.forEach((mat) => mat.dispose());
        } else {
          planetMesh.material.dispose();
        }
      }
    }

    // Dispose of sun mesh
    if (this.sunMesh) {
      this.sunMesh.geometry.dispose();
      this.sunMesh.material.dispose();
    }

    // Dispose of star field
    if (this.starField) {
      this.starField.geometry.dispose();
      this.starField.material.dispose();
    }
  }

  /**
   * Clears all objects from a given group.
   *
   * @param {THREE.Group} group - The group to clear.
   */
  clearGroup(group) {
    while (group.children.length > 0) {
      const obj = group.children[0];
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((mat) => mat.dispose());
        } else {
          obj.material.dispose();
        }
      }
      group.remove(obj);
    }
  }
}
