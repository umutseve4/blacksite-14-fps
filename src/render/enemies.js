import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STATE, makeBot, tickBot, canSee, damageBot, AI_TUNING } from '../core/ai.js';
import { raycastWorld } from '../core/collide.js';
import { clamp, lerp, mulberry32 } from '../core/rng.js';

const bx = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.45));

/** Hit regions, in local space (metres, origin at feet). */
export const HITBOXES = [
  { part: 'head', c: [0, 1.62, 0], s: [0.22, 0.26, 0.24] },
  { part: 'body', c: [0, 1.18, 0], s: [0.46, 0.62, 0.30] },
  { part: 'limb', c: [-0.33, 1.20, 0], s: [0.18, 0.62, 0.22] },
  { part: 'limb', c: [0.33, 1.20, 0], s: [0.18, 0.62, 0.22] },
  { part: 'limb', c: [-0.13, 0.45, 0], s: [0.22, 0.90, 0.24] },
  { part: 'limb', c: [0.13, 0.45, 0], s: [0.22, 0.90, 0.24] },
];

export class EnemyManager {
  constructor(scene, lib, boxes, onEvent) {
    this.scene = scene;
    this.lib = lib;
    this.boxes = boxes;
    this.onEvent = onEvent;
    this.bots = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    this._v = new THREE.Vector3();
    this.geoCache = {};
  }

