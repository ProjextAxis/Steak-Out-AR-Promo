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

  const start = () => {
    const scene = document.querySelector('#marker-scene');
    if (!scene) return setTimeout(start, 300);
    const sys = scene.systems && scene.systems['mindar-image-system'];
    if (!sys || !sys.controller || !hook(sys.controller)) return setTimeout(start, 300);
    draw();
  };

  const cv = document.createElement('canvas');
  cv.id = 'ar-xray';
  cv.style.cssText = 'position:fixed;inset:0;z-index:6;pointer-events:none';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(cv));
  if (document.readyState !== 'loading') document.body.appendChild(cv);

  const draw = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const vw = state.vw, vh = state.vh;
    if (vw && vh) {
      // MindAR covers the viewport with the feed; match that mapping.
      const scale = Math.max(W / vw, H / vh);
      const ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
      const X = (x) => ox + x * scale, Y = (y) => oy + y * scale;

      const since = performance.now() - state.lastMatchAt;
      const live = state.lastMatchAt && since < 400;

      if (state.crop) {
        g.strokeStyle = live ? 'rgba(60,220,110,.95)' : 'rgba(255,190,40,.9)';
        g.lineWidth = 3;
        g.strokeRect(X(state.crop.x), Y(state.crop.y), state.crop.s * scale, state.crop.s * scale);
        g.fillStyle = live ? 'rgba(60,220,110,.10)' : 'rgba(255,190,40,.07)';
        g.fillRect(X(state.crop.x), Y(state.crop.y), state.crop.s * scale, state.crop.s * scale);
      }

      // Every feature the detector returned this frame.
      g.fillStyle = live ? 'rgba(60,255,140,.95)' : 'rgba(90,200,255,.9)';
      for (const p of state.points) {
        g.beginPath(); g.arc(X(p.x), Y(p.y), 2.4, 0, 6.2832); g.fill();
      }

      const pad = 10;
      g.font = '600 13px ui-monospace,Menlo,monospace';
      const lines = [
        'feed ' + vw + 'x' + vh + '   crop ' + state.cropSize,
        'patch ' + (window.__steakoutCameraPatch || '?'),
        'cam ' + ((window.__steakoutCameraTrail||[]).join(' > ').slice(-40) || 'never called'),
        'features ' + state.points.length,
        'match ' + state.matches + '/' + state.attempts + (live ? '   LOCKED' : '   searching'),
        state.lastMatchAt ? 'last match ' + (since / 1000).toFixed(1) + 's ago' : 'no match yet'
      ];
      // Size the panel to the longest line; fixed widths clipped off-screen.
      let wBox = 0;
      lines.forEach((t) => { wBox = Math.max(wBox, g.measureText(t).width); });
      wBox += 20;
      const hBox = lines.length * 18 + 12;
      g.fillStyle = 'rgba(0,0,0,.62)';
      g.fillRect(pad, pad + 96, wBox, hBox);
      g.fillStyle = live ? '#5cff8c' : '#ffd34d';
      lines.forEach((t, i) => g.fillText(t, pad + 10, pad + 96 + 20 + i * 18));
    }
    requestAnimationFrame(draw);
  };

  start();
})();
