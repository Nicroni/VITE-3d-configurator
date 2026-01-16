
// src/core/raycast.js
import * as THREE from 'three';

const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();

/** Convert pointer to NDC relative to a canvas */
function eventToNDC(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / Math.max(1, rect.width);
  const y = (e.clientY - rect.top) / Math.max(1, rect.height);
  mouseNDC.set(x * 2 - 1, -(y * 2 - 1));
  return mouseNDC;
}

/**
 * Raycast the given object (or group) using a pointer event
 * @returns {THREE.Intersection|null}
 */
export function hitTest(e, camera, object, canvas) {
  if (!object) return null;
  const ndc = eventToNDC(e, canvas);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(object, true);
  return hits.length ? hits[0] : null;
}
