/*
 * match-sim.js — does this .mind actually LOCK ON to a picture of the print?
 *
 *   cd <toolchain dir>            # or set MINDAR_ROOT
 *   node <repo>/tools/match-sim.js a.mind [b.mind ...]
 *   node <repo>/tools/match-sim.js --json --source <artwork.png> a.mind
 *
 * Feature counts are a weak proxy: they mostly track image resolution. This
 * runs the real thing instead. For every held-out scenario in lib/scenarios.js
 * it renders a synthetic camera frame, then drives MindAR's OWN acquisition
 * path over it:
 *
 *   CropDetector.detectMoving()  ->  Matcher.matchDetection()  ->  Estimator
 *
 * exactly as controller.js and controller.worker.js do at runtime, including
 * the worker's break-on-first-hit over the target list.
 *
 * THE CROP DETAIL THAT DRIVES EVERYTHING: acquisition never looks at the whole
 * frame. CropDetector picks a square window of the nearest power of two to
 * half the short edge (256px for a 640x480 stream) and cycles it through nine
 * positions, one per frame. So the score below is per-window, and the headline
 * metric is how many of those nine windows find the marker. That number is
 * what governs how fast a lock is regained after a wobble — which is what
 * "drops too easy" feels like to a user.
 */
const fs = require('fs');
const path = require('path');
const resolver = require('./lib/resolve-mindar.js');
const ops = require('./lib/imageops.js');
const { buildFrame, intrinsics } = require('./lib/scene.js');
const { selectSet } = require('./lib/scenarios.js');
const { readStats } = require('./mind-stats.js');

// The CPU kernels must be registered before any Detector runs. tfjs has no
// WebGL backend here, so without this the detector has no kernel to call.
resolver.loadCpuKernels();
const tf = resolver.loadTf();
const { CropDetector } = resolver.loadCropDetector();
const { Matcher } = resolver.loadMatcher();
const { Estimator } = resolver.loadEstimator();

/* MindAR takes whatever getUserMedia hands it — aframe.js sets no resolution
 * constraint — so inputWidth/inputHeight are the browser's default stream size.
 * 640x480 is the common unconstrained default and is the primary test point,
 * but the stream can be larger, which changes BOTH the crop window size and how
 * many pixels the flyer occupies. Override with --frame WxH. */
let FRAME_W = 640;
let FRAME_H = 480;
const CROPS_PER_FRAME = 9; // CropDetector cycles nine window positions

/** Replicates controller.worker.js "match": walk targets in order, stop at the
 *  first one that produces a keyframe match AND a solvable pose. */
function workerMatch(matcher, estimator, matchingDataList, featurePoints) {
  for (let i = 0; i < matchingDataList.length; i++) {
    const { keyframeIndex, screenCoords, worldCoords } =
      matcher.matchDetection(matchingDataList[i], featurePoints);
    if (keyframeIndex === -1) continue;

    const modelViewTransform = estimator.estimate({ screenCoords, worldCoords });
    // The worker breaks out of the target loop as soon as a keyframe matched,
    // whether or not the pose solved. Mirror that, so cost is modeled honestly.
    return {
      targetIndex: modelViewTransform ? i : -1,
      keyframeIndex,
      inliers: screenCoords ? screenCoords.length : 0,
      posed: !!modelViewTransform,
      targetsScanned: i + 1
    };
  }
  return { targetIndex: -1, keyframeIndex: -1, inliers: 0, posed: false, targetsScanned: matchingDataList.length };
}

async function detectAllFrames(source, { saveFramesTo = null, scenarios } = {}) {
  const cropDetector = new CropDetector(FRAME_W, FRAME_H);
  const results = [];

  for (const scenario of scenarios) {
    const { frame } = buildFrame(source, { ...scenario, frameW: FRAME_W, frameH: FRAME_H });
    if (saveFramesTo) ops.saveGrey(frame, path.join(saveFramesTo, `${scenario.name}.png`));

    const inputT = tf.tensor(frame.data, [frame.data.length], 'float32').reshape([FRAME_H, FRAME_W]);
    const crops = [];
    for (let c = 0; c < CROPS_PER_FRAME; c++) {
      const { featurePoints } = cropDetector.detectMoving(inputT);
      crops.push(featurePoints);
    }
    inputT.dispose();

    results.push({ scenario, crops });
    process.stderr.write(
      `  frame ${scenario.name.padEnd(24)} features/crop: ` +
      `${crops.map((c) => String(c.length).padStart(3)).join(' ')}\n`
    );
  }
  return results;
}

