#!/usr/bin/env python3
"""Add a check that looks at a shadow instead of at a flag.

Every existing check around lighting is a count or a boolean: shadowMap
enabled, castShadow set, a frustum sized, a map allocated. All of those can be
true while the sand stays flat and shadowless, which is exactly what the game
looks like in a screenshot from a real browser.

Game.shadowProbe() renders two small top-down views of the same flat ground,
lit by the same sun, textured with the same material: one patch where a chosen
prop's shadow has to land, and the mirror patch the same distance on the sun
side of that prop, where it cannot. Every other object is hidden for the
duration, so the only difference between the two samples is occlusion by that
one prop. The ratio between them is a direct reading of the shadow map.

The samples are written to an sRGB render target on purpose. A linear target
would clip bright sand at 1.0 and flatten the very difference the probe exists
to measure.

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


PROBE = '''
  /**
   * Measures whether the sun's shadow map actually darkens the ground.
   *
   * Nothing in this repository had ever looked at a shadow. Every check was a
   * count or a state flag, so the scene could ship with the shadow map on, the
   * casters flagged and the frustum centred, and still put nothing on the sand
   * while every job stayed green.
   *
   * The probe picks a prop, renders the patch of ground its shadow must fall
   * on, then renders the mirror patch the same distance on the sun side, which
   * that prop cannot reach. Same ground, same material, same light, same
   * camera: the only difference is occlusion. Every other object is hidden for
   * the duration so a second caster cannot darken the control sample.
   *
   * Samples are read from an sRGB target. A linear one clips bright sand at
   * 1.0 and hides the difference this exists to measure.
   */
  shadowProbe(size = 32) {
    const renderer = this.renderer;
    const dir = this.skyRig.sunDir;
    const horiz = new THREE.Vector3(dir.x, 0, dir.z);
    const horizLen = horiz.length();
    if (horizLen < 1e-3 || dir.y < 1e-3) {
      return { ok: false, reason: 'the sun is straight overhead, no shadow to sample' };
    }
    horiz.divideScalar(horizLen);
    const perLength = horizLen / dir.y;

    // Pick a caster whose shadow is long enough to clear its own footprint and
    // wide enough to cover the sample window. A long wall fails the first test
    // and a thin mast fails the second, so neither can produce a bogus reading.
    let caster = null;
    let casterBox = null;
    let casterReach = 0;
    let best = -Infinity;
    for (const m of this.world.shadowCasters) {
      const b = new THREE.Box3().setFromObject(m);
      if (!Number.isFinite(b.min.y) || !Number.isFinite(b.max.y)) continue;
      const mid = (b.min.y + b.max.y) * 0.5;
      const reach = mid * perLength;
      const hx = (b.max.x - b.min.x) * 0.5;
      const hz = (b.max.z - b.min.z) * 0.5;
      const along = Math.abs(horiz.x) * hx + Math.abs(horiz.z) * hz;
      const across = Math.abs(horiz.z) * hx + Math.abs(horiz.x) * hz;
      if (reach - along < 1.0) continue;
      if (across < 0.5) continue;
      const score = (reach - along) + (b.max.y - b.min.y);
      if (score > best) {
        best = score;
        caster = m;
        casterBox = b;
        casterReach = reach;
      }
    }
    if (!caster) return { ok: false, reason: 'no prop casts a shadow clear of its own footprint' };

    const mid = new THREE.Vector3();
    casterBox.getCenter(mid);
    const dark = new THREE.Vector3(mid.x - horiz.x * casterReach, 0, mid.z - horiz.z * casterReach);
    const lit = new THREE.Vector3(mid.x + horiz.x * casterReach, 0, mid.z + horiz.z * casterReach);

    const hidden = [];
    const keep = new Set([this.world.group, this.skyRig.sky]);
    for (const o of this.scene.children) {
      if (keep.has(o) || o.isLight) continue;
      if (o.visible) { o.visible = false; hidden.push(o); }
    }
    for (const o of this.world.group.children) {
      if (o === caster || o.name === 'ground' || o.name === 'apron') continue;
      if (o.visible) { o.visible = false; hidden.push(o); }
    }

    // The probe renders straight to a target, bypassing the tone map pass, so
    // sunlit sand can sit above 1.0 and clip to white. A clipped pair reads as
    // no shadow even when the shadow is there, so the light rig is dimmed by a
    // uniform factor until the open sample comes back off the ceiling. Dimming
    // every light and the environment by the same factor leaves the ratio the
    // probe reports intact; it only moves both samples into range.
    const lights = [];
    this.scene.traverse((o) => { if (o.isLight) lights.push([o, o.intensity]); });
    const envWas = this.scene.environmentIntensity;
    const setExposure = (k) => {
      for (const [l, i] of lights) l.intensity = i * k;
      this.scene.environmentIntensity = envWas * k;
    };

    const half = 0.15;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.05, 30);
    cam.up.set(0, 0, -1);
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    const buf = new Uint8Array(size * size * 4);
    const previous = renderer.getRenderTarget();

    const sample = (p) => {
      cam.position.set(p.x, 6, p.z);
      cam.lookAt(p.x, 0, p.z);
      cam.updateMatrixWorld(true);
      renderer.setRenderTarget(rt);
      renderer.render(this.scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) {
        sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      }
      return sum / (size * size) / 255;
    };

    let shadowed = 0;
    let open = 0;
    let exposure = 1;
    try {
      this.skyRig.update([mid.x, 0, mid.z]);
      for (const k of [1, 0.5, 0.25, 0.125, 0.0625]) {
        exposure = k;
        setExposure(k);
        open = sample(lit);
        if (open < 0.97) break;
      }
      shadowed = sample(dark);
    } finally {
      setExposure(1);
      renderer.setRenderTarget(previous);
      for (const o of hidden) o.visible = true;
      rt.dispose();
      this.skyRig.update(this.pos);
    }

    return {
      ok: true,
      caster: caster.userData.tag || caster.name || 'prop',
      height: Number((casterBox.max.y - casterBox.min.y).toFixed(2)),
      reach: Number(casterReach.toFixed(2)),
      exposure,
      saturated: open >= 0.97,
      shadowed: Number(shadowed.toFixed(4)),
      lit: Number(open.toFixed(4)),
      ratio: Number((shadowed / Math.max(1e-6, open)).toFixed(4)),
    };
  }
'''


def patch_world():
    path = ROOT / "src" / "render" / "world.js"
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "  apron.rotation.x = -Math.PI / 2;\n"
        "  apron.position.y = 0.012;\n"
        "  apron.receiveShadow = true;\n",
        "  apron.rotation.x = -Math.PI / 2;\n"
        "  apron.position.y = 0.012;\n"
        "  apron.receiveShadow = true;\n"
        "  apron.name = 'apron';\n",
        "name the apron",
    )

    src = replace_once(
        src,
        "/** Assembles the whole compound. Returns { group, shadowCasters }. */",
        "/**\n"
        " * Assembles the whole compound. The two ground meshes are named and returned\n"
        " * because the shadow probe has to tell a receiver from a caster, and a check\n"
        " * that hunts for its subject by index breaks the first time a prop is added.\n"
        " */",
        "buildWorld doc",
    )

    src = replace_once(
        src,
        "  return { group, shadowCasters, byProp };",
        "  return { group, ground, apron, shadowCasters, byProp };",
        "return ground and apron",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


def patch_main():
    path = ROOT / "src" / "main.js"
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "  render() {\n"
        "    this.post.composer.render();\n"
        "  }\n",
        "  render() {\n"
        "    this.post.composer.render();\n"
        "  }\n"
        + PROBE,
        "insert shadowProbe",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


SMOKE = '''
  // 11. Shadows reach the ground. Every other statement this project makes
  // about the sun is a flag; this one is a measurement. The probe renders the
  // patch of ground a prop's shadow must land on and the mirror patch on the
  // sun side, and reports both.
  const sunState = await page.evaluate(() => {
    const g = window.__game;
    const sun = g.skyRig.sun;
    return {
      enabled: g.renderer.shadowMap.enabled,
      castShadow: sun.castShadow,
      mapSize: sun.shadow.map ? sun.shadow.map.width : 0,
      extent: sun.shadow.camera.right,
    };
  });
  console.log(`# sun ${JSON.stringify(sunState)}`);
  check(
    'the sun is set up to cast shadows',
    sunState.enabled && sunState.castShadow,
    `enabled=${sunState.enabled} castShadow=${sunState.castShadow}`
  );
  check(
    'the sun allocated a shadow map',
    sunState.mapSize >= 1024,
    `${sunState.mapSize}px over a ${sunState.extent * 2} m frustum`
  );

  const probe = await page.evaluate(() => window.__game.shadowProbe());
  console.log(`# shadow probe ${JSON.stringify(probe)}`);
  check('the shadow probe found a usable caster', probe.ok, probe.reason || '');
  check(
    'the open sample is not clipped, so the comparison means something',
    probe.ok && !probe.saturated,
    probe.ok ? `lit ${probe.lit} at exposure ${probe.exposure}` : 'probe did not run'
  );
  check(
    'a prop casts a shadow onto the ground',
    probe.ok && probe.ratio < 0.9,
    probe.ok
      ? `${probe.caster} ${probe.height} m tall: shadowed ${probe.shadowed} vs lit ${probe.lit}, ratio ${probe.ratio}`
      : 'probe did not run'
  );
'''


def patch_smoke():
    path = ROOT / "tests" / "smoke.mjs"
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "  // 10. No console errors anywhere in that run.",
        SMOKE.lstrip("\n") + "\n  // 10. No console errors anywhere in that run.",
        "insert shadow checks",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


def main():
    patch_world()
    patch_main()
    patch_smoke()
    print("shadow probe added")


if __name__ == "__main__":
    main()
