// AgX tone mapping. Defined once, here, as numbers.
//
// Both consumers are built from these numbers: the fragment shader injects
// agxGlsl() and the test suite calls agxJs(). That shared definition is the
// only reason a grading mistake can be caught at all, because a fragment
// shader cannot be run from node.
//
// agx() returns LINEAR light. The caller performs the sRGB encode, exactly
// once. Getting that boundary wrong is what made the whole game look like it
// had been shot through milk: the sigmoid output is already display-referred,
// so encoding it a second time displayed a 0.5% grey shadow at 27% brightness
// instead of 2.5%, and the entire image collapsed into the top half of the
// range. The pow(OUTPUT_GAMMA) step below is what returns it to linear.

/** Inset matrix, in GLSL mat3 order: three columns of three. */
export const AGX_IN = [
  0.8424790622, 0.0423282423, 0.0423756549,
  0.0784336000, 0.8784686365, 0.0784336000,
  0.0792237451, 0.0791661275, 0.8791429738,
];

/** Outset matrix, same ordering. */
export const AGX_OUT = [
  1.1968790051, -0.0528968518, -0.0529716355,
  -0.0980208811, 1.1519031299, -0.0980434501,
  -0.0990297441, -0.0989611768, 1.1510736726,
];

/** Sobotka's sigmoid, highest power first. */
export const AGX_CONTRAST = [15.5, -40.14, 31.96, -6.868, 0.4298, 0.1191, -0.00232];

export const MIN_EV = -12.47393;
export const MAX_EV = 4.026069;

/** Saturation restored after the sigmoid, which desaturates as it clips. */
export const PUNCH = 1.28;

/** Per-channel trim, a hair of warmth in the shadows. */
export const CHANNEL_POW = [1.0, 0.98, 0.99];

/**
 * The sigmoid is display-referred. This exponent takes it back to linear so
 * the grade, the vignette and the sRGB encode all happen in the right space.
 */
export const OUTPUT_GAMMA = 2.2;

function mul(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function contrast(x) {
  const c = AGX_CONTRAST;
  const x2 = x * x;
  const x4 = x2 * x2;
  return c[0] * x4 * x2 + c[1] * x4 * x + c[2] * x4
    + c[3] * x2 * x + c[4] * x2 + c[5] * x + c[6];
}

/**
 * Reference implementation of the shader's agx(), on the CPU.
 * @param {number[]} rgb linear light, unbounded above
 * @returns {number[]} linear light, ready for the sRGB encode
 */
export function agxJs(rgb) {
  let col = mul(AGX_IN, rgb.map((c) => Math.max(c, 0)));
  col = col.map((c) => {
    const ev = Math.log2(Math.max(c, 1e-10));
    const clamped = Math.min(Math.max(ev, MIN_EV), MAX_EV);
    return (clamped - MIN_EV) / (MAX_EV - MIN_EV);
  });
  col = col.map(contrast);
  const luma = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
  col = col.map((c) => luma + (c - luma) * PUNCH);
  col = col.map((c, i) => Math.max(c, 0) ** CHANNEL_POW[i]);
  col = mul(AGX_OUT, col);
  return col.map((c) => Math.max(c, 0) ** OUTPUT_GAMMA);
}

/** The sRGB transfer function, matching the encode at the end of the shader. */
export function encodeSrgb(c) {
  const v = Math.min(Math.max(c, 0), 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** What a linear value ends up as on screen, all steps included. */
export function displayValue(linear) {
  return agxJs([linear, linear, linear]).map(encodeSrgb);
}

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** The same transform as GLSL source, generated from the constants above. */
export function agxGlsl() {
  const c = AGX_CONTRAST.map(f);
  return `
    const mat3 AGX_IN = mat3(${AGX_IN.map(f).join(', ')});
    const mat3 AGX_OUT = mat3(${AGX_OUT.map(f).join(', ')});

    vec3 agxContrast(vec3 x) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return ${c[0]} * x4 * x2
           + ${c[1]} * x4 * x
           + ${c[2]} * x4
           + ${c[3]} * x2 * x
           + ${c[4]} * x2
           + ${c[5]} * x
           + ${c[6]};
    }

    vec3 agx(vec3 col) {
      const float MIN_EV = ${f(MIN_EV)};
      const float MAX_EV = ${f(MAX_EV)};
      col = AGX_IN * max(col, vec3(0.0));
      col = clamp(log2(max(col, 1e-10)), MIN_EV, MAX_EV);
      col = (col - MIN_EV) / (MAX_EV - MIN_EV);
      col = agxContrast(col);
      vec3 luma = vec3(dot(col, vec3(0.2126, 0.7152, 0.0722)));
      col = mix(luma, col, ${f(PUNCH)});
      col = pow(max(col, vec3(0.0)), vec3(${CHANNEL_POW.map(f).join(', ')}));
      col = AGX_OUT * col;
      // The sigmoid is display-referred. Return to linear so the caller's
      // single sRGB encode is the only encode in the chain.
      return pow(max(col, vec3(0.0)), vec3(${f(OUTPUT_GAMMA)}));
    }
`;
}
