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

      // Leg bones aren't guaranteed present on every VRM (only hips/spine/
      // chest/neck/head/eyes are required by the spec) - logged once here so
      // it's obvious from the console whether real leg animation (as opposed
      // to just sliding the window) is actually possible on this model.
      const legBoneNames = ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'hips'];
      const legBoneAvailability = Object.fromEntries(
        legBoneNames.map((name) => [name, Boolean(vrm.humanoid?.getNormalizedBoneNode(name))]),
      );
      console.log('Lyra.vrm: leg bone availability:', legBoneAvailability);

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

// --- Drag-to-move: lets clicking directly on her body (not the chat box)
// drag the whole window, so she can be repositioned anywhere on the desktop.
// The window is transparent and desktop-sized, so moving it just shifts
// where her canvas renders on screen - the newly uncovered strip shows the
// real desktop either way, since it was showing through as transparent
// before too. ---
let isDraggingCharacter = false;
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartWinX = 0;
let dragStartWinY = 0;

function isOnCharacter(clientX, clientY) {
  const distance = Math.hypot(clientX - characterScreenX, clientY - characterScreenY);
  return distance < CHARACTER_HOVER_RADIUS_PX && !isOverChatContainer(clientX, clientY);
}

// --- Ctrl+scroll resize: a persistent-for-the-session user size preference,
// applied in updateCameraFraming() below as a final divisor on top of the
// existing crop-framing distance calculation - CAMERA_FRAME_MARGIN and
// CAMERA_LOOK_Y_OFFSET themselves are untouched, so the crop line tuned
// there stays exactly where it was regardless of this. A larger multiplier
// means a smaller camera distance, which means she appears larger. ---
const USER_SIZE_MIN = 0.5;
const USER_SIZE_MAX = 2.0;
const USER_SIZE_STEP = 0.05;
let userSizeMultiplier = 1;

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  if (!isOnCharacter(event.clientX, event.clientY)) return;

  // Chromium binds Ctrl+wheel to native page zoom by default - block it so
  // it doesn't fight this custom scaling. Requires a non-passive listener,
  // since preventDefault() on a passive 'wheel' listener is silently ignored.
  event.preventDefault();

  const direction = event.deltaY < 0 ? 1 : -1; // scroll up = larger
  userSizeMultiplier = THREE.MathUtils.clamp(
    userSizeMultiplier + direction * USER_SIZE_STEP,
    USER_SIZE_MIN,
    USER_SIZE_MAX,
  );
}, { passive: false });

window.addEventListener('mousedown', (event) => {
  if (!isOnCharacter(event.clientX, event.clientY)) return;

  isDraggingCharacter = true;
  dragStartScreenX = event.screenX;
  dragStartScreenY = event.screenY;

  // Fetched async, but the drag itself is driven by the screenX/Y delta
  // below, which is independent of when this resolves - worst case the
  // window doesn't move for the first event or two of a very fast drag.
  window.boltmos?.getWindowPosition().then((pos) => {
    if (!pos) return;
    [dragStartWinX, dragStartWinY] = pos;
  });
});

window.addEventListener('mouseup', () => {
  if (isDraggingCharacter) {
    startSettle(currentElapsed);
  }
  isDraggingCharacter = false;
});

window.addEventListener('mousemove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  if (isDraggingCharacter) {
    // screenX/screenY are absolute desktop coordinates, unaffected by the
    // window itself moving, so this delta is exactly how far to shift it.
    const dx = event.screenX - dragStartScreenX;
    const dy = event.screenY - dragStartScreenY;
    window.boltmos?.moveWindow(dragStartWinX + dx, dragStartWinY + dy);
    return;
  }

  // characterScreenX/Y is her actual projected screen position, updated
  // every frame in updateCameraFraming() - not window.innerWidth/2, which
  // only lined up with her while the window was cropped tightly around her.
  const isInteractive = isOnCharacter(event.clientX, event.clientY) ||
    isOverChatContainer(event.clientX, event.clientY);

  window.boltmos?.setIgnoreMouseEvents(!isInteractive);
});

// --- Full walk cycle: leg swing/knee bend/hip twist/arm counter-swing/bob,
// all driven by a single phase (0-1, one full stride) rather than elapsed
// time - see walkAcrossScreen() below, which derives phase from actual
// horizontal distance traveled so step rate always matches travel speed.
// leftUpperLeg/rightUpperLeg/leftLowerLeg/rightLowerLeg/hips (confirmed
// present on this model - see the leg bone availability log at load time)
// and leftUpperArm.x/rightUpperArm.x/model.position.y are the only things
// this touches. ---
const WALK_CYCLE_LEG_SWING_RAD = 0.4;
const WALK_CYCLE_KNEE_BEND_RAD = -0.3;
const WALK_CYCLE_HIP_TWIST_RAD = 0.12; // was 0.05 - too subtle to read as a real twist
const WALK_CYCLE_ARM_SWING_RAD = 0.25;
const WALK_CYCLE_BOB_AMPLITUDE = 0.035; // was 0.015 - too subtle to read as a real step

// Read by animate() below and added into model.position.y - only ever
// non-zero while updateWalkCycle() is actively being driven, and zeroed by
// resetWalkCyclePose() (see walkAcrossScreen() below) the moment walking
// stops, so she's at her normal resting height whenever it isn't active.
let walkCycleBobY = 0;

