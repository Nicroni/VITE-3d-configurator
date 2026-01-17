// src/print/exportJSON.js
export function buildPrintJobJSON({ placement, printZone, printZoneCM, dpi, templatePx, product }) {
  return {
    product,
    zone: {
      name: printZone.name,
      cm: printZoneCM,
      uv: {
        uMin: printZone.uMin,
        uMax: printZone.uMax,
        vMin: printZone.vMin,
        vMax: printZone.vMax
      }
    },
    placement: {
      u: placement.u,
      v: placement.v,
      uScale: placement.uScale,
      vScale: placement.vScale,
      rotationDeg: (placement.rotationRad || 0) * 180 / Math.PI
    },
    meta: {
      dpi,
      templatePx,
      timestamp: new Date().toISOString()
    }
  };
}

// helper function for cropping a canvas
export function cropCanvas(srcCanvas, crop) {
  const { x, y, w, h } = crop;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w));
  out.height = Math.max(1, Math.round(h));
  const octx = out.getContext('2d');
  octx.drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
  return out;
}

