/*
 * Compile a printed marker image into a MindAR .mind tracking target, and grade
 * how well it is likely to track.
 *
 *   npm i mind-ar@1.2.5 canvas @msgpack/msgpack
 *   MINDAR_ROOT=/path/to/node_modules node tools/compile-mind.js artwork.png out.mind
 *
 * Then point config.marker.targetMindUrl at the output.
 *
 * Gotcha worth keeping: mind-ar ships its own nested copy of `canvas`. An Image
 * loaded from a different canvas install is rejected by its context with
 * "Image or Canvas expected", so the image MUST be loaded through mind-ar's copy.
 * lib/resolve-mindar.js handles that, and also finds the install from
 * MINDAR_ROOT / the cwd / NODE_PATH — `require` resolves relative to THIS FILE,
 * not the working directory, so merely cd-ing to the toolchain is not enough.
 *
 * Grading baseline is MindAR's own sample card, which tracks well in practice:
 *   62 tracking points (32 of them live), 593 matching points.
 *
 * See tools/MARKER-TUNING.md for why "live" is the number that matters and why
 * the other two are easy to over-read.
 */
const fs = require('fs');
const resolver = require('./lib/resolve-mindar.js');
const { loadImage } = resolver.canvas;
const { OfflineCompiler } = resolver.loadOfflineCompiler();
const msgpack = resolver.msgpack;

/* tracker.js: `const TRACKING_KEYFRAME = 1; // 0: 256px, 1: 128px` — the tracker
 * reads ONLY the 128px level, so the other level's points are inert at runtime. */
const TRACKING_KEYFRAME = 1;
const REFERENCE = { track: 62, live: 32, match: 593 };

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
  const liveLevel = t.trackingData[TRACKING_KEYFRAME];
  const live = liveLevel && liveLevel.points ? liveLevel.points.length : 0;
  const match = t.matchingData.reduce(
    (a, x) => a + ((x.maximaPoints || []).length + (x.minimaPoints || []).length), 0);

  console.log(`\n  ${inPath} (${img.width}x${img.height}) -> ${outPath} ` +
              `(${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
  console.log(`  live tracking points ${live}  (sample card: ${REFERENCE.live})  <- the one that matters`);
  console.log(`  all tracking points  ${track}  (sample card: ${REFERENCE.track})  includes the unused 256px level`);
  console.log(`  matching points      ${match}  (sample card: ${REFERENCE.match})  grows with source resolution`);

  // Graded on the live count, not the sum: the 256px tracking level is never
  // read at runtime, and matching points mostly measure how big the source was.
  const ok = live >= REFERENCE.live * 0.8 && match >= REFERENCE.match * 0.6;
  console.log(ok
    ? '  VERDICT: should track at least as well as the MindAR sample.'
    : '  VERDICT: below the sample card. Add contrast and non-repeating detail.');
})().catch((e) => { console.error('COMPILE FAILED:', e.message); process.exit(1); });
