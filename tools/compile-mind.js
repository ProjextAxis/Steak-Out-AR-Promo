/*
 * Compile a printed marker image into a MindAR .mind tracking target, and grade
 * how well it is likely to track.
 *
 *   npm i mind-ar@1.2.5 canvas @msgpack/msgpack
 *   node tools/compile-mind.js artwork.png assets/steakout-marker.mind
 *
 * Then point config.marker.targetMindUrl at the output.
 *
 * Gotcha worth keeping: mind-ar ships its own nested copy of `canvas`. An Image
 * loaded from a different canvas install is rejected by its context with
 * "Image or Canvas expected", so the image MUST be loaded through mind-ar's copy.
 *
 * Grading baseline is MindAR's own sample card, which tracks well in practice:
 *   62 tracking points, 593 matching points.
 */
const fs = require('fs');
const { loadImage } = require('mind-ar/node_modules/canvas');
const { OfflineCompiler } = require('mind-ar/src/image-target/offline-compiler.js');
const msgpack = require('@msgpack/msgpack');

const REFERENCE = { track: 62, match: 593 };

(async () => {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: node tools/compile-mind.js <image> <out.mind>');
    process.exit(1);
  }

  const img = await loadImage(inPath);
  const compiler = new OfflineCompiler();
  let last = -1;
  await compiler.compileImageTargets([img], (p) => {
    const r = Math.floor(p / 20) * 20;
    if (r !== last) { last = r; process.stdout.write(`${r}% `); }
  });
  fs.writeFileSync(outPath, Buffer.from(compiler.exportData()));

  const t = msgpack.decode(fs.readFileSync(outPath)).dataList[0];
  const track = t.trackingData.reduce((a, x) => a + (x.points ? x.points.length : 0), 0);
  const match = t.matchingData.reduce(
    (a, x) => a + ((x.maximaPoints || []).length + (x.minimaPoints || []).length), 0);

  console.log(`\n  ${inPath} (${img.width}x${img.height}) -> ${outPath} ` +
              `(${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
  console.log(`  tracking points ${track}  (sample card: ${REFERENCE.track})`);
  console.log(`  matching points ${match}  (sample card: ${REFERENCE.match})`);

  const ok = track >= REFERENCE.track * 0.6 && match >= REFERENCE.match * 0.6;
  console.log(ok
    ? '  VERDICT: should track at least as well as the MindAR sample.'
    : '  VERDICT: below the sample card. Add contrast and non-repeating detail.');
})().catch((e) => { console.error('COMPILE FAILED:', e.message); process.exit(1); });
