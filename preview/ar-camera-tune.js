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

  md.getUserMedia = function (constraints) {
    const video = constraints && constraints.video;
    const unsized = video && typeof video === 'object' &&
                    video.width === undefined && video.height === undefined;

    if (LEAVE_ALONE || !unsized) return native(constraints).then(publish);

    const ask = (w, h) => native({
      ...constraints,
      video: { ...video, width: { ideal: w }, height: { ideal: h } }
    });

    // Ask high, step down, and only then accept whatever the browser wants.
    return ask(1920, 1080)
      .catch(() => ask(1280, 720))
      .catch(() => native(constraints))
      .then(publish);
  };
})();
