import * as THREE from 'three';
import { MaterialLibrary } from './render/textures.js';
import { buildWorld } from './render/world.js';
import { buildSky } from './render/sky.js';
import { buildComposer } from './render/post.js';
import { ViewModel } from './render/viewmodel.js';
import { FX } from './render/fx.js';
import { EnemyManager } from './render/enemies.js';
import { HUD } from './hud.js';
import { Audio } from './audio.js';
import { PROPS, collisionBoxes, SPAWN, BOT_SPAWNS, AMMO_CRATES, ARENA } from './core/level.js';
import { BoxGrid, moveWithSlide, moveVertical, raycastWorld } from './core/collide.js';
import { WEAPONS, WEAPON_ORDER, hFovToV } from './core/weapons.js';
import { Spring, FireClock, makeRecoilStream, spreadDegrees, damageAt } from './core/recoil.js';
import { clamp, lerp } from './core/rng.js';
import { STATE } from './core/ai.js';
import { Trigger } from './core/trigger.js';

export const QUALITY = {
  low: {
    label: 'Low', texSize: 256, aniso: 2, bevel: false, shadows: true, shadowMap: 1024, shadowExtent: 40,
    msaa: 0, bloom: false, smaa: false, gtao: false, decals: 24, sparks: 260, puffs: 18,
    grain: 0.014, sharpen: 0.10, bloomStrength: 0.0, bloomRadius: 0.5, bloomThreshold: 1.2, pixelCap: 1.0,
  },
  medium: {
    label: 'Medium', texSize: 512, aniso: 4, bevel: true, shadows: true, shadowMap: 2048, shadowExtent: 46,
    msaa: 0, bloom: true, smaa: false, gtao: false, decals: 48, sparks: 520, puffs: 32,
    grain: 0.018, sharpen: 0.15, bloomStrength: 0.16, bloomRadius: 0.5, bloomThreshold: 1.10, pixelCap: 1.5,
  },
  high: {
    label: 'High', texSize: 1024, aniso: 8, bevel: true, shadows: true, shadowMap: 4096, shadowExtent: 52,
    msaa: 4, bloom: true, smaa: true, gtao: false, decals: 80, sparks: 900, puffs: 48,
    grain: 0.020, sharpen: 0.18, bloomStrength: 0.20, bloomRadius: 0.55, bloomThreshold: 1.05, pixelCap: 2.0,
  },
};

