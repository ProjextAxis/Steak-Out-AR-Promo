/* QR-based recovery for a lost flyer.
 *
 * WHY
 * ---
 * The image target is natural-feature based, and this particular flyer is a
 * hard one for that: pure black on white with no midtones, dominated by a QR
 * code and repeated letterforms. Feature matchers want DISTINCTIVE,
 * non-repeating patches; this gives them thousands of near-identical square
 * corners. Printed, angled and slightly blurred on a dark table, it stops being
 * detected at all -- and once the anchor is wrong, nothing re-establishes it.
 *
 * A QR code is a FIDUCIAL. Its three finder patterns are engineered for exactly
 * the conditions that defeat feature matching: steep angles, motion blur, low
 * light, partial occlusion. And because it is unambiguous, there is no
 * self-similarity problem.
 *
 * So: image tracking stays primary. This runs ONLY while the target is lost,
 * at a low rate, and publishes a pose the marker runtime can re-lock to.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a replacement for image tracking. QR pose from four coplanar points is
 * noisier than a good feature track, and it is only as accurate as the physical
 * QR size it is told about. It is a way back from a wrong anchor, not a way to
 * hold a right one.
 */
(() => {
  const CFG = (window.STEAKOUT_AR_CONFIG && window.STEAKOUT_AR_CONFIG.marker) || {};

  // The QR's printed edge length in METRES, measured on the actual flyer.
  // Everything downstream scales linearly with this: get it wrong and the meal
  // lands at the right angle but the wrong distance.
  const QR_SIZE_M = Number(CFG.qrPhysicalSizeMetres || 0.075);

  // Only while lost, and cheaply. Decoding every frame would cost more than the
  // tracking it is backstopping.
  const SCAN_HZ = 3;
  const MAX_EDGE = 480;            // downscale before decode; QR survives it

  let jsQRPromise = null;
  let lastScanAt = 0;
  let enabled = false;
  let canvas = null;
  let ctx = null;

  const loadJsQR = () => {
    if (jsQRPromise) return jsQRPromise;
    jsQRPromise = new Promise((resolve, reject) => {
      if (window.jsQR) return resolve(window.jsQR);
      const s = document.createElement('script');
      s.src = './vendor/jsqr/jsQR.js';
      s.onload = () => resolve(window.jsQR);
      s.onerror = () => reject(new Error('jsQR failed to load'));
      document.head.appendChild(s);
    });
    return jsQRPromise;
  };

  /* ----------------------------------------------------------------------
   * Pose from a planar homography.
   *
   * Four coplanar correspondences give H mapping the QR plane to the image.
   * With intrinsics K:  H ~ K [r1 r2 t]
   * so  r1 = K^-1 h1 / lambda,  r2 = K^-1 h2 / lambda,  r3 = r1 x r2,
   *     t  = K^-1 h3 / lambda,  lambda = 1 / |K^-1 h1|
   * The recovered r1,r2 are not exactly orthonormal (noise), so they are
   * re-orthogonalised before use.
   * -------------------------------------------------------------------- */

  const solveHomography = (src, dst) => {
    // src: 4 object points (x,y) on the QR plane. dst: 4 image points (x,y).
    // Builds the 8x8 system for h11..h32 with h33 = 1.
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    // Gaussian elimination with partial pivoting.
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  };

  const poseFromHomography = (H, K) => {
    if (!H) return null;
    const { fx, fy, cx, cy } = K;
    // K^-1 applied to a column of H.
    const inv = (c) => [(H[0][c] - cx * H[2][c]) / fx, (H[1][c] - cy * H[2][c]) / fy, H[2][c]];
    const h1 = inv(0), h2 = inv(1), h3 = inv(2);
    const n1 = Math.hypot(h1[0], h1[1], h1[2]);
    const n2 = Math.hypot(h2[0], h2[1], h2[2]);
    if (!(n1 > 1e-9) || !(n2 > 1e-9)) return null;
    // Average the two scale estimates: using only one biases the result when
    // the correspondences are noisy.
    const lambda = 2 / (n1 + n2);

    let r1 = h1.map((v) => v * lambda);
    let r2 = h2.map((v) => v * lambda);
    const t = h3.map((v) => v * lambda);

    // Re-orthogonalise: keep r1, project r2 off it, r3 = r1 x r2.
    const dot = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
    r2 = r2.map((v, i) => v - dot * r1[i]);
    const rn1 = Math.hypot(...r1), rn2 = Math.hypot(...r2);
    if (!(rn1 > 1e-9) || !(rn2 > 1e-9)) return null;
    r1 = r1.map((v) => v / rn1);
    r2 = r2.map((v) => v / rn2);

    // A QR seen from the front must be in FRONT of the camera. In the pinhole
    // convention used here the camera looks down +Z, so a valid solution has
    // t[2] > 0. Homography decomposition yields a sign-ambiguous pair; if the
    // negative one came back, flip the whole basis rather than discard it.
    if (t[2] < 0) {
      r1 = r1.map((v) => -v);
      r2 = r2.map((v) => -v);
      t[0] = -t[0]; t[1] = -t[1]; t[2] = -t[2];
    }
    const r3 = [
      r1[1] * r2[2] - r1[2] * r2[1],
      r1[2] * r2[0] - r1[0] * r2[2],
      r1[0] * r2[1] - r1[1] * r2[0]
    ];
    return { r1, r2, r3, t };
  };

  const rotationToQuaternion = (r1, r2, r3) => {
    // Columns are the basis vectors; build the matrix row-wise.
    const m00 = r1[0], m01 = r2[0], m02 = r3[0];
    const m10 = r1[1], m11 = r2[1], m12 = r3[1];
    const m20 = r1[2], m21 = r2[2], m22 = r3[2];
    const tr = m00 + m11 + m22;
    let w, x, y, z;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    const n = Math.hypot(x, y, z, w) || 1;
    return { x: x / n, y: y / n, z: z / n, w: w / n };
  };

  const poseFromCorners = (corners, K, sizeM) => {
    const h = sizeM / 2;
    const object = [
      { x: -h, y: h }, { x: h, y: h }, { x: h, y: -h }, { x: -h, y: -h }
    ];
    const pose = poseFromHomography(solveHomography(object, corners), K);
    if (!pose) return null;
    return {
      position: { x: pose.t[0], y: pose.t[1], z: pose.t[2] },
      quaternion: rotationToQuaternion(pose.r1, pose.r2, pose.r3)
    };
  };

  // Exposed for tests; the pipeline below is the runtime path.
  window.SteakoutQrPose = { solveHomography, poseFromHomography, poseFromCorners };

  /* ------------------------------------------------------------------ */

  const scanFrame = async (processCpuResult) => {
    const now = performance.now();
    if (now - lastScanAt < 1000 / SCAN_HZ) return;
    lastScanAt = now;

    const jsQR = await loadJsQR().catch(() => null);
    if (!jsQR) return;

    const video = document.querySelector('video');
    if (!video || !video.videoWidth) return;

    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(video, 0, 0, w, h);

    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return; }
    const found = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (!found || !found.location) return;

    const L = found.location;
    const up = (p) => ({ x: p.x / scale, y: p.y / scale });
    const corners = [up(L.topLeftCorner), up(L.topRightCorner),
                     up(L.bottomRightCorner), up(L.bottomLeftCorner)];

    const intr = processCpuResult && processCpuResult.processCpuResult
      && processCpuResult.processCpuResult.reality
      && processCpuResult.processCpuResult.reality.intrinsics;
    const K = intr ? { fx: intr[0], fy: intr[5], cx: intr[8], cy: intr[9] }
                   : { fx: video.videoWidth, fy: video.videoWidth,
                       cx: video.videoWidth / 2, cy: video.videoHeight / 2 };

    const pose = poseFromCorners(corners, K, QR_SIZE_M);
    if (!pose) return;

    window.dispatchEvent(new CustomEvent('steakout-qr-pose', {
      detail: { pose, corners, sizeM: QR_SIZE_M, text: found.data || null, at: now }
    }));
  };

  const pipelineModule = {
    name: 'steakout-qr-recovery',
    onProcessCpu: (args) => { if (enabled) scanFrame(args); }
  };

  const install = () => {
    if (!window.XR8 || !window.XR8.addCameraPipelineModule) return false;
    window.XR8.addCameraPipelineModule(pipelineModule);
    return true;
  };

  // Only run while the flyer is lost. This is a backstop, not a second tracker.
  window.addEventListener('steakout-qr-recovery', (e) => { enabled = !!(e.detail && e.detail.enabled); });

  if (!install()) {
    const t = window.setInterval(() => { if (install()) window.clearInterval(t); }, 250);
    window.setTimeout(() => window.clearInterval(t), 20000);
  }
})();
