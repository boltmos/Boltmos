import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const MODEL_URL = '../assets/lyra6.vrm';

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

// These are only the seed/floor values used before the model loads. Once
// updateCameraFraming() is running (see below), it recalculates camera
// position every frame from the model's actual live bone positions, so the
// real on-screen distance/height come from CAMERA_FRAME_MARGIN and
// CAMERA_LOOK_Y_OFFSET, not these two constants directly.
const CAMERA_BASE_LOOK_Y = 0.532; // was 0.6 - shifted down by the same 0.068 as MODEL_BASE_Y so the look-at point stays fixed relative to her body
const CAMERA_BASE_DISTANCE = 1.471; // was 1.672 (-12%) - kept proportional to the framing zoom below, though it isn't the binding value at runtime

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  20,
);
camera.position.set(0, CAMERA_BASE_LOOK_Y, CAMERA_BASE_DISTANCE);
camera.lookAt(new THREE.Vector3(0, CAMERA_BASE_LOOK_Y, 0));
camera.updateProjectionMatrix();

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
directionalLight.position.set(1, 1.5, 1).normalize();
scene.add(directionalLight);

const MODEL_BASE_Y = -0.918; // was -0.85, moved down 8% (-0.068) to lower her in frame

const lookAtTarget = new THREE.Object3D();
lookAtTarget.position.set(0, 1.3 + MODEL_BASE_Y, 1.5);
scene.add(lookAtTarget);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

let currentVrm = null;
let modelReady = false;
let hasSpringBones = false;
const clock = new THREE.Clock();

console.log(`Lyra.vrm: calling GLTFLoader.load() with URL: ${MODEL_URL}`);

loader.load(
  MODEL_URL,
  (gltf) => {
    console.log('Lyra.vrm: GLTFLoader onLoad callback fired - VRM loaded successfully.');
    try {
      const vrm = gltf.userData.vrm;
      if (!vrm) {
        throw new Error(
          'gltf.userData.vrm is missing - the file loaded but was not recognized as a VRM (VRMLoaderPlugin found nothing).',
        );
      }

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

      // Resting arm/hand pose is expressed as the initial animState targets
      // (see below), not as a direct bone.rotation write here. The single
      // final lerp pass eases the bones into this pose on load instead of
      // snapping them, which reads as more natural than a hard pose-set.

      // Hair/cloth spring bones animate automatically inside vrm.update(delta),
      // as long as it's called every frame with an accurate delta (it is, from
      // THREE.Clock in animate() below). We only verify the manager exists;
      // there is no manual fallback animation, so an unrigged model will
      // simply have static hair.
      if (vrm.springBoneManager) {
        if (vrm.springBoneManager.joints.size > 0) {
          hasSpringBones = true;
          vrm.springBoneManager.joints.forEach((joint) => {
            if (joint.settings) {
              joint.settings.stiffness = Math.max(joint.settings.stiffness, 1.0);
            }
          });
          console.log(
            `Lyra.vrm: spring bone physics active (${vrm.springBoneManager.joints.size} joints).`,
          );
        } else {
          console.warn('Lyra.vrm: spring bone manager present but has no joints.');
        }
      } else {
        console.warn('Lyra.vrm: no spring bone hair configured on this model.');
      }

      if (vrm.expressionManager) {
        vrm.expressionManager.setValue('blink', 0);
        vrm.expressionManager.setValue('happy', 0);
        vrm.expressionManager.setValue('sad', 0);
      }

      setupMicroExpression(vrm);

      console.log('Lyra.vrm: vrm.scene object exists:', vrm.scene);
      scene.add(vrm.scene);
      console.log('Lyra.vrm: vrm.scene added to the Three.js scene via scene.add().');
      currentVrm = vrm;

      setTimeout(() => {
        modelReady = true;
      }, 500);

      startBlink();

      console.log('Lyra.vrm: setup complete, model added to scene.');
    } catch (error) {
      console.error('Lyra.vrm: error while setting up the loaded model:', error?.message ?? error);
      if (error?.stack) console.error(error.stack);
    }
  },
  (progress) => {
    if (progress.total) {
      const percent = ((progress.loaded / progress.total) * 100).toFixed(0);
      console.log(`Loading Lyra.vrm: ${percent}% (${progress.loaded}/${progress.total} bytes)`);
    } else {
      console.log(`Loading Lyra.vrm: ${progress.loaded} bytes loaded (total size unknown)`);
    }
  },
  (error) => {
    console.error('Failed to load Lyra.vrm:', error?.message ?? error);
    if (error?.stack) console.error(error.stack);
  },
);

