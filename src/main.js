
// src/main.js
//console.log('[BOOT] main.js loaded', import.meta.url);

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

import { createDecalMaterial, setArtworkTextureFromImage, hasArtworkTexture } from './decal/decalMaterial.js';
import { buildPoseFromHit } from './decal/decalPose.js';
import { buildDecalMesh, disposeDecalMesh } from './decal/decalBuilder.js';

import { bakeTemplatePNGAndJSON } from './print/exportPNG.js';

import { loadImageFromFile } from './utils/image.js';
import { downloadDataURL, downloadText } from './utils/download.js';

import { ZONE_CM } from './config/printZones.js';
import { pickOnMeshByUV } from './zones/uvPick.js';
import { DEFAULT_DPI, DEFAULT_TEMPLATE_PX, DECAL_DEPTH, WORLD_ZONE_W } from './config/constants.js';

// --------------------
// DOM
// --------------------
const hud = document.getElementById('hud');
const btnExport = document.getElementById('btnExport');
const fileInput = document.getElementById('file');
const btnSubmit = document.getElementById('btnSubmit');
const btnEdit = document.getElementById('btnEdit');
const overlayBox = document.getElementById('overlayBox');

const chkSnapCenter = document.getElementById('chkSnapCenter');
const chkSnapGrid = document.getElementById('chkSnapGrid');
const gridCmInput = document.getElementById('gridCm');
const inpWidthCm = document.getElementById('inpWidthCm');
const btnApplyCm = document.getElementById('btnApplyCm');

const viewer3d = document.getElementById('viewer3d');
if (!viewer3d) throw new Error('#viewer3d not found');

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


let _modelBox = null;     // Box3 cache
let _modelSize = null;    // Vector3 cache
let _modelCenter = null;  // Vector3 cache

function fitCameraToModel(framing = 1.35) {
  if (!_modelBox || !_modelSize) return;

  // Хэрвээ чи tshirtRoot.position.sub(_modelCenter) хийсэн бол
  // model-ийн төв нь (0,0,0) болсон гэсэн үг.
  const center = new THREE.Vector3(0, 0, 0);

  const maxDim = Math.max(_modelSize.x, _modelSize.y, _modelSize.z);

  // Fit distance (vertical + horizontal)
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fitHeightDistance = (maxDim / 2) / Math.tan(fov / 2);
  const fitWidthDistance = fitHeightDistance / Math.max(1e-6, camera.aspect);

  const dist = framing * Math.max(fitHeightDistance, fitWidthDistance);

  // Камерыг model-ийн яг төв рүү харуулна
  controls.target.copy(center);

  // Камерыг төвөөс арагш байрлуулна (z тэнхлэгээр)
  camera.position.set(center.x, center.y, center.z + dist);

  camera.near = Math.max(0.01, dist / 100);
  camera.far  = dist * 100;
  camera.updateProjectionMatrix();
  controls.update();
}


const { scene, camera } = getContext();

const { renderer, canvas } = createRenderer(viewer3d, { alpha: false });
function handleResize() {
  const rect = viewer3d.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  resizeRendererToElement(renderer, viewer3d);
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();

  // ✅ model бэлэн + хэмжээс OK үед л fit хийнэ
 if (_modelBox && _modelSize && _modelCenter) {
    fitCameraToModel(1.35);
  }

}

handleResize();
window.addEventListener('resize', handleResize);
// ✅ viewer3d-ийн хэмжээ layout-оос болж өөрчлөгдөх үед ч автоматаар resize хийх
const ro = new ResizeObserver(() => handleResize());
ro.observe(viewer3d);


// (optional) color space / pixel ratio
if ('outputColorSpace' in renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace; // r152+
} else {
  renderer.outputEncoding = THREE.sRGBEncoding;     // r151-
}
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

const controls = createControls(camera, canvas);
setControlMode('EDIT'); // EDIT үед wheel-ийг artwork scale-д ашиглана

