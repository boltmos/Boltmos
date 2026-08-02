import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const MODEL_URL = '../assets/Lyra.vrm';

const canvas = document.getElementById('character-canvas');

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  20,
);
camera.position.set(0, 0.6, 1.9);
camera.lookAt(new THREE.Vector3(0, 0.6, 0));
camera.updateProjectionMatrix();

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
directionalLight.position.set(1, 1.5, 1).normalize();
scene.add(directionalLight);

const MODEL_BASE_Y = -0.65;

const lookAtTarget = new THREE.Object3D();
lookAtTarget.position.set(0, 1.3 + MODEL_BASE_Y, 1.5);
scene.add(lookAtTarget);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

let currentVrm = null;
const clock = new THREE.Clock();

function applyIdlePose(vrm) {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm');
  const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
  const leftLowerArm = humanoid.getNormalizedBoneNode('leftLowerArm');
  const rightLowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');

  leftUpperArm.rotation.z = -1.3;
  leftUpperArm.rotation.x = 0.1;

  rightUpperArm.rotation.z = 1.3;
  rightUpperArm.rotation.x = 0.1;

  leftLowerArm.rotation.z = -0.05;
  rightLowerArm.rotation.z = 0.05;
}

loader.load(
  MODEL_URL,
  (gltf) => {
    const vrm = gltf.userData.vrm;

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    if (vrm.meta?.metaVersion === '0') {
      VRMUtils.rotateVRM0(vrm);
    }

    if (vrm.lookAt) {
      vrm.lookAt.target = lookAtTarget;
    }

    applyIdlePose(vrm);

    if (vrm.expressionManager) {
      vrm.expressionManager.setValue('blink', 0);
    }

    scene.add(vrm.scene);
    currentVrm = vrm;

    setTimeout(() => {
      startBlinkInterval();
    }, 3000);
  },
  (progress) => {
    if (progress.total) {
      const percent = ((progress.loaded / progress.total) * 100).toFixed(0);
      console.log(`Loading Lyra.vrm: ${percent}%`);
    }
  },
  (error) => {
    console.error('Failed to load Lyra.vrm:', error);
  },
);

const mouse = new THREE.Vector2(0, 0);

window.addEventListener('mousemove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
});

function updateLookAtTarget() {
  lookAtTarget.position.x = mouse.x * 0.5;
  lookAtTarget.position.y = 1.3 + MODEL_BASE_Y + mouse.y * 0.3;
}

let blinkStarted = false;
let nextBlinkAt = 0;

function randomBlinkDelay() {
  return 4000 + Math.random() * 4000;
}

function startBlinkInterval() {
  blinkStarted = true;
  nextBlinkAt = performance.now() + randomBlinkDelay();
}

function updateBlink(now) {
  const expressionManager = currentVrm?.expressionManager;
  if (!expressionManager || !blinkStarted) return;

  if (now >= nextBlinkAt) {
    expressionManager.setValue('blink', 1.0);
    setTimeout(() => {
      expressionManager.setValue('blink', 0.0);
    }, 120);
    nextBlinkAt = now + randomBlinkDelay();
  }
}

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  if (currentVrm) {
    currentVrm.scene.position.y = MODEL_BASE_Y + Math.sin(elapsed * 1.2) * 0.01;

    updateLookAtTarget();
    updateBlink(performance.now());

    currentVrm.update(delta);
  }

  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
