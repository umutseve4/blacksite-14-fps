// Real-browser smoke test. Boots the game in headless Chromium, deploys, runs
// the loop, and fires a shot.
//
// It deliberately asserts on PROGRESS, never on frame rate: CI renders through
// SwiftShader on a CPU, so any fps threshold would only measure the runner.
// Every wait below is "advance n frames, up to a generous ceiling", so a slow
// runner takes longer and still passes, while a stalled loop fails.
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

// Wait until the loop has actually advanced n frames. A fixed sleep would turn
// every later check into a frame-rate assertion, and SwiftShader on a shared CI
// core can spend seconds on one frame. The measured cost is printed so a real
// performance regression is still visible to a human.
let page;
async function advanceFrames(n, timeout = 120_000) {
  const from = await page.evaluate(() => window.__game.frames);
  const t = Date.now();
  let reached = true;
  try {
    await page.waitForFunction(
      ([a, want]) => window.__game.frames - a >= want,
      [from, n],
      { timeout, polling: 100 }
    );
  } catch {
    reached = false;
  }
  const to = await page.evaluate(() => window.__game.frames);
  const ms = Date.now() - t;
  const gained = to - from;
  console.log(`# ${gained} frames in ${ms} ms (${Math.round(ms / Math.max(1, gained))} ms/frame)`);
  return { reached, from, to, gained, ms };
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
page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// Anything that leaves the machine is a dependency the game claims not to have,
// so every escaping request is recorded and asserted on at the end.
const escaped = [];
if (existsSync(vendor)) {
  await page.route(`${CDN}**`, async (route) => {
    const url = route.request().url();
    const rel = url.slice(CDN.length);
    try {
      const body = await readFile(join(vendor, rel));
      await route.fulfill({ body, contentType: 'text/javascript; charset=utf-8' });
    } catch {
      escaped.push(url);
      await route.continue();
    }
  });
  console.log('# serving three from node_modules');
}
const failedRequests = [];
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText || ''}`));

let exitCode = 0;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

  // 1. It boots at all. The 180 s ceiling is a job-kill limit, not a target:
  // the real number is printed so a regression in load time is visible.
  const t0 = Date.now();
  await page.waitForSelector('#loading.done', { timeout: 180_000 });
  const bootMs = Date.now() - t0;
  const bootError = await page.evaluate(() => window.__bootError || null);
  check('boots without throwing', !bootError, bootError || `${(bootMs / 1000).toFixed(1)}s`);
  console.log(`# boot took ${bootMs} ms under SwiftShader`);

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
  await page.waitForFunction(() => window.__game.state === 'play', null, { timeout: 60_000 });
  const run = await advanceFrames(5);
  const f1 = run.to;
  check('render loop advances', run.gained >= 5, `${run.gained} frames in ${run.ms} ms`);

  // renderer.info is reset once per frame by the loop, so these counters cover a
  // whole frame including every post pass, not just the last fullscreen quad.
  // The highest of several completed frames is taken: a sample can otherwise
  // land halfway through the frame that is being drawn right now.
  const calls = await page.evaluate(async () => {
    const g = window.__game;
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      peak = Math.max(peak, g.renderer.info.render.calls);
    }
    return peak;
  });
  check('the GPU is actually drawing', calls > 10, `${calls} draw calls in one frame`);

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

  // 5. The mouse is captured \u2014 without this the whole input path is dead.
  const locked = await page.evaluate(() => document.pointerLockElement === window.__game.canvas);
  check('pointer lock engages', locked, locked ? '' : 'canvas never captured the mouse');

  // 6. Shooting works end to end: ammo drops, tracers/decals appear.
  const mag = () => page.evaluate(() => window.__game.ammo[window.__game.weaponKey].mag);
  const before = await mag();
  const shots0 = await page.evaluate(() => window.__game.stats.shots);
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await advanceFrames(3);
  await page.mouse.up();
  await advanceFrames(2);
  const after = await mag();
  check('firing consumes ammunition', after < before, `${before} -> ${after} rounds`);

  const spent = (await page.evaluate(() => window.__game.stats.shots)) - shots0;
  check('the fire clock produced shots', spent > 0, `${spent} shots`);
  // Every round that left the magazine has to be a round the fire clock counted.
  // This is what catches a "fix" that drains ammo without ever shooting.
  check('ammunition and the shot counter agree', before - after === spent, `${before - after} rounds vs ${spent} shots`);

  // 7. Reloading refills.
  await page.keyboard.press('KeyR');
  try {
    await page.waitForFunction(
      (floor) => window.__game.ammo[window.__game.weaponKey].mag > floor,
      after,
      { timeout: 120_000, polling: 100 }
    );
  } catch { /* reported by the check below */ }
  const reloaded = await mag();
  check('reload refills the magazine', reloaded > after, `${after} -> ${reloaded} rounds`);

  // 8. Weapon switching does not break the loop.
  await page.keyboard.press('Digit2');
  await advanceFrames(2);
  const swapped = await page.evaluate(() => ({
    id: window.__game.weapon.id,
    frames: window.__game.frames
  }));
  check('weapon switching works', swapped.id !== built.weapon, `${built.weapon} -> ${swapped.id}`);
  check('loop survives the switch', swapped.frames > f1, `${swapped.frames} frames`);

  // 9. Resizing must not throw.
  await page.setViewportSize({ width: 900, height: 1200 });
  await advanceFrames(2);
  await page.setViewportSize({ width: 1280, height: 720 });
  await advanceFrames(2);
  const alive = await page.evaluate(() => window.__game.frames);
  check('survives a resize', alive > swapped.frames, `${alive} frames`);

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

  // 10. No console errors anywhere in that run. Only the favicon is forgiven,
  // and only by exact URL: a broad filter would swallow a missing module.
  const real = consoleErrors.filter((t) => !t.includes('/favicon.ico'));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));

  const badRequests = failedRequests.filter((t) => !t.includes('/favicon.ico'));
  check('nothing failed to load', badRequests.length === 0, badRequests.slice(0, 3).join(' | '));
  check('nothing reached the network', escaped.length === 0, escaped.slice(0, 3).join(' | '));

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
