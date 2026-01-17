// src/main.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import './styless.css';

import { initScene, getContext } from './core/scene.js';
import { createRenderer, resizeRendererToElement } from './core/renderer.js';
import { createControls, setControlMode, updateControls } from './core/controls.js';
import { hitTest } from './core/raycast.js';

import { createArtworkController } from './editor/placement.js';
import { setupUVEditor } from './editor/uvCanvas.js';

import { buildPrintZoneFromMesh, isUVInsidePrintZone } from './zones/zoneDetector.js';
import { uvToPrintCM } from './zones/zoneMetrics.js';
import { pickOnMeshByUV } from './zones/uvPick.js';

import {
  createDecalMaterial,
  setArtworkTextureFromImage,
  hasArtworkTexture
} from './decal/decalMaterial.js';

import { buildPoseFromHit } from './decal/decalPose.js';
import { buildDecalMesh, disposeDecalMesh } from './decal/decalBuilder.js';

import { bakeTemplatePNGAndJSON, bakeManyPNGsAndJSON } from './print/exportPNG.js';
import { loadImageFromFile } from './utils/image.js';
import { downloadDataURL, downloadText } from './utils/download.js';

import { ZONE_CM } from './config/printZones.js';
import { DEFAULT_DPI, DEFAULT_TEMPLATE_PX, DECAL_DEPTH, WORLD_ZONE_W } from './config/constants.js';
import { getSafeRectRel, clampPlacementToSafe } from './editor/safeZone.js';

// --------------------
// DOM
// --------------------
const hud = document.getElementById('hud');
const btnExport = document.getElementById('btnExport');
const fileInput = document.getElementById('file');
const btnSubmit = document.getElementById('btnSubmit');
const btnEdit = document.getElementById('btnEdit');
const overlayBox = document.getElementById('overlayBox');
const zoneLabel = document.getElementById('zoneLabel');

const btnZoneFront = document.getElementById('zoneFront');
const btnZoneBack = document.getElementById('zoneBack');
const btnZoneLeftArm = document.getElementById('zoneLeftArm');
const btnZoneRightArm = document.getElementById('zoneRightArm');

const chkSnapCenter = document.getElementById('chkSnapCenter');
const chkSnapGrid = document.getElementById('chkSnapGrid');
const gridCmInput = document.getElementById('gridCm');
const inpWidthCm = document.getElementById('inpWidthCm');
const btnApplyCm = document.getElementById('btnApplyCm');

const uvTabs = document.getElementById('uvTabs');

const viewer3d = document.getElementById('viewer3d');
if (!viewer3d) throw new Error('#viewer3d not found');

const artCanvas = document.getElementById('artCanvas');
const artViewport = document.getElementById('artViewport');

// overlay handles
const hTL = overlayBox ? overlayBox.querySelector('.tl') : null;
const hTR = overlayBox ? overlayBox.querySelector('.tr') : null;
const hBL = overlayBox ? overlayBox.querySelector('.bl') : null;
const hBR = overlayBox ? overlayBox.querySelector('.br') : null;

// --------------------
// Scene + Renderer
// --------------------
initScene({
  background: 0xeeeeee,
  lightProfile: 'studio',
  aspect: viewer3d.clientWidth / Math.max(1, viewer3d.clientHeight),
});

const { scene, camera } = getContext();
const { renderer, canvas } = createRenderer(viewer3d, { alpha: false });

if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
else renderer.outputEncoding = THREE.sRGBEncoding;

renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

const controls = createControls(camera, canvas);
setControlMode('EDIT');

// --------------------
// Model fit helpers
// --------------------
let _modelBox = null;
let _modelSize = null;
let _modelCenter = null;