// --------------------
// State
// --------------------
let tshirtRoot = null;
let zoneMesh = null;
let printZone = null;
let WORLD_ZONE_W_DYNAMIC = WORLD_ZONE_W; // fallback (constants.js-оос)


let decalMesh = null;
let decalPose = null; // { object, position, baseOrientation }

let isLocked = false;
let isDragging = false;

// decal size in world units
let decalW = 0.25;
let decalH = 0.25;

const productKey = 'tshirt';
const sideKey = 'front';
const printZoneCM = ZONE_CM[productKey][sideKey];
const dpi = DEFAULT_DPI;
const templatePx = DEFAULT_TEMPLATE_PX;

// --- throttle for decal rebuild (fps-д ээлтэй) ---
let decalBuildRaf = 0;
function scheduleDecalRebuild() {
  if (decalBuildRaf) return;
  decalBuildRaf = requestAnimationFrame(() => {
    decalBuildRaf = 0;
    applyDecalFromPose();
  });
}

// artwork/material
const artworkCtrl = createArtworkController({
  onUpdate: (evt) => {
    // ✅ Scale/rotate/position — ямар ч update дээр 3D-г синкдэнэ
    const poseOK = updatePoseFromPlacementUV(); // pose өөрчлөгдөөгүй байж болно (scale үед)
    if (artworkCtrl.hasImage() && (decalPose || poseOK)) {
      scheduleDecalRebuild(); // geometry-г дахин байгуулах (size/rotation өөрчлөгдөнө)
    }
  }
});
const { material: decalMat } = createDecalMaterial(renderer);

// --------------------
// Helpers
// --------------------
function syncDecalWHFromPlacement() {
  const p = artworkCtrl.getPlacement();
  const img = artworkCtrl.getImage();
  if (!p || !img) return;
 const w = p.uScale * WORLD_ZONE_W_DYNAMIC;   // ✅ энд л ашиглана
  const ratio = img.height / Math.max(1e-6, img.width);
  const h = w * ratio;
  decalW = Math.min(1.5, Math.max(0.05, w));
  decalH = Math.min(1.5, Math.max(0.05, h));
}

// Canvas(top->down) харьцангуй (p.u, p.v) -> absolute UV(bottom->up)
function relToAbsUV(pu, pv, rect) {
  const u = rect.uMin + pu * (rect.uMax - rect.uMin);
  // 🔁 FLIP V: Canvas(top→down) -> UV(bottom→up)
  const v = rect.vMax - pv * (rect.vMax - rect.vMin);
  const EPS = 1e-4;
  const uC = Math.min(1 - EPS, Math.max(EPS, u));
  const vC = Math.min(1 - EPS, Math.max(EPS, v));
  return new THREE.Vector2(uC, vC);
}

// Ойролцоох жижиг grid fallback (хоосон UV цэгийн үед)
function findHitWithFallback(targetMesh, prefUV, rect) {
  // 0) Шууд prefUV дээр
  let hit = pickOnMeshByUV(targetMesh, prefUV, { uvAttr: 'uv' });
  if (!hit) hit = pickOnMeshByUV(targetMesh, prefUV, { uvAttr: 'uv2' });
  if (hit) return hit;

  // 1) Жижиг grid (5x5), төвөөс гадагш
  const STEPS = [0, 1, -1, 2, -2];
  const STEP = 0.04; // printZone доторх харьцангуй алхам

  // prefUV -> relative (0..1)
  const uRel0 = (prefUV.x - printZone.uMin) / (printZone.uMax - printZone.uMin);
  const vRel0 = (prefUV.y - printZone.vMin) / (printZone.vMax - printZone.vMin);

  for (const dy of STEPS) {
    for (const dx of STEPS) {
      if (dx === 0 && dy === 0) continue;
      const pu = Math.min(1, Math.max(0, uRel0 + dx * STEP));
      const pv = Math.min(1, Math.max(0, vRel0 + dy * STEP));
      const uv = relToAbsUV(pu, pv, rect);

      let h = pickOnMeshByUV(targetMesh, uv, { uvAttr: 'uv' });
      if (!h) h = pickOnMeshByUV(targetMesh, uv, { uvAttr: 'uv2' });
      if (h) return h;
    }
  }
  return null;
}

