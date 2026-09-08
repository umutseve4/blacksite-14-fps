// Level definition: "Blacksite 14", a desert forward-operating compound.
// Everything is axis-aligned so the AABB collision is exact rather than
// approximate — a deliberate design constraint, not a shortcut.
// Pure data: CI loads this to prove the playable space is one connected region.

export const ARENA = 108;      // metres, square
export const WALL_H = 6.5;

const P = [];
const push = (o) => (P.push(o), o);

/** box(x,y,z,sx,sy,sz,mat) — y is the CENTRE height. */
const box = (x, y, z, sx, sy, sz, mat, opts = {}) =>
  push({ kind: 'box', x, y, z, sx, sy, sz, mat, solid: opts.solid !== false, ...opts });

// ---------------------------------------------------------------- perimeter
const H = ARENA / 2;
box(0, WALL_H / 2, -H, ARENA, WALL_H, 1.2, 'concrete');
box(0, WALL_H / 2, H, ARENA, WALL_H, 1.2, 'concrete');
box(-H, WALL_H / 2, 0, 1.2, WALL_H, ARENA, 'concrete');
box(H, WALL_H / 2, 0, 1.2, WALL_H, ARENA, 'concrete');
// buttresses, so the wall is not one flat extruded rectangle
for (let i = -4; i <= 4; i++) {
  box(i * 11, 2.2, -H + 1.0, 1.0, 4.4, 0.9, 'concrete');
  box(i * 11, 2.2, H - 1.0, 1.0, 4.4, 0.9, 'concrete');
  box(-H + 1.0, 2.2, i * 11, 0.9, 4.4, 1.0, 'concrete');
  box(H - 1.0, 2.2, i * 11, 0.9, 4.4, 1.0, 'concrete');
}

// ---------------------------------------------------------------- buildings
/**
 * Hollow building with a doorway on one side. Walls are separate boxes so you
 * can walk in, and the roof is solid so you can be shot at from the tower.
 */
function building(cx, cz, w, d, h, door, mat = 'concrete', tag = 'bldg') {
  const t = 0.45;
  const doorW = 1.9;
  const lintel = 2.35;
  const sides = [
    { ax: 'x', sign: -1 },
    { ax: 'x', sign: 1 },
    { ax: 'z', sign: -1 },
    { ax: 'z', sign: 1 },
  ];
  for (const s of sides) {
    const isDoor = door === `${s.ax}${s.sign > 0 ? '+' : '-'}`;
    if (s.ax === 'x') {
      const x = cx + (s.sign * (w / 2 - t / 2));
      if (!isDoor) {
        box(x, h / 2, cz, t, h, d, mat, { tag });
      } else {
        const seg = (d - doorW) / 2;
        box(x, h / 2, cz - (doorW / 2 + seg / 2), t, h, seg, mat, { tag });
        box(x, h / 2, cz + (doorW / 2 + seg / 2), t, h, seg, mat, { tag });
        box(x, (h + lintel) / 2, cz, t, h - lintel, doorW, mat, { tag });
      }
    } else {
      const z = cz + (s.sign * (d / 2 - t / 2));
      if (!isDoor) {
        box(cx, h / 2, z, w, h, t, mat, { tag });
      } else {
        const seg = (w - doorW) / 2;
        box(cx - (doorW / 2 + seg / 2), h / 2, z, seg, h, t, mat, { tag });
        box(cx + (doorW / 2 + seg / 2), h / 2, z, seg, h, t, mat, { tag });
        box(cx, (h + lintel) / 2, z, doorW, h - lintel, t, mat, { tag });
      }
    }
  }
  box(cx, h + 0.15, cz, w, 0.3, d, mat, { tag: tag + '_roof' });
  // parapet
  box(cx, h + 0.75, cz - d / 2 + 0.15, w, 0.9, 0.3, mat, { tag });
  box(cx, h + 0.75, cz + d / 2 - 0.15, w, 0.9, 0.3, mat, { tag });
  box(cx - w / 2 + 0.15, h + 0.75, cz, 0.3, 0.9, d, mat, { tag });
  box(cx + w / 2 - 0.15, h + 0.75, cz, 0.3, 0.9, d, mat, { tag });
}

