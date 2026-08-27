/*
 * scene.js — compose a synthetic CAMERA FRAME containing the printed flyer.
 *
 * This is the piece that makes the benchmark meaningful. Rather than compare
 * feature counts (which mostly measure image size), we build a picture of what
 * the phone would actually see, run MindAR's own detector over it, and ask its
 * own matcher whether it locks on.
 *
 * The flyer is treated as a real plane in 3D and projected through the same
 * pinhole camera model MindAR assumes for pose estimation (controller.js):
 *   fovy = 45 degrees, f = (frameHeight / 2) / tan(fovy / 2), principal point
 *   at the frame center. So the geometry the matcher is asked to solve is the
 *   geometry it was designed for.
 */
const ops = require('./imageops.js');

const deg = (d) => (d * Math.PI) / 180;

/** MindAR's assumed camera intrinsics for a given frame size. */
function intrinsics(frameW, frameH) {
  const fovy = deg(45);
  const f = frameH / 2 / Math.tan(fovy / 2);
  return { f, cx: frameW / 2, cy: frameH / 2 };
}

function rotate3(p, { pitch = 0, yaw = 0, roll = 0 }) {
  let [x, y, z] = p;
  const rz = deg(roll), rx = deg(pitch), ry = deg(yaw);
  // roll (about view axis)
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  // pitch (top edge tips away)
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  // yaw (left edge swings away)
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  return [x, y, z];
}

/**
 * Project the flyer into a frame and return its four screen corners, ordered
 * top-left, top-right, bottom-right, bottom-left.
 *
 * heightFrac — the flyer's height as a fraction of the frame height when seen
 *              face-on. 1.0 means it exactly fills the frame vertically.
 */
function projectQuad({ frameW, frameH, aspect, heightFrac, pitch, yaw, roll, offsetX = 0, offsetY = 0 }) {
  const { f, cx, cy } = intrinsics(frameW, frameH);

  // Put the plane at unit depth and size it so a face-on view fills heightFrac.
  const depth = 1;
  const planeH = (heightFrac * frameH * depth) / f;
  const planeW = planeH * aspect;

  const corners = [
    [-planeW / 2, -planeH / 2, 0],
    [planeW / 2, -planeH / 2, 0],
    [planeW / 2, planeH / 2, 0],
    [-planeW / 2, planeH / 2, 0]
  ];

  return corners.map((c) => {
    const [x, y, z] = rotate3(c, { pitch, yaw, roll });
    const Z = z + depth;
    return [
      (f * (x + (offsetX * planeW))) / Z + cx,
      (f * (y + (offsetY * planeH))) / Z + cy
    ];
  });
}

/**
 * Render `src` into a frame-sized grayscale buffer, warped onto `quad`, over a
 * textured background. Inverse-mapped with bilinear sampling.
 *
 * The background is not flat: a real table has its own gradient and grain, and
 * those features compete for the detector's fixed feature budget (10x10
 * buckets, 5 features each). A flat background would flatter the results.
 */
function renderFrame(src, quad, { frameW, frameH, bgLevel = 140, bgGradient = 30, bgGrain = 6, seed = 7 }) {
  const data = new Float32Array(frameW * frameH);

  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const g = bgGradient * ((x / frameW) * 0.6 + (y / frameH) * 0.4 - 0.5) * 2;
      data[y * frameW + x] = bgLevel + g + (rnd() - 0.5) * 2 * bgGrain;
    }
  }

  // Inverse homography: frame pixel -> source pixel.
  const srcQuad = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]];
  const Hinv = ops.homography(quad, srcQuad);

  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(frameW, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(frameH, Math.ceil(Math.max(...ys)));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [u, v] = ops.applyH(Hinv, x + 0.5, y + 0.5);
      if (u < 0 || v < 0 || u >= src.width || v >= src.height) continue;
      data[y * frameW + x] = ops.sample(src, u - 0.5, v - 0.5);
    }
  }
  return { data, width: frameW, height: frameH };
}

/**
 * Full scenario -> camera frame.
 *
 * `photometric` is a pipeline of imageops applied to the artwork BEFORE
 * projection (ink, paper and lighting live on the sheet); `optical` is applied
 * to the composed frame AFTER projection (defocus, motion and sensor noise live
 * in the camera).
 */
function buildFrame(source, scenario, { sheet: presheet = null } = {}) {
  const frameW = scenario.frameW || 640;
  const frameH = scenario.frameH || 480;

  // The photometric pass is the expensive one and depends only on the scenario,
  // not on where the sheet is held, so callers sweeping poses can hoist it.
  let sheet = presheet;
  if (!sheet) {
    sheet = source;
    for (const step of scenario.photometric || []) {
      sheet = ops[step.op](sheet, step.args);
    }
  }

  // Pre-shrink the artwork towards its on-screen size so the warp is a
  // minification with area averaging rather than a point resample.
  const targetH = Math.max(64, Math.round(scenario.heightFrac * frameH * 1.4));
  if (targetH < sheet.height) sheet = ops.resize(sheet, (sheet.width * targetH) / sheet.height, targetH);

  const quad = projectQuad({
    frameW, frameH,
    aspect: source.width / source.height,
    heightFrac: scenario.heightFrac,
    pitch: scenario.pitch || 0,
    yaw: scenario.yaw || 0,
    roll: scenario.roll || 0,
    offsetX: scenario.offsetX || 0,
    offsetY: scenario.offsetY || 0
  });

  let frame = renderFrame(sheet, quad, {
    frameW, frameH,
    bgLevel: scenario.bgLevel, bgGradient: scenario.bgGradient,
    bgGrain: scenario.bgGrain, seed: scenario.seed
  });

  for (const step of scenario.optical || []) {
    frame = ops[step.op](frame, step.args);
  }
  return { frame: ops.clamp(frame), quad };
}

