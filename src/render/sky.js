import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Physical-ish sky + IBL + sun.
 *
 * The sun is a single directional light with an orthographic shadow frustum
 * that re-centres on the player each frame. Cascaded shadow maps (CSM) would
 * give sharper contact shadows at range, but CSM patches every material's
 * shader and is the most common source of "black screen on some GPUs" in
 * browser builds, so this build takes the boring, reliable option and spends
 * the budget on texel density instead.
 */
export function buildSky(scene, renderer, quality) {
  const sky = new Sky();
  sky.scale.setScalar(45000);
  scene.add(sky);

  // Late afternoon: low sun, long shadows, warm key / cool sky fill.
  const elevation = 14.5;
  const azimuth = 122;
  const u = sky.material.uniforms;
  u.turbidity.value = 4.2;
  u.rayleigh.value = 1.35;
  u.mieCoefficient.value = 0.0065;
  u.mieDirectionalG.value = 0.82;

  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  u.sunPosition.value.copy(sunDir);

  // Image-based lighting straight from the sky shader — no HDR file to load.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromScene(sky, 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.85;

  const sun = new THREE.DirectionalLight(0xffd9b0, 3.35);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow = quality.shadows;
  if (quality.shadows) {
    sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    const s = quality.shadowExtent;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 1.6;
  }
  scene.add(sun);
  scene.add(sun.target);

  // Bounce term: the ground is bright sand, so faces pointing down are not black.
  const bounce = new THREE.HemisphereLight(0xbcd4ff, 0xcaa877, 0.55);
  scene.add(bounce);

  // Aerial perspective. Colour sampled from the horizon so distant geometry
  // dissolves into the sky rather than into an arbitrary grey.
  scene.fog = new THREE.FogExp2(0xbfc6cf, 0.0042);

  const target = new THREE.Vector3();
  return {
    sky,
    sun,
    sunDir,
    envRT,
    /** Keep the shadow frustum centred on the player (texel-snapped). */
    update(playerPos) {
      const texel = (quality.shadowExtent * 2) / quality.shadowMap;
      const sx = Math.round(playerPos[0] / texel) * texel;
      const sz = Math.round(playerPos[2] / texel) * texel;
      target.set(sx, 0, sz);
      sun.target.position.copy(target);
      sun.position.copy(sunDir).multiplyScalar(120).add(target);
      sun.target.updateMatrixWorld();
    },
    dispose() {
      envRT.dispose();
      pmrem.dispose();
    },
  };
}
