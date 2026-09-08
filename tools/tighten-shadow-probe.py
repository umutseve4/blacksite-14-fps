#!/usr/bin/env python3
"""Make the shadow probe compare the same square metre against itself.

The first probe compared the patch of ground a prop must shade against the
mirror patch on the sun side. It reported a ratio of 0.8656, which passed, and
that pass was worth less than it looked: the two samples were 72 m apart on
procedurally varied sand, so some of that difference was texture rather than
occlusion, and a 13 percent drop is far too small for direct sunlight.

The control is now the same square metre with the caster hidden. Same texels,
same normals, same light, same camera. The only variable left is whether that
one prop is in the way, which is exactly the question. The mirror sample is
kept as a second, independent reading rather than as the control.

The caster search also refuses anything whose shadow lands more than 12 m
away. The first run chose a tower whose box centre sits 9.3 m up, throwing its
shadow 36 m across the map, which is a much weaker statement about the ground
the player actually walks on than a crate at arm's length.

Every anchor is asserted. A file that is not what this script expects makes it
exit rather than write something half-patched.
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
        "      if (reach - along < 1.0) continue;\n"
        "      if (across < 0.5) continue;\n",
        "      if (reach - along < 1.0) continue;\n"
        "      if (across < 0.5) continue;\n"
        "      // A shadow thrown tens of metres by something high up says little\n"
        "      // about the ground the player walks on, and it drifts towards the\n"
        "      // edge of the shadow frustum where the reading gets soft.\n"
        "      if (reach > 12) continue;\n",
        "cap the reach",
    )

    src = replace_once(
        src,
        "    let shadowed = 0;\n"
        "    let open = 0;\n"
        "    let exposure = 1;\n"
        "    try {\n"
        "      this.skyRig.update([mid.x, 0, mid.z]);\n"
        "      for (const k of [1, 0.5, 0.25, 0.125, 0.0625]) {\n"
        "        exposure = k;\n"
        "        setExposure(k);\n"
        "        open = sample(lit);\n"
        "        if (open < 0.97) break;\n"
        "      }\n"
        "      shadowed = sample(dark);\n"
        "    } finally {\n"
        "      setExposure(1);\n",
        "    // The control is this same square metre with the caster taken away.\n"
        "    // Comparing two different patches of ground would fold the sand's own\n"
        "    // variation into the reading; comparing a patch against itself leaves\n"
        "    // occlusion by this one prop as the only thing that changed.\n"
        "    let occluded = 0;\n"
        "    let clear = 0;\n"
        "    let mirror = 0;\n"
        "    let exposure = 1;\n"
        "    try {\n"
        "      this.skyRig.update([mid.x, 0, mid.z]);\n"
        "      for (const k of [1, 0.5, 0.25, 0.125, 0.0625]) {\n"
        "        exposure = k;\n"
        "        setExposure(k);\n"
        "        caster.visible = false;\n"
        "        clear = sample(dark);\n"
        "        caster.visible = true;\n"
        "        if (clear < 0.97) break;\n"
        "      }\n"
        "      occluded = sample(dark);\n"
        "      mirror = sample(lit);\n"
        "    } finally {\n"
        "      caster.visible = true;\n"
        "      setExposure(1);\n",
        "same-point control",
    )

    src = replace_once(
        src,
        "      exposure,\n"
        "      saturated: open >= 0.97,\n"
        "      shadowed: Number(shadowed.toFixed(4)),\n"
        "      lit: Number(open.toFixed(4)),\n"
        "      ratio: Number((shadowed / Math.max(1e-6, open)).toFixed(4)),\n",
        "      exposure,\n"
        "      saturated: clear >= 0.97,\n"
        "      occluded: Number(occluded.toFixed(4)),\n"
        "      clear: Number(clear.toFixed(4)),\n"
        "      ratio: Number((occluded / Math.max(1e-6, clear)).toFixed(4)),\n"
        "      mirror: Number(mirror.toFixed(4)),\n"
        "      mirrorRatio: Number((occluded / Math.max(1e-6, mirror)).toFixed(4)),\n",
        "report both readings",
    )

    src = replace_once(
        src,
        "   * Samples are read from an sRGB target. A linear one clips bright sand at\n"
        "   * 1.0 and hides the difference this exists to measure.\n",
        "   * The control sample is the same patch of ground with the caster hidden,\n"
        "   * so the sand's own variation cancels out. The mirror patch on the sun\n"
        "   * side is reported too, as a second and independent reading.\n"
        "   *\n"
        "   * Samples are read from an sRGB target. A linear one clips bright sand at\n"
        "   * 1.0 and hides the difference this exists to measure.\n",
        "probe doc",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


def patch_smoke():
    path = ROOT / "tests" / "smoke.mjs"
    src = path.read_text(encoding="utf-8")

    src = replace_once(
        src,
        "  check(\n"
        "    'the open sample is not clipped, so the comparison means something',\n"
        "    probe.ok && !probe.saturated,\n"
        "    probe.ok ? `lit ${probe.lit} at exposure ${probe.exposure}` : 'probe did not run'\n"
        "  );\n"
        "  check(\n"
        "    'a prop casts a shadow onto the ground',\n"
        "    probe.ok && probe.ratio < 0.9,\n"
        "    probe.ok\n"
        "      ? `${probe.caster} ${probe.height} m tall: shadowed ${probe.shadowed} vs lit ${probe.lit}, ratio ${probe.ratio}`\n"
        "      : 'probe did not run'\n"
        "  );\n",
        "  check(\n"
        "    'the control sample is not clipped, so the comparison means something',\n"
        "    probe.ok && !probe.saturated,\n"
        "    probe.ok ? `clear ${probe.clear} at exposure ${probe.exposure}` : 'probe did not run'\n"
        "  );\n"
        "  check(\n"
        "    'taking the prop away brightens the ground it was shading',\n"
        "    probe.ok && probe.ratio < 0.9,\n"
        "    probe.ok\n"
        "      ? `${probe.caster} ${probe.height} m tall, shadow ${probe.reach} m out: occluded ${probe.occluded} vs clear ${probe.clear}, ratio ${probe.ratio}`\n"
        "      : 'probe did not run'\n"
        "  );\n"
        "  check(\n"
        "    'the shaded patch is darker than the matching patch on the sun side',\n"
        "    probe.ok && probe.mirrorRatio < 0.95,\n"
        "    probe.ok\n"
        "      ? `occluded ${probe.occluded} vs mirror ${probe.mirror}, ratio ${probe.mirrorRatio}`\n"
        "      : 'probe did not run'\n"
        "  );\n",
        "same-point checks",
    )

    path.write_text(src, encoding="utf-8")
    print(f"patched {path.relative_to(ROOT)}")


def main():
    patch_main()
    patch_smoke()
    print("shadow probe tightened")


if __name__ == "__main__":
    main()