function fitCameraToModel(framing = 1.35) {
  if (!_modelBox || !_modelSize) return;

  const center = new THREE.Vector3(0, 0, 0);
  const maxDim = Math.max(_modelSize.x, _modelSize.y, _modelSize.z);

  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeightDistance = (maxDim / 2) / Math.tan(fov / 2);
  const fitWidthDistance = fitHeightDistance / Math.max(1e-6, camera.aspect);
  const dist = framing * Math.max(fitHeightDistance, fitWidthDistance);

  controls.target.copy(center);
  camera.position.set(center.x, center.y, center.z + dist);

  camera.near = Math.max(0.01, dist / 100);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function handleResize() {
  const rect = viewer3d.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  resizeRendererToElement(renderer, viewer3d);
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
  if (_modelBox && _modelSize && _modelCenter) fitCameraToModel(1.35);
}
handleResize();
window.addEventListener('resize', handleResize);
new ResizeObserver(handleResize).observe(viewer3d);

// --------------------
// Global State
// --------------------
const productKey = 'tshirt';

const ZONE_MESH_NAMES = {
  front: 'PRINT_ZONE_FRONT',
  back: 'PRINT_ZONE_BACK',
  left_arm: 'PRINT_ZONE_LEFT_ARM',
  right_arm: 'PRINT_ZONE_RIGHT_ARM',
};

const zoneDrafts = {
  front:     { image: null, placement: null, locked: false },
  back:      { image: null, placement: null, locked: false },
  left_arm:  { image: null, placement: null, locked: false },
  right_arm: { image: null, placement: null, locked: false },
};

function saveDraftFor(key) {
  if (!key) return;
  const d = zoneDrafts[key];
  if (!d) return;
  d.image = artworkCtrl.getImage?.() || null;
  d.placement = artworkCtrl.getPlacement?.() ? { ...artworkCtrl.getPlacement() } : null;
}

function restoreDraftFor(key) {
  const d = zoneDrafts[key];
  if (!d) return;

  // restore image + placement into controller
  artworkCtrl.setImage(d.image || null);
  artworkCtrl.setPlacement(d.placement ? { ...d.placement } : null);

  // update 3D material texture to match this zone's image
  if (d.image) {
    setArtworkTextureFromImage(d.image, decalMat, renderer, { flipU: true });
  }
}

let tshirtRoot = null;

let zones = {};              // { front:{uMin..}, back:{..} ... }
let activeZoneKey = 'front';
let zoneMesh = null;
let printZone = null;

let printZoneCM = (ZONE_CM?.[productKey]?.[activeZoneKey]) || { width: 30, height: 40 };
let WORLD_ZONE_W_DYNAMIC = WORLD_ZONE_W;

let isDragging = false;






// decal per zone
const zoneDecals = {
  // key: { mesh, pose, material, image, placement, printZoneCM }
};

let decalPose = null;
let decalW = 0.25;
let decalH = 0.25;

let editor = null;

let decalBuildRaf = 0;
function scheduleDecalRebuild() {
  if (decalBuildRaf) return;
  decalBuildRaf = requestAnimationFrame(() => {
    decalBuildRaf = 0;
    applyDecalFromPose();
  });
}

// --------------------
// Artwork / material
// --------------------
const { material: decalMat } = createDecalMaterial(renderer);

function redraw2D() {
  if (!editor) return;
  editor.drawEditor?.();
  editor.updateOverlayBox?.();
}

const artworkCtrl = createArtworkController({
  onUpdate: () => {
    redraw2D();
    const poseOK = updatePoseFromPlacementUV();
    if (artworkCtrl.hasImage() && (decalPose || poseOK)) scheduleDecalRebuild();
  }
});

// --------------------
// Helpers
// --------------------

function setActiveTabUI(key) {
  uvTabs?.querySelectorAll('.uvTab').forEach(b => {
    b.classList.toggle('is-active', b.dataset.zone === key);
  });
}

uvTabs?.addEventListener('click', (e) => {
  const btn = e.target.closest('.uvTab');
  if (!btn) return;
  const key = btn.dataset.zone;
  setActiveZone(key);
  setActiveTabUI(key);
});


function ensureZoneDecal(key) {
  if (!zoneDecals[key]) {
    zoneDecals[key] = {
      mesh: null,
      pose: null,
      material: createDecalMaterial(renderer).material,
      image: null,
      placement: null,
      printZoneCM: null,
    };
  }
  return zoneDecals[key];
}

function clearZoneDecal(key) {
  const zs = ensureZoneDecal(key);
  if (zs.mesh) {
    disposeDecalMesh(zs.mesh, scene);
    zs.mesh = null;
  }
  zs.pose = null;
  zs.image = null;
  zs.placement = null;
  zs.printZoneCM = null;
}

function clampPlacementNow() {
  const p = artworkCtrl.getPlacement?.();
  if (!p) return false;

  const key = activeZoneKey || 'front';
  const safe = getSafeRectRel(key, printZoneCM);

  const maxUS = Math.max(1e-6, safe.uMax - safe.uMin);
  const maxVS = Math.max(1e-6, safe.vMax - safe.vMin);
  p.uScale = Math.min(p.uScale, maxUS);
  p.vScale = Math.min(p.vScale, maxVS);

  clampPlacementToSafe(p, safe);
  artworkCtrl.setPlacement(p);
  return true;
}

function readSnapUI() {
  return {
    enableCenter: !!chkSnapCenter?.checked,
    enableGrid: !!chkSnapGrid?.checked,
    gridCm: Math.max(0.1, parseFloat(gridCmInput?.value || '1')),
  };
}

function syncDecalWHFromPlacement() {
  const p = artworkCtrl.getPlacement();
  const img = artworkCtrl.getImage();
  if (!p || !img) return;

  const w = p.uScale * WORLD_ZONE_W_DYNAMIC;
  const ratio = img.height / Math.max(1e-6, img.width);
  const h = w * ratio;

  decalW = Math.min(1.5, Math.max(0.05, w));
  decalH = Math.min(1.5, Math.max(0.05, h));
}

// placement (zone-local) -> abs UV (v flip)
function relToAbsUV(pu, pv, rect) {
  const u = rect.uMin + pu * (rect.uMax - rect.uMin);
  const v = rect.vMin + pv * (rect.vMax - rect.vMin);

  const EPS = 1e-4;
  return new THREE.Vector2(
    Math.min(1 - EPS, Math.max(EPS, u)),
    Math.min(1 - EPS, Math.max(EPS, v))
  );
}


function findHitWithFallback(targetMesh, prefUV) {
  let hit = pickOnMeshByUV(targetMesh, prefUV, { uvAttr: 'uv' });
  if (!hit) hit = pickOnMeshByUV(targetMesh, prefUV, { uvAttr: 'uv2' });
  if (hit) return hit;

  if (!printZone) return null;

  const STEPS = [0, 1, -1, 2, -2];
  const STEP = 0.04;

  const uRel0 = (prefUV.x - printZone.uMin) / (printZone.uMax - printZone.uMin);
  const vRel0 = (prefUV.y - printZone.vMin) / (printZone.vMax - printZone.vMin);

  for (const dy of STEPS) {
    for (const dx of STEPS) {
      if (dx === 0 && dy === 0) continue;
      const pu = Math.min(1, Math.max(0, uRel0 + dx * STEP));
      const pv = Math.min(1, Math.max(0, vRel0 + dy * STEP));
      const uv = relToAbsUV(pu, pv, printZone);

      let h = pickOnMeshByUV(targetMesh, uv, { uvAttr: 'uv' });
      if (!h) h = pickOnMeshByUV(targetMesh, uv, { uvAttr: 'uv2' });
      if (h) return h;
    }
  }
  return null;
}

function updatePoseFromPlacementUV() {
  if (!printZone) return false;
  if (!zoneMesh || !zoneMesh.isMesh) return false;

  const p = artworkCtrl.getPlacement?.();
  if (!p) return false;

  const prefUV = relToAbsUV(p.u, p.v, printZone);

  let hit = pickOnMeshByUV(zoneMesh, prefUV, { uvAttr: 'uv' });
  if (!hit) hit = pickOnMeshByUV(zoneMesh, prefUV, { uvAttr: 'uv2' });
  if (!hit) hit = findHitWithFallback(zoneMesh, prefUV);
  if (!hit) return false;

  const pose = buildPoseFromHit(hit);
  if (!pose) return false;

  // ✅ save pose into active zone slot
  pose.object = zoneMesh;
  decalPose = pose;

  const zs = ensureZoneDecal(activeZoneKey);
  zs.pose = pose;

  return true;
}

function applyDecalFromPose() {
  const zs = ensureZoneDecal(activeZoneKey);
  if (!zs.pose || !artworkCtrl.hasImage() || !hasArtworkTexture()) return;
  if (!zs.material?.map) return;

  syncDecalWHFromPlacement();
  const rotationRad = (artworkCtrl.getPlacement()?.rotationRad) || 0;

  const mesh = buildDecalMesh(
    zs.pose,
    { width: decalW, height: decalH, depth: DECAL_DEPTH },
    rotationRad,
    zs.material
  );

  if (zs.mesh) disposeDecalMesh(zs.mesh, scene);
  zs.mesh = mesh;
  scene.add(zs.mesh);
}

// --------------------
// HUD
// --------------------
function renderHUD(hitUV) {
  if (!printZone) return;

  const a = artworkCtrl.getPlacement();
  if (!a) {
    hud.textContent = hitUV
      ? `UV: ${hitUV.x.toFixed(3)}, ${hitUV.y.toFixed(3)}\n(no placement yet)`
      : `Ready.`;
    return;
  }

  const cm = hitUV ? uvToPrintCM(hitUV, printZone, printZoneCM) : null;
  hud.textContent =
`${hitUV ? `UV: ${hitUV.x.toFixed(3)}, ${hitUV.y.toFixed(3)}` : 'UV: -'}
${cm ? `PRINT cm: x=${cm.x_cm?.toFixed(2)}, y=${cm.y_cm?.toFixed(2)}` : ''}
Artwork:
  center: u=${a.u?.toFixed(4)}, v=${a.v?.toFixed(4)}
  size:   uS=${a.uScale?.toFixed(4)}, vS=${a.vScale?.toFixed(4)}
  rot:    ${((a.rotationRad || 0) * 57.2958).toFixed(1)}°
Zone: ${activeZoneKey} | ${isLocked() ? 'LOCKED' : 'EDIT'}`;
}

// --------------------
// Lock / Edit (per-zone)
// --------------------
// --------------------
// Lock / Edit (per-zone via zoneDrafts.locked)
// --------------------
function isZoneLocked(key) {
  return !!zoneDrafts?.[key]?.locked;
}
function isLocked() {
  return isZoneLocked(activeZoneKey);
}

function syncLockUI() {
  const locked = isLocked();
  setControlMode(locked ? 'LOCKED' : 'EDIT');
  if (btnSubmit) btnSubmit.disabled = locked;
  if (btnEdit) btnEdit.disabled = !locked;
}

function setLockedStateForZone(key, lock) {
  if (!zoneDrafts?.[key]) return;
  zoneDrafts[key].locked = !!lock;
  syncLockUI();
}


btnSubmit?.addEventListener('click', () => {
  const d = zoneDrafts[activeZoneKey];
  const zs = ensureZoneDecal(activeZoneKey);

  // draft дээр image+placement байх ёстой
  if (!d?.image || !d?.placement) {
    alert('Upload + place artwork first.');
    return;
  }

  // pose баталгаажуулна (заримдаа tab солиход pose null болдог)
  const poseOK = updatePoseFromPlacementUV();
  if (!poseOK || !zs.pose) {
    alert('Pose not ready. Click on the 3D zone once to place.');
    return;
  }

  // энэ zone-ийн decal snapshot хадгалалт (3D дээр үлдээнэ)
  zs.image = d.image;
  zs.placement = { ...d.placement };
  zs.printZoneCM = { ...printZoneCM };

  scheduleDecalRebuild();

  // ✅ зөвхөн active zone-ийг LOCK болгоно
  setLockedStateForZone(activeZoneKey, true);

  // ✅ submit хийсний дараа "дараагийн зураг upload" боломжтой
  if (fileInput) fileInput.value = '';

  hud.textContent += `\n✅ Saved & Locked: ${activeZoneKey}. You can upload next image now.`;
});

btnEdit?.addEventListener('click', () => {
  const zs = ensureZoneDecal(activeZoneKey);
  if (!zs?.mesh && !(zoneDrafts[activeZoneKey]?.image && zoneDrafts[activeZoneKey]?.placement)) {
    // юу ч алга байвал edit хийх шаардлагагүй
    return;
  }

  setLockedStateForZone(activeZoneKey, false);

  // хэрвээ өмнө saved байсан бол editor дээр буцааж гаргана
  const d = zoneDrafts[activeZoneKey];
  if (d?.image) setArtworkTextureFromImage(d.image, decalMat, renderer, { flipU: true });

  redraw2D();
  hud.textContent += `\n✏️ Edit: ${activeZoneKey}`;
});




// --------------------
// Zone selector
// --------------------
function setActiveZone(key) {
  // ✅ 1) save current zone draft BEFORE switching
  saveDraftFor(activeZoneKey);

  if (!zones?.[key]) {
    console.warn('[setActiveZone] missing zone rect:', key);
    return;
  }

  activeZoneKey = key;

  // print cm size update
  printZoneCM = (ZONE_CM?.[productKey]?.[activeZoneKey]) || printZoneCM;

  // mesh by name
  const meshName = ZONE_MESH_NAMES[key];
  let found = null;
  tshirtRoot?.traverse(o => { if (o.name === meshName) found = o; });
  zoneMesh = found;

  // dynamic zone width
  if (zoneMesh) {
    const b = new THREE.Box3().setFromObject(zoneMesh);
    const s = b.getSize(new THREE.Vector3());
    WORLD_ZONE_W_DYNAMIC = Math.max(s.x, s.z);
  }

  printZone = zones[key];

  // label
  if (zoneLabel && printZoneCM) {
    zoneLabel.textContent = `Print Zone: ${printZoneCM.width} × ${printZoneCM.height} cm (${key})`;
  }

  // ✅ 2) restore new zone draft (ALWAYS, if-ээс гадна!)
  restoreDraftFor(activeZoneKey);

  // ✅ lock UI sync
  syncLockUI();

  // redraw 2D
  redraw2D();

  // if this zone has placement+image, rebuild pose/decal
  if (zoneDrafts[activeZoneKey]?.image && zoneDrafts[activeZoneKey]?.placement) {
    decalPose = null;
    const poseOK = updatePoseFromPlacementUV();
    if (poseOK) scheduleDecalRebuild();
  }

  // tab highlight
  setActiveTabUI?.(activeZoneKey);

  console.log('[activeZone]', key, 'zoneMesh=', zoneMesh?.name, 'locked=', isLocked());
}


btnZoneFront?.addEventListener('click', () => setActiveZone('front'));
btnZoneBack?.addEventListener('click', () => setActiveZone('back'));
btnZoneLeftArm?.addEventListener('click', () => setActiveZone('left_arm'));
btnZoneRightArm?.addEventListener('click', () => setActiveZone('right_arm'));

// --------------------
// Overlay resize handles
// --------------------
let resizingCorner = null;
let resizeStart = null;

function beginResize(corner, e) {
  if (isLocked()) return;
  if (!artworkCtrl.hasPlacement()) return;

  e.preventDefault();
  e.stopPropagation();
  resizingCorner = corner;

  const p = artworkCtrl.getPlacement();
  resizeStart = {
    x: e.clientX,
    y: e.clientY,
    uScale: p.uScale,
    vScale: p.vScale,
    ratio: p.vScale / Math.max(1e-6, p.uScale),
  };
  controls.enabled = false;
}

(function bindOverlayHandles() {
  const map = { hTL, hTR, hBL, hBR };
  Object.entries(map).forEach(([key, el]) => {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      const corner = key.replace('h', '').toLowerCase();
      beginResize(corner, e);
    });
  });

  window.addEventListener('pointermove', (e) => {
    if (!resizingCorner || !resizeStart) return;
    if (isLocked()) return;

    let dx = e.clientX - resizeStart.x;
    let dy = e.clientY - resizeStart.y;

    if (resizingCorner === 'tl' || resizingCorner === 'bl') dx = -dx;
    if (resizingCorner === 'bl' || resizingCorner === 'br') dy = -dy;

    const k = 0.0015;
    let sx = Math.min(5, Math.max(0.2, 1 + dx * k));
    let sy = Math.min(5, Math.max(0.2, 1 + dy * k));

    const p = artworkCtrl.getPlacement();
    if (!p) return;

    if (e.shiftKey) {
      const r = resizeStart.ratio || (resizeStart.vScale / Math.max(1e-6, resizeStart.uScale));
      sy = sx * r;
    }
    if (e.altKey) {
      const uni = (sx + sy) * 0.5;
      sx = sy = uni;
    }

    p.uScale = Math.min(1.2, Math.max(0.05, resizeStart.uScale * sx));
    p.vScale = Math.min(1.2, Math.max(0.05, resizeStart.vScale * sy));

    artworkCtrl.setPlacement(p);
    updatePoseFromPlacementUV();
    scheduleDecalRebuild();
    redraw2D();
  });

  window.addEventListener('pointerup', () => {
    if (!resizingCorner) return;
    resizingCorner = null;
    resizeStart = null;
    controls.enabled = true;
  });
})();