export const PLAYER = {
  eye: 1.66, eyeCrouch: 1.05,
  radius: 0.34, height: 1.78, heightCrouch: 1.20,
  walk: 4.35, sprint: 6.5, crouchSpeed: 2.2,
  accel: 60, airAccel: 8, friction: 11,
  gravity: -22.5, jump: 6.5,
};

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class Game {
  constructor(canvas, qualityName) {
    this.canvas = canvas;
    this.qualityName = QUALITY[qualityName] ? qualityName : 'medium';
    this.q = QUALITY[this.qualityName];
    this.state = 'loading';
    this.time = 0;
    this.frames = 0;
    this.errors = [];
  }

  async init(onProgress) {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping is done by the final pass, on HDR values, not here.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = this.q.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // three.js clears renderer.info at the start of every render() call. With a
    // post-processing chain the last call is a fullscreen quad, so the counters
    // report a single draw call for the whole frame. Own the reset instead: the
    // loop clears it once per frame, before the first pass runs.
    renderer.info.autoReset = false;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(hFovToV(103, aspect), aspect, 0.06, 600);

    onProgress?.(0.06, 'synthesising materials');
    await frame();
    this.lib = new MaterialLibrary(renderer, this.q).build();

    onProgress?.(0.55, 'building Blacksite 14');
    await frame();
    this.world = buildWorld(this.scene, this.lib, this.q);
    this.boxes = collisionBoxes();
    this.grid = new BoxGrid(this.boxes, 6);

    onProgress?.(0.70, 'lighting the sky');
    await frame();
    this.skyRig = buildSky(this.scene, renderer, this.q);
    // The viewmodel lives in its own scene, so give the shared materials the
    // env map explicitly instead of relying on one scene's environment slot.
    this.lib.setEnvironment(this.skyRig.envRT.texture);

    onProgress?.(0.80, 'assembling weapons');
    await frame();
    this.vm = new ViewModel(this.lib).build();
    this.vm.scene.environment = this.skyRig.envRT.texture;
    this.vm.scene.environmentIntensity = 0.55;
    this.vm.setAspect(aspect, WEAPONS.ar.viewFov);
    this.fx = new FX(this.scene, this.lib, this.q);
    this.enemies = new EnemyManager(this.scene, this.lib, this.boxes, (e) => this.onEnemyEvent(e));

    onProgress?.(0.90, 'compiling shaders');
    await frame();
    this.post = buildComposer(renderer, this.scene, this.camera, this.vm.scene, this.vm.camera, this.q);
    renderer.compile(this.scene, this.camera);

    this.hud = new HUD();
    this.audio = new Audio();
    this.resetRun();
    this.bindInput();
    window.addEventListener('resize', () => this.resize());

    onProgress?.(1, 'ready');
    this.state = 'menu';
    this.ready = true;
    return this;
  }

  // ---------------------------------------------------------------- run state
  resetRun() {
    this.pos = [SPAWN.x, SPAWN.y, SPAWN.z];
    this.vel = [0, 0, 0];
    this.yaw = SPAWN.yaw;
    this.pitch = 0;
    this.onGround = true;
    this.crouched = false;
    this.crouchK = 0;
    this.hp = 100;
    this.alive = true;
    this.regenT = 0;
    this.score = 0;
    this.wave = 0;
    this.bobT = 0;
    this.stepAcc = 0;
    this.shotsFired = 0;
    this.slot = 0;
    this.reloadT = 0;
    this.reloadWasEmpty = false;
    this.wasFiring = false;
    this.lastLookDx = 0;
    this.lastLookDy = 0;
    this.stats = { shots: 0, hits: 0, kills: 0, headshots: 0, damage: 0 };

    this.recoilPitch = new Spring(0.085);
    this.recoilYaw = new Spring(0.095);
    this.punch = new Spring(0.07);

    this.ammo = {};
    for (const k of WEAPON_ORDER) this.ammo[k] = { mag: WEAPONS[k].magSize, reserve: WEAPONS[k].reserve };

    this.vm.select(WEAPON_ORDER[0]);
    this.recoilStream = makeRecoilStream(this.weapon.recoil, 0x5eed01);
    this.fireClock = new FireClock(this.weapon.rpm);

    for (const p of PROPS) if (p.explosive) p.blown = false;
    for (const b of this.boxes) if (b.explosive) b.blown = false;
    for (const [prop, mesh] of this.world.byProp) if (prop.explosive) mesh.visible = true;

    if (this.enemies) {
      this.enemies.group.clear();
      this.enemies.bots.length = 0;
    }
    this.spawnWave();
  }

  get weaponKey() { return WEAPON_ORDER[this.slot]; }
  get weapon() { return WEAPONS[this.weaponKey]; }

  spawnWave() {
    this.wave += 1;
    const n = Math.min(3 + this.wave, 8);
    this.enemies.spawn(BOT_SPAWNS, n, 1000 + this.wave * 131);
    this.hud?.say(`WAVE ${this.wave} \u2014 ${n} HOSTILES`, 1600);
  }

  // ------------------------------------------------------------------- input
  bindInput() {
    this.keys = new Set();
    this.mouse = { dx: 0, dy: 0, down: false, rdown: false };
    // Presses are latched so a click that starts and ends inside one long
    // frame still reaches the simulation. See src/core/trigger.js.
    this.trigger = new Trigger();
    this.sens = Number(localStorage.getItem('bs14.sens') || 0.0022);

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Escape') this.pause();
      if (this.state !== 'play') return;
      if (e.code === 'KeyR') this.startReload();
      if (e.code === 'Digit1') this.switchTo(0);
      if (e.code === 'Digit2') this.switchTo(1);
      if (e.code === 'Digit3') this.switchTo(2);
      if (e.code === 'KeyQ') this.switchTo((this.slot + 1) % WEAPON_ORDER.length);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });
    document.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) { this.mouse.down = true; this.trigger.press(); }
      if (e.button === 2) this.mouse.rdown = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.mouse.down = false; this.trigger.release(); }
      if (e.button === 2) this.mouse.rdown = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      const n = WEAPON_ORDER.length;
      this.switchTo((this.slot + (e.deltaY > 0 ? 1 : n - 1)) % n);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (!locked && this.state === 'play') this.pause();
      else if (locked && this.state === 'paused') {
        this.state = 'play';
        // exitPointerLock is not instantaneous. A click landing between
        // pause() and the actual release still passes the handler guard and
        // latches a press, so resume starts from a clean latch.
        this.trigger.clear();
        document.body.classList.remove('paused');
        document.getElementById('menu')?.classList.remove('show');
      }
    });
  }

  start() {
    this.audio.resume();
    if (this.state === 'dead') this.resetRun();
    this.state = 'play';
    this.trigger.clear();
    document.body.classList.remove('paused');
    this.canvas.requestPointerLock?.();
  }

  pause() {
    if (this.state !== 'play') return;
    this.state = 'paused';
    // Drop held and latched input, otherwise the gun keeps firing on resume.
    this.mouse.down = false;
    this.trigger.clear();
    document.body.classList.add('paused');
    document.getElementById('menu')?.classList.add('show');
    document.exitPointerLock?.();
  }

  switchTo(slot) {
    if (slot === this.slot || this.reloadT > 0) return;
    this.slot = slot;
    this.vm.select(this.weaponKey);
    this.vm.setAspect(this.camera.aspect, this.weapon.viewFov);
    this.recoilStream = makeRecoilStream(this.weapon.recoil, 0x5eed01 + slot * 7919);
    this.fireClock = new FireClock(this.weapon.rpm);
    this.shotsFired = 0;
    this.vm.lowerSpring.value = 1;
    this.audio.click(520, 0.06, 0.16, 'square');
  }

  startReload() {
    const a = this.ammo[this.weaponKey];
    const w = this.weapon;
    if (this.reloadT > 0 || a.reserve <= 0 || a.mag >= w.magSize) return;
    const empty = a.mag === 0;
    const ms = empty ? w.reloadEmptyMs : w.reloadMs;
    this.reloadT = ms / 1000;
    this.reloadWasEmpty = empty;
    this.vm.startReload(ms, empty);
    this.audio.click(330, 0.07, 0.20, 'square');
    setTimeout(() => this.audio.click(210, 0.09, 0.22, 'square'), ms * 0.45);
    setTimeout(() => this.audio.click(680, 0.06, 0.20, 'square'), ms * 0.85);
  }

  finishReload() {
    const a = this.ammo[this.weaponKey];
    const take = Math.min(this.weapon.magSize - a.mag, a.reserve);
    a.mag += take;
    a.reserve -= take;
  }

  // ------------------------------------------------------------------ combat
  eyePos() {
    return [this.pos[0], this.pos[1] + lerp(PLAYER.eye, PLAYER.eyeCrouch, this.crouchK), this.pos[2]];
  }

  forward(out = [0, 0, 0]) {
    const cp = Math.cos(this.pitch);
    out[0] = -Math.sin(this.yaw) * cp;
    out[1] = Math.sin(this.pitch);
    out[2] = -Math.cos(this.yaw) * cp;
    return out;
  }

  /** Viewmodel muzzle, converted from viewmodel-camera space into world space. */
  muzzleWorld() {
    const v = this.vm.muzzleWorld(this._mw || (this._mw = new THREE.Vector3()));
    return v.applyMatrix4(this.camera.matrixWorld);
  }

  fire() {
    const w = this.weapon;
    const a = this.ammo[this.weaponKey];
    if (a.mag <= 0) {
      this.audio.click(170, 0.03, 0.10, 'square');
      this.startReload();
      return;
    }
    a.mag -= 1;
    this.stats.shots += 1;
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    const ads = this.vm.adsAmount > 0.7;
    const spread = spreadDegrees(w, {
      ads,
      speed,
      shotsFired: this.shotsFired,
      crouched: this.crouched,
      airborne: !this.onGround,
    });

    const dir = this.forward();
    if (spread > 0) {
      const ang = (spread * Math.PI) / 180;
      const r = Math.tan(Math.sqrt(Math.random()) * ang);
      const th = Math.random() * Math.PI * 2;
      const d = this._d || (this._d = new THREE.Vector3());
      d.set(dir[0], dir[1], dir[2]);
      const right = (this._r || (this._r = new THREE.Vector3())).crossVectors(d, THREE.Object3D.DEFAULT_UP).normalize();
      const up = (this._u || (this._u = new THREE.Vector3())).crossVectors(right, d).normalize();
      d.addScaledVector(right, Math.cos(th) * r).addScaledVector(up, Math.sin(th) * r).normalize();
      dir[0] = d.x; dir[1] = d.y; dir[2] = d.z;
    }

    const origin = this.eyePos();
    const world = raycastWorld(origin, dir, this.boxes, w.falloffEnd * 2.5);
    let best = world ? { t: world.t, kind: 'world', hit: world } : { t: w.falloffEnd * 2.5, kind: 'none' };
    for (const bot of this.enemies.bots) {
      const h = this.enemies.hitTest(bot, origin, dir, best.t);
      if (h && h.t < best.t) best = { t: h.t, kind: 'bot', bot, part: h.part };
    }
    const end = [origin[0] + dir[0] * best.t, origin[1] + dir[1] * best.t, origin[2] + dir[2] * best.t];

    if (this.stats.shots % w.tracerEvery === 0) {
      const m = this.muzzleWorld();
      this.fx.tracer([m.x, m.y, m.z], end);
    }

    if (best.kind === 'world') {
      const tag = best.hit.box.tag || 'concrete';
      this.fx.impact(end, best.hit.normal, best.hit.box.mat || 'concrete');
      const metal = ['metal', 'container', 'barrel', 'tower', 'pipe'].some((t) => tag.includes(t));
      this.audio.impact(metal ? 'metal' : tag === 'ground' ? 'sand' : 'concrete');
      if (best.hit.box.explosive && !best.hit.box.blown) this.detonate(best.hit.box);
    } else if (best.kind === 'bot') {
      const dmg = damageAt(w, best.t, best.part);
      const killed = this.enemies.damage(best.bot, dmg, best.part);
      this.fx.bloodMist(end, dir);
      this.audio.impact('flesh');
      this.stats.hits += 1;
      if (best.part === 'head') this.stats.headshots += 1;
      this.hud.hitmark(killed);
      if (killed) {
        this.stats.kills += 1;
        this.score += best.part === 'head' ? 150 : 100;
        this.hud.kill(`<b>YOU</b> ${best.part === 'head' ? '&#9678;' : '&#10005;'} <span>HOSTILE ${best.bot.id + 1}</span>`, best.part === 'head' ? 'hs' : '');
        this.audio.click(880, 0.09, 0.18, 'triangle');
      }
    }

    // recoil: the weapon kicks more than the camera does
    const kick = this.recoilStream();
    const adsMul = lerp(1, 0.72, this.vm.adsAmount);
    this.recoilPitch.target += (kick.pitch * Math.PI) / 180 * adsMul * w.camRecoilShare;
    this.recoilYaw.target += (kick.yaw * Math.PI) / 180 * adsMul * w.camRecoilShare;
    this.punch.target += 0.012;
    this.vm.applyShot(w);
    this.shotsFired += 1;

    this.audio.shot({ bodyHz: w.sound.bodyHz, punchHz: w.sound.bodyHz * 0.55, decay: w.sound.bodyDecay + 0.06, gain: 0.9 }, 0);
    const m = this.muzzleWorld();
    this.fx.muzzleFlash(m, 1);

    const d = (this._d2 || (this._d2 = new THREE.Vector3())).set(dir[0], dir[1], dir[2]);
    const right = (this._r2 || (this._r2 = new THREE.Vector3())).crossVectors(d, THREE.Object3D.DEFAULT_UP).normalize();
    const shellPos = (this._sp || (this._sp = new THREE.Vector3())).set(origin[0], origin[1] - 0.14, origin[2])
      .addScaledVector(right, 0.20).addScaledVector(d, 0.28);
    this.fx.shell(shellPos, right, THREE.Object3D.DEFAULT_UP, d);
  }

  detonate(box) {
    box.blown = true;
    if (box.prop) box.prop.blown = true;
    const c = [(box.min[0] + box.max[0]) / 2, box.min[1] + 0.5, (box.min[2] + box.max[2]) / 2];
    this.fx.explosion(c);
    this.audio.explosion();
    const mesh = box.prop ? this.world.byProp.get(box.prop) : null;
    if (mesh) mesh.visible = false;
    const R = 7;
    for (const bot of this.enemies.bots) {
      if (bot.state === STATE.DEAD) continue;
      const d = Math.hypot(bot.pos[0] - c[0], bot.pos[2] - c[2]);
      if (d >= R) continue;
      if (this.enemies.damage(bot, 150 * (1 - d / R), 'body')) {
        this.stats.kills += 1;
        this.score += 120;
        this.hud.kill(`<b>YOU</b> &#10022; <span>HOSTILE ${bot.id + 1}</span>`, 'boom');
      }
    }
    const pd = Math.hypot(this.pos[0] - c[0], this.pos[2] - c[2]);
    if (pd < R) this.hurt(75 * (1 - pd / R), c);
  }

  hurt(amount, fromPos) {
    if (!this.alive || amount <= 0) return;
    this.hp -= amount;
    this.stats.damage += amount;
    this.regenT = 0;
    const ang = (Math.atan2(fromPos[0] - this.pos[0], fromPos[2] - this.pos[2]) - this.yaw) * (180 / Math.PI);
    this.hud.damageFrom(-ang);
    this.punch.target += 0.02;
    this.recoilPitch.target += 0.0006 * amount;
    if (this.hp <= 0) this.die();
  }

  die() {
    this.hp = 0;
    this.alive = false;
    this.state = 'dead';
    document.exitPointerLock?.();
    document.body.classList.add('paused');
    const acc = this.stats.shots ? Math.round((this.stats.hits / this.stats.shots) * 100) : 0;
    const el = document.getElementById('over-stats');
    if (el) {
      el.innerHTML =
        `<div><span>SCORE</span><b>${this.score}</b></div>` +
        `<div><span>WAVE</span><b>${this.wave}</b></div>` +
        `<div><span>KILLS</span><b>${this.stats.kills}</b></div>` +
        `<div><span>HEADSHOTS</span><b>${this.stats.headshots}</b></div>` +
        `<div><span>ACCURACY</span><b>${acc}%</b></div>`;
    }
    document.getElementById('gameover')?.classList.add('show');
  }

  onEnemyEvent(e) {
    if (e.type !== 'botFire') return;
    this.audio.shot({ bodyHz: 930, punchHz: 120, decay: 0.16, gain: 0.5 }, Math.max(1, e.dist));
    // Bots roll to hit. Nothing here fakes perfect aim; distance is the whole model.
    const acc = clamp(0.55 - e.dist * 0.007, 0.10, 0.55);
    if (Math.random() < acc) this.hurt(8 + Math.random() * 6, e.bot.pos);
    else this.audio.whizz(Math.random() * 2.5);
  }

  // -------------------------------------------------------------------- tick
  update(dt) {
    const w = this.weapon;

    // ---- look
    const adsAmt = this.vm.adsAmount || 0;
    const sensScale = lerp(1, 0.65, adsAmt);
    const dx = this.mouse.dx;
    const dy = this.mouse.dy;
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.yaw -= dx * this.sens * sensScale;
    this.pitch = clamp(this.pitch - dy * this.sens * sensScale, -1.53, 1.53);
    this.lastLookDx = lerp(this.lastLookDx, dx * 0.02, 0.4);
    this.lastLookDy = lerp(this.lastLookDy, dy * 0.02, 0.4);

    // ---- stance
    const k = this.keys;
    this.crouched = k.has('ControlLeft');
    this.crouchK = clamp(this.crouchK + (this.crouched ? 8 : -8) * dt, 0, 1);
    let ix = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    let iz = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; }
    const wantsAds = this.mouse.rdown && this.reloadT <= 0;
    const sprinting = k.has('ShiftLeft') && iz > 0.5 && !this.crouched && !wantsAds && this.onGround;

    // ---- reload
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.finishReload();
    }

    // ---- horizontal movement (accelerate / friction, Quake-style)
    const maxSpd = this.crouched ? PLAYER.crouchSpeed
      : sprinting ? PLAYER.sprint
      : lerp(PLAYER.walk, PLAYER.walk * 0.58, adsAmt);
    const fx = -Math.sin(this.yaw) * iz + Math.cos(this.yaw) * ix;
    const fz = -Math.cos(this.yaw) * iz - Math.sin(this.yaw) * ix;
    if (this.onGround) {
      const sp = Math.hypot(this.vel[0], this.vel[2]);
      if (sp > 0) {
        const scale = Math.max(0, sp - sp * PLAYER.friction * dt) / sp;
        this.vel[0] *= scale;
        this.vel[2] *= scale;
      }
    }
    const cur = this.vel[0] * fx + this.vel[2] * fz;
    const add = clamp(maxSpd - cur, 0, (this.onGround ? PLAYER.accel : PLAYER.airAccel) * dt);
    this.vel[0] += fx * add;
    this.vel[2] += fz * add;

    if (k.has('Space') && this.onGround) {
      this.vel[1] = PLAYER.jump;
      this.onGround = false;
    }

    const height = lerp(PLAYER.height, PLAYER.heightCrouch, this.crouchK);
    const before = [this.pos[0], this.pos[2]];
    moveWithSlide(this.pos, [this.vel[0] * dt, 0, this.vel[2] * dt], PLAYER.radius, height, this.boxes, this.grid);
    if (Math.abs(this.pos[0] - before[0]) < 1e-9) this.vel[0] = 0;
    if (Math.abs(this.pos[2] - before[1]) < 1e-9) this.vel[2] = 0;
    const v = moveVertical(this.pos, this.vel[1], dt, PLAYER.gravity, PLAYER.radius, height, this.boxes, this.grid);
    this.vel[1] = v.vy;
    this.onGround = v.onGround;
    this.pos[0] = clamp(this.pos[0], -ARENA / 2 + 1.2, ARENA / 2 - 1.2);
    this.pos[2] = clamp(this.pos[2], -ARENA / 2 + 1.2, ARENA / 2 - 1.2);

    // ---- firing
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    const canFire = this.reloadT <= 0 && !sprinting && this.alive && this.state === 'play';
    // One read per simulation step. It consumes the latch, so a click that was
    // pressed and released inside a single long frame still pulls the trigger.
    const triggerPulled = this.trigger.sample();
    if (canFire) {
      const shots = this.fireClock.update(this.time, triggerPulled, w.auto);
      for (let i = 0; i < shots; i++) this.fire();
    }
    if (!triggerPulled) {
      this.fireClock.release(this.time);
      this.shotsFired = Math.max(0, this.shotsFired - dt * 9);
    }

    // ---- camera recoil decay + compose
    this.recoilPitch.target *= Math.pow(0.02, dt);
    this.recoilYaw.target *= Math.pow(0.05, dt);
    this.punch.target *= Math.pow(0.004, dt);
    this.recoilPitch.step(dt);
    this.recoilYaw.step(dt);
    this.punch.step(dt);

    const bobSpeed = clamp(speed / PLAYER.walk, 0, 1.4);
    this.bobT += dt * (sprinting ? 2.85 : 1.85) * Math.PI * 2 * bobSpeed;
    const bobAmt = (1 - adsAmt * 0.85) * bobSpeed * (this.onGround ? 1 : 0);
    const bobY = Math.abs(Math.cos(this.bobT)) * 0.030 * bobAmt;
    const bobX = Math.sin(this.bobT) * 0.022 * bobAmt;
    const eye = this.eyePos();
    this.camera.position.set(
      eye[0] + bobX * Math.cos(this.yaw),
      eye[1] + bobY - this.punch.value,
      eye[2] - bobX * Math.sin(this.yaw)
    );
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotation.y = this.yaw + this.recoilYaw.value;
    this.camera.rotation.x = clamp(this.pitch + this.recoilPitch.value, -1.55, 1.55);
    this.camera.rotation.z = Math.sin(this.bobT) * 0.005 * bobAmt - ix * 0.010 * (1 - adsAmt);

    // ---- footsteps
    if (this.onGround && speed > 1.2) {
      this.stepAcc += dt * speed;
      if (this.stepAcc > 2.1) {
        this.stepAcc = 0;
        this.audio.click(140 + Math.random() * 70, 0.055, 0.05, 'sine');
      }
    }

    // ---- FOV
    const targetH = adsAmt > 0.02 ? lerp(w.hipFovH, w.adsFovH, adsAmt) : sprinting ? w.hipFovH + 5 : w.hipFovH;
    const targetV = hFovToV(targetH, this.camera.aspect);
    this.camera.fov += (targetV - this.camera.fov) * clamp(dt * 14, 0, 1);
    this.camera.updateProjectionMatrix();

    // ---- viewmodel
    this.vm.update(dt, {
      ads: wantsAds,
      adsMs: w.adsMs,
      unAdsMs: w.unAdsMs,
      speed,
      sprinting,
      crouched: this.crouched,
      onGround: this.onGround,
      lookDx: this.lastLookDx,
      lookDy: this.lastLookDy,
    });

    // ---- world
    this.skyRig.update(this.pos);
    this.enemies.update(dt, this.pos, this.alive);
    this.fx.update(dt, this.camera);

    // ---- regen, resupply, waves
    if (this.alive && this.hp < 100) {
      this.regenT += dt;
      if (this.regenT > 4.5) this.hp = Math.min(100, this.hp + 16 * dt);
    }
    for (const c of AMMO_CRATES) {
      if (Math.hypot(this.pos[0] - c[0], this.pos[2] - c[2]) > 1.6) continue;
      const a = this.ammo[this.weaponKey];
      if (a.reserve < w.reserve) {
        a.reserve = Math.min(w.reserve, a.reserve + Math.ceil(w.magSize * 1.2));
        this.hud.say('AMMO RESUPPLIED', 900);
        this.audio.click(1200, 0.07, 0.14, 'triangle');
      }
    }
    if (this.enemies.aliveCount() === 0) {
      this.score += 250;
      this.hp = Math.min(100, this.hp + 35);
      this.spawnWave();
    }

    // ---- hud
    const curSpread = spreadDegrees(w, {
      ads: adsAmt > 0.7, speed, shotsFired: this.shotsFired, crouched: this.crouched, airborne: !this.onGround,
    });
    const px = (curSpread / Math.max(1e-3, this.camera.fov * 0.5)) * (window.innerHeight * 0.5) + 5;
    this.hud.setCrosshair(px, adsAmt > 0.8);
    const a = this.ammo[this.weaponKey];
    this.hud.setAmmo(a.mag, a.reserve, w.name, this.reloadT > 0);
    this.hud.setHealth(this.hp);
    this.hud.setScore(this.score, this.enemies.aliveCount(), this.wave);
    this.hud.update(dt);
    if (this.frames % 3 === 0) this.hud.drawMinimap(this.pos, this.yaw, this.enemies.bots, this.boxes);

    const u = this.post.final.uniforms;
    u.uTime.value = this.time;
    u.uHurt.value = clamp((1 - this.hp / 100) * 0.9, 0, 0.9);
    u.uExposure.value = lerp(1.0, 0.94, adsAmt);
  }

  render() {
    this.post.composer.render();
  }

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
   * The control sample is the same patch of ground with the caster hidden,
   * so the sand's own variation cancels out. The mirror patch on the sun
   * side is reported too, as a second and independent reading.
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
      // The box has to be filled, not merely large. A mast passes every
      // size test below on the strength of its cross-arms, while the part
      // that actually blocks the sun is a 0.12 m pole. Half the sample
      // window then lands outside the shadow and the probe reports a weak
      // shadow that is really a badly chosen occluder.
      if (!m.userData.solidBox) continue;
      if (reach - along < 1.0) continue;
      if (across < 0.5) continue;
      // A shadow thrown tens of metres by something high up says little
      // about the ground the player walks on, and it drifts towards the
      // edge of the shadow frustum where the reading gets soft.
      if (reach > 12) continue;
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

    // The control is this same square metre with the caster taken away.
    // Comparing two different patches of ground would fold the sand's own
    // variation into the reading; comparing a patch against itself leaves
    // occlusion by this one prop as the only thing that changed.
    let occluded = 0;
    let clear = 0;
    let mirror = 0;
    let noSun = 0;
    let exposure = 1;
    try {
      this.skyRig.update([mid.x, 0, mid.z]);
      for (const k of [1, 0.5, 0.25, 0.125, 0.0625]) {
        exposure = k;
        setExposure(k);
        caster.visible = false;
        clear = sample(dark);
        caster.visible = true;
        if (clear < 0.97) break;
      }
      // The floor of the measurement: this same patch, caster gone, sun at
      // zero. No shadow can ever be darker than that, so the distance from
      // clear to noSun is the whole prize and occluded says how much of it
      // the shadow map collects.
      const sunLight = this.skyRig.sun;
      const sunAt = sunLight.intensity;
      caster.visible = false;
      sunLight.intensity = 0;
      noSun = sample(dark);
      sunLight.intensity = sunAt;
      caster.visible = true;
      occluded = sample(dark);
      mirror = sample(lit);
    } finally {
      caster.visible = true;
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
      saturated: clear >= 0.97,
      occluded: Number(occluded.toFixed(4)),
      clear: Number(clear.toFixed(4)),
      ratio: Number((occluded / Math.max(1e-6, clear)).toFixed(4)),
      mirror: Number(mirror.toFixed(4)),
      mirrorRatio: Number((occluded / Math.max(1e-6, mirror)).toFixed(4)),
      noSun: Number(noSun.toFixed(4)),
      sunShare: Number(((clear - noSun) / Math.max(1e-6, clear)).toFixed(4)),
      efficiency: Number(((clear - occluded) / Math.max(1e-6, clear - noSun)).toFixed(4)),
    };
  }

  resize() {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = hFovToV(this.weapon.hipFovH, this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.vm.setAspect(this.camera.aspect, this.weapon.viewFov);
    this.post.setSize(w, h);
  }
}

