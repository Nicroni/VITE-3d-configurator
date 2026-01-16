
// src/core/scene.js
// --------------------------------------
// Scene, Camera, Light rig + Groups
// Environment helpers (PMREM/HDR), Resize, Dispose
//
// Dependencies: three (from node_modules)
import * as THREE from 'three';

let _scene = null;
let _camera = null;
let _lightRig = null;
let _groups = null;   // { root, product, decals, zones, helpers }
let _grid = null;
let _pmrem = null;

/** Types
 * @typedef {{
 *  fov?:number, near?:number, far?:number, aspect?:number,
 *  cameraZ?:number,
 *  background?: number|string|null, // hex | 'transparent' | null
 *  useRoomEnv?: boolean,
 *  lightProfile?: 'studio'|'neutral'|'dramatic'|CustomLightProfile,
 *  showGrid?: boolean
 * }} SceneInitOptions
 *
 * @typedef {{
 *  ambient?:{ intensity?:number, color?:number },
 *  hemi?:   { intensity?:number, skyColor?:number, groundColor?:number },
 *  key?:    { intensity?:number, color?:number, position?:[number,number,number] },
 *  fill?:   { intensity?:number, color?:number, position?:[number,number,number] },
 *  rim?:    { intensity?:number, color?:number, position?:[number,number,number] }
 * }} CustomLightProfile
 */

const DEFAULTS = {
  fov: 35,
  near: 0.1,
  far: 100,
  aspect: 16 / 9,
  cameraZ: 2.2,
  background: 0xf4f5f7,
  useRoomEnv: false,   // RoomEnvironment-ийг main талд сонголтоор ашиглах
  lightProfile: 'studio',
  showGrid: false,
};

const LIGHT_PROFILES = {
  studio: /** @type {CustomLightProfile} */({
    ambient: { intensity: 0.25, color: 0xffffff },
    hemi:    { intensity: 0.55, skyColor: 0xffffff, groundColor: 0x444444 },
    key:     { intensity: 2.2,  color: 0xfff1e0,   position: [2.5, 3.5, 2.5] },
    fill:    { intensity: 0.9,  color: 0xcfe7ff,   position: [-2.5, 1.5, 2.0] },
    rim:     { intensity: 1.2,  color: 0xffffff,   position: [-1.0, 2.5, -2.5] },
  }),
  neutral: /** @type {CustomLightProfile} */({
    ambient: { intensity: 0.2, color: 0xffffff },
    hemi:    { intensity: 0.4, skyColor: 0xe0e0e0, groundColor: 0x909090 },
    key:     { intensity: 1.2, color: 0xffffff,   position: [2.0, 2.0, 2.0] },
    fill:    { intensity: 0.6, color: 0xffffff,   position: [-2.0, 1.0, 2.0] },
    rim:     { intensity: 0.8, color: 0xffffff,   position: [-1.0, 2.0, -2.0] },
  }),
  dramatic: /** @type {CustomLightProfile} */({
    ambient: { intensity: 0.12, color: 0xffffff },
    hemi:    { intensity: 0.25, skyColor: 0xffffff, groundColor: 0x222233 },
    key:     { intensity: 3.0,  color: 0xffe7c7,   position: [3.5, 3.5, 1.5] },
    fill:    { intensity: 0.35, color: 0x88aaff,   position: [-2.5, 1.0, 2.5] },
    rim:     { intensity: 1.8,  color: 0xffffff,   position: [-1.5, 3.0, -2.5] },
  }),
};

function createGroups() {
  const root = new THREE.Group(); root.name = 'ROOT';
  const product = new THREE.Group(); product.name = 'ProductRoot';
  const decals = new THREE.Group(); decals.name = 'DecalsRoot';
  const zones = new THREE.Group(); zones.name = 'ZonesRoot';
  const helpers = new THREE.Group(); helpers.name = 'HelpersRoot';
  root.add(product, decals, zones, helpers);
  return { root, product, decals, zones, helpers };
}

function createLightRig(profile) {
  const p = profile || LIGHT_PROFILES.studio;
  const rig = new THREE.Group(); rig.name = 'LightRig';

  const ambient = new THREE.AmbientLight(
    p.ambient?.color ?? 0xffffff,
    p.ambient?.intensity ?? 0.2
  ); ambient.name = 'Ambient';

  const hemi = new THREE.HemisphereLight(
    p.hemi?.skyColor ?? 0xffffff,
    p.hemi?.groundColor ?? 0x444444,
    p.hemi?.intensity ?? 0.4
  ); hemi.name = 'Hemi'; hemi.position.set(0, 1, 0);

  const key = new THREE.DirectionalLight(
    p.key?.color ?? 0xffffff,
    p.key?.intensity ?? 1.5
  ); key.name = 'Key';
  key.position.fromArray(p.key?.position ?? [2, 3, 2]);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 2;

  const fill = new THREE.DirectionalLight(
    p.fill?.color ?? 0xffffff,
    p.fill?.intensity ?? 0.7
  ); fill.name = 'Fill';
  fill.position.fromArray(p.fill?.position ?? [-2, 1, 2]);

  const rim = new THREE.DirectionalLight(
    p.rim?.color ?? 0xffffff,
    p.rim?.intensity ?? 1.0
  ); rim.name = 'Rim';
  rim.position.fromArray(p.rim?.position ?? [-1, 2, -2]);

  rig.add(ambient, hemi, key, fill, rim);
  return rig;
}

