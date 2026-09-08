// Deterministic pseudo-random utilities. Pure, no DOM, no three.js — unit tested in CI.

/** Mulberry32 PRNG. Same seed => same stream, on every machine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0,1). Used for tileable value noise lattices. */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const smoothstep = (t) => t * t * (3 - 2 * t);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Tileable value noise on a `period`-sized lattice.
 * Wrapping the lattice indices (not the sample coords) is what makes it seamless.
 */
export function valueNoise2D(x, y, period, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const u = smoothstep(xf);
  const v = smoothstep(yf);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x1, y0, seed);
  const n01 = hash2(x0, y1, seed);
  const n11 = hash2(x1, y1, seed);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

/** Tileable fBm. `period` doubles per octave so every octave stays seamless. */
export function fbm2D(x, y, period, octaves = 5, gain = 0.5, lacunarity = 2, seed = 0) {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let p = period;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * f, y * f, p, seed + o * 131);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
    p *= lacunarity;
  }
  return sum / norm;
}

/** Tileable ridged noise — used for cracks and wind streaks. */
export function ridge2D(x, y, period, octaves = 4, seed = 0) {
  return 1 - Math.abs(fbm2D(x, y, period, octaves, 0.5, 2, seed) * 2 - 1);
}
