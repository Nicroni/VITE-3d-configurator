// src/core/controls.js
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

let controls = null;
let _mode = 'EDIT'; // 'EDIT' | 'LOCKED'

/**
 * Create OrbitControls bound to renderer.domElement
 *
 * EDIT  => zoom OFF (wheel reserved for artwork scale)
 * LOCKED=> zoom ON  (user can zoom/inspect)
 *
 * @param {import('three').Camera} camera
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   enableDamping?: boolean,
 *   dampingFactor?: number,
 *   rotateSpeed?: number,
 *   panSpeed?: number,
 *   enablePan?: boolean,
 *   minDistance?: number,
 *   maxDistance?: number,
 *   target?: { x:number, y:number, z:number } | null
 * }} [opts]
 */
export function createControls(camera, canvas, opts = {}) {
  if (!camera) throw new Error('[controls] camera is required');
  if (!canvas) throw new Error('[controls] canvas is required');

  controls = new OrbitControls(camera, canvas);

  // Feel
  controls.enableDamping = opts.enableDamping ?? true;
  controls.dampingFactor = opts.dampingFactor ?? 0.08;
  controls.rotateSpeed = opts.rotateSpeed ?? 0.6;
  controls.panSpeed = opts.panSpeed ?? 0.8;

  // Configurator-д pan ихэвчлэн төөрөгдүүлдэг
  controls.enablePan = opts.enablePan ?? false;

  // Optional distance clamps
  if (typeof opts.minDistance === 'number') controls.minDistance = opts.minDistance;
  if (typeof opts.maxDistance === 'number') controls.maxDistance = opts.maxDistance;

  // ✅ IMPORTANT:
  // Зарим three хувилбар дээр THREE.TOUCH байхгүй тул
  // энд ямар ч THREE.TOUCH.ROTATE гэх мэт reference хийхгүй.
  // OrbitControls default touches/mouse mapping-аа өөрөө зөв тохируулдаг.

  // Default: EDIT mode => wheel zoom OFF
  controls.enableZoom = false;

  // Optional initial target
  if (opts.target) {
    controls.target.set(opts.target.x, opts.target.y, opts.target.z);
  }

  controls.update();
  return controls;
}

/**
 * EDIT => zoom OFF
 * LOCKED => zoom ON
 * @param {'EDIT'|'LOCKED'} mode
 */
export function setControlMode(mode) {
  _mode = mode === 'LOCKED' ? 'LOCKED' : 'EDIT';
  if (!controls) return;

  controls.enabled = true;
  controls.enableZoom = _mode === 'LOCKED';
}

/** OrbitControls instance */
export function getControls() {
  return controls;
}

/** Current mode */
export function getControlMode() {
  return _mode;
}

/** Completely enable/disable controls */
export function setControlsEnabled(enabled) {
  if (!controls) return;
  controls.enabled = !!enabled;
}

/** Call inside animation loop */
export function updateControls() {
  controls?.update();
}