/**
 * Initialize Scene + Camera + Lights + Groups
 * @param {SceneInitOptions} [opts]
 */
export function initScene(opts = {}) {
  if (_scene) {
    console.warn('[scene] initScene() called again; returning existing context.');
    return getContext();
  }
  const cfg = { ...DEFAULTS, ...opts };

  _scene = new THREE.Scene();

  // Background
  if (cfg.background === 'transparent' || cfg.background === null) {
    _scene.background = null;
  } else if (typeof cfg.background === 'number') {
    _scene.background = new THREE.Color(cfg.background);
  } else {
    _scene.background = new THREE.Color(DEFAULTS.background);
  }

  // Groups
  _groups = createGroups();
  _scene.add(_groups.root);

  // Grid helper (optional)
  _grid = new THREE.GridHelper(10, 20, 0x888888, 0xcccccc);
  _grid.name = 'GridHelper';
  _grid.visible = !!cfg.showGrid;
  _groups.helpers.add(_grid);

  // Camera
  _camera = new THREE.PerspectiveCamera(
    cfg.fov, cfg.aspect ?? (16/9), cfg.near, cfg.far
  );
  _camera.position.set(0, 1.15, cfg.cameraZ);
  _camera.lookAt(0, 1, 0);
  _camera.name = 'MainCamera';

  // Lights
  const profile = typeof cfg.lightProfile === 'string'
    ? (LIGHT_PROFILES[cfg.lightProfile] ?? LIGHT_PROFILES.studio)
    : (cfg.lightProfile ?? LIGHT_PROFILES.studio);
  _lightRig = createLightRig(profile);
  _scene.add(_lightRig);

  // Color space
  THREE.ColorManagement.enabled = true;

  return getContext();
}

/** Return handles */
export function getContext() {
  return { scene: _scene, camera: _camera, groups: _groups, lightRig: _lightRig };
}
export function getScene() { return _scene; }
export function getCamera() { return _camera; }
export function getGroups() { return _groups; }
export function getLightRig() { return _lightRig; }

/** Attach object into a bucket */
export function attach(object, opts = {}) {
  if (!object || !_groups) return;
  const slot = opts.slot ?? 'product';
  if (opts.name) object.name = opts.name;
  switch (slot) {
    case 'product': _groups.product.add(object); break;
    case 'decals':  _groups.decals.add(object); break;
    case 'zones':   _groups.zones.add(object); break;
    case 'helpers': _groups.helpers.add(object); break;
    default:        _groups.root.add(object); break;
  }
}

/** Camera aspect & projection on resize */
export function onResize(width, height) {
  if (!_camera) return;
  const aspect = Math.max(1e-6, width / Math.max(1, height));
  _camera.aspect = aspect;
  _camera.updateProjectionMatrix();
}

/** Toggle helper visibility (Grid & HelpersRoot) */
export function toggleHelpers(visible) {
  if (_groups?.helpers) _groups.helpers.visible = visible;
}

/** Change scene background */
export function setBackground(background) {
  if (!_scene) return;
  if (background === 'transparent' || background === null) {
    _scene.background = null;
  } else if (typeof background === 'number') {
    _scene.background = new THREE.Color(background);
  }
}

/** Update light profile at runtime */
export function setLightProfile(profile) {
  if (!_scene || !_lightRig) return;
  _scene.remove(_lightRig);
  const resolved = typeof profile === 'string'
    ? (LIGHT_PROFILES[profile] ?? LIGHT_PROFILES.studio)
    : (profile ?? LIGHT_PROFILES.studio);
  _lightRig = createLightRig(resolved);
  _scene.add(_lightRig);
}

/** Prepare PMREM generator using a renderer (call once per renderer) */
export function ensurePMREM(renderer) {
  if (!renderer) return null;
  if (_pmrem) return _pmrem;
  _pmrem = new THREE.PMREMGenerator(renderer);
  _pmrem.compileEquirectangularShader();
  return _pmrem;
}

/** Apply environment from a loaded equirect texture (PMREM) */
export function setEnvironmentFromTexture(renderer, texture) {
  if (!_scene || !renderer || !texture) return;
  const pmrem = ensurePMREM(renderer);
  const envMap = pmrem.fromEquirectangular(texture).texture;
  _scene.environment = envMap;
  // _scene.background = envMap; // хүсвэл background болгож ашиглаж болно
  texture.dispose?.();
}

/** (Optional) Clear all resources */
export function disposeScene() {
  if (!_scene) return;

  _scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && typeof v === 'object' && v.isTexture) v.dispose?.();
        }
        m.dispose?.();
      }
    }
  });

  if (_scene.environment?.dispose) _scene.environment.dispose();
  if (_pmrem) { _pmrem.dispose(); _pmrem = null; }

  _grid = null;
  _lightRig = null;
  _groups = null;
  _camera = null;
  _scene = null;
}

/** Export builtin light profiles (if you want to use from main) */
export const LightProfiles = Object.freeze({ ...LIGHT_PROFILES });