// --------------------
// UV template loader
// --------------------
function loadTemplateImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// --------------------
// 2D wheel scale
// --------------------
artViewport?.addEventListener('wheel', (e) => {
  if (isLocked()) return;
  if (!artworkCtrl.hasPlacement()) return;
  e.preventDefault();
  e.stopPropagation();

  const factor = e.deltaY > 0 ? 0.95 : 1.05;
  artworkCtrl.scaleBy(factor);
  clampPlacementNow();
  redraw2D();
  scheduleDecalRebuild();
}, { passive: false });

// Apply width in cm
btnApplyCm?.addEventListener('click', () => {
  if (isLocked()) return;
  if (!artworkCtrl.hasPlacement()) return;
  const widthCm = parseFloat(inpWidthCm?.value || '0');
  if (!widthCm || widthCm <= 0) return;
  editor?.applyWidthCm?.(widthCm);
  redraw2D();
  scheduleDecalRebuild();
});

// --------------------
// Editor init (once)
// --------------------
async function initEditorOnce() {
  if (editor) return editor;

  let uvTemplateImg = null;
  try {
    uvTemplateImg = await loadTemplateImage('/assets/uv/tshirt_uv.png');
  } catch (e) {
    console.warn('UV template not loaded:', e);
  }

  editor = setupUVEditor({
    artCanvas,
    artViewport,
    overlayBox,
    handles: { hTL, hTR, hBL, hBR },
    hud,
    camera,
    canvas3D: canvas,

    printZoneCM,
    getPose: () => decalPose,
    getDecalSize: () => ({ w: decalW, h: decalH }),
    setDecalSize: (w, h) => { decalW = w; decalH = h; },

    artworkCtrl,
    readSnapUI,

    onApplyDecalFromPose: () => {
      updatePoseFromPlacementUV();
      scheduleDecalRebuild();
      redraw2D();
    },

    template: uvTemplateImg ? { img: uvTemplateImg } : null,
    zones,
    getActiveZoneKey: () => activeZoneKey,
  });

  return editor;
}

