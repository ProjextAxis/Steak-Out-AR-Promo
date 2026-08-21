/*
 * imageops.js — greyscale image pipeline used to simulate what a phone camera
 * actually sees when it looks at the PRINTED Steak Out flyer.
 *
 * Everything works on a plain { data: Float32Array, width, height } buffer of
 * 0..255 greyscale samples. Float, not Uint8, so a chain of operations does not
 * accumulate rounding error; it is quantised once on the way out.
 *
 * Why greyscale: MindAR's compiler throws colour away immediately —
 * compiler-base.js reduces every pixel to (R + G + B) / 3 before it detects a
 * single feature. Simulating in grey is therefore not a shortcut, it is exactly
 * the signal the compiler sees.
 *
 * MUST load images through mind-ar's OWN nested `canvas` copy. An Image from a
 * different canvas install is rejected with "Image or Canvas expected".
 */
const fs = require('fs');
const { loadImage, createCanvas } = require('./resolve-mindar.js').canvas;

/** Load any image file as a greyscale buffer, matching MindAR's (R+G+B)/3. */
async function loadGrey(path) {
  const img = await loadImage(path);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, img.width, img.height);
  const rgba = ctx.getImageData(0, 0, img.width, img.height).data;

  const data = new Float32Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) {
    const o = i * 4;
    data[i] = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
  }
  return { data, width: img.width, height: img.height };
}

/** Write a greyscale buffer out as an 8-bit RGB PNG (R = G = B, so the
 *  compiler's (R+G+B)/3 recovers these exact values). */
function saveGrey(image, path) {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(image.width, image.height);
  for (let i = 0; i < image.data.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(image.data[i])));
    const o = i * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
    out.data[o + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  fs.writeFileSync(path, canvas.toBuffer('image/png'));
  return path;
}

const clone = (image) => ({
  data: Float32Array.from(image.data),
  width: image.width,
  height: image.height
});

const sample = (image, x, y) => {
  // bilinear, clamped at the border
  const { data, width, height } = image;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const a = data[y0 * width + x0], b = data[y0 * width + x1];
  const c = data[y1 * width + x0], d = data[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
};

/* ---------------------------------------------------------------- geometry */

/** Area-averaged downscale (box filter). Correct minification — a plain
 *  bilinear resample aliases badly and would invent detail the print has not
 *  got, flattering the feature counts. */
function resize(image, outW, outH) {
  outW = Math.max(1, Math.round(outW));
  outH = Math.max(1, Math.round(outH));
  const { data, width, height } = image;
  const out = new Float32Array(outW * outH);
  const sx = width / outW;
  const sy = height / outH;

  for (let y = 0; y < outH; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    const iy0 = Math.floor(y0), iy1 = Math.min(height, Math.ceil(y1));
    for (let x = 0; x < outW; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      const ix0 = Math.floor(x0), ix1 = Math.min(width, Math.ceil(x1));
      let acc = 0, wsum = 0;
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const w = wx * wy;
          acc += data[yy * width + xx] * w;
          wsum += w;
        }
      }
      out[y * outW + x] = wsum > 0 ? acc / wsum : sample(image, x0, y0);
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Scale so the LONG edge equals `longEdge`, preserving aspect. */
function resizeLongEdge(image, longEdge) {
  const s = longEdge / Math.max(image.width, image.height);
  return resize(image, image.width * s, image.height * s);
}

/** Solve the 3x3 homography taking the unit-ish src quad to the dst quad.
 *  Plain Gaussian elimination on the 8x8 system; no dependency needed. */
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i], [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col];
    for (let c = col; c < 8; c++) A[col][c] /= d;
    b[col] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
}

const applyH = (H, x, y) => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

/**
 * Perspective skew: tilt the flyer as if photographed off-axis.
 *
 * `tiltX` leans the top edge away (rotation about the horizontal axis),
 * `tiltY` leans the left edge away. Both are in degrees. The result is
 * re-cropped to the same canvas size, so the marker stays fully framed —
 * which is what a compiled target needs.
 *
 * `background` fills anything that maps outside the source (paper white).
 */
function perspective(image, { tiltX = 0, tiltY = 0, background = 255 } = {}) {
  const { width: w, height: h } = image;
  const kx = Math.tan((tiltX * Math.PI) / 180) * 0.5;
  const ky = Math.tan((tiltY * Math.PI) / 180) * 0.5;

  // Foreshorten the far edge; keep the near edge full width.
  let dst = [
    [0 + w * kx, 0 + h * ky],
    [w - w * kx, 0],
    [w, h - h * ky],
    [0, h]
  ];
  if (kx < 0 || ky < 0) {
    dst = [
      [0, 0],
      [w, 0 - h * ky],
      [w + w * kx, h],
      [0 - w * kx, h - h * ky]
    ];
  }

  // Normalise the warped quad back into the frame so nothing is cropped off.
  const xs = dst.map((p) => p[0]), ys = dst.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = w / (maxX - minX), sy = h / (maxY - minY);
  dst = dst.map(([x, y]) => [(x - minX) * sx, (y - minY) * sy]);

  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const Hinv = homography(dst, src); // inverse map: dst pixel -> src pixel

  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = applyH(Hinv, x + 0.5, y + 0.5);
      out[y * w + x] =
        u < 0 || v < 0 || u >= w || v >= h ? background : sample(image, u - 0.5, v - 0.5);
    }
  }
  return { data: out, width: w, height: h };
}

/* -------------------------------------------------------------- photometry */

/**
 * Contrast compression — the single most important print effect.
 *
 * Pure digital artwork spans 0..255. Ink on uncoated stock under a restaurant's
 * warm downlights does not: the blacks lift (ink is never 0, and ambient light
 * scatters into them) and the whites drop (paper is not a perfect diffuser and
 * the camera meters for the room, not the page).
 *
 * `black`/`white` are the output levels that 0 and 255 land on.
 */
