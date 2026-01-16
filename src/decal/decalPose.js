
// src/decal/decalPose.js
import * as THREE from 'three';

/** Build base pose (position+orientation) from raycast hit normal */
export function buildPoseFromHit(hit) {
  const position = hit.point.clone();
  const n = hit.face?.normal?.clone();
  if (!n) return null;
  n.transformDirection(hit.object.matrixWorld);

  const m = new THREE.Matrix4();
  m.lookAt(position, position.clone().add(n), new THREE.Vector3(0, 1, 0));
  const baseOrientation = new THREE.Euler().setFromRotationMatrix(m);

  return { object: hit.object, position, baseOrientation };
}

export function orientationWithUserRotation(baseOrientation, rotationRad = 0) {
  const o = baseOrientation.clone();
  o.z += rotationRad;
  return o;
}
