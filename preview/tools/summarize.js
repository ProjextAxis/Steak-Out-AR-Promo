/*
 * summarize.js — fold the two benchmark JSONs into the comparison table.
 *
 *   node tools/match-sim.js --set all --json a.mind ... > match.json
 *   node tools/track-sim.js --set all --json a.mind ... > track.json
 *   node tools/summarize.js match.json track.json [--md]
 *
 * Splits the results by scenario tier, because the two tiers answer different
 * questions: the "normal" set says whether a target is good enough for real
 * use, and the "hard" set — which is deliberately past the point of failure —
 * is the only place candidates separate from one another at all.
 */
const fs = require('fs');

const isHard = (name) => name.startsWith('h');

function splitScenarios(perScenario) {
  const norm = perScenario.filter((s) => !isHard(s.name));
  const hard = perScenario.filter((s) => isHard(s.name));
  const rate = (rows) => {
    const w = rows.reduce((a, r) => a + r.windows, 0);
    const h = rows.reduce((a, r) => a + r.hits, 0);
    return w ? +((h / w) * 100).toFixed(1) : 0;
  };
  return { normal: rate(norm), hard: rate(hard), normalCount: norm.length, hardCount: hard.length };
}

function splitTrack(rows) {
  const pick = (f) => {
    const sub = rows.filter((r) => f(r.scenario));
    const kept = sub.filter((r) => r.keeps).length;
    return {
      kept: sub.length ? +((kept / sub.length) * 100).toFixed(1) : 0,
      mean: sub.length ? +(sub.reduce((a, r) => a + r.goodPoints, 0) / sub.length).toFixed(1) : 0
    };
  };
  return { normal: pick((n) => !isHard(n)), hard: pick(isHard) };
}

function main() {
  const args = process.argv.slice(2);
  const asMd = args.includes('--md');
  const [matchFile, trackFile] = args.filter((a) => a !== '--md');
  if (!matchFile || !trackFile) {
    console.error('usage: node tools/summarize.js <match.json> <track.json> [--md]');
    process.exit(1);
  }
  const match = JSON.parse(fs.readFileSync(matchFile, 'utf8'));
  const track = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
  const trackBy = Object.fromEntries(track.map((t) => [t.file, t]));

  const rows = match.map((m) => {
    const t = trackBy[m.file];
    const acq = splitScenarios(m.perScenario);
    // The runtime tracks whichever target acquired; for a multi-target file the
    // meaningful tracking figure is its best target's.
    const trk = t ? splitTrack(t.best.rows) : null;
    return {
      file: m.file,
      targets: m.targets,
      kb: m.kb,
      live: t ? t.best.trackPoints : 0,
      matchPts: m.matchingPoints,
      kf: m.matchKeyframes,
      acqNormal: acq.normal,
      acqHard: acq.hard,
      inliers: m.meanInliers,
      ms: m.msPerWindow,
      trkNormal: trk ? trk.normal.kept : 0,
      trkHard: trk ? trk.hard.kept : 0,
      trkMeanHard: trk ? trk.hard.mean : 0
    };
  });

  if (asMd) {
    console.log('| target | tgts | KB | live pts | match pts | kf | acq normal % | acq hard % | inliers | ms/win | track normal % | track hard % | mean pts (hard) |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of rows) {
      console.log(`| \`${r.file}\` | ${r.targets} | ${r.kb} | ${r.live} | ${r.matchPts} | ${r.kf} | ${r.acqNormal} | ${r.acqHard} | ${r.inliers} | ${r.ms} | ${r.trkNormal} | ${r.trkHard} | ${r.trkMeanHard} |`);
    }
    return;
  }

  const head = `${'target'.padEnd(30)}${'tgt'.padStart(4)}${'KB'.padStart(6)}${'live'.padStart(6)}${'match'.padStart(7)}${'kf'.padStart(4)}` +
               `${'acqN%'.padStart(7)}${'acqH%'.padStart(7)}${'inl'.padStart(6)}${'ms'.padStart(7)}${'trkN%'.padStart(7)}${'trkH%'.padStart(7)}${'ptsH'.padStart(6)}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    console.log(
      r.file.padEnd(30) + String(r.targets).padStart(4) + String(r.kb).padStart(6) +
      String(r.live).padStart(6) + String(r.matchPts).padStart(7) + String(r.kf).padStart(4) +
      String(r.acqNormal).padStart(7) + String(r.acqHard).padStart(7) + String(r.inliers).padStart(6) +
      String(r.ms).padStart(7) + String(r.trkNormal).padStart(7) + String(r.trkHard).padStart(7) +
      String(r.trkMeanHard).padStart(6)
    );
  }
  console.log('\nacqN/acqH = acquisition window hit rate, normal / hard scenario tier');
  console.log('trkN/trkH = tracking survival rate, normal / hard tier (best target in the file)');
  console.log('live      = tracking points in the 128px keyframe, the only level tracker.js reads');
  console.log('ms/win    = matcher time per acquisition window on this machine, all targets scanned');
}

if (require.main === module) main();
module.exports = { splitScenarios, splitTrack };
