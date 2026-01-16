
// src/editor/transforms.js
/**
 * Project world pos -> screen px relative to a canvas
 */
export function worldToScreen(pos, camera, canvas) {
  const v = pos.clone().project(camera);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return {
    x: (v.x * 0.5 + 0.5) * w,
    y: (-v.y * 0.5 + 0.5) * h
  };
}
