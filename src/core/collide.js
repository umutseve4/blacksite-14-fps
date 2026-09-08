// Player physics: swept vertical-cylinder vs axis-aligned boxes, with sliding,
// step-up and ground snapping. Pure math so the walk simulation in CI can run it
// headless at a fixed timestep.

import { clamp } from './rng.js';

/** @typedef {{min:[number,number,number], max:[number,number,number], tag?:string}} Box */

export function makeBox(cx, cy, cz, sx, sy, sz, tag = 'world') {
  return {
    min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
    max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
    tag,
  };
}

/** Uniform grid broadphase. Rebuilt once at level load; queried every substep. */
export class BoxGrid {
  constructor(boxes, cell = 6) {
    this.cell = cell;
    this.boxes = boxes;
    this.map = new Map();
    boxes.forEach((b, i) => {
      const x0 = Math.floor(b.min[0] / cell);
      const x1 = Math.floor(b.max[0] / cell);
      const z0 = Math.floor(b.min[2] / cell);
      const z1 = Math.floor(b.max[2] / cell);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = x + ',' + z;
          let arr = this.map.get(k);
          if (!arr) this.map.set(k, (arr = []));
          arr.push(i);
        }
      }
    });
  }
  /** Indices of boxes overlapping the XZ range. */
  query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    const c = this.cell;
    const seen = new Set();
    for (let x = Math.floor(minX / c); x <= Math.floor(maxX / c); x++) {
      for (let z = Math.floor(minZ / c); z <= Math.floor(maxZ / c); z++) {
        const arr = this.map.get(x + ',' + z);
        if (!arr) continue;
        for (const i of arr) {
          if (!seen.has(i)) {
            seen.add(i);
            out.push(i);
          }
        }
      }
    }
    return out;
  }
}

/**
 * True when the vertical cylinder (centre `p` = feet position, radius r, height h)
 * intersects box `b`. Cylinder is approximated by its circular XZ footprint —
 * exact for the vertical extent, conservative-free for the horizontal one.
 */
export function cylinderHitsBox(p, r, h, b) {
  if (p[1] + h <= b.min[1] || p[1] >= b.max[1]) return false;
  const cx = clamp(p[0], b.min[0], b.max[0]);
  const cz = clamp(p[2], b.min[2], b.max[2]);
  const dx = p[0] - cx;
  const dz = p[2] - cz;
  return dx * dx + dz * dz < r * r;
}

/** Names the first box the cylinder is inside of, or null. */
export function blocked(p, r, h, boxes, grid) {
  const idx = grid
    ? grid.query(p[0] - r, p[2] - r, p[0] + r, p[2] + r)
    : boxes.map((_, i) => i);
  for (const i of idx) {
    if (cylinderHitsBox(p, r, h, boxes[i])) return boxes[i];
  }
  return null;
}

const STEP_HEIGHT = 0.42;

/**
 * Moves the body by `delta` with axis-separated sliding, so hitting a wall at an
 * angle preserves the tangential component instead of stopping the player dead.
 * Also attempts a step-up over ledges <= STEP_HEIGHT.
 * Mutates and returns `p`.
 */
export function moveWithSlide(p, delta, r, h, boxes, grid) {
  // Substep so a large delta (low frame rate, or a launch) can never step over a
  // thin wall: each substep is at most half a body radius.
  const len = Math.hypot(delta[0], delta[2]);
  const maxStep = r * 0.5;
  if (len > maxStep) {
    const n = Math.min(64, Math.ceil(len / maxStep));
    const sub = [delta[0] / n, 0, delta[2] / n];
    for (let i = 0; i < n; i++) moveWithSlide(p, sub, r, h, boxes, grid);
    return p;
  }
  const order = Math.abs(delta[0]) > Math.abs(delta[2]) ? [0, 2] : [2, 0];
  for (const axis of order) {
    if (delta[axis] === 0) continue;
    const before = p[axis];
    p[axis] += delta[axis];
    const hit = blocked(p, r, h, boxes, grid);
    if (hit) {
      // Try stepping up onto low obstacles (kerbs, sandbags, crates).
      const stepTop = hit.max[1];
      const rise = stepTop - p[1];
      if (rise > 0 && rise <= STEP_HEIGHT) {
        const y0 = p[1];
        p[1] = stepTop + 1e-3;
        if (!blocked(p, r, h, boxes, grid)) continue; // step succeeded
        p[1] = y0;
      }
      p[axis] = before;
    }
  }
  return p;
}

/** Vertical integration with ground snap. Returns {onGround, vy}. */
export function moveVertical(p, vy, dt, gravity, r, h, boxes, grid) {
  let onGround = false;
  vy += gravity * dt;
  p[1] += vy * dt;
  const hit = blocked(p, r, h, boxes, grid);
  if (hit) {
    if (vy <= 0) {
      p[1] = hit.max[1];
      onGround = true;
    } else {
      p[1] = hit.min[1] - h - 1e-3;
    }
    vy = 0;
  }
  if (p[1] <= 0) {
    p[1] = 0;
    vy = 0;
    onGround = true;
  }
  return { vy, onGround };
}

/** Slab method: ray vs AABB. Returns entry distance or Infinity. */
export function rayBox(o, d, b) {
  let t0 = 0;
  let t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < b.min[i] || o[i] > b.max[i]) return Infinity;
    } else {
      const inv = 1 / d[i];
      let ta = (b.min[i] - o[i]) * inv;
      let tb = (b.max[i] - o[i]) * inv;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}

/** Face normal of box `b` at hit point `pt` (largest relative axis offset wins). */
export function boxNormalAt(pt, b) {
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const ex = (b.max[0] - b.min[0]) / 2 || 1e-6;
  const ey = (b.max[1] - b.min[1]) / 2 || 1e-6;
  const ez = (b.max[2] - b.min[2]) / 2 || 1e-6;
  const dx = (pt[0] - cx) / ex;
  const dy = (pt[1] - cy) / ey;
  const dz = (pt[2] - cz) / ez;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ax >= ay && ax >= az) return [Math.sign(dx) || 1, 0, 0];
  if (ay >= az) return [0, Math.sign(dy) || 1, 0];
  return [0, 0, Math.sign(dz) || 1];
}

/** Closest world hit along a ray. */
export function raycastWorld(o, d, boxes, maxDist = 300) {
  let best = maxDist;
  let hitBox = null;
  for (const b of boxes) {
    const t = rayBox(o, d, b);
    if (t < best) {
      best = t;
      hitBox = b;
    }
  }
  if (!hitBox) return null;
  const pt = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
  return { t: best, point: pt, box: hitBox, normal: boxNormalAt(pt, hitBox) };
}
