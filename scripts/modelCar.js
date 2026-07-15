// carModel.js

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js?v=4.41";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js?v=4.41";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js?v=4.41";

// Function to load and create a car model. `scaleFactor` may be a number OR a getter
// () => number, read when the (async) model finishes loading — so the roadster picks up
// its size factor even though it loads after setRoadsterSizeFactor() has already run.
export function createCarModel(THREE, planetData, scene, planets, scaleFactor = 1) {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("./scripts/imported/draco/");

  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  loader.load("./model3d/ferrari/ferrari.glb", (gltf) => {
    const carModel = gltf.scene.children[0];

    // Customize car materials
    const bodyMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xff0000,
      metalness: 1.0,
      roughness: 0.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
    });
    const detailsMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 1.0,
      roughness: 0.5,
    });
    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0.25,
      roughness: 0,
      transmission: 1.0,
    });

    carModel.getObjectByName("body").material = bodyMaterial;
    ["rim_fl", "rim_fr", "rim_rr", "rim_rl", "trim"].forEach((partName) => {
      carModel.getObjectByName(partName).material = detailsMaterial;
    });
    carModel.getObjectByName("glass").material = glassMaterial;

    // Adjust scaling and position for the solar system. Read the factor NOW (the model
    // loaded async) so a roadster size set before the model existed still applies.
    const factor = typeof scaleFactor === "function" ? scaleFactor() : scaleFactor;
    const scale = 0.001 * factor;
    carModel.scale.set(scale, scale, scale);
    carModel.position.set(0, 0, 0);

    carModel.castShadow = true;
    carModel.receiveShadow = true;

    carModel.isRoadster = true;
    carModel.params = planetData; // Store parameters if needed
    scene.add(carModel);
    planets[planetData.name] = carModel;
  });
}