const mouse = new THREE.Vector2(0, 0);
const CHARACTER_HOVER_RADIUS_PX = 120;
const chatContainer = document.getElementById('chat-container');

function isOverChatContainer(clientX, clientY) {
  if (!chatContainer) return false;
  const rect = chatContainer.getBoundingClientRect();
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

window.addEventListener('mousemove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  const distance = Math.hypot(event.clientX - centerX, event.clientY - centerY);

  const isInteractive =
    distance < CHARACTER_HOVER_RADIUS_PX || isOverChatContainer(event.clientX, event.clientY);

  window.boltmos?.setIgnoreMouseEvents(!isInteractive);
});

function updateLookAtTarget() {
  lookAtTarget.position.x = mouse.x * 0.5;
  lookAtTarget.position.y = 1.3 + MODEL_BASE_Y + mouse.y * 0.3;
}

let currentElapsed = 0;
let bounceActive = false;
let bounceStart = 0;

function startBlink() {
  const delay = 3000 + Math.random() * 5000;
  setTimeout(() => {
    const expressionManager = currentVrm?.expressionManager;
    if (!currentVrm || !modelReady || !expressionManager) {
      startBlink();
      return;
    }
    expressionManager.setValue('blink', 1.0);
    setTimeout(() => {
      expressionManager.setValue('blink', 0.0);
      startBlink();
    }, 120);
  }, delay);
}

const EXPRESSION_RESET_MS = 2000;
let expressionResetTimer = null;

function playExpression(name) {
  const expressionManager = currentVrm?.expressionManager;
  if (!expressionManager || !name) return;

  expressionManager.setValue(name, 1.0);

  clearTimeout(expressionResetTimer);
  expressionResetTimer = setTimeout(() => {
    expressionManager.setValue(name, 0.0);
  }, EXPRESSION_RESET_MS);
}

window.playExpression = playExpression;

// --- Expressiveness: continuous subtle facial life beyond blink. At load
// time we log every expression name this specific VRM actually exposes (they
// vary model to model), then - if it has any blend shape beyond blink and
// the standard named emotions/visemes/look directions - gently oscillate the
// first such shape (typically a brow- or eyelid-tension-style shape) at a
// slow, continuous, low-amplitude rate so the face never sits perfectly
// static between blinks. This is separate from, and does not touch, the
// blink/lookAt systems. ---
const KNOWN_EXPRESSION_NAMES = new Set([
  'blink', 'blinkLeft', 'blinkRight',
  'happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral',
  'aa', 'ih', 'ou', 'ee', 'oh',
  'lookUp', 'lookDown', 'lookLeft', 'lookRight',
]);

let microExpressionName = null;

function setupMicroExpression(vrm) {
  const expressionManager = vrm.expressionManager;
  if (!expressionManager) return;

  const allNames = Object.keys(expressionManager.expressionMap);
  console.log('Lyra.vrm: available expressions:', allNames);

  const extraNames = allNames.filter((name) => !KNOWN_EXPRESSION_NAMES.has(name));
  if (extraNames.length > 0) {
    microExpressionName = extraNames[0];
    console.log(
      `Lyra.vrm: extra expression blend shape(s) beyond blink/named emotions found, using "${microExpressionName}" for subtle micro-expression life:`,
      extraNames,
    );
  } else {
    console.log('Lyra.vrm: no extra expression blend shapes beyond blink/named emotions found.');
  }
}

function updateMicroExpression(elapsed) {
  if (!microExpressionName) return;
  const expressionManager = currentVrm?.expressionManager;
  if (!expressionManager) return;

  const tension = (Math.sin(elapsed * 0.12) * 0.5 + 0.5) * 0.15;
  expressionManager.setValue(microExpressionName, tension);
}

// ============================================================================
// Unified animation state. Every per-frame system below writes ONLY to these
// bone rotation targets, never to a bone.rotation property directly anywhere
// else in this file. A single pass at the end of animate() (applyAnimState)
// is the only place that reads animState and writes bone.rotation.
// ============================================================================
const ANIM_BONE_NAMES = [
  'chest',
  'spine',
  'hips',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
];

// Large slow-moving core bones ease in gently; smaller extremity bones can
// keep up with faster, snappier motion without looking laggy.
const LERP_SLOW = 0.045; // hips, spine, chest
const LERP_FAST = 0.08; // neck, head, shoulders, arms, hands
const SLOW_LERP_BONES = new Set(['chest', 'spine', 'hips']);

