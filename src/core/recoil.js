// Weapon feel: deterministic recoil patterns, critically damped springs, spread model.
// Pure math. Every constant here is a tuning knob validated by tests/logic.test.mjs.

import { mulberry32, clamp, lerp } from './rng.js';

/**
 * Deterministic recoil pattern, in degrees, for shot index `i` (0-based).
 * Phase 1 (0-2)  : near-vertical climb, little yaw.
 * Phase 2 (3-7)  : characteristic lateral drift.
 * Phase 3 (8+)   : low-frequency wander, reduced climb.
 * `randomShare` of the magnitude is stochastic; the rest is learnable.
 */
export function recoilStep(profile, i, rand) {
  const { pitchBase, yawDrift, randomShare, driftSign } = profile;
  let pitch;
  let yaw;
  if (i < 3) {
    pitch = pitchBase * (1.25 - i * 0.06);
    yaw = yawDrift * 0.18 * driftSign * i;
  } else if (i < 8) {
    pitch = pitchBase * (1.0 - (i - 3) * 0.05);
    yaw = yawDrift * driftSign * (0.55 + (i - 3) * 0.12);
  } else {
    pitch = pitchBase * 0.62;
    // Low-frequency sinusoidal wander instead of unbounded drift.
    yaw = yawDrift * driftSign * Math.cos((i - 8) * 0.55) * 0.9;
  }
  const rp = (rand() * 2 - 1) * randomShare;
  const ry = (rand() * 2 - 1) * randomShare;
  return { pitch: pitch * (1 + rp), yaw: yaw + yawDrift * ry };
}

/** Fresh deterministic pattern stream for a magazine. */
export function makeRecoilStream(profile, seed) {
  const rand = mulberry32(seed);
  let i = 0;
  return () => recoilStep(profile, i++, rand);
}

/**
 * Critically damped spring. Stable for any dt (semi-implicit, no overshoot).
 * halfLife = time for the remaining error to halve.
 */
export class Spring {
  constructor(halfLife = 0.12, value = 0) {
    this.value = value;
    this.vel = 0;
    this.target = value;
    this.setHalfLife(halfLife);
  }
  setHalfLife(halfLife) {
    this.halfLife = Math.max(1e-4, halfLife);
    // omega for critical damping such that error halves in halfLife seconds
    this.omega = 2.0 * Math.LN2 / this.halfLife;
  }
  step(dt) {
    const w = this.omega;
    const d = clamp(dt, 0, 0.1);
    // Semi-implicit Euler with critical damping: x'' = -2w x' - w^2 (x - target)
    const accel = -2 * w * this.vel - w * w * (this.value - this.target);
    this.vel += accel * d;
    this.value += this.vel * d;
    return this.value;
  }
}

/** Bullet spread half-angle, in degrees, from movement/stance/ADS/consecutive shots. */
export function spreadDegrees(w, s) {
  let v = s.ads ? w.adsSpread : w.hipSpread;
  v += Math.min(s.speed, 8) * (s.ads ? 0.035 : 0.09);
  v += Math.min(s.shotsFired, 12) * w.spreadPerShot * (s.ads ? 0.5 : 1.0);
  if (s.crouched) v *= 0.72;
  if (s.airborne) v *= 2.2;
  return clamp(v, 0.0, 12.0);
}

/** Damage with range falloff and limb multipliers. Head is always lethal-fast, never one-shot for ARs. */
export function damageAt(w, distance, part) {
  const t = clamp((distance - w.falloffStart) / Math.max(1e-3, w.falloffEnd - w.falloffStart), 0, 1);
  const base = lerp(w.damageNear, w.damageFar, t);
  const mult = part === 'head' ? w.headMult : part === 'limb' ? 0.85 : 1.0;
  return base * mult;
}

/** Shots needed to kill, and the resulting time-to-kill in ms. */
export function ttkMs(w, distance, part, health = 100) {
  const dmg = damageAt(w, distance, part);
  const shots = Math.ceil(health / dmg);
  return { shots, ms: ((shots - 1) * 60000) / w.rpm };
}

/**
 * Schedules shots on an absolute clock so a low frame-rate can never reduce the
 * fire rate. Returns the number of shots that should be emitted this frame.
 */
export class FireClock {
  constructor(rpm) {
    this.interval = 60 / rpm;
    this.next = -Infinity;
    this.wasHeld = false;
  }
  setRpm(rpm) {
    this.interval = 60 / rpm;
  }
  /** @returns {number} shots to fire now */
  update(now, triggerHeld, auto, maxCatchUp = 3) {
    if (!triggerHeld) {
      this.wasHeld = false;
      return 0;
    }
    // Semi-auto needs a trigger edge: holding the button must not repeat.
    const wasHeld = this.wasHeld;
    this.wasHeld = true;
    if (!auto && wasHeld) return 0;
    if (now < this.next) return 0;
    if (this.next === -Infinity) {
      this.next = now + this.interval;
      return 1;
    }
    let n = 0;
    while (now >= this.next && n < maxCatchUp) {
      n++;
      this.next += this.interval;
      if (!auto) break;
    }
    if (now > this.next + this.interval * maxCatchUp) this.next = now + this.interval;
    return n;
  }
  release(now) {
    this.wasHeld = false;
    if (this.next !== -Infinity && now > this.next) this.next = -Infinity;
  }
  reset() {
    this.next = -Infinity;
    this.wasHeld = false;
  }
}