// 2D placement (0..1) -> absolute UV -> world pose шинэчлэх
function updatePoseFromPlacementUV() {
  if (!printZone) { return false; }

  // Target: эхлээд zoneMesh, дараа нь decalPose.object
  const target = (zoneMesh?.isMesh ? zoneMesh : null) || (decalPose?.object?.isMesh ? decalPose.object : null);
  if (!target) { return false; }

  const p = artworkCtrl.getPlacement?.();
  if (!p) { return false; }

  const prefUV = relToAbsUV(p.u, p.v, printZone);

  // 1) uv -> 2) uv2 -> 3) grid fallback
  let hit = pickOnMeshByUV(target, prefUV, { uvAttr: 'uv' });
  if (!hit) hit = pickOnMeshByUV(target, prefUV, { uvAttr: 'uv2' });
  if (!hit) hit = findHitWithFallback(target, prefUV, printZone);

  if (!hit) return false;

  const pose = buildPoseFromHit(hit);
  if (!pose) return false;

  decalPose = pose;
  return true;
}

// DevTools хурдан тест
window.__testUVPick = () => {
  if (!zoneMesh || !printZone) return console.warn('no zoneMesh/printZone');
  const u = 0.5 * (printZone.uMin + printZone.uMax);
  const v = 0.5 * (printZone.vMin + printZone.vMax);
  const hit = pickOnMeshByUV(zoneMesh, new THREE.Vector2(u, v));
  console.log('uv=', u.toFixed(3), v.toFixed(3), 'hit=', !!hit, hit);
};

function readSnapUI() {
  return {
    enableCenter: !!chkSnapCenter?.checked,
    enableGrid: !!chkSnapGrid?.checked,
    gridCm: Math.max(0.1, parseFloat(gridCmInput?.value || '1')),
  };
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
// Decal helpers
// --------------------
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

// overlay resize handles (Shift: ratio lock, Alt: uniform)
let resizingCorner = null;
let resizeStart = null; // { x,y, uScale,vScale, ratio }
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

function bindOverlayHandles() {
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

    if (e.shiftKey) { // ratio lock
      const r = resizeStart.ratio || (resizeStart.vScale / Math.max(1e-6, resizeStart.uScale));
      sy = sx * r;
    }
    if (e.altKey) { // uniform
      const uni = (sx + sy) * 0.5;
      sx = sy = uni;
    }

    p.uScale = Math.min(1.2, Math.max(0.05, resizeStart.uScale * sx));
    p.vScale = Math.min(1.2, Math.max(0.05, resizeStart.vScale * sy));

    // setPlacement нэг удаа
    artworkCtrl.setPlacement(p);

    // Scale-д pose өөрчлөгдөхгүй ч decal-г заавал дахин байгуулна
    updatePoseFromPlacementUV();
    scheduleDecalRebuild();
  });

  window.addEventListener('pointerup', () => {
    if (!resizingCorner) return;
    resizingCorner = null;
    resizeStart = null;
    controls.enabled = true;
  });
}
bindOverlayHandles();

// --------------------
// 2D Canvas Editor
// --------------------
const artCanvas = document.getElementById('artCanvas');
const artViewport = document.getElementById('artViewport');

const editor = setupUVEditor({
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

  // 2D canvas дээрх placement шинэчлэгдсэн үед:
  onApplyDecalFromPose: () => {
    updatePoseFromPlacementUV(); // pose байхгүй бол чимээгүй буцаана
    scheduleDecalRebuild();      // decal-г заавал дахин байгуулах
  },
});

