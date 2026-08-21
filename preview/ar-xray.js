/*
 * Diagnostic overlay: shows what the tracker is actually looking at and finding.
 * Off unless the URL carries ?xray=1, so customers never see it.
 *
 * Draws, per frame:
 *   - the SEARCH WINDOW, the centred crop acquisition inspects. controller.js
 *     calls cropDetector.detect(), which slices a square from the middle sized
 *     from half the smaller dimension: 256 at 720p, 512 at 1080p.
 *   - every FEATURE POINT the detector returned. These come back already offset
 *     into full-frame coordinates by _detect(), so they map straight to screen.
 *   - whether the last match SUCCEEDED, and how long since one did.
 *   - the camera report from ar-camera-tune.js: what was asked for, what came
 *     back, and what the track says it is CAPABLE of. That last one is the
 *     measurement the resolution question turns on.
 *
 * The panel draws as soon as the page loads, not only once the tracker
 * produces a frame, so a camera that never starts is still legible on a
 * recording.
 *
 * Nothing here changes tracking. It only wraps two methods to read what they
 * already return, then hands the original value straight back.
 */
(() => {
  if (new URLSearchParams(location.search).get('xray') !== '1') return;

  const state = {
    crop: null, points: [], lastMatchAt: 0, matches: 0, attempts: 0,
    matched: false, vw: 0, vh: 0, cropSize: 0
  };

  const hook = (controller) => {
    const cd = controller.cropDetector;
    if (!cd || cd.__xray) return false;
    cd.__xray = true;
    state.cropSize = cd.cropSize;

    const wrap = (name, centred) => {
      const original = cd[name].bind(cd);
      cd[name] = function (input) {
        const result = original(input);
        Promise.resolve(result).then((r) => {
          if (!r) return;
          state.points = r.featurePoints || [];
          const c = cd.cropSize;
          state.crop = centred
            ? { x: Math.floor(cd.width / 2 - c / 2), y: Math.floor(cd.height / 2 - c / 2), s: c }
            : (state.crop || { x: 0, y: 0, s: c });
          state.vw = cd.width; state.vh = cd.height;
        }).catch(() => {});
        return result;
      };
    };
    wrap('detect', true);
    if (cd.detectMoving) wrap('detectMoving', false);

    const match = controller._workerMatch?.bind(controller);
    if (match) {
      controller._workerMatch = function (...args) {
        state.attempts++;
        const p = match(...args);
        Promise.resolve(p).then((r) => {
          const ok = !!(r && r.modelViewTransform);
          state.matched = ok;
          if (ok) { state.matches++; state.lastMatchAt = performance.now(); }
        }).catch(() => {});
        return p;
      };
    }
    return true;
  };

  /* Drawing and hooking are deliberately separate.
   *
   * mind-ar only builds its controller inside _startAR, which runs after
   * getUserMedia resolves -- so a camera that never starts means no controller,
   * ever. Waiting for one before drawing meant the overlay stayed blank in
   * exactly the case worth diagnosing. Draw from load; attach when there is
   * something to attach to. */
  const hookWhenReady = () => {
    const scene = document.querySelector('#marker-scene');
    const sys = scene && scene.systems && scene.systems['mindar-image-system'];
    if (!sys || !sys.controller || !hook(sys.controller)) setTimeout(hookWhenReady, 300);
  };

  const start = () => {
    hookWhenReady();
    draw();
  };

  const cv = document.createElement('canvas');
  cv.id = 'ar-xray';
  /* width/height are NOT redundant with inset:0.
   *
   * A canvas is a replaced element, so with width:auto it takes its INTRINSIC
   * size -- the backing-store size we set below, in CSS pixels. On a 375px
   * phone at dpr 2 that laid the overlay out 750px wide and drew every glyph
   * at double size, which is why the panel ran off the right edge. Pinning the
   * CSS box to the viewport is what makes the dpr transform mean what it says.
   *
   * z-index sits above .marker-fault (9) on purpose: the fault panel is what a
   * customer should see, but ?xray=1 is opt-in, and a camera failure is
   * precisely when the numbers need to be legible on a recording. */
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:21;pointer-events:none';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(cv));
  if (document.readyState !== 'loading') document.body.appendChild(cv);

  const draw = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // Bare block: the panel below always draws, while everything keyed to the
    // video frame is guarded individually on vw/vh.
    const vw = state.vw, vh = state.vh;
    {
      // MindAR covers the viewport with the feed; match that mapping.
      const scale = (vw && vh) ? Math.max(W / vw, H / vh) : 1;
      const ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
      const X = (x) => ox + x * scale, Y = (y) => oy + y * scale;

      const since = performance.now() - state.lastMatchAt;
      const live = state.lastMatchAt && since < 400;

      if (state.crop && vw && vh) {
        g.strokeStyle = live ? 'rgba(60,220,110,.95)' : 'rgba(255,190,40,.9)';
        g.lineWidth = 3;
        g.strokeRect(X(state.crop.x), Y(state.crop.y), state.crop.s * scale, state.crop.s * scale);
        g.fillStyle = live ? 'rgba(60,220,110,.10)' : 'rgba(255,190,40,.07)';
        g.fillRect(X(state.crop.x), Y(state.crop.y), state.crop.s * scale, state.crop.s * scale);
      }

      // Every feature the detector returned this frame.
      g.fillStyle = live ? 'rgba(60,255,140,.95)' : 'rgba(90,200,255,.9)';
      for (const p of (vw && vh ? state.points : [])) {
        g.beginPath(); g.arc(X(p.x), Y(p.y), 2.4, 0, 6.2832); g.fill();
      }

      const pad = 10;
      /* Fit the panel to the screen instead of assuming it fits. The rung
       * lines vary in length with what the camera answered, and a narrow
       * phone must still show them whole -- a truncated diagnostic is how the
       * previous camera trail managed to report a fallback that never
       * happened. Shrink to fit; never clip. */
      const FIT = W - pad * 2 - 20;
      let fontPx = 13;
      const setFont = () => { g.font = '600 ' + fontPx + 'px ui-monospace,Menlo,monospace'; };
      setFont();
      /* The camera report, one fact per line.
       *
       * An earlier version joined it all into one string and kept the last 40
       * characters, which cut off the front -- the decisive part. Worse, the
       * chain it summarised ran its .then handlers on the success path too, so
       * it reported a fallback that had not happened. Give each request its own
       * line and let the reader see all of them.
       *
       * CAPS is the line that settles the open question: a track reporting
       * 1920 while the feed sits at 480x640 is a constraint problem, not a
       * hardware limit. */
      const cam = window.__steakoutCamera;
      const camLines = cam ? [
        'CAPS  ' + cam.caps
      ].concat(
        cam.rungs.length ? cam.rungs.map((r, i) => (i ? '      ' : 'ask   ') + r)
                         : ['ask   (none recorded)'],
        cam.applied ? ['apply ' + cam.applied] : [],
        ['grant ' + cam.granted]
      ) : ['cam   never called'];

      const lines = [
        'feed  ' + (vw && vh ? vw + 'x' + vh + '   crop ' + state.cropSize : 'no frames yet'),
        'patch ' + (window.__steakoutCameraPatch || '?')
      ].concat(camLines, [
        'feat  ' + state.points.length,
        'match ' + state.matches + '/' + state.attempts + (live ? '   LOCKED' : '   searching'),
        state.lastMatchAt ? 'last  ' + (since / 1000).toFixed(1) + 's ago' : 'last  no match yet'
      ]);
      // Size the panel to the longest line; fixed widths clipped off-screen.
      const widest = () => lines.reduce((m, t) => Math.max(m, g.measureText(t).width), 0);
      while (fontPx > 8 && widest() > FIT) { fontPx -= 1; setFont(); }
      const lineH = Math.round(fontPx * 1.38);
      let wBox = widest() + 20;
      const hBox = lines.length * lineH + 12;
      g.fillStyle = 'rgba(0,0,0,.62)';
      g.fillRect(pad, pad + 96, wBox, hBox);
      g.fillStyle = live ? '#5cff8c' : '#ffd34d';
      lines.forEach((t, i) => g.fillText(t, pad + 10, pad + 96 + lineH + i * lineH));
    }
    requestAnimationFrame(draw);
  };

  start();
})();