export function detectQuality() {
  const saved = localStorage.getItem('bs14.quality');
  if (saved && QUALITY[saved]) return saved;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem >= 8 && cores >= 8) return 'high';
  if (mem <= 3 || cores <= 3) return 'low';
  return 'medium';
}

export async function boot() {
  const canvas = document.getElementById('c');
  const bar = document.getElementById('bar');
  const status = document.getElementById('load-status');
  const quality = detectQuality();
  const qLabel = document.getElementById('q-label');
  if (qLabel) qLabel.textContent = QUALITY[quality].label;
  for (const btn of document.querySelectorAll('[data-quality]')) {
    btn.classList.toggle('on', btn.dataset.quality === quality);
  }

  const game = new Game(canvas, quality);
  window.__game = game;
  try {
    await game.init((p, msg) => {
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
      if (msg && status) status.textContent = msg;
    });
  } catch (err) {
    if (status) status.textContent = `failed: ${err.message}`;
    document.getElementById('loading')?.classList.add('error');
    window.__bootError = String(err && err.stack || err);
    throw err;
  }

  document.getElementById('loading')?.classList.add('done');
  document.body.classList.add('paused');
  document.getElementById('menu')?.classList.add('show');
  document.getElementById('start')?.addEventListener('click', () => {
    document.getElementById('menu')?.classList.remove('show');
    document.getElementById('gameover')?.classList.remove('show');
    game.start();
  });
  document.getElementById('retry')?.addEventListener('click', () => {
    document.getElementById('gameover')?.classList.remove('show');
    game.resetRun();
    game.start();
  });
  for (const btn of document.querySelectorAll('[data-quality]')) {
    btn.addEventListener('click', () => {
      localStorage.setItem('bs14.quality', btn.dataset.quality);
      location.reload();
    });
  }
  const sens = document.getElementById('sens');
  if (sens) {
    sens.value = String(Math.round((game.sens / 0.0022) * 100));
    sens.addEventListener('input', () => {
      game.sens = 0.0022 * (Number(sens.value) / 100);
      localStorage.setItem('bs14.sens', String(game.sens));
      document.getElementById('sens-val').textContent = sens.value;
    });
    document.getElementById('sens-val').textContent = sens.value;
  }

  // Fixed gameplay step: physics and rate of fire must not depend on GPU speed.
  const STEP = 1 / 120;
  let last = performance.now();
  let acc = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const raw = (now - last) / 1000;
    last = now;
    if (game.state === 'play') {
      acc = Math.min(acc + raw, 0.25);
      let guard = 0;
      while (acc >= STEP && guard++ < 40) {
        game.time += STEP;
        game.update(STEP);
        acc -= STEP;
      }
    }
    game.frames += 1;
    game.renderer.info.reset();
    game.render();
  }
  requestAnimationFrame(loop);
  return game;
}
