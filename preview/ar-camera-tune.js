/*
 * The camera must be asked for resolution, or it hands back far too little.
 *
 * Measured on a real device with the x-ray overlay, an UNCONSTRAINED
 * getUserMedia returned 480x640. That is 0.3 megapixels, and at that size the
 * printed flyer has almost no resolvable detail: the detector still finds 180-280
 * feature points per frame, but they scatter across the table and the matcher
 * scored single-digit successes across 500+ attempts.
 *
 * This file originally capped resolution DOWN to 720p to cut per-frame work.
 * That was solving the wrong problem. Detection cost was never the bottleneck;
 * having enough pixels on the marker is.
 *
 * So: ask for 1080p, and fall back through 720p rather than accept the default.
 * `ideal` is a request, not a guarantee, so what was actually granted is
 * published on window.__steakoutCamera and shown in the x-ray HUD.
 *
 * For reference, the detection crop is sized from HALF the smaller dimension:
 *     cropSize = 2 ** Math.round(Math.log2(Math.min(w, h) / 2))
 * so 480x640 gives 256, and 1080p gives 512.
 */
(() => {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;

  // ?ar=C|D leaves the request untouched, so the browser default can still be
  // measured against a constrained one.
  const VARIANT = (new URLSearchParams(location.search).get('ar') || 'A').toUpperCase();
  const LEAVE_ALONE = VARIANT === 'C' || VARIANT === 'D';

  const native = md.getUserMedia.bind(md);

  const publish = (stream) => {
    try {
      const s = stream.getVideoTracks()[0]?.getSettings?.();
      if (s) {
        const min = Math.min(s.width || 0, s.height || 0);
        window.__steakoutCamera = {
          width: s.width, height: s.height, frameRate: s.frameRate,
          constrained: !LEAVE_ALONE,
          detectionCrop: min ? Math.pow(2, Math.round(Math.log2(min / 2))) : null
        };
      }
    } catch (error) { /* reporting only */ }
    return stream;
  };

  const wrapped = function (constraints) {
    const video = constraints && constraints.video;
    const unsized = video && typeof video === 'object' &&
                    video.width === undefined && video.height === undefined;

    if (LEAVE_ALONE || !unsized) return native(constraints).then(publish);

    const ask = (w, h) => native({
      ...constraints,
      video: { ...video, width: { ideal: w }, height: { ideal: h } }
    });

    // `ideal` is advisory and gets silently ignored, which is indistinguishable
    // from the device genuinely not offering the mode. Try `exact` first: if the
    // camera cannot do it, it REJECTS, and that is a definitive answer rather
    // than a quiet downgrade. Fall back through ideal, then the plain request.
    const exact = (w, h) => native({
      ...constraints,
      video: { ...video, width: { exact: w }, height: { exact: h } }
    });

    window.__steakoutCameraTrail = [];
    const note = (t) => { window.__steakoutCameraTrail.push(t); };

    return exact(1920, 1080).then((s) => (note('exact 1920x1080 OK'), s))
      .catch(() => { note('exact 1920x1080 REJECTED'); return exact(1280, 720); })
      .then((s) => (note('exact 1280x720 OK'), s))
      .catch(() => { note('exact 1280x720 REJECTED'); return ask(1920, 1080); })
      .then((s) => (note('fell back to ideal'), s))
      .catch(() => { note('ideal failed, using plain request'); return native(constraints); })
      .then(publish);
  };

  /* Installing the wrapper is not just an assignment.
   *
   * getUserMedia lives on MediaDevices.prototype and on some browsers is
   * non-writable. A plain `md.getUserMedia = fn` then fails SILENTLY in
   * non-strict code: no error, no override, and the library keeps calling the
   * native method. That is what happened here. Chrome accepted the assignment
   * so it looked installed under test, and Safari ignored it, so on the phone
   * the constraint never applied and the feed stayed at the default.
   *
   * Define it, verify it took, and fall back to the prototype. Record which
   * route worked so the overlay can show it instead of us assuming.
   */
  const install = () => {
    try {
      Object.defineProperty(md, 'getUserMedia',
        { value: wrapped, writable: true, configurable: true });
      if (md.getUserMedia === wrapped) return 'instance';
    } catch (error) { /* fall through */ }

    try {
      const proto = Object.getPrototypeOf(md);
      Object.defineProperty(proto, 'getUserMedia',
        { value: wrapped, writable: true, configurable: true });
      if (navigator.mediaDevices.getUserMedia === wrapped) return 'prototype';
    } catch (error) { /* fall through */ }

    return 'FAILED';
  };

  window.__steakoutCameraPatch = install();
})();