function lerpFactorFor(boneName) {
  return SLOW_LERP_BONES.has(boneName) ? LERP_SLOW : LERP_FAST;
}

// Resting arm pose lives here as the default target instead of being poked
// directly onto the bone at load time, so the single final lerp pass is the
// only thing that ever touches these bones' rotations.
const animState = {
  chest: { x: 0, y: 0, z: 0 },
  spine: { x: 0, y: 0, z: 0 },
  hips: { x: 0, y: 0, z: 0 },
  neck: { x: 0, y: 0, z: 0 },
  head: { x: 0, y: 0, z: 0 },
  leftShoulder: { x: 0, y: 0, z: 0 },
  rightShoulder: { x: 0, y: 0, z: 0 },
  leftUpperArm: { x: 0.1, y: 0, z: -1.3 },
  rightUpperArm: { x: 0.1, y: 0, z: 1.3 },
  leftLowerArm: { x: 0, y: 0, z: -0.05 },
  rightLowerArm: { x: 0, y: 0, z: 0.05 },
  leftHand: { x: 0, y: 0, z: 0 },
  rightHand: { x: 0, y: 0, z: 0 },
};

// Center point that the continuous arm sway oscillates around.
const ARM_REST_Z = { leftUpperArm: -1.3, rightUpperArm: 1.3 };

// --- Breathing: animState.chest.x and animState.spine.x, continuous, never stops ---
function updateBreathing(elapsed) {
  animState.chest.x = Math.sin(elapsed * 0.9) * 0.014;
  animState.spine.x = Math.sin(elapsed * 0.9) * 0.006;
}

// --- Weight shift: animState.spine.z only, new random target every 9-14s.
// This used to target hips.z, but hips sits at the base of the skeleton, so
// rotating it dragged the legs and feet along with it (whole-body tilt) via
// normal skeletal inheritance. animState.hips is intentionally never written
// anywhere in this file and stays at {0,0,0} so the character stays planted;
// only spine and everything above it (chest, neck, head, arms) sways. ---
const WEIGHT_SHIFT_MIN_MS = 9000;
const WEIGHT_SHIFT_MAX_MS = 14000;
let weightShiftTarget = 0;
let nextWeightShiftTime =
  Date.now() + WEIGHT_SHIFT_MIN_MS + Math.random() * (WEIGHT_SHIFT_MAX_MS - WEIGHT_SHIFT_MIN_MS);

function updateWeightShift(now) {
  if (now > nextWeightShiftTime) {
    weightShiftTarget = (Math.random() * 2 - 1) * 0.02;
    nextWeightShiftTime =
      now + WEIGHT_SHIFT_MIN_MS + Math.random() * (WEIGHT_SHIFT_MAX_MS - WEIGHT_SHIFT_MIN_MS);
  }
  animState.spine.z = weightShiftTarget;
}

// --- Idle variation: every 12-18s randomly pick one idle action and hold it
// for 2.5s before returning to zero. Never repeats the same action twice in
// a row. Three actions: head tilt, glance (head+neck), shoulder shift. ---
const IDLE_ACTIONS = ['tilt', 'glance', 'shoulderShift'];
const IDLE_ACTION_MIN_MS = 12000;
const IDLE_ACTION_MAX_MS = 18000;
const IDLE_ACTION_HOLD_MS = 2500;
let lastIdleAction = null;
let idleActionActive = false;
let idleActionHoldUntil = 0;
let shoulderShiftSign = 1;
let nextIdleActionTime =
  Date.now() + IDLE_ACTION_MIN_MS + Math.random() * (IDLE_ACTION_MAX_MS - IDLE_ACTION_MIN_MS);

function resetIdleActionTargets() {
  animState.head.y = 0;
  animState.head.z = 0;
  animState.neck.y = 0;
  animState.leftShoulder.z = 0;
  animState.rightShoulder.z = 0;
}

