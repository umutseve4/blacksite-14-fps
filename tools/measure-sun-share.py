#!/usr/bin/env python3
"""Separate a broken shadow map from a sun that barely lights anything.

The tightened probe reported that hiding a 6 m mast brightens the ground it
shades by 6 percent. Two very different faults produce that number. Either the
shadow map is not darkening the ground, or the shadow is landing correctly and
the sun it blocks was only ever worth 6 percent of the light on that sand.

So the probe now takes a third sample at the same point, with the caster gone
and the sun turned down to zero. That reading is the ceiling: it is exactly how
dark a perfect shadow could ever make this patch. The efficiency it reports,
(clear - occluded) / (clear - noSun), is the fraction of the sun's own
contribution that the shadow actually removes. Near 1 means the shadow map is
doing its job and the light rig is unbalanced. Near 0 means the shadow is not
arriving.

Turning a light down is a uniform change, not a material change, so this costs
one more render and no shader recompile.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        sys.exit(f"FAIL [{label}]: expected exactly 1 occurrence, found {n}")
    return text.replace(old, new)


def patch_main():
    path = ROOT / "src" / "main.js"
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "    let occluded = 0;\n"
        "    let clear = 0;\n"
        "    let mirror = 0;\n",
        "    let occluded = 0;\n"
        "    let clear = 0;\n"
        "    let mirror = 0;\n"
        "    let noSun = 0;\n",
        "declare noSun",
    )

    src = replace_once(
        src,
        "      occluded = sample(dark);\n"
        "      mirror = sample(lit);\n",
        "      // The floor of the measurement: this same patch, caster gone, sun at\n"
        "      // zero. No shadow can ever be darker than that, so the distance from\n"
        "      // clear to noSun is the whole prize and occluded says how much of it\n"
        "      // the shadow map collects.\n"
        "      const sunLight = this.skyRig.sun;\n"
        "      const sunAt = sunLight.intensity;\n"
        "      caster.visible = false;\n"
        "      sunLight.intensity = 0;\n"
        "      noSun = sample(dark);\n"
        "      sunLight.intensity = sunAt;\n"
        "      caster.visible = true;\n"
        "      occluded = sample(dark);\n"
        "      mirror = sample(lit);\n",
        "sample with the sun off",
    )

    src = replace_once(
        src,
        "      mirror: Number(mirror.toFixed(4)),\n"
        "      mirrorRatio: Number((occluded / Math.max(1e-6, mirror)).toFixed(4)),\n",
        "      mirror: Number(mirror.toFixed(4)),\n"
        "      mirrorRatio: Number((occluded / Math.max(1e-6, mirror)).toFixed(4)),\n"
        "      noSun: Number(noSun.toFixed(4)),\n"
        "      sunShare: Number(((clear - noSun) / Math.max(1e-6, clear)).toFixed(4)),\n"
        "      efficiency: Number(((clear - occluded) / Math.max(1e-6, clear - noSun)).toFixed(4)),\n",
        "report the sun share",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


def patch_smoke():
    path = ROOT / "tests" / "smoke.mjs"
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "  check(\n"
        "    'the shaded patch is darker than the matching patch on the sun side',\n",
        "  check(\n"
        "    'the shadow removes most of the sunlight it stands in front of',\n"
        "    probe.ok && probe.efficiency > 0.7,\n"
        "    probe.ok\n"
        "      ? `sun is ${(probe.sunShare * 100).toFixed(1)}% of the light here, shadow removes ${(probe.efficiency * 100).toFixed(1)}% of it (noSun ${probe.noSun})`\n"
        "      : 'probe did not run'\n"
        "  );\n"
        "  check(\n"
        "    'the shaded patch is darker than the matching patch on the sun side',\n",
        "efficiency check",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


def main():
    patch_main()
    patch_smoke()
    print("sun share measured")


if __name__ == "__main__":
    main()