function updateWalkCycle(phase) {
  const cycle = phase * Math.PI * 2;
  const leftSwing = Math.sin(cycle);
  // Offset by half a phase (PI radians) from the left leg, so the two
  // always swing in opposition rather than together.
  const rightSwing = Math.sin(cycle + Math.PI);

  // Negated: a previous walk test showed the legs stepping backward
  // regardless of screen travel direction, which (since phase here is
  // derived from distance traveled, not direction - see walkAcrossScreen()
  // below) means positive rotation.x on this rig's upper-leg bones is
  // actually backward extension, not forward flexion like the naive
  // mapping below assumed - same kind of rig-specific sign inversion
  // WALK_FACE_TURN_Y already documents for rotation.y. Only the final
  // output is flipped; leftSwing/rightSwing keep their original meaning
  // (positive = this leg's forward half of the stride) for the knee
  // bend/hip twist/arm counter-swing below, which are all correct relative
  // to that phase and don't need to change.
  animState.leftUpperLeg.x = -leftSwing * WALK_CYCLE_LEG_SWING_RAD;
  animState.rightUpperLeg.x = -rightSwing * WALK_CYCLE_LEG_SWING_RAD;

  // Each leg's own knee bends only while that leg's swing is positive (its
  // forward half - Math.max(0, ...) clips the backward half to 0), so it
  // reads as a lifted, bent knee swinging forward that straightens again as
  // the leg plants back down.
  animState.leftLowerLeg.x = Math.max(0, leftSwing) * WALK_CYCLE_KNEE_BEND_RAD;
  animState.rightLowerLeg.x = Math.max(0, rightSwing) * WALK_CYCLE_KNEE_BEND_RAD;

  // Hips twist toward whichever leg is currently forward, synced to the
  // same phase as the left leg's swing.
  animState.hips.y = leftSwing * WALK_CYCLE_HIP_TWIST_RAD;

  // Arm counter-swing: each arm tracks the OPPOSITE-side leg's swing value,
  // so contralateral limbs move together the way they do in a real gait -
  // rightUpperArm goes forward (positive, on top of its ARM_REST_X resting
  // pose) exactly when leftSwing is positive, i.e. right arm forward pairs
  // with left leg forward.
  animState.leftUpperArm.x = ARM_REST_X + rightSwing * WALK_CYCLE_ARM_SWING_RAD;
  animState.rightUpperArm.x = ARM_REST_X + leftSwing * WALK_CYCLE_ARM_SWING_RAD;

  // Double-bounce vertical bob: -cos(2*cycle) peaks twice per full stride,
  // at phase 0.25/0.75 - exactly where leftSwing/rightSwing hit their
  // extremes (a leg fully extended) - and dips below rest at phase 0/0.5/1,
  // where leftSwing crosses zero and neither leg is at extension (the
  // transition between steps). The doubled frequency (2 * cycle, vs. cycle
  // for the leg swing above) is what produces two bounces per stride
  // instead of one.
  walkCycleBobY = -Math.cos(2 * cycle) * WALK_CYCLE_BOB_AMPLITUDE;
}

function resetWalkCyclePose() {
  animState.leftUpperLeg.x = 0;
  animState.rightUpperLeg.x = 0;
  animState.leftLowerLeg.x = 0;
  animState.rightLowerLeg.x = 0;
  animState.hips.y = 0;
  animState.leftUpperArm.x = ARM_REST_X;
  animState.rightUpperArm.x = ARM_REST_X;
  walkCycleBobY = 0;
}

// --- Window slide, wired to the walk cycle above: moves the actual
// Electron window horizontally from its current position to targetX over
// durationS via the same move-window IPC channel drag-to-move uses
// (window.boltmos.moveWindow/getWindowPosition), while advancing the walk
// phase from the real horizontal distance covered each frame
// (walkCycleDistanceTraveled / WALK_CYCLE_STRIDE_PX) rather than a fixed
// timer - so covering the same distance in less time (a faster slide)
// proportionally speeds up the step rate, keeping the visual stepping
// matched to actual travel speed. isWalkingActive is read by
// updateHeadComposite() to keep the head comparatively stable while the
// hips/arms are actively swinging. y is read once at the start and held
// fixed, since this is purely horizontal. Exposed for manual console
// testing, e.g. window.testWalk = () => walkAcrossScreen(800, 3). ---
const WALK_CYCLE_STRIDE_PX = 120; // horizontal px of window travel per full stride

// Turn to face the direction of travel. This is the whole VRM root's
// orientation (currentVrm.scene.rotation.y), not an animState bone target -
// a pose lerp doesn't apply to which way the whole model is facing. The
// sign below is empirically confirmed for this model/camera setup, not
// derived from axis convention (which turned out to be the opposite of the
// naive math): screenshotting both showed rotation.y = -WALK_FACE_TURN_Y
// renders her in a right-facing profile and +WALK_FACE_TURN_Y a left-facing
// one, so moving right uses the negative sign despite that looking
// backwards on paper.
const WALK_FACE_TURN_Y = Math.PI / 2;

let isWalkingActive = false;
let walkCycleDistanceTraveled = 0;

