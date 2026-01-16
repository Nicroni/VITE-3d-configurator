
// src/print/exportPNG.js
/**
 * Bake a flat PNG template + JSON job for printing.
 * This is a template-based export (no UV warp) using placement within zone.
 */
export async function bakeTemplatePNGAndJSON({
  artworkImage,
  placement,       // {u,v,uScale,vScale,rotationRad}
  printZone,       // {uMin,uMax,vMin,vMax}
  printZoneCM,     // {width,height}
  dpi = 300,
  templatePx = 4096,
  product = { id: 'tshirt', side: 'front' }
}) {
  const aspect = printZoneCM.height / printZoneCM.width; // e.g. 40/30 => 4/3
  const outW = templatePx;
  const outH = Math.round(outW * aspect);

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');

  // white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  // draw artwork per placement
  // placement u/v are center in [0..1] of zone; scale are fraction of zone
  const cx = placement.u * outW;
  const cy = (1 - placement.v) * outH;
  const dw = placement.uScale * outW;
  const dh = placement.vScale * outH;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(placement.rotationRad || 0);
  ctx.drawImage(artworkImage, -dw/2, -dh/2, dw, dh);
  ctx.restore();

  // Build JSON
  const json = {
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
      templatePx: { width: outW, height: outH },
      timestamp: new Date().toISOString(),
    }
  };

  const pngDataURL = canvas.toDataURL('image/png');
  return { pngDataURL, json };
}