// --------------------
// Load GLB (build zones)
// --------------------
const loader = new GLTFLoader();

loader.load(
  '/assets/models/TShirt.glb',
  async (gltf) => {
    tshirtRoot = gltf.scene;
    scene.add(tshirtRoot);

    _modelBox = new THREE.Box3().setFromObject(tshirtRoot);
    _modelSize = _modelBox.getSize(new THREE.Vector3());
    _modelCenter = _modelBox.getCenter(new THREE.Vector3());
    tshirtRoot.position.sub(_modelCenter);

    fitCameraToModel(1.35);

    zones = {};
    tshirtRoot.traverse(o => {
      if (!o.isMesh) return;
      if (o.name === 'PRINT_ZONE_FRONT') zones.front = buildPrintZoneFromMesh(o, 'front');
      if (o.name === 'PRINT_ZONE_BACK') zones.back = buildPrintZoneFromMesh(o, 'back');
      if (o.name === 'PRINT_ZONE_LEFT_ARM') zones.left_arm = buildPrintZoneFromMesh(o, 'left_arm');
      if (o.name === 'PRINT_ZONE_RIGHT_ARM') zones.right_arm = buildPrintZoneFromMesh(o, 'right_arm');
    });

    console.log('[zones]', zones);

    await initEditorOnce();
    setActiveZone(activeZoneKey || 'front');

    hud.textContent =
      'Loaded.\n1) Upload image\n2) Click on active zone in 3D to place\nDrag=move, Wheel=scale, R=rotate';
  },
  undefined,
  (err) => {
    console.error('GLB load error:', err);
    hud.textContent = 'Failed to load GLB. Check console.';
  }
);

