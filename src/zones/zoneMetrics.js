
// src/zones/zoneMetrics.js
/** Convert a UV (relative to full mesh) into cm within the print zone rect */
export function uvToPrintCM(hitUV, printZone, printZoneCM) {
  const uRel = (hitUV.x - printZone.uMin) / Math.max(1e-6, (printZone.uMax - printZone.uMin));
  const vRel = (hitUV.y - printZone.vMin) / Math.max(1e-6, (printZone.vMax - printZone.vMin));

  return {
    x_cm: uRel * printZoneCM.width,
    y_cm: (1 - vRel) * printZoneCM.height
  };
}
