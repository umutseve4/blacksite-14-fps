// One-shot applier. Makes two exact replacements, then gets deleted.
//
// Why this exists: src/main.js is 36 KB. Rewriting a file that size through
// the contents API means retyping every byte, and a single silent
// transcription slip would land in a file the whole game boots from. Naming
// the exact text to replace is verifiable in a way that retyping is not.
//
// Contract: every replacement must match exactly once. Zero matches means the
// file moved on and the patch is stale; two matches means the anchor is
// ambiguous. Both exit non-zero and write nothing.

import { readFile, writeFile } from 'node:fs/promises';

const edits = [
  {
    file: 'src/render/world.js',
    find: '    mesh.userData.tag = p.tag || p.mat;\n',
    replace:
      '    mesh.userData.tag = p.tag || p.mat;\n' +
      '    // Only a box prop fills its own bounding box. A mast is a 0.12 m pole\n' +
      '    // with 0.9 m cross-arms: its box is mostly air, so its shadow is far\n' +
      '    // thinner than the box implies. The shadow probe needs that difference.\n' +
      '    mesh.userData.solidBox = p.kind === \'box\';\n',
  },
  {
    file: 'src/main.js',
    find: '      if (reach - along < 1.0) continue;\n      if (across < 0.5) continue;\n',
    replace:
      '      // The box has to be filled, not merely large. A mast passes every\n' +
      '      // size test below on the strength of its cross-arms, while the part\n' +
      '      // that actually blocks the sun is a 0.12 m pole. Half the sample\n' +
      '      // window then lands outside the shadow and the probe reports a weak\n' +
      '      // shadow that is really a badly chosen occluder.\n' +
      '      if (!m.userData.solidBox) continue;\n' +
      '      if (reach - along < 1.0) continue;\n' +
      '      if (across < 0.5) continue;\n',
  },
];

let failed = false;

for (const { file, find, replace } of edits) {
  const before = await readFile(file, 'utf8');
  const hits = before.split(find).length - 1;
  if (hits !== 1) {
    console.error(`FAIL ${file}: anchor matched ${hits} times, expected exactly 1`);
    failed = true;
    continue;
  }
  if (before.includes(replace)) {
    console.log(`skip ${file}: already applied`);
    continue;
  }
  await writeFile(file, before.replace(find, replace));
  console.log(`ok   ${file}: applied`);
}

if (failed) process.exit(1);

// The runner watches this path. This file landed one commit before the runner,
// so nothing was listening the first time and it is re-pushed here.
