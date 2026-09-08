#!/usr/bin/env python3
"""Fix the double gamma encode in the final post-processing pass.

agx() in src/render/post.js returned the AgX sigmoid output directly. That
output is display-referred: the sigmoid has roughly a 2.2 gamma baked into it.
The shader then ran a second, manual sRGB encode before writing to the default
framebuffer. Encoding twice lifts the whole image into the top half of the
range, which is why 0.5% linear grey displayed at 27% instead of 2.5%, and why
the game looked like it had been shot through milk.

The transform now lives in src/render/tonemap.js as numbers, and both consumers
are built from those numbers: the shader injects agxGlsl(), the tests call
agxJs(). agx() returns linear light and the caller encodes exactly once.

The grade was tuned by eye in display space, so every constant that operates
after agx() moves to its linear equivalent here, or the fix would trade one
wrong picture for another. Grain moves after the encode, because sensor noise
is a display-space perturbation and 0.018 added in linear light would bury the
shadows in speckle.

The script asserts every anchor it touches. If the file on disk is not what
this script expects, it fails instead of writing something half-patched.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f"FAIL [{label}]: expected exactly 1 occurrence, found {n}")
    return text.replace(old, new)


def patch_post():
    path = ROOT / "src" / "render" / "post.js"
    src = path.read_text(encoding="utf-8")
    before = len(src)

    src = replace_once(
        src,
        "import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';\n",
        "import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';\n"
        "import { agxGlsl } from './tonemap.js';\n",
        "import agxGlsl",
    )

    src = replace_once(
        src,
        """ * what a modern military shooter's image looks like.
 */""",
        """ * what a modern military shooter's image looks like.
 *
 * The AgX transform itself is generated from src/render/tonemap.js so the
 * shader and the unit tests are built from one set of numbers. agx() hands
 * back LINEAR light; the sRGB encode at the bottom of main() is the only
 * encode in the chain. Everything between those two points, the grade, the
 * damage tint and the vignette, is therefore expressed in linear light, which
 * is why those constants do not look like the values you would pick by eye.
 */""",
        "header comment",
    )

    # ---- constants that act after agx(), converted to linear light ---------
    src = replace_once(
        src,
        "    uVignette: { value: 0.13 },",
        "    // 0.87 displayed at the corner, which is 0.87^2.2 in linear light.\n"
        "    uVignette: { value: 0.265 },",
        "uVignette",
    )
    src = replace_once(
        src,
        "    uLift: { value: new THREE.Vector3(0.004, 0.006, 0.012) },\n"
        "    uGain: { value: new THREE.Vector3(1.015, 1.0, 0.978) },",
        "    // Lift was 0.004/0.006/0.012 displayed; below 0.0031308 the sRGB\n"
        "    // curve is linear with slope 12.92, so the linear values are those\n"
        "    // divided by 12.92. Gain was 1.015/1.0/0.978 displayed, so linear\n"
        "    // is those raised to 2.2. Same cool shadow, same warm-neutral gain.\n"
        "    uLift: { value: new THREE.Vector3(0.00031, 0.00046, 0.00093) },\n"
        "    uGain: { value: new THREE.Vector3(1.0334, 1.0, 0.9522) },",
        "uLift/uGain",
    )

    # ---- the transform itself, now generated -------------------------------
    old_agx_start = "    // ---- AgX (Troy Sobotka's transform, minimal polynomial fit) ---"
    old_agx_end = "      return max(col, vec3(0.0));\n    }\n"
    i = src.find(old_agx_start)
    if i < 0:
        sys.exit("FAIL [agx block]: start anchor not found")
    j = src.find(old_agx_end, i)
    if j < 0:
        sys.exit("FAIL [agx block]: end anchor not found")
    j += len(old_agx_end)
    src = (
        src[:i]
        + "    // ---- AgX (Troy Sobotka's transform, minimal polynomial fit) ----------\n"
        + "    // Generated from src/render/tonemap.js. Returns linear light.\n"
        + "    ${agxGlsl()}\n"
        + src[j:]
    )

    # ---- damage tint, converted to linear ----------------------------------
    src = replace_once(
        src,
        "        col = mix(col, mix(grey, vec3(0.42, 0.02, 0.015), 0.55),"
        " uHurt * (0.30 + r2 * 1.5));",
        "        // vec3(0.42, 0.02, 0.015) displayed, in linear light.\n"
        "        col = mix(col, mix(grey, vec3(0.147, 0.00155, 0.00116), 0.55),"
        " uHurt * (0.30 + r2 * 1.5));",
        "damage tint",
    )

    # ---- grain moves after the encode --------------------------------------
    old_tail = """      // Vignette \u2014 cos^4 falloff, the shape a real lens actually has.
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
"""
    new_tail = """      // Vignette, cos^4 falloff, the shape a real lens actually has.
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
"""
    src = replace_once(src, old_tail, new_tail, "grain after encode")

    # ---- house rule: no em dash in source text -----------------------------
    src = src.replace(
        "// can never clip into a wall \u2014 the standard FPS \"viewmodel pass\".",
        "// can never clip into a wall, the standard FPS \"viewmodel pass\".",
    )
    src = replace_once(
        src,
        "    // image, so it goes last \u2014 after the final pass has written sRGB.",
        "    // image, so it goes last, after the final pass has written sRGB.",
        "smaa comment em dash",
    )
    if "\u2014" in src or "\u2013" in src:
        sys.exit("FAIL: an em dash or en dash survived in post.js")

    # ---- guards ------------------------------------------------------------
    if src.count("1.055 * pow") != 1:
        sys.exit("FAIL: post.js must contain exactly one sRGB encode")
    if "${agxGlsl()}" not in src:
        sys.exit("FAIL: the generated agx block was not injected")
    if "vec3 agxContrast" in src:
        sys.exit("FAIL: the hand-written agx block is still present")

    path.write_text(src, encoding="utf-8")
    print(f"post.js: {before} -> {len(src)} bytes")


TESTS = '''
// ---- tone mapping --------------------------------------------------------
// A fragment shader cannot be run from node, so the transform is defined as
// numbers in src/render/tonemap.js and the shader is generated from them.
// These tests are the only thing standing between the game and another
// picture nobody looked at.

test('the tone map lands mid grey where mid grey belongs', () => {
  // 0.18 linear is the photographic mid grey. It must display near 0.5.
  // Before the double-encode fix it displayed at 0.738, which is what made
  // the whole image look washed out.
  const [r, g, b] = displayValue(0.18);
  for (const v of [r, g, b]) {
    assert.ok(Math.abs(v - 0.5) < 0.03, `mid grey displayed at ${v.toFixed(3)}`);
  }
});

test('shadows stay dark', () => {
  // 0.5% linear is a deep shadow. sRGB alone would put it at 0.059; AgX pulls
  // it a little further down. It must not sit anywhere near the 0.269 the
  // double encode produced.
  const [, g] = displayValue(0.005);
  assert.ok(g < 0.08, `deep shadow displayed at ${g.toFixed(3)}`);
});

test('black is black and the range is actually used', () => {
  const black = displayValue(0.0);
  for (const v of black) assert.equal(v, 0, 'black must stay black');
  const bright = displayValue(8.0)[1];
  const dark = displayValue(0.005)[1];
  // The spread across the visible range was 0.718 when encoded twice.
  assert.ok(bright - dark > 0.88, `spread of only ${(bright - dark).toFixed(3)}`);
});

test('the tone map is monotonic across the latitude it claims', () => {
  // AgX clamps the log-encoded signal to [MIN_EV, MAX_EV] by design, so it is
  // flat outside that window. Strictly increasing is only meaningful inside.
  let prev = -1;
  for (let ev = MIN_EV + 0.25; ev <= MAX_EV - 0.25; ev += 0.25) {
    const v = displayValue(2 ** ev)[1];
    assert.ok(v > prev, `not monotonic at ${ev.toFixed(2)} EV: ${v} after ${prev}`);
    prev = v;
  }
  assert.ok(prev <= 1, 'the transform must not exceed the display range');
  // And above the shoulder it holds, rather than climbing or breaking down.
  const shoulder = displayValue(2 ** (MAX_EV + 2))[1];
  assert.ok(Math.abs(displayValue(2 ** (MAX_EV + 8))[1] - shoulder) < 1e-9,
    'the highlight shoulder must clamp, not keep climbing');
});

test('agx hands back linear light, not display-referred light', () => {
  // The bug in one assertion: if agx() returned display-referred values, its
  // output for 0.18 linear would already be near 0.5. It must be near the
  // linear value that ENCODES to 0.5, which is about 0.21.
  const g = agxJs([0.18, 0.18, 0.18])[1];
  assert.ok(g < 0.30, `agx() returned ${g.toFixed(3)}, which looks encoded`);
  assert.ok(Math.abs(encodeSrgb(g) - 0.5) < 0.03, 'and it must encode to mid grey');
});

test('the generated shader carries the same numbers as the JS reference', () => {
  const glsl = agxGlsl();
  assert.ok(glsl.includes(`vec3(${OUTPUT_GAMMA.toFixed(1)})`), 'output gamma missing');
  assert.ok(glsl.includes(String(AGX_IN[0])), 'inset matrix missing');
  assert.ok(glsl.includes(String(AGX_OUT[0])), 'outset matrix missing');
  assert.ok(glsl.includes(String(AGX_CONTRAST[0])), 'sigmoid missing');
  assert.equal((glsl.match(/1\\.055/g) || []).length, 0, 'agx must not encode sRGB itself');
});
'''


def patch_tests():
    path = ROOT / "tests" / "logic.test.mjs"
    src = path.read_text(encoding="utf-8")
    before = len(src)

    src = replace_once(
        src,
        "import { Trigger } from '../src/core/trigger.js';\n",
        "import { Trigger } from '../src/core/trigger.js';\n"
        "import {\n"
        "  agxJs, displayValue, encodeSrgb, agxGlsl,\n"
        "  AGX_IN, AGX_OUT, AGX_CONTRAST, OUTPUT_GAMMA, MIN_EV, MAX_EV,\n"
        "} from '../src/render/tonemap.js';\n",
        "tonemap import",
    )

    if "the tone map lands mid grey" in src:
        sys.exit("FAIL: tone map tests are already present")
    src = src.rstrip("\n") + "\n" + TESTS

    path.write_text(src, encoding="utf-8")
    print(f"logic.test.mjs: {before} -> {len(src)} bytes")


def main():
    tonemap = ROOT / "src" / "render" / "tonemap.js"
    if not tonemap.is_file():
        sys.exit("FAIL: src/render/tonemap.js must be pushed before this runs")
    patch_post()
    patch_tests()
    print("ok")


main()