function walkAcrossScreen(targetX, durationS) {
  window.boltmos?.getWindowPosition().then((pos) => {
    if (!pos) return;
    const [startX, startY] = pos;
    const durationMs = durationS * 1000;
    const startTime = performance.now();
    let lastX = startX;

    isWalkingActive = true;
    if (currentVrm) {
      currentVrm.scene.rotation.y = targetX >= startX ? -WALK_FACE_TURN_Y : WALK_FACE_TURN_Y;
    }

    function step(now) {
      const p = Math.min(1, (now - startTime) / durationMs);
      const x = startX + (targetX - startX) * p;
      window.boltmos?.moveWindow(Math.round(x), startY);

      walkCycleDistanceTraveled += Math.abs(x - lastX);
      lastX = x;
      updateWalkCycle((walkCycleDistanceTraveled / WALK_CYCLE_STRIDE_PX) % 1);

      if (p < 1) {
        requestAnimationFrame(step);
      } else {
        isWalkingActive = false;
        resetWalkCyclePose();
        if (currentVrm) currentVrm.scene.rotation.y = 0;
      }
    }

    requestAnimationFrame(step);
  });
}

window.testWalk = () => walkAcrossScreen(800, 3);
window.__debugWalkAcrossScreen = walkAcrossScreen;
window.__debugUpdateWalkCycle = updateWalkCycle;
window.__debugSetRotationY = (v) => { if (currentVrm) currentVrm.scene.rotation.y = v; };
window.__debugGetLegRotations = () => ({
  leftUpperLeg: currentVrm?.humanoid.getNormalizedBoneNode('leftUpperLeg')?.rotation.x,
  rightUpperLeg: currentVrm?.humanoid.getNormalizedBoneNode('rightUpperLeg')?.rotation.x,
  modelFacingY: currentVrm?.scene.rotation.y,
});

// --- Off-screen walk-in entrance (manual test): jumps the window instantly
// off-screen to the left, then uses walkAcrossScreen() above to slide it
// back to its current resting x over ~2s - walkAcrossScreen() itself now
// drives the full walk cycle (legs, knees, hip twist, arm counter-swing,
// bob) from the real distance traveled, so this only needs to trigger the
// slide. Not wired into the real load-time entrance
// (startEntrance/updateEntrance) above, which stays untouched. Exposed as
// window.testWalkIn for console testing. ---
const WALK_ENTRANCE_DURATION_S = 2;
const WALK_ENTRANCE_START_X_OFFSET = -400; // how far off-screen-left to start from

function walkInEntrance() {
  window.boltmos?.getWindowPosition().then((pos) => {
    if (!pos) return;
    const [restX, restY] = pos;
    window.boltmos?.moveWindow(Math.round(restX + WALK_ENTRANCE_START_X_OFFSET), restY);
    walkAcrossScreen(restX, WALK_ENTRANCE_DURATION_S);
  });
}

window.testWalkIn = walkInEntrance;

// --- Chat send: the single shared path both the Enter key and the mic
// button funnel through, so text and voice input behave identically. ---
const chatInput = document.getElementById('chat-input');
const micButton = document.getElementById('mic-button');
const chatError = document.getElementById('chat-error');

let chatErrorTimeout = null;
function showChatError(message, duration = 4000) {
  if (!chatError) return;
  chatError.textContent = message;
  chatError.style.display = 'block';
  clearTimeout(chatErrorTimeout);
  chatErrorTimeout = setTimeout(() => {
    chatError.style.display = 'none';
  }, duration);
}

// Only messages that clearly request an action go to /task (the automation
// planner, which can open apps, click, type, etc.). Everything else -
// questions, greetings, general conversation - goes to /chat instead. This
// is a simple whole-word/phrase check, not NLU: it's a deliberately blunt
// filter so "search" (task) doesn't also match inside an unrelated word.
const TASK_ACTION_VERBS = [
  'open', 'search', 'find', 'click', 'go to', 'write', 'save', 'launch',
  'navigate', 'close', 'type', 'download', 'install', 'play', 'pause',
];

function isActionRequest(text) {
  const lower = text.toLowerCase();
  return TASK_ACTION_VERBS.some((verb) => new RegExp(`(^|\\s)${verb}(\\s|$)`).test(lower));
}

async function sendChatMessage(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  const isTask = isActionRequest(trimmed);
  const endpoint = isTask ? '/task' : '/chat';
  const payload = isTask ? { task: trimmed } : { message: trimmed };

  try {
    const response = await fetch(`http://localhost:8000${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Backend responded with status ${response.status}`);
    }
  } catch (error) {
    console.error('sendChatMessage failed:', error);
    showChatError("Couldn't reach the backend - is it running?");
  }
}

if (chatInput) {
  chatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const text = chatInput.value;
    chatInput.value = '';
    sendChatMessage(text);
  });
}

// --- Voice input: press-and-hold the mic button to record, release to send
// the transcript through the same sendChatMessage() path as Enter. ---
const SpeechRecognitionCtor = window.webkitSpeechRecognition || window.SpeechRecognition;
let recognition = null;
let isListening = false;
let micTranscript = '';

if (SpeechRecognitionCtor) {
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    micTranscript = transcript;
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isListening = false;
    micButton?.classList.remove('mic-active');
    setListeningPosture(false);
    showChatError('Voice input failed - please try again.');
  };

  // Recognition ends asynchronously after .stop() is called (or on its own
  // if the browser times out silence), so the actual "stop and send" happens
  // here rather than in the mouseup handler - that way we never send a
  // transcript that's still one onresult event behind.
  recognition.onend = () => {
    isListening = false;
    micButton?.classList.remove('mic-active');
    setListeningPosture(false);
    if (micTranscript.trim()) {
      sendChatMessage(micTranscript);
    }
    micTranscript = '';
  };
}

