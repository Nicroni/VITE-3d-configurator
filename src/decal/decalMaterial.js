
// src/decal/decalMaterial.js
import * as THREE from 'three';

let artworkTexture = null;

export function createDecalMaterial(renderer) {
  const mat = new THREE.MeshStandardMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4
  });
  if (renderer) {
    mat.needsUpdate = true;
  }
  return { material: mat };
}

export function setArtworkTextureFromImage(img, material, renderer) {
  if (!material) return;
  if (artworkTexture) {
    artworkTexture.dispose();
    artworkTexture = null;
  }
  const tex = new THREE.Texture(img);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;

  material.map = tex;
  material.needsUpdate = true;
  artworkTexture = tex;
}

export function hasArtworkTexture() {
  return !!artworkTexture;
}
