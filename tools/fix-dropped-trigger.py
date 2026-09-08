#!/usr/bin/env python3
"""Apply the dropped-trigger and draw-call fixes.

Every replacement below asserts that its anchor appears exactly once, so this
script either reproduces the reviewed result byte for byte or fails loudly. It
is committed only so the change can be applied inside CI, and it removes itself
in the same commit.
"""
import io
import os
import re

CHANGES = []


def edit(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    before = len(s)
    for a, b in pairs:
        assert s.count(a) == 1, (path, a[:70], s.count(a))
        s = s.replace(a, b)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    CHANGES.append(f"{path}: {before} -> {len(s)} bytes")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8", newline="").write(text)
    CHANGES.append(f"{path}: new, {len(text)} bytes")


# --------------------------------------------------------------- new module
write("src/core/trigger.js", '''// Trigger input latch. Pure, no DOM, no three.js. Unit tested in CI.
//
// Why this exists: input arrives on the event loop, the simulation samples it
// once per frame. If a whole press and release lands between two frames, a
// naive "is the button down right now" read never sees it and the shot is
// silently dropped. That is a real bug on any machine that stutters, and it is
// exactly what the headless smoke test caught on a software rasteriser where a
// frame can take seconds.
//
// The latch remembers that a press happened, so the next sample reports the
// trigger as pulled even if the button is already back up.

export class Trigger {
  constructor() {
    /** True while the physical button is held. */
    this.held = false;
    /** Presses seen since the last sample, including ones already released. */
    this.latched = 0;
  }

  /** Button went down. */
  press() {
    this.held = true;
    this.latched += 1;
  }

  /** Button came up. A press that was never sampled stays latched. */
  release() {
    this.held = false;
  }

  /**
   * Read the trigger for one simulation step and consume the latch.
   * @returns {boolean} true if the trigger was pulled at any point in this step.
   */
  sample() {
    const on = this.held || this.latched > 0;
    this.latched = 0;
    return on;
  }

  /** Drop everything. Used on pause and on pointer lock exit. */
  clear() {
    this.held = false;
    this.latched = 0;
  }
}
''')

# ------------------------------------------------------------------ main.js
edit("src/main.js", [
    ("import { STATE } from './core/ai.js';",
     "import { STATE } from './core/ai.js';\nimport { Trigger } from './core/trigger.js';"),

    ("    this.mouse = { dx: 0, dy: 0, down: false, rdown: false };",
     "    this.mouse = { dx: 0, dy: 0, down: false, rdown: false };\n"
     "    // Presses are latched so a click that starts and ends inside one long\n"
     "    // frame still reaches the simulation. See src/core/trigger.js.\n"
     "    this.trigger = new Trigger();"),

    ("    renderer.shadowMap.type = THREE.PCFSoftShadowMap;\n    this.renderer = renderer;",
     "    renderer.shadowMap.type = THREE.PCFSoftShadowMap;\n"
     "    // three.js clears renderer.info at the start of every render() call. With a\n"
     "    // post-processing chain the last call is a fullscreen quad, so the counters\n"
     "    // report a single draw call for the whole frame. Own the reset instead: the\n"
     "    // loop clears it once per frame, before the first pass runs.\n"
     "    renderer.info.autoReset = false;\n"
     "    this.renderer = renderer;"),

    ("      if (e.button === 0) this.mouse.down = true;",
     "      if (e.button === 0) { this.mouse.down = true; this.trigger.press(); }"),

    ("      if (e.button === 0) this.mouse.down = false;",
     "      if (e.button === 0) { this.mouse.down = false; this.trigger.release(); }"),

    ("""    if (canFire) {
      const shots = this.fireClock.update(this.time, this.mouse.down, w.auto);
      for (let i = 0; i < shots; i++) this.fire();
    }
    if (!this.mouse.down) {""",
     """    // One read per simulation step. It consumes the latch, so a click that was
    // pressed and released inside a single long frame still pulls the trigger.
    const triggerPulled = this.trigger.sample();
    if (canFire) {
      const shots = this.fireClock.update(this.time, triggerPulled, w.auto);
      for (let i = 0; i < shots; i++) this.fire();
    }
    if (!triggerPulled) {"""),

    ("""    this.state = 'paused';
    document.body.classList.add('paused');""",
     """    this.state = 'paused';
    // Drop held and latched input, otherwise the gun keeps firing on resume.
    this.mouse.down = false;
    this.trigger.clear();
    document.body.classList.add('paused');"""),

    ("""    game.frames += 1;
    game.render();""",
     """    game.frames += 1;
    game.renderer.info.reset();
    game.render();"""),
])

# ---------------------------------------------------------------- smoke.mjs
edit("tests/smoke.mjs", [
    ("""// It deliberately asserts on PROGRESS, never on frame rate: CI renders through
// SwiftShader on a CPU, so any fps threshold would only measure the runner.""",
     """// It deliberately asserts on PROGRESS, never on frame rate: CI renders through
// SwiftShader on a CPU, so any fps threshold would only measure the runner.
// Every wait below is "advance n frames, up to a generous ceiling", so a slow
// runner takes longer and still passes, while a stalled loop fails."""),

    ("const server = await serve(PORT);",
     """// Wait until the loop has actually advanced n frames. A fixed sleep would turn
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

const server = await serve(PORT);"""),

    ("const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });",
     "page = await browser.newPage({ viewport: { width: 1280, height: 720 } });"),

    ("""  await page.click('#start');
  await page.waitForTimeout(300);
  const f0 = await page.evaluate(() => window.__game.frames);
  await page.waitForTimeout(4000);
  const f1 = await page.evaluate(() => window.__game.frames);
  check('render loop advances', f1 - f0 >= 5, `${f1 - f0} frames in 4s`);

  const calls = await page.evaluate(() => window.__game.renderer.info.render.calls);
  check('the GPU is actually drawing', calls > 10, `${calls} draw calls`);""",
     """  await page.click('#start');
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
  check('the GPU is actually drawing', calls > 10, `${calls} draw calls in one frame`);"""),

    ("""  const before = await mag();
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await mag();
  check('firing consumes ammunition', after < before, `${before} -> ${after} rounds`);

  const spent = await page.evaluate(() => window.__game.stats.shots);
  check('the fire clock produced shots', spent > 0, `${spent} shots`);""",
     """  const before = await mag();
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
  check('ammunition and the shot counter agree', before - after === spent, `${before - after} rounds vs ${spent} shots`);"""),

    ("""  await page.keyboard.press('KeyR');
  await page.waitForTimeout(2600);
  const reloaded = await mag();""",
     """  await page.keyboard.press('KeyR');
  try {
    await page.waitForFunction(
      (floor) => window.__game.ammo[window.__game.weaponKey].mag > floor,
      after,
      { timeout: 120_000, polling: 100 }
    );
  } catch { /* reported by the check below */ }
  const reloaded = await mag();"""),

    ("""  await page.keyboard.press('Digit2');
  await page.waitForTimeout(600);""",
     """  await page.keyboard.press('Digit2');
  await advanceFrames(2);"""),

    ("""  await page.setViewportSize({ width: 900, height: 1200 });
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(600);""",
     """  await page.setViewportSize({ width: 900, height: 1200 });
  await advanceFrames(2);
  await page.setViewportSize({ width: 1280, height: 720 });
  await advanceFrames(2);"""),
])

# ----------------------------------------------------------- logic.test.mjs
edit("tests/logic.test.mjs", [
    ("import { STATE, AI_TUNING, canSee, tickBot, makeBot, damageBot } from '../src/core/ai.js';",
     "import { STATE, AI_TUNING, canSee, tickBot, makeBot, damageBot } from '../src/core/ai.js';\n"
     "import { Trigger } from '../src/core/trigger.js';"),

    ("test('clamp and lerp behave', () => {",
     '''// ------------------------------------------------------------------ trigger
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

test('clamp and lerp behave', () => {'''),
])

# --------------------------------------------------------------- weapons.js
edit("src/core/weapons.js", [
    ("""// Weapon data. Numbers follow published MW-class envelopes (AR ~700-850 RPM,
// ADS 230-300 ms, SMG 780-1050 RPM / ADS 175-225 ms) rather than arbitrary taste.""",
     """// Weapon data. The numbers sit inside the ranges the genre has settled on
// (assault rifle about 700-850 RPM, SMG about 780-1050 RPM, ADS times in the
// 175-300 ms band) so the guns feel familiar instead of arbitrary. They are
// design targets for this project, not measurements taken from another game.
// What CI proves is the relationships: rate of fire independent of frame rate,
// monotonic damage falloff, and time to kill inside a stated window."""),
])

# ----------------------------------------------------------------- README.md
edit("README.md", [
    ("[**\\u25b6 Play in your browser**]", "[**Play in your browser**]"),
    ("40 GB package \\u2014 the entire game", "40 GB package. The entire game"),
    ("by an import map \\u2014 the browser test", "by an import map, and the browser test"),
    ("at 256\\u20131024 px", "at 256 to 1024 px"),
    ("counter it by hand \\u2014 which is the entire skill curve",
     "counter it by hand, which is the entire skill curve"),
    ("crouching and aiming \\u2014 in that order", "crouching and aiming, in that order"),
    ("**Controls** \\u2014 `WASD`", "**Controls.** `WASD`"),
    ("pure logic \\u2014 no THREE import", "pure logic, no THREE import"),
    ("THREE-dependent \\u2014 world", "THREE-dependent: world"),
    ("choose Low \\u2014 the texture resolution", "choose Low. The texture resolution"),

    ("assertions-103%20%2B%2019%20in%20chromium", "assertions-114%20%2B%2020%20in%20chromium"),
    ("**103 assertions across 33 logic tests** cover:", "**114 assertions across 38 logic tests** cover:"),
    ("the AI state machine, and normal maps that are unit length.",
     "the AI state machine, normal maps that are unit length, and a trigger latch "
     "that keeps a click alive across a dropped frame."),

    ("""**19 checks in headless Chromium** boot the real game, deploy, capture the mouse, fire, reload, switch weapons and resize \\u2014 asserting the render loop advances, the GPU issues draw calls, ammunition is consumed, nothing fails to load, nothing escapes to the network, and no console error occurs. It deliberately **never asserts a frame rate**: CI renders through SwiftShader on a CPU, so an fps threshold would measure the runner and not the game.""",
     """**20 checks in headless Chromium** boot the real game, deploy, capture the mouse, fire, reload, switch weapons and resize, asserting that the render loop advances, that the GPU issues draw calls, that ammunition is consumed, that the rounds which left the magazine match the rounds the fire clock counted, that nothing fails to load, that nothing escapes to the network, and that no console error occurs. It deliberately **never asserts a frame rate**: CI renders through SwiftShader on a CPU, so an fps threshold would measure the runner and not the game. Every wait is written as "advance this many frames, up to a generous ceiling", so a slow runner takes longer and still passes, while a stalled loop fails."""),

    ("""Those tests found four real bugs during development, each of which would have been nearly invisible by eye:

- Semi-auto fire had no trigger-edge check,""",
     """Those tests found six real bugs, each of which would have been nearly invisible by eye:

- A click that began and ended inside a single long frame was dropped. The simulation only ever read whether the button was down at that instant, so on the CPU rasteriser in CI, where one frame can take two seconds, the gun never fired. Fixed with a press latch in `src/core/trigger.js`. The test was not relaxed to press the button for longer.
- Draw calls were counted wrongly rather than missing. `renderer.info` clears itself at the start of every `render()` call and the last post-processing pass is a single fullscreen quad, so an entire frame reported one draw call. The loop now owns the reset and the counter covers the whole frame.
- Semi-auto fire had no trigger-edge check,"""),
])

# Remaining escapes are mechanical.
s = io.open("README.md", encoding="utf-8").read()
s = s.replace(" \\u2192 ", " to ").replace("\\u2192", " to ")
s = s.replace(" \\u00b7 ", " | ").replace("\\u00b7", " | ")
s = s.replace("\\u00d7", "x")
s = s.replace("\\u00b0", " deg")
io.open("README.md", "w", encoding="utf-8", newline="").write(s)
left = sorted(set(re.findall(r"\\u[0-9a-fA-F]{4}", s)))
assert not left, left

# The workflow file itself is updated separately: the default Actions token is
# not allowed to push changes under .github/workflows.

for line in CHANGES:
    print(line)
print("patch applied")