function updateIdleVariation(now) {
  if (!idleActionActive && now > nextIdleActionTime) {
    const pool = IDLE_ACTIONS.filter((action) => action !== lastIdleAction);
    const action = pool[Math.floor(Math.random() * pool.length)];
    lastIdleAction = action;
    idleActionActive = true;

    if (action === 'tilt') {
      animState.head.z = (Math.random() * 2 - 1) * 0.07;
    } else if (action === 'glance') {
      const glanceY = (Math.random() * 2 - 1) * 0.15;
      animState.head.y = glanceY;
      animState.neck.y = glanceY * 0.5;
    } else if (action === 'shoulderShift') {
      shoulderShiftSign *= -1;
      animState.leftShoulder.z = shoulderShiftSign * 0.04;
      animState.rightShoulder.z = -shoulderShiftSign * 0.04;
    }

    idleActionHoldUntil = now + IDLE_ACTION_HOLD_MS;
    nextIdleActionTime =
      now + IDLE_ACTION_MIN_MS + Math.random() * (IDLE_ACTION_MAX_MS - IDLE_ACTION_MIN_MS);
  } else if (idleActionActive && now > idleActionHoldUntil) {
    resetIdleActionTargets();
    idleActionActive = false;
  }
}

// --- Shoulder/arm micro movement: continuous secondary sway on the upper
// arms, oscillating around the resting arm pose, left/right out of phase.
// The right arm's phase carries a slow drifting offset on top of the base
// 1.4 rad separation so the left/right relationship itself never settles
// into a perfectly static, repeating pattern - it feels organic rather than
// mechanically mirrored. ---
function updateArmSway(elapsed) {
  const phaseDrift = Math.sin(elapsed * 0.05) * 0.6;
  animState.leftUpperArm.z = ARM_REST_Z.leftUpperArm + Math.sin(elapsed * 0.35) * 0.015;
  animState.rightUpperArm.z =
    ARM_REST_Z.rightUpperArm + Math.sin(elapsed * 0.35 + 1.4 + phaseDrift) * 0.015;
}

// --- Hand micro movement: extremely subtle continuous wrist/finger life,
// left/right out of phase with each other, with its own slow phase drift
// (different rate than the arms so the two systems don't drift in lockstep).
// A second, slower wrist-rotation wave rides on the x axis, independent of
// the z-axis sway above and at a different frequency, so the hands never
// settle into one perfectly repeating rhythm - just enough tiny life to read
// as natural stillness rather than fidgeting. ---
function updateHandSway(elapsed) {
  const phaseDrift = Math.sin(elapsed * 0.07 + 2) * 0.6;
  animState.leftHand.z = Math.sin(elapsed * 1.1) * 0.02;
  animState.rightHand.z = Math.sin(elapsed * 1.1 + 1.4 + phaseDrift) * 0.02;

  animState.leftHand.x = Math.sin(elapsed * 0.4) * 0.012;
  animState.rightHand.x = Math.sin(elapsed * 0.4 + 2.1) * 0.012;
}

// --- Occasional arm readjustment: roughly every 25-40s, one upper arm
// briefly shifts on its x axis - a bit more than the constant micro sway -
// like a small natural weight readjustment a person makes while standing
// still, then eases back to rest. Uses the same hold-then-reset pattern as
// idle variation, so the final lerp pass supplies the smooth ease in/out. ---
const ARM_REST_X = 0.1;
const ARM_READJUST_MIN_MS = 25000;
const ARM_READJUST_MAX_MS = 40000;
const ARM_READJUST_HOLD_MS = 1600;
let armReadjustBone = null;
let nextArmReadjustTime =
  Date.now() + ARM_READJUST_MIN_MS + Math.random() * (ARM_READJUST_MAX_MS - ARM_READJUST_MIN_MS);
let armReadjustHoldUntil = 0;

function updateArmReadjust(now) {
  if (!armReadjustBone && now > nextArmReadjustTime) {
    armReadjustBone = Math.random() < 0.5 ? 'leftUpperArm' : 'rightUpperArm';
    const sign = Math.random() < 0.5 ? -1 : 1;
    animState[armReadjustBone].x = ARM_REST_X + sign * 0.09;

    armReadjustHoldUntil = now + ARM_READJUST_HOLD_MS;
    nextArmReadjustTime =
      now + ARM_READJUST_MIN_MS + Math.random() * (ARM_READJUST_MAX_MS - ARM_READJUST_MIN_MS);
  } else if (armReadjustBone && now > armReadjustHoldUntil) {
    animState[armReadjustBone].x = ARM_REST_X;
    armReadjustBone = null;
  }
}