// --- Listening posture: a slight forward lean (spine.x, added on top of
// the breathing cycle in updateBreathing() above) and head tilt (head.z,
// combined in updateHeadComposite() above) while the mic is actively
// recording. Tied to isListening's real transitions (including the
// asynchronous onend/onerror below), not the raw mousedown/mouseup - the
// existing comment on recognition.onend already explains why isListening
// itself, not the button press, is the source of truth for "is it actually
// recording" here. ---
const LISTENING_LEAN_X = 0.05;
const LISTENING_HEAD_TILT_Z = 0.08;
let listeningLeanX = 0;

function setListeningPosture(active) {
  listeningLeanX = active ? LISTENING_LEAN_X : 0;
  listeningHeadTiltZ = active ? LISTENING_HEAD_TILT_Z : 0;
}

function startListening() {
  if (!recognition) {
    showChatError('Voice input is not supported in this app.');
    return;
  }
  if (isListening) return;
  micTranscript = '';
  isListening = true;
  micButton.classList.add('mic-active');
  setListeningPosture(true);
  try {
    recognition.start();
  } catch (error) {
    console.error('recognition.start() failed:', error);
    isListening = false;
    micButton.classList.remove('mic-active');
    setListeningPosture(false);
  }
}

function stopListening() {
  if (!recognition || !isListening) return;
  recognition.stop();
}

if (micButton) {
  micButton.addEventListener('mousedown', (event) => {
    event.preventDefault();
    startListening();
  });
  micButton.addEventListener('mouseup', stopListening);
  micButton.addEventListener('mouseleave', stopListening);
}

function updateLookAtTarget() {
  lookAtTarget.position.x = mouse.x * 0.5;
  lookAtTarget.position.y = 1.3 + MODEL_BASE_Y + mouse.y * 0.3;
}

// --- Head rotation composite: animState.head is shared by several
// independent systems (idle tilt/glance, the sad emotion reaction, the
// listening posture, and the look-based head extension below), so instead
// of each one writing animState.head directly and fighting over it every
// frame, each owns a small tracked variable here and this one function
// sums them into animState.head once per frame - the only place head.x/y/z
// actually get assigned. Mirrors why applyAnimState() is the sole place
// that writes bone.rotation: one writer per target, always. ---
let idleTiltHeadZ = 0; // set by updateIdleVariation()'s 'tilt' action
let idleGlanceHeadY = 0; // set by updateIdleVariation()'s 'glance' action
let emotionHeadTiltX = 0; // set by updateEmotionReaction() on 'sad'
let listeningHeadTiltZ = 0; // set by setListeningPosture()

// Eye tracking extension: past this cursor-angle threshold (magnitude of
// the normalized mouse.x/mouse.y used by updateLookAtTarget() above), a
// small proportional head rotation adds on top of the eye movement - small
// everyday eye movements near center never turn the head at all; only
// looking sharply off to a side does.
const LOOK_HEAD_THRESHOLD = 0.5;
const LOOK_HEAD_MAX_YAW = 0.12;
const LOOK_HEAD_MAX_PITCH = 0.08;

// While walking, the head stays comparatively stable next to the actively
// swinging hips/arms - only WALK_HEAD_STABILITY_FACTOR of its usual
// composite motion still comes through (1 = unaffected, 0 = frozen).
const WALK_HEAD_STABILITY_FACTOR = 0.3;

function updateHeadComposite() {
  const magnitude = Math.hypot(mouse.x, mouse.y);
  const lookFactor = magnitude <= LOOK_HEAD_THRESHOLD
    ? 0
    : Math.min(1, (magnitude - LOOK_HEAD_THRESHOLD) / (1 - LOOK_HEAD_THRESHOLD));
  const stability = isWalkingActive ? WALK_HEAD_STABILITY_FACTOR : 1;

  animState.head.x = (emotionHeadTiltX + mouse.y * lookFactor * LOOK_HEAD_MAX_PITCH) * stability;
  animState.head.y = (idleGlanceHeadY + mouse.x * lookFactor * LOOK_HEAD_MAX_YAW) * stability;
  animState.head.z = (idleTiltHeadZ + listeningHeadTiltZ) * stability;
}

let currentElapsed = 0;
let bounceActive = false;
let bounceStart = 0;

// --- Drag-end settle: when a drag (see isDraggingCharacter above) ends, a
// brief small vertical bounce plus a tiny spine sway, together lasting
// ~0.4s, before returning to normal idle - like feet landing after being
// picked up and set back down. The vertical part follows the same direct
// model.position.y pattern as entranceBobY/bounceActive (Y position was
// never part of animState - only bone rotations are); the spine sway adds
// on top of whatever updateWeightShift() set that same frame, so it must
// run after it in animate() below. ---
const SETTLE_DURATION_S = 0.4;
const SETTLE_BOB_AMPLITUDE = 0.015;
const SETTLE_SPINE_AMPLITUDE = 0.03;

let settleActive = false;
let settleStartElapsed = 0;
let settleBobY = 0;

function startSettle(elapsed) {
  settleActive = true;
  settleStartElapsed = elapsed;
}

