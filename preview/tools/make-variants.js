/*
 * make-variants.js — render "what the camera actually sees" versions of the
 * printed Steak Out flyer, so the tracking target can be compiled from
 * something closer to reality than the pristine digital artwork.
 *
 *   cd <mindc dir>   # where node_modules lives
 *   node <repo>/tools/make-variants.js <repo>/assets/steakout-marker.png <outdir>
 *
 * Ops are applied in the order the physics happens:
 *   perspective (how the sheet is held)
 *     -> contrast (ink on paper)
 *     -> gamma / brightness (room lighting)
 *     -> glare (specular reflection off the stock)
 *     -> blur (lens defocus and hand motion)
 *     -> resize (sensor sampling)
 *     -> noise (sensor read noise)
 *
 * Every variant is deterministic: same input, same output, every run.
 */
const fs = require('fs');
const path = require('path');
const ops = require('./lib/imageops.js');

/* Reference: the source artwork is 1038x1515. `longEdge` values below are
 * expressed in absolute pixels on the long (1515px) edge. */
const VARIANTS = [
  /* ---- baselines ------------------------------------------------------- */
  {
    name: 'v00-pristine',
    note: 'Untouched artwork, grayscaled the same way the compiler does. Reproduces the currently shipped target.',
    pipeline: []
  },
  {
    name: 'v01-grey-only',
    note: 'Explicit grayscale pass and nothing else. Tests whether pre-greyscaling buys anything.',
    pipeline: [{ op: 'brightness', args: { delta: 0 } }]
  },

  /* ---- source resolution ----------------------------------------------- */
  {
    name: 'v10-res1200',
    note: 'Downscaled to a 1200px long edge.',
    pipeline: [{ op: 'resizeLongEdge', args: 1200 }]
  },
  {
    name: 'v11-res1024',
    note: 'Downscaled to a 1024px long edge.',
    pipeline: [{ op: 'resizeLongEdge', args: 1024 }]
  },
  {
    name: 'v12-res800',
    note: 'Downscaled to an 800px long edge.',
    pipeline: [{ op: 'resizeLongEdge', args: 800 }]
  },
  {
    name: 'v13-res640',
    note: 'Downscaled to a 640px long edge, close to the phone camera working resolution.',
    pipeline: [{ op: 'resizeLongEdge', args: 640 }]
  },
  {
    name: 'v14-res512',
    note: 'Downscaled to a 512px long edge.',
    pipeline: [{ op: 'resizeLongEdge', args: 512 }]
  },

  /* ---- contrast -------------------------------------------------------- */
  {
    name: 'v20-contrast-mild',
    note: 'Ink/paper contrast compression to 40..215 (69% of digital range).',
    pipeline: [{ op: 'contrast', args: { black: 40, white: 215 } }]
  },
  {
    name: 'v21-contrast-hard',
    note: 'Harsh contrast compression to 65..190 (49% of digital range), a dim room.',
    pipeline: [{ op: 'contrast', args: { black: 65, white: 190 } }]
  },

  /* ---- lighting -------------------------------------------------------- */
  {
    name: 'v30-bright-gamma',
    note: 'Overhead wash: gamma 0.8 plus a +18 level exposure lift.',
    pipeline: [
      { op: 'gamma', args: 0.8 },
      { op: 'brightness', args: { delta: 18 } }
    ]
  },
  {
    name: 'v31-dim-gamma',
    note: 'Under-lit: gamma 1.35 plus a -15 level exposure cut.',
    pipeline: [
      { op: 'gamma', args: 1.35 },
      { op: 'brightness', args: { delta: -15 } }
    ]
  },

  /* ---- optics ---------------------------------------------------------- */
  {
    name: 'v40-blur-slight',
    note: 'Gaussian sigma 1.2 at native resolution: mild defocus.',
    pipeline: [{ op: 'blur', args: 1.2 }]
  },
  {
    name: 'v41-blur-motion',
    note: 'Gaussian sigma 2.5 at native resolution: hand-held motion smear.',
    pipeline: [{ op: 'blur', args: 2.5 }]
  },

  /* ---- specular -------------------------------------------------------- */
  {
    name: 'v50-glare',
    note: 'Blown specular highlight across the upper left of the sheet.',
    pipeline: [{ op: 'glare', args: { cx: 0.34, cy: 0.28, radius: 0.42, strength: 115, aspect: 1.5 } }]
  },

  /* ---- geometry -------------------------------------------------------- */
  {
    name: 'v60-skew-small',
    note: 'Perspective tilt 12 deg vertical, 8 deg horizontal.',
    pipeline: [{ op: 'perspective', args: { tiltX: 12, tiltY: 8 } }]
  },
  {
    name: 'v61-skew-large',
    note: 'Perspective tilt 25 deg vertical, 18 deg horizontal.',
    pipeline: [{ op: 'perspective', args: { tiltX: 25, tiltY: 18 } }]
  },

  /* ---- combined, the realistic ones ------------------------------------ */
  {
    name: 'v70-print-light',
    note: 'REALISTIC MILD: contrast 35..220, gamma 0.9, blur 1.0, 1024px long edge, light noise.',
    pipeline: [
      { op: 'contrast', args: { black: 35, white: 220 } },
      { op: 'gamma', args: 0.9 },
      { op: 'blur', args: 1.0 },
      { op: 'resizeLongEdge', args: 1024 },
      { op: 'noise', args: { sigma: 2, seed: 11 } }
    ]
  },
  {
    name: 'v71-print-typical',
    note: 'REALISTIC TYPICAL: contrast 48..205, gamma 0.85, +10 lift, blur 1.8, 800px long edge, noise.',
    pipeline: [
      { op: 'contrast', args: { black: 48, white: 205 } },
      { op: 'gamma', args: 0.85 },
      { op: 'brightness', args: { delta: 10 } },
      { op: 'blur', args: 1.8 },
      { op: 'resizeLongEdge', args: 800 },
      { op: 'noise', args: { sigma: 3, seed: 22 } }
    ]
  },
  {
    name: 'v72-print-harsh',
    note: 'REALISTIC HARSH: contrast 62..190, glare, blur 2.6, 12/8 deg skew, 640px long edge, noise.',
    pipeline: [
      { op: 'perspective', args: { tiltX: 12, tiltY: 8 } },
      { op: 'contrast', args: { black: 62, white: 190 } },
      { op: 'glare', args: { cx: 0.36, cy: 0.3, radius: 0.4, strength: 105, aspect: 1.5 } },
      { op: 'blur', args: 2.6 },
      { op: 'resizeLongEdge', args: 640 },
      { op: 'noise', args: { sigma: 4, seed: 33 } }
    ]
  },
  {
    name: 'v73-print-typical-hires',
    note: 'v71 conditions but kept at native resolution, to separate the resolution effect from the photometric one.',
    pipeline: [
      { op: 'contrast', args: { black: 48, white: 205 } },
      { op: 'gamma', args: 0.85 },
      { op: 'brightness', args: { delta: 10 } },
      { op: 'blur', args: 1.8 },
      { op: 'noise', args: { sigma: 3, seed: 22 } }
    ]
  },
  /* ---- the opposite direction: MORE contrast, not less --------------- */
  {
    name: 'v80-sharpen',
    note: 'Unsharp mask (amount 1.0, sigma 1.5). Tests whether a crisper source yields more tracking points.',
    pipeline: [{ op: 'sharpen', args: { amount: 1.0, sigma: 1.5 } }]
  },
  {
    name: 'v81-sharpen-strong',
    note: 'Stronger unsharp mask (amount 1.8, sigma 2.5).',
    pipeline: [{ op: 'sharpen', args: { amount: 1.8, sigma: 2.5 } }]
  },
  {
    name: 'v82-contrast-boost',
    note: 'Contrast expanded 1.4x about mid-grey — the inverse of print compression.',
    pipeline: [{ op: 'expand', args: { factor: 1.4, pivot: 128 } }]
  },
  {
    name: 'v83-binarize',
    note: 'Hard threshold to pure black and white — maximum local contrast everywhere.',
    pipeline: [{ op: 'binarize', args: { threshold: 128 } }]
  },
  {
    name: 'v84-sharpen-800',
    note: 'Unsharp mask then downscale to an 800px long edge: crisp but cheap.',
    pipeline: [
      { op: 'sharpen', args: { amount: 1.0, sigma: 1.5 } },
      { op: 'resizeLongEdge', args: 800 }
    ]
  },
  {
    name: 'v74-print-skewed-typical',
    note: 'Typical print conditions seen from an angle: 18/12 deg skew, contrast 48..205, blur 1.8, 800px.',
    pipeline: [
      { op: 'perspective', args: { tiltX: 18, tiltY: 12 } },
      { op: 'contrast', args: { black: 48, white: 205 } },
      { op: 'blur', args: 1.8 },
      { op: 'resizeLongEdge', args: 800 },
      { op: 'noise', args: { sigma: 3, seed: 44 } }
    ]
  }
];