// (ШИНЭ) 2D талын wheel-ийг scale-д ашиглах (хүсвэл)
artViewport?.addEventListener('wheel', (e) => {
  if (isLocked) return;
  if (!artworkCtrl.hasPlacement()) return;
  e.preventDefault();
  e.stopPropagation();
  const factor = e.deltaY > 0 ? 0.95 : 1.05;
  artworkCtrl.scaleBy(factor);
  scheduleDecalRebuild();
}, { passive: false });

btnApplyCm?.addEventListener('click', () => {
  if (isLocked) return;
  if (!artworkCtrl.hasPlacement()) return;
  const widthCm = parseFloat(inpWidthCm?.value || '0');
  if (!widthCm || widthCm <= 0) return;
  editor.applyWidthCm(widthCm);
});

// --------------------
// Lock / Edit buttons
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
// Load GLB
// --------------------
const loader = new GLTFLoader();
loader.load(
  '/assets/models/TShirt.glb',
  (gltf) => {
    tshirtRoot = gltf.scene;
    scene.add(tshirtRoot);
    // Fit camera to model (cache + fit)
_modelBox = new THREE.Box3().setFromObject(tshirtRoot);
_modelSize = _modelBox.getSize(new THREE.Vector3());
_modelCenter = _modelBox.getCenter(new THREE.Vector3());

tshirtRoot.position.sub(_modelCenter);

// aspect аль хэдийн handleResize дээр шинэчлэгддэг тул
//fitCameraToModel(1.6);
fitCameraToModel(1.35);
handleResize(); // ✅ aspect + size update + if(_modelBox) fit


    

    // --- find zone ---
    let foundZone = null;
    tshirtRoot.traverse(o => { if (o.name === 'PRINT_ZONE_FRONT') foundZone = o; });
    zoneMesh = foundZone;
    // after zoneMesh found
if (zoneMesh && zoneMesh.isObject3D) {
  const zoneBox = new THREE.Box3().setFromObject(zoneMesh);
  const zoneSize = zoneBox.getSize(new THREE.Vector3());
  WORLD_ZONE_W_DYNAMIC = Math.max(1e-6, zoneSize.x);
  console.log('[zone] WORLD_ZONE_W_DYNAMIC =', WORLD_ZONE_W_DYNAMIC.toFixed(4));
} else {
  console.warn('[zone] PRINT_ZONE_FRONT not found → using fallback WORLD_ZONE_W');
}


    // 🔎 Debug: бүх хүүхэд mesh-үүд, UV байгаа эсэх
    console.group('[zone] scan');
    tshirtRoot.traverse(o => {
      if (o.isMesh) {
        const hasUV = !!o.geometry?.attributes?.uv;
        const verts = o.geometry?.attributes?.position?.count ?? 0;
        console.log('  mesh:', o.name, 'hasUV=', hasUV, 'verts=', verts);
      }
    });
    console.groupEnd();

    // 🔎 Debug: сонгосон zone mesh
    console.log('[zone] selected:', zoneMesh?.name, 'hasUV=', !!zoneMesh?.geometry?.attributes?.uv);

    if (zoneMesh) {
      printZone = buildPrintZoneFromMesh(zoneMesh);
    } else {
      // fallback UV-рект (zoneMesh олдоогүй тохиолдолд)
      printZone = { uMin: 0.25, uMax: 0.75, vMin: 0.20, vMax: 0.85, name: 'fallback', side: 'front' };
      console.warn('[zone] PRINT_ZONE_FRONT not found – using fallback rect', printZone);
    }

    // 🔎 Debug: printZone UV-рект
    console.log(
      '[zone] rect u[', printZone.uMin.toFixed(3), '..', printZone.uMax.toFixed(3),
      '] v[', printZone.vMin.toFixed(3), '..', printZone.vMax.toFixed(3), ']'
    );

    setLockedState(false);
    btnEdit && (btnEdit.disabled = true);
    btnSubmit && (btnSubmit.disabled = true);

    hud.textContent =
      `Loaded.\n` +
      `PrintZoneUV: u[${printZone.uMin.toFixed(3)}..${printZone.uMax.toFixed(3)}], v[${printZone.vMin.toFixed(3)}..${printZone.vMax.toFixed(3)}]\n` +
      `1) Upload image\n2) Click on PRINT_ZONE_FRONT to place\nDrag=move, Wheel=scale, R=rotate\n` +
      `Snap: Center/Grid (Shift=off)\n` +
      `Resize: drag corners (Shift=ratio lock, Alt=uniform)\n` +
      `Overlay rotates with artwork`;
  },
  undefined,
  (err) => {
    console.error('GLB load error:', err);
    hud.textContent = 'Failed to load GLB. Check console.';
  }
);