function updateSettle(elapsed) {
  if (!settleActive) return;

  const t = elapsed - settleStartElapsed;
  if (t >= SETTLE_DURATION_S) {
    settleBobY = 0;
    settleActive = false;
    return;
  }

  // One rise-and-fall hump, decaying to 0 by the end of the window - a
  // single small settle, not an oscillation.
  const p = t / SETTLE_DURATION_S;
  const decay = 1 - p;
  const phase = Math.sin(p * Math.PI);
  settleBobY = -phase * SETTLE_BOB_AMPLITUDE * decay;
  animState.spine.z += phase * SETTLE_SPINE_AMPLITUDE * decay;
}

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

// --- Emotion from chat: driven by the "emotion" field the /chat endpoint
// now sends alongside "text". Unlike playExpression above (which snaps back
// to 0 via setTimeout), this holds at peak briefly then eases back toward
// the neutral resting expression (value 0) every frame in updateEmotionFade,
// called from animate() below - a smooth fade reads far less jarring than a
// pop, especially for a slow emotion like "sad". ---
const CHAT_EMOTION_NAMES = new Set(['happy', 'angry', 'sad', 'relaxed', 'surprised']);
const EMOTION_PEAK_VALUE = 0.8;
const EMOTION_HOLD_S = 2.5;
const EMOTION_FADE_LERP = 0.03;

let activeEmotionName = null;
let emotionFadeStartElapsed = 0;

function playEmotion(name) {
  const expressionManager = currentVrm?.expressionManager;
  if (!expressionManager || !CHAT_EMOTION_NAMES.has(name)) return;

  // Snap out any still-fading previous emotion so two never blend together.
  if (activeEmotionName && activeEmotionName !== name) {
    expressionManager.setValue(activeEmotionName, 0);
  }

  activeEmotionName = name;
  expressionManager.setValue(name, EMOTION_PEAK_VALUE);
  emotionFadeStartElapsed = currentElapsed + EMOTION_HOLD_S;
}

function updateEmotionFade(elapsed) {
  if (!activeEmotionName) return;
  const expressionManager = currentVrm?.expressionManager;
  if (!expressionManager) return;

  if (elapsed < emotionFadeStartElapsed) return;

  const current = expressionManager.getValue(activeEmotionName);
  const next = current * (1 - EMOTION_FADE_LERP);

  if (next < 0.01) {
    expressionManager.setValue(activeEmotionName, 0);
    activeEmotionName = null;
    return;
  }

  expressionManager.setValue(activeEmotionName, next);
}

// --- Breathing-rate + physical reaction, both driven by setEmotionState()
// below (the single entry point handleLyraAction calls whenever a new
// emotion arrives), rather than continuously re-derived from whatever the
// "current" emotion happens to be each frame - a snapshot taken once per
// emotion change, same spirit as activeEmotionName/emotionFadeStartElapsed
// above. ---
const BREATHING_RATE_BY_EMOTION = {
  happy: 1.4,
  surprised: 1.6,
  sad: 0.7,
  relaxed: 0.75,
  neutral: 1,
  angry: 1,
};
const ALL_EMOTION_NAMES = new Set([...CHAT_EMOTION_NAMES, 'neutral']);

// A brief physical reaction alongside the facial expression change - only
// happy/sad/surprised get one, matching the three called out in the spec.
// The bone/axis/sign choices below (shoulder lift, downward head tilt,
// backward lean) are a best guess at this rig's local axis conventions -
// not yet confirmed by watching it actually run - so flip a sign here if
// any one of these reads as the opposite direction once tested.
const EMOTION_REACTION_KIND = { happy: 'shoulder', sad: 'headTilt', surprised: 'spineLean' };
const EMOTION_REACTION_HOLD_S = 2;
const EMOTION_REACTION_EASE_S = 0.5;
const SHOULDER_LIFT_AMOUNT = 0.08;
const SAD_HEAD_TILT_AMOUNT = -0.12;
const SURPRISED_SPINE_LEAN_AMOUNT = -0.06;

let emotionSpineLeanX = 0; // read by updateBreathing() above, added on top of the breathing cycle
let reactionKind = null;
let reactionStartElapsed = 0;

function clearReactionTargets(kind) {
  if (kind === 'shoulder') {
    animState.leftShoulder.x = 0;
    animState.rightShoulder.x = 0;
  } else if (kind === 'headTilt') {
    emotionHeadTiltX = 0;
  } else if (kind === 'spineLean') {
    emotionSpineLeanX = 0;
  }
}

function triggerEmotionReaction(name, elapsed) {
  // Cut off whatever reaction was still mid-flight so two never overlap.
  if (reactionKind) clearReactionTargets(reactionKind);

  reactionKind = EMOTION_REACTION_KIND[name] || null;
  reactionStartElapsed = elapsed;
}

function updateEmotionReaction(elapsed) {
  if (!reactionKind) return;

  const t = elapsed - reactionStartElapsed;
  const totalDuration = EMOTION_REACTION_HOLD_S + EMOTION_REACTION_EASE_S;

  if (t >= totalDuration) {
    clearReactionTargets(reactionKind);
    reactionKind = null;
    return;
  }

  const amount = t < EMOTION_REACTION_HOLD_S
    ? 1
    : 1 - (t - EMOTION_REACTION_HOLD_S) / EMOTION_REACTION_EASE_S;

  if (reactionKind === 'shoulder') {
    animState.leftShoulder.x = SHOULDER_LIFT_AMOUNT * amount;
    animState.rightShoulder.x = SHOULDER_LIFT_AMOUNT * amount;
  } else if (reactionKind === 'headTilt') {
    emotionHeadTiltX = SAD_HEAD_TILT_AMOUNT * amount;
  } else if (reactionKind === 'spineLean') {
    emotionSpineLeanX = SURPRISED_SPINE_LEAN_AMOUNT * amount;
  }
}

