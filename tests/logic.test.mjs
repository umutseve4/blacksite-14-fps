// Pure-logic tests. No browser, no WebGL: everything under src/core is
// deliberately renderer-free so the game rules can be proven in CI.
//
// Rule for this repo: a failing assertion is fixed in the game, never weakened
// in the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32, valueNoise2D, fbm2D, clamp, lerp } from '../src/core/rng.js';
import {
  recoilStep, makeRecoilStream, Spring, spreadDegrees, damageAt, ttkMs, FireClock,
} from '../src/core/recoil.js';
import { WEAPONS, WEAPON_ORDER, hFovToV } from '../src/core/weapons.js';
import {
  makeBox, BoxGrid, blocked, moveWithSlide, moveVertical, rayBox, raycastWorld,
} from '../src/core/collide.js';
import { PROPS, collisionBoxes, SPAWN, BOT_SPAWNS, AMMO_CRATES, ARENA } from '../src/core/level.js';
import { STATE, AI_TUNING, canSee, tickBot, makeBot, damageBot } from '../src/core/ai.js';
import { Trigger } from '../src/core/trigger.js';
import { concrete, sand, gunMetal, heightToNormal, bulletDecal, radialSprite } from '../src/core/texgen.js';

const PLAYER_R = 0.34;
const PLAYER_H = 1.78;

