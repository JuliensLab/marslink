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
export let satelliteScaleFactor = SIM_CONSTANTS.SATELLITE_SCALE_FACTOR;

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
    this.roadsterSizeFactor = 1;
    this.satelliteSizeFactor = 1;
    this.currentSatelliteScale = 100; // Default scale to make satellites visible initially
    this.satelliteColorMode = "Zone"; // Default color mode
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
    // Cached instanced mesh data for in-place position updates
    this._cachedMeshes = [];
    this._cachedGroupMappings = [];
    this._cachedGeometry = null;
    this.linksGroup = new THREE.Group();
    this.scene.add(this.linksGroup);
    this.linkLabelsGroup = new THREE.Group();
    this.scene.add(this.linkLabelsGroup);

    // Initialize links arrays
    this.possibleLinks = [];
    this.activeLinks = [];
    this.linkLabels = [];
    // Label mode: null = off, "mbps" = throughput labels (M key), "latency" = latency labels (L key)
    this.linkLabelMode = null;

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

  setSatelliteColorMode(mode) {
    this.satelliteColorMode = mode;
  }

  getSatelliteColorIndex(satellite) {
    if (this.satelliteColorMode === "Quad") {
      const solarAngle = ((satellite.position.solarAngle % 360) + 360) % 360;
      return Math.floor(solarAngle / 90);
    } else if (this.satelliteColorMode === "Zone") {
      if (satellite.orbitalZone === "INSIDE_EARTH") return 0;
      if (satellite.orbitalZone === "BETWEEN_EARTH_AND_MARS") return 1;
      if (satellite.orbitalZone === "OUTSIDE_MARS") return 2;
      if (satellite.orbitalZone === "EARTH_RING") return 4;
      if (satellite.orbitalZone === "MARS_RING") return 5;
      return 3; // Unknown zone
    } else if (this.satelliteColorMode === "Suit") {
      if (!satellite.suitable) return 3; // Grey for unsuitable
      if (satellite.suitable.includes("Mars") && satellite.suitable.includes("Earth")) return 1; // Green for both
      else if (satellite.suitable.includes("Mars")) return 0; // Red for Mars
      else if (satellite.suitable.includes("Earth")) return 2; // Blue for Earth
      else return 3; // Grey for unsuitable
    } else {
      // Grey or other
      return 0; // all same
    }
  }

  getEmissiveColors() {
    if (this.satelliteColorMode === "Quad") {
      return this.quadrantEmissives;
    } else if (this.satelliteColorMode === "Zone" || this.satelliteColorMode === "Suit") {
      return this.orbitalZoneEmissives;
    } else {
      return [this.normalEmissive];
    }
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
    const scale = 4; // render at 4x resolution for crisp text
    const fontSize = 48 * scale;
    context.font = `bold ${fontSize}px Arial`;
    const textWidth = context.measureText(text).width;
    canvas.width = textWidth + 20 * scale;
    canvas.height = fontSize + 20 * scale;
    context.font = `bold ${fontSize}px Arial`; // re-set after canvas resize
    context.clearRect(0, 0, canvas.width, canvas.height); // transparent background
    context.fillStyle = "rgba(255, 255, 255, 1)";
    context.fillText(text, 10 * scale, fontSize + 5 * scale);
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(0.005, 0.005, 1);
    return sprite;
  }

  /**
   * Sets the size factors for sun and planets.
   *
   * @param {number} sunFactor - Multiplier for sun size.
   * @param {number} planetsFactor - Multiplier for planets size.
   */
  setSizeFactors(sunFactor, planetsFactor, satellitesFactor) {
    const sunRatio = sunFactor / this.sunSizeFactor;
    const planetRatio = planetsFactor / this.planetSizeFactor;
    const satelliteRatio = satellitesFactor / this.satelliteSizeFactor;

    this.sunSizeFactor = sunFactor;
    this.planetSizeFactor = planetsFactor;
    this.satelliteSizeFactor = satellitesFactor;

    sunScaleFactor = SIM_CONSTANTS.SUN_SCALE_FACTOR * sunFactor;
    planetScaleFactor = SIM_CONSTANTS.PLANET_SCALE_FACTOR * planetsFactor;
    satelliteScaleFactor = SIM_CONSTANTS.SATELLITE_SCALE_FACTOR * satellitesFactor;

    // Update existing meshes
    if (this.sunMesh) {
      this.sunMesh.scale.set(sunScaleFactor, sunScaleFactor, sunScaleFactor);
    }
    for (const planetName in this.planets) {
      const planetMesh = this.planets[planetName];
      if (planetMesh) {
        if (planetMesh.isRoadster) {
          // Roadster uses its own size factor
          const rf = 0.001 * this.roadsterSizeFactor;
          planetMesh.scale.set(rf, rf, rf);
        } else {
          planetMesh.scale.set(planetScaleFactor, planetScaleFactor, planetScaleFactor);
        }
      }
    }
    // Update satellite geometry scale — apply to cached instanced meshes
    this.currentSatelliteScale = satelliteScaleFactor;
    if (this._cachedMeshes) {
      for (const mesh of this._cachedMeshes) {
        mesh.geometry.dispose();
      }
      const scale = 0.0001;
      const newGeometry = new THREE.CylinderGeometry(scale, scale, scale * 2, 6);
      newGeometry.scale(this.currentSatelliteScale, this.currentSatelliteScale, this.currentSatelliteScale);
      this._cachedGeometry = newGeometry;
      for (const mesh of this._cachedMeshes) {
        mesh.geometry = newGeometry;
      }
    }
  }

  setRoadsterSizeFactor(factor) {
    this.roadsterSizeFactor = factor;
    for (const planetName in this.planets) {
      const planetMesh = this.planets[planetName];
      if (planetMesh && planetMesh.isRoadster) {
        const rf = 0.001 * factor;
        planetMesh.scale.set(rf, rf, rf);
      }
    }
  }

  // Define emissive colors for solar angle Quad
  quadrantEmissives = [
    new THREE.Color(0xdd2222), // 0-90 degrees
    new THREE.Color(0x22dd22), // 90-180 degrees
    new THREE.Color(0x2222dd), // 180-270 degrees
    new THREE.Color(0x666666), // 270-360 degrees
  ];

  // Define emissive colors for Zones
  orbitalZoneEmissives = [
    new THREE.Color(0xdd2222), // Red for inside earth
    new THREE.Color(0x22dd22), // Green for between earth and mars
    new THREE.Color(0x2222dd), // Blue for outside mars
    new THREE.Color(0x333333), // Grey for unknown
    new THREE.Color(0x0066ff), // Blue green for earth ring
    new THREE.Color(0xff6600), // Red green for mars ring
  ];

  // Normal color
  normalEmissive = new THREE.Color(0x777777);

  /**
   * Sets up satellites using instanced meshes for efficiency, grouped by color mode.
   * Cleans up any previous instanced objects if needed.
   *
   * @param {Array} satellites - Array of satellite objects with properties:
   *                             { position: { x, y, z, solarAngle } }.
   */
  /**
   * Rebuilds satellite instanced meshes from scratch.
   * Call only when satellite count or color mode changes.
   * Per-frame position updates use updatePositions() which updates matrices in-place.
   */
  setSatellites(satellites) {
    // Cleanup existing satellites group
    this.clearGroup(this.satellitesGroup);

    // Always populate satellite positions for links, even if not displaying meshes
    this.satellitePositions = {};
    satellites.forEach((satellite) => {
      const position = satellite.position;
      this.satellitePositions[satellite.name] = {
        x: auTo3D(position.x),
        y: auTo3D(position.z),
        z: -auTo3D(position.y),
      };
    });

    // Reset cached mesh data
    this._cachedMeshes = [];
    this._cachedGroupMappings = [];
    this._cachedGeometry = null;

    if (this.satelliteColorMode === "None") return;
    if (satellites.length === 0 || this.satelliteSizeFactor <= 0) return;

    const scale = 0.0001;
    const geometry = new THREE.CylinderGeometry(scale, scale, scale * 2, 6);
    geometry.scale(this.currentSatelliteScale, this.currentSatelliteScale, this.currentSatelliteScale);
    this._cachedGeometry = geometry;

    // Group satellites by color index
    const numGroups =
      this.satelliteColorMode === "Quad" ? 4 : this.satelliteColorMode === "Zone" || this.satelliteColorMode === "Suit" ? 6 : 1;
    const colorGroups = Array.from({ length: numGroups }, () => []);
    satellites.forEach((satellite, index) => {
      const colorIndex = this.getSatelliteColorIndex(satellite);
      colorGroups[colorIndex].push({ satellite, originalIndex: index });
    });

    // Create instanced meshes for each group
    const emissives = this.getEmissiveColors();
    const dummy = new THREE.Object3D();

    colorGroups.forEach((groupSats, groupIndex) => {
      if (groupSats.length === 0) return;

      const material = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        shininess: 10,
        specular: new THREE.Color(0x333333),
        emissive: emissives[groupIndex],
        emissiveIntensity: 0.5,
        transparent: false,
        opacity: 1.0,
      });

      const instancedMesh = new THREE.InstancedMesh(geometry, material, groupSats.length);
      instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instancedMesh.castShadow = false;
      instancedMesh.receiveShadow = true;

      groupSats.forEach((item, localIndex) => {
        const position = item.satellite.position;
        dummy.position.set(auTo3D(position.x), auTo3D(position.z), -auTo3D(position.y));
        dummy.updateMatrix();
        instancedMesh.setMatrixAt(localIndex, dummy.matrix);
      });
      instancedMesh.instanceMatrix.needsUpdate = true;

      this.satellitesGroup.add(instancedMesh);
      this._cachedMeshes.push(instancedMesh);
      this._cachedGroupMappings.push(groupSats.map((item) => item.originalIndex));
    });
  }

  /**
   * Updates the 3D scene with new planets positions, satellites, and links data.
   *
   * @param {Object} planetsPositions - An object mapping planet names to positions { x, y, z }.
   * @param {Array} satellitesPositions - Array of satellite position objects [{ x, y, z }, ...].
   * @param {Array} links - Array of link objects with properties:
   *                        { fromId: string, toId: string, gbpsFlow: number, ... }.
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
    // Always populate satellite positions for links, even if not displaying meshes
    satellites.forEach((satellite) => {
      const position = satellite.position;
      this.satellitePositions[satellite.name] = {
        x: auTo3D(position.x),
        y: auTo3D(position.z),
        z: -auTo3D(position.y),
      };
    });
    // Update instanced mesh matrices in-place (no rebuild)
    if (this._cachedMeshes && this._cachedMeshes.length > 0) {
      const dummy = new THREE.Object3D();
      for (let g = 0; g < this._cachedMeshes.length; g++) {
        const mesh = this._cachedMeshes[g];
        const originalIndices = this._cachedGroupMappings[g];
        for (let i = 0; i < originalIndices.length; i++) {
          const satellite = satellites[originalIndices[i]];
          if (!satellite) continue;
          const position = satellite.position;
          dummy.position.set(auTo3D(position.x), auTo3D(position.z), -auTo3D(position.y));
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
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
    if (this.linksColorsType === "None") {
      this.linksGeometry.setDrawRange(0, 0);
      if (this.linkLabels.length > 0) this.updateLinkLabels([]);
      return;
    }

    // Build active link set using pre-cached keys to avoid per-frame string alloc
    if (!this._activeLinkSet) this._activeLinkSet = new Set();
    const activeLinkSet = this._activeLinkSet;
    activeLinkSet.clear();
    for (let i = 0; i < this.activeLinks.length; i++) {
      const link = this.activeLinks[i];
      activeLinkSet.add(link._key || (link._key = link.fromId + "_" + link.toId));
    }

    // Count valid links without allocating filter arrays
    const possible = this.possibleLinks;
    const active = this.activeLinks;
    const pPos = this.planetPositions;
    const sPos = this.satellitePositions;

    // Pre-count to size buffers, then fill in a single pass
    let numLinks = 0;

    // Active links first
    for (let i = 0; i < active.length; i++) {
      const link = active[i];
      const from = pPos[link.fromId] || sPos[link.fromId];
      const to = pPos[link.toId] || sPos[link.toId];
      if (from && to) numLinks++;
    }
    // Inactive links
    const inactiveStart = numLinks;
    for (let i = 0; i < possible.length; i++) {
      const link = possible[i];
      const key = link._key || (link._key = link.fromId + "_" + link.toId);
      const revKey = link._revKey || (link._revKey = link.toId + "_" + link.fromId);
      if (activeLinkSet.has(key) || activeLinkSet.has(revKey)) continue;
      const from = pPos[link.fromId] || sPos[link.fromId];
      const to = pPos[link.toId] || sPos[link.toId];
      if (from && to) numLinks++;
    }

    const requiredSize = numLinks * 6;

    // Reuse or grow pre-allocated typed arrays
    if (!this._linkPositions || this._linkPositions.length < requiredSize) {
      const allocSize = Math.max(requiredSize, 6000);
      this._linkPositions = new Float32Array(allocSize);
      this._linkColors = new Float32Array(allocSize);
      this._linkPosAttr = new THREE.BufferAttribute(this._linkPositions, 3);
      this._linkPosAttr.setUsage(THREE.DynamicDrawUsage);
      this._linkColAttr = new THREE.BufferAttribute(this._linkColors, 3);
      this._linkColAttr.setUsage(THREE.DynamicDrawUsage);
      this.linksGeometry.setAttribute("position", this._linkPosAttr);
      this.linksGeometry.setAttribute("color", this._linkColAttr);
    }

    const positions = this._linkPositions;
    const colors = this._linkColors;

    // Calculate min and max for color mapping
    let maxVal = 1, minVal = 0;
    const isFlowMode = this.linksColorsType === "Flow";
    if (isFlowMode) {
      for (let i = 0; i < active.length; i++) {
        const f = active[i].gbpsFlow;
        if (f > maxVal) maxVal = f;
      }
    } else {
      maxVal = 0; minVal = Infinity;
      for (let i = 0; i < possible.length; i++) {
        const c = possible[i].gbpsCapacity;
        if (c > maxVal) maxVal = c;
        if (c < minVal) minVal = c;
      }
      for (let i = 0; i < active.length; i++) {
        const c = active[i].gbpsCapacity;
        if (c > maxVal) maxVal = c;
        if (c < minVal) minVal = c;
      }
    }

    // Pre-extract color stop RGB (avoid .set() per frame — only update when styles change)
    if (!this._colorsCached) {
      this._colorsCached = true;
      const c = new THREE.Color();
      c.set(this.styles.links.inactive.color);
      this._inR = c.r; this._inG = c.g; this._inB = c.b;
      c.set(this.styles.links.active.color_0);
      this._c0R = c.r; this._c0G = c.g; this._c0B = c.b;
      c.set(this.styles.links.active.color_fixed);
      this._cfR = c.r; this._cfG = c.g; this._cfB = c.b;
      c.set(this.styles.links.active.color_max);
      this._cmR = c.r; this._cmG = c.g; this._cmB = c.b;
    }

    const valRange = maxVal - minVal;
    const valRangeInv = valRange > 0 ? 1 / valRange : 0;
    const threshold = 0.02;
    const aboveThresholdInv = maxVal > threshold ? 1 / (maxVal - threshold) : 0;
    const thresholdInv = 1 / threshold;

    // Reuse validLinks array for label pass
    if (!this._validLinks) this._validLinks = [];
    const validLinks = this._validLinks;
    validLinks.length = 0;

    // Single-pass: write active links, then inactive
    let idx = 0;
    const writeLink = (link, isActive) => {
      const from = pPos[link.fromId] || sPos[link.fromId];
      const to = pPos[link.toId] || sPos[link.toId];
      if (!from || !to) return;

      const off = idx * 6;
      positions[off]     = from.x; positions[off + 1] = from.y; positions[off + 2] = from.z;
      positions[off + 3] = to.x;   positions[off + 4] = to.y;   positions[off + 5] = to.z;

      let r, g, b;
      if ((isFlowMode && isActive) || !isFlowMode) {
        const val = isFlowMode ? link.gbpsFlow : link.gbpsCapacity;
        if (val <= threshold) {
          const t = val * thresholdInv;
          r = this._c0R + (this._cfR - this._c0R) * t;
          g = this._c0G + (this._cfG - this._c0G) * t;
          b = this._c0B + (this._cfB - this._c0B) * t;
        } else {
          const t = (val - threshold) * aboveThresholdInv;
          r = this._cfR + (this._cmR - this._cfR) * t;
          g = this._cfG + (this._cmG - this._cfG) * t;
          b = this._cfB + (this._cmB - this._cfB) * t;
        }
      } else {
        r = this._inR; g = this._inG; b = this._inB;
      }

      colors[off]     = r; colors[off + 1] = g; colors[off + 2] = b;
      colors[off + 3] = r; colors[off + 4] = g; colors[off + 5] = b;
      idx++;
      validLinks.push(link);
    };

    for (let i = 0; i < active.length; i++) writeLink(active[i], true);
    for (let i = 0; i < possible.length; i++) {
      const link = possible[i];
      if (activeLinkSet.has(link._key) || activeLinkSet.has(link._revKey)) continue;
      writeLink(link, false);
    }

    this.linksGeometry.setDrawRange(0, idx * 2);
    this._linkPosAttr.needsUpdate = true;
    this._linkColAttr.needsUpdate = true;

    // Update link labels (skip cleanup when no labels exist and none requested)
    if (this.linkLabelMode || this.linkLabels.length > 0) {
      this.updateLinkLabels(validLinks);
    }
  }

  /**
   * Updates the text labels for links based on screen distance and zoom level.
   *
   * @param {Array} validLinks - Array of valid links.
   */
  updateLinkLabels(validLinks) {
    // Only show labels when a label mode is active and links are being drawn
    if (!this.linkLabelMode || this.linksColorsType === "None") {
      // Hide all pooled labels
      for (let i = 0; i < this.linkLabels.length; i++) this.linkLabels[i].visible = false;
      return;
    }

    // Reuse vector objects to avoid per-link allocation
    const fromPos = this._labelFromPos || (this._labelFromPos = new THREE.Vector3());
    const toPos = this._labelToPos || (this._labelToPos = new THREE.Vector3());
    const fromScreen = this._labelFromScreen || (this._labelFromScreen = new THREE.Vector3());
    const toScreen = this._labelToScreen || (this._labelToScreen = new THREE.Vector3());

    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    const pPos = this.planetPositions;
    const sPos = this.satellitePositions;
    const isMbps = this.linkLabelMode === "mbps";
    const isFlowMode = this.linksColorsType === "Flow";

    let labelIdx = 0;
    for (let i = 0; i < validLinks.length; i++) {
      const link = validLinks[i];
      const from = pPos[link.fromId] || sPos[link.fromId];
      const to = pPos[link.toId] || sPos[link.toId];
      if (!from || !to) continue;

      fromPos.set(from.x, from.y, from.z);
      toPos.set(to.x, to.y, to.z);
      fromScreen.copy(fromPos).project(this.camera);
      toScreen.copy(toPos).project(this.camera);

      // Skip if both endpoints are off-screen
      const fIn = fromScreen.x >= -1 && fromScreen.x <= 1 && fromScreen.y >= -1 && fromScreen.y <= 1 && fromScreen.z >= -1 && fromScreen.z <= 1;
      const tIn = toScreen.x >= -1 && toScreen.x <= 1 && toScreen.y >= -1 && toScreen.y <= 1 && toScreen.z >= -1 && toScreen.z <= 1;
      if (!fIn && !tIn) continue;

      const dx = (fromScreen.x - toScreen.x) * halfW;
      const dy = (fromScreen.y - toScreen.y) * halfH;
      if (dx * dx + dy * dy < 2500) continue; // screenDist < 50px (avoid sqrt)

      let labelText;
      if (isMbps) {
        const v = isFlowMode ? link.gbpsFlow : link.gbpsCapacity;
        labelText = `${Math.round(v * 1000)}`;
      } else {
        const s = link.latencySeconds ?? 0;
        labelText = s >= 1 ? `${s.toFixed(1)}s` : `${Math.round(s * 1000)}ms`;
      }

      // Reuse or create sprite from pool
      let label;
      if (labelIdx < this.linkLabels.length) {
        label = this.linkLabels[labelIdx];
        // Only recreate texture if text changed
        if (label._text !== labelText) {
          if (label.material.map) label.material.map.dispose();
          const newSprite = this.createTextSprite(labelText);
          label.material.map = newSprite.material.map;
          label.material.needsUpdate = true;
          newSprite.material.dispose();
          label._text = labelText;
        }
        label.visible = true;
      } else {
        label = this.createTextSprite(labelText);
        label._text = labelText;
        this.linkLabelsGroup.add(label);
        this.linkLabels.push(label);
      }

      label.position.set(
        (from.x + to.x) * 0.5,
        (from.y + to.y) * 0.5,
        (from.z + to.z) * 0.5
      );
      labelIdx++;
    }

    // Hide unused pooled labels
    for (let i = labelIdx; i < this.linkLabels.length; i++) {
      this.linkLabels[i].visible = false;
    }
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
    // Ignore shortcuts while typing in form fields
    const t = event.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "l") {
      this.setLinkLabelMode(this.linkLabelMode === "latency" ? null : "latency");
    } else if (key === "m") {
      this.setLinkLabelMode(this.linkLabelMode === "mbps" ? null : "mbps");
    }
  }

  /**
   * Sets the link-label mode (null | "latency" | "mbps") and notifies listeners
   * via a window-level CustomEvent so the UI can reflect the active state.
   */
  setLinkLabelMode(mode) {
    this.linkLabelMode = mode;
    window.dispatchEvent(new CustomEvent("marslink:link-label-mode", { detail: { mode } }));
  }

  /**
   * Animation loop that renders the scene and updates controls.
   * Positions are updated via updateData(), so we only need to handle rendering here.
   */
  animate() {
    if (this.stopAnimation) return; // Stop if flagged
    requestAnimationFrame(this.animate);

    // FPS counter
    const now = performance.now();
    if (!this._fpsFrames) {
      this._fpsFrames = 0;
      this._fpsLastTime = now;
      this._fpsDisplay = document.getElementById("fps-counter");
    }
    this._fpsFrames++;
    const elapsed = now - this._fpsLastTime;
    if (elapsed >= 500) {
      this._fpsDisplay.textContent = `${Math.round((this._fpsFrames * 1000) / elapsed)} fps`;
      this._fpsFrames = 0;
      this._fpsLastTime = now;
    }

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
    this._cachedMeshes = [];
    this._cachedGroupMappings = [];
    this._cachedGeometry = null;

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