// Single entry point for a new emotion arriving from the backend - updates
// the breathing rate, the facial expression (playEmotion above), and the
// physical reaction (above) all from the one place a "new emotion is set."
function setEmotionState(name) {
  if (!ALL_EMOTION_NAMES.has(name)) return;

  breathingRateMultiplier = BREATHING_RATE_BY_EMOTION[name] ?? 1;
  playEmotion(name);
  triggerEmotionReaction(name, currentElapsed);
}

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
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
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
  leftUpperLeg: { x: 0, y: 0, z: 0 },
  rightUpperLeg: { x: 0, y: 0, z: 0 },
  leftLowerLeg: { x: 0, y: 0, z: 0 },
  rightLowerLeg: { x: 0, y: 0, z: 0 },
};

// Center point that the continuous arm sway oscillates around.
const ARM_REST_Z = { leftUpperArm: -1.3, rightUpperArm: 1.3 };

// --- Breathing: animState.chest.x and animState.spine.x, continuous, never
// stops. Rate is scaled by breathingRateMultiplier (set once per emotion
// change by setEmotionState() below, not recalculated every frame), and
// integrated as a phase accumulator (breathingPhase += delta * rate) rather
// than Math.sin(elapsed * rate) - the latter would jump discontinuously the
// instant the multiplier changes, since elapsed is absolute total time.
// spine.x also adds emotionSpineLeanX (surprised reaction) and
// listeningLeanX (mic posture) on top of the breathing cycle itself. ---
let breathingPhase = 0;
let breathingRateMultiplier = 1;

function updateBreathing(delta) {
  breathingPhase += delta * 0.9 * breathingRateMultiplier;
  animState.chest.x = Math.sin(breathingPhase) * 0.014;
  animState.spine.x = Math.sin(breathingPhase) * 0.006 + emotionSpineLeanX + listeningLeanX;
}

// --- Weight shift: animState.spine.z only, new random target every 9-14s.
// This used to target hips.z, but hips sits at the base of the skeleton, so
// rotating it dragged the legs and feet along with it (whole-body tilt) via
// normal skeletal inheritance. animState.hips stays at {0,0,0} so the
// character stays planted during ordinary idle standing; only spine and
// everything above it (chest, neck, head, arms) sways. The one deliberate
// exception is updateWalkCycle() below, which writes hips.z for a step-synced
// sway - that's fine there specifically because the legs are also being
// animated in lockstep, so it reads as an actual gait rather than a
// standing-still character whose hips randomly rotate. ---
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
// before returning to zero (most for 2.5s; fidget is shorter, ~1s, since a
// held pose isn't the point there - the in-and-back motion itself is).
// Never repeats the same action twice in a row. Four actions: head tilt,
// glance (head+neck), shoulder shift, hand fidget. head.y/head.z themselves
// are no longer written here directly - idleTiltHeadZ/idleGlanceHeadY (see
// updateHeadComposite() above) are, since animState.head is now composited
// from several systems each frame rather than owned outright by this one. ---
const IDLE_ACTIONS = ['tilt', 'glance', 'shoulderShift', 'fidget'];
const IDLE_ACTION_MIN_MS = 12000;
const IDLE_ACTION_MAX_MS = 18000;
const IDLE_ACTION_HOLD_MS = 2500;
const FIDGET_HOLD_MS = 1000;
const HAND_FIDGET_Y = 0.3;
let lastIdleAction = null;
let idleActionActive = false;
let idleActionHoldUntil = 0;
let shoulderShiftSign = 1;
let nextIdleActionTime =
  Date.now() + IDLE_ACTION_MIN_MS + Math.random() * (IDLE_ACTION_MAX_MS - IDLE_ACTION_MIN_MS);

function resetIdleActionTargets() {
  idleGlanceHeadY = 0;
  idleTiltHeadZ = 0;
  animState.neck.y = 0;
  animState.leftShoulder.z = 0;
  animState.rightShoulder.z = 0;
  animState.leftHand.y = 0;
  animState.rightHand.y = 0;
}

