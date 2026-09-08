import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/**
 * Final image pass.
 *
 * The renderer itself is left at NoToneMapping and the whole chain runs in a
 * half-float buffer, so bloom is computed on real HDR values instead of on
 * already-clipped LDR ones. Tone mapping is AgX (not ACES): ACES pushes bright
 * saturated colour toward the primaries and gives the orange-and-teal look that
 * reads as "game engine demo"; AgX desaturates as it clips, like film, which is
 * what a modern military shooter's image looks like.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uGrain: { value: 0.018 },
    uCA: { value: 0.30 },
    uVignette: { value: 0.13 },
    uSharpen: { value: 0.16 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uHurt: { value: 0 },
    uSat: { value: 1.02 },
    uLift: { value: new THREE.Vector3(0.004, 0.006, 0.012) },
    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.978) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure, uGrain, uCA, uVignette, uSharpen, uTime, uHurt, uSat;
    uniform vec2 uResolution;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    // ---- AgX (Troy Sobotka's transform, minimal polynomial fit) -------------
    const mat3 AGX_IN = mat3(
      0.8424790622, 0.0423282423, 0.0423756549,
      0.0784336000, 0.8784686365, 0.0784336000,
      0.0792237451, 0.0791661275, 0.8791429738);
    const mat3 AGX_OUT = mat3(
       1.1968790051, -0.0528968518, -0.0529716355,
      -0.0980208811,  1.1519031299, -0.0980434501,
      -0.0990297441, -0.0989611768,  1.1510736726);

    vec3 agxContrast(vec3 x) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return  15.5     * x4 * x2
            - 40.14    * x4 * x
            + 31.96    * x4
            -  6.868   * x2 * x
            +  0.4298  * x2
            +  0.1191  * x
            -  0.00232;
    }

    vec3 agx(vec3 col) {
      const float MIN_EV = -12.47393;
      const float MAX_EV = 4.026069;
      col = AGX_IN * max(col, vec3(0.0));
      col = clamp(log2(max(col, 1e-10)), MIN_EV, MAX_EV);
      col = (col - MIN_EV) / (MAX_EV - MIN_EV);
      col = agxContrast(col);
      // "punchy" look: slight power + saturation restore, then back to linear
      vec3 luma = vec3(dot(col, vec3(0.2126, 0.7152, 0.0722)));
      col = mix(luma, col, 1.28);
      col = pow(max(col, vec3(0.0)), vec3(1.0, 0.98, 0.99));
      col = AGX_OUT * col;
      return max(col, vec3(0.0));
    }

    float hash13(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // Chromatic aberration: sub-pixel, radial, zero at the crosshair.
      vec2 px = 1.0 / uResolution;
      float caAmt = uCA * (1.0 + uHurt * 3.0);
      vec2 off = c * r2 * caAmt * 2.0 * px * uResolution.y * 0.004;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;

      // Unsharp mask in linear light, before tone mapping.
      if (uSharpen > 0.0) {
        vec3 blur =
          texture2D(tDiffuse, uv + vec2( px.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(-px.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0,  px.y)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0, -px.y)).rgb;
        col += (col - blur * 0.25) * uSharpen;
        col = max(col, vec3(0.0));
      }

      col *= uExposure;
      col = agx(col);

      // Lift / gain grade, then saturation.
      col = col * uGain + uLift;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);

      // Damage: desaturate and push red at the edges.
      if (uHurt > 0.0) {
        vec3 grey = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
        col = mix(col, mix(grey, vec3(0.42, 0.02, 0.015), 0.55), uHurt * (0.30 + r2 * 1.5));
      }

      // Vignette — cos^4 falloff, the shape a real lens actually has.
      float v = 1.0 - uVignette * pow(r2 * 2.0, 1.35);
      col *= clamp(v, 0.0, 1.0);

      // Grain, scaled down in highlights the way sensor noise behaves.
      float n = hash13(vec3(gl_FragCoord.xy, floor(uTime * 60.0))) - 0.5;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += n * uGrain * (1.0 - lum * 0.75);

      col = clamp(col, 0.0, 1.0);
      // Manual sRGB encode: this pass writes to the default framebuffer.
      vec3 lo = col * 12.92;
      vec3 hi = 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055;
      gl_FragColor = vec4(mix(hi, lo, step(col, vec3(0.0031308))), 1.0);
    }
  `,
};

export function buildComposer(renderer, scene, camera, viewScene, viewCamera, quality) {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const pr = renderer.getPixelRatio();

  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    samples: quality.msaa,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pr);
  composer.setSize(size.x, size.y);

  composer.addPass(new RenderPass(scene, camera));

  // The weapon is rendered by a second camera with its own near plane so it
  // can never clip into a wall — the standard FPS "viewmodel pass".
  const vmPass = new RenderPass(viewScene, viewCamera);
  vmPass.clear = false;
  vmPass.clearDepth = true;
  composer.addPass(vmPass);

  let bloom = null;
  if (quality.bloom) {
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), quality.bloomStrength, quality.bloomRadius, quality.bloomThreshold);
    composer.addPass(bloom);
  }

  const final = new ShaderPass(FinalShader);
  final.uniforms.uResolution.value.set(size.x * pr, size.y * pr);
  final.uniforms.uGrain.value = quality.grain;
  final.uniforms.uSharpen.value = quality.sharpen;
  final.renderToScreen = true;
  composer.addPass(final);

  let smaa = null;
  if (quality.smaa) {
    // SMAA is an edge-detection filter that expects a perceptually encoded
    // image, so it goes last — after the final pass has written sRGB.
    smaa = new SMAAPass(size.x * pr, size.y * pr);
    final.renderToScreen = false;
    composer.addPass(smaa);
    smaa.renderToScreen = true;
  }

  return {
    composer,
    final,
    bloom,
    setSize(w, h) {
      const p = renderer.getPixelRatio();
      composer.setPixelRatio(p);
      composer.setSize(w, h);
      final.uniforms.uResolution.value.set(w * p, h * p);
      if (bloom) bloom.setSize(w, h);
      if (smaa) smaa.setSize(w * p, h * p);
    },
  };
}
