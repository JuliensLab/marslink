
import * as THREE from "three";
import WebGPURenderer from "three/addons/renderers/webgpu/WebGPURenderer.js";
import {
    float, vec3, vec4, color, instanceIndex, storage,
    uniform, texture, MeshBasicNodeMaterial,
    Fn, math, sin, cos, atan, sqrt, tan, distance,
    PI, positionLocal, timerLocal
} from "three/addons/nodes/Nodes.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js?v=4.3";
import { SIM_CONSTANTS } from "./simConstants.js";

/**
 * SimDisplayWebGPU
 * 
 * A WebGPU implementation of the Marslink visualization.
 * - Replaces GPUComputationRenderer with Storage Buffers.
 * - Uses TSL (Three Shading Language) for Compute and Render shaders.
 * - Optimized for 100k+ instances.
 */
export class SimDisplayWebGPU {
    constructor(container = document.body) {
        this.container = container;
        this.simSatellites = null;

        // Settings
        this.fov = 45;
        this.sunSizeFactor = 1;
        this.planetSizeFactor = 1;
        this.satelliteSizeFactor = 1;

        // Scene
        this.scene = new THREE.Scene();
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        // Buffers
        this.satellitesBuffer = null; // StorageBuffer
        this.satellitesCount = 0;

        // Compute Node
        this.computeNode = null;

        // Meshes
        this.satellitesMesh = null;
        this.linksMesh = null;

        this.init();
    }

    async init() {
        const width = this.container.clientWidth || window.innerWidth;
        const height = this.container.clientHeight || window.innerHeight;

        // 1. Setup Camera
        this.camera = new THREE.PerspectiveCamera(this.fov, width / height, 0.0001, 10000000);
        this.camera.position.set(0, 5, 5);
        this.camera.up.set(0, 0, 1);

        // 2. Setup WebGPU Renderer
        try {
            this.renderer = new WebGPURenderer({ antialias: true, alpha: true });
            this.renderer.setSize(width, height);
            this.renderer.setPixelRatio(window.devicePixelRatio);
            // this.renderer.toneMapping = THREE.LinearToneMapping; 
            this.container.appendChild(this.renderer.domElement);
        } catch (e) {
            console.error("WebGPU Not Supported or Modules Missing", e);
            const errorDiv = document.createElement('div');
            errorDiv.style.color = 'red';
            errorDiv.style.fontSize = '20px';
            errorDiv.textContent = 'WebGPU Initialization Failed. Check Console.';
            this.container.appendChild(errorDiv);
            return;
        }

        // 3. Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;

        // 4. Lights & Environment
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);
        this.scene.background = new THREE.Color(0x000005);