function updateIdleVariation(now) {
  if (!idleActionActive && now > nextIdleActionTime) {
    const pool = IDLE_ACTIONS.filter((action) => action !== lastIdleAction);
    const action = pool[Math.floor(Math.random() * pool.length)];
    lastIdleAction = action;
    idleActionActive = true;

    if (action === 'tilt') {
      idleTiltHeadZ = (Math.random() * 2 - 1) * 0.07;
    } else if (action === 'glance') {
      idleGlanceHeadY = (Math.random() * 2 - 1) * 0.15;
      animState.neck.y = idleGlanceHeadY * 0.5;
    } else if (action === 'shoulderShift') {
      shoulderShiftSign *= -1;
      animState.leftShoulder.z = shoulderShiftSign * 0.04;
      animState.rightShoulder.z = -shoulderShiftSign * 0.04;
    } else if (action === 'fidget') {
      // Hands drift toward each other on the (otherwise unused) y axis and
      // back - the snap-to-target/reset below is eased entirely by the
      // existing per-frame lerp in applyAnimState(), same as the other
      // three actions, just with a much shorter hold so the whole in-and-
      // back reads as one ~1s fidget rather than a held pose.
      animState.leftHand.y = HAND_FIDGET_Y;
      animState.rightHand.y = -HAND_FIDGET_Y;
    }

    idleActionHoldUntil = now + (action === 'fidget' ? FIDGET_HOLD_MS : IDLE_ACTION_HOLD_MS);
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

// Still used by updateHairTouch() below to return the forearm to rest.
const RIGHT_LOWER_ARM_REST = { x: 0, y: 0, z: 0.05 };

// --- Entrance: a one-time settle-in motion played once, right after the
// model finishes loading, before the regular idle systems (breathing,
// weight shift, idle variation, arm/hand sway, arm readjust) begin. Gives
// the impression of two or three small steps as she settles into frame -
// leftUpperArm/rightUpperArm swing opposite each other on z (shoulder-level
// arm swing) in sync with a subtle spine.z side-to-side sway (reads as a
// hip-level weight shift, the same mechanism updateWeightShift() uses -
// animState.hips is left untouched here (see the comment on
// updateWeightShift for the one deliberate exception, updateWalkCycle()),
// so the sway happens at spine and above only and her feet stay planted).
// No raised arm or wave motion at all.
// It writes to the same animState fields the regular systems use, so while
// it's active those systems are simply not called for that frame (see
// animate() below) - only one thing drives those bone targets at a time. ---
const ENTRANCE_DURATION_S = 1.5;
const ENTRANCE_CYCLES = 2;
// leftUpperArm.z swings between -0.85 and -1.75 (rest -1.3 +/- 0.45); mirrored
// for rightUpperArm.z between 0.85 and 1.75 (rest 1.3 +/- 0.45).
const ENTRANCE_ARM_AMPLITUDE = 0.45;
// Side-to-side spine sway, synced to the same swing as the arms.
const ENTRANCE_SPINE_AMPLITUDE = 0.15;
// Vertical bob layered on top of MODEL_BASE_Y, synced to the same phase so
// she dips down and rises twice over the entrance - reads as footsteps
// landing rather than the arms/spine swinging in place.
const ENTRANCE_BOB_AMPLITUDE = 0.04;

let entranceActive = false;
let entranceDone = false;
let entranceStartElapsed = 0;
// Added to MODEL_BASE_Y by animate() while the entrance runs; always reset
// to exactly 0 the instant the entrance ends, so no permanent y offset
// is left on the model afterward.
let entranceBobY = 0;

function startEntrance(elapsed) {
  entranceActive = true;
  entranceStartElapsed = elapsed;
}

function updateEntrance(elapsed) {
  const t = elapsed - entranceStartElapsed;

  if (t >= ENTRANCE_DURATION_S) {
    animState.leftUpperArm.z = ARM_REST_Z.leftUpperArm;
    animState.rightUpperArm.z = ARM_REST_Z.rightUpperArm;
    animState.spine.z = 0;
    entranceBobY = 0;
    entranceActive = false;
    entranceDone = true;
    return;
  }

  // ENTRANCE_CYCLES is a whole number, so this sine is already back at
  // exactly 0 the instant t reaches ENTRANCE_DURATION_S - the swing settles
  // into the exact resting values on its own, no separate transition step
  // needed to avoid a pop.
  const phase = Math.sin(t * ((2 * Math.PI * ENTRANCE_CYCLES) / ENTRANCE_DURATION_S));

  animState.leftUpperArm.z = ARM_REST_Z.leftUpperArm + phase * ENTRANCE_ARM_AMPLITUDE;
  animState.rightUpperArm.z = ARM_REST_Z.rightUpperArm - phase * ENTRANCE_ARM_AMPLITUDE;
  animState.spine.z = phase * ENTRANCE_SPINE_AMPLITUDE;
  // Reuses the exact same phase as the arm/spine swing (not a reshaped
  // version of it), so the bob completes ENTRANCE_CYCLES down-up cycles -
  // two - landing perfectly in sync with the arm swing.
  entranceBobY = -phase * ENTRANCE_BOB_AMPLITUDE;
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
// padding at all). History: 1.18 -> 1.04 -> 0.8 -> 0.62 (deliberately past a
// full-body fit, to crop her at mid-thigh). Legs ended up cut off at the
// bottom of the screen, so this goes back up to 1.6 - pulling the camera
// back gives a taller visible window overall, which is the only way to
// restore her feet (and leave room below them) without touching
// CAMERA_LOOK_Y_OFFSET or her actual position: that offset is a fixed
// amount added on top of her live-tracked center regardless of zoom, so at
// any margin, part of what it pushes the frame up by has to be recovered by
// margin just to stop cropping her feet - then more on top of that for
// actual visible space below them.
//
// CAMERA_LOOK_Y_OFFSET: cameraLookY below always converges to her live
// vertical center every frame (that's what "auto-framing" means), so a
// one-time edit to CAMERA_BASE_LOOK_Y or to MODEL_BASE_Y has no lasting
// effect - the tracking just re-centers on wherever she actually is, and
// moving the model can never crop her since the camera follows. This
// constant is the only lever that actually shifts what's visible: a
// persistent offset added on top of her live center, independent of her
// position. Left at 0.32 (unchanged) - only the margin above changed here. ---
const CAMERA_FRAME_MARGIN = 1.6; // was 0.62
const CAMERA_LOOK_Y_OFFSET = 0.32; // unchanged
const _boneWorldPos = new THREE.Vector3();
const _hipsWorldPos = new THREE.Vector3();
const _screenProjectPos = new THREE.Vector3();
let cameraLookY = CAMERA_BASE_LOOK_Y;
let cameraDistance = CAMERA_BASE_DISTANCE;

// Her real on-screen pixel position, recomputed every frame in
// updateCameraFraming() below by projecting her live world-space center
// through the camera. Now that the window spans the whole desktop rather
// than being cropped tightly around her, "window center" no longer equals
// "where she renders" - the mousemove listener reads these instead of
// deriving a position from window.innerWidth/innerHeight.
let characterScreenX = window.innerWidth / 2;
let characterScreenY = window.innerHeight / 2;

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
  // userSizeMultiplier (see the Ctrl+scroll listener above) is applied here,
  // after the crop-framing distance is otherwise fully determined - it's a
  // pure zoom on top, not a change to what part of her body is in frame.
  const targetDistance = Math.max(CAMERA_BASE_DISTANCE, requiredDistance) / userSizeMultiplier;

  // CAMERA_LOOK_Y_OFFSET is a fixed world-space amount, but the visible frame
  // height shrinks as userSizeMultiplier zooms in (targetDistance below is
  // divided by it too) - left unscaled, that fixed offset would eat a
  // growing share of the shrinking frame and push it up past her feet.
  // Dividing the offset by the same multiplier keeps it a constant fraction
  // of the frame at any zoom level, so the padding below her feet that's
  // there at userSizeMultiplier = 1 stays proportionally there always.
  cameraLookY += (centerY + CAMERA_LOOK_Y_OFFSET / userSizeMultiplier - cameraLookY) * 0.05;
  cameraDistance += (targetDistance - cameraDistance) * 0.05;

  camera.position.set(0, cameraLookY, cameraDistance);
  camera.lookAt(0, cameraLookY, 0);
  // .project() below reads camera.matrixWorldInverse, which is only
  // refreshed lazily on render - force it now so the projection reflects
  // the position/lookAt just set above, not last frame's.
  camera.updateMatrixWorld();

  // Project her live world-space center (not window geometry) to actual
  // screen pixels, so click-through detection tracks where she really is
  // regardless of how large or how positioned the window is.
  const hips = humanoid.getNormalizedBoneNode('hips');
  const originX = hips ? hips.getWorldPosition(_hipsWorldPos).x : 0;
  _screenProjectPos.set(originX, centerY, 0);
  _screenProjectPos.project(camera);
  characterScreenX = (_screenProjectPos.x * 0.5 + 0.5) * window.innerWidth;
  characterScreenY = (-_screenProjectPos.y * 0.5 + 0.5) * window.innerHeight;
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
      // MODEL POSITION - stays at MODEL_BASE_Y except during the task-done
      // bounce, or the footstep bob layered on top while the entrance runs.
      // entranceBobY is always exactly 0 once entranceDone is true (reset in
      // updateEntrance above), so it leaves no permanent offset behind.
      let modelY = MODEL_BASE_Y + entranceBobY + settleBobY + walkCycleBobY;
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

        // The entrance plays once, right after load, before any other
        // system touches animState. While it's active it's the only thing
        // driving leftUpperArm/rightUpperArm/spine; the regular systems
        // below simply don't run yet, so nothing fights over those targets.
        if (!entranceDone && !entranceActive) {
          startEntrance(elapsed);
        }

        if (entranceActive) {
          updateEntrance(elapsed);
        } else if (entranceDone) {
          // ---- Systems: each writes ONLY to its own animState bone field(s),
          // never to a bone.rotation directly. ----
          updateBreathing(delta);
          updateWeightShift(now);
          // Must run after updateWeightShift() - it adds its transient sway
          // on top of whatever spine.z that just set, rather than owning it.
          updateSettle(elapsed);
          updateIdleVariation(now);
          updateArmSway(elapsed);
          updateHandSway(elapsed);
          updateHairTouch(now, elapsed);
          // Skipped while the hair-touch gesture is active (both can target
          // rightUpperArm.x, and hair-touch should never be interrupted
          // mid-gesture) or while walking (updateWalkCycle() owns
          // leftUpperArm.x/rightUpperArm.x for the counter-swing while
          // isWalkingActive, and a readjust firing mid-stride would fight it
          // on the same axis).
          if (!hairTouchActive && !isWalkingActive) {
            updateArmReadjust(now);
          }
        }

        updateMicroExpression(elapsed);
        updateEmotionFade(elapsed);
        updateEmotionReaction(elapsed);
        updateLookAtTarget();
        // Must run after updateIdleVariation()/updateEmotionReaction() above
        // - it composites idleTiltHeadZ/idleGlanceHeadY/emotionHeadTiltX/
        // listeningHeadTiltZ (each set elsewhere) into animState.head.
        updateHeadComposite();
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
    console.log('WebSocket speak message received:', data);
    window.showSpeech?.(data.text, 3000);
    if (data.emotion) setEmotionState(data.emotion);
    if (typeof data.audio === 'string' && data.audio) playAudioWithMouthSync(data.audio);
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
