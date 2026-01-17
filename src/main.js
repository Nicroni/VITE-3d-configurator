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

import { bakeTemplatePNGAndJSON } from './print/exportPNG.js';
import { loadImageFromFile } from './utils/image.js';
import { downloadDataURL, downloadText } from './utils/download.js';

import { ZONE_CM } from './config/printZones.js';
import { DEFAULT_DPI, DEFAULT_TEMPLATE_PX, DECAL_DEPTH, WORLD_ZONE_W } from './config/constants.js';
import { getSafeRectRel, isPlacementInsideSafe, clampPlacementToSafe } from './editor/safeZone.js';

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

if ('outputColorSpace' in renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
} else {
  // eslint-disable-next-line
  renderer.outputEncoding = THREE.sRGBEncoding;
}
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

let tshirtRoot = null;

let zones = {};              // { front:{uMin..}, back:{..} ... }
let activeZoneKey = 'front';
let zoneMesh = null;         // active zone mesh
let printZone = null;        // active zone rect in UV

let printZoneCM = (ZONE_CM?.[productKey]?.[activeZoneKey]) || { width: 30, height: 40 };

// decal sizing base (world units)
let WORLD_ZONE_W_DYNAMIC = WORLD_ZONE_W;

// decal state
let decalMesh = null;
let decalPose = null;

let isLocked = false;
let isDragging = false;

let decalW = 0.25;
let decalH = 0.25;

// editor instance
let editor = null;

// throttle for decal rebuild
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
    // editor байхгүй үед redraw хийхгүй
    redraw2D();

    const poseOK = updatePoseFromPlacementUV();
    if (artworkCtrl.hasImage() && (decalPose || poseOK)) scheduleDecalRebuild();
  }
});

