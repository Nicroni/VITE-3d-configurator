
// src/core/renderer.js
import * as THREE from 'three';

/**
 * Create a high-quality renderer and attach to container
 * @param {HTMLElement} container - e.g., document.getElementById('viewer3d')
 */
export function createRenderer(container, { alpha = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  container.appendChild(renderer.domElement);
  resizeRendererToElement(renderer, container);

  return { renderer, canvas: renderer.domElement };
}

/** Resize renderer to match container bounds */
export function resizeRendererToElement(renderer, container) {
  const rect = container.getBoundingClientRect();
  const w = Math.max(320, rect.width);
  const h = Math.max(240, rect.height);
  renderer.setSize(w, h, false);
  return { width: w, height: h };
}