function runPipeline(image, pipeline) {
  let cur = image;
  for (const step of pipeline) {
    const fn = ops[step.op];
    if (!fn) throw new Error(`unknown op: ${step.op}`);
    cur = fn(cur, step.args);
    if (!Number.isFinite(cur.data[0])) {
      throw new Error(`op "${step.op}" produced non-finite pixels — check its argument shape`);
    }
  }
  // Quantisation happens on write anyway; clamping here means the reported
  // stats describe the PNG that is actually compiled.
  return ops.clamp(cur);
}

async function main() {
  const [, , inPath, outDir] = process.argv;
  if (!inPath || !outDir) {
    console.error('usage: node tools/make-variants.js <source.png> <outdir>');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const source = await ops.loadGrey(inPath);
  console.log(`source ${inPath} ${source.width}x${source.height} ${JSON.stringify(ops.stats(source))}\n`);

  const manifest = [];
  for (const variant of VARIANTS) {
    const t0 = Date.now();
    const image = runPipeline(source, variant.pipeline);
    const file = path.join(outDir, `${variant.name}.png`);
    ops.saveGrey(image, file);
    const s = ops.stats(image);
    manifest.push({
      name: variant.name,
      note: variant.note,
      file,
      width: image.width,
      height: image.height,
      stats: s
    });
    console.log(
      `${variant.name.padEnd(26)} ${String(image.width).padStart(4)}x${String(image.height).padEnd(4)}` +
      ` range ${String(s.min).padStart(5)}..${String(s.max).padEnd(5)} mean ${String(s.mean).padStart(5)}` +
      ` rms ${String(s.rms).padStart(5)}  (${Date.now() - t0}ms)`
    );
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length} variants -> ${outDir}`);
}

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
module.exports = { VARIANTS, runPipeline };
