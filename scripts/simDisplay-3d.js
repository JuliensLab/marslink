// simDisplay-3d.js

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js?v=4.3";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js?v=4.3";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js?v=4.3";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js?v=4.3";
import { SimSolarSystem } from "./simSolarSystem.js?v=4.3";
import { createCarModel } from "./modelCar.js?v=4.3";
import { GPUComputationRenderer } from "./imported/three/addons/misc/GPUComputationRenderer.js";

const satelliteVertexShader = `
uniform sampler2D positionTexture;
attribute vec2 reference;
varying vec3 vColor;
varying float vVisibility;

void main() {
    vec3 pos = texture2D(positionTexture, reference).xyz;
    float visibility = texture2D(positionTexture, reference).w;
    
    // Simple logic: if w is negative, it's invisible/unused
    vVisibility = visibility;
    
    // Position the vertex: object space position + instance world position
    vec3 transformed = position + pos;
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    
    // Pass color to fragment shader (can be uniform or attribute based)
    vColor = vec3(1.0); 
}
`;

const satelliteFragmentShader = `
varying vec3 vColor;
varying float vVisibility;

void main() {
    if (vVisibility < 0.0) discard;
    gl_FragColor = vec4(vColor, 1.0);
}
`;

const positionShaderFragment = `
uniform float time;
uniform sampler2D textureElements; // a, e, i, Om
uniform sampler2D textureElements2; // w, M0, n, scale

#define PI 3.1415926535897932384626433832795

void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 elements1 = texture2D(textureElements, uv);
    vec4 elements2 = texture2D(textureElements2, uv);

  if (elements1.x == 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, -1.0); // Invisible
    return;
  }

    float a = elements1.x;
    float e = elements1.y;
  // Clamp eccentricity to avoid NaN in Kepler solver or hyperbolic orbits
  if (e >= 1.0) e = 0.99;
  if (e < 0.0) e = 0.0;

    float i = elements1.z;
    float Om = elements1.w;
    
    float w = elements2.x;
    float M0 = elements2.y;
    float n = elements2.z;
    float scale = elements2.w;

    // Mean Anomaly at time t
    float M = mod(M0 + n * time, 2.0 * PI);

    // Solve Kepler's Equation for Eccentric Anomaly E
    // M = E - e * sin(E)
    // Iterative approximation
    float E = M;
  if (e > 0.8) E = PI; // Initial guess for high eccentricity

  for (int j = 0; j < 5; j++) {
        float f = E - e * sin(E) - M;
        float df = 1.0 - e * cos(E);
    E = E - f / df;
  }

    // True Anomaly v
    float v = 2.0 * atan(sqrt((1.0 + e) / (1.0 - e)) * tan(E / 2.0));

    // Distance r
    float r = a * (1.0 - e * cos(E));

    // Heliocentric coordinates in orbital plane
    float x_orb = r * cos(v);
    float y_orb = r * sin(v);

    // Coordinate transformation to 3D space
    // Using Euler angles (Om, i, w)
    
    float cosOm = cos(Om);
    float sinOm = sin(Om);

    // Optimized combined rotation
    float u = w + v;
    
    float x = r * (cos(u) * cosOm - sin(u) * sinOm * cos(i));
    float y = r * (cos(u) * sinOm + sin(u) * cosOm * cos(i));
    float z = r * (sin(u) * sin(i));

  // Apply scale and coordinate swap (y -> z, z -> -y)
  gl_FragColor = vec4(x * scale, z * scale, -y * scale, 1.0);
}
`;


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
    this.linksGroup = new THREE.Group();
    this.scene.add(this.linksGroup);
    this.linkLabelsGroup = new THREE.Group();
    this.scene.add(this.linkLabelsGroup);

    // Initialize links arrays
    this.possibleLinks = [];
    this.activeLinks = [];
    this.linkLabels = [];
    this.showLinkLabels = false; // Flag for 'L' key press

    // Link Shaders
    const linkVertexShader = `
        uniform sampler2D positionTexture;
        uniform vec3 color;
        attribute vec2 satelliteUV; 
        attribute vec3 linkColor;
        varying vec3 vColor;

void main() {
            vec3 pos = texture2D(positionTexture, satelliteUV).xyz;
            float vis = texture2D(positionTexture, satelliteUV).w;

  // If satellite is invisible, we might want to hide the link too
  // But for now let's just project it.

  vColor = linkColor;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

    const linkFragmentShader = `
        varying vec3 vColor;
        uniform float opacity;
