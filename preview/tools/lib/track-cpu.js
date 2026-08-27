/*
 * track-cpu.js — a faithful CPU port of MindAR's per-frame TRACKING stage.
 *
 * WHY THIS FILE EXISTS: mind-ar's Tracker (src/image-target/tracker/tracker.js)
 * implements its four hot kernels as GLSL `userCode` WebGL programs. There is
 * no CPU fallback for them — the cpu kernel directory only covers the detector.
 * So Tracker.track() cannot run under Node's tfjs CPU backend, and the stage
 * that actually decides "does the marker stay locked" would otherwise be
 * unmeasurable off-device.
 *
 * This is a line-by-line port of _computeProjection and _computeMatching from
 * mind-ar 1.2.5, same constants, same normalized-cross-correlation formula,
 * same argmax-over-search-window, same AR2_SIM_THRESH cut. It is a
 * reimplementation, not MindAR's own code path, so treat its absolute numbers
 * as a model — the COMPARISONS between targets are what it is for.
 *
 * One deliberate difference: where the GLSL samples the input texture out of
 * bounds (undefined in WebGL, whatever tf's texture clamp happens to give),
 * this clamps to the edge pixel.
 *
 * The one constant worth knowing by heart:
 *
 *     const TRACKING_KEYFRAME = 1;   // 0: 256px, 1: 128px
 *
 * The tracker uses ONLY keyframe 1 — the 128px level. Every tracking point
 * compiled into the 256px level is dead weight at track time. So the tracking
 * point count that matters is the 128px level's alone, not the sum of both.
 */

const AR2_DEFAULT_TS = 6;        // template half-size -> 13x13 template
const AR2_DEFAULT_TS_GAP = 1;
const AR2_SEARCH_SIZE = 10;      // search half-size -> 21x21 search window
const AR2_SEARCH_GAP = 1;
const AR2_SIM_THRESH = 0.8;      // NCC cut for a surviving point
const TRACKING_KEYFRAME = 1;     // 0: 256px, 1: 128px  <- the tracker's choice
const MIN_TRACK_POINTS = 4;      // controller drops the lock below this

/** projectionTransform (3x3) x modelViewTransform (3x4). Mirrors
 *  estimation/utils.js buildModelViewProjectionTransform. */
function buildMVP(projectionTransform, m) {
  const p = projectionTransform;
  return [
    [
      p[0][0] * m[0][0] + p[0][2] * m[2][0],
      p[0][0] * m[0][1] + p[0][2] * m[2][1],
      p[0][0] * m[0][2] + p[0][2] * m[2][2],
      p[0][0] * m[0][3] + p[0][2] * m[2][3]
    ],
    [
      p[1][1] * m[1][0] + p[1][2] * m[2][0],
      p[1][1] * m[1][1] + p[1][2] * m[2][1],
      p[1][1] * m[1][2] + p[1][2] * m[2][2],
      p[1][1] * m[1][3] + p[1][2] * m[2][3]
    ],
    [m[2][0], m[2][1], m[2][2], m[2][3]]
  ];
}

/**
 * Warp the camera frame into marker space — tracker.js _computeProjection.
 *
 * Produces a markerWidth x markerHeight image: what the camera would be seeing
 * if the marker were flat-on and filling the tracking keyframe exactly, given
 * the pose we believe the marker is at. If the pose is right, this lines up
 * with the compiled template; the further the pose has drifted since the last
 * frame, the more it is displaced — which is precisely what the search window
 * below is for.
 */
function computeProjection(mvp, frame, keyframe) {
  const { width: mw, height: mh, scale } = keyframe;
  const out = new Float32Array(mw * mh);
  const [m00, m01, , m03] = mvp[0];
  const [m10, m11, , m13] = mvp[1];
  const [m20, m21, , m23] = mvp[2];
  const fw = frame.width, fh = frame.height;

  for (let y = 0; y < mh; y++) {
    const yy = y / scale;
    for (let x = 0; x < mw; x++) {
      const xx = x / scale;
      const uz = xx * m20 + yy * m21 + m23;
      const inv = 1 / uz;
      let ux = Math.floor((xx * m00 + yy * m01 + m03) * inv + 0.5);
      let uy = Math.floor((xx * m10 + yy * m11 + m13) * inv + 0.5);
      // GLSL leaves out-of-range texture reads undefined; clamp to the edge.
      if (ux < 0) ux = 0; else if (ux >= fw) ux = fw - 1;
      if (uy < 0) uy = 0; else if (uy >= fh) uy = fh - 1;
      out[y * mw + x] = frame.data[uy * fw + ux];
    }
  }
  return { data: out, width: mw, height: mh };
}