building(-30, -28, 16, 13, 4.2, 'z+');
building(26, -30, 14, 12, 4.0, 'x-');
building(-32, 26, 18, 14, 4.6, 'x+');
building(30, 28, 15, 15, 4.2, 'z-');
building(2, -6, 12, 10, 5.0, 'z+');   // central admin block

// staircases (ramps built from steps) up to the roofs — real vertical gameplay
function stairs(x, z, dir, steps = 11, rise = 0.4, run = 0.62, w = 2.2) {
  for (let i = 0; i < steps; i++) {
    const h = (i + 1) * rise;
    if (dir === 'x') box(x + i * run, h / 2, z, run, h, w, 'concrete', { tag: 'stair' });
    else box(x, h / 2, z + i * run, w, h, run, 'concrete', { tag: 'stair' });
  }
}
stairs(-40, -20, 'x', 11);
stairs(20, 24, 'z', 12);
stairs(10, -8, 'x', 13);

// ---------------------------------------------------------------- watchtower
box(-6, 0.5, 34, 6, 1.0, 6, 'concrete', { tag: 'tower' });
for (const [dx, dz] of [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]]) {
  box(-6 + dx, 4.5, 34 + dz, 0.5, 8, 0.5, 'metal', { tag: 'tower' });
}
box(-6, 8.6, 34, 7, 0.3, 7, 'metal', { tag: 'tower_deck' });
box(-6, 9.3, 30.7, 7, 1.1, 0.25, 'metal', { tag: 'tower' });
box(-6, 9.3, 37.3, 7, 1.1, 0.25, 'metal', { tag: 'tower' });
box(-9.4, 9.3, 34, 0.25, 1.1, 7, 'metal', { tag: 'tower' });
stairs(-6, 26, 'z', 20, 0.42, 0.42, 2.0);

// ---------------------------------------------------------------- containers
const CONTAINER_TINTS = [
  [0.42, 0.20, 0.16],
  [0.15, 0.30, 0.34],
  [0.36, 0.33, 0.16],
  [0.20, 0.26, 0.19],
];
function container(x, y, z, rotY, tint) {
  box(x, y + 1.3, z, rotY ? 2.44 : 6.1, 2.6, rotY ? 6.1 : 2.44, 'container', { tint, tag: 'container' });
}
container(-14, 0, 6, 0, CONTAINER_TINTS[0]);
container(-14, 2.6, 6, 0, CONTAINER_TINTS[1]);
container(-20, 0, 12, 1, CONTAINER_TINTS[2]);
container(16, 0, 4, 1, CONTAINER_TINTS[3]);
container(16, 2.6, 4, 1, CONTAINER_TINTS[0]);
container(34, 0, -6, 0, CONTAINER_TINTS[1]);
container(-38, 0, 2, 0, CONTAINER_TINTS[2]);
container(4, 0, 22, 0, CONTAINER_TINTS[3]);
container(-4, 0, 44, 1, CONTAINER_TINTS[1]);
container(40, 0, 34, 0, CONTAINER_TINTS[2]);
container(-40, 0, -44, 1, CONTAINER_TINTS[0]);

// ---------------------------------------------------------------- sandbags
function sandbagLine(x, z, len, axis) {
  for (let i = 0; i < len; i++) {
    const o = (i - (len - 1) / 2) * 1.1;
    const h = i % 2 === 0 ? 1.05 : 0.95;
    if (axis === 'x') box(x + o, h / 2, z, 1.05, h, 0.85, 'sandbag', { tag: 'cover' });
    else box(x, h / 2, z + o, 0.85, h, 1.05, 'sandbag', { tag: 'cover' });
  }
}
sandbagLine(-2, 14, 7, 'x');
sandbagLine(22, 12, 6, 'z');
sandbagLine(-24, -10, 6, 'x');
sandbagLine(12, -20, 5, 'z');
sandbagLine(-16, 34, 6, 'x');
sandbagLine(36, 16, 5, 'x');

