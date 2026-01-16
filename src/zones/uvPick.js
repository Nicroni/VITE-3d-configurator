
// src/zones/uvPick.js
import * as THREE from 'three';

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

  // seam орчимд зөөлрүүлсэн шалгалт
  const tol = 2e-5;
  if (u >= -tol && v >= -tol && w >= -tol) return { u, v, w };
  return null;
}

// UV гурвалжин дээр өгөгдсөн цэгийн "хамгийн ойр цэг" (clamped barycentric) ба квадратыг буцаана
function closestPointOnUVTriangle(ua, ub, uc, p) {
  // Möller–Trumbore style биш, харин 2D-д projection + clamp
  // Энд бид туршилтын энгийн хэрэгжилт ашиглая.
  const v0 = new THREE.Vector2().subVectors(ub, ua);
  const v1 = new THREE.Vector2().subVectors(uc, ua);
  const v2 = new THREE.Vector2().subVectors(p,  ua);

  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);

  const denom = d00 * d11 - d01 * d01;
  if (denom <= 1e-12) {
    return { bc: { u: 1, v: 0, w: 0 }, dist2: Infinity };
  }

  let v = (d11 * d20 - d01 * d21) / denom;
  let w = (d00 * d21 - d01 * d20) / denom;
  let u = 1 - v - w;

  // Хэрэв гурвалжнаас гадуур байвал хавч
  // (triangle barycentric clamp)
  // Энгийн clamp: u,v,w-г [0,1] болгож, нийлбэрийг 1 болгоно
  // (салангид тохиолдолд төгс биш ч хамгийн ойрын оройд ойртуулна)
  if (u < 0 || v < 0 || w < 0) {
    u = Math.max(0, u);
    v = Math.max(0, v);
    w = Math.max(0, w);
    const s = u + v + w || 1;
    u /= s; v /= s; w /= s;
  }

  const q = new THREE.Vector2()
    .addScaledVector(ua, u)
    .addScaledVector(ub, v)
    .addScaledVector(uc, w);

  const dist2 = q.distanceToSquared(p);
  return { bc: { u, v, w }, dist2 };
}

function pickOnGeometryByUV(geometry, mesh, targetUV, opts = {}) {
  // uv байхгүй бол uv2-г шалгах боломж олгохын тулд нэрийг гаднаас авна
  const uvAttrName = opts.uvAttr || (geometry.attributes.uv ? 'uv' : (geometry.attributes.uv2 ? 'uv2' : null));
  const uv = uvAttrName ? geometry.attributes[uvAttrName] : null;
  const pos = geometry.attributes.position;
  if (!pos || !uv || uv.itemSize !== 2) return null;

  const index = geometry.index ? geometry.index.array : null;
  const triCount = index ? index.length / 3 : pos.count / 3;

  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
  const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2();

  // world normal (сонголтоор)
  const wantWorldNormal = !!opts.wantWorldNormal;
  const normalMatrix = wantWorldNormal ? new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld) : null;

  // 1) Эхний тойрог — яг дотор нь таарах эсэхийг хайна
  for (let i = 0; i < triCount; i++) {
    const ia = index ? index[i * 3]     : i * 3;
    const ib = index ? index[i * 3 + 1] : i * 3 + 1;
    const ic = index ? index[i * 3 + 2] : i * 3 + 2;

    ua.set(uv.getX(ia), uv.getY(ia));
    ub.set(uv.getX(ib), uv.getY(ib));
    uc.set(uv.getX(ic), uv.getY(ic));

    // хурдан bbox check
    const minU = Math.min(ua.x, ub.x, uc.x) - 2e-5;
    const maxU = Math.max(ua.x, ub.x, uc.x) + 2e-5;
    const minV = Math.min(ua.y, ub.y, uc.y) - 2e-5;
    const maxV = Math.max(ua.y, ub.y, uc.y) + 2e-5;
    const u = targetUV.x, v = targetUV.y;
    if (u < minU || u > maxU || v < minV || v > maxV) continue;

    const bc = barycentricFromUV(ua, ub, uc, targetUV);
    if (!bc) continue;

    pa.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
    pb.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
    pc.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic));

    const pLocal = new THREE.Vector3()
      .addScaledVector(pa, bc.u)
      .addScaledVector(pb, bc.v)
      .addScaledVector(pc, bc.w);

    const nLocal = new THREE.Vector3()
      .subVectors(pb, pa)
      .cross(new THREE.Vector3().subVectors(pc, pa))
      .normalize();

    const pWorld = pLocal.clone().applyMatrix4(mesh.matrixWorld);
    let nWorld = null;
    if (wantWorldNormal && normalMatrix) nWorld = nLocal.clone().applyMatrix3(normalMatrix).normalize();

    return {
      object: mesh,
      point: pWorld,
      pointLocal: pLocal,
      uv: targetUV.clone(),
      barycentric: bc,
      face: { normal: nLocal },
      normalWorld: nWorld
    };
  }

  // 2) Nearest-triangle fallback — хамгийн ойрын гурвалжин руу хавчина
  let best = { dist2: Infinity, bc: null, ia: 0, ib: 0, ic: 0, hit: null };
  for (let i = 0; i < triCount; i++) {
    const ia = index ? index[i * 3]     : i * 3;
    const ib = index ? index[i * 3 + 1] : i * 3 + 1;
    const ic = index ? index[i * 3 + 2] : i * 3 + 2;

    ua.set(uv.getX(ia), uv.getY(ia));
    ub.set(uv.getX(ib), uv.getY(ib));
    uc.set(uv.getX(ic), uv.getY(ic));

    const { bc, dist2 } = closestPointOnUVTriangle(ua, ub, uc, targetUV);
    if (dist2 < best.dist2) {
      best = { dist2, bc, ia, ib, ic };
    }
  }

  if (best.bc) {
    const { ia, ib, ic, bc } = best;

    pa.set(pos.getX(ia), pos.getY(ia), pos.getZ(ia));
    pb.set(pos.getX(ib), pos.getY(ib), pos.getZ(ib));
    pc.set(pos.getX(ic), pos.getY(ic), pos.getZ(ic));

    const pLocal = new THREE.Vector3()
      .addScaledVector(pa, bc.u)
      .addScaledVector(pb, bc.v)
      .addScaledVector(pc, bc.w);

    const nLocal = new THREE.Vector3()
      .subVectors(pb, pa)
      .cross(new THREE.Vector3().subVectors(pc, pa))
      .normalize();

    const pWorld = pLocal.clone().applyMatrix4(mesh.matrixWorld);
    let nWorld = null;
    if (wantWorldNormal && normalMatrix) nWorld = nLocal.clone().applyMatrix3(normalMatrix).normalize();

    return {
      object: mesh,
      point: pWorld,
      pointLocal: pLocal,
      uv: targetUV.clone(),
      barycentric: bc,
      face: { normal: nLocal },
      normalWorld: nWorld,
      _nearestFallback: true
    };
  }

  return null;
}

export function pickOnMeshByUV(mesh, targetUV, opts = {}) {
  let hit = null;

  // 1) Яв цав заасан сувгаар (эсвэл uv)
  mesh.traverse((o) => {
    if (hit || !o.isMesh || !o.geometry) return;
    hit = pickOnGeometryByUV(o.geometry, o, targetUV, { uvAttr: opts.uvAttr || 'uv', wantWorldNormal: opts.wantWorldNormal });
  });
  if (hit) return hit;

  // 2) Олдохгүй бол uv2 сувгаар оролдоно
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
