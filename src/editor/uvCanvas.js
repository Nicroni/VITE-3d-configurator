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
    template,            // { img: HTMLImageElement }
    zones,               // { front:{uMin..}, back:{..}, left_arm:{..}, right_arm:{..} }
    getActiveZoneKey,    // () => 'front' | 'back' | 'left_arm' | 'right_arm'
  } = opts;

  const ctx = artCanvas?.getContext('2d');
  if (!ctx) return null;

  // ----------------------------
  // Template contain transform
  // ----------------------------
  let tplX = 0, tplY = 0, tplW = 0, tplH = 0;

  // ----------------------------
  // VIEW TRANSFORM (zone-fit)
  // ----------------------------
  // "world" coordinate = template-drawn pixel coordinate system (tplX/tplY/tplW/tplH space).
  // We will optionally scale/translate that world into canvas view.
  let viewS = 1, viewOX = 0, viewOY = 0;
  let viewEnabled = false; // if true => ctx.setTransform(viewS,0,0,viewS,viewOX,viewOY) before drawing

  function setIdentityTransform() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function setViewTransform() {
    if (!viewEnabled) {
      setIdentityTransform();
      return;
    }
    ctx.setTransform(viewS, 0, 0, viewS, viewOX, viewOY);
  }

  // Template-drawn pixel -> Canvas pixel
  function worldToCanvasPx(x, y) {
    if (!viewEnabled) return { x, y };
    return { x: x * viewS + viewOX, y: y * viewS + viewOY };
  }

  // Canvas pixel -> Template-drawn pixel
  function canvasToWorldPx(x, y) {
    if (!viewEnabled) return { x, y };
    return { x: (x - viewOX) / Math.max(1e-6, viewS), y: (y - viewOY) / Math.max(1e-6, viewS) };
  }

  function resizeCanvasDPR() {
    if (!artCanvas || !artViewport) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const pad = 32;
    const availW = Math.max(300, artViewport.clientWidth - pad);
    const availH = Math.max(300, artViewport.clientHeight - pad);

    const tpl = template?.img;
    const aspect = tpl ? (tpl.height / Math.max(1e-6, tpl.width)) : 1;

    // fit into viewport
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

  function drawTemplateContainComputeOnly() {
    // compute tplX,tplY,tplW,tplH (do not draw here)
    const tpl = template?.img;
    if (!tpl) return;

    const cw = artCanvas.width, ch = artCanvas.height;
    const s = Math.min(cw / tpl.width, ch / tpl.height);

    tplW = tpl.width * s;
    tplH = tpl.height * s;
    tplX = (cw - tplW) * 0.5;
    tplY = (ch - tplH) * 0.5;
  }

  function drawTemplateAtWorld() {
    const tpl = template?.img;
    if (!tpl) return;
    // IMPORTANT: assume current ctx transform maps WORLD->CANVAS
    // draw in WORLD coords (tplX/tplY already WORLD coords)
    ctx.drawImage(tpl, tplX, tplY, tplW, tplH);
  }

  // ✅ UV(0..1) -> WORLD px (template-drawn pixels)
  function uvToWorldPx(u, v) {
    const x = tplX + u * tplW;
    const y = tplY + (1 - v) * tplH; // v up -> canvas down
    return { x, y };
  }

  // ✅ WORLD px -> abs UV
  function worldPxToAbsUV(x, y) {
    const u0 = (x - tplX) / Math.max(1e-6, tplW);
    const v0 = 1 - ((y - tplY) / Math.max(1e-6, tplH));
    return { u: clamp(u0, 0, 1), v: clamp(v0, 0, 1) };
  }

  // ✅ CANVAS px -> abs UV (considers zone-fit view)
  function canvasPxToAbsUV(xCanvas, yCanvas) {
    const { x, y } = canvasToWorldPx(xCanvas, yCanvas);
    return worldPxToAbsUV(x, y);
  }

  // ----------------------------
  // Zone-fit view transform
  // ----------------------------
  function computeZoneViewTransform(z, padPx = 24) {
    // 1) zone bounds in WORLD pixels
    const x0 = tplX + z.uMin * tplW;
    const x1 = tplX + z.uMax * tplW;

    const y0 = tplY + (1 - z.vMax) * tplH;
    const y1 = tplY + (1 - z.vMin) * tplH;

    const zw = Math.max(1, x1 - x0);
    const zh = Math.max(1, y1 - y0);

    // 2) fit that rect into canvas
    const cw = artCanvas.width;
    const ch = artCanvas.height;

    const sx = (cw - padPx * 2) / zw;
    const sy = (ch - padPx * 2) / zh;
    const s = Math.min(sx, sy);

    const drawW = zw * s;
    const drawH = zh * s;

    // translate so (x0,y0) aligns into padded centered view
    const ox = (cw - drawW) * 0.5 - x0 * s;
    const oy = (ch - drawH) * 0.5 - y0 * s;

    return { s, ox, oy, zoneWorld: { x0, y0, x1, y1 } };
  }

  function setViewTransformForActiveZone() {
    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];
    if (!z || tplW <= 0 || tplH <= 0) {
      viewEnabled = false;
      viewS = 1; viewOX = 0; viewOY = 0;
      return;
    }

    const vt = computeZoneViewTransform(z, 24);
    viewEnabled = true;
    viewS = vt.s;
    viewOX = vt.ox;
    viewOY = vt.oy;
  }

  // ----------------------------
  // Backdrop (template + zones)
  // ----------------------------
  function drawBackdrop() {
    ctx.save();
    setIdentityTransform();
    ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, artCanvas.width, artCanvas.height);
    ctx.restore();

    // Now draw everything with view transform
    ctx.save();
    setViewTransform();

    // template
    drawTemplateAtWorld();

    // zones rectangles (still useful as reference)
    if (zones && tplW > 0 && tplH > 0) {
      Object.entries(zones).forEach(([key, z]) => {
        if (!z) return;
        const active = (getActiveZoneKey?.() === key);

        const p0 = uvToWorldPx(z.uMin, z.vMax);
        const p1 = uvToWorldPx(z.uMax, z.vMin);

        const x = p0.x;
        const y = p0.y;
        const w = p1.x - p0.x;
        const h = p1.y - p0.y;

        ctx.save();
        ctx.globalAlpha = active ? 0.22 : 0.08;
        ctx.fillStyle = active ? 'rgba(0,140,255,1)' : 'rgba(0,0,0,1)';
        ctx.fillRect(x, y, w, h);

        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = active ? 'rgba(0,90,200,1)' : 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 2 / Math.max(1e-6, viewS); // keep thickness visually constant
        ctx.strokeRect(x, y, w, h);

        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.font = `${14 / Math.max(1e-6, viewS)}px ui-monospace,monospace`;
        ctx.fillText(key.toUpperCase(), x + 8 / Math.max(1e-6, viewS), y + 18 / Math.max(1e-6, viewS));
        ctx.restore();
      });
    }

    ctx.restore();
  }

  function drawSafeOverlay() {
    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];
    if (!z || tplW <= 0 || tplH <= 0) return;

    const safe = getSafeRectRel(key, printZoneCM);

    // zone in WORLD
    const zoneX = tplX + z.uMin * tplW;
    const zoneY = tplY + (1 - z.vMax) * tplH;
    const zoneW = (z.uMax - z.uMin) * tplW;
    const zoneH = (z.vMax - z.vMin) * tplH;

    const safeX = zoneX + safe.uMin * zoneW;
    const safeY = zoneY + safe.vMin * zoneH;
    const safeW = (safe.uMax - safe.uMin) * zoneW;
    const safeH = (safe.vMax - safe.vMin) * zoneH;

    ctx.save();
    setViewTransform();

    // outside safe tint inside zone
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = 'black';
    ctx.fillRect(zoneX, zoneY, zoneW, safeY - zoneY);
    ctx.fillRect(zoneX, safeY + safeH, zoneW, (zoneY + zoneH) - (safeY + safeH));
    ctx.fillRect(zoneX, safeY, safeX - zoneX, safeH);
    ctx.fillRect(safeX + safeW, safeY, (zoneX + zoneW) - (safeX + safeW), safeH);

    // safe border
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2 / Math.max(1e-6, viewS);
    ctx.strokeStyle = 'rgba(0,170,90,1)';
    ctx.strokeRect(safeX, safeY, safeW, safeH);

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(0,170,90,1)';
    ctx.font = `${12 / Math.max(1e-6, viewS)}px ui-monospace,monospace`;
    ctx.fillText('SAFE AREA', safeX + 8 / Math.max(1e-6, viewS), safeY + 16 / Math.max(1e-6, viewS));

    ctx.restore();
  }

  // ----------------------------
  // Placement -> WORLD px
  // ----------------------------
  function placementToWorld(p) {
    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];

    if (!z) {
      const c = uvToWorldPx(p.u, p.v);
      const dw = p.uScale * tplW;
      const dh = p.vScale * tplW;
      return { cx: c.x, cy: c.y, dw, dh, zoneWorld: { x: tplX, y: tplY, w: tplW, h: tplH } };
    }

    // zone local -> abs uv
    const uAbs = z.uMin + p.u * (z.uMax - z.uMin);
    // ✅ placement v нь TOP->DOWN учраас abs UV дээр V-г flip хийнэ
