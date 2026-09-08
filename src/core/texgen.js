// Procedural PBR texture synthesis. Zero external assets: every byte of every map
// is computed here. Returns plain Uint8Array RGBA buffers, so this module is
// testable in Node and gets wrapped in THREE.DataTexture on the render side.

import { fbm2D, ridge2D, valueNoise2D, mulberry32, clamp, lerp } from './rng.js';

/** Height field -> tangent-space normal map, wrapped at the edges (seamless). */
export function heightToNormal(height, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = height[y * size + xp] - height[y * size + xm];
      const dy = height[yp * size + x] - height[ym * size + x];
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Ambient occlusion approximated from the height field (cavity darkening). */
export function heightToAO(height, size, radius = 3, strength = 1.0) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = height[y * size + x];
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const sx = (x + dx + size) % size;
          const sy = (y + dy + size) % size;
          sum += height[sy * size + sx];
          n++;
        }
      }
      const avg = sum / n;
      const occ = clamp(1 - Math.max(0, avg - h) * 6 * strength, 0.25, 1);
      const v = occ * 255;
      const i = (y * size + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

function grey(size, fn) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = clamp(fn(x, y), 0, 1) * 255;
      const i = (y * size + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

function rgba(size, fn) {
  const out = new Uint8Array(size * size * 4);
  const c = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x, y, c);
      const i = (y * size + x) * 4;
      out[i] = clamp(c[0], 0, 1) * 255;
      out[i + 1] = clamp(c[1], 0, 1) * 255;
      out[i + 2] = clamp(c[2], 0, 1) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Cracks: a branching random-walk network rasterised into a mask. Ridged noise
 * alone gives worms, not cracks — real cracks are long, thin and connected.
 */
function crackMask(size, seed, count = 10, len = 220) {
  const mask = new Float32Array(size * size);
  const rand = mulberry32(seed);
  const stamp = (x, y, v) => {
    const xi = ((Math.round(x) % size) + size) % size;
    const yi = ((Math.round(y) % size) + size) % size;
    const i = yi * size + xi;
    if (mask[i] < v) mask[i] = v;
  };
  const walk = (x, y, ang, steps, w) => {
    for (let s = 0; s < steps; s++) {
      ang += (rand() - 0.5) * 0.55;
      x += Math.cos(ang);
      y += Math.sin(ang);
      const v = w * (1 - s / steps) ** 0.4;
      stamp(x, y, v);
      if (w > 0.45) {
        stamp(x + Math.cos(ang + 1.57) * 0.7, y + Math.sin(ang + 1.57) * 0.7, v * 0.55);
      }
      if (rand() < 0.012 && w > 0.4) walk(x, y, ang + (rand() < 0.5 ? 1 : -1) * 0.8, steps * 0.35, w * 0.6);
    }
  };
  for (let c = 0; c < count; c++) {
    walk(rand() * size, rand() * size, rand() * Math.PI * 2, len, 0.7 + rand() * 0.3);
  }
  return mask;
}

const SIZE_DEFAULT = 512;

/** Weathered cast concrete: macro mottling + aggregate + pores + crack network. */
export function concrete(size = SIZE_DEFAULT, seed = 11) {
  const h = new Float32Array(size * size);
  const cracks = crackMask(size, seed + 7, 12, 260);
  const s = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      const macro = fbm2D(u * 4, v * 4, 4, 4, 0.55, 2, seed);
      const agg = fbm2D(u * 48, v * 48, 48, 3, 0.5, 2, seed + 3);
      const pore = valueNoise2D(u * 160, v * 160, 160, seed + 5);
      const cr = cracks[y * size + x];
      h[y * size + x] = macro * 0.55 + agg * 0.3 + pore * 0.15 - cr * 0.85;
    }
  }
  const albedo = rgba(size, (x, y, c) => {
    const u = x * s;
    const v = y * s;
    const macro = fbm2D(u * 4, v * 4, 4, 4, 0.55, 2, seed);
    const agg = fbm2D(u * 48, v * 48, 48, 3, 0.5, 2, seed + 3);
    const stain = fbm2D(u * 2.5, v * 2.5, 3, 3, 0.6, 2, seed + 21);
    const cr = cracks[y * size + x];
    let base = 0.40 + macro * 0.16 + agg * 0.07;
    base *= 1 - stain * 0.22;          // rain streak / grime
    base *= 1 - cr * 0.45;             // cracks read darker
    // Warm dust tint, never a pure grey
    c[0] = base * 1.06;
    c[1] = base * 1.005;
    c[2] = base * 0.93;
  });
  const rough = grey(size, (x, y) => {
    const u = x * s;
    const v = y * s;
    const macro = fbm2D(u * 4, v * 4, 4, 4, 0.55, 2, seed);
    const micro = fbm2D(u * 64, v * 64, 64, 2, 0.5, 2, seed + 9);
    const cr = cracks[y * size + x];
    return 0.80 + macro * 0.10 + micro * 0.05 + cr * 0.08 - 0.06;
  });
  return { albedo, normal: heightToNormal(h, size, 2.2), rough, ao: heightToAO(h, size, 3, 1.0), size };
}

