
// src/core/controls.js
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

let controls = null;

/**
 * @param {THREE.Camera} camera
 * @param {HTMLCanvasElement} canvas
 */
export function createControls(camera, canvas) {
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enableZoom = false; // EDIT mode by default: wheel reserved for artwork scale
  return controls;
}

/** LOCKED mode => orbit zoom ON, EDIT => orbit zoom OFF */
export function setControlMode(mode /* 'EDIT' | 'LOCKED' */) {
  if (!controls) return;
  const isLocked = mode === 'LOCKED';
  controls.enabled = true;
  controls.enableZoom = isLocked;
}

/** call in your render loop */
export function updateControls() {
  controls?.update();
}
``
