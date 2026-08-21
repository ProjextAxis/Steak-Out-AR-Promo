#!/bin/sh
# Reproduce the whole marker-tuning experiment behind tools/MARKER-TUNING.md.
#
#   sh tools/run-experiment.sh <toolchain-dir> [workdir]
#
# <toolchain-dir> is the directory holding node_modules with mind-ar, canvas and
# @msgpack/msgpack installed. Everything intermediate lands in <workdir>
# (default ./marker-work) and nothing outside assets/ and tools/ is touched.
#
# Runtime is roughly 25-35 minutes, most of it compiling: the compiler spends
# 8-30s per target depending on source resolution, and the multi-target files
# cost the sum of their parts.
set -e

TOOLCHAIN=${1:?usage: sh tools/run-experiment.sh <toolchain-dir> [workdir]}
WORK=${2:-./marker-work}
REPO=$(cd "$(dirname "$0")/.." && pwd)

export MINDAR_ROOT="$(cd "$TOOLCHAIN" && pwd)/node_modules"
mkdir -p "$WORK/variants" "$WORK/mind" "$WORK/logs"
echo "repo=$REPO  modules=$MINDAR_ROOT  work=$WORK"

echo "\n=== 1. render print-simulated variants ==="
node "$REPO/tools/make-variants.js" "$REPO/assets/steakout-marker.png" "$WORK/variants"

echo "\n=== 2. compile each variant as a single-target .mind ==="
i=0
for f in "$WORK"/variants/*.png; do
  n=$(basename "$f" .png)
  [ -f "$WORK/mind/$n.mind" ] && continue
  node "$REPO/tools/compile-mind-multi.js" "$WORK/mind/$n.mind" "$f" > "$WORK/logs/$n.log" 2>&1 &
  i=$((i + 1))
  [ $((i % 4)) -eq 0 ] && wait
done
wait

echo "\n=== 3. compile the multi-target candidates ==="
V="$WORK/variants"
node "$REPO/tools/compile-mind-multi.js" "$WORK/mind/m2a-pristine+typical.mind" \
  "$V/v00-pristine.png" "$V/v71-print-typical.png" > "$WORK/logs/m2a.log" 2>&1
node "$REPO/tools/compile-mind-multi.js" "$WORK/mind/m3a-pristine+light+harsh.mind" \
  "$V/v00-pristine.png" "$V/v70-print-light.png" "$V/v72-print-harsh.png" > "$WORK/logs/m3a.log" 2>&1
node "$REPO/tools/compile-mind-multi.js" "$WORK/mind/m4a-full-ladder.mind" \
  "$V/v00-pristine.png" "$V/v70-print-light.png" "$V/v71-print-typical.png" \
  "$V/v74-print-skewed-typical.png" > "$WORK/logs/m4a.log" 2>&1

echo "\n=== 4. feature counts ==="
node "$REPO/tools/mind-stats.js" "$REPO/assets/steakout-marker.mind" "$WORK"/mind/*.mind \
  | tee "$WORK/mind-stats.txt" | tail -20

CANDIDATES="$REPO/assets/steakout-marker.mind $WORK/mind/v00-pristine.mind \
$WORK/mind/v13-res640.mind $WORK/mind/v14-res512.mind $WORK/mind/v71-print-typical.mind \
$WORK/mind/v80-sharpen.mind $WORK/mind/m2a-pristine+typical.mind \
$WORK/mind/m3a-pristine+light+harsh.mind $WORK/mind/m4a-full-ladder.mind"

echo "\n=== 5. acquisition benchmark (MindAR's own detector + matcher) ==="
node "$REPO/tools/match-sim.js" --set all --json $CANDIDATES > "$WORK/match-all.json"

echo "\n=== 6. tracking benchmark (CPU port of MindAR's tracker) ==="
node "$REPO/tools/track-sim.js" --set all --json $CANDIDATES > "$WORK/track-all.json"

echo "\n=== 7. combined table ==="
node "$REPO/tools/summarize.js" "$WORK/match-all.json" "$WORK/track-all.json" | tee "$WORK/summary.txt"

echo "\nDone. Raw JSON in $WORK/match-all.json and $WORK/track-all.json"