// --- Hand-to-hair gesture: another occasional idle action, alongside head
// tilt / glance / shoulder shift, where the right hand rises to tuck hair
// behind the ear, holds briefly, then returns to rest. It runs on its own
// ~20-30s timer (longer than the 12-18s head/neck/shoulder pool, and a
// three-phase rise/hold/return curve instead of their snap-hold-reset), and
// it only ever touches rightUpperArm.x / rightLowerArm.x - bones/axes the
// head/neck/shoulder pool never writes - so the two idle systems can never
// collide. Same principle throughout: only animState targets are touched,
// and the single final lerp pass is what actually moves the bones. ---
const HAIR_TOUCH_MIN_MS = 20000;
const HAIR_TOUCH_MAX_MS = 30000;
const HAIR_TOUCH_RISE_S = 0.8;
const HAIR_TOUCH_HOLD_S = 1.2;
const HAIR_TOUCH_RETURN_S = 0.8;
const HAIR_TOUCH_HOLD_END_S = HAIR_TOUCH_RISE_S + HAIR_TOUCH_HOLD_S;
const HAIR_TOUCH_DURATION_S = HAIR_TOUCH_HOLD_END_S + HAIR_TOUCH_RETURN_S;

const RIGHT_UPPER_ARM_HAIR_X = -1.1;
const RIGHT_LOWER_ARM_HAIR_X = -1.4;

let hairTouchActive = false;
let hairTouchStartElapsed = 0;
let nextHairTouchTime =
  Date.now() + HAIR_TOUCH_MIN_MS + Math.random() * (HAIR_TOUCH_MAX_MS - HAIR_TOUCH_MIN_MS);

function updateHairTouch(now, elapsed) {
  if (!hairTouchActive && now > nextHairTouchTime) {
    hairTouchActive = true;
    hairTouchStartElapsed = elapsed;
    // Next trigger is measured from now, so the ~20-30s gap is the gap
    // between gestures, not overlapping the ~2.8s the gesture itself takes.
    nextHairTouchTime =
      now +
      HAIR_TOUCH_DURATION_S * 1000 +
      HAIR_TOUCH_MIN_MS +
      Math.random() * (HAIR_TOUCH_MAX_MS - HAIR_TOUCH_MIN_MS);
  }

  if (!hairTouchActive) return;

  const t = elapsed - hairTouchStartElapsed;

  if (t >= HAIR_TOUCH_DURATION_S) {
    animState.rightUpperArm.x = ARM_REST_X;
    animState.rightLowerArm.x = RIGHT_LOWER_ARM_REST.x;
    hairTouchActive = false;
    return;
  }

  if (t < HAIR_TOUCH_RISE_S) {
    const p = t / HAIR_TOUCH_RISE_S;
    animState.rightUpperArm.x = THREE.MathUtils.lerp(ARM_REST_X, RIGHT_UPPER_ARM_HAIR_X, p);
    animState.rightLowerArm.x = THREE.MathUtils.lerp(RIGHT_LOWER_ARM_REST.x, RIGHT_LOWER_ARM_HAIR_X, p);
  } else if (t < HAIR_TOUCH_HOLD_END_S) {
    animState.rightUpperArm.x = RIGHT_UPPER_ARM_HAIR_X;
    animState.rightLowerArm.x = RIGHT_LOWER_ARM_HAIR_X;
  } else {
    const p = (t - HAIR_TOUCH_HOLD_END_S) / HAIR_TOUCH_RETURN_S;
    animState.rightUpperArm.x = THREE.MathUtils.lerp(RIGHT_UPPER_ARM_HAIR_X, ARM_REST_X, p);
    animState.rightLowerArm.x = THREE.MathUtils.lerp(RIGHT_LOWER_ARM_HAIR_X, RIGHT_LOWER_ARM_REST.x, p);
  }
}

// --- Greeting: a one-time wave played once, right after the model finishes
// loading, before the regular idle systems (breathing, weight shift, idle
// variation, arm/hand sway, arm readjust) begin. It writes to the same
// animState.rightUpperArm / animState.rightLowerArm targets those systems
// use, so while it's active the regular systems are simply not called for
// that frame (see animate() below) - there's still only one thing driving
// those bones' targets at any given moment. ---
const GREETING_RAISE_S = 0.5;
const GREETING_WAVE_S = 2.0;
const GREETING_DURATION_S = 3.0; // raise (0.5s) + wave (2.0s) + return (0.5s)
const GREETING_WAVE_CYCLES = 3;
const GREETING_WAVE_AMPLITUDE = 0.2;

const RIGHT_UPPER_ARM_REST = { x: 0.1, y: 0, z: 1.3 };
const RIGHT_LOWER_ARM_REST = { x: 0, y: 0, z: 0.05 };
// Lift is driven by z (out and up to the side), not x (which would reach
// forward) - x stays near neutral, only slightly negative.
const RIGHT_UPPER_ARM_WAVE = { x: -0.15, y: 0, z: 0.9 };
const RIGHT_LOWER_ARM_WAVE_X = -1.3;

