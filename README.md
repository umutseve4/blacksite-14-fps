<div align="center">

# BLACKSITE-14

### A browser FPS with zero asset files. Every texture, every sound, every wall is generated the moment the page loads.

[**\u25b6 Play in your browser**](https://umutseve4.github.io/blacksite-14-fps/)

[![play](https://img.shields.io/badge/play-live%20on%20pages-FF4D4F?style=for-the-badge&logo=googlechrome&logoColor=white)](https://umutseve4.github.io/blacksite-14-fps/)
[![ci](https://img.shields.io/github/actions/workflow/status/umutseve4/blacksite-14-fps/ci.yml?branch=main&style=for-the-badge&label=ci&logo=githubactions&logoColor=white&color=22C55E)](https://github.com/umutseve4/blacksite-14-fps/actions/workflows/ci.yml)
[![three.js](https://img.shields.io/badge/three.js-r169-049EF4?style=for-the-badge&logo=threedotjs&logoColor=white)](https://threejs.org)
[![assets](https://img.shields.io/badge/asset%20files-0-A855F7?style=for-the-badge)](#everything-is-generated)
[![tests](https://img.shields.io/badge/assertions-103%20%2B%2019%20in%20chromium-F59E0B?style=for-the-badge&logo=nodedotjs&logoColor=white)](#the-tests-are-the-point)
[![license](https://img.shields.io/badge/license-MIT-0EA5E9?style=for-the-badge)](LICENSE)

</div>

---

## What it is

A single-player wave shooter that runs on a URL. No install, no download, no loading a 40 GB package \u2014 the entire game is 3,864 lines of JavaScript and a 121-line `index.html`. It ships **not one image, audio, or model file**. The concrete, the sand, the painted metal, the gunmetal on your weapon, the muzzle flash, the bullet decals, the rifle report, the shell hitting the floor: all of it is computed in the first second, in your browser, from a seed.

Clone it, open `index.html` through any static server, and it works. The one thing it does fetch is the Three.js library itself, pulled from a CDN by an import map \u2014 the browser test serves that from `node_modules` instead and asserts that nothing else leaves the machine.

## Everything is generated

| What you see | How it exists |
|---|---|
| Concrete, sand, painted metal, fabric, gunmetal | Tileable value-noise + fBm \u2192 albedo, then a **derived normal map** (Sobel on the height field) and a derived AO map, at 256\u20131024 px depending on quality |
| Bullet holes, smoke puffs, muzzle flash | Radial sprites with a computed alpha falloff, written straight into `DataTexture` |
| The rifle, the SMG, the marksman rifle | Built from primitives in a separate scene with its own camera, so the viewmodel never clips into a wall |
| The map | A data structure. `level.js` is a list of boxes with tags; the renderer and the collision system read the *same* list, so what you see is exactly what you can hit |
| Gunshots, mechanical clicks, hit markers | Web Audio: a body oscillator, a noise crack, a mechanical transient and a wet tail, mixed per weapon |
| Sky, sun, fog | A gradient shader rendered once into a cube target and used as the environment map for every PBR material in the scene |

## How it plays

Three weapons with genuinely different roles, not reskins:

| | KR-7 CARBINE | VX-9 SMG | M-14 MARKSMAN |
|---|---|---|---|
| Rate of fire | 780 rpm, auto | 920 rpm, auto | 360 rpm, **semi-auto** |
| Damage, close \u2192 far | 33 \u2192 22 | 28 \u2192 16 | 62 \u2192 48 |
| Falloff | 26 m \u2192 70 m | 14 m \u2192 42 m | 40 m \u2192 110 m |
| Headshot | \u00d71.55 | \u00d71.4 | \u00d71.7 |
| Magazine | 30 (+210) | 36 (+252) | 20 (+120) |
| Time to aim | 250 ms | 195 ms | 320 ms |
| ADS spread | 0.16\u00b0 | 0.24\u00b0 | 0.05\u00b0 |
| Feel | the default answer | wins the corner, loses the courtyard | wins the courtyard, punished indoors |

These are internal tuning targets, and the logic suite holds them to it: every weapon must lose damage with range, aim tighter than it hips, zoom in when aiming, reload slower on an empty magazine, and land its time-to-kill between 120 ms and 900 ms at 12 m. No comparison to any commercial title is claimed or measured here.

Recoil is a **learnable pattern**, not a random cone: each weapon has a fixed climb-and-drift sequence seeded per weapon, with only a small random share on top. Hold the trigger long enough and you can counter it by hand \u2014 which is the entire skill curve. A test asserts the deterministic share dominates the random one, so a future refactor cannot quietly turn recoil back into a dice roll.

Movement: sprint, crouch, slide-free but momentum-preserving strafing, and ADS that tightens spread and narrows FOV. Spread rewards standing still, crouching and aiming \u2014 in that order, and a test asserts that ordering.

**Controls** \u2014 `WASD` move \u00b7 `Shift` sprint \u00b7 `Ctrl` crouch \u00b7 `Space` jump \u00b7 `Mouse` look \u00b7 `LMB` fire \u00b7 `RMB` aim \u00b7 `R` reload \u00b7 `1/2/3` or `Q` weapons \u00b7 `Esc` pause

## The tests are the point

Most browser graphics demos cannot be tested, so they are not. This one splits into **pure logic** (no WebGL, no DOM) and **rendering**, which means the interesting half runs headless in CI.

**103 assertions across 33 logic tests** cover: noise that tiles exactly across its period, recoil reproducibility, spring stability, rate of fire that is identical at 30 fps and 300 fps, semi-auto needing a real trigger edge, time-to-kill inside the genre window, monotonic damage falloff, collision that does not tunnel at any speed, wall sliding that preserves tangential motion, a flood fill proving every spawn point is reachable, the AI state machine, and normal maps that are unit length.

**19 checks in headless Chromium** boot the real game, deploy, capture the mouse, fire, reload, switch weapons and resize \u2014 asserting the render loop advances, the GPU issues draw calls, ammunition is consumed, nothing fails to load, nothing escapes to the network, and no console error occurs. It deliberately **never asserts a frame rate**: CI renders through SwiftShader on a CPU, so an fps threshold would measure the runner and not the game.

A fourth CI job counts the assertions and fails if that count drops. A green pipeline earned by deleting checks is not a green pipeline. A fifth job walks the tracked file list and fails if a single image, audio, model or font file is ever committed, so the claim at the top of this page stays enforced rather than remembered.

Those tests found four real bugs during development, each of which would have been nearly invisible by eye:

- Semi-auto fire had no trigger-edge check, so holding the button emptied the magazine like full-auto.
- `moveWithSlide` integrated in one step, so a fast enough player passed straight through a wall.
- The AI reset its alert timer every frame while it could see you, so bots literally never finished reacting and never fired.
- One bot spawn point was inside a staircase; the flood-fill test found it walled off from the player.

## Running it

```bash
git clone https://github.com/umutseve4/blacksite-14-fps
cd blacksite-14-fps

npm test        # 33 logic tests, no browser needed
npm run check   # parse every source file, including the WebGL ones
npm run serve   # http://localhost:8099
```

The smoke test needs a browser: `npm i playwright three && npx playwright install chromium && npm run smoke`.

## Layout

```
src/core/     pure logic \u2014 no THREE import, fully unit-testable
  rng.js        seeded noise, fBm, ridged noise (tileable)
  texgen.js     material generators + height\u2192normal / height\u2192AO
  weapons.js    the three weapons as data
  recoil.js     recoil streams, springs, spread, damage, fire clock
  collide.js    swept AABB movement, gravity, hitscan raycast
  ai.js         bot state machine
  level.js      the map as a list of tagged boxes
src/render/   THREE-dependent \u2014 world, viewmodel, enemies, fx, sky, post
src/main.js   the game: input, the fixed 1/120 s timestep, the loop
tests/        logic.test.mjs (node) \u00b7 smoke.mjs (chromium)
```

Gameplay runs on a fixed 1/120 s timestep with rendering decoupled, so physics and rate of fire do not change with your GPU. Rendering is a half-float pipeline with bloom and a final pass that applies AgX tonemapping, a subtle vignette and a hurt flash. The HUD is DOM, not canvas, so post-processing never blurs your own crosshair.

## Honest limits

- Bots use a state machine with reaction delays, magazine management and line-of-sight checks. They do not path-find around the map; they navigate locally.
- One map, one mode: escalating waves.
- It requires WebGL 2 and pointer lock, so it is a desktop game. Mobile loads, but there is no touch control scheme.
- Quality auto-detects from device memory and core count, and can be overridden in the menu. On a low-end machine, choose Low \u2014 the texture resolution and shadow budget change substantially.
- It is not a networked game and there is no multiplayer code.

## License

MIT. See [LICENSE](LICENSE).
