// Real-browser smoke test. Boots the game in headless Chromium, deploys, runs
// the loop, and fires a shot.
//
// It deliberately asserts on PROGRESS, never on frame rate: CI renders through
// SwiftShader on a CPU, so any fps threshold would only measure the runner.
//
// Three.js is served from node_modules so the test never depends on a CDN.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../scripts/serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.169.0/';
const vendor = join(root, 'node_modules', 'three');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
}

const server = await serve(PORT);
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-lcd-text'
  ]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

if (existsSync(vendor)) {
  await page.route(`${CDN}**`, async (route) => {
    const rel = route.request().url().slice(CDN.length);
    try {
      const body = await readFile(join(vendor, rel));
      await route.fulfill({ body, contentType: 'text/javascript; charset=utf-8' });
    } catch {
      await route.continue();
    }
  });
  console.log('# serving three from node_modules');
}

let exitCode = 0;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

  // 1. It boots at all.
  await page.waitForSelector('#loading.done', { timeout: 180_000 });
  const bootError = await page.evaluate(() => window.__bootError || null);
  check('boots without throwing', !bootError, bootError || '');

  // 2. The whole world really is generated, not stubbed.
  const built = await page.evaluate(() => {
    const g = window.__game;
    return {
      quality: g.q?.label,
      mats: Object.keys(g.lib?.materials || {}).length,
      meshes: g.scene.children.length,
      bots: g.enemies.bots.length,
      boxes: g.boxes.length,
      weapon: g.weapon?.id,
      drawCalls: g.renderer.info.render.calls
    };
  });
  console.log(`# ${JSON.stringify(built)}`);
  check('materials were generated', built.mats >= 4, `${built.mats} materials`);
  check('collision world was built', built.boxes > 40, `${built.boxes} boxes`);
  check('enemies spawned', built.bots > 0, `${built.bots} bots`);

  // 3. It renders continuously after deploying.
  await page.click('#start');
  await page.waitForTimeout(300);
  const f0 = await page.evaluate(() => window.__game.frames);
  await page.waitForTimeout(4000);
  const f1 = await page.evaluate(() => window.__game.frames);
  check('render loop advances', f1 - f0 >= 5, `${f1 - f0} frames in 4s`);

  const calls = await page.evaluate(() => window.__game.renderer.info.render.calls);
  check('the GPU is actually drawing', calls > 10, `${calls} draw calls`);

  // 4. Gameplay state advances: time moves, the player is inside the arena.
  const sim = await page.evaluate(() => {
    const g = window.__game;
    return { state: g.state, time: g.time, pos: g.pos.slice ? g.pos.slice() : [...g.pos], hp: g.hp };
  });
  check('simulation is running', sim.state === 'play' && sim.time > 0.5, `t=${sim.time.toFixed(2)}s`);
  check(
    'player stays inside the arena',
    Math.abs(sim.pos[0]) < 120 && Math.abs(sim.pos[2]) < 120 && sim.pos[1] > -5,
    `pos=${sim.pos.map((n) => n.toFixed(1)).join(',')}`
  );

  // 5. The mouse is captured — without this the whole input path is dead.
  const locked = await page.evaluate(() => document.pointerLockElement === window.__game.canvas);
  check('pointer lock engages', locked, locked ? '' : 'canvas never captured the mouse');

  // 6. Shooting works end to end: ammo drops, tracers/decals appear.
  const mag = () => page.evaluate(() => window.__game.ammo[window.__game.weaponKey].mag);
  const before = await mag();
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await mag();
  check('firing consumes ammunition', after < before, `${before} -> ${after} rounds`);

  const spent = await page.evaluate(() => window.__game.stats.shots);
  check('the fire clock produced shots', spent > 0, `${spent} shots`);

  // 7. Reloading refills.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(2600);
  const reloaded = await mag();
  check('reload refills the magazine', reloaded > after, `${after} -> ${reloaded} rounds`);

  // 8. Weapon switching does not break the loop.
  await page.keyboard.press('Digit2');
  await page.waitForTimeout(600);
  const swapped = await page.evaluate(() => ({
    id: window.__game.weapon.id,
    frames: window.__game.frames
  }));
  check('weapon switching works', swapped.id !== built.weapon, `${built.weapon} -> ${swapped.id}`);
  check('loop survives the switch', swapped.frames > f1, `${swapped.frames} frames`);

  // 9. Resizing must not throw.
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(600);
  const alive = await page.evaluate(() => window.__game.frames);
  check('survives a resize', alive > swapped.frames, `${alive} frames`);

  // 10. No console errors anywhere in that run.
  const real = consoleErrors.filter((t) => !/Failed to load resource|favicon|pointer lock/i.test(t));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));

  await mkdir(join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: join(root, 'artifacts', 'smoke.png') });
  console.log('# screenshot -> artifacts/smoke.png');
} catch (err) {
  check('smoke run completed', false, err.message);
} finally {
  await browser.close();
  server.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} browser checks passed`);
if (failed.length) exitCode = 1;
process.exit(exitCode);
