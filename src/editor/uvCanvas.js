// src/editor/uvCanvas.js
import * as THREE from 'three';
import { cmToPlacementWidth, applySnap } from './placement.js';
import { clamp } from './clamp.js';
import { worldToScreen } from './transforms.js';
import { getSafeRectRel, isPlacementInsideSafe, clampPlacementToSafe } from './safeZone.js';

export function setupUVEditor(opts) {
  const {
    artCanvas, artViewport, overlayBox, handles, hud,
    camera, canvas3D, printZoneCM, getPose, getDecalSize, setDecalSize,
    artworkCtrl, readSnapUI, onApplyDecalFromPose,
    template,            // ✅ { img: HTMLImageElement }
    zones,               // ✅ { front:{uMin..}, back:{..}, left_arm:{..}, right_arm:{..} }
    getActiveZoneKey,    // ✅ () => 'front' | 'back' | 'left_arm' | 'right_arm'
  } = opts;

  const ctx = artCanvas?.getContext('2d');

  // --- template draw transform (contain) ---
  let tplX = 0, tplY = 0, tplW = 0, tplH = 0;

function resizeCanvasDPR() {
  if (!artCanvas || !artViewport) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const pad = 32; // чи өмнө нь -32 хэрэглэж байсан
  const availW = Math.max(300, artViewport.clientWidth - pad);
  const availH = Math.max(300, artViewport.clientHeight - pad);

  const tpl = template?.img;
  const aspect = tpl ? (tpl.height / Math.max(1e-6, tpl.width)) : 1;

  // ✅ width + height хоёрын аль алинд нь багтаана
  let cssW = availW;
  let cssH = Math.round(cssW * aspect);

  if (cssH > availH) {
    cssH = availH;
    cssW = Math.round(cssH / aspect);
  }

  artCanvas.style.width = `${cssW}px`;
  artCanvas.style.height = `${cssH}px`;

  artCanvas.width = Math.round(cssW * dpr);
  artCanvas.height = Math.round(cssH * dpr);
}


  function drawTemplateContain() {
    const tpl = template?.img;
    if (!tpl || !ctx) return;

    const cw = artCanvas.width, ch = artCanvas.height;
    const s = Math.min(cw / tpl.width, ch / tpl.height);

    tplW = tpl.width * s;
    tplH = tpl.height * s;
    tplX = (cw - tplW) * 0.5;
    tplY = (ch - tplH) * 0.5;

    ctx.drawImage(tpl, tplX, tplY, tplW, tplH);
  }

  // ✅ UV(0..1) -> canvas px (template-ийн contain transform ашиглана)
  function uvToCanvasPx(u, v) {
    const x = tplX + u * tplW;
    const y = tplY + (1 - v) * tplH; // v up -> canvas down
    return { x, y };
  }

  // ✅ A) canvas px -> abs UV (template contain transform ашиглана)
  function canvasPxToAbsUV(x, y) {
    const u0 = (x - tplX) / Math.max(1e-6, tplW);
    const v0 = 1 - ((y - tplY) / Math.max(1e-6, tplH)); // v up
    return {
      u: clamp(u0, 0, 1),
      v: clamp(v0, 0, 1),
    };
  }

  function drawBackdrop() {
    if (!ctx) return;

    ctx.save();
    ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, artCanvas.width, artCanvas.height);

    drawTemplateContain();

    // zones rectangles
    if (zones && tplW > 0 && tplH > 0) {
      Object.entries(zones).forEach(([key, z]) => {
        if (!z) return;

        const active = (getActiveZoneKey?.() === key);

        const p0 = uvToCanvasPx(z.uMin, z.vMax);
        const p1 = uvToCanvasPx(z.uMax, z.vMin);
        const x = p0.x;
        const y = p0.y;
        const w = p1.x - p0.x;
        const h = p1.y - p0.y;

        ctx.save();
        ctx.globalAlpha = active ? 0.22 : 0.10;
        ctx.fillStyle = active ? 'rgba(0,140,255,1)' : 'rgba(0,0,0,1)';
        ctx.fillRect(x, y, w, h);

        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = active ? 'rgba(0,90,200,1)' : 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.font = `${14 * (window.devicePixelRatio || 1)}px ui-monospace,monospace`;
        ctx.fillText(key.toUpperCase(), x + 8, y + 18);
        ctx.restore();
      });
    }

    ctx.restore();
  }

  function drawSafeOverlay() {
    if (!ctx) return;

    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];
    if (!z || tplW <= 0 || tplH <= 0) return;

    const safe = getSafeRectRel(key, printZoneCM);

    const zoneX = tplX + z.uMin * tplW;
    const zoneY = tplY + (1 - z.vMax) * tplH;
    const zoneW = (z.uMax - z.uMin) * tplW;
    const zoneH = (z.vMax - z.vMin) * tplH;

    const safeX = zoneX + safe.uMin * zoneW;
    const safeY = zoneY + safe.vMin * zoneH;
    const safeW = (safe.uMax - safe.uMin) * zoneW;
    const safeH = (safe.vMax - safe.vMin) * zoneH;

    ctx.save();

    ctx.globalAlpha = 0.10;
    ctx.fillStyle = 'black';
    ctx.fillRect(zoneX, zoneY, zoneW, safeY - zoneY);
    ctx.fillRect(zoneX, safeY + safeH, zoneW, (zoneY + zoneH) - (safeY + safeH));
    ctx.fillRect(zoneX, safeY, safeX - zoneX, safeH);
    ctx.fillRect(safeX + safeW, safeY, (zoneX + zoneW) - (safeX + safeW), safeH);

    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,170,90,1)';
    ctx.strokeRect(safeX, safeY, safeW, safeH);

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(0,170,90,1)';
    ctx.font = `${12 * (window.devicePixelRatio || 1)}px ui-monospace,monospace`;
    ctx.fillText('SAFE AREA', safeX + 8, safeY + 16);

    ctx.restore();
  }

  // placement (zone-local 0..1) -> canvas px
  function placementToCanvas(p) {
    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];

    if (!z) {
      const c = uvToCanvasPx(p.u, p.v);
      const dw = p.uScale * tplW;
      const dh = p.vScale * tplW;
      return { cx: c.x, cy: c.y, dw, dh };
    }

    // zone local -> abs uv
    const uAbs = z.uMin + p.u * (z.uMax - z.uMin);
    const vAbs = z.vMin + p.v * (z.vMax - z.vMin); // UV up
    const c = uvToCanvasPx(uAbs, vAbs);

    const zoneWpx = (z.uMax - z.uMin) * tplW;
    const dw = p.uScale * zoneWpx;
    const dh = p.vScale * zoneWpx;

    return { cx: c.x, cy: c.y, dw, dh };
  }

  function drawEditor() {
    if (!ctx) return;

    resizeCanvasDPR();
    drawBackdrop();

    // safe overlay (artwork-аас доор)
    drawSafeOverlay();

    const p = artworkCtrl.getPlacement?.();
    const img = artworkCtrl.getImage?.();
    if (!p || !img) return;

    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];

    const { cx, cy, dw, dh } = placementToCanvas(p);

    // zone rect (template space) for clip + warning
    let zoneX = 0, zoneY = 0, zoneW = artCanvas.width, zoneH = artCanvas.height;
    if (z && tplW > 0 && tplH > 0) {
      zoneX = tplX + z.uMin * tplW;
      zoneY = tplY + (1 - z.vMax) * tplH;
      zoneW = (z.uMax - z.uMin) * tplW;
      zoneH = (z.vMax - z.vMin) * tplH;
    }

    // CLIP: artwork zone-оос гадуур харагдахгүй
    ctx.save();
    ctx.beginPath();
    ctx.rect(zoneX, zoneY, zoneW, zoneH);
    ctx.clip();

    ctx.translate(cx, cy);
    ctx.rotate(p.rotationRad || 0);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);

    ctx.strokeStyle = 'rgba(17,24,39,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);

    ctx.restore();

    // WARNING if outside safe
    const safe = getSafeRectRel(key, printZoneCM);
    const ok = isPlacementInsideSafe(p, safe);

    if (!ok) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = 'rgba(255,0,0,1)';
      ctx.fillRect(zoneX, zoneY, zoneW, zoneH);
      ctx.restore();

      if (hud && !hud.textContent.includes('Outside SAFE')) {
        hud.textContent += `\n⚠ Outside SAFE AREA`;
      }
    }
  }

  function bindEditorEvents() {
    let dragging2D = false;

    function getCanvasXY(e) {
      const r = artCanvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (artCanvas.width / r.width);
      const y = (e.clientY - r.top) * (artCanvas.height / r.height);
      return { x, y };
    }

    // ✅ A) canvas px -> placement (0..1) (active zone-оор)  (template contain ашиглана)
    function canvasToPlacement(x, y) {
      const key = getActiveZoneKey?.() || 'front';
      const z = zones?.[key];

      // canvas px -> abs UV
      const { u: uAbs, v: vAbs } = canvasPxToAbsUV(x, y);

      if (!z) return { u: uAbs, v: vAbs };

      // abs UV -> zone-relative (0..1)
      const uRel = (uAbs - z.uMin) / Math.max(1e-6, (z.uMax - z.uMin));
      //const vRel = (z.vMax - vAbs) / Math.max(1e-6, (z.vMax - z.vMin)); // ✅ зөв flip
      const vRel = (vAbs - z.vMin) / Math.max(1e-6, (z.vMax - z.vMin));
      return {
        u: clamp(uRel, 0, 1),
        v: clamp(vRel, 0, 1),
      };
    }

    function isPointInsideArtwork(x, y) {
      const p = artworkCtrl.getPlacement?.();
      if (!p) return false;
      const box = placementToCanvas(p); // {cx,cy,dw,dh}
      const left = box.cx - box.dw / 2;
      const top = box.cy - box.dh / 2;
      return (x >= left && x <= left + box.dw && y >= top && y <= top + box.dh);
    }

    // ✅ B) placement-ийг zone дотроос гаргахгүй clamp
    function clampPlacementInsideZone(p) {
      const halfW = p.uScale * 0.5;
      const halfH = p.vScale * 0.5;

      p.u = clamp(p.u, 0 + halfW, 1 - halfW);
      p.v = clamp(p.v, 0 + halfH, 1 - halfH);
      return p;
    }

    // 2D drag MOVE
    artCanvas.addEventListener('pointerdown', (e) => {
      // NOTE: isLocked энд scope-д байхгүй байж магадгүй.
      // main.js дээр lock хийж байгаа бол opts-оор isLocked getter дамжуулах нь хамгийн зөв.
      if (!artworkCtrl.hasPlacement?.()) return;

      const { x, y } = getCanvasXY(e);
      if (!isPointInsideArtwork(x, y)) return;

      e.preventDefault();
      artCanvas.setPointerCapture?.(e.pointerId);
      dragging2D = true;
    });

    artCanvas.addEventListener('pointermove', (e) => {
      if (!dragging2D) return;

      const { x, y } = getCanvasXY(e);
      const rel = canvasToPlacement(x, y);

      const p = artworkCtrl.getPlacement();
      if (!p) return;

      p.u = rel.u;
      p.v = rel.v;

      // ✅ zone дотроо барина (wrap бүр мөсөн зогсоно)
      clampPlacementInsideZone(p);

      // ✅ optional: safe area дотроо барих
      // const key = getActiveZoneKey?.() || 'front';
      // const safe = getSafeRectRel(key, printZoneCM);
      // clampPlacementToSafe(p, safe);

      artworkCtrl.setPlacement(p);

      // 3D sync
      onApplyDecalFromPose?.();

      // 2D redraw
      drawEditor();
    });

    window.addEventListener('pointerup', () => {
      dragging2D = false;
    });
  }

  resizeCanvasDPR();
  window.addEventListener('resize', () => { resizeCanvasDPR(); drawEditor(); });

  bindEditorEvents();
  drawEditor();

  return {
    drawEditor,
    updateOverlayBox: () => {}, // (чи өмнөх updateOverlayBox-оо энд оруулж болно)
    applyWidthCm(widthCm) {
      const p = artworkCtrl.getPlacement();
      const img = artworkCtrl.getImage();
      if (!p || !img) return;

      p.uScale = cmToPlacementWidth(widthCm, printZoneCM);
      const ratio = img.height / Math.max(1e-6, img.width);
      p.vScale = clamp(p.uScale * ratio, 0.05, 1.2);

      artworkCtrl.setPlacement(p);
      onApplyDecalFromPose?.();
      drawEditor();
    },
  };
}