let greetingActive = false;
let greetingDone = false;
let greetingStartElapsed = 0;

function startGreeting(elapsed) {
  greetingActive = true;
  greetingStartElapsed = elapsed;
}

function updateGreeting(elapsed) {
  const t = elapsed - greetingStartElapsed;
  const waveEnd = GREETING_RAISE_S + GREETING_WAVE_S;

  if (t >= GREETING_DURATION_S) {
    animState.rightUpperArm.x = RIGHT_UPPER_ARM_REST.x;
    animState.rightUpperArm.z = RIGHT_UPPER_ARM_REST.z;
    animState.rightLowerArm.x = RIGHT_LOWER_ARM_REST.x;
    animState.rightLowerArm.z = RIGHT_LOWER_ARM_REST.z;
    greetingActive = false;
    greetingDone = true;
    return;
  }

  if (t < GREETING_RAISE_S) {
    // Raise the arm outward into wave position.
    const p = t / GREETING_RAISE_S;
    animState.rightUpperArm.x = THREE.MathUtils.lerp(RIGHT_UPPER_ARM_REST.x, RIGHT_UPPER_ARM_WAVE.x, p);
    animState.rightUpperArm.z = THREE.MathUtils.lerp(RIGHT_UPPER_ARM_REST.z, RIGHT_UPPER_ARM_WAVE.z, p);
    animState.rightLowerArm.x = THREE.MathUtils.lerp(RIGHT_LOWER_ARM_REST.x, RIGHT_LOWER_ARM_WAVE_X, p);
    animState.rightLowerArm.z = RIGHT_LOWER_ARM_REST.z;
  } else if (t < waveEnd) {
    // Hold the upper arm fixed in the raised side position; only the
    // forearm (elbow bend already set, z oscillating) visibly waves.
    const waveT = t - GREETING_RAISE_S;
    animState.rightUpperArm.x = RIGHT_UPPER_ARM_WAVE.x;
    animState.rightUpperArm.z = RIGHT_UPPER_ARM_WAVE.z;
    animState.rightLowerArm.x = RIGHT_LOWER_ARM_WAVE_X;
    animState.rightLowerArm.z =
      Math.sin(waveT * ((2 * Math.PI * GREETING_WAVE_CYCLES) / GREETING_WAVE_S)) *
      GREETING_WAVE_AMPLITUDE;
  } else {
    // Return smoothly to the normal resting position.
    const p = (t - waveEnd) / (GREETING_DURATION_S - waveEnd);
    animState.rightUpperArm.x = THREE.MathUtils.lerp(RIGHT_UPPER_ARM_WAVE.x, RIGHT_UPPER_ARM_REST.x, p);
    animState.rightUpperArm.z = THREE.MathUtils.lerp(RIGHT_UPPER_ARM_WAVE.z, RIGHT_UPPER_ARM_REST.z, p);
    animState.rightLowerArm.x = THREE.MathUtils.lerp(RIGHT_LOWER_ARM_WAVE_X, RIGHT_LOWER_ARM_REST.x, p);
    animState.rightLowerArm.z = THREE.MathUtils.lerp(0, RIGHT_LOWER_ARM_REST.z, p);
  }
}

// --- Final application pass: the ONLY place in this file that reads
// animState and writes bone.rotation. Runs once per bone per frame. ---
function applyAnimState(vrm) {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  for (const boneName of ANIM_BONE_NAMES) {
    const node = humanoid.getNormalizedBoneNode(boneName);
    if (!node) continue;

    const target = animState[boneName];
    const lerpFactor = lerpFactorFor(boneName);

    node.rotation.x += (target.x - node.rotation.x) * lerpFactor;
    node.rotation.y += (target.y - node.rotation.y) * lerpFactor;
    node.rotation.z += (target.z - node.rotation.z) * lerpFactor;
  }
}

