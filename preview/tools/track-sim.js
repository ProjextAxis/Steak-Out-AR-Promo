/*
 * track-sim.js — does this .mind HOLD the lock when the phone moves a little?
 *
 *   cd <toolchain dir>            # or set MINDAR_ROOT
 *   node <repo>/tools/track-sim.js a.mind [b.mind ...]
 *   node <repo>/tools/track-sim.js --json --source artwork.png a.mind
 *
 * The user's complaint is "it drops too easy — it loses the marker on small
 * movements". That is the TRACKING stage, not acquisition, and it is a
 * different measurement from tools/match-sim.js.
 *
 * How the runtime loses a lock (controller.js):
 *   1. tracker.track() correlates each compiled tracking point's 13x13
 *      template against the current frame warped into marker space.
 *   2. Points scoring above AR2_SIM_THRESH (0.8) survive.
 *   3. Fewer than 4 survivors -> _trackAndUpdate returns null -> isTracking
 *      goes false -> trackMiss climbs -> past missTolerance the model vanishes.
 *
 * So this renders each held-out scenario twice: once at a pose, once after a
 * SMALL MOVEMENT, then asks how many compiled points still correlate when the
 * tracker is handed the stale pose from the previous frame. That is exactly
 * the situation a hand wobble creates.
 *
 * NOTE ON FIDELITY: mind-ar's tracker kernels are WebGL-only, so this drives a
 * CPU port (lib/track-cpu.js) rather than mind-ar's own code. Absolute survivor
 * counts are a model; the comparison between targets is the point.
 */
const fs = require('fs');
const path = require('path');
const resolver = require('./lib/resolve-mindar.js');
const ops = require('./lib/imageops.js');
const scene = require('./lib/scene.js');
const { selectSet } = require('./lib/scenarios.js');
const trackCpu = require('./lib/track-cpu.js');
const { readStats } = require('./mind-stats.js');

const FRAME_W = 640;
const FRAME_H = 480;

/**
 * The movements. `d00` is the control — no movement at all, which isolates how
 * well the compiled template matches the printed page regardless of motion.
 * The rest step up from a barely perceptible wobble to a deliberate turn.
 */
const MOVES = [
  { name: 'd00-still', note: 'no movement (template/print agreement only)', d: {} },
  { name: 'd01-wobble', note: 'hand wobble: 2 deg pitch, 1.5 deg yaw, 1 deg roll, 1.5% closer',
    d: { pitch: 2, yaw: 1.5, roll: 1, scale: 1.015 } },
  { name: 'd02-small', note: 'small shift: 4 deg pitch, 3 deg yaw, 2 deg roll, 3% closer, slight pan',
    d: { pitch: 4, yaw: 3, roll: 2, scale: 1.03, offsetX: 0.02 } },
  { name: 'd03-medium', note: 'lean in: 7 deg pitch, 5 deg yaw, 4 deg roll, 5% closer, mild smear',
    d: { pitch: 7, yaw: 5, roll: 4, scale: 1.05, offsetX: 0.03, blur: 1.2 } },
  { name: 'd04-quick', note: 'quick turn: 11 deg pitch, 8 deg yaw, 6 deg roll, 8% closer, real smear',
    d: { pitch: 11, yaw: 8, roll: 6, scale: 1.08, offsetX: 0.05, offsetY: 0.03, blur: 2.0 } }
];

const moved = (scenario, d) => ({
  ...scenario,
  pitch: (scenario.pitch || 0) + (d.pitch || 0),
  yaw: (scenario.yaw || 0) + (d.yaw || 0),
  roll: (scenario.roll || 0) + (d.roll || 0),
  heightFrac: scenario.heightFrac * (d.scale || 1),
  offsetX: (scenario.offsetX || 0) + (d.offsetX || 0),
  offsetY: (scenario.offsetY || 0) + (d.offsetY || 0),
  optical: [
    ...(scenario.optical || []),
    ...(d.blur ? [{ op: 'blur', args: d.blur }] : [])
  ]
});

/** Render every (scenario x move) camera frame once, shared across candidates. */
function buildAllFrames(source, scenarios) {
  const frames = [];
  for (const scenario of scenarios) {
    const sheet = scene.buildSheet(source, scenario);
    for (const move of MOVES) {
      const target = moved(scenario, move.d);
      const { frame } = scene.buildFrame(source, { ...target, frameW: FRAME_W, frameH: FRAME_H }, { sheet });
      frames.push({ scenario, move, frame });
    }
    process.stderr.write(`  rendered ${scenario.name} x ${MOVES.length} moves\n`);
  }
  return frames;
}

const { f, cx, cy } = scene.intrinsics(FRAME_W, FRAME_H);
const PROJECTION = [[f, 0, cx], [0, f, cy], [0, 0, 1]];

