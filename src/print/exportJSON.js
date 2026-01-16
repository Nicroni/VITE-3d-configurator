
// src/print/exportJSON.js
export function buildPrintJobJSON({ placement, printZone, printZoneCM, dpi, templatePx, product }) {
  return {
    product,
    zone: {
      name: printZone.name,
      cm: printZoneCM,
      uv: { uMin: printZone.uMin, uMax: printZone.uMax, vMin: printZone.vMin, vMax: printZone.vMax }
    },
    placement: {
      u: placement.u, v: placement.v,
      uScale: placement.uScale, vScale: placement.vScale,
      rotationDeg: (placement.rotationRad || 0) * 180 / Math.PI
    },
    meta: {
      dpi,
      templatePx,
      timestamp: new Date().toISOString(),
    }
  };
}