function contrast(image, { black = 40, white = 215 } = {}) {
  const out = clone(image);
  const span = (white - black) / 255;
  for (let i = 0; i < out.data.length; i++) out.data[i] = black + out.data[i] * span;
  return out;
}

/** Ops take either a bare number or {name: number}, so a recipe can read either
 *  way without silently producing NaN. */
const scalarArg = (arg, key, fallback) => {
  if (arg === undefined || arg === null) return fallback;
  if (typeof arg === 'number') return arg;
  const v = arg[key];
  return typeof v === 'number' ? v : fallback;
};

/** Gamma shift. <1 brightens midtones (a bright overhead wash), >1 darkens. */
function gamma(image, arg = 1.0) {
  const g = scalarArg(arg, 'gamma', 1.0);
  const out = clone(image);
  const inv = 1 / g;
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = 255 * Math.pow(Math.max(0, out.data[i]) / 255, inv);
  }
  return out;
}

/** Flat exposure lift/cut in 0..255 levels. */
function brightness(image, arg = 0) {
  const delta = scalarArg(arg, 'delta', 0);
  const out = clone(image);
  for (let i = 0; i < out.data.length; i++) out.data[i] = out.data[i] + delta;
  return out;
}

/** Clamp to the representable 0..255 range. Applied at the end of every
 *  pipeline so the reported stats describe the PNG that actually gets written,
 *  not the unbounded float intermediate. */
function clamp(image) {
  const out = clone(image);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = Math.max(0, Math.min(255, out.data[i]));
  }
  return out;
}

/**
 * Specular glare: an elliptical highlight blown across part of the sheet, as a
 * ceiling light or window reflects off semi-gloss stock. Additive and clipped,
 * so it genuinely destroys local contrast where it lands rather than merely
 * brightening it.
 *
 * cx/cy are fractions of width/height; radius is a fraction of the long edge.
 */
function glare(image, { cx = 0.35, cy = 0.3, radius = 0.45, strength = 110, aspect = 1.6 } = {}) {
  const out = clone(image);
  const { width: w, height: h } = image;
  const px = cx * w, py = cy * h;
  const r = radius * Math.max(w, h);
  const rx = r * aspect, ry = r;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - px) / rx, dy = (y - py) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const falloff = Math.pow(1 - d2, 2); // smooth, no hard rim
      out.data[y * w + x] += strength * falloff;
    }
  }
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.min(255, out.data[i]);
  return out;
}

/** True separable Gaussian blur — camera defocus and hand-motion smear. */
function blur(image, sigma) {
  if (!sigma || sigma <= 0) return clone(image);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width: w, height: h } = image;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.max(0, Math.min(w - 1, x + k));
        acc += image.data[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.max(0, Math.min(h - 1, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Unsharp mask. Included because the obvious intuition — "compile from
 * something that looks like the print" — may be backwards.
 *
 * Two facts pull the other way. Tracking points are only selected where the
 * local 13x13 standard deviation clears SD_THRESH = 8 (tracker/extract.js), so
 * a flatter source yields FEWER points. And the tracker scores them by
 * NORMALISED cross-correlation, which is invariant to any affine change in
 * brightness and contrast — so a crisp, high-contrast template costs nothing
 * when matched against a washed-out photo of the print. If both hold, sharper
 * beats print-like. Worth measuring rather than assuming.
 */
function sharpen(image, { amount = 1.0, sigma = 1.5 } = {}) {
  const blurred = blur(image, sigma);
  const out = clone(image);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = out.data[i] + amount * (out.data[i] - blurred.data[i]);
  }
  return out;
}

/** Expand contrast about mid-grey — the inverse of the `contrast` op. */
function expand(image, { factor = 1.4, pivot = 128 } = {}) {
  const out = clone(image);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = pivot + (out.data[i] - pivot) * factor;
  }
  return out;
}

/** Hard threshold to pure black and white. */
function binarize(image, { threshold = 128 } = {}) {
  const out = clone(image);
  for (let i = 0; i < out.data.length; i++) out.data[i] = out.data[i] >= threshold ? 255 : 0;
  return out;
}

/** Deterministic sensor noise (seeded, so every run is reproducible). */
function noise(image, { sigma = 3, seed = 1 } = {}) {
  const out = clone(image);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    // xorshift32 -> uniform in [0,1)
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < out.data.length; i++) {
    // Box-Muller for a proper normal distribution
    const u = Math.max(1e-9, rnd());
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
    out.data[i] += g * sigma;
  }
  return out;
}

/** Paste `src` onto a `bg`-filled canvas of the given size, top-left at x,y. */
function canvasPaste(src, { width, height, x = 0, y = 0, background = 128 }) {
  const data = new Float32Array(width * height).fill(background);
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= width) continue;
      data[dy * width + dx] = src.data[sy * src.width + sx];
    }
  }
  return { data, width, height };
}

/** Simple descriptive stats, handy for sanity-checking a simulated variant. */
function stats(image) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < image.data.length; i++) {
    const v = image.data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / image.data.length;
  let varAcc = 0;
  for (let i = 0; i < image.data.length; i++) {
    const d = image.data[i] - mean;
    varAcc += d * d;
  }
  return {
    min: +min.toFixed(1),
    max: +max.toFixed(1),
    mean: +mean.toFixed(1),
    rms: +Math.sqrt(varAcc / image.data.length).toFixed(1)
  };
}

module.exports = {
  loadGrey, saveGrey, clone, sample, stats, clamp,
  resize, resizeLongEdge, perspective, homography, applyH,
  contrast, gamma, brightness, glare, blur, noise, canvasPaste,
  sharpen, expand, binarize
};