function evaluate(mindFile, frames) {
  const stats = readStats(mindFile);
  const content = resolver.msgpack.decode(fs.readFileSync(mindFile));

  const perTarget = content.dataList.map((target, targetIndex) => {
    const targetW = target.targetImage.width;
    const targetH = target.targetImage.height;
    const rows = [];

    for (const { scenario, move, frame } of frames) {
      // The pose the tracker still believes: the marker's TRUE pose in the
      // previous, unmoved frame.
      const stale = scene.modelViewTransform({
        frameW: FRAME_W, frameH: FRAME_H, targetW, targetH,
        heightFrac: scenario.heightFrac,
        pitch: scenario.pitch || 0, yaw: scenario.yaw || 0, roll: scenario.roll || 0,
        offsetX: scenario.offsetX || 0, offsetY: scenario.offsetY || 0
      });

      const r = trackCpu.track({
        trackingData: target.trackingData,
        projectionTransform: PROJECTION,
        modelViewTransform: stale,
        frame
      });
      rows.push({ scenario: scenario.name, move: move.name, ...r });
    }

    const byMove = MOVES.map((m) => {
      const subset = rows.filter((r) => r.move === m.name);
      const kept = subset.filter((r) => r.keeps).length;
      return {
        move: m.name,
        keptRate: +((kept / subset.length) * 100).toFixed(0),
        meanGood: +(subset.reduce((a, r) => a + r.goodPoints, 0) / subset.length).toFixed(1)
      };
    });

    const kept = rows.filter((r) => r.keeps).length;
    return {
      targetIndex,
      dims: `${targetW}x${targetH}`,
      trackKeyframe: rows.length ? rows[0].keyframeSize : '?',
      trackPoints: rows.length ? rows[0].totalPoints : 0,
      keptRate: +((kept / rows.length) * 100).toFixed(1),
      meanGood: +(rows.reduce((a, r) => a + r.goodPoints, 0) / rows.length).toFixed(1),
      byMove,
      rows
    };
  });

  // The runtime tracks whichever single target acquired, so the useful summary
  // for a multi-target file is its BEST target, plus target 0 for reference.
  const best = perTarget.reduce((a, b) => (b.keptRate > a.keptRate ? b : a), perTarget[0]);
  return {
    file: path.basename(mindFile),
    kb: stats.kb,
    targetCount: perTarget.length,
    best,
    target0: perTarget[0],
    perTarget
  };
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  let sourcePath = null;
  let setName = 'normal';
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--source') { sourcePath = args[++i]; continue; }
    if (args[i] === '--set') { setName = args[++i]; continue; }
    files.push(args[i]);
  }
  if (!files.length) {
    console.error('usage: node tools/track-sim.js [--source artwork.png] [--set normal|hard|all] [--json] <a.mind> [...]');
    process.exit(1);
  }
  if (!sourcePath) sourcePath = path.join(__dirname, '..', 'assets', 'steakout-marker.png');
  const scenarios = selectSet(setName);

  const source = await ops.loadGrey(sourcePath);
  process.stderr.write(`source ${path.basename(sourcePath)} ${source.width}x${source.height}\n`);
  process.stderr.write(`rendering ${scenarios.length} scenarios (set "${setName}") x ${MOVES.length} moves = ` +
                       `${scenarios.length * MOVES.length} frames at ${FRAME_W}x${FRAME_H}\n`);
  const frames = buildAllFrames(source, scenarios);

  const results = [];
  for (const file of files) {
    process.stderr.write(`evaluating ${path.basename(file)} ...\n`);
    results.push(evaluate(file, frames));
  }

  if (asJson) { console.log(JSON.stringify(results, null, 2)); return; }

  console.log(`\nTracking survival — share of ${frames.length} (scenario x move) frames keeping >= ${trackCpu.MIN_TRACK_POINTS} correlated points\n`);
  const head = `${'file'.padEnd(32)} ${'tgt'.padStart(3)} ${'dims'.padStart(9)} ${'kf'.padStart(8)} ${'pts'.padStart(4)} ${'kept%'.padStart(6)} ${'mean'.padStart(6)}  ` +
    MOVES.map((m) => m.name.split('-')[1].padStart(7)).join(' ');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of results) {
    for (const t of r.perTarget) {
      console.log(
        `${r.file.padEnd(32)} ${String(t.targetIndex).padStart(3)} ${t.dims.padStart(9)} ${t.trackKeyframe.padStart(8)} ` +
        `${String(t.trackPoints).padStart(4)} ${String(t.keptRate).padStart(6)} ${String(t.meanGood).padStart(6)}  ` +
        t.byMove.map((m) => `${String(m.keptRate).padStart(3)}%/${String(m.meanGood).padStart(3)}`).join(' ')
      );
    }
  }
  console.log('\npts    = tracking points in the 128px keyframe — the ONLY level tracker.js uses (TRACKING_KEYFRAME = 1)');
  console.log('kept%  = frames where at least 4 points still correlated above 0.8, so the lock survived');
  console.log('mean   = mean surviving points per frame (headroom above the 4-point cliff)');
  console.log('columns per move: kept% / mean surviving points');
  MOVES.forEach((m) => console.log(`  ${m.name.padEnd(12)} ${m.note}`));
}

if (require.main === module) {
  main().catch((e) => { console.error('TRACK-SIM FAILED:', e.stack || e.message); process.exit(1); });
}
module.exports = { evaluate, buildAllFrames, MOVES };