/** Wind-rippled desert sand: directional warp + fine grain, low normal amplitude. */
export function sand(size = SIZE_DEFAULT, seed = 31) {
  const h = new Float32Array(size * size);
  const s = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      const warp = fbm2D(u * 3, v * 3, 3, 3, 0.5, 2, seed + 2);
      const ripple = (Math.sin((u * 26 + warp * 3.2) * Math.PI * 2) * 0.5 + 0.5) ** 1.6;
      const grain = valueNoise2D(u * 220, v * 220, 220, seed + 4);
      const dune = fbm2D(u * 1.5, v * 1.5, 2, 3, 0.55, 2, seed);
      h[y * size + x] = dune * 0.45 + ripple * 0.35 + grain * 0.2;
    }
  }
  const albedo = rgba(size, (x, y, c) => {
    const u = x * s;
    const v = y * s;
    const dune = fbm2D(u * 1.5, v * 1.5, 2, 3, 0.55, 2, seed);
    const grain = valueNoise2D(u * 220, v * 220, 220, seed + 4);
    const packed = fbm2D(u * 6, v * 6, 6, 3, 0.5, 2, seed + 12);
    let base = 0.50 + dune * 0.10 + grain * 0.05 - packed * 0.09;
    c[0] = base * 1.14;
    c[1] = base * 0.97;
    c[2] = base * 0.72;
  });
  const rough = grey(size, (x, y) => {
    const u = x * s;
    const v = y * s;
    const packed = fbm2D(u * 6, v * 6, 6, 3, 0.5, 2, seed + 12);
    return 0.90 + valueNoise2D(u * 90, v * 90, 90, seed + 8) * 0.06 - packed * 0.14;
  });
  return { albedo, normal: heightToNormal(h, size, 1.1), rough, ao: heightToAO(h, size, 2, 0.6), size };
}

/** Painted, chipped, scratched metal — barrels, doors, weapon receiver. */
export function paintedMetal(size = SIZE_DEFAULT, seed = 57, tint = [0.32, 0.35, 0.33]) {
  const h = new Float32Array(size * size);
  const s = 1 / size;
  const chip = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      // Anisotropic machining scratches
      const scratch = ridge2D(u * 200, v * 8, 200, 3, seed + 5) ** 3;
      const dents = fbm2D(u * 9, v * 9, 9, 3, 0.55, 2, seed);
      const wear = fbm2D(u * 14, v * 14, 14, 4, 0.6, 2, seed + 17);
      chip[y * size + x] = wear > 0.62 ? clamp((wear - 0.62) * 6, 0, 1) : 0;
      h[y * size + x] = dents * 0.5 + scratch * 0.18 + chip[y * size + x] * 0.32;
    }
  }
  const albedo = rgba(size, (x, y, c) => {
    const u = x * s;
    const v = y * s;
    const dirt = fbm2D(u * 5, v * 5, 5, 3, 0.6, 2, seed + 23);
    const ch = chip[y * size + x];
    const rust = clamp(fbm2D(u * 22, v * 22, 22, 3, 0.5, 2, seed + 31) * ch * 2.1, 0, 1);
    const paint = 1 - dirt * 0.3;
    c[0] = lerp(tint[0] * paint, 0.34, ch) * (1 - rust * 0.35) + rust * 0.30;
    c[1] = lerp(tint[1] * paint, 0.33, ch) * (1 - rust * 0.55) + rust * 0.14;
    c[2] = lerp(tint[2] * paint, 0.32, ch) * (1 - rust * 0.7) + rust * 0.05;
  });
  const rough = grey(size, (x, y) => {
    const u = x * s;
    const v = y * s;
    const grime = fbm2D(u * 5, v * 5, 5, 3, 0.6, 2, seed + 23);
    const scratch = ridge2D(u * 200, v * 8, 200, 3, seed + 5) ** 3;
    const ch = chip[y * size + x];
    return 0.50 + grime * 0.18 - scratch * 0.16 - ch * 0.10;
  });
  const metal = grey(size, (x, y) => chip[y * size + x] * 0.92);
  return { albedo, normal: heightToNormal(h, size, 2.6), rough, ao: heightToAO(h, size, 3, 0.9), metal, size };
}