// --------------------
// 3D place / drag
// --------------------
canvas.addEventListener('pointerdown', (e) => {
  if (!printZone) return;
  if (isLocked()) return;
  if (resizingCorner) return;

  const hit = hitTest(e, camera, zoneMesh, canvas);
  if (!hit) return;

  if (!isUVInsidePrintZone(hit.uv, printZone)) {
    hud.textContent = 'Outside active print zone. Place inside the zone.';
    return;
  }

  if (!artworkCtrl.hasImage()) {
    hud.textContent = 'Upload an image first.';
    return;
  }

  isDragging = true;
  controls.enabled = false;

  artworkCtrl.placeAtUV(hit.uv, printZone);
  clampPlacementNow();
  renderHUD(hit.uv);

  const pose = buildPoseFromHit(hit);
  if (!pose) return;
  pose.object = zoneMesh;
  decalPose = pose;

  const zs = ensureZoneDecal(activeZoneKey);
  zs.pose = pose;

  scheduleDecalRebuild();
  redraw2D();
});

canvas.addEventListener('pointermove', (e) => {
  if (isLocked() || !isDragging || resizingCorner) return;

  const hit = hitTest(e, camera, zoneMesh, canvas);
  if (!hit) return;
  if (!isUVInsidePrintZone(hit.uv, printZone)) return;

  artworkCtrl.placeAtUV(hit.uv, printZone);
  clampPlacementNow();
  renderHUD(hit.uv);

  const pose = buildPoseFromHit(hit);
  if (!pose) return;
  pose.object = zoneMesh;
  decalPose = pose;

  const zs = ensureZoneDecal(activeZoneKey);
  zs.pose = pose;

  scheduleDecalRebuild();
  redraw2D();
});

