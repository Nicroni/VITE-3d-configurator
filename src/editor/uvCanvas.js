
// src/editor/uvCanvas.js
import * as THREE from 'three';
import { cmToPlacementWidth, applySnap } from './placement.js';
import { clamp } from './clamp.js';
import { worldToScreen } from './transforms.js';

/**
 * 2D Canvas Editor + 3D Overlay (Photoshop-like)
 * @param {{
 *   artCanvas: HTMLCanvasElement,
 *   artViewport: HTMLElement,
 *   overlayBox: HTMLElement,
 *   handles: { hTL:HTMLElement, hTR:HTMLElement, hBL:HTMLElement, hBR:HTMLElement },
 *   hud: HTMLElement,
 *   camera: THREE.Camera,
 *   canvas3D: HTMLCanvasElement,
 *   printZoneCM: {width:number,height:number},
 *   getPose: () => { position:THREE.Vector3, baseOrientation:THREE.Euler } | null,
 *   getDecalSize: () => { w:number, h:number },
 *   setDecalSize: (w:number, h:number) => void,
 *   artworkCtrl: { getPlacement:Function, setPlacement:Function, hasPlacement:Function, getImage:Function, hasImage:Function, rotateByDeg:Function },
 *   readSnapUI: () => { enableCenter:boolean, enableGrid:boolean, gridCm:number },
 *   onApplyDecalFromPose: () => void,
 * }} opts
 */
