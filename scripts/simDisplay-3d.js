// simDisplay-3d.js

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js?v=4.38";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js?v=4.38";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js?v=4.38";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js?v=4.38";
import { SimSolarSystem } from "./simSolarSystem.js?v=4.38";
import { createCarModel } from "./modelCar.js?v=4.38";
import { positionFromSolarAngle } from "./simOrbits.js?v=4.38";
import { stationKeepingAccel, THRUST_BINS, satSchemeT, rampHex, OVER_BUDGET_HEX, isThrustScheme, satStationKeeping, satTotalProp } from "./simStationKeeping.js?v=4.38";

/**
 * Converts astronomical units (AU) to 3D units using a scale factor.
 *
 * @param {number} au - Distance in astronomical units.
 * @returns {number} Distance in 3D units
 */

import { SIM_CONSTANTS } from "./simConstants.js?v=4.38";

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
    this.satPhysics = null; // ringName -> { dryMass, nRing, skPropRing, aThreshold, ports }
    this.skCfg = { F: 0.17, tm: 15, maxN: 64, n: 5, isp: 2500, capacity: 1500 };
    this.satLabelMode = false; // per-satellite labels (3D rendering deferred; 2D implemented)
    this.planetOrbitsGroup = null;
    this.referenceLinesGroup = null;
    this.satThrusterMax = 1;   // fleet max thruster count (Thrusters colour scale)
    this.satLaserMax = 1;      // fleet max laser terminals (Lasers colour scale)
    this.satLaserValues = [1];
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

    // Replace OrbitControls' wheel dolly-zoom with a "fly forward" translation.
    // The wheel now moves the camera (and the orbit target) along the view
    // direction, so it flies through the scene instead of zooming toward a fixed
    // point. Moving camera and target by the same vector preserves the spherical
    // offset OrbitControls tracks, so rotation keeps working normally afterward.
    this.controls.enableZoom = false;
    this._onWheel = this.onWheel.bind(this);
    this.renderer.domElement.addEventListener("wheel", this._onWheel, { passive: false });

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
        // Use the helper function to create the car model. Pass a getter for the roadster's
        // OWN size factor (not the planet factor) — read when the async model finishes, so
        // it lands correctly even if loadPlanets re-runs after setRoadsterSizeFactor().
        createCarModel(THREE, planetData, this.scene, this.planets, () => this.roadsterSizeFactor);
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

  setSatellitePhysics(map, cfg) {
    this.satPhysics = map;
    if (cfg) this.skCfg = cfg;
  }

  buildPlanetOrbits() {
    if (this.planetOrbitsGroup) return;
    const group = new THREE.Group();
    group.visible = false;
    const mat = new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 });
    const SEG = 256;
    for (const planetData of this.solarSystemData.planets) {
      if (planetData.shape !== "sphere" || !(planetData.a > 0)) continue;
      const pts = [];
      for (let i = 0; i <= SEG; i++) {
        // Sweep the true ecliptic longitude → real (eccentric, inclined) heliocentric
        // position, then map ecliptic (x,y,z)→world (x, z, -y) like the planet meshes.
        const p = positionFromSolarAngle(planetData, (i / SEG) * 360);
        pts.push(new THREE.Vector3(auTo3D(p.x), auTo3D(p.z), -auTo3D(p.y)));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    this.planetOrbitsGroup = group;
    this.scene.add(group);
  }

  setPlanetOrbits(value) {
    const on = Array.isArray(value) ? value.length > 0 : !!(value && String(value).length);
    this.buildPlanetOrbits();
    this.planetOrbitsGroup.visible = on;
  }

  // Reference lines through the Sun, each from Mars's orbit at one longitude to the
  // other (180° away). Same ecliptic→world mapping (x, z, −y) as the planet meshes/orbits.
  // `list` = enabled option labels; `angles` = { "<label>": {n1, n2} } for all options.
  buildReferenceLines(list, angles) {
    const COLORS = { "Closest approach": 0x5dd6a0, "Mars apsides": 0x4fc3d8, "Plane nodes": 0xd8b85a, "Earth apsides": 0xe0795a };
    if (this.referenceLinesGroup) {
      this.scene.remove(this.referenceLinesGroup);
      this.referenceLinesGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      this.referenceLinesGroup = null;
    }
    const group = new THREE.Group();
    group.visible = false;
    const mars = this.solarSystemData.planets.find((p) => p.name === "Mars");
    if (mars) {
      const toWorld = (ang) => { const p = positionFromSolarAngle(mars, ang); return new THREE.Vector3(auTo3D(p.x), auTo3D(p.z), -auTo3D(p.y)); };
      for (const key of list) {
        const ang = angles && angles[key], col = COLORS[key];
        if (!ang || col == null) continue;
        const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.85 });
        const pts = [toWorld(ang.n1), new THREE.Vector3(0, 0, 0), toWorld(ang.n2)];
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
      }
    }
    this.referenceLinesGroup = group;
    this.scene.add(group);
  }

  setReferenceLines(value, angles) {
    const list = Array.isArray(value) ? value : String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.buildReferenceLines(list, angles || {});
    this.referenceLinesGroup.visible = list.length > 0;
  }

  setSatLabelMode(on) {
    this.satLabelMode = !!on; // 3D per-satellite label rendering is deferred (2D implemented)
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
    } else if (isThrustScheme(this.satelliteColorMode)) {
      const ring = this.satPhysics && this.satPhysics[satellite.ringName];
      if (!ring) return 0;
      const a = stationKeepingAccel(satellite.position, this.planetPositionsAU || {});
      const isPlanetary = satellite.ringName === "ring_earth" || satellite.ringName === "ring_mars";
      const { N, skProp, m } = satStationKeeping(a, ring.dryMass, ring, isPlanetary, this.skCfg);
      const { t, over } = satSchemeT(this.satelliteColorMode, { a, m, skProp, favail: N * this.skCfg.F, isp: this.skCfg.isp, n: N, nMax: this.satThrusterMax, ports: ring.ports, lasersMax: this.satLaserMax, capacity: this.skCfg.capacity, nonSkFuel: ring.nonSkFuel, totProp: satTotalProp(ring, skProp, isPlanetary) });
      if (over) return THRUST_BINS; // over-budget bin (Thrust% only)
      return Math.max(0, Math.min(THRUST_BINS - 1, Math.floor(t * THRUST_BINS)));
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
    } else if (isThrustScheme(this.satelliteColorMode)) {
      const arr = Array.from({ length: THRUST_BINS }, (_, i) => new THREE.Color(rampHex(THRUST_BINS === 1 ? 0 : i / (THRUST_BINS - 1))));
      arr.push(new THREE.Color(OVER_BUDGET_HEX)); // over-budget bin (Thrust% >100%)
      return arr;
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
      this.satelliteColorMode === "Quad" ? 4 : this.satelliteColorMode === "Zone" || this.satelliteColorMode === "Suit" ? 6 : isThrustScheme(this.satelliteColorMode) ? THRUST_BINS + 1 : 1;
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
    this.planetPositionsAU = {};
    for (let planet of Object.values(planets)) {
      const position = planet.position;
      const name = planet.name;
      this.planetPositionsAU[name] = { x: position.x, y: position.y, z: position.z };
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

  // ── Spacecraft-flight overlay (transfer arcs + extension links + ship markers) ──
  // Lazily create the reusable scene objects: a Points cloud for ships (updated in
  // place each frame), a LineSegments buffer for extension links (in place), and a
  // Group of Lines for the transfer arcs (rebuilt only when the in-transit set changes).
  _initFlightOverlay() {
    if (this._flightInit) return;
    this._flightInit = true;

    // Round sprite for the ship point markers.
    const cnv = document.createElement("canvas"); cnv.width = cnv.height = 64;
    const cx = cnv.getContext("2d");
    const grd = cx.createRadialGradient(32, 32, 0, 32, 32, 30);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.65, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    cx.fillStyle = grd; cx.beginPath(); cx.arc(32, 32, 30, 0, Math.PI * 2); cx.fill();
    const shipTex = new THREE.CanvasTexture(cnv);

    this._flightArcsGroup = new THREE.Group();
    this._flightArcsGroup.frustumCulled = false;
    this.scene.add(this._flightArcsGroup);
    this._flightArcRefs = null;
    this._flightArcMat = new THREE.LineBasicMaterial({ color: 0xffa83c, transparent: true, opacity: 0.7 });

    this._flightLinksGeom = new THREE.BufferGeometry();
    this._flightLinksGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this._flightLinksMat = new THREE.LineBasicMaterial({ color: 0x00d2aa, transparent: true, opacity: 0.95 });
    this._flightLinks = new THREE.LineSegments(this._flightLinksGeom, this._flightLinksMat);
    this._flightLinks.frustumCulled = false;
    this._flightLinks.renderOrder = 2;
    this.scene.add(this._flightLinks);

    this._flightShipsGeom = new THREE.BufferGeometry();
    this._flightShipsGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this._flightShipsGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
    this._flightShipsMat = new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, map: shipTex, vertexColors: true, transparent: true, alphaTest: 0.3, depthWrite: false });
    this._flightShips = new THREE.Points(this._flightShipsGeom, this._flightShipsMat);
    this._flightShips.frustumCulled = false;
    this._flightShips.renderOrder = 3;
    this.scene.add(this._flightShips);
  }

  setFlightData(data) {
    this.flightData = data || { ships: [], arcs: [], links: [] };
    if (!this.scene) return;
    this._initFlightOverlay();
    const fd = this.flightData;

    // Ships — update position + color attributes in place (resize only if count changed).
    const ships = fd.ships || [];
    const ns = ships.length;
    let posAttr = this._flightShipsGeom.getAttribute("position");
    let colAttr = this._flightShipsGeom.getAttribute("color");
    if (posAttr.count !== ns) {
      posAttr = new THREE.BufferAttribute(new Float32Array(ns * 3), 3);
      colAttr = new THREE.BufferAttribute(new Float32Array(ns * 3), 3);
      this._flightShipsGeom.setAttribute("position", posAttr);
      this._flightShipsGeom.setAttribute("color", colAttr);
    }
    for (let i = 0; i < ns; i++) {
      const s = ships[i];
      posAttr.setXYZ(i, auTo3D(s.x), auTo3D(s.z), -auTo3D(s.y));
      if (s.connected === false) colAttr.setXYZ(i, 0.55, 0.55, 0.55);
      else if (s.direction === "EM") colAttr.setXYZ(i, 0.07, 0.78, 1.0);
      else colAttr.setXYZ(i, 1.0, 0.31, 0.85);
    }
    posAttr.needsUpdate = true; colAttr.needsUpdate = true;
    this._flightShipsGeom.setDrawRange(0, ns);
    if (ns) this._flightShipsGeom.computeBoundingSphere();

    // Extension links — 2 vertices per link, in place.
    const links = fd.links || [];
    const nl = links.length;
    let lAttr = this._flightLinksGeom.getAttribute("position");
    if (lAttr.count !== nl * 2) {
      lAttr = new THREE.BufferAttribute(new Float32Array(nl * 2 * 3), 3);
      this._flightLinksGeom.setAttribute("position", lAttr);
    }
    for (let i = 0; i < nl; i++) {
      const l = links[i];
      if (!l.from || !l.to) continue;
      lAttr.setXYZ(i * 2, auTo3D(l.from.x), auTo3D(l.from.z), -auTo3D(l.from.y));
      lAttr.setXYZ(i * 2 + 1, auTo3D(l.to.x), auTo3D(l.to.z), -auTo3D(l.to.y));
    }
    lAttr.needsUpdate = true;
    this._flightLinksGeom.setDrawRange(0, nl * 2);
    if (nl) this._flightLinksGeom.computeBoundingSphere();

    // Arcs — rebuild only when the set of (cached) polylines changes.
    const arcs = fd.arcs || [];
    const same = this._flightArcRefs && this._flightArcRefs.length === arcs.length && this._flightArcRefs.every((a, i) => a === arcs[i]);
    if (!same) {
      for (const child of this._flightArcsGroup.children) child.geometry.dispose();
      this._flightArcsGroup.clear();
      for (const arc of arcs) {
        if (!arc || arc.length < 2) continue;
        const pts = new Float32Array(arc.length * 3);
        for (let i = 0; i < arc.length; i++) { pts[i * 3] = auTo3D(arc[i].x); pts[i * 3 + 1] = auTo3D(arc[i].z); pts[i * 3 + 2] = -auTo3D(arc[i].y); }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(pts, 3));
        this._flightArcsGroup.add(new THREE.Line(geom, this._flightArcMat));
      }
      this._flightArcRefs = arcs.slice();
    }
  }

  // ── Coverage-probe overlay (Monte-Carlo independent point cloud + access links) ──
  // A Points cloud for the probe markers and a LineSegments buffer for the access
  // links (probe → backbone node), both updated in place. Probes are static, so
  // positions only change when the cloud is resampled.
  _initProbeOverlay() {
    if (this._probeInit) return;
    this._probeInit = true;

    // Round sprite for the probe point markers.
    const cnv = document.createElement("canvas"); cnv.width = cnv.height = 64;
    const cx = cnv.getContext("2d");
    const grd = cx.createRadialGradient(32, 32, 0, 32, 32, 30);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.6, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    cx.fillStyle = grd; cx.beginPath(); cx.arc(32, 32, 30, 0, Math.PI * 2); cx.fill();
    const probeTex = new THREE.CanvasTexture(cnv);

    this._probeLinksGeom = new THREE.BufferGeometry();
    this._probeLinksGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this._probeLinksMat = new THREE.LineBasicMaterial({ color: 0x66c8ff, transparent: true, opacity: 0.3 });
    this._probeLinks = new THREE.LineSegments(this._probeLinksGeom, this._probeLinksMat);
    this._probeLinks.frustumCulled = false;
    this._probeLinks.renderOrder = 2;
    this.scene.add(this._probeLinks);

    this._probePointsGeom = new THREE.BufferGeometry();
    this._probePointsGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    this._probePointsGeom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
    this._probePointsMat = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, map: probeTex, vertexColors: true, transparent: true, alphaTest: 0.3, depthWrite: false });
    this._probePoints = new THREE.Points(this._probePointsGeom, this._probePointsMat);
    this._probePoints.frustumCulled = false;
    this._probePoints.renderOrder = 3;
    this.scene.add(this._probePoints);
  }

  setProbeData(data) {
    this.probeData = data || { probes: [], links: [] };
    if (!this.scene) return;
    this._initProbeOverlay();
    const pd = this.probeData;

    // Probe markers — update position + color in place (resize only on count change).
    const probes = pd.probes || [];
    const np = probes.length;
    let posAttr = this._probePointsGeom.getAttribute("position");
    let colAttr = this._probePointsGeom.getAttribute("color");
    if (posAttr.count !== np) {
      posAttr = new THREE.BufferAttribute(new Float32Array(np * 3), 3);
      colAttr = new THREE.BufferAttribute(new Float32Array(np * 3), 3);
      this._probePointsGeom.setAttribute("position", posAttr);
      this._probePointsGeom.setAttribute("color", colAttr);
    }
    for (let i = 0; i < np; i++) {
      const p = probes[i];
      posAttr.setXYZ(i, auTo3D(p.x), auTo3D(p.z), -auTo3D(p.y));
      if (p.connected === false) colAttr.setXYZ(i, 0.6, 0.6, 0.65);       // grey — no link
      else if (p.connected) colAttr.setXYZ(i, 0.35, 0.9, 0.66);           // green — linked
      else colAttr.setXYZ(i, 0.85, 0.85, 0.9);                            // pale — not yet measured
    }
    posAttr.needsUpdate = true; colAttr.needsUpdate = true;
    this._probePointsGeom.setDrawRange(0, np);
    if (np) this._probePointsGeom.computeBoundingSphere();

    // Access links — 2 vertices per link, in place.
    const links = pd.links || [];
    const nl = links.length;
    let lAttr = this._probeLinksGeom.getAttribute("position");
    if (lAttr.count !== nl * 2) {
      lAttr = new THREE.BufferAttribute(new Float32Array(nl * 2 * 3), 3);
      this._probeLinksGeom.setAttribute("position", lAttr);
    }
    for (let i = 0; i < nl; i++) {
      const l = links[i];
      if (!l.from || !l.to) continue;
      lAttr.setXYZ(i * 2, auTo3D(l.from.x), auTo3D(l.from.z), -auTo3D(l.from.y));
      lAttr.setXYZ(i * 2 + 1, auTo3D(l.to.x), auTo3D(l.to.z), -auTo3D(l.to.y));
    }
    lAttr.needsUpdate = true;
    this._probeLinksGeom.setDrawRange(0, nl * 2);
    if (nl) this._probeLinksGeom.computeBoundingSphere();
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
    const isCapMode = this.linksColorsType === "Capacity";
    const isColorMode = isFlowMode || isCapMode;
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
    if (isColorMode) this.lastLinkRange = { type: this.linksColorsType, min: minVal, max: maxVal };

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
      if ((isFlowMode && isActive) || isCapMode) {
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
   * Handles mouse-wheel events as a forward/backward translation ("fly")
   * instead of OrbitControls' dolly-zoom. Scrolling up moves the camera toward
   * what it is looking at; scrolling down pulls it back. Both the camera and the
   * orbit target move by the same vector, so the orbit pivot travels with the
   * camera and rotation continues to behave normally.
   *
   * @param {WheelEvent} event - The wheel event.
   */
  onWheel(event) {
    event.preventDefault();

    // Direction the camera is looking (from the camera toward the orbit target).
    const forward = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();

    // Step scales with distance from the Sun so motion feels consistent across
    // scene scales; floored so we never stall near the center.
    const dist = Math.max(this.camera.position.length(), 0.5);
    const step = -event.deltaY * 0.0005 * dist; // scroll up (deltaY < 0) => forward

    forward.multiplyScalar(step);
    this.camera.position.add(forward);
    this.controls.target.add(forward);
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

    // Remove the custom wheel ("fly forward") listener
    if (this._onWheel && this.renderer) {
      this.renderer.domElement.removeEventListener("wheel", this._onWheel);
    }

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
