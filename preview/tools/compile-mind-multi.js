/*
 * compile-mind-multi.js — compile ONE OR MORE images into a single .mind.
 *
 *   cd <toolchain dir>            # or set MINDAR_ROOT
 *   node <repo>/tools/compile-mind-multi.js out.mind img1.png [img2.png ...]
 *
 * A .mind holds a list of targets. The runtime tries each not-yet-tracking
 * target in turn until one matches, so extra targets cost acquisition time but
 * cost nothing once a lock is held (see tools/mind-stats.js for why).
 *
 * tools/compile-mind.js remains the single-image entry point; this is the
 * multi-target sibling used for the print-robustness experiment.
 *
 * GOTCHA: images MUST be loaded through mind-ar's own nested `canvas`, or its
 * context rejects them with "Image or Canvas expected". lib/resolve-mindar.js
 * handles that.
 */
const fs = require('fs');
const path = require('path');
const { canvas, loadOfflineCompiler } = require('./lib/resolve-mindar.js');
const { readStats } = require('./mind-stats.js');

async function compile(outPath, inPaths, { quiet = false } = {}) {
  const { OfflineCompiler } = loadOfflineCompiler();

  const images = [];
  for (const p of inPaths) images.push(await canvas.loadImage(p));

  const compiler = new OfflineCompiler();
  const started = Date.now();
  let last = -1;
  await compiler.compileImageTargets(images, (percent) => {
    if (quiet) return;
    const r = Math.floor(percent / 20) * 20;
    if (r !== last) { last = r; process.stdout.write(`${r}% `); }
  });
  const compileMs = Date.now() - started;

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(compiler.exportData()));

  // Decode what we just wrote: proves the file is well-formed and that its
  // recorded dimensions match the inputs, rather than trusting the compiler.
  const stats = readStats(outPath);
  stats.compileMs = compileMs;
  stats.sources = inPaths.map((p, i) => ({
    file: path.basename(p),
    width: images[i].width,
    height: images[i].height
  }));

  const mismatched = stats.targets.filter(
    (t, i) => t.width !== images[i].width || t.height !== images[i].height);
  stats.dimensionsOk = mismatched.length === 0 && stats.targetCount === inPaths.length;

  return stats;
}

async function main() {
  const [, , outPath, ...inPaths] = process.argv;
  if (!outPath || !inPaths.length) {
    console.error('usage: node tools/compile-mind-multi.js <out.mind> <img1> [img2 ...]');
    process.exit(1);
  }

  const stats = await compile(outPath, inPaths);
  console.log(`\n  ${inPaths.length} source image(s) -> ${outPath}`);
  for (const s of stats.sources) console.log(`    ${s.file} (${s.width}x${s.height})`);
  console.log(`  ${stats.kb} KB   version ${stats.version}   targets ${stats.targetCount}   compiled in ${(stats.compileMs / 1000).toFixed(1)}s`);
  console.log(`  tracking points ${stats.trackingPoints}   matching points ${stats.matchingPoints}   keyframes ${stats.matchKeyframes}`);
  console.log(`  integrity: version ${stats.versionOk ? 'ok' : 'WRONG'}, dimensions ${stats.dimensionsOk ? 'ok' : 'MISMATCH'}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('COMPILE FAILED:', e.stack || e.message); process.exit(1); });
}
module.exports = { compile };