void main() {
  gl_FragColor = vec4(vColor, opacity);
}
`;

    this.linkMaterial = new THREE.ShaderMaterial({
      uniforms: {
        positionTexture: { value: null },
        opacity: { value: 0.2 }
      },
      vertexShader: linkVertexShader,
      fragmentShader: linkFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

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

  initGPGPU(satellites) {
    const count = satellites.length;
    if (count === 0) return;

    // Determine texture size (power of 2 is best, but square is fine)
    const width = Math.ceil(Math.sqrt(count));
    this.gpuComputeWidth = width;

    this.gpuCompute = new GPUComputationRenderer(width, width, this.renderer);

    if (this.renderer.capabilities.isWebGL2 === false) {
      this.gpuCompute.setDataType(THREE.HalfFloatType);
    }

    const dtElements1 = this.gpuCompute.createTexture();
    const dtElements2 = this.gpuCompute.createTexture();

    this.fillTextures(satellites, dtElements1, dtElements2);

    this.positionVariable = this.gpuCompute.addVariable("texturePosition", positionShaderFragment, dtElements1); // Initial texture doesn't matter much if we overwrite

    this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable]);

    this.positionVariable.material.uniforms["textureElements"] = { value: dtElements1 };
    this.positionVariable.material.uniforms["textureElements2"] = { value: dtElements2 };
    this.positionVariable.material.uniforms["time"] = { value: 0 };

    const error = this.gpuCompute.init();
    if (error !== null) {
      console.error("GPGPU init error:", error);
    } else {
      console.log("GPGPU init success");
    }
  }

  fillTextures(satellites, texture1, texture2) {
    const data1 = texture1.image.data;
    const data2 = texture2.image.data;

    for (let i = 0; i < satellites.length; i++) {
      const sat = satellites[i];

      // Convert orbital elements if needed (SimSatellites uses o, p, l; GPGPU uses Om, w, M0)
      let Om = sat.Om;
      let w = sat.w;
      let M0 = sat.M0;

      if (Om === undefined && sat.o !== undefined) Om = sat.o;
      if (w === undefined && sat.p !== undefined && sat.o !== undefined) w = sat.p - sat.o;
      if (M0 === undefined && sat.l !== undefined && sat.p !== undefined) M0 = sat.l - sat.p;

      // Normalize to 0-360
      if (w !== undefined) w = ((w % 360) + 360) % 360;
      if (M0 !== undefined) M0 = ((M0 % 360) + 360) % 360;

      // Validation Check
      if (isNaN(sat.a) || isNaN(sat.e) || isNaN(sat.i) || isNaN(Om) || isNaN(w) || isNaN(M0) || isNaN(sat.n)) {
        console.warn(`[SimDisplay] NaN element detected for satellite ${i}(${sat.name}): a = ${sat.a}, e = ${sat.e}, n = ${sat.n}, Om = ${Om}, w = ${w}, M0 = ${M0} `);
      }

      // data1: a, e, i, Om
      data1[i * 4 + 0] = sat.a;
      data1[i * 4 + 1] = sat.e;
      data1[i * 4 + 2] = sat.i * (Math.PI / 180); // Convert to radians
      data1[i * 4 + 3] = Om * (Math.PI / 180);

      // data2: w, M0, n, scale
      data2[i * 4 + 0] = w * (Math.PI / 180);
      data2[i * 4 + 1] = M0 * (Math.PI / 180) || 0; // Mean anomaly at epoch
      data2[i * 4 + 2] = sat.n * (Math.PI / 180); // Mean motion (deg/day -> rad/day)
      // We will pass 'simDaysSinceStart' as time.

      data2[i * 4 + 3] = auTo3D(1.0); // Pass scale factor here to be safe

      if (i < 10) {
        console.log(`[SimDisplay] Sat ${i}: a = ${sat.a}, e = ${sat.e}, i = ${sat.i}, Om = ${Om}, w = ${to360(w)}, M0 = ${to360(M0)}, n = ${sat.n} `);
        console.log(`[SimDisplay] Texture Data1 for ${i}: `, data1.slice(i * 4, i * 4 + 4));
        console.log(`[SimDisplay] Texture Data2 for ${i}: `, data2.slice(i * 4, i * 4 + 4));
      }
    }

    function to360(angle) {
      if (angle === undefined) return 'undef';
      return ((angle % 360) + 360) % 360;
    }
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
    // this.linksMaterial = new THREE.LineBasicMaterial({
    //   vertexColors: true, // Enable vertex colors
    //   transparent: true,
    //   opacity: 1.0, // Full opacity; control transparency via color if needed
    // });
    //
    // this.linksGeometry = new THREE.BufferGeometry();
    // this.linksLineSegments = new THREE.LineSegments(this.linksGeometry, this.linksMaterial);
    // this.linksLineSegments.frustumCulled = false; // Optional
    // this.scene.add(this.linksLineSegments);

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
    const fontSize = 48;
    context.font = `${fontSize}px Arial`;
    const textWidth = context.measureText(text).width;
    canvas.width = textWidth + 20;
    canvas.height = fontSize + 20;
    context.fillStyle = "rgba(255, 255, 255, 1)";
    context.fillText(text, 10, fontSize + 5);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(0.05, 0.05, 1); // Adjust scale as needed
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

    this.currentSatelliteScale = satelliteScaleFactor;
    if (this.satellitesMesh && this.satellitesMesh.material.uniforms.uScale) {
      this.satellitesMesh.material.uniforms.uScale.value = this.currentSatelliteScale;
    }

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
    // Update satellites geometry scale
    // Scaling is handled in updatePositions when recreating meshes
    this.currentSatelliteScale = satelliteScaleFactor;
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
  setSatellites(satellites) {
    this.clearGroup(this.satellitesGroup);

    if (satellites.length === 0) return;

    // Initialize GPGPU if not already compatible or count changed drastically (simplified: re-init if not present)
    // For now, always re-init when setSatellites is called (assuming it's called on config change, not every frame)
    this.initGPGPU(satellites);
    this.satellitesCount = satellites.length;

    // Geometry
    const scale = 0.0001; // Base scale, dynamic scaling via uScale uniform
    const geometry = new THREE.CylinderGeometry(20, 20, 30, 6); // Base size, scaled by shader/matrix or minimal size
    geometry.scale(scale, scale, scale);

    // We need InstanceBufferGeometry to pass 'reference' attribute
    const ibGeometry = new THREE.InstancedBufferGeometry();
    ibGeometry.copy(geometry);

    this.satelliteUVMap = new Map();
    const references = new Float32Array(this.satellitesCount * 2);
    for (let i = 0; i < this.satellitesCount; i++) {
      const x = (i + 0.5) / this.gpuComputeWidth;
      const y = (Math.floor(i / this.gpuComputeWidth) + 0.5) / this.gpuComputeWidth;
      references[i * 2] = x;
      references[i * 2 + 1] = y;

      // Store UV for links
      // Assumes satellites[i].name is unique
      this.satelliteUVMap.set(satellites[i].name, { x, y });
    }

    ibGeometry.setAttribute('reference', new THREE.InstancedBufferAttribute(references, 2));
    ibGeometry.instanceCount = this.satellitesCount;

    // Material
    const material = new THREE.ShaderMaterial({
      uniforms: {
        positionTexture: { value: null },
        uScale: { value: this.currentSatelliteScale }
      },
      vertexShader: satelliteVertexShader,
      fragmentShader: satelliteFragmentShader,
      transparent: false, // Optimization
      side: THREE.DoubleSide,
    });

    this.satellitesMesh = new THREE.Mesh(ibGeometry, material);
    this.satellitesMesh.frustumCulled = false; // Important: vertices are displaced by shader
    this.satellitesGroup.add(this.satellitesMesh);

    // Links GPGPU Setup (Plan for next step: create geometry for links)
    // We will initialize links geometry here or in updateLinks
  }

  /**
   * Updates the 3D scene with new planets positions, satellites, and links data.
   *
   * @param {Object} planetsPositions - An object mapping planet names to positions { x, y, z }.
   * @param {Array} satellitesPositions - Array of satellite position objects [{ x, y, z }, ...].
   * @param {Array} links - Array of link objects with properties:
   *                        { fromId: string, toId: string, gbpsFlow: number, ... }.
   */
  updatePositions(planets, satellites, simTimeDays) {
    if (!this.gpuCompute) return;

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
      }
    }

    // === GPGPU COMPUTE ===
    // Update time for the compute shader
    this.positionVariable.material.uniforms["time"].value = simTimeDays; // Passing raw sim days? Need to check if n is in rad/day
    this.gpuCompute.compute();

    // DEBUG: Read back one pixel to verify GPGPU output
    // Run this only once per second roughly
    if (!this.lastDebugTime || Date.now() - this.lastDebugTime > 1000) {
      this.lastDebugTime = Date.now();
      const rt = this.gpuCompute.getCurrentRenderTarget(this.positionVariable);
      const pixelBuffer = new Float32Array(4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, pixelBuffer);
      console.log(`[GPU Debug]Time: ${simTimeDays.toFixed(2)}, Pixel[0](Pos): x = ${pixelBuffer[0].toFixed(3)}, y = ${pixelBuffer[1].toFixed(3)}, z = ${pixelBuffer[2].toFixed(3)}, w = ${pixelBuffer[3]} `);

      // Also check if texture input is valid (check first satellite params if possible? No, can't read internal texture easily unless variable)
      // But we can check if simTimeDays is progressing
    }

    // Get the new position texture
    const currentTexture = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;

    // Update Satellites Material
    if (this.satellitesMesh) {
      this.satellitesMesh.material.uniforms.positionTexture.value = currentTexture;
    }

    // === Update Links Positions ===
    this.updateLinksPositions();
  }

  updatePossibleLinks(links) {
    this.possibleLinks = links;
    // Combine with active links to get all potential lines to draw
    const allLinks = [...this.activeLinks, ...this.possibleLinks];
    this.rebuildLinksGeometry(allLinks);
  }

  updateActiveLinks(links) {
    this.activeLinks = links;
  }

  updateLinksPositions() {
    if (!this.gpuCompute) return;

    // We need to rebuild the geometry buffers only if links change or on init
    // But color updates happen here too.
    // For GPGPU links, we need:
    // 1. A buffer of 'satelliteUV' (vec2) for each vertex.
    // 2. A buffer of 'linkColor' (vec3) for each vertex.

    const activeLinkSet = new Set(this.activeLinks.map((link) => link.fromId + "_" + link.toId));

    // We can't display links involving Planets easily because Planets aren't in the texture!
    // GPGPU Links only support Satellite-Satellite links if we assume texture lookup.
    // If we want Planet-Satellite, we need to pass Planet positions as uniforms or put them in texture.
    // Current texture only has Satellites.
    // Workaround: Only render Satellite-Satellite links via GPGPU.
    // Render Planet links via CPU? Or put Planets in texture?
    // Planets list is small. We can pass them as uniforms array? Or just CPU lines for those.
    // The bottleneck is 100k satellite links.

    // Filter for Satellite-Only links for GPGPU optimization
    // Assuming 'fromId' and 'toId' are satellite names (e.g. ring_earth-0).
    // Planet names are "Earth", "Mars".
    const isSat = (id) => id.includes("-") || id.includes("ring");

    // For simplicity, let's just handle all links. If it's a planet, we need a fallback.
    // Actually, simply:
    // Let's create a mapping of name -> TextureUV in setSatellites.

    if (!this.satelliteUVMap) return;

    // Filter valid links (both ends must be in UV map)
    const validLinks = [];
    const allLinks = [...this.activeLinks, ...this.possibleLinks]; // Optim: maybe don't loop all if cached

    // Wait, looping 1M links in JS is slow! = 10ms for 1M simple ops?
    // We should avoid recreating buffers every frame.
    // The user said: "Remove activeLinks.filter loop in updateLinksPositions"
    // "Remove THREE.LineSegments with vertexColors"

    // Strategy:
    // Create a massive buffer ONCE (max links).
    // Update 'indices' or 'drawRange' or 'visibility attribute'?
    // If links are static (topology), we build geometry once.
    // Are links static?
    // "Satellites and Links" - Links might be dynamic (ISL).
    // But ISL usually follows a pattern (next/prev).
    // If the graph is static, we just build it once in setSatellites/setLinks.

    // Assumption: Topology is mostly static or updates infrequently (config change).
    // Flow/Active status changes frequently.

    // Let's implement rebuildLinksGeometry method called only when topology changes.
    // updatePositions should ONLY update colors/uniforms if needed (but even colors might be static-ish).
    // Actually, Flow visualization requires color updates.
    // Updating 1M colors attribute is slow? (Upload 12MB).
    // Maybe use a 'linkDataTexture' for flow status?
    // Too complex for now. Let's assume we build geometry once and update colors sparingly.

    // But wait, updatePositions called every frame.
    // We should NOT rebuild geometry here.

    // Pass the positionTexture to material.
    if (this.linksMesh && this.linksMesh.material.uniforms.positionTexture.value !== this.satellitesMesh.material.uniforms.positionTexture.value) {
      this.linksMesh.material.uniforms.positionTexture.value = this.satellitesMesh.material.uniforms.positionTexture.value;
    }
  }

  rebuildLinksGeometry(links) {
    if (!this.gpuCompute || !this.satelliteUVMap) return;

    // 1. Build buffers
    const positions = []; // Not used but needed by Three? We can verify.
    const satelliteUVs = [];
    const colors = [];

    // Only proces links where both ends are satellites in our texture
    // If planet links are needed, handle separately (CPU).

    let validCount = 0;
    const maxLinks = links.length;

    const uvs = new Float32Array(maxLinks * 2 * 2); // 2 vertices * 2 coords
    const cols = new Float32Array(maxLinks * 2 * 3); // 2 vertices * 3 rgb

    // For color, default to inactive
    const baseColor = new THREE.Color(this.styles.links.inactive.color);

    links.forEach((link, i) => {
      const uv1 = this.satelliteUVMap.get(link.fromId);
      const uv2 = this.satelliteUVMap.get(link.toId);

      if (uv1 && uv2) {
        uvs[validCount * 4 + 0] = uv1.x;
        uvs[validCount * 4 + 1] = uv1.y;
        uvs[validCount * 4 + 2] = uv2.x;
        uvs[validCount * 4 + 3] = uv2.y;

        cols[validCount * 6 + 0] = baseColor.r;
        cols[validCount * 6 + 1] = baseColor.g;
        cols[validCount * 6 + 2] = baseColor.b;

        cols[validCount * 6 + 3] = baseColor.r;
        cols[validCount * 6 + 4] = baseColor.g;
        cols[validCount * 6 + 5] = baseColor.b;

        validCount++;
      }
    });

    // Create Geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('satelliteUV', new THREE.BufferAttribute(uvs.slice(0, validCount * 4), 2));
    geometry.setAttribute('linkColor', new THREE.BufferAttribute(cols.slice(0, validCount * 6), 3));

    // Three.js needs 'position' attribute for bounding box? 
    // Shader ignores it, but Frustum Culling needs it.
    // Disable frustum culling for links or provide simple positions.
    // Providing 0s:
    const zeros = new Float32Array(validCount * 2 * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(zeros, 3));

    if (this.linksMesh) {
      this.linksGroup.remove(this.linksMesh);
      this.linksMesh.geometry.dispose();
    }

    this.linksMesh = new THREE.LineSegments(geometry, this.linkMaterial);
    this.linksMesh.frustumCulled = false;
    this.linksGroup.add(this.linksMesh);
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

    // Only show labels when 'L' key is pressed and display flow is not 'none'
    if (!this.showLinkLabels || this.linksColorsType === "None") return;

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
        // Determine display value based on linksColorsType
        let displayMbps = 0;
        if (this.linksColorsType === "Flow") {
          displayMbps = Math.round(link.gbpsFlow * 1000);
        } else if (this.linksColorsType === "Capacity") {
          displayMbps = Math.round(link.gbpsCapacity * 1000);
        }
        const label = this.createTextSprite(`${displayMbps} `);
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