// --------------------
// Helpers
// --------------------
function clampPlacementNow() {
  const p = artworkCtrl.getPlacement?.();
  if (!p) return false;

  const key = activeZoneKey || 'front';
  const safe = getSafeRectRel(key, printZoneCM);

  // хэмжээс их байвал safe-ээс том байх тохиолдолд “зөөлөн” багасгаж багтаая
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

// placement (top->down) -> absolute UV (bottom->up)
function relToAbsUV(pu, pv, rect) {
  const u = rect.uMin + pu * (rect.uMax - rect.uMin);
  const v = rect.vMax - pv * (rect.vMax - rect.vMin);

  const EPS = 1e-4;
  const uC = Math.min(1 - EPS, Math.max(EPS, u));
  const vC = Math.min(1 - EPS, Math.max(EPS, v));
  return new THREE.Vector2(uC, vC);
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
  if (!zoneMesh || !zoneMesh.isMesh) return false;   // ✅ ALWAYS use active zone mesh

  const p = artworkCtrl.getPlacement?.();
  if (!p) return false;

  const prefUV = relToAbsUV(p.u, p.v, printZone);

  // ✅ UV pick ONLY on zoneMesh
  let hit = pickOnMeshByUV(zoneMesh, prefUV, { uvAttr: 'uv' });
  if (!hit) hit = pickOnMeshByUV(zoneMesh, prefUV, { uvAttr: 'uv2' });
  if (!hit) hit = findHitWithFallback(zoneMesh, prefUV);
  if (!hit) return false;

  const pose = buildPoseFromHit(hit);
  if (!pose) return false;

  // ✅ CRITICAL: lock pose object to current zoneMesh
  pose.object = zoneMesh;

  decalPose = pose;
  return true;
}


function applyDecalFromPose() {
  if (!decalPose || !artworkCtrl.hasImage() || !hasArtworkTexture()) return;

  syncDecalWHFromPlacement();
  const rotationRad = (artworkCtrl.getPlacement()?.rotationRad) || 0;

  const mesh = buildDecalMesh(
    decalPose,
    { width: decalW, height: decalH, depth: DECAL_DEPTH },
    rotationRad,
    decalMat
  );

  disposeDecalMesh(decalMesh, scene);
  decalMesh = mesh;
  scene.add(decalMesh);
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
Mode: ${isLocked ? 'LOCKED' : 'EDIT'} (Shift=snap off | Shift=ratio-lock on resize | Alt=uniform)`;
}

// --------------------
// Lock / Edit
// --------------------
function setLockedState(lock) {
  isLocked = lock;
  setControlMode(isLocked ? 'LOCKED' : 'EDIT');

  if (isLocked) {
    isDragging = false;
    btnSubmit && (btnSubmit.disabled = true);
    btnEdit && (btnEdit.disabled = false);
    hud.textContent += '\n🔒 Locked. Click Edit to modify again.';
  } else {
    btnSubmit && (btnSubmit.disabled = false);
    btnEdit && (btnEdit.disabled = true);
    hud.textContent += '\n✏️ Edit mode.';
  }
}

btnSubmit?.addEventListener('click', () => {
  if (!artworkCtrl.hasPlacement() || !decalMesh) {
    alert('Place artwork first.');
    return;
  }
  setLockedState(true);
});

btnEdit?.addEventListener('click', () => {
  if (!decalMesh) return;
  setLockedState(false);
});

// --------------------
// Zone selector
// --------------------
function setActiveZone(key) {
  if (!zones?.[key]) {
    console.warn('[setActiveZone] missing zone rect:', key);
    return;
  }
  activeZoneKey = key;

  // print cm size update (маш чухал)
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

  if (zoneLabel && printZoneCM) {
    zoneLabel.textContent = `Print Zone: ${printZoneCM.width} × ${printZoneCM.height} cm (${key})`;
  }

  // editor refresh
  if (editor?.setPrintZoneCM) editor.setPrintZoneCM(printZoneCM);
  redraw2D();

  console.log('[activeZone]', key, 'zoneMesh=', zoneMesh?.name);
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
  if (isLocked) return;
  if (!artworkCtrl.hasPlacement() || !decalPose) return;

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
      const corner = key.replace('h', '').toLowerCase(); // tl/tr/bl/br
      beginResize(corner, e);
    });
  });

  window.addEventListener('pointermove', (e) => {
    if (!resizingCorner || !resizeStart) return;

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
  if (isLocked) return;
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
  if (isLocked) return;
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
  if (isLocked) return;
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
  decalPose = pose;

  scheduleDecalRebuild();
  redraw2D();
  btnSubmit && (btnSubmit.disabled = false);
});

canvas.addEventListener('pointermove', (e) => {
  if (isLocked || !isDragging || resizingCorner) return;

  const hit = hitTest(e, camera, zoneMesh, canvas);
  if (!hit) return;
  if (!isUVInsidePrintZone(hit.uv, printZone)) return;

  artworkCtrl.placeAtUV(hit.uv, printZone);
  clampPlacementNow(); 
  renderHUD(hit.uv);

  const pose = buildPoseFromHit(hit);
  if (!pose) return;
  decalPose = pose;

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
  if (isLocked) return;
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
    if (isLocked) return;
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
  clampPlacementNow();
  // pose update (if possible)
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

  const img = await loadImageFromFile(file);
  artworkCtrl.setImage(img);

  // ✅ mirror fix: flipU true (if your mesh UV causes horizontal mirror)
  setArtworkTextureFromImage(img, decalMat, renderer, { flipU: true });

  centerAndFitOnUpload(img, 0.92);

  const p = artworkCtrl.getPlacement();
  if (p && inpWidthCm && printZoneCM?.width) {
    inpWidthCm.value = (printZoneCM.width * p.uScale).toFixed(1);
  }

  setLockedState(false);
  btnEdit && (btnEdit.disabled = true);

  hud.textContent = decalPose
    ? 'Image centered on 2D and posed on 3D (UV pick).'
    : 'Image centered on 2D. Click on the active 3D zone to place.';
});

// --------------------
// Export
// --------------------
btnExport?.addEventListener('click', async () => {
  if (!printZone) return alert('No print zone yet.');
  if (!artworkCtrl.hasPlacement()) return alert('Place artwork first.');

  const placement = artworkCtrl.getPlacement();
  const product = { id: productKey, side: activeZoneKey };

  const result = await bakeTemplatePNGAndJSON({
    artworkImage: artworkCtrl.getImage(),
    placement,
    printZone,
    printZoneCM,
    dpi: DEFAULT_DPI,
    templatePx: DEFAULT_TEMPLATE_PX,
    product
  });

  downloadDataURL(result.pngDataURL, 'print-template.png');
  downloadText(JSON.stringify(result.json, null, 2), 'print-job.json');
  alert('Exported: print-template.png + print-job.json');
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
