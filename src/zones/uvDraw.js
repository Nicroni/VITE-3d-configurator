// src/zones/uvDraw.js
import * as THREE from "three";

export function drawMeshUV(ctx, mesh, {
  canvasW,
  canvasH,
  stroke = null,                 // ✅ default: no stroke
  fill = "rgba(120,170,255,0.18)",
  lineWidth = 1
} = {}) {
  if (!mesh?.geometry) return;

  const geom = mesh.geometry;
  const uv = geom.attributes.uv || geom.attributes.uv2;
  const pos = geom.attributes.position;
  if (!pos || !uv) return;

  const index = geom.index ? geom.index.array : null;
  const triCount = index ? index.length / 3 : pos.count / 3;

  ctx.save();
  ctx.fillStyle = fill;

  ctx.beginPath();
  for (let i = 0; i < triCount; i++) {
    const ia = index ? index[i * 3] : i * 3;
    const ib = index ? index[i * 3 + 1] : i * 3 + 1;
    const ic = index ? index[i * 3 + 2] : i * 3 + 2;

    const ax = uv.getX(ia) * canvasW, ay = (1 - uv.getY(ia)) * canvasH;
    const bx = uv.getX(ib) * canvasW, by = (1 - uv.getY(ib)) * canvasH;
    const cx = uv.getX(ic) * canvasW, cy = (1 - uv.getY(ic)) * canvasH;

    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.closePath();
  }

  ctx.fill();

  // ✅ stroke хүсвэл л зурна
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  ctx.restore();
}