/** Apply just the scenario's photometric pass to the artwork. Hoist this out of
 *  a pose sweep and hand the result back via buildFrame's `sheet` option. */
function buildSheet(source, scenario) {
  let sheet = source;
  for (const step of scenario.photometric || []) sheet = ops[step.op](sheet, step.args);
  return sheet;
}

/**
 * The GROUND-TRUTH pose of the flyer in a scenario, as MindAR's 3x4
 * modelViewTransform.
 *
 * Because the scene is synthetic we know the pose exactly, which means the
 * tracking stage can be tested without first having to solve for it — no
 * estimator error leaks into the measurement.
 *
 * MindAR's marker world coordinates are PIXELS OF THE COMPILED TARGET IMAGE
 * (tracker.js divides each point by the keyframe scale to get back there). So
 * the pose depends on the target's own dimensions: a variant compiled at 640px
 * has the same physical pose but a different scale factor. Pass the dimensions
 * recorded in the .mind, not the artwork's.
 */
function modelViewTransform({ frameW, frameH, targetW, targetH, heightFrac, pitch = 0, yaw = 0, roll = 0, offsetX = 0, offsetY = 0 }) {
  const { f } = intrinsics(frameW, frameH);
  const depth = 1;
  const planeH = (heightFrac * frameH * depth) / f;
  const planeW = planeH * (targetW / targetH);
  const s = planeW / targetW; // 3D units per target pixel

  // Columns of the scene rotation, taken by rotating the basis vectors — this
  // cannot drift out of step with projectQuad's rotate3 ordering.
  const col = [
    rotate3([1, 0, 0], { pitch, yaw, roll }),
    rotate3([0, 1, 0], { pitch, yaw, roll }),
    rotate3([0, 0, 1], { pitch, yaw, roll })
  ];

  // The plane is centerd on the optical axis, so the target's top-left corner
  // sits at -(W/2, H/2) before rotation. Fold that into the translation.
  const center = [(s * targetW) / 2, (s * targetH) / 2, 0];
  const rc = [0, 1, 2].map((r) => col[0][r] * center[0] + col[1][r] * center[1] + col[2][r] * center[2]);
  const T = [offsetX * planeW, offsetY * planeH, depth];

  return [0, 1, 2].map((r) => [
    s * col[0][r], s * col[1][r], s * col[2][r], T[r] - rc[r]
  ]);
}

/** Self-check: the pose must project the target's corners onto the same quad
 *  renderFrame drew. Returns the largest corner error in pixels. */
function poseError(scenario, targetW, targetH, frameW, frameH) {
  const m = modelViewTransform({ frameW, frameH, targetW, targetH, ...scenario });
  const { f, cx, cy } = intrinsics(frameW, frameH);
  const p = [[f, 0, cx], [0, f, cy], [0, 0, 1]];
  const mvp = [
    [p[0][0] * m[0][0] + p[0][2] * m[2][0], p[0][0] * m[0][1] + p[0][2] * m[2][1], 0, p[0][0] * m[0][3] + p[0][2] * m[2][3]],
    [p[1][1] * m[1][0] + p[1][2] * m[2][0], p[1][1] * m[1][1] + p[1][2] * m[2][1], 0, p[1][1] * m[1][3] + p[1][2] * m[2][3]],
    [m[2][0], m[2][1], 0, m[2][3]]
  ];
  const quad = projectQuad({
    frameW, frameH, aspect: targetW / targetH,
    heightFrac: scenario.heightFrac,
    pitch: scenario.pitch || 0, yaw: scenario.yaw || 0, roll: scenario.roll || 0,
    offsetX: scenario.offsetX || 0, offsetY: scenario.offsetY || 0
  });
  const corners = [[0, 0], [targetW, 0], [targetW, targetH], [0, targetH]];

  let worst = 0;
  corners.forEach(([x, y], i) => {
    const uz = mvp[2][0] * x + mvp[2][1] * y + mvp[2][3];
    const ux = (mvp[0][0] * x + mvp[0][1] * y + mvp[0][3]) / uz;
    const uy = (mvp[1][0] * x + mvp[1][1] * y + mvp[1][3]) / uz;
    worst = Math.max(worst, Math.hypot(ux - quad[i][0], uy - quad[i][1]));
  });
  return worst;
}

module.exports = {
  buildFrame, buildSheet, projectQuad, renderFrame,
  intrinsics, modelViewTransform, poseError
};