/**
 * tracker.js _computeMatching: for every compiled tracking point, slide its
 * 13x13 template over a 21x21 search window in the projected image and keep the
 * best normalized cross-correlation.
 */
function computeMatching(keyframe, projected) {
  const templateOne = AR2_DEFAULT_TS;
  const templateSize = templateOne * 2 + 1;
  const searchOne = AR2_SEARCH_SIZE * AR2_DEFAULT_TS_GAP;
  const searchSize = searchOne * 2 + 1;
  const count = templateSize * templateSize;

  const mw = keyframe.width, mh = keyframe.height;
  const marker = keyframe.data;
  const tw = projected.width, th = projected.height;
  const target = projected.data;

  const sims = new Float32Array(keyframe.points.length);

  for (let i = 0; i < keyframe.points.length; i++) {
    const p = keyframe.points[i];
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);

    // The template is fixed per feature — hoist its sums out of the search.
    let sumTemplate = 0, sumTemplateSquare = 0;
    let templateOk = true;
    for (let ty = 0; ty < templateSize; ty++) {
      const fy = cy + ty - templateOne;
      for (let tx = 0; tx < templateSize; tx++) {
        const fx = cx + tx - templateOne;
        if (fx < 0 || fy < 0 || fx >= mw || fy >= mh) { templateOk = false; break; }
        const v = marker[fy * mw + fx];
        sumTemplate += v;
        sumTemplateSquare += v * v;
      }
      if (!templateOk) break;
    }
    if (!templateOk) { sims[i] = -4; continue; }

    const templateVariance = Math.sqrt(sumTemplateSquare - (sumTemplate / count) * sumTemplate);
    if (templateVariance < 1e-7) { sims[i] = -4; continue; }

    let best = -Infinity;
    for (let so = 0; so < searchSize * searchSize; so++) {
      const sx = cx + (so % searchSize) * AR2_SEARCH_GAP - searchOne;
      const sy = cy + Math.floor(so / searchSize) * AR2_SEARCH_GAP - searchOne;

      if (sx < templateOne || sx >= tw - templateOne || sy < templateOne || sy >= th - templateOne) {
        if (-2 > best) best = -2;
        continue;
      }

      let sumPoint = 0, sumPointSquare = 0, sumPointTemplate = 0;
      for (let ty = 0; ty < templateSize; ty++) {
        const fy = cy + ty - templateOne;
        const sy2 = sy + ty - templateOne;
        const mrow = fy * mw;
        const trow = sy2 * tw;
        for (let tx = 0; tx < templateSize; tx++) {
          const mv = marker[mrow + cx + tx - templateOne];
          const tv = target[trow + sx + tx - templateOne];
          sumPoint += tv;
          sumPointSquare += tv * tv;
          sumPointTemplate += tv * mv;
        }
      }

      const pointVariance = Math.sqrt(sumPointSquare - (sumPoint / count) * sumPoint);
      if (pointVariance < 1e-7) { if (-3 > best) best = -3; continue; }

      const sim = (sumPointTemplate - (sumPoint / count) * sumTemplate) / pointVariance / templateVariance;
      if (sim > best) best = sim;
    }
    sims[i] = best;
  }
  return sims;
}

/**
 * One tracking update, as controller.js `_trackAndUpdate` would perform it.
 *
 * `trackingData` is dataList[i].trackingData straight out of the .mind;
 * `modelViewTransform` is the pose believed from the PREVIOUS frame; `frame` is
 * the current camera image. Returns how many compiled points still correlate.
 *
 * Fewer than MIN_TRACK_POINTS surviving is exactly what makes the controller
 * set isTracking = false — the moment the user experiences as a drop.
 */
function track({ trackingData, projectionTransform, modelViewTransform, frame }) {
  const keyframe = trackingData[TRACKING_KEYFRAME];
  const mvp = buildMVP(projectionTransform, modelViewTransform);
  const projected = computeProjection(mvp, frame, keyframe);
  const sims = computeMatching(keyframe, projected);

  let good = 0;
  let simSum = 0;
  for (let i = 0; i < sims.length; i++) {
    if (sims[i] > AR2_SIM_THRESH) { good++; simSum += sims[i]; }
  }
  return {
    totalPoints: keyframe.points.length,
    goodPoints: good,
    meanSim: good ? simSum / good : 0,
    keeps: good >= MIN_TRACK_POINTS,
    keyframeSize: `${keyframe.width}x${keyframe.height}`
  };
}

module.exports = {
  track, buildMVP, computeProjection, computeMatching,
  AR2_SIM_THRESH, TRACKING_KEYFRAME, MIN_TRACK_POINTS
};