console.log('zoneMesh=', zoneMesh?.name);
zoneMesh?.traverse(o => {
  if (o.isMesh) {
    console.log('child mesh:', o.name, 'hasUV=', !!o.geometry?.attributes?.uv);
  }
});

// --------------------
// Input: place / drag on 3D
// --------------------
canvas.addEventListener('pointerdown', (e) => {
  if (!printZone) return;
  if (isLocked) return;
  if (resizingCorner) return;

  const hit = hitTest(e, camera, zoneMesh, canvas);
  if (!hit) return;

  if (!isUVInsidePrintZone(hit.uv, printZone)) {
    hud.textContent = 'Outside PRINT_ZONE_FRONT. Place inside the print zone.';
    return;
  }

  if (!artworkCtrl.hasImage()) {
    hud.textContent = 'Upload an image first (right panel).';
    return;
  }

  isDragging = true;
  controls.enabled = false;

  artworkCtrl.placeAtUV(hit.uv, printZone);
  renderHUD(hit.uv);

  const pose = buildPoseFromHit(hit);
  if (!pose) return;
  decalPose = pose;

  syncDecalWHFromPlacement();
  scheduleDecalRebuild();
  btnSubmit && (btnSubmit.disabled = false);
});

canvas.addEventListener('pointermove', (e) => {
  if (isLocked || !isDragging || resizingCorner) return;
  const hit = hitTest(e, camera, zoneMesh, canvas);
  if (!hit) return;
  if (!isUVInsidePrintZone(hit.uv, printZone)) return;

  artworkCtrl.placeAtUV(hit.uv, printZone);
  renderHUD(hit.uv);

  const pose = buildPoseFromHit(hit);
  if (!pose) return;
  decalPose = pose;

  scheduleDecalRebuild();
});

window.addEventListener('pointerup', () => {
  isDragging = false;
  controls.enabled = true;
});

// === center + fit contain (2D) ============================================
function centerAndFitOnUpload(img, margin = 0.92) {
  let p = artworkCtrl.getPlacement() || { u: 0.5, v: 0.5, uScale: 0.3, vScale: 0.3, rotationRad: 0 };

  // 1) Төвд аваачна
  p.u = 0.5;
  p.v = 0.5;
  p.rotationRad = 0;

  // 2) Aspect хадгалсан "fit contain"
  const ratio = img.height / Math.max(1e-6, img.width);
  const sMaxByWidth  = margin;
  const sMaxByHeight = margin / ratio;
  const best = Math.min(sMaxByWidth, sMaxByHeight);

  p.uScale = Math.min(1.2, Math.max(0.05, best));
  p.vScale = Math.min(1.2, Math.max(0.05, best * ratio));

  artworkCtrl.setPlacement(p);

  // Upload дараа анхны pose-ийг UV pick-р авч, decal-г throttle-тойгоор байгуулах
  if (updatePoseFromPlacementUV()) scheduleDecalRebuild();

  // 2D дахин зурах
  if (editor && typeof editor.drawEditor === 'function') {
    editor.drawEditor();
  }
}