  _mesh(seed) {
    const rand = mulberry32(seed);
    const fabric = this.lib.get('crate');
    const vest = this.lib.get('sandbag');
    const gun = this.lib.get('gun');
    const g = new THREE.Group();
    const parts = {};
    const mk = (name, geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      parts[name] = m;
      return m;
    };
    const torso = mk('torso', bx(0.44, 0.60, 0.28), fabric, 0, 1.18, 0);
    const plate = new THREE.Mesh(bx(0.42, 0.42, 0.16), vest);
    plate.position.set(0, 0.03, 0.03);
    torso.add(plate);
    // pouches break the silhouette
    for (let i = 0; i < 3; i++) {
      const pouch = new THREE.Mesh(bx(0.10, 0.11, 0.07), vest);
      pouch.position.set(-0.13 + i * 0.13, -0.12, 0.12);
      torso.add(pouch);
    }
    mk('head', bx(0.20, 0.24, 0.22), fabric, 0, 1.62, 0);
    const helm = new THREE.Mesh(bx(0.235, 0.15, 0.25, 0.05), vest);
    helm.position.set(0, 1.685, -0.005);
    g.add(helm);
    parts.helm = helm;
    mk('armL', bx(0.14, 0.54, 0.16), fabric, -0.30, 1.20, 0);
    mk('armR', bx(0.14, 0.54, 0.16), fabric, 0.30, 1.20, 0);
    mk('legL', bx(0.18, 0.86, 0.20), fabric, -0.12, 0.44, 0);
    mk('legR', bx(0.18, 0.86, 0.20), fabric, 0.12, 0.44, 0);
    const rifle = new THREE.Group();
    const body = new THREE.Mesh(bx(0.05, 0.07, 0.62), gun);
    rifle.add(body);
    const magm = new THREE.Mesh(bx(0.03, 0.16, 0.05), fabric);
    magm.position.set(0, -0.10, 0.02);
    rifle.add(magm);
    rifle.position.set(0.22, 1.24, -0.24);
    g.add(rifle);
    parts.rifle = rifle;
    const flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.lib.flash, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    );
    flash.scale.setScalar(0.4);
    flash.position.set(0.22, 1.24, -0.58);
    flash.visible = false;
    g.add(flash);
    parts.flash = flash;
    g.userData.parts = parts;
    g.userData.phase = rand() * 6.28;
    return g;
  }

  spawn(spawns, count, seedBase = 1000) {
    for (let i = 0; i < count; i++) {
      const [x, z] = spawns[i % spawns.length];
      const bot = makeBot(i, [x, 0, z], seedBase + i * 977);
      bot.mesh = this._mesh(seedBase + i);
      bot.mesh.position.set(x, 0, z);
      this.group.add(bot.mesh);
      bot.deathT = 0;
      bot.hitFlash = 0;
      bot.muzzleT = 0;
      this.bots.push(bot);
    }
    return this;
  }

  /** Line of sight through the static world. */
  los(a, b) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1e-6;
    d[0] /= len; d[1] /= len; d[2] /= len;
    const hit = raycastWorld(a, d, this.boxes, len - 0.25);
    return !hit;
  }

  /** Ray vs this bot's hit regions. Returns {part, t} or null. */
  hitTest(bot, o, d, maxT) {
    if (bot.state === STATE.DEAD) return null;
    let best = null;
    for (const hb of HITBOXES) {
      const b = {
        min: [bot.pos[0] + hb.c[0] - hb.s[0] / 2, bot.pos[1] + hb.c[1] - hb.s[1] / 2, bot.pos[2] + hb.c[2] - hb.s[2] / 2],
        max: [bot.pos[0] + hb.c[0] + hb.s[0] / 2, bot.pos[1] + hb.c[1] + hb.s[1] / 2, bot.pos[2] + hb.c[2] + hb.s[2] / 2],
      };
      let t0 = 0;
      let t1 = maxT;
      let ok = true;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-9) {
          if (o[i] < b.min[i] || o[i] > b.max[i]) { ok = false; break; }
        } else {
          const inv = 1 / d[i];
          let ta = (b.min[i] - o[i]) * inv;
          let tb = (b.max[i] - o[i]) * inv;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          if (ta > t0) t0 = ta;
          if (tb < t1) t1 = tb;
          if (t0 > t1) { ok = false; break; }
        }
      }
      if (ok && (!best || t0 < best.t)) best = { part: hb.part, t: t0 };
    }
    return best;
  }

  damage(bot, amount, part) {
    const killed = damageBot(bot, amount);
    bot.hitFlash = 1;
    if (killed) {
      bot.deathT = 0;
      bot.deathDir = (Math.random() - 0.5) * 0.6;
    }
    return killed;
  }

  aliveCount() {
    return this.bots.reduce((n, b) => n + (b.state !== STATE.DEAD ? 1 : 0), 0);
  }

  update(dt, playerPos, playerAlive) {
    const eye = [0, 0, 0];
    for (const bot of this.bots) {
      const parts = bot.mesh.userData.parts;
      if (bot.state === STATE.DEAD) {
        bot.deathT += dt;
        const k = clamp(bot.deathT / 0.55, 0, 1);
        const e = 1 - Math.pow(1 - k, 3);
        bot.mesh.rotation.x = e * (Math.PI / 2) * 0.92;
        bot.mesh.rotation.z = e * bot.deathDir;
        bot.mesh.position.y = -e * 0.12;
        parts.flash.visible = false;
        continue;
      }
      eye[0] = bot.pos[0];
      eye[1] = bot.pos[1] + 1.55;
      eye[2] = bot.pos[2];
      const fwd = [Math.sin(bot.yaw), 0, Math.cos(bot.yaw)];
      const target = [playerPos[0], playerPos[1] + 1.2, playerPos[2]];
      const sight = playerAlive
        ? canSee(eye, fwd, target, (a, b) => this.los(a, b))
        : { visible: false, dist: 999 };
      // A bot that has been alerted keeps tracking even outside its FOV cone.
      if (!sight.visible && bot.state === STATE.ENGAGE && bot.forgetTimer < 3) {
        sight.dist = Math.hypot(target[0] - eye[0], target[2] - eye[2]);
      }
      const act = tickBot(bot, { sight, targetPos: target }, dt);

      // face the player when engaged
      if (bot.state === STATE.ENGAGE || bot.state === STATE.ALERT || bot.state === STATE.RELOAD) {
        const want = Math.atan2(target[0] - bot.pos[0], target[2] - bot.pos[2]);
        let diff = ((want - bot.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        bot.yaw += clamp(diff, -4.5 * dt, 4.5 * dt);
      }

      // movement: forward/back toward preferred range + strafe, blocked by walls
      const [fwdIn, strafeIn] = act.move;
      const spd = AI_TUNING.speed * (bot.state === STATE.ENGAGE ? 1 : 0.55);
      const dx = (Math.sin(bot.yaw) * fwdIn + Math.cos(bot.yaw) * strafeIn) * spd * dt;
      const dz = (Math.cos(bot.yaw) * fwdIn - Math.sin(bot.yaw) * strafeIn) * spd * dt;
      const tryPos = [bot.pos[0] + dx, bot.pos[1], bot.pos[2] + dz];
      if (!this._blockedAt(tryPos)) {
        bot.pos[0] = tryPos[0];
        bot.pos[2] = tryPos[2];
      } else if (!this._blockedAt([bot.pos[0] + dx, bot.pos[1], bot.pos[2]])) {
        bot.pos[0] += dx;
      } else if (!this._blockedAt([bot.pos[0], bot.pos[1], bot.pos[2] + dz])) {
        bot.pos[2] += dz;
      }

      // pose
      const moving = Math.abs(fwdIn) + Math.abs(strafeIn) > 0.05;
      bot.mesh.userData.phase += dt * (moving ? 7.5 : 1.2);
      const ph = bot.mesh.userData.phase;
      const swing = moving ? 0.55 : 0.06;
      parts.legL.rotation.x = Math.sin(ph) * swing;
      parts.legR.rotation.x = -Math.sin(ph) * swing;
      parts.armL.rotation.x = -Math.sin(ph) * swing * 0.5 - 0.8;
      parts.armR.rotation.x = Math.sin(ph) * swing * 0.3 - 0.9;
      parts.torso.rotation.y = Math.sin(ph) * 0.06;
      bot.mesh.position.set(bot.pos[0], bot.pos[1], bot.pos[2]);
      bot.mesh.rotation.y = bot.yaw + Math.PI;

      // hit flash on the material colour, decaying
      if (bot.hitFlash > 0) {
        bot.hitFlash = Math.max(0, bot.hitFlash - dt * 5);
      }

      // muzzle flash + report handed back to the game layer
      bot.muzzleT = Math.max(0, bot.muzzleT - dt);
      parts.flash.visible = bot.muzzleT > 0;
      if (parts.flash.visible) parts.flash.scale.setScalar(0.3 + Math.random() * 0.25);
      if (act.fire && playerAlive) {
        bot.muzzleT = 0.045;
        this.onEvent?.({ type: 'botFire', bot, dist: sight.dist, eye: eye.slice() });
      }
    }
  }

  _blockedAt(p) {
    const r = 0.34;
    const h = 1.75;
    for (const b of this.boxes) {
      if (b.tag === 'ground') continue;
      if (p[1] + h <= b.min[1] || p[1] >= b.max[1]) continue;
      const cx = clamp(p[0], b.min[0], b.max[0]);
      const cz = clamp(p[2], b.min[2], b.max[2]);
      if ((p[0] - cx) ** 2 + (p[2] - cz) ** 2 < r * r) return true;
    }
    return false;
  }
}