/** Ballistic nylon / tactical fabric weave. */
export function fabric(size = 256, seed = 77, tint = [0.20, 0.20, 0.17]) {
  const h = new Float32Array(size * size);
  const s = 1 / size;
  const yarn = 46;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      const weave =
        Math.sin((u + v) * yarn * Math.PI) * 0.5 + Math.sin((u - v) * yarn * Math.PI) * 0.5;
      const wrinkle = fbm2D(u * 4, v * 4, 4, 3, 0.55, 2, seed);
      h[y * size + x] = weave * 0.22 + 0.5 + wrinkle * 0.28;
    }
  }
  const albedo = rgba(size, (x, y, c) => {
    const u = x * s;
    const v = y * s;
    const wrinkle = fbm2D(u * 4, v * 4, 4, 3, 0.55, 2, seed);
    const fiber = valueNoise2D(u * 130, v * 130, 130, seed + 6);
    const k = 0.85 + wrinkle * 0.28 + fiber * 0.08;
    c[0] = tint[0] * k;
    c[1] = tint[1] * k;
    c[2] = tint[2] * k;
  });
  const rough = grey(size, (x, y) => {
    const u = x * s;
    const v = y * s;
    return 0.88 + valueNoise2D(u * 130, v * 130, 130, seed + 6) * 0.07 - fbm2D(u * 4, v * 4, 4, 3, 0.55, 2, seed) * 0.09;
  });
  return { albedo, normal: heightToNormal(h, size, 3.4), rough, ao: heightToAO(h, size, 2, 0.7), size };
}

/** Blued gun steel: fine directional polish, low roughness, near-full metalness. */
export function gunMetal(size = 256, seed = 91) {
  const h = new Float32Array(size * size);
  const s = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      const polish = ridge2D(u * 320, v * 5, 320, 2, seed) ** 4;
      const pits = fbm2D(u * 40, v * 40, 40, 3, 0.5, 2, seed + 3);
      h[y * size + x] = 0.5 + polish * 0.25 - pits * 0.12;
    }
  }
  const albedo = rgba(size, (x, y, c) => {
    const u = x * s;
    const v = y * s;
    const wear = fbm2D(u * 12, v * 12, 12, 3, 0.55, 2, seed + 11);
    const k = 0.34 + wear * 0.16;
    c[0] = k * 0.98;
    c[1] = k * 1.0;
    c[2] = k * 1.06; // cold blued tint
  });
  const rough = grey(size, (x, y) => {
    const u = x * s;
    const v = y * s;
    const polish = ridge2D(u * 320, v * 5, 320, 2, seed) ** 4;
    return 0.36 + fbm2D(u * 12, v * 12, 12, 3, 0.55, 2, seed + 11) * 0.12 - polish * 0.14;
  });
  return { albedo, normal: heightToNormal(h, size, 1.6), rough, ao: heightToAO(h, size, 2, 0.5), size };
}

/** Bullet impact decal: crater + radial spall, alpha-masked. RGBA with real alpha. */
export function bulletDecal(size = 128, seed = 5) {
  const out = new Uint8Array(size * size * 4);
  const rand = mulberry32(seed);
  const spikes = [];
  for (let i = 0; i < 18; i++) spikes.push({ a: rand() * Math.PI * 2, l: 0.18 + rand() * 0.3, w: 0.05 + rand() * 0.12 });
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      let a = clamp(1 - r / 0.28, 0, 1) ** 0.6;      // core crater
      for (const sp of spikes) {
        let d = Math.abs(((ang - sp.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < sp.w) a = Math.max(a, clamp(1 - r / sp.l, 0, 1) * (1 - d / sp.w) * 0.85);
      }
      a *= 0.55 + fbm2D(x / size * 12, y / size * 12, 12, 3, 0.5, 2, seed) * 0.9;
      const dark = clamp(1 - r / 0.2, 0, 1);
      const i4 = (y * size + x) * 4;
      const l = 0.30 - dark * 0.24;
      out[i4] = l * 255;
      out[i4 + 1] = l * 250;
      out[i4 + 2] = l * 240;
      out[i4 + 3] = clamp(a, 0, 1) * 255;
    }
  }
  return { albedo: out, size };
}

/** Soft radial sprite used for smoke, dust and muzzle flash billboards. */
export function radialSprite(size = 128, power = 2.2, seed = 3) {
  const out = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x - c) / c, (y - c) / c);
      const n = fbm2D((x / size) * 6, (y / size) * 6, 6, 4, 0.5, 2, seed);
      const a = clamp(1 - r, 0, 1) ** power * (0.55 + n * 0.75);
      const i = (y * size + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 255;
      out[i + 3] = clamp(a, 0, 1) * 255;
    }
  }
  return { albedo: out, size };
}