// ---------------------------------------------------------------- crates/barrels
function crate(x, y, z, s = 1.1, mat = 'crate') {
  box(x, y + s / 2, z, s, s, s, mat, { tag: 'crate' });
}
const CRATES = [
  [-8, 0, 18], [-8, 1.1, 18], [-6.6, 0, 18.4], [24, 0, -12], [25.2, 0, -12.6],
  [24.4, 1.1, -12.2], [-28, 0, 8], [-26.8, 0, 8.5], [8, 0, 36], [9.2, 0, 36],
  [8.6, 1.1, 36], [-36, 0, -8], [42, 0, 12], [-44, 0, 22], [18, 0, 44], [-18, 0, -40],
  [30, 0, -22], [31.1, 0, -22.4],
];
CRATES.forEach(([x, y, z]) => crate(x, y, z));

const BARRELS = [
  [-11, 22], [-10, 23.1], [20, -4], [21, -3.2], [-30, 14], [38, -14], [6, 30],
  [-42, -14], [14, 16], [-20, -22], [44, 4], [-6, -30], [27, 20], [-34, 40],
];
BARRELS.forEach(([x, z], i) =>
  push({ kind: 'barrel', x, y: 0, z, r: 0.32, h: 0.95, mat: 'barrel', explosive: i % 3 === 0, tag: 'barrel' })
);

// pipes / conduits along walls (silhouette breakup)
for (let i = 0; i < 6; i++) {
  box(-H + 1.9, 4.2, -40 + i * 16, 0.18, 0.18, 15, 'metal', { tag: 'pipe', solid: false });
}

// awnings — thin overhangs that catch the sun and cast long shadows
box(-30, 4.6, -20.5, 16, 0.16, 3.2, 'metal', { tag: 'awning' });
box(26, 4.4, -23.5, 14, 0.16, 3.0, 'metal', { tag: 'awning' });
box(2, 5.4, 0.2, 12, 0.16, 3.4, 'metal', { tag: 'awning' });

// antenna masts (vertical interest, thin geometry for AA testing)
for (const [x, z, h] of [[-32, 26, 7], [30, 28, 6], [-6, 34, 5]]) {
  push({ kind: 'mast', x, z, y: 0, h, tag: 'mast' });
}

export const PROPS = P;

/** Solid AABBs used by physics and hitscan. */
export function collisionBoxes() {
  const out = [];
  for (const p of PROPS) {
    if (p.solid === false) continue;
    if (p.kind === 'box') {
      out.push({
        min: [p.x - p.sx / 2, p.y - p.sy / 2, p.z - p.sz / 2],
        max: [p.x + p.sx / 2, p.y + p.sy / 2, p.z + p.sz / 2],
        tag: p.tag || p.mat,
        mat: p.mat,
        prop: p,
      });
    } else if (p.kind === 'barrel') {
      out.push({
        min: [p.x - p.r, p.y, p.z - p.r],
        max: [p.x + p.r, p.y + p.h, p.z + p.r],
        tag: 'barrel',
        mat: 'barrel',
        explosive: !!p.explosive,
        prop: p,
      });
    }
  }
  // ground plane as a thin slab, so raycasts always terminate on something
  out.push({ min: [-H, -1, -H], max: [H, 0, H], tag: 'ground', mat: 'sand' });
  return out;
}

export const SPAWN = { x: 0, y: 0, z: 40, yaw: Math.PI };

export const BOT_SPAWNS = [
  [-30, -24], [26, -26], [-30, 24], [28, 26], [2, -2], [-14, 10], [18, 8],
  [-10, 30], [34, -4], [-40, 6], [10, 34], [-20, -14],
];

export const AMMO_CRATES = [
  [0, 30], [-28, 0], [28, 0], [0, -24],
];
