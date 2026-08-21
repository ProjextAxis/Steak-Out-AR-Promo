/*
 * mind-stats.js — decode a compiled .mind and report what is actually inside it.
 *
 *   node tools/mind-stats.js <file.mind> [more.mind ...]
 *   node tools/mind-stats.js --json <file.mind>
 *
 * WHAT THE NUMBERS MEAN (this matters — they are easy to misread):
 *
 * trackingData  Two fixed levels, built by buildTrackingImageList() at 256px
 *               and 128px on the image's SHORT edge, regardless of how big the
 *               source was. These points drive frame-to-frame TRACKING once a
 *               lock exists. Because the levels are fixed, this count is very
 *               nearly independent of source resolution — it measures the
 *               artwork, not the file size.
 *
 * matchingData  A scale pyramid built by buildImageList(), from full source
 *               resolution down to a 100px short edge in 2^(1/3) steps. These
 *               points drive ACQUISITION (finding the marker from scratch).
 *               The number of levels — and therefore the total point count —
 *               grows with source resolution. A 1038px-wide source gets 11
 *               levels; a 674px-wide one gets 7. So comparing raw "matching
 *               points" between images of different sizes compares resolution
 *               at least as much as it compares trackability.
 *
 * matchCost     Per acquisition frame, matcher.matchDetection() walks EVERY
 *               keyframe of EVERY not-yet-tracking target with no early exit
 *               (matching/matcher.js), and inside each it queries a cluster
 *               tree over that keyframe's points. Keyframes x points is
 *               therefore the honest proxy for acquisition cost, and it is the
 *               number that multi-target compilation inflates.
 */
const fs = require('fs');
const path = require('path');
const { msgpack } = require('./lib/resolve-mindar.js');

const EXPECTED_VERSION = 2;

/* tracker.js: `const TRACKING_KEYFRAME = 1; // 0: 256px, 1: 128px` */
const TRACKING_KEYFRAME = 1;

/** MindAR's own sample card, which is known to track acceptably in practice.
 *  Treated as the floor, not the goal. */
const REFERENCE = { name: 'MindAR sample card', track: 62, match: 593, keyframes: 7 };

function readStats(file) {
  const buffer = fs.readFileSync(file);
  const content = msgpack.decode(buffer);

  const targets = content.dataList.map((t, index) => {
    const track = t.trackingData.reduce((a, x) => a + (x.points ? x.points.length : 0), 0);
    const match = t.matchingData.reduce(
      (a, x) => a + ((x.maximaPoints || []).length + (x.minimaPoints || []).length), 0);
    // tracker.js hardcodes TRACKING_KEYFRAME = 1 and uses ONLY that level.
    // Everything compiled into level 0 is inert at track time, so this — not
    // the sum — is the tracking number that decides whether a lock survives.
    const live = t.trackingData[TRACKING_KEYFRAME];
    return {
      index,
      width: t.targetImage.width,
      height: t.targetImage.height,
      trackingPoints: track,
      livePoints: live && live.points ? live.points.length : 0,
      liveKeyframe: live ? `${live.width}x${live.height}` : '?',
      matchingPoints: match,
      matchKeyframes: t.matchingData.length,
      trackLevels: t.trackingData.map((x) => ({ w: x.width, h: x.height, points: x.points ? x.points.length : 0 })),
      matchLevels: t.matchingData.map((x) => ({
        w: x.width, h: x.height,
        points: (x.maximaPoints || []).length + (x.minimaPoints || []).length
      }))
    };
  });

  return {
    file,
    name: path.basename(file),
    version: content.v,
    versionOk: content.v === EXPECTED_VERSION,
    bytes: buffer.length,
    kb: +(buffer.length / 1024).toFixed(0),
    targetCount: targets.length,
    targets,
    // Totals across all targets in the file.
    trackingPoints: targets.reduce((a, t) => a + t.trackingPoints, 0),
    livePoints: targets.reduce((a, t) => a + t.livePoints, 0),
    matchingPoints: targets.reduce((a, t) => a + t.matchingPoints, 0),
    matchKeyframes: targets.reduce((a, t) => a + t.matchKeyframes, 0),
    // Worst-case acquisition work: every keyframe of every target is visited.
    matchCost: targets.reduce((a, t) => a + t.matchingPoints, 0),
    // Best case for target 0 alone (the worker breaks out of the target loop on
    // the first target that produces a keyframe match).
    matchCostBestCase: targets.length ? targets[0].matchingPoints : 0
  };
}

function report(s) {
  console.log(`\n=== ${s.name} ===`);
  console.log(`  file          ${s.kb} KB   version ${s.version}${s.versionOk ? ' (ok)' : ' (WRONG — runtime will reject)'}`);
  console.log(`  targets       ${s.targetCount}`);
  for (const t of s.targets) {
    console.log(
      `   [${t.index}] ${t.width}x${t.height}` +
      `  tracking ${String(t.trackingPoints).padStart(4)}` +
      `  live(128px) ${String(t.livePoints).padStart(3)}` +
      `  matching ${String(t.matchingPoints).padStart(5)}` +
      `  keyframes ${t.matchKeyframes}`
    );
    console.log(`        track levels: ${t.trackLevels.map((l) => `${l.w}x${l.h}:${l.points}`).join('  ')}`);
    console.log(`        match levels: ${t.matchLevels.map((l) => `${l.w}x${l.h}:${l.points}`).join(' ')}`);
  }
  console.log(`  TOTAL         tracking ${s.trackingPoints}   live(128px) ${s.livePoints}   matching ${s.matchingPoints}   keyframes ${s.matchKeyframes}`);
  console.log('  NOTE          tracker.js uses ONLY the 128px level, so "live" is the count that governs holding a lock.');
  console.log(`  acquisition   worst-case keypoints scanned/frame: ${s.matchCost}` +
              (s.targetCount > 1 ? `   (best case, target 0 hits: ${s.matchCostBestCase})` : ''));
  console.log(`  reference     ${REFERENCE.name}: tracking ${REFERENCE.track}, matching ${REFERENCE.match}, keyframes ${REFERENCE.keyframes}`);
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => a !== '--json');
  if (!files.length) {
    console.error('usage: node tools/mind-stats.js [--json] <file.mind> [...]');
    process.exit(1);
  }
  const all = files.map(readStats);
  if (asJson) console.log(JSON.stringify(all, null, 2));
  else all.forEach(report);
}

if (require.main === module) main();
module.exports = { readStats, REFERENCE, EXPECTED_VERSION, TRACKING_KEYFRAME };
