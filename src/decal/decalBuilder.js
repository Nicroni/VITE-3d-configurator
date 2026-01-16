
// src/decal/decalBuilder.js
import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { orientationWithUserRotation } from './decalPose.js';

export function buildDecalMesh(pose, { width, height, depth }, rotationRad, material) {
  const orientation = orientationWithUserRotation(pose.baseOrientation, rotationRad);
  const size = new THREE.Vector3(width, height, depth);
  const geo = new DecalGeometry(pose.object, pose.position, orientation, size);
  return new THREE.Mesh(geo, material);
}

export function disposeDecalMesh(mesh, scene) {
  if (!mesh) return;
  mesh.geometry?.dispose?.();
  scene?.remove(mesh);
}

