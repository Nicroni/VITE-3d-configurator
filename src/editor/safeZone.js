// src/editor/safeZone.js
import { SAFE_MARGINS_CM } from '../config/safeMargins.js';
import { clamp } from './clamp.js';

export function getSafeRectRel(activeZoneKey, printZoneCM) {
  const m = SAFE_MARGINS_CM?.[activeZoneKey] || SAFE_MARGINS_CM.front;

  const W = Math.max(1e-6, printZoneCM?.width || 30);
  const H = Math.max(1e-6, printZoneCM?.height || 40);

  // placement v is TOP -> DOWN
  const uMin = m.left / W;
  const uMax = 1 - (m.right / W);
  const vMin = m.top / H;
  const vMax = 1 - (m.bottom / H);

  return { uMin, uMax, vMin, vMax, marginsCm: m };
}

export function placementBounds(p) {
  const left = p.u - p.uScale * 0.5;
  const right = p.u + p.uScale * 0.5;
  const top = p.v - p.vScale * 0.5;
  const bottom = p.v + p.vScale * 0.5;
  return { left, right, top, bottom };
}

export function isPlacementInsideSafe(p, safe) {
  const b = placementBounds(p);
  return (
    b.left >= safe.uMin &&
    b.right <= safe.uMax &&
    b.top >= safe.vMin &&
    b.bottom <= safe.vMax
  );
}

export function clampPlacementToSafe(p, safe) {
  const halfW = p.uScale * 0.5;
  const halfH = p.vScale * 0.5;

  // Safe дотор “зураг бүхэлдээ багтах” байдлаар clamp хийнэ
  p.u = clamp(p.u, safe.uMin + halfW, safe.uMax - halfW);
  p.v = clamp(p.v, safe.vMin + halfH, safe.vMax - halfH);

  return p;
}
