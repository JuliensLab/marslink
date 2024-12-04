// simDisplay.js

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js?v=2.3";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js?v=2.3";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js?v=2.3";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js?v=2.3";
import { SimSolarSystem } from "./simSolarSystem.js?v=2.3";
import { createCarModel } from "./modelCar.js?v=2.3";

/**
 * Converts astronomical units (AU) to 3D units using a scale factor.
 *
 * @param {number} au - Distance in astronomical units.
 * @returns {number} Distance in 3D units.
 */
export const sunScaleFactor = 20;
export const planetScaleFactor = 200;

export function auTo3D(au) {
  return au;
}

export function kmToAu(km) {
  return km / 149597871;
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
    // === Styles ===
    this.styles = {
      links: {
        inactive: { color: 0x555555, opacity: 0.1 },
        active: { colormax: 0xff0000, colormin: 0x0000ff, opacity: 0.8, gbpsmax: 1, gbpsmin: 0.1 },
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

    // Initialize links arrays
    this.possibleLinks = [];
    this.activeLinks = [];

    // === Load Scene Elements ===
    this.loadScene();

    // === Resize Listener ===
    window.addEventListener("resize", this.onWindowResize.bind(this), false);

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
    const sunGeometry = new THREE.SphereGeometry(kmTo3D(sunData.diameterKm / 2) * sunScaleFactor, 64, 64);
    const sunMaterial = new THREE.MeshBasicMaterial({ map: sunTexture, color: 0xffffff });
    const sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);
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
    const ambientLight = new THREE.AmbientLight(0x888888); // Dim ambient light
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
        const geometry = new THREE.SphereGeometry(kmTo3D(planetData.diameterKm / 2) * planetScaleFactor, 32, 32);
        const texture = this.textureLoader.load(planetData.texturePath);
        const material = new THREE.MeshPhongMaterial({
          map: texture,
          shininess: 2,
          specular: new THREE.Color(0x111111),
        });
        const planetMesh = new THREE.Mesh(geometry, material);
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

    const numLinks = allLinks.length;
    const positions = new Float32Array(numLinks * 2 * 3);
    const colors = new Float32Array(numLinks * 2 * 3);

    // Calculate min and max flow for color mapping (for active links only)
    const flows = this.activeLinks.map((link) => link.gbpsFlowActual);
    const maxFlow = Math.max(...flows);
    const minFlow = Math.min(...flows);

    // const maxFlow = this.styles.links.active.gbpsmax;
    // const minFlow = this.styles.links.active.gbpsmin;
    // console.log(maxFlow, minFlow);

    for (let i = 0; i < numLinks; i++) {
      const link = allLinks[i];
      const isActive = activeLinkSet.has(link.fromId + "_" + link.toId);

      // Get 'from' and 'to' positions
      const fromPosition = this.planetPositions[link.fromId] || this.satellitePositions[link.fromId];
      const toPosition = this.planetPositions[link.toId] || this.satellitePositions[link.toId];

      if (!fromPosition || !toPosition) {
        console.warn(`Cannot find positions for link between "${link.fromId}" and "${link.toId}"`);
        continue;
      }

      // Set positions
      positions[i * 6] = fromPosition.x;
      positions[i * 6 + 1] = fromPosition.y;
      positions[i * 6 + 2] = fromPosition.z;

      positions[i * 6 + 3] = toPosition.x;
      positions[i * 6 + 4] = toPosition.y;
      positions[i * 6 + 5] = toPosition.z;

      // Set colors
      let color = new THREE.Color();
      if (isActive) {
        // Active link: interpolate color based on flow
        let t = 0;
        if (maxFlow > minFlow) {
          t = (link.gbpsFlowActual - minFlow) / (maxFlow - minFlow);
        }
        t = isNaN(t) ? 0 : t;

        color.lerpColors(new THREE.Color(this.styles.links.active.colormin), new THREE.Color(this.styles.links.active.colormax), t);
      } else {
        // Inactive link: use inactive color
        color = new THREE.Color(this.styles.links.inactive.color);
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
   * Animation loop that renders the scene and updates controls.
   * Positions are updated via updateData(), so we only need to handle rendering here.
   */
  animate() {
    requestAnimationFrame(this.animate);

    this.controls.update(); // Update orbit controls

    // === Render Scene with Composer ===
    this.composer.render();
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
