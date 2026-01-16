
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
// src/core/renderer.js
export function resizeRendererToElement(renderer, container) {
  const rect = container.getBoundingClientRect();

  // ✅ контейнер үнэхээр хэмжээсгүй байвал алгас
  if (rect.width < 10 || rect.height < 10) {
    return { width: 0, height: 0 };
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);

  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);

  renderer.setSize(w, h, false); // CSS size-г 100% дээр нь үлдээнэ
  return { width: w, height: h };
}

