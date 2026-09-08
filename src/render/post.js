import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { agxGlsl } from './tonemap.js';

/**
 * Final image pass.
 *
 * The renderer itself is left at NoToneMapping and the whole chain runs in a
 * half-float buffer, so bloom is computed on real HDR values instead of on
 * already-clipped LDR ones. Tone mapping is AgX (not ACES): ACES pushes bright
 * saturated colour toward the primaries and gives the orange-and-teal look that
 * reads as "game engine demo"; AgX desaturates as it clips, like film, which is
 * what a modern military shooter's image looks like.
 *
 * The AgX transform itself is generated from src/render/tonemap.js so the
 * shader and the unit tests are built from one set of numbers. agx() hands
 * back LINEAR light; the sRGB encode at the bottom of main() is the only
 * encode in the chain. Everything between those two points, the grade, the
 * damage tint and the vignette, is therefore expressed in linear light, which
 * is why those constants do not look like the values you would pick by eye.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uGrain: { value: 0.018 },
    uCA: { value: 0.30 },
    // 0.87 displayed at the corner, which is 0.87^2.2 in linear light.
    uVignette: { value: 0.265 },
    uSharpen: { value: 0.16 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uHurt: { value: 0 },
    uSat: { value: 1.02 },
    // Lift was 0.004/0.006/0.012 displayed; below 0.0031308 the sRGB
    // curve is linear with slope 12.92, so the linear values are those
    // divided by 12.92. Gain was 1.015/1.0/0.978 displayed, so linear
    // is those raised to 2.2. Same cool shadow, same warm-neutral gain.
    uLift: { value: new THREE.Vector3(0.00031, 0.00046, 0.00093) },
    uGain: { value: new THREE.Vector3(1.0334, 1.0, 0.9522) },
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

    // ---- AgX (Troy Sobotka's transform, minimal polynomial fit) ----------
    // Generated from src/render/tonemap.js. Returns linear light.
    ${agxGlsl()}

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
        // vec3(0.42, 0.02, 0.015) displayed, in linear light.
        col = mix(col, mix(grey, vec3(0.147, 0.00155, 0.00116), 0.55), uHurt * (0.30 + r2 * 1.5));
      }

      // Vignette, cos^4 falloff, the shape a real lens actually has.
      float v = 1.0 - uVignette * pow(r2 * 2.0, 1.35);
      col *= clamp(v, 0.0, 1.0);

      // The one and only sRGB encode: agx() returned linear light and this
      // pass writes to the default framebuffer.
      col = clamp(col, 0.0, 1.0);
      vec3 lo = col * 12.92;
      vec3 hi = 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055;
      col = mix(hi, lo, step(col, vec3(0.0031308)));

      // Grain last, in display space. Sensor noise is what you see, not what
      // the lens delivered; 0.018 added in linear light would sit two stops
      // above the shadows and turn them to speckle. Still scaled down in the
      // highlights, the way a real sensor behaves.
      float n = hash13(vec3(gl_FragCoord.xy, floor(uTime * 60.0))) - 0.5;
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += n * uGrain * (1.0 - lum * 0.75);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
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
  // can never clip into a wall, the standard FPS "viewmodel pass".
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
    // image, so it goes last, after the final pass has written sRGB.
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