function evaluate(mindFile, frames) {
  const stats = readStats(mindFile);
  const content = resolver.msgpack.decode(fs.readFileSync(mindFile));
  const matchingDataList = content.dataList.map((d) => d.matchingData);

  const { f, cx, cy } = intrinsics(FRAME_W, FRAME_H);
  const projectionTransform = [[f, 0, cx], [0, f, cy], [0, 0, 1]];
  const matcher = new Matcher(FRAME_W, FRAME_H);
  const estimator = new Estimator(projectionTransform);

  const perScenario = [];
  let totalWindows = 0, hitWindows = 0, inlierSum = 0, msSum = 0;
  const targetHits = new Array(matchingDataList.length).fill(0);

  for (const { scenario, crops } of frames) {
    let hits = 0, inliers = 0;
    for (const featurePoints of crops) {
      const t0 = process.hrtime.bigint();
      const r = workerMatch(matcher, estimator, matchingDataList, featurePoints);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;

      totalWindows++; msSum += ms;
      if (r.posed) {
        hits++; hitWindows++;
        inliers += r.inliers; inlierSum += r.inliers;
        targetHits[r.targetIndex]++;
      }
    }
    perScenario.push({
      name: scenario.name,
      hits,
      windows: crops.length,
      meanInliers: hits ? +(inliers / hits).toFixed(1) : 0
    });
  }

  return {
    file: path.basename(mindFile),
    targets: stats.targetCount,
    kb: stats.kb,
    trackingPoints: stats.trackingPoints,
    matchingPoints: stats.matchingPoints,
    matchKeyframes: stats.matchKeyframes,
    scenariosAcquired: perScenario.filter((s) => s.hits > 0).length,
    scenarioCount: perScenario.length,
    windowHitRate: +((hitWindows / totalWindows) * 100).toFixed(1),
    hitWindows,
    totalWindows,
    meanInliers: hitWindows ? +(inlierSum / hitWindows).toFixed(1) : 0,
    msPerWindow: +(msSum / totalWindows).toFixed(1),
    targetHits,
    perScenario
  };
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  let sourcePath = null;
  let setName = 'normal';
  let saveTo = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--source') { sourcePath = args[++i]; continue; }
    if (args[i] === '--set') { setName = args[++i]; continue; }
    if (args[i] === '--frame') {
      const [w, h] = args[++i].split('x').map(Number);
      FRAME_W = w; FRAME_H = h;
      continue;
    }
    if (args[i] === '--save-frames') { saveTo = args[++i]; continue; }
    files.push(args[i]);
  }
  if (!files.length) {
    console.error('usage: node tools/match-sim.js [--source artwork.png] [--set normal|hard|all] [--frame WxH] [--save-frames dir] [--json] <a.mind> [...]');
    process.exit(1);
  }
  if (!sourcePath) {
    sourcePath = path.join(__dirname, '..', 'assets', 'steakout-marker.png');
  }
  const scenarios = selectSet(setName);

  const source = await ops.loadGrey(sourcePath);
  process.stderr.write(`source ${path.basename(sourcePath)} ${source.width}x${source.height}\n`);
  process.stderr.write(`building ${scenarios.length} held-out camera frames (set "${setName}") at ${FRAME_W}x${FRAME_H} ` +
                       `(CropDetector window ${new CropDetector(FRAME_W, FRAME_H).cropSize}px, ${CROPS_PER_FRAME} positions)\n`);

  if (saveTo) fs.mkdirSync(saveTo, { recursive: true });
  const frames = await detectAllFrames(source, { saveFramesTo: saveTo, scenarios });

  const results = [];
  for (const file of files) {
    process.stderr.write(`\nevaluating ${path.basename(file)} ...\n`);
    results.push(evaluate(file, frames));
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\n${'file'.padEnd(34)} ${'tgts'} ${'KB'.padStart(5)} ${'track'.padStart(6)} ${'scen'.padStart(6)} ${'window%'.padStart(8)} ${'inliers'.padStart(8)} ${'ms/win'.padStart(7)}`);
  console.log('-'.repeat(90));
  for (const r of results) {
    console.log(
      `${r.file.padEnd(34)} ${String(r.targets).padStart(4)} ${String(r.kb).padStart(5)} ` +
      `${String(r.trackingPoints).padStart(6)} ${String(`${r.scenariosAcquired}/${r.scenarioCount}`).padStart(6)} ` +
      `${String(r.windowHitRate).padStart(8)} ${String(r.meanInliers).padStart(8)} ${String(r.msPerWindow).padStart(7)}`
    );
  }
  console.log('\nscen    = held-out scenarios acquired at least once across the 9 crop windows');
  console.log('window% = share of all (scenario x crop window) trials that produced a solvable pose');
  console.log('inliers = mean inlier correspondences on a successful match (higher = steadier pose)');
  console.log('ms/win  = mean matcher time per acquisition window on this machine, all targets scanned');
}

if (require.main === module) {
  main().catch((e) => { console.error('MATCH-SIM FAILED:', e.stack || e.message); process.exit(1); });
}
module.exports = { evaluate, detectAllFrames, workerMatch };
