// src/decal/decalMaterial.js
import * as THREE from 'three';

let artworkTexture = null;

export function createDecalMaterial(renderer) {
  const mat = new THREE.MeshStandardMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    color: 0xffffff, // ✅ map-аа харанхуйлуулахгүй
  });
  if (renderer) mat.needsUpdate = true;
  return { material: mat };
}

/**
 * @param {HTMLImageElement} img
 * @param {THREE.Material} material
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ flipU?: boolean }} opts
 */
export function setArtworkTextureFromImage(img, material, renderer, opts = {}) {
  if (!material) return;

  const { flipU = false } = opts;

  if (artworkTexture) {
    artworkTexture.dispose();
    artworkTexture = null;
  }

  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;

  // ✅ IMPORTANT: negative repeat хэрэглэх гэж байгаа бол RepeatWrapping хэрэгтэй
  tex.wrapS = flipU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;

  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;

  if (flipU) {
    // Flip horizontally (U axis)
    tex.repeat.set(-1, 1);
    tex.offset.set(1, 0);
  } else {
    tex.repeat.set(1, 1);
    tex.offset.set(0, 0);
  }

  tex.needsUpdate = true;

  material.map = tex;
  material.needsUpdate = true;
  artworkTexture = tex;
}

export function hasArtworkTexture() {
  return !!artworkTexture;
}