// --- Camera framing: keeps Lyra fully in frame by tracking actual bone world
// positions each frame. This only reads bones and writes the camera, so it
// doesn't participate in the animState/lerp system.
//
// CAMERA_FRAME_MARGIN controls zoom: it's the ratio of visible frame height
// to actual body height (1.0 = camera fit exactly to her silhouette, no
// padding at all). It was 1.18 (~18% total padding split evenly above/below);
// dropping it to 1.04 brings her ~12% closer/larger while still leaving a
// small real margin - cutting distance a literal 15% would need margin
// ~1.00, which is zero padding and leaves no safe room for the headroom
// offset below without clipping her feet.
//
// CAMERA_LOOK_Y_OFFSET is new: cameraLookY below always converges to her
// live vertical center every frame (that's what "auto-framing" means), so a
// one-time edit to CAMERA_BASE_LOOK_Y or to MODEL_BASE_Y has no lasting
// effect - the tracking just re-centers on wherever she actually is. This
// constant is a persistent offset added on top of that live center, aiming
// the camera slightly above her true center so she reads lower in frame with
// more headroom above her head. ---
const CAMERA_FRAME_MARGIN = 1.04; // was 1.18
const CAMERA_LOOK_Y_OFFSET = 0.02;
const _boneWorldPos = new THREE.Vector3();
let cameraLookY = CAMERA_BASE_LOOK_Y;
let cameraDistance = CAMERA_BASE_DISTANCE;

function getBoneWorldY(bone) {
  bone.getWorldPosition(_boneWorldPos);
  return _boneWorldPos.y;
}

function updateCameraFraming(vrm) {
  const humanoid = vrm.humanoid;
  const head = humanoid?.getNormalizedBoneNode('head');
  if (!head) return;

  const leftFoot = humanoid.getNormalizedBoneNode('leftFoot');
  const rightFoot = humanoid.getNormalizedBoneNode('rightFoot');

  const headTopY = getBoneWorldY(head) + 0.22;

  let feetY;
  if (leftFoot || rightFoot) {
    const candidates = [];
    if (leftFoot) candidates.push(getBoneWorldY(leftFoot));
    if (rightFoot) candidates.push(getBoneWorldY(rightFoot));
    feetY = Math.min(...candidates) - 0.05;
  } else {
    feetY = headTopY - 1.5;
  }

  const bodyHeight = Math.max(0.5, headTopY - feetY);
  const centerY = (headTopY + feetY) / 2;

  const halfFovRad = THREE.MathUtils.degToRad(camera.fov) / 2;
  const requiredDistance = (bodyHeight * CAMERA_FRAME_MARGIN) / 2 / Math.tan(halfFovRad);
  const targetDistance = Math.max(CAMERA_BASE_DISTANCE, requiredDistance);

  cameraLookY += (centerY + CAMERA_LOOK_Y_OFFSET - cameraLookY) * 0.05;
  cameraDistance += (targetDistance - cameraDistance) * 0.05;

  camera.position.set(0, cameraLookY, cameraDistance);
  camera.lookAt(0, cameraLookY, 0);
}

// animateLoopErrorLogged prevents one persistent per-frame error (e.g. a bad
// bone name) from spamming the console 60x/sec - it logs once, then stays
// silent while still retrying every frame so the loop can recover on its own
// if the underlying condition clears (e.g. the model finishes loading).
let animateLoopErrorLogged = false;
let animateStarted = false;

