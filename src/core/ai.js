// Enemy brain: pure state machine + steering decisions. No rendering, no three.js,
// so CI can run whole firefights headless and assert nobody gets stuck in a wall.

import { clamp, mulberry32 } from './rng.js';

export const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  ENGAGE: 'engage',
  RELOAD: 'reload',
  DEAD: 'dead',
};

export const AI_TUNING = {
  sightRange: 62,
  fovCos: Math.cos((100 * Math.PI) / 180 / 2),
  engageRange: 42,
  preferredRange: 14,
  reactionMs: 260,       // delay between seeing and shooting
  burst: [3, 5],
  burstGapMs: [420, 900],
  rpm: 640,
  damage: 9,
  accuracyDeg: 3.2,      // cone half-angle at preferredRange
  speed: 3.1,
  strafeChance: 0.35,
  magSize: 30,
  reloadMs: 2100,
};

/** Can `eye` see `target` — range, field of view, and a caller-supplied LOS test. */
export function canSee(eye, forward, target, losFn, tuning = AI_TUNING) {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist > tuning.sightRange) return { visible: false, dist };
  const inv = 1 / (dist || 1e-6);
  const dot = (dx * inv) * forward[0] + (dy * inv) * forward[1] + (dz * inv) * forward[2];
  if (dot < tuning.fovCos) return { visible: false, dist };
  return { visible: losFn(eye, target), dist };
}

/**
 * One AI tick. `bot` is mutated. Returns an action descriptor the renderer layer
 * turns into bullets/animation — keeping the decision layer testable.
 */
export function tickBot(bot, ctx, dt, tuning = AI_TUNING) {
  if (bot.state === STATE.DEAD) return { fire: 0, move: [0, 0] };
  bot.timer += dt;
  const rand = bot.rand || (bot.rand = mulberry32(bot.seed | 0));

  const sight = ctx.sight; // {visible, dist} computed by caller (needs world LOS)
  let fire = 0;
  let move = [0, 0];

  if (sight.visible) {
    // Enter ALERT once. Re-entering every tick would keep resetting the
    // reaction timer, so the bot would never actually start shooting.
    if (bot.state !== STATE.ENGAGE && bot.state !== STATE.RELOAD && bot.state !== STATE.ALERT) {
      bot.state = STATE.ALERT;
      bot.alertFor = 0;
    }
    bot.lastSeen = ctx.targetPos.slice();
    bot.forgetTimer = 0;
  } else {
    bot.forgetTimer += dt;
  }

  switch (bot.state) {
    case STATE.IDLE:
    case STATE.PATROL: {
      move = bot.patrolDir || [0, 0];
      break;
    }
    case STATE.ALERT: {
      bot.alertFor += dt;
      if (bot.alertFor * 1000 >= tuning.reactionMs) bot.state = STATE.ENGAGE;
      break;
    }
    case STATE.ENGAGE: {
      if (bot.ammo <= 0) {
        bot.state = STATE.RELOAD;
        bot.reloadT = 0;
        break;
      }
      if (!sight.visible && bot.forgetTimer > 3.0) {
        bot.state = STATE.PATROL;
        break;
      }
      // Keep preferred distance, strafe sometimes so they are not static targets.
      const err = sight.dist - tuning.preferredRange;
      move = [clamp(err / 10, -1, 1), bot.strafe];
      if (bot.timer > bot.nextStrafe) {
        bot.strafe = rand() < tuning.strafeChance ? (rand() < 0.5 ? -1 : 1) : 0;
        bot.nextStrafe = bot.timer + 0.6 + rand() * 1.4;
      }
      if (sight.visible && sight.dist <= tuning.engageRange) {
        if (bot.burstLeft <= 0 && bot.timer >= bot.nextBurst) {
          const [b0, b1] = tuning.burst;
          bot.burstLeft = b0 + Math.floor(rand() * (b1 - b0 + 1));
        }
        if (bot.burstLeft > 0 && bot.timer >= bot.nextShot) {
          fire = 1;
          bot.burstLeft--;
          bot.ammo--;
          bot.nextShot = bot.timer + 60 / tuning.rpm;
          if (bot.burstLeft === 0) {
            const [g0, g1] = tuning.burstGapMs;
            bot.nextBurst = bot.timer + (g0 + rand() * (g1 - g0)) / 1000;
          }
        }
      }
      break;
    }
    case STATE.RELOAD: {
      bot.reloadT += dt;
      if (bot.reloadT * 1000 >= tuning.reloadMs) {
        bot.ammo = tuning.magSize;
        bot.state = sight.visible ? STATE.ENGAGE : STATE.PATROL;
      }
      break;
    }
  }
  return { fire, move };
}

export function makeBot(id, pos, seed) {
  return {
    id,
    pos: pos.slice(),
    vel: [0, 0, 0],
    yaw: 0,
    hp: 100,
    state: STATE.PATROL,
    seed,
    timer: 0,
    alertFor: 0,
    forgetTimer: 99,
    lastSeen: null,
    ammo: AI_TUNING.magSize,
    burstLeft: 0,
    nextShot: 0,
    nextBurst: 0,
    nextStrafe: 0,
    strafe: 0,
    reloadT: 0,
    patrolDir: [0, 0],
  };
}

/** Damage application with limb multipliers; returns true if this shot killed. */
export function damageBot(bot, amount) {
  if (bot.state === STATE.DEAD) return false;
  bot.hp -= amount;
  if (bot.hp <= 0) {
    bot.hp = 0;
    bot.state = STATE.DEAD;
    return true;
  }
  // Being shot at instantly promotes to ENGAGE — no free wallbangs on a napping bot.
  if (bot.state === STATE.IDLE || bot.state === STATE.PATROL) {
    bot.state = STATE.ALERT;
    bot.alertFor = 0;
  }
  return false;
}
