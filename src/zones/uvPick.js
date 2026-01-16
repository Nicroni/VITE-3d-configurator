
// src/zones/uvPick.js
import * as THREE from 'three';

/**
 * Барицентрийг UV хавтгай дээрээс олно.
 */
function barycentricFromUV(ua, ub, uc, p, eps = 1e-6) {
  const v0 = new THREE.Vector2().subVectors(ub, ua);
  const v1 = new THREE.Vector2().subVectors(uc, ua);
  const v2 = new THREE.Vector2().subVectors(p,  ua);

  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < eps) return null;

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;

  // Хөвөөлд бага зэрэг "зөөлөрсөн" шалгалт хийе
  const tol = 1e-5;
  if (u >= -tol && v >= -tol && w >= -tol) return { u, v, w };
  return null;
}

/**
 * Нэг geometry дээр өгөгдсөн UV цэгтэй таарах гурвалыг хайж,
 * таарвал world point + (локал) нормал + бусад мэдээллүүдийг буцаана.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Mesh} mesh
 * @param {THREE.Vector2} targetUV
 * @param {{uvAttr?: 'uv'|'uv2', wantWorldNormal?: boolean}} opts
 */
function pickOnGeometryByUV(geometry, mesh, targetUV, opts = {}) {
  const uvAttrName = geometry.attributes.uv
    ? (opts.uvAttr || 'uv')
    : (geometry.attributes.uv2 ? 'uv2' : null);

  const uv = uvAttrName ? geometry.attributes[uvAttrName] : null;
  const pos = geometry.attributes.position;

  if (!pos || !uv || uv.itemSize !== 2) return null;

  const index = geometry.index ? geometry.index.array : null;
  const triCount = index ? index.length / 3 : pos.count / 3;

  // Эрэмбэлээгүй bbox pre-check (UV дээр): бага зэрэг тэлэлттэй
  // Том geometry дээр гүйцэтгэлийг сайжруулна.
  const expand = 1e-6;
  const uvBox = { min: new THREE.Vector2(+Infinity, +Infinity), max: new THREE.Vector2(-Infinity, -Infinity) };
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < uvBox.min.x) uvBox.min.x = u;
    if (v < uvBox.min.y) uvBox.min.y = v;
    if (u > uvBox.max.x) uvBox.max.x = u;
    if (v > uvBox.max.y) uvBox.max.y = v;
  }
  if (targetUV.x < uvBox.min.x - expand || targetUV.x > uvBox.max.x + expand ||
      targetUV.y < uvBox.min.y - expand || targetUV.y > uvBox.max.y + expand) {
    return null; // UV ерөнхий мужид ч алга
  }

  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
  const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2();

  // World normal хэрэгтэй юу?
  const wantWorldNormal = !!opts.wantWorldNormal;
  const normalMatrix = wantWorldNormal ? new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld) : null;

  for (let i = 0; i < triCount; i++) {
    const ia = index ? index[i * 3]     : i * 3;
    const ib = index ? index[i * 3 + 1] : i * 3 + 1;
    const ic = index ? index[i * 3 + 2] : i * 3 + 2;

    // UV гурвалжин
    ua.set(uv.getX(ia), uv.getY(ia));
    ub.set(uv.getX(ib), uv.getY(ib));
    uc.set(uv.getX(ic), uv.getY(ic));

    // Хурдан bbox шалгалт (UV)
    const minU = Math.min(ua.x, ub.x, uc.x) - 1e-6;
    const maxU = Math.max(ua.x, ub.x, uc.x) + 1e-6;
    const minV = Math.min(ua.y, ub.y, uc.y) - 1e-6;
    const maxV = Math.max(ua.y, ub.y, uc.y) + 1e-6;
    const u = targetUV.x, v = targetUV.y;
    if (u < minU || u > maxU || v < minV || v > maxV) continue;

    // Барицентр
    const bc = barycentricFromUV(ua, ub, uc, targetUV);
    if (!bc) continue;

    // Оршин байгаа гурвалжны оройнууд (локал)
    pa.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
    pb.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
    pc.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic));

    // Локал цэг
    const pLocal = new THREE.Vector3()
      .addScaledVector(pa, bc.u)
      .addScaledVector(pb, bc.v)
      .addScaledVector(pc, bc.w);

    // Локал нормал (face normal)
    const nLocal = new THREE.Vector3()
      .subVectors(pb, pa)
      .cross(new THREE.Vector3().subVectors(pc, pa))
      .normalize();

    // World цэг
    const pWorld = pLocal.clone().applyMatrix4(mesh.matrixWorld);

    // (Сонголтоор) World нормал
    let nWorld = null;
    if (wantWorldNormal && normalMatrix) {
      nWorld = nLocal.clone().applyMatrix3(normalMatrix).normalize();
    }

    return {
      object: mesh,
      point: pWorld,               // world position
      pointLocal: pLocal,          // local position (diagnostics)
      uv: targetUV.clone(),
      barycentric: bc,
      face: { normal: nLocal },    // three.js raycaster-тэй ижил: LOCAL normal
      normalWorld: nWorld          // шаардлагатай бол ашиглаж болно
    };
  }
  return null;
}

/**
 * Mesh болон бүх хүүхдүүд дээр UV-р pick хийнэ. `uv` байхгүй бол `uv2`-г туршина.
 * @param {THREE.Object3D} mesh
 * @param {THREE.Vector2} targetUV
 * @param {{uvAttr?: 'uv'|'uv2', wantWorldNormal?: boolean}} opts
 */

export function pickOnMeshByUV(mesh, targetUV, opts = {}) {
  let hit = null;

  // 1) Яв цав заасан сувгаар
  mesh.traverse((o) => {
    if (hit || !o.isMesh || !o.geometry) return;
    hit = pickOnGeometryByUV(o.geometry, o, targetUV, { uvAttr: opts.uvAttr || 'uv', wantWorldNormal: opts.wantWorldNormal });
  });
  if (hit) return hit;

  // 2) Fallback сувгаар
  if (!opts.uvAttr) {
    mesh.traverse((o) => {
      if (hit || !o.isMesh || !o.geometry) return;
      if (!o.geometry.attributes?.uv2) return;
      hit = pickOnGeometryByUV(o.geometry, o, targetUV, { uvAttr: 'uv2', wantWorldNormal: opts.wantWorldNormal });
    });
  }

  if (!hit) {
    console.warn('[uvPick] no hit for', mesh?.name, 'targetUV=', targetUV.toArray(),
                 'attrs:', !!mesh?.geometry?.attributes?.uv, !!mesh?.geometry?.attributes?.uv2);
  }
  return hit;
}
