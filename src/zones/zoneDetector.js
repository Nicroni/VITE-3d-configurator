
// src/zones/zoneDetector.js
/**
 * Compute UV bounds from a dedicated zone mesh (PRINT_ZONE_FRONT)
 * Expects geometry with uv attribute. Returns {uMin,uMax,vMin,vMax,name,side}
 */
export function buildPrintZoneFromMesh(mesh) {
  const geom = mesh?.geometry;
  const uv = geom?.attributes?.uv;
  if (!uv) {
    // fallback generic zone
    return { uMin: 0.25, uMax: 0.75, vMin: 0.2, vMax: 0.85, name: 'fallback', side: 'front' };
  }
  let uMin = +Infinity, uMax = -Infinity, vMin = +Infinity, vMax = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return { uMin, uMax, vMin, vMax, name: mesh.name || 'PRINT_ZONE_FRONT', side: 'front' };
}

export function isUVInsidePrintZone(uv, zone) {
  return (uv.x >= zone.uMin && uv.x <= zone.uMax && uv.y >= zone.vMin && uv.y <= zone.vMax);
}