export function setupUVEditor(opts) {
  const {
    artCanvas, artViewport, overlayBox, handles, hud,
    camera, canvas3D, printZoneCM, getPose, getDecalSize, setDecalSize,
    artworkCtrl, readSnapUI, onApplyDecalFromPose
  } = opts;

  const ctx = artCanvas?.getContext('2d');

  // Canvas харьцаа = PRINT_ZONE_FRONT (H/W)
  const zoneAspect = (printZoneCM?.height || 40) / Math.max(1e-6, (printZoneCM?.width || 30));

  // 2D editor state
  let edScale = 1;
  let edPan = { x: 0, y: 0 };
  let edDragging = false;
  let edPanning = false;
  let spaceHeld = false;

  // DPI‑aware canvas resize (viewport өргөнд тааруулан, aspect=zoneAspect)
  function resizeCanvasDPR() {
    if (!artCanvas || !artViewport) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(300, artViewport.clientWidth - 32);
    const cssH = Math.round(cssW * zoneAspect);

    artCanvas.style.width  = `${cssW}px`;
    artCanvas.style.height = `${cssH}px`;

    artCanvas.width  = Math.round(cssW * dpr);
    artCanvas.height = Math.round(cssH * dpr);
  }

  // Background + guides + zone label
  function drawBackdrop() {
    if (!ctx) return;
    ctx.save();

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, artCanvas.width, artCanvas.height);

    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
    ctx.strokeRect(0, 0, artCanvas.width, artCanvas.height);

    // Center guides
    ctx.globalAlpha = .35;
    ctx.beginPath();
    ctx.moveTo(artCanvas.width / 2, 0);
    ctx.lineTo(artCanvas.width / 2, artCanvas.height);
    ctx.moveTo(0, artCanvas.height / 2);
    ctx.lineTo(artCanvas.width, artCanvas.height / 2);
    ctx.stroke();

    // Label
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.font = `${12 * (window.devicePixelRatio || 1)}px ui-monospace,monospace`;
    const label = `PRINT ZONE: ${printZoneCM?.width || '?'}×${printZoneCM?.height || '?'} cm`;
    ctx.fillText(label, 8 * (window.devicePixelRatio || 1), 18 * (window.devicePixelRatio || 1));

    ctx.restore();
  }

  function placementToCanvas(p) {
    const cw = artCanvas.width, ch = artCanvas.height;
    const cx = p.u * cw, cy = (1 - p.v) * ch;
    const dw = p.uScale * cw, dh = p.vScale * ch;
    return { cx, cy, dw, dh };
  }

  function drawEditor() {
    if (!ctx || !artCanvas) return;
    ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
    drawBackdrop();

    const p = artworkCtrl.getPlacement?.();
    const img = artworkCtrl.getImage?.();
    if (!p || !img) return;

    const { cx, cy, dw, dh } = placementToCanvas(p);

    ctx.save();
    ctx.translate(edPan.x * (window.devicePixelRatio || 1), edPan.y * (window.devicePixelRatio || 1));
    ctx.scale(edScale, edScale);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.rotationRad || 0);

    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);

    // selection border
    ctx.strokeStyle = 'rgba(17,24,39,0.9)';
    ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
    ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);

    ctx.restore();
    ctx.restore();
  }

  function clientToLocal(e) {
    const rect = artCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // === Overlay Box (3D талын HTML control) — 3D canvas‑ын офсеттай ===
  function updateOverlayBox() {
    if (!overlayBox) return;

    const pose = getPose();
    const p = artworkCtrl.getPlacement?.();
    if (!p || !pose) {
      overlayBox.style.display = 'none';
      return;
    }

    const center = worldToScreen(pose.position, camera, canvas3D);
    const rect3d = canvas3D.getBoundingClientRect(); // офсет

    // orientation (base + user rotation)
    const final = pose.baseOrientation.clone();
    final.z += (p.rotationRad || 0);
    const q = new THREE.Quaternion().setFromEuler(final);

    const { w, h } = getDecalSize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();

    const halfRightW = pose.position.clone().add(right.multiplyScalar(w * 0.5));
    const halfUpW    = pose.position.clone().add(up.multiplyScalar(h * 0.5));

    const rightPx = worldToScreen(halfRightW, camera, canvas3D);
    const upPx    = worldToScreen(halfUpW,    camera, canvas3D);

    const halfW = Math.hypot(rightPx.x - center.x, rightPx.y - center.y);
    const halfH = Math.hypot(upPx.x    - center.x, upPx.y    - center.y);

    const pxW = Math.max(60, halfW * 2);
    const pxH = Math.max(60, halfH * 2);

    overlayBox.style.display = 'block';
    overlayBox.style.left = `${rect3d.left + center.x - pxW / 2}px`;
    overlayBox.style.top  = `${rect3d.top  + center.y - pxH / 2}px`;
    overlayBox.style.width  = `${pxW}px`;
    overlayBox.style.height = `${pxH}px`;
    overlayBox.style.transformOrigin = '50% 50%';
    overlayBox.style.transform = `rotate(${p.rotationRad || 0}rad)`;

    // handle sizes
    const handlePx = clamp(Math.min(pxW, pxH) * 0.10, 10, 22);
    const { hTL, hTR, hBL, hBR } = handles || {};
    if (hTL && hTR && hBL && hBR) {
      [hTL, hTR, hBL, hBR].forEach(hh => {
        hh.style.width = `${handlePx}px`;
        hh.style.height = `${handlePx}px`;
        hh.style.borderRadius = `${Math.round(handlePx * 0.45)}px`;
      });
      const off = Math.round(handlePx * 0.55);
      hTL.style.left = `${-off}px`;  hTL.style.top = `${-off}px`;
      hTR.style.right = `${-off}px`; hTR.style.top = `${-off}px`;
      hBL.style.left = `${-off}px`;  hBL.style.bottom = `${-off}px`;
      hBR.style.right = `${-off}px`; hBR.style.bottom = `${-off}px`;
    }
  }

  // === Editor events ===
 // === Editor events ===
function bindEditorEvents() {
  // --- 2D drag state (✅ нэг газар shared state) ---
  let isDragging2D = false;
  let grabOffsetU = 0;
  let grabOffsetV = 0;

  function getUVFromEvent(e) {
    // event -> canvas local (CSS px)
    const loc = clientToLocal(e);

    // pan/zoom-г тайлж "canvas coordinate" (px) болгож хөрвүүлэх
    const inv = 1 / edScale;
    const x = (loc.x - edPan.x) * inv;
    const y = (loc.y - edPan.y) * inv;

    // canvas px -> normalized u,v
    let u = x / artCanvas.width;
    let v = 1 - (y / artCanvas.height);

    // clamp
    u = Math.min(1, Math.max(0, u));
    v = Math.min(1, Math.max(0, v));
    return { u, v };
  }

  function applySnapAndSet(p, e) {
    const sn = readSnapUI();
    const snapped = applySnap(p, {
      enableCenterSnap: sn.enableCenter,
      enableGridSnap: sn.enableGrid,
      gridCm: sn.gridCm,
      printZoneCM,
      shiftToDisable: true,
      shiftKey: e.shiftKey,
    });
    artworkCtrl.setPlacement(snapped);
  }

  function placeFromClient(e) {
    const { u, v } = getUVFromEvent(e);

    const p =
      artworkCtrl.getPlacement() ||
      { u: 0.5, v: 0.5, uScale: 0.3, vScale: 0.3, rotationRad: 0 };

    p.u = u;
    p.v = v;

    applySnapAndSet(p, e);
    onApplyDecalFromPose();
    drawEditor();
  }

  function stopDrag(e) {
    isDragging2D = false;
    edDragging = false;
    edPanning = false;

    if (e?.pointerId != null) {
      try { artCanvas.releasePointerCapture(e.pointerId); } catch {}
    }
  }

  // -----------------------
  // pointerdown
  // -----------------------
  artCanvas?.addEventListener('pointerdown', (e) => {
    if (!artworkCtrl.hasImage()) return;

    // ✅ pointerup алдагдахаас хамгаална
    artCanvas.setPointerCapture(e.pointerId);

    // pan mode (space / middle / right)
    if (spaceHeld || e.button === 1 || e.button === 2) {
      edPanning = true;
      e.preventDefault();
      return;
    }

    // ---- LEFT CLICK ----
    // 1) хэрэв placement байхгүй бол: нэг удаа байрлуулна
    if (!artworkCtrl.hasPlacement()) {
      edDragging = true;
      placeFromClient(e); // click placement
      // drag эхлүүлэхгүй (байрлуулж дуусаад зогсоно)
      stopDrag(e);
      return;
    }

    // 2) placement байгаа бол: "drag to move"
    const { u, v } = getUVFromEvent(e);
    const p = artworkCtrl.getPlacement();

    // ✅ mouse дарсан цэг төвөөс хэдэн u/v зөрүүтэйг хадгална
    grabOffsetU = u - p.u;
    grabOffsetV = v - p.v;

    isDragging2D = true;
    edDragging = true;

    e.preventDefault();
  });

  // -----------------------
  // pointermove
  // -----------------------
  window.addEventListener('pointermove', (e) => {
    // ✅ товч суллагдсан мөртлөө move ирвэл drag-аа унтраана
    if (isDragging2D && e.buttons === 0) {
      stopDrag(e);
      return;
    }

    if (edPanning) {
      e.preventDefault();
      edPan.x += e.movementX;
      edPan.y += e.movementY;
      drawEditor();
      return;
    }

    if (!isDragging2D) return;

    const { u, v } = getUVFromEvent(e);
    const p = artworkCtrl.getPlacement();
    if (!p) return;

    p.u = u - grabOffsetU;
    p.v = v - grabOffsetV;

    // clamp
    p.u = Math.min(1, Math.max(0, p.u));
    p.v = Math.min(1, Math.max(0, p.v));

    applySnapAndSet(p, e);
    onApplyDecalFromPose();
    drawEditor();
  });

  // -----------------------
  // pointerup/cancel
  // -----------------------
  window.addEventListener('pointerup', (e) => stopDrag(e));
  window.addEventListener('pointercancel', (e) => stopDrag(e));
  window.addEventListener('blur', () => { isDragging2D = false; edDragging = false; edPanning = false; });

  // Wheel = zoom to cursor
  artCanvas?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = artCanvas.getBoundingClientRect();
    const loc = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const old = edScale;
    const k = (e.deltaY > 0) ? 0.9 : 1.1;
    edScale = Math.max(0.2, Math.min(5, edScale * k));

    const wx = (loc.x - edPan.x) / old;
    const wy = (loc.y - edPan.y) / old;
    edPan.x = loc.x - wx * edScale;
    edPan.y = loc.y - wy * edScale;

    drawEditor();
  }, { passive: false });

  // Keyboard: space = pan, E/R rotate
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') spaceHeld = true;
    if (artworkCtrl.hasPlacement()) {
      if (e.key.toLowerCase() === 'e') { artworkCtrl.rotateByDeg(-5); onApplyDecalFromPose(); drawEditor(); }
      if (e.key.toLowerCase() === 'r') { artworkCtrl.rotateByDeg( 5); onApplyDecalFromPose(); drawEditor(); }
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });

  // Initial + responsive
  resizeCanvasDPR();
  window.addEventListener('resize', () => { resizeCanvasDPR(); drawEditor(); });
}


  bindEditorEvents();

  return {
    drawEditor,
    updateOverlayBox,
    /** Width (cm) тохируулах + ratio хадгална */
    applyWidthCm(widthCm) {
      const p = artworkCtrl.getPlacement();
      const img = artworkCtrl.getImage();
      if (!p || !img) return;
      p.uScale = cmToPlacementWidth(widthCm, printZoneCM);
      const ratio = img.height / Math.max(1e-6, img.width);
      p.vScale = clamp(p.uScale * ratio, 0.05, 1.2);
      artworkCtrl.setPlacement(p);
      onApplyDecalFromPose();
      drawEditor();
    },
  };
}