window.addEventListener('pointerup', () => {
  isDragging = false;
  controls.enabled = true;
});

// 3D wheel scale (Alt/Shift only)
viewer3d.addEventListener('wheel', (e) => {
  const scaleIntent = e.altKey || e.shiftKey;
  if (!scaleIntent) return;
  if (isLocked()) return;
  if (!artworkCtrl.hasPlacement()) return;

  e.preventDefault();
  e.stopPropagation();

  const factor = e.deltaY > 0 ? 0.95 : 1.05;
  artworkCtrl.scaleBy(factor);
  scheduleDecalRebuild();
  redraw2D();
}, { passive: false });

// Rotate (R)
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') {
    if (isLocked()) return;
    artworkCtrl.rotateByDeg(5);
    scheduleDecalRebuild();
    redraw2D();
  }
});

// --------------------
// Center + fit on upload
// --------------------
function centerAndFitOnUpload(img, margin = 0.92) {
  let p = artworkCtrl.getPlacement() || { u: 0.5, v: 0.5, uScale: 0.3, vScale: 0.3, rotationRad: 0 };

  p.u = 0.5;
  p.v = 0.5;
  p.rotationRad = 0;

  const ratio = img.height / Math.max(1e-6, img.width);
  const sMaxByWidth = margin;
  const sMaxByHeight = margin / ratio;
  const best = Math.min(sMaxByWidth, sMaxByHeight);

  p.uScale = Math.min(1.2, Math.max(0.05, best));
  p.vScale = Math.min(1.2, Math.max(0.05, best * ratio));

  artworkCtrl.setPlacement(p);
  clampPlacementNow();

  updatePoseFromPlacementUV();
  scheduleDecalRebuild();
  redraw2D();
}
 

