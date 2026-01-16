
// src/main.js
console.log('[BOOT] main.js loaded', import.meta.url);

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

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

const { scene, camera } = getContext();

const { renderer, canvas } = createRenderer(viewer3d, { alpha: false });
function handleResize() {
  resizeRendererToElement(renderer, viewer3d);
  const rect = viewer3d.getBoundingClientRect();
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
}
handleResize();
window.addEventListener('resize', handleResize);

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
    console.log('[onUpdate]', evt?.type, artworkCtrl.getPlacement());
    if (!zoneMesh || !printZone) return;
    if (!evt || evt.type === 'placement' || evt.type === 'transform') {
      const ok = updatePoseFromPlacementUV();  // 2D -> UV -> world pose
      console.log('  updatePoseFromPlacementUV =', ok);
      if (ok) scheduleDecalRebuild();
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
  const w = p.uScale * WORLD_ZONE_W;
  const ratio = img.height / Math.max(1e-6, img.width);
  const h = w * ratio;
  decalW = Math.min(1.5, Math.max(0.05, w));
  decalH = Math.min(1.5, Math.max(0.05, h));
}


// 2D placement (0..1) -> absolute UV -> world pose шинэчлэх
function updatePoseFromPlacementUV() {
  if (!printZone) { console.log('[sync] no printZone'); return false; }

  // Target: эхэнд zoneMesh-ийг л ашиглая (decalPose.object null байх үе олон)
  const target = (zoneMesh?.isMesh ? zoneMesh : null) || (decalPose?.object?.isMesh ? decalPose.object : null);
  if (!target) { console.warn('[sync] no target mesh with UV'); return false; }

  const p = artworkCtrl.getPlacement?.();
  if (!p) { console.log('[sync] no placement'); return false; }

  // 2D (0..1) -> absolute UV
  let u = printZone.uMin + p.u * (printZone.uMax - printZone.uMin);
  let v = printZone.vMin + p.v * (printZone.vMax - printZone.vMin);

  const EPS = 1e-4;
  u = Math.min(1 - EPS, Math.max(EPS, u));
  v = Math.min(1 - EPS, Math.max(EPS, v));
  const uv = new THREE.Vector2(u, v);

  // 🧩 ШУУД 2 СУВГААР ТУРШЪЯ
  let hit = null;
  hit = pickOnMeshByUV(target, uv, { uvAttr: 'uv' });
  console.log('[sync] try uv : target=', target?.name, 'uv=', uv.toArray(), 'hit=', !!hit);
  if (!hit) {
    hit = pickOnMeshByUV(target, uv, { uvAttr: 'uv2' });
    console.log('[sync] try uv2: target=', target?.name, 'uv=', uv.toArray(), 'hit=', !!hit);
  }
  if (!hit) return false;

  const pose = buildPoseFromHit(hit);
  if (!pose) return false;

  decalPose = pose;
  return true;
}



// main.js дээр нэг удаа:
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

    // ⬇️ давхардсан setPlacement-ийг нэг болголоо
    artworkCtrl.setPlacement(p);

    // 2D->3D sync
    if (updatePoseFromPlacementUV()) scheduleDecalRebuild();
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
    const ok = updatePoseFromPlacementUV(); // 2D -> UV -> world pose
    if (ok) scheduleDecalRebuild();        // throttle-тааар decal-г дахин байгуулах
  },
});

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

    // Fit camera to model
    const box = new THREE.Box3().setFromObject(tshirtRoot);
    const center = box.getCenter(new THREE.Vector3());
    tshirtRoot.position.sub(center);

    const newBox = new THREE.Box3().setFromObject(tshirtRoot);
    const newSize = newBox.getSize(new THREE.Vector3());
    const maxDim = Math.max(newSize.x, newSize.y, newSize.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    let cameraZ = (maxDim / 2) / Math.tan(fov / 2);
    cameraZ *= 1.6;

    camera.position.set(0, maxDim * 0.6, cameraZ);
    camera.near = Math.max(0.01, cameraZ / 100);
    camera.far = cameraZ * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);

    // --- find zone ---
    let foundZone = null;
    tshirtRoot.traverse(o => { if (o.name === 'PRINT_ZONE_FRONT') foundZone = o; });
    zoneMesh = foundZone;

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

  // base pose
  const pose = buildPoseFromHit(hit);
  if (!pose) return;
  decalPose = pose;

  syncDecalWHFromPlacement();
  scheduleDecalRebuild(); // applyDecalFromPose();
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

  scheduleDecalRebuild(); // applyDecalFromPose();
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
// Камераас PRINT_ZONE_FRONT руу raycast хийж "hit" гаргана.
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
  scheduleDecalRebuild(); // applyDecalFromPose();

  btnSubmit && (btnSubmit.disabled = false);
  renderHUD(hit.uv);

  if (editor?.drawEditor) editor.drawEditor();
  if (editor?.updateOverlayBox) editor.updateOverlayBox();

  return true;
}

// Wheel: resize artwork (edit mode)
canvas.addEventListener('wheel', (e) => {
  if (isLocked) return;
  if (!artworkCtrl.hasPlacement()) return;

  e.preventDefault();
  e.stopPropagation();

  const delta = Math.sign(e.deltaY);
  const factor = delta > 0 ? 0.95 : 1.05;

  artworkCtrl.scaleBy(factor);
  // Pose өөрчлөгдөхгүй, зөвхөн хэмжээ — decal-г дахин байгуулахад л хангалттай
  scheduleDecalRebuild(); // applyDecalFromPose();
}, { passive: false });

// Rotate
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') {
    if (isLocked) return;
    artworkCtrl.rotateByDeg(5);
    // Pose хэвээр, зөвхөн эргэлт — decal-г дахин байгуулах
    scheduleDecalRebuild(); // applyDecalFromPose();
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

  // 🧩 NEW: анхны pose-ийг UV дээрээс авах / эсвэл авто-place хийх
  let gotPose = updatePoseFromPlacementUV();       // 2D placement -> UV -> world pose
  if (gotPose) {
    scheduleDecalRebuild();                        // applyDecalFromPose();
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