const vAbs = z.vMax - p.v * (z.vMax - z.vMin);
    const c = uvToWorldPx(uAbs, vAbs);

    const zoneWpx = (z.uMax - z.uMin) * tplW;
    const dw = p.uScale * zoneWpx;
    const dh = p.vScale * zoneWpx;

    const zoneX = tplX + z.uMin * tplW;
    const zoneY = tplY + (1 - z.vMax) * tplH;
    const zoneW = (z.uMax - z.uMin) * tplW;
    const zoneH = (z.vMax - z.vMin) * tplH;

    return { cx: c.x, cy: c.y, dw, dh, zoneWorld: { x: zoneX, y: zoneY, w: zoneW, h: zoneH } };
  }

  // ----------------------------
  // drawEditor
  // ----------------------------
  function drawEditor() {
    resizeCanvasDPR();

    // 1) compute template contain rect
    drawTemplateContainComputeOnly();

    // 2) compute zone-fit view (based on active zone)
    setViewTransformForActiveZone();

    // 3) draw
    drawBackdrop();
    drawSafeOverlay();

    const p = artworkCtrl.getPlacement?.();
    const img = artworkCtrl.getImage?.();
    if (!p || !img) return;

    const key = getActiveZoneKey?.() || 'front';
    const z = zones?.[key];

    const { cx, cy, dw, dh, zoneWorld } = placementToWorld(p);

    // CLIP: within active zone
    ctx.save();
    setViewTransform();

    ctx.beginPath();
    ctx.rect(zoneWorld.x, zoneWorld.y, zoneWorld.w, zoneWorld.h);
    ctx.clip();

    ctx.translate(cx, cy);
    ctx.rotate(p.rotationRad || 0);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);

    // artwork stroke
    ctx.strokeStyle = 'rgba(17,24,39,0.9)';
    ctx.lineWidth = 2 / Math.max(1e-6, viewS);
    ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);

    ctx.restore();

    // WARNING if outside safe
    const safe = getSafeRectRel(key, printZoneCM);
    const ok = isPlacementInsideSafe(p, safe);

    if (!ok) {
      ctx.save();
      setViewTransform();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = 'rgba(255,0,0,1)';
      ctx.fillRect(zoneWorld.x, zoneWorld.y, zoneWorld.w, zoneWorld.h);
      ctx.restore();

      if (hud && !hud.textContent.includes('Outside SAFE')) {
        hud.textContent += `\n⚠ Outside SAFE AREA`;
      }
    }
  }

  // ----------------------------
  // Events (drag)
  // ----------------------------
  function bindEditorEvents() {
    let dragging2D = false;

    function getCanvasXY(e) {
      const r = artCanvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (artCanvas.width / r.width);
      const y = (e.clientY - r.top)  * (artCanvas.height / r.height);
      return { x, y };
    }

    // canvas px -> placement (0..1)
    function canvasToPlacement(xCanvas, yCanvas) {
      const key = getActiveZoneKey?.() || 'front';
      const z = zones?.[key];

      const { u: uAbs, v: vAbs } = canvasPxToAbsUV(xCanvas, yCanvas);

      if (!z) return { u: uAbs, v: vAbs };

      const uRel = (uAbs - z.uMin) / Math.max(1e-6, (z.uMax - z.uMin));
      // ✅ зөв flip (canvas дээр дээш = vAbs ихэснэ, zone local v доош чиглэлтэй байхын тулд)
      const vRel = (z.vMax - vAbs) / Math.max(1e-6, (z.vMax - z.vMin));

      return {
        u: clamp(uRel, 0, 1),
        v: clamp(vRel, 0, 1),
      };
    }

    function clampPlacementInsideZone(p) {
      const halfW = p.uScale * 0.5;
      const halfH = p.vScale * 0.5;

      p.u = clamp(p.u, 0 + halfW, 1 - halfW);
      p.v = clamp(p.v, 0 + halfH, 1 - halfH);
      return p;
    }

    function isPointInsideArtwork(xCanvas, yCanvas) {
      const p = artworkCtrl.getPlacement?.();
      if (!p) return false;

      // placement bounds in WORLD, then convert to CANVAS to compare
      const w = placementToWorld(p);
      const c = worldToCanvasPx(w.cx, w.cy);

      const left = c.x - (w.dw * viewS) / 2;
      const top  = c.y - (w.dh * viewS) / 2;

      return (xCanvas >= left && xCanvas <= left + (w.dw * viewS) &&
              yCanvas >= top  && yCanvas <= top + (w.dh * viewS));
    }

    artCanvas.addEventListener('pointerdown', (e) => {
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

      // ✅ zone дотроо барина
      clampPlacementInsideZone(p);

      // ✅ optional: safe дотроо барина
      // const key = getActiveZoneKey?.() || 'front';
      // const safe = getSafeRectRel(key, printZoneCM);
      // clampPlacementToSafe(p, safe);

      artworkCtrl.setPlacement(p);
      onApplyDecalFromPose?.();
      drawEditor();
    });

    window.addEventListener('pointerup', () => {
      dragging2D = false;
    });
  }

  // ----------------------------
  // Init
  // ----------------------------
  resizeCanvasDPR();
  window.addEventListener('resize', () => {
    resizeCanvasDPR();
    drawEditor();
  });

  bindEditorEvents();
  drawEditor();

  return {
    drawEditor,
    updateOverlayBox: () => {},

    // main.js дээр setActiveZone солих үед printZoneCM update хийх бол хэрэгтэй
    setPrintZoneCM(cm) {
      // eslint-disable-next-line no-param-reassign
      printZoneCM = cm;
      drawEditor();
    },

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