// === AUTO PLACE on 3D (after upload) ======================================
function autoPlaceOnZoneCenter() {
  if (!zoneMesh || !printZone) return false;
  if (!artworkCtrl.hasImage()) return false;

  // Zone world center
  const box = new THREE.Box3().setFromObject(zoneMesh);
  const zoneCenterW = box.getCenter(new THREE.Vector3());

  // Ray from camera -> zone center
  const origin = camera.position.clone();
  const dir = zoneCenterW.clone().sub(origin).normalize();

  const raycaster = new THREE.Raycaster();
  raycaster.set(origin, dir);

  const hits = raycaster.intersectObject(zoneMesh, true);
  if (!hits.length) return false;

  const hit = hits[0];
  if (!hit.uv) return false;

  artworkCtrl.placeAtUV(hit.uv, printZone);

  const pose = buildPoseFromHit(hit);
  if (!pose) return false;
  decalPose = pose;

  syncDecalWHFromPlacement();
  scheduleDecalRebuild();

  btnSubmit && (btnSubmit.disabled = false);
  renderHUD(hit.uv);

  if (editor?.drawEditor) editor.drawEditor();
  if (editor?.updateOverlayBox) editor.updateOverlayBox();

  return true;
}

// Wheel: resize artwork (edit mode) — 3D canvas талд
viewer3d.addEventListener('wheel', (e) => {
  // ✅ Page scroll хэвээр үлдээнэ. Зөвхөн Alt (эсвэл Shift)-тай үед л scale.
  const scaleIntent = e.altKey || e.shiftKey;
  if (!scaleIntent) return;

  if (isLocked) return;
  if (!artworkCtrl.hasPlacement()) return;

  e.preventDefault();
  e.stopPropagation();

  const factor = e.deltaY > 0 ? 0.95 : 1.05;
  artworkCtrl.scaleBy(factor);
  scheduleDecalRebuild();
}, { passive: false });


// Rotate
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') {
    if (isLocked) return;
    artworkCtrl.rotateByDeg(5);
    scheduleDecalRebuild();
  }
});

// Upload image
fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const img = await loadImageFromFile(file);
  artworkCtrl.setImage(img);
  setArtworkTextureFromImage(img, decalMat, renderer);

  // 2D: төвд багтааж байрлуулах
  centerAndFitOnUpload(img, 0.92);

  // 3D: UV pick -> pose тогтоох, бүтэлгүйдвэл auto place
  const gotPose = updatePoseFromPlacementUV(); // 2D placement -> UV -> world pose
  if (gotPose) {
    scheduleDecalRebuild();
    hud.textContent = 'Image centered on 2D and posed on 3D (UV pick).';
  } else {
    const placed = autoPlaceOnZoneCenter();
    if (!placed) {
      hud.textContent = 'Image centered on 2D. Click on PRINT_ZONE_FRONT to place it on 3D.';
      btnSubmit && (btnSubmit.disabled = true);
    } else {
      hud.textContent = 'Image placed on 2D and auto-placed on 3D.';
    }
  }

  // (optional) Width(cm) утгыг автоматаар бөглөх
  const p = artworkCtrl.getPlacement();
  if (p && inpWidthCm && printZoneCM?.width) {
    inpWidthCm.value = (printZoneCM.width * p.uScale).toFixed(1);
  }

  setLockedState(false);
  btnEdit && (btnEdit.disabled = true);
});

// Export
btnExport?.addEventListener('click', async () => {
  if (!printZone) return alert('No print zone yet.');
  if (!artworkCtrl.hasPlacement()) return alert('Place artwork first (click on T-shirt).');

  const placement = artworkCtrl.getPlacement();
  const product = { id: productKey, side: sideKey };

  const result = await bakeTemplatePNGAndJSON({
    artworkImage: artworkCtrl.getImage(),
    placement,
    printZone,
    printZoneCM,
    dpi,
    templatePx,
    product
  });

  downloadDataURL(result.pngDataURL, 'print-template.png');
  downloadText(JSON.stringify(result.json, null, 2), 'print-job.json');
  alert('Exported: print-template.png + print-job.json');
});

// Animate
function animate() {
  requestAnimationFrame(animate);
  updateControls();
  renderer.render(scene, camera);
  if (editor?.updateOverlayBox) editor.updateOverlayBox();
}
animate();
