export function buildPrintZoneFromMesh(mesh, side = 'front') {
  const geom = mesh?.geometry;
  const uv = geom?.attributes?.uv;

  if (!uv) {
    return { uMin: 0.25, uMax: 0.75, vMin: 0.2, vMax: 0.85, name: 'fallback', side };
  }

  const us = [];
  const vs = [];
  for (let i = 0; i < uv.count; i++) {
    us.push(uv.getX(i));
    vs.push(uv.getY(i));
  }

  us.sort((a,b)=>a-b);
  vs.sort((a,b)=>a-b);

  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];

  // ✅ outlier cut (2% .. 98%)
  let uMin = q(us, 0.02), uMax = q(us, 0.98);
  let vMin = q(vs, 0.02), vMax = q(vs, 0.98);

  // ✅ (optional) UV wrap fix: хэрвээ u range хэт том байвал wrap гэж үзнэ
  if ((uMax - uMin) > 0.7) {
    // 0..1 boundary давсан байж магадгүй → 0.5-аас бага u-г +1 болгож дахин bounds авна
    const us2 = us.map(u => (u < 0.5 ? u + 1 : u)).sort((a,b)=>a-b);
    uMin = q(us2, 0.02); uMax = q(us2, 0.98);
    // буцаад 0..1 болгож нормальчилно
    uMin = (uMin > 1 ? uMin - 1 : uMin);
    uMax = (uMax > 1 ? uMax - 1 : uMax);
    // note: энэ тохиолдолд rectangle 0/1 boundary-г давна (атлас дээр “тасархай” харагдаж болно)
  }

  return { uMin, uMax, vMin, vMax, name: mesh.name || side, side };
}

export function isUVInsidePrintZone(uv, zone, pad = 0) {
  if (!uv || !zone) return false;
  const u = uv.x, v = uv.y;
  return (
    u >= zone.uMin + pad && u <= zone.uMax - pad &&
    v >= zone.vMin + pad && v <= zone.vMax - pad
  );
}
