// src/print/exportPNG.js
/**
 * Bake a flat PNG template + JSON job for printing.
 * This is a template-based export (no UV warp) using placement within zone.
 */
export async function bakeTemplatePNGAndJSON({
  artworkImage,
  placement,       // {u,v,uScale,vScale,rotationRad}
  printZone,       // {uMin,uMax,vMin,vMax, name?}
  printZoneCM,     // {width,height}
  dpi = 300,
  templatePx = 4096,
  product = { id: 'tshirt', side: 'front' }
}) {
  const aspect = printZoneCM.height / printZoneCM.width;
  const outW = templatePx;
  const outH = Math.round(outW * aspect);

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  const cx = placement.u * outW;
  const cy = (1 - placement.v) * outH;
  const dw = placement.uScale * outW;
  const dh = placement.vScale * outH;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(placement.rotationRad || 0);
  ctx.drawImage(artworkImage, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();

  const json = {
    product,
    zone: {
      name: printZone.name || product.side,
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

/**
 * ✅ NEW: batch helper
 * jobs: [{ key:'front', artworkImage, placement, printZone, printZoneCM, product }]
 */
export async function bakeManyPNGsAndJSON({
  jobs,
  dpi = 300,
  templatePx = 4096,
}) {
  const results = [];
  for (const j of jobs) {
    if (!j?.artworkImage || !j?.placement || !j?.printZone || !j?.printZoneCM) continue;
    const r = await bakeTemplatePNGAndJSON({
      artworkImage: j.artworkImage,
      placement: j.placement,
      printZone: j.printZone,
      printZoneCM: j.printZoneCM,
      dpi,
      templatePx,
      product: j.product || { id: 'tshirt', side: j.key || 'front' },
    });
    results.push({ key: j.key, ...r });
  }
  return results;
}