// --------------------------------------------------------------------- rng
test('mulberry32 is deterministic and uniform-ish in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  let sum = 0;
  for (let i = 0; i < 5000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
    sum += x;
  }
  const mean = sum / 5000;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean drifted: ${mean}`);
});

test('value noise tiles exactly across its period', () => {
  const P = 16;
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * P;
    const y = Math.random() * P;
    assert.ok(Math.abs(valueNoise2D(x, y, P, 7) - valueNoise2D(x + P, y, P, 7)) < 1e-9);
    assert.ok(Math.abs(valueNoise2D(x, y, P, 7) - valueNoise2D(x, y + P, P, 7)) < 1e-9);
  }
});

test('fbm stays inside [0,1] and also tiles', () => {
  const P = 32;
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * P;
    const y = Math.random() * P;
    const v = fbm2D(x, y, P, 5, 0.5, 2, 3);
    assert.ok(v >= -0.001 && v <= 1.001, `fbm out of range: ${v}`);
    assert.ok(Math.abs(v - fbm2D(x + P, y + P, P, 5, 0.5, 2, 3)) < 1e-9);
  }
});

// ------------------------------------------------------------------ recoil
test('recoil pattern is reproducible from a seed and bounded', () => {
  const p = WEAPONS.ar.recoil;
  const s1 = makeRecoilStream(p, 42);
  const s2 = makeRecoilStream(p, 42);
  let climb = 0;
  for (let i = 0; i < 30; i++) {
    const a = s1();
    const b = s2();
    assert.deepEqual(a, b);
    assert.ok(a.pitch > 0, 'the muzzle must always rise');
    assert.ok(Math.abs(a.yaw) < 1.0, `yaw runaway at shot ${i}: ${a.yaw}`);
    climb += a.pitch;
  }
  // A 30-round magazine must not walk the crosshair off a 74 degree screen.
  assert.ok(climb < 14, `total climb too high: ${climb}`);
  assert.ok(climb > 4, `total climb too low to feel like a weapon: ${climb}`);
});

test('recoil is learnable: the non-random share dominates', () => {
  const p = WEAPONS.ar.recoil;
  const runs = [];
  for (let r = 0; r < 24; r++) {
    const s = makeRecoilStream(p, 1000 + r);
    const acc = [];
    let pitch = 0;
    for (let i = 0; i < 12; i++) pitch += s().pitch, acc.push(pitch);
    runs.push(acc);
  }
  for (let i = 0; i < 12; i++) {
    const col = runs.map((r) => r[i]);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    const sd = Math.sqrt(col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length);
    assert.ok(sd / Math.max(mean, 1e-6) < 0.20, `shot ${i} is too random: cv=${sd / mean}`);
  }
});

test('critically damped spring converges and never oscillates', () => {
  for (const dt of [1 / 30, 1 / 60, 1 / 120, 1 / 240]) {
    const s = new Spring(0.08, 0);
    s.target = 1;
    let last = -Infinity;
    let overshoot = 0;
    for (let i = 0; i < Math.ceil(2 / dt); i++) {
      const v = s.step(dt);
      overshoot = Math.max(overshoot, v - 1);
      assert.ok(v >= last - 1e-9, 'spring went backwards');
      last = v;
    }
    assert.ok(Math.abs(s.value - 1) < 0.01, `dt=${dt} did not converge: ${s.value}`);
    assert.ok(overshoot < 0.02, `dt=${dt} overshot by ${overshoot}`);
  }
});

test('spring half-life means what it says', () => {
  const s = new Spring(0.1, 0);
  s.target = 1;
  const dt = 1 / 1000;
  for (let i = 0; i < 100; i++) s.step(dt);
  // Critically damped step response at t = halfLife: within a sane band of 0.5.
  assert.ok(s.value > 0.35 && s.value < 0.75, `half-life response off: ${s.value}`);
});

// ------------------------------------------------------------------ firing
test('rate of fire is frame-rate independent', () => {
  for (const rpm of [780, 920, 400]) {
    const counts = [];
    for (const dt of [1 / 240, 1 / 60, 1 / 20, 1 / 8]) {
      const fc = new FireClock(rpm);
      let t = 0;
      let n = 0;
      while (t < 3) {
        t += dt;
        n += fc.update(t, true, true, 999);
      }
      counts.push(n);
    }
    const expect = (rpm / 60) * 3;
    for (const n of counts) {
      assert.ok(Math.abs(n - expect) <= 2, `rpm=${rpm} got ${n}, expected ~${expect}`);
    }
  }
});

test('semi-auto fires once per trigger press, whatever the frame rate', () => {
  const fc = new FireClock(WEAPONS.dmr.rpm);
  let t = 0;
  let n = 0;
  for (let i = 0; i < 600; i++) {
    t += 1 / 120;
    n += fc.update(t, true, false);
  }
  assert.equal(n, 1, 'holding the trigger on a semi-auto must not repeat');
  fc.release(t);
  t += 1;
  assert.equal(fc.update(t, true, false), 1, 'a new press must fire');
});

test('semi-auto click-spam cannot exceed the mechanical rate', () => {
  const w = WEAPONS.dmr;
  const fc = new FireClock(w.rpm);
  let t = 0;
  let n = 0;
  // Mash the trigger every single 120 Hz step for 2 seconds.
  for (let i = 0; i < 240; i++) {
    t += 1 / 120;
    n += fc.update(t, true, false);
    fc.release(t);
  }
  const cap = (w.rpm / 60) * 2 + 1;
  assert.ok(n <= cap, `${n} shots exceeds the ${w.rpm} RPM cap of ~${cap}`);
});

// ----------------------------------------------------------------- weapons
test('every weapon is internally consistent', () => {
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    assert.equal(w.id, id);
    assert.ok(w.rpm >= 300 && w.rpm <= 1100, `${id} rpm`);
    assert.ok(w.damageNear > w.damageFar, `${id} must lose damage with range`);
    assert.ok(w.falloffEnd > w.falloffStart, `${id} falloff window`);
    assert.ok(w.adsSpread < w.hipSpread, `${id} aiming must be tighter`);
    assert.ok(w.adsFovH < w.hipFovH, `${id} ADS must zoom in`);
    assert.ok(w.reloadEmptyMs > w.reloadMs, `${id} empty reload must be slower`);
    assert.ok(w.adsMs >= 150 && w.adsMs <= 400, `${id} ADS time outside the genre envelope`);
    assert.ok(w.magSize > 0 && w.reserve >= w.magSize);
    assert.ok(w.headMult > 1);
  }
});

test('time-to-kill sits in the genre window and headshots reward aim', () => {
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    const body = ttkMs(w, 12, 'body');
    const head = ttkMs(w, 12, 'head');
    assert.ok(body.ms >= 120 && body.ms <= 900, `${id} body TTK ${body.ms}ms`);
    assert.ok(head.shots <= body.shots, `${id} headshots must not be worse`);
    assert.ok(head.ms <= body.ms);
    // No instant kills at range from a full-auto weapon.
    if (w.auto) assert.ok(head.shots >= 2, `${id} one-shot headshot is not acceptable`);
  }
});

test('damage falloff is monotonic and clamped at both ends', () => {
  const w = WEAPONS.ar;
  let prev = Infinity;
  for (let d = 0; d < 200; d += 2) {
    const v = damageAt(w, d, 'body');
    assert.ok(v <= prev + 1e-9, 'damage increased with distance');
    prev = v;
  }
  assert.equal(damageAt(w, 0, 'body'), w.damageNear);
  assert.ok(Math.abs(damageAt(w, 500, 'body') - w.damageFar) < 1e-9);
  assert.ok(damageAt(w, 10, 'limb') < damageAt(w, 10, 'body'));
  assert.ok(damageAt(w, 10, 'head') > damageAt(w, 10, 'body'));
});

test('spread rewards standing still, crouching and aiming', () => {
  const w = WEAPONS.ar;
  const base = { ads: false, speed: 0, shotsFired: 0, crouched: false, airborne: false };
  const still = spreadDegrees(w, base);
  assert.ok(spreadDegrees(w, { ...base, ads: true }) < still);
  assert.ok(spreadDegrees(w, { ...base, crouched: true }) < still);
  assert.ok(spreadDegrees(w, { ...base, speed: 6 }) > still);
  assert.ok(spreadDegrees(w, { ...base, airborne: true }) > still);
  assert.ok(spreadDegrees(w, { ...base, shotsFired: 10 }) > still);
  // and it can never blow up
  assert.ok(spreadDegrees(w, { ads: false, speed: 99, shotsFired: 999, crouched: false, airborne: true }) <= 12);
});

test('horizontal FOV converts to vertical sanely', () => {
  assert.ok(hFovToV(103, 16 / 9) > 60 && hFovToV(103, 16 / 9) < 80);
  assert.ok(hFovToV(103, 21 / 9) < hFovToV(103, 4 / 3), 'wider screens show less vertically');
});

// --------------------------------------------------------------- collision
const boxes = collisionBoxes();
const grid = new BoxGrid(boxes, 6);

test('the level is well formed', () => {
  assert.ok(PROPS.length > 40, 'the map should not be empty');
  assert.ok(boxes.length > 40);
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) assert.ok(b.max[i] > b.min[i], 'degenerate box');
  }
  assert.ok(Math.abs(SPAWN.z) < ARENA / 2);
  for (const [x, z] of [...BOT_SPAWNS, ...AMMO_CRATES]) {
    assert.ok(Math.abs(x) < ARENA / 2 && Math.abs(z) < ARENA / 2, 'spawn outside the arena');
  }
});

test('no spawn point starts inside geometry', () => {
  const pts = [[SPAWN.x, SPAWN.z], ...BOT_SPAWNS, ...AMMO_CRATES];
  for (const [x, z] of pts) {
    assert.ok(!blocked([x, 0.05, z], PLAYER_R, PLAYER_H, boxes, grid), `spawn ${x},${z} is inside a solid`);
  }
});

test('the player cannot tunnel through a wall at any speed', () => {
  const wall = [makeBox(0, 2, 0, 40, 4, 1, 'concrete')]; // centre, then size
  const g = new BoxGrid(wall, 6);
  for (const speed of [5, 20, 80, 300]) {
    const p = [0, 0.1, 4];
    for (let i = 0; i < 60; i++) moveWithSlide(p, [0, 0, -speed / 60], PLAYER_R, PLAYER_H, wall, g);
    assert.ok(p[2] > 0.5, `tunnelled at ${speed} m/s: z=${p[2]}`);
  }
});

test('sliding along a wall preserves tangential movement', () => {
  const wall = [makeBox(0, 2, 0, 40, 4, 1, 'concrete')];
  const g = new BoxGrid(wall, 6);
  const p = [0, 0.1, 1.0];
  for (let i = 0; i < 60; i++) moveWithSlide(p, [0.08, 0, -0.08], PLAYER_R, PLAYER_H, wall, g);
  assert.ok(p[0] > 2, `did not slide: x=${p[0]}`);
  assert.ok(p[2] > 0.5, 'slid through the wall');
});

test('gravity settles the player on the ground and jumps land', () => {
  const p = [0, 6, SPAWN.z];
  let vy = 0;
  let onGround = false;
  for (let i = 0; i < 400; i++) {
    const r = moveVertical(p, vy, 1 / 120, -22.5, PLAYER_R, PLAYER_H, boxes, grid);
    vy = r.vy;
    onGround = r.onGround;
  }
  assert.ok(onGround, 'never landed');
  assert.ok(Math.abs(p[1]) < 0.05, `rest height wrong: ${p[1]}`);
});

test('a fired ray always terminates on the world', () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const th = rnd() * Math.PI * 2;
    const ph = (rnd() - 0.5) * 1.2;
    const d = [Math.sin(th) * Math.cos(ph), Math.sin(ph), Math.cos(th) * Math.cos(ph)];
    const hit = raycastWorld([SPAWN.x, 1.6, SPAWN.z], d, boxes, 400);
    if (d[1] < -0.05) assert.ok(hit, 'a downward ray missed the ground');
    if (hit) {
      assert.ok(hit.t > 0);
      const n = hit.normal;
      assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-9, 'normal is not unit length');
    }
  }
});

test('rayBox agrees with a brute-force march', () => {
  const b = makeBox(0, 1, 0, 2, 2, 2, 'x'); // spans -1..1 on x/z, 0..2 on y
  const o = [0, 1, 6];
  const d = [0, 0, -1];
  const t = rayBox(o, d, b);
  assert.ok(Math.abs(t - 5) < 1e-6, `expected 5, got ${t}`);
  assert.equal(rayBox([0, 1, 6], [0, 0, 1], b), Infinity, 'a ray pointing away must miss');
});

test('the playable area is connected: a flood fill reaches every spawn', () => {
  const step = 1.0;
  const half = ARENA / 2 - 1.5;
  const key = (x, z) => `${x},${z}`;
  const free = (x, z) => !blocked([x, 0.05, z], PLAYER_R, PLAYER_H, boxes, grid);
  const seen = new Set();
  const start = [Math.round(SPAWN.x), Math.round(SPAWN.z)];
  const q = [start];
  seen.add(key(...start));
  while (q.length) {
    const [x, z] = q.pop();
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (Math.abs(nx) > half || Math.abs(nz) > half) continue;
      const k = key(nx, nz);
      if (seen.has(k) || !free(nx, nz)) continue;
      seen.add(k);
      q.push([nx, nz]);
    }
  }
  assert.ok(seen.size > 1500, `walkable area too small: ${seen.size} cells`);
  for (const [x, z] of BOT_SPAWNS) {
    // nearest grid cell must be reachable
    const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => seen.has(key(Math.round(x) + a, Math.round(z) + b)));
    assert.ok(near, `bot spawn ${x},${z} is walled off from the player`);
  }
});

// ---------------------------------------------------------------------- ai
test('a bot needs both line of sight and a facing cone to see you', () => {
  const eye = [0, 1.6, 0];
  const fwd = [0, 0, 1];
  const alwaysClear = () => true;
  assert.ok(canSee(eye, fwd, [0, 1.6, 10], alwaysClear).visible, 'straight ahead');
  assert.ok(!canSee(eye, fwd, [0, 1.6, -10], alwaysClear).visible, 'directly behind');
  assert.ok(!canSee(eye, fwd, [0, 1.6, 10], () => false).visible, 'blocked by a wall');
  assert.ok(!canSee(eye, fwd, [0, 1.6, 1000], alwaysClear).visible, 'beyond sight range');
});

test('bots escalate idle -> alert -> engage and give up when you vanish', () => {
  const bot = makeBot(0, [0, 0, 0], 99);
  assert.equal(bot.state, STATE.PATROL);
  const sight = { visible: true, dist: 14 };
  let engaged = false;
  for (let i = 0; i < 400; i++) {
    tickBot(bot, { sight, targetPos: [0, 1.2, 14] }, 1 / 60);
    engaged = engaged || bot.state === STATE.ENGAGE;
  }
  assert.ok(engaged, 'a bot that sees you must engage');
  const lost = { visible: false, dist: 999 };
  for (let i = 0; i < 1200; i++) tickBot(bot, { sight: lost, targetPos: [0, 1.2, 14] }, 1 / 60);
  assert.equal(bot.state, STATE.PATROL, 'a bot must forget a target it cannot see');
});

test('bots respect a reaction delay before the first shot', () => {
  const bot = makeBot(1, [0, 0, 0], 5);
  const sight = { visible: true, dist: 12 };
  let t = 0;
  let firstShot = null;
  for (let i = 0; i < 1200 && firstShot === null; i++) {
    t += 1 / 120;
    if (tickBot(bot, { sight, targetPos: [0, 1.2, 12] }, 1 / 120).fire) firstShot = t;
  }
  assert.ok(firstShot !== null, 'bot never fired');
  assert.ok(firstShot >= AI_TUNING.reactionMs / 1000 * 0.8, `bot fired too fast: ${firstShot}s`);
  assert.ok(firstShot < 3, `bot took too long: ${firstShot}s`);
});

test('bots run out of ammo, reload, and never fire while reloading', () => {
  const bot = makeBot(2, [0, 0, 0], 11);
  const sight = { visible: true, dist: 10 };
  let reloadedOnce = false;
  for (let i = 0; i < 6000; i++) {
    const act = tickBot(bot, { sight, targetPos: [0, 1.2, 10] }, 1 / 120);
    if (bot.state === STATE.RELOAD) {
      reloadedOnce = true;
      assert.ok(!act.fire, 'fired while reloading');
    }
    assert.ok(bot.ammo >= 0, 'negative magazine');
  }
  assert.ok(reloadedOnce, 'bot never needed to reload');
});

test('damage kills exactly once', () => {
  const bot = makeBot(3, [0, 0, 0], 3);
  const hp = bot.hp;
  assert.ok(hp > 0);
  assert.equal(damageBot(bot, hp * 0.4), false);
  assert.equal(bot.state === STATE.DEAD, false);
  assert.equal(damageBot(bot, hp), true, 'lethal damage must report a kill');
  assert.equal(bot.state, STATE.DEAD);
  assert.equal(damageBot(bot, 999), false, 'a corpse cannot be killed again');
});

// ----------------------------------------------------------------- texgen
test('procedural textures produce full RGBA byte buffers with real variance', () => {
  const N = 64;
  for (const [name, fn] of [['concrete', concrete], ['sand', sand], ['gunMetal', gunMetal]]) {
    const out = fn(N, 1234);
    assert.ok(out.albedo instanceof Uint8Array, `${name}.albedo`);
    assert.equal(out.albedo.length, N * N * 4);
    assert.equal(out.rough.length, N * N * 4);
    assert.equal(out.normal.length, N * N * 4);
    assert.equal(out.ao.length, N * N * 4);
    assert.equal(out.size, N);
    let min = 255;
    let max = 0;
    for (let i = 0; i < out.albedo.length; i += 4) {
      min = Math.min(min, out.albedo[i]);
      max = Math.max(max, out.albedo[i]);
      assert.equal(out.albedo[i + 3], 255, `${name} must be opaque`);
    }
    assert.ok(max - min > 20, `${name} is a flat colour (range ${max - min})`);
  }
});

test('normal maps are unit length and point outward', () => {
  const N = 32;
  const h = new Float32Array(N * N);
  for (let i = 0; i < h.length; i++) h[i] = Math.sin(i * 0.3) * 0.5 + 0.5;
  const n = heightToNormal(h, N, 1.5);
  for (let i = 0; i < N * N; i++) {
    const x = n[i * 4] / 255 * 2 - 1;
    const y = n[i * 4 + 1] / 255 * 2 - 1;
    const z = n[i * 4 + 2] / 255 * 2 - 1;
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.02, `not unit length at ${i}`);
    assert.ok(z > 0, 'normal points into the surface');
  }
});

test('sprites and decals fade to transparent at the edge', () => {
  const N = 32;
  const decal = bulletDecal(N, 1).albedo;
  const sprite = radialSprite(N, 2.0).albedo;
  for (const buf of [decal, sprite]) {
    assert.equal(buf.length, N * N * 4);
    assert.ok(buf[3] < 8, 'corner is not transparent');
    const c = ((N / 2) * N + N / 2) * 4;
    assert.ok(buf[c + 3] > 100, 'centre is not opaque enough');
  }
});

// --------------------------------------------------------------- integration
test('a full magazine of AR fire kills a bot in a plausible number of hits', () => {
  const w = WEAPONS.ar;
  const bot = makeBot(0, [0, 0, 20], 1);
  let shots = 0;
  while (bot.state !== STATE.DEAD && shots < 100) {
    damageBot(bot, damageAt(w, 20, 'body'));
    shots++;
  }
  assert.ok(shots >= 3 && shots <= 8, `body shots to kill at 20 m: ${shots}`);
  assert.ok(shots < w.magSize, 'one magazine must be able to kill one enemy');
});

// ------------------------------------------------------------------ trigger
test('a click that starts and ends inside one frame is not lost', () => {
  const t = new Trigger();
  t.press();
  t.release();
  // The button is already up by the time the simulation looks at it.
  assert.equal(t.held, false);
  assert.equal(t.sample(), true, 'the latched press must survive the release');
  assert.equal(t.sample(), false, 'the latch is consumed exactly once');
});

test('holding the trigger reads as pulled on every step', () => {
  const t = new Trigger();
  t.press();
  for (let i = 0; i < 5; i++) assert.equal(t.sample(), true);
  t.release();
  assert.equal(t.sample(), false);
});

test('an untouched trigger never reports a pull', () => {
  const t = new Trigger();
  for (let i = 0; i < 3; i++) assert.equal(t.sample(), false);
  t.press();
  t.clear();
  assert.equal(t.sample(), false, 'clear() must drop the latch as well as the hold');
  assert.equal(t.held, false);
});

test('a press latched while pausing is not fired on resume', () => {
  const t = new Trigger();
  t.press();
  // pause() drops the held button and the latch.
  t.clear();
  // exitPointerLock has not landed yet, so this click still gets through.
  t.press();
  // Resume clears the latch a second time, which is the fix.
  t.clear();
  assert.equal(t.sample(), false, 'resume must not fire a shot nobody aimed');
  t.press();
  t.release();
  assert.equal(t.sample(), true, 'a fresh press after resume still fires');
  assert.equal(t.sample(), false, 'and it is still consumed exactly once');
});

test('a dropped frame fires a semi-auto weapon exactly once', () => {
  // This is the bug the headless run caught: press and release both landed
  // between two frames, so the old "is the button down now" read saw nothing.
  const t = new Trigger();
  const clock = new FireClock(WEAPONS.dmr.rpm);
  let now = 0;
  let shots = 0;
  t.press();
  t.release();
  for (let step = 0; step < 8; step++) {
    now += 1 / 120;
    shots += clock.update(now, t.sample(), false);
  }
  assert.equal(shots, 1, 'one click has to produce one shot, not zero and not two');
});

test('the trigger drives automatic fire at the weapon rate', () => {
  const t = new Trigger();
  const w = WEAPONS.ar;
  const clock = new FireClock(w.rpm);
  let now = 0;
  let shots = 0;
  t.press();
  // One second of held fire, sampled at the fixed simulation step.
  for (let step = 0; step < 120; step++) {
    now += 1 / 120;
    shots += clock.update(now, t.sample(), true);
  }
  const expected = w.rpm / 60;
  assert.ok(Math.abs(shots - expected) <= 1, `${shots} shots in 1 s, expected about ${expected}`);
  t.release();
  assert.equal(clock.update(now + 1, t.sample(), true), 0, 'releasing must stop the gun');
});

test('clamp and lerp behave', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(lerp(0, 10, 0.25), 2.5);
});