function animate() {
  requestAnimationFrame(animate);

  if (!animateStarted) {
    animateStarted = true;
    console.log('animate(): loop started and is now running repeatedly via requestAnimationFrame.');
  }

  try {
    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();
    currentElapsed = elapsed;

    if (currentVrm) {
      // MODEL POSITION - stays at MODEL_BASE_Y except during the task-done bounce
      let modelY = MODEL_BASE_Y;
      if (bounceActive) {
        const bounceTime = elapsed - bounceStart;
        if (bounceTime < 0.6) {
          modelY = MODEL_BASE_Y + Math.sin(bounceTime * Math.PI * 3) * 0.03;
        } else {
          bounceActive = false;
        }
      }
      currentVrm.scene.position.set(0, modelY, 0);

      if (modelReady) {
        const now = Date.now();

        // The greeting plays once, right after load, before any other system
        // touches animState. While it's active it's the only thing driving
        // rightUpperArm/rightLowerArm; the regular systems below simply don't
        // run yet, so nothing fights over those targets.
        if (!greetingDone && !greetingActive) {
          startGreeting(elapsed);
        }

        if (greetingActive) {
          updateGreeting(elapsed);
        } else if (greetingDone) {
          // ---- Systems: each writes ONLY to its own animState bone field(s),
          // never to a bone.rotation directly. ----
          updateBreathing(elapsed);
          updateWeightShift(now);
          updateIdleVariation(now);
          updateArmSway(elapsed);
          updateHandSway(elapsed);
          updateHairTouch(now, elapsed);
          // Skipped while the hair-touch gesture is active - both can target
          // rightUpperArm.x, and hair-touch should never be interrupted mid-gesture.
          if (!hairTouchActive) {
            updateArmReadjust(now);
          }
        }

        updateMicroExpression(elapsed);
        updateLookAtTarget();
      }

      // Spring bone (hair/cloth) physics animate automatically here, driven by
      // the real per-frame delta from THREE.Clock.
      currentVrm.update(delta);

      if (modelReady) {
        // ---- ONE final pass: every animState bone eases toward its target
        // here, exactly once. Nothing else in this file writes bone.rotation. ----
        applyAnimState(currentVrm);

        updateCameraFraming(currentVrm);
      }
    }

    renderer.render(scene, camera);
    animateLoopErrorLogged = false;
  } catch (error) {
    if (!animateLoopErrorLogged) {
      console.error('animate() loop error (this frame skipped, loop continues):', error?.message ?? error);
      if (error?.stack) console.error(error.stack);
      animateLoopErrorLogged = true;
    }
  }
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Voice output: play base64 WAV audio from the backend and drive the
// VRM's mouth-open ("aa") expression from the live audio volume. ---
let voiceAudioContext = null;
const MOUTH_SYNC_INTERVAL_MS = 50;

function playAudioWithMouthSync(base64Audio) {
  const expressionManager = currentVrm?.expressionManager;

  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));

  const audioEl = new Audio(blobUrl);

  if (!voiceAudioContext) {
    voiceAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (voiceAudioContext.state === 'suspended') {
    voiceAudioContext.resume();
  }

  const source = voiceAudioContext.createMediaElementSource(audioEl);
  const analyser = voiceAudioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(voiceAudioContext.destination);

  const volumeData = new Uint8Array(analyser.frequencyBinCount);
  let mouthSyncInterval = null;

  function stopMouthSync() {
    if (mouthSyncInterval) {
      clearInterval(mouthSyncInterval);
      mouthSyncInterval = null;
    }
    expressionManager?.setValue('aa', 0);
    URL.revokeObjectURL(blobUrl);
  }

  audioEl.addEventListener('play', () => {
    mouthSyncInterval = setInterval(() => {
      analyser.getByteFrequencyData(volumeData);
      const average = volumeData.reduce((sum, value) => sum + value, 0) / volumeData.length;
      const mouthOpen = Math.min(1, average / 128);
      expressionManager?.setValue('aa', mouthOpen);
    }, MOUTH_SYNC_INTERVAL_MS);
  });

  audioEl.addEventListener('ended', stopMouthSync);
  audioEl.addEventListener('error', stopMouthSync);

  audioEl.play().catch((error) => {
    console.error('Voice audio playback failed:', error);
    stopMouthSync();
  });
}

function handleLyraAction(data) {
  const expressionManager = currentVrm?.expressionManager;

  if (data.action === 'speak_audio' && typeof data.audio === 'string') {
    playAudioWithMouthSync(data.audio);
  } else if (data.action === 'look_at' && typeof data.x === 'number') {
    const screenCenterX = window.screen.width / 2;
    const diff = (data.x - screenCenterX) / window.screen.width;
    animState.head.y = diff * 0.4;
    if (data.text) window.showSpeech?.(data.text, 2000);
  } else if (data.action === 'thinking') {
    animState.head.z = 0.05;
    if (data.text) window.showSpeech?.(data.text, 2000);
  } else if (data.action === 'task_done') {
    animState.head.x = 0;
    animState.head.y = 0;
    animState.head.z = 0;
    bounceActive = true;
    bounceStart = currentElapsed;
    if (expressionManager) {
      expressionManager.setValue('happy', 0.8);
      setTimeout(() => expressionManager.setValue('happy', 0), 2000);
    }
    if (data.text) window.showSpeech?.(data.text, 3000);
  } else if (data.action === 'task_failed') {
    animState.head.z = -0.1;
    if (data.text) window.showSpeech?.(data.text, 3000);
  } else if (data.action === 'speak' && typeof data.text === 'string') {
    window.showSpeech?.(data.text, 3000);
  }
}

function connectLyraSocket() {
  const socket = new WebSocket('ws://localhost:8001');

  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      console.error('Invalid WebSocket message:', event.data);
      return;
    }

    handleLyraAction(data);
  });

  socket.addEventListener('close', () => {
    setTimeout(connectLyraSocket, 3000);
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

connectLyraSocket();
