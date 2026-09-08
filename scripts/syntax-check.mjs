// Parses every source file without executing it. Catches syntax errors in the
// render modules, which cannot be imported in Node because they need WebGL.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = (await walk(root)).sort();
let bad = 0;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
    console.log(`ok   ${f.slice(root.length + 1)}`);
  } catch (err) {
    bad++;
    console.error(`FAIL ${f.slice(root.length + 1)}: ${err.message}`);
  }
}
console.log(`\n${files.length - bad}/${files.length} files parse`);
process.exit(bad ? 1 : 0);
