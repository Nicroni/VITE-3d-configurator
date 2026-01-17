// src/editor/placement.js
import { clamp } from './clamp.js';

export function createArtworkController({ onUpdate } = {}) {
  let image = null;
  let placement = null; // { u, v, uScale, vScale, rotationRad }

  const api = {
    setImage(img) { image = img; onUpdate?.(); },
    getImage() { return image; },
    hasImage() { return !!image; },

    setPlacement(p) { placement = { ...placement, ...p }; onUpdate?.(); },
    getPlacement() { return placement; },
    hasPlacement() { return !!placement; },

    clear() { image = null; placement = null; onUpdate?.(); }, // ✅ NEW

    /** place center at uv inside given printZone {uMin,uMax,vMin,vMax} */
    placeAtUV(hitUV, printZone) {
      const u = (hitUV.x - printZone.uMin) / Math.max(1e-6, (printZone.uMax - printZone.uMin));
      const v = (hitUV.y - printZone.vMin) / Math.max(1e-6, (printZone.vMax - printZone.vMin));
      if (!placement) {
        placement = { u, v, uScale: 0.3, vScale: 0.3, rotationRad: 0 };
      } else {
        placement.u = u; placement.v = v;
      }
      onUpdate?.();
    },

    scaleBy(f) {
      if (!placement) return;
      placement.uScale = clamp(placement.uScale * f, 0.05, 1.2);
      placement.vScale = clamp(placement.vScale * f, 0.05, 1.2);
      onUpdate?.();
    },

    rotateByDeg(deg) {
      if (!placement) return;
      const r = (deg * Math.PI) / 180;
      placement.rotationRad = (placement.rotationRad || 0) + r;
      onUpdate?.();
    },
  };

  return api;
}

export function placementToCm(p, printZoneCM) {
  return {
    width_cm: p.uScale * printZoneCM.width,
    height_cm: p.vScale * printZoneCM.height,
    x_cm: p.u * printZoneCM.width,
    y_cm: (1 - p.v) * printZoneCM.height
  };
}

export function cmToPlacementWidth(widthCm, printZoneCM) {
  return clamp(widthCm / printZoneCM.width, 0.05, 1.2);
}

export function applySnap(p, {
  enableCenterSnap,
  enableGridSnap,
  gridCm,
  printZoneCM,
  shiftToDisable = false,
  shiftKey = false,
}) {
  if (shiftToDisable && shiftKey) return p;

  const r = { ...p };

  if (enableCenterSnap) {
    const eps = 0.02;
    if (Math.abs(r.u - 0.5) < eps) r.u = 0.5;
    if (Math.abs(r.v - 0.5) < eps) r.v = 0.5;
  }

  if (enableGridSnap && gridCm > 0) {
    const snap = (val) => Math.round(val / gridCm) * gridCm;
    const x = snap(r.u * printZoneCM.width);
    const y = snap((1 - r.v) * printZoneCM.height);
    r.u = clamp(x / printZoneCM.width, 0, 1);
    r.v = clamp(1 - (y / printZoneCM.height), 0, 1);
  }

  return r;
}