// --------------------
// Upload image
// --------------------
fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // хэрвээ энэ zone locked байвал upload хийхэд автоматаар EDIT болгоно
  if (isLocked()) {
    setLockedStateForZone(activeZoneKey, false);
    clearZoneDecal(activeZoneKey);
  }

  const img = await loadImageFromFile(file);
  artworkCtrl.setImage(img);

  // active zone-ийн material дээр texture тавина
  const zs = ensureZoneDecal(activeZoneKey);
  setArtworkTextureFromImage(img, zs.material, renderer, { flipU: true });

  // ✅ энд placement үүснэ (center & fit хийнэ)
  centerAndFitOnUpload(img, 0.92);

  // ✅ placement бүрэн болсон хойно draft-д хадгал
  zoneDrafts[activeZoneKey].image = img;
  zoneDrafts[activeZoneKey].placement = artworkCtrl.getPlacement()
    ? { ...artworkCtrl.getPlacement() }
    : null;
  zoneDrafts[activeZoneKey].locked = false;

  // ✅ энэ upload-оор тухайн zone заавал EDIT байна
  setLockedStateForZone(activeZoneKey, false);

  // same file дахин сонгох боломж
  if (fileInput) fileInput.value = '';

  // width cm UI
  const p = artworkCtrl.getPlacement();
  if (p && inpWidthCm && printZoneCM?.width) {
    inpWidthCm.value = (printZoneCM.width * p.uScale).toFixed(1);
  }

  hud.textContent = 'Image ready. Click/drag on active 3D zone to place.';
  redraw2D();
});