        // 5. Start Loop
        this.renderer.setAnimationLoop(this.render.bind(this));
    }

    /**
     * Initializes the satellite buffers and compute shaders.
     * Called when satellites are generated in SimMain.
     */
    setSatellites(satellites) {
        this.satellitesCount = satellites.length;
        if (this.satellitesCount === 0) return;

        // --- Data Layout ---
        // We pack orbital elements and state into a single storage buffer for efficiency.
        // Array Stride: 16 floats (vec4 * 4) per satellite to keep alignment simple
        // Struct:
        //  0-3: Position (x, y, z, w=unused) - WRITTEN by Compute
        //  4-7: Elements1 (a, e, i, Om) - READ ONLY
        //  8-11: Elements2 (w, M0, n, scale) - READ ONLY
        //  12-15: State (Vis, unused, unused, unused) - READ/WRITE

        const data = new Float32Array(this.satellitesCount * 16);

        for (let i = 0; i < this.satellitesCount; i++) {
            const s = satellites[i];
            const base = i * 16;

            // Normalize elements (similar to GLSL logic)
            let Om = s.Om ?? s.o;
            let w = s.w ?? (s.p - s.o);
            let M0 = s.M0 ?? (s.l - s.p);
            // Ensure radians
            const degToRad = Math.PI / 180;

            // Elements 1
            data[base + 4] = s.a;
            data[base + 5] = s.e;
            data[base + 6] = s.i * degToRad;
            data[base + 7] = Om * degToRad;

            // Elements 2
            data[base + 8] = w * degToRad;
            data[base + 9] = M0 * degToRad;
            data[base + 10] = s.n * degToRad; // rad/day? need to check time unit
            data[base + 11] = 1.0; // scale placeholder
        }

        // Create Storage Buffer
        this.satellitesBuffer = new THREE.InstancedBufferAttribute(data, 16);
        // We can access it as a node: storage( bufferAttribute, type, count )
        // Using 'storage' allows read/write in compute shaders
        // For rendering, we can use it as attribute or uniform buffer

        // TSL Compute Shader
        // Note: In Three R170 TSL, we define a compute node

        // Accessors
        const satelliteStorage = storage(this.satellitesBuffer, 'vec4', this.satellitesCount * 4); // Access as vec4 array
        // Stride is 4 vec4s per satellite. 
        // Index i -> 
        //   pos = satelliteStorage.element(i * 4 + 0)
        //   el1 = satelliteStorage.element(i * 4 + 1)
        //   el2 = satelliteStorage.element(i * 4 + 2)

        const time = timerLocal(); // Uniform time

        // Define the Compute Kernel
        const computePhysics = Fn(() => {
            const index = instanceIndex; // Global invocation ID
            const stride = index.mul(4);

            const el1 = satelliteStorage.element(stride.add(1));
            const el2 = satelliteStorage.element(stride.add(2));

            const a = el1.x;
            const e = el1.y;
            const i = el1.z;
            const Om = el1.w;

            const w = el2.x;
            const M0 = el2.y;
            const n = el2.z;

            // Kepler Logic (Simplified for TSL POC)
            // M = M0 + n * time
            const M = M0.add(n.mul(time)).mod(PI.mul(2.0));

            // Iterative Solver (Newton)
            // E = M; (Initial guess)
            let E = M;
            // Loop 5 times
            // Since TSL loops are tricky in early versions, standard unroll or 'loop' node
            // For now, let's do 3 manual iterations or use approximate
            // E = E - (E - e*sin(E) - M) / (1 - e*cos(E))

            // Iteration 1
            const f1 = E.sub(e.mul(sin(E))).sub(M);
            const df1 = float(1.0).sub(e.mul(cos(E)));
            E = E.sub(f1.div(df1));

            // Iteration 2
            const f2 = E.sub(e.mul(sin(E))).sub(M);
            const df2 = float(1.0).sub(e.mul(cos(E)));
            E = E.sub(f2.div(df2));
            // Iteration 3
            const f3 = E.sub(e.mul(sin(E))).sub(M);
            const df3 = float(1.0).sub(e.mul(cos(E)));
            E = E.sub(f3.div(df3));

            // True Anomaly v
            const v = float(2.0).mul(atan(sqrt(float(1.0).add(e).div(float(1.0).sub(e))).mul(tan(E.div(2.0)))));
            const r = a.mul(float(1.0).sub(e.mul(cos(E))));

            // Helio Coordinates
            const x_orb = r.mul(cos(v));
            const y_orb = r.mul(sin(v));

            const cosOm = cos(Om);
            const sinOm = sin(Om);
            const u = w.add(v); // Argument of Latitude

            const x = r.mul(cos(u).mul(cosOm).sub(sin(u).mul(sinOm).mul(cos(i))));
            const y = r.mul(cos(u).mul(sinOm).add(sin(u).mul(cosOm).mul(cos(i))));
            const z = r.mul(sin(u).mul(sin(i)));

            // Write Output (y->z swap as per original)
            // Original: x, z, -y
            satelliteStorage.element(stride).assign(vec4(x, z, y.negate(), 1.0));
        });

        // Create the Compute Node
        // We run this for every satellite
        this.computeNode = computePhysics().compute(this.satellitesCount);

        this.createSatellitesMesh(satelliteStorage);
    }

    createSatellitesMesh(storageNode) {
        if (this.satellitesMesh) {
            this.scene.remove(this.satellitesMesh);
            this.satellitesMesh.geometry.dispose();
        }

        const geometry = new THREE.CylinderGeometry(0.1, 0.1, 1.0, 6);

        // TSL Material
        const material = new MeshBasicNodeMaterial();
        material.colorNode = color(0xffffff);

        // Vertex Position Logic
        // We need to read the position from the storage buffer using the instance index
        const index = instanceIndex;
        const stride = index.mul(4);
        const worldPos = storageNode.element(stride).xyz;

        // Apply position to vertex
        // positionLocal is the vertex model position
        // We scale it and add worldPos
        const scale = float(0.001); // TODO: Make dynamic
        material.positionNode = positionLocal.mul(scale).add(worldPos);

        this.satellitesMesh = new THREE.InstancedMesh(geometry, material, this.satellitesCount);
        this.satellitesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // Not really used if we override positionNode

        this.scene.add(this.satellitesMesh);
    }

    render() {
        if (this.renderer) {
            // 1. Dispatch Compute
            if (this.computeNode) {
                this.renderer.compute(this.computeNode);
            }

            // 2. Render Scene
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        }
    }

    // Stub setup methods to match interface
    setSizeFactors() { }
    setLinksColors() { }
    setSatelliteColorMode() { }
}