// --------------------
// Export (ALL zones + 3D preview screenshot)
// --------------------
btnExport?.addEventListener('click', async () => {
  if (!zones || Object.keys(zones).length === 0) {
    alert('Zones not ready.');
    return;
  }

  // ✅ collect jobs from all zones that have saved decal (OR currently editing)
  const jobs = [];
  const keys = ['front', 'back', 'left_arm', 'right_arm'];

  for (const k of keys) {
    const zs = ensureZoneDecal(k);

    // priority: saved snapshot (submit хийсэн)
    const img = zs.image;
    const plc = zs.placement;
    const zrect = zones[k];
    const zcm = zs.printZoneCM || (ZONE_CM?.[productKey]?.[k]);

    if (img && plc && zrect && zcm) {
      jobs.push({
        key: k,
        artworkImage: img,
        placement: plc,
        printZone: zrect,
        printZoneCM: zcm,
        product: { id: productKey, side: k },
      });
    }
  }

  // хэрвээ submit хийгээгүй ч active zone дээр одоо зурагтай байвал export-д оруулна
  if (artworkCtrl.hasImage() && artworkCtrl.hasPlacement() && zones?.[activeZoneKey]) {
    const already = jobs.some(j => j.key === activeZoneKey);
    if (!already) {
      jobs.push({
        key: activeZoneKey,
        artworkImage: artworkCtrl.getImage(),
        placement: { ...artworkCtrl.getPlacement() },
        printZone: zones[activeZoneKey],
        printZoneCM: printZoneCM,
        product: { id: productKey, side: activeZoneKey },
      });
    }
  }

  if (jobs.length === 0) {
    alert('No saved artworks to export. Use Submit(Lock) on a zone (or have active placement).');
    return;
  }

  // 1) flat print PNG + JSON (each zone)
  const results = await bakeManyPNGsAndJSON({
    jobs,
    dpi: DEFAULT_DPI,
    templatePx: DEFAULT_TEMPLATE_PX,
  });

  for (const r of results) {
    downloadDataURL(r.pngDataURL, `print-${productKey}-${r.key}.png`);
    downloadText(JSON.stringify(r.json, null, 2), `print-${productKey}-${r.key}.json`);
  }

  // 2) 3D preview screenshot (all decals visible)
  renderer.render(scene, camera);
  const previewURL = renderer.domElement.toDataURL('image/png');
  downloadDataURL(previewURL, `preview-3d-${productKey}.png`);

  alert(`Exported ${results.length} zone(s) + 3D preview screenshot.`);
});

// --------------------
// Animate
// --------------------
function animate() {
  requestAnimationFrame(animate);
  updateControls();
  renderer.render(scene, camera);
  editor?.updateOverlayBox?.();
}
animate();
