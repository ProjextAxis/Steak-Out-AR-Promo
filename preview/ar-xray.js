/* AR diagnostics. No camera pixels or textures are ever retained.
 *
 * RIG MODE: with ALWAYS_ON the HUD is on screen permanently and cannot be
 * tapped shut, because the test phone is bolted to the gimbal and cannot be
 * tapped at all. Set ALWAYS_ON = false to restore the opt-in ?ar-debug=1
 * behaviour -- do that before this is live in front of customers. */
(() => {
  const ALWAYS_ON = true;    // DEBUGGING the spatial lock. false before ship.   // Customer default. ?ar-debug=1 or ?xray=1 opts in.
  const params = new URLSearchParams(location.search);

  /* DEV MODE (?dev=1): strip the branded chrome and put the diagnostics at the
   * TOP. During a rig run the header, the ORDER NOW pill, the social buttons
   * and the step ribbon are pure obstruction -- they cover the camera view we
   * are trying to read and sit on top of the panel. Customers never see this;
   * it is opt-in and leaves the normal styling untouched. */
  const DEV = params.get('dev') === '1';
  if (!ALWAYS_ON && params.get('ar-debug') !== '1' && params.get('xray') !== '1') return;

  const scene = document.querySelector('#marker-scene');
  const anchor = document.querySelector('#marker-anchor');
  if (!scene || !anchor) return;

  const PIPELINE_NAME = 'steakout-anchor-diagnostics';
  const MAX_LOG_AGE_MS = 60000;
  const MAX_LOG_ENTRIES = 2400;
  const FRAME_SAMPLE_MS = 250;
  const PANEL_UPDATE_MS = 250;
  const FRAME_HISTORY_LIMIT = 240;
  const log = [];
  const listeners = [];
  let disposed = false;
  let pipelineInstalled = false;
  let nextFrameSampleAt = 0;
  let lastInvariantWarningAt = 0;
  let lastTargetUpdateAt = 0;
  let committedAnchor;
  let previousRealityFrame;
  let lastFrameAnomalyAt = 0;
  let faultCount = 0;
  let lastPoseAt = 0;
  let baseAnchorState = 'idle';
  const FAULT_DECAY_MS = 1500;
  const frameHistory = [];
  const anomalyCaptures = [];

  const state = {
    camera: 'not requested',
    tracking: 'not started',
    image: 'not found',
    anchor: 'idle',
    anchorDetail: {},
    lastFaultInfo: '',
    pose: '',
    lastEvent: 'debug enabled'
  };

  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const round = (value, digits = 5) => {
    const number = finite(value);
    return number === null ? null : Number(number.toFixed(digits));
  };

  const safeCopy = (value, depth = 0) => {
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? round(value) : String(value);
    if (typeof value === 'string') return value.slice(0, 160);
    if (depth >= 4) return '[depth]';
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeCopy(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 80);
    const result = {};
    Object.keys(value).slice(0, 30).forEach((key) => {
      const next = value[key];
      if (typeof next !== 'function' && !(next instanceof Node)) result[key] = safeCopy(next, depth + 1);
    });
    return result;
  };

  const record = (type, detail = {}) => {
    if (disposed) return;
    const now = performance.now();
    log.push({ t: round(now, 3), type, detail: safeCopy(detail) });
    while (log.length && (log.length > MAX_LOG_ENTRIES || now - log[0].t > MAX_LOG_AGE_MS)) log.shift();
    state.lastEvent = type;
    if (type === 'anchor-committed') committedAnchor = safeCopy(detail.anchor);
    if (type === 'session-start' && detail.scaleMode) state.scaleMode = detail.scaleMode;
  };

  const setAnchorState = (nextState, detail = {}) => {
    // Remember the app's real (non-fault) state so a transient camera-translation
    // fault can decay back to it instead of latching on the dot forever.
    if (nextState !== 'fault') baseAnchorState = nextState;
    state.anchor = nextState;
    state.anchorDetail = safeCopy(detail);
  };

  window.STEAKOUT_AR_DIAGNOSTICS = { record, setAnchorState, getLog: () => safeCopy(log) };
  record('debug-enabled', { href: location.pathname, userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight] });

  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const targetPose = (detail = {}) => {
    const scale = finite(detail.scale);
    const scaledWidth = finite(detail.scaledWidth);
    const scaledHeight = finite(detail.scaledHeight);
    return {
      name: detail.name || '',
      position: detail.position ? {
        x: round(detail.position.x), y: round(detail.position.y), z: round(detail.position.z)
      } : null,
      rotation: detail.rotation ? {
        x: round(detail.rotation.x), y: round(detail.rotation.y),
        z: round(detail.rotation.z), w: round(detail.rotation.w)
      } : null,
      scale,
      scaledWidth,
      scaledHeight,
      width: scale !== null && scaledWidth !== null ? round(scale * scaledWidth) : null,
      height: scale !== null && scaledHeight !== null ? round(scale * scaledHeight) : null
    };
  };

  const poseSummary = (pose) => {
    if (!pose.position) return 'pose unavailable';
    const p = pose.position;
    const width = pose.width === null ? '?' : pose.width.toFixed(3);
    return `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} · flyer ${width}`;
  };

  listen(scene, 'camerastatuschange', ({ detail = {} }) => {
    state.camera = detail.status || 'unknown';
    record('scene-camera-status', { status: state.camera });
  });
  listen(scene, 'realityready', () => record('scene-reality-ready'));
  listen(scene, 'realityerror', ({ detail = {} }) => {
    const error = detail.error || detail;
    state.camera = `error ${error?.name || 'unknown'}`;
    record('scene-reality-error', { name: error?.name, message: error?.message });
  });
  listen(scene, 'xrtrackingstatus', ({ detail = {} }) => {
    state.tracking = String(detail.status || detail.state || detail.trackingStatus || 'unknown').toUpperCase();
    record('scene-tracking-status', { status: state.tracking, reason: detail.reason || detail.trackingReason });
  });
  listen(scene, 'xrimagescanning', () => {
    state.image = 'scanning';
    record('scene-image-scanning');
  });
  listen(scene, 'xrimagefound', ({ detail = {} }) => {
    const pose = targetPose(detail);
    state.image = `found ${pose.name || 'target'}`;
    state.pose = poseSummary(pose);
    lastPoseAt = performance.now();
    record('scene-image-found', pose);
  });
  listen(scene, 'xrimageupdated', ({ detail = {} }) => {
    const pose = targetPose(detail);
    state.image = `tracking ${pose.name || 'target'}`;
    state.pose = poseSummary(pose);
    const now = performance.now();
    lastPoseAt = now;
    if (now - lastTargetUpdateAt >= FRAME_SAMPLE_MS) {
      lastTargetUpdateAt = now;
      record('scene-image-updated', pose);
    }
  });
  listen(scene, 'xrimagelost', ({ detail = {} }) => {
    state.image = `lost ${detail.name || 'target'}`;
    record('scene-image-lost', { name: detail.name || '' });
  });

  ['visibilitychange', 'pageshow', 'pagehide', 'orientationchange', 'focus', 'blur'].forEach((type) => {
    const target = type === 'visibilitychange' ? document : window;
    listen(target, type, () => record(`dom-${type}`, {
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      orientation: screen.orientation?.type || window.orientation,
      viewport: [innerWidth, innerHeight]
    }));
  });
  listen(window, 'message', (event) => {
    if (event.origin !== location.origin || !/^steakout-ar-/.test(event.data?.type || '')) return;
    record('parent-message', { type: event.data.type });
  });

  const matrix = (value) => {
    const elements = value?.elements || value;
    return elements && typeof elements.length === 'number'
      ? Array.from(elements).slice(0, 16).map((entry) => round(entry))
      : null;
  };
  const vector = (value) => value ? [round(value.x), round(value.y), round(value.z)] : null;
  const quaternion = (value) => value ? [round(value.x), round(value.y), round(value.z), round(value.w)] : null;

  const cameraSnapshot = () => {
    const camera = scene.camera;
    if (!camera) return null;
    return {
      position: vector(camera.position),
      quaternion: quaternion(camera.quaternion),
      matrixWorld: matrix(camera.matrixWorld),
      projection: matrix(camera.projectionMatrix)
    };
  };

  const anchorSnapshot = () => {
    const object = anchor.object3D;
    if (!object) return null;
    return {
      visible: object.visible,
      position: vector(object.position),
      quaternion: quaternion(object.quaternion),
      scale: vector(object.scale),
      matrixWorld: matrix(object.matrixWorld)
    };
  };

  const quaternionDifference = (first, second) => {
    if (!first?.every(Number.isFinite) || !second?.every(Number.isFinite)) return 0;
    const dot = Math.abs(first.reduce((sum, entry, index) => sum + entry * second[index], 0));
    return 2 * Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  };

  const vectorDifference = (first, second) => first?.every(Number.isFinite) && second?.every(Number.isFinite)
    ? Math.hypot(...first.map((entry, index) => entry - second[index]))
    : 0;

  const matrixDifference = (first, second) => first?.every(Number.isFinite) && second?.every(Number.isFinite)
    ? first.reduce((maximum, entry, index) => Math.max(maximum, Math.abs(entry - second[index])), 0)
    : 0;

  const realityFrame = (result, now) => {
    const frame = result.frameStartResult || {};
    const reality = result.processCpuResult?.reality || result.reality || {};
    return {
      t: round(now, 3),
      videoTime: finite(frame.videoTime),
      repeatFrame: Boolean(frame.repeatFrame),
      orientation: frame.orientation ?? null,
      position: vector(reality.position),
      rotation: quaternion(reality.rotation),
      intrinsics: matrix(reality.intrinsics),
      trackingStatus: reality.trackingStatus || null,
      trackingReason: reality.trackingReason || null
    };
  };

  const detectRealityAnomaly = (current, previous) => {
    if (!committedAnchor || !previous) return null;
    const anchorWidth = Number(committedAnchor.scale?.[0]) || 1;
    const translationLimit = Math.max(state.scaleMode === 'absolute' ? 0.10 : 0, anchorWidth * 0.50);
    const translation = vectorDifference(current.position, previous.position);
    const rotation = quaternionDifference(current.rotation, previous.rotation);
    const projection = matrixDifference(current.intrinsics, previous.intrinsics);
    const trackingChanged = previous.trackingStatus && current.trackingStatus &&
      previous.trackingStatus !== current.trackingStatus;
    const reasons = [];
    if (translation > translationLimit) reasons.push('camera-translation');
    if (rotation > 35) reasons.push('camera-rotation');
    if (projection > 0.08) reasons.push('projection');
    if (trackingChanged && String(current.trackingStatus).toUpperCase() !== 'NORMAL') reasons.push('tracking');
    return reasons.length ? { reasons, translation, translationLimit, rotation, projection } : null;
  };

  const checkAnchorInvariant = (snapshot, now) => {
    if (!committedAnchor || !snapshot || now - lastInvariantWarningAt < 1000) return;
    const expectedPosition = committedAnchor.position;
    const expectedQuaternion = committedAnchor.quaternion;
    const expectedScale = committedAnchor.scale;
    if (!expectedPosition || !expectedQuaternion || !expectedScale) return;
    const positionDelta = Math.hypot(...snapshot.position.map((entry, index) => entry - expectedPosition[index]));
    const rotationDelta = quaternionDifference(snapshot.quaternion, expectedQuaternion);
    const scaleDelta = Math.abs(snapshot.scale[0] / expectedScale[0] - 1);
    const positionLimit = Math.max(0.002, expectedScale[0] * 0.01);
    if (positionDelta > positionLimit || rotationDelta > 0.5 || scaleDelta > 0.005) {
      // The invariant is "nothing moves the anchor after commit", which was true
      // until grounding started deliberately correcting SLAM drift toward the
      // flyer. A sanctioned correction is not a fault -- reporting it as one
      // buries real faults under a constant false alarm, and makes the HUD say
      // the lock is broken at the exact moment it is being repaired.
      let grounding = false;
      try {
        const g = window.STEAKOUT_GROUND_STATE && window.STEAKOUT_GROUND_STATE();
        grounding = !!(g && g.correcting);
      } catch (e) { /* the AR page may not expose it; treat as a real fault */ }

      if (grounding) {
        record('anchor-moved-by-grounding', {
          positionDelta, rotationDelta, scaleDelta, positionLimit
        });
      } else {
        lastInvariantWarningAt = now;
        setAnchorState('fault', { reason: 'anchor-invariant' });
        record('anchor-invariant-warning', { positionDelta, rotationDelta, scaleDelta, positionLimit, snapshot });
      }
    }
  };

  const dimensions = (detail = {}) => ({
    canvas: [finite(detail.canvasWidth || detail.canvas?.width), finite(detail.canvasHeight || detail.canvas?.height)],
    video: [finite(detail.videoWidth), finite(detail.videoHeight)],
    orientation: detail.orientation ?? detail.videoOrientation ?? null
  });

  const pipelineModule = {
    name: PIPELINE_NAME,
    onAttach: (detail) => record('pipeline-attach', dimensions(detail)),
    onStart: (detail) => record('pipeline-start', dimensions(detail)),
    onDetach: () => record('pipeline-detach'),
    onRemove: () => { pipelineInstalled = false; record('pipeline-remove'); },
    onCameraStatusChange: (detail = {}) => record('pipeline-camera-status', { status: detail.status }),
    onPaused: () => record('pipeline-paused'),
    onResume: () => record('pipeline-resumed'),
    onDeviceOrientationChange: (detail) => record('pipeline-orientation', dimensions(detail)),
    onCanvasSizeChange: (detail) => record('pipeline-canvas-size', dimensions(detail)),
    onVideoSizeChange: (detail) => record('pipeline-video-size', dimensions(detail)),
    onException: (error = {}) => record('pipeline-exception', { name: error.name, message: error.message }),
    onUpdate: (result = {}) => {
      const now = performance.now();
      const frame = result.frameStartResult || {};
      const currentRealityFrame = realityFrame(result, now);
      frameHistory.push(currentRealityFrame);
      if (frameHistory.length > FRAME_HISTORY_LIMIT) frameHistory.shift();
      anomalyCaptures.forEach((capture) => {
        if (capture.remaining > 0) {
          capture.frames.push(currentRealityFrame);
          capture.remaining -= 1;
        }
      });
      const anomaly = detectRealityAnomaly(currentRealityFrame, previousRealityFrame);
      previousRealityFrame = currentRealityFrame;
      if (anomaly && now - lastFrameAnomalyAt >= 250) {
        lastFrameAnomalyAt = now;
        anomalyCaptures.push({ detectedAt: round(now, 3), anomaly, frames: [...frameHistory], remaining: 60 });
        if (anomalyCaptures.length > 4) anomalyCaptures.shift();
        faultCount += 1;
        // Surface how far past the limit the jump was, so the on-screen HUD alone
        // carries the calibration number (no need to open the saved log for it).
        state.lastFaultInfo = `${anomaly.reasons.join(',')} ${round(anomaly.translation, 3)}>${round(anomaly.translationLimit, 3)}`;
        setAnchorState('fault', {
          reason: anomaly.reasons.join(','),
          translation: round(anomaly.translation, 3),
          limit: round(anomaly.translationLimit, 3)
        });
        record('frame-anomaly', anomaly);
      }
      // A camera-translation fault is a momentary event, not a persistent state.
      // Let the dot fall back to the app's real anchor state after a quiet period
      // so it stops overstating on ordinary fast panning. The faults counter keeps
      // the running total; a genuine anchor-invariant fault does NOT decay.
      if (state.anchor === 'fault' && state.anchorDetail?.reason !== 'anchor-invariant' &&
          now - lastFrameAnomalyAt >= FAULT_DECAY_MS) {
        state.anchor = baseAnchorState;
        state.anchorDetail = {};
      }
      if (now < nextFrameSampleAt && !anomaly) return;
      nextFrameSampleAt = now + FRAME_SAMPLE_MS;
      const anchorState = anchorSnapshot();
      checkAnchorInvariant(anchorState, now);
      record('frame', {
        videoTime: finite(frame.videoTime),
        repeatFrame: Boolean(frame.repeatFrame),
        orientation: frame.orientation ?? null,
        texture: [finite(frame.textureWidth), finite(frame.textureHeight)],
        reality: {
          position: currentRealityFrame.position,
          rotation: currentRealityFrame.rotation,
          trackingStatus: currentRealityFrame.trackingStatus,
          trackingReason: currentRealityFrame.trackingReason,
          intrinsics: currentRealityFrame.intrinsics
        },
        camera: cameraSnapshot(),
        anchor: anchorState,
        viewport: [innerWidth, innerHeight]
      });
    }
  };

  const installPipeline = () => {
    if (disposed || pipelineInstalled || !window.XR8?.addCameraPipelineModule) return;
    window.XR8.addCameraPipelineModule(pipelineModule);
    pipelineInstalled = true;
    record('pipeline-installed', { name: PIPELINE_NAME });
  };
  installPipeline();
  listen(window, 'xrloaded', installPipeline, { once: true });

  const style = document.createElement('style');
  style.id = 'steakout-ar-debug-style';
  style.textContent = `
    #steakout-ar-debug-toggle{position:fixed;left:max(7px,env(safe-area-inset-left));bottom:max(7px,env(safe-area-inset-bottom));z-index:1001;width:40px;height:40px;border:0;background:transparent;padding:0;display:grid;place-items:center;touch-action:manipulation}
    #steakout-ar-debug-toggle span{width:9px;height:9px;border-radius:50%;background:#88929b;box-shadow:0 0 0 2px rgba(0,0,0,.7),0 0 8px rgba(255,255,255,.35)}
    #steakout-ar-debug-toggle[data-state="camera"] span,#steakout-ar-debug-toggle[data-state="scanning"] span{background:#4ca7ff}
    #steakout-ar-debug-toggle[data-state="candidate"] span,#steakout-ar-debug-toggle[data-state="stabilizing"] span,#steakout-ar-debug-toggle[data-state="candidate-warning"] span,#steakout-ar-debug-toggle[data-state="limited"] span{background:#ffb020}
    #steakout-ar-debug-toggle[data-state="committed"] span{background:#43db82}
    #steakout-ar-debug-toggle[data-state="fault"] span{background:#ff4b55}
    #steakout-ar-debug-panel{position:fixed;left:max(8px,env(safe-area-inset-left));bottom:calc(max(8px,env(safe-area-inset-bottom)) + 45px);z-index:1001;width:min(430px,calc(100vw - 16px));max-height:55vh;overflow:auto;box-sizing:border-box;padding:12px;border:1px solid rgba(127,255,177,.4);border-radius:10px;background:rgba(0,0,0,.86);color:#dfffea;font:600 11px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;box-shadow:0 10px 40px rgba(0,0,0,.45)}
    #steakout-ar-debug-panel[hidden]{display:none}
    #steakout-ar-debug-actions{display:flex;gap:8px;margin-top:10px}
    #steakout-ar-debug-actions button{border:1px solid rgba(255,255,255,.4);border-radius:6px;background:#151a18;color:#fff;padding:8px 10px;font:700 10px ui-monospace,Menlo,monospace}
  `;
  document.head.appendChild(style);

  if (DEV) {
    const dev = document.createElement('style');
    dev.id = 'steakout-dev-mode-style';
    dev.textContent = `
      #marker-hud, #marker-order, #marker-social, #marker-progress,
      #marker-instruction, #marker-intro { display: none !important; }
      /* Diagnostics move to the top, out of the way of the camera view. */
      #steakout-ar-debug-panel{
        top: max(8px, env(safe-area-inset-top)) !important;
        bottom: auto !important;
        max-height: 46vh !important;
      }
      #steakout-ar-debug-toggle{
        top: calc(max(8px, env(safe-area-inset-top)) + 4px) !important;
        bottom: auto !important;
        left: auto !important;
        right: max(10px, env(safe-area-inset-right)) !important;
      }
    `;
    document.head.appendChild(dev);
  }

  const toggle = document.createElement('div');
  toggle.id = 'steakout-ar-debug-toggle';
  toggle.setAttribute('role', 'status');
  toggle.setAttribute('aria-label', 'AR anchor state');
  toggle.dataset.state = 'idle';
  toggle.appendChild(document.createElement('span'));

  const panel = document.createElement('section');
  panel.id = 'steakout-ar-debug-panel';
  panel.hidden = false;
  panel.setAttribute('aria-label', 'AR diagnostics');
  const output = document.createElement('div');
  const actions = document.createElement('div');
  actions.id = 'steakout-ar-debug-actions';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'SAVE 60S LOG';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = 'REMOVE';
  actions.append(copyButton, removeButton);
  panel.append(output, actions);
  document.body.append(toggle, panel);

  const render = () => {
    toggle.dataset.state = state.anchor;
    if (panel.hidden) return;
    const detail = state.anchorDetail || {};
    const poseAge = lastPoseAt ? ` · ${Math.round(performance.now() - lastPoseAt)}ms` : '';
    output.textContent = [
      `STEAK OUT AR · ${state.scaleMode || params.get('xrscale') || 'responsive'}`,
      `camera    ${state.camera}`,
      `tracking  ${state.tracking}`,
      `image     ${state.image}`,
      `anchor    ${state.anchor}`,
      `samples   ${detail.sampleCount ?? '-'}`,
      `reason    ${detail.reason || '-'}`,
      `faults    ${faultCount}${state.lastFaultInfo ? '  last ' + state.lastFaultInfo : ''}`,
      `pose      ${state.pose || 'waiting'}${poseAge}`,
      `event     ${state.lastEvent}`,
      `log       ${log.length} entries / last 60s`
    ].join('\n');
  };
  const renderTimer = window.setInterval(render, PANEL_UPDATE_MS);

  const flashButton = (text) => {
    copyButton.textContent = text;
    window.setTimeout(() => { copyButton.textContent = 'SAVE 60S LOG'; }, 2200);
  };

  /* Last-resort retrieval: a full-screen selectable textarea. Even if a file
     download and the clipboard are both blocked (iframe permission policy, old
     iOS), the log can always be long-pressed -> Select All -> Share. Tap closes. */
  const revealSelectableLog = (payload) => {
    let box = document.getElementById('steakout-ar-debug-raw');
    if (!box) {
      box = document.createElement('textarea');
      box.id = 'steakout-ar-debug-raw';
      box.readOnly = true;
      box.style.cssText = 'position:fixed;inset:8px;z-index:1002;box-sizing:border-box;' +
        'padding:10px;font:600 10px/1.4 ui-monospace,Menlo,monospace;background:#000;' +
        'color:#dfffea;border:1px solid rgba(127,255,177,.5);border-radius:8px';
      box.addEventListener('click', () => box.remove());
      document.body.appendChild(box);
    }
    box.value = 'Long-press -> Select All -> Share. Tap this box to close.\n\n' + payload;
    box.focus();
  };

  /* The old handler only tried the clipboard, and this HUD runs INSIDE the AR
     iframe whose allow-list did not include clipboard-write, so on iOS the write
     was blocked -- and the button then said COPIED anyway. Now it actually SAVES
     a file (the reliable way to get a log off a phone), copies as a bonus, and
     only reports what genuinely happened. */
  copyButton.addEventListener('click', async () => {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      page: location.href,
      entries: log,
      anomalyCaptures
    }, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `steakout-ar-log-${stamp}.json`;

    let saved = false;
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      // Revoke late; a too-early revoke cancels the download on some engines.
      window.setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 5000);
      saved = true;
    } catch (error) { /* fall through to clipboard / selectable */ }

    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        copied = true;
      }
    } catch (error) { /* clipboard blocked; the file save is the real path */ }

    if (saved) flashButton(copied ? 'SAVED + COPIED' : 'SAVED');
    else if (copied) flashButton('COPIED');
    else { revealSelectableLog(payload); flashButton('SELECT & SHARE'); }
  });

  const remove = () => {
    if (disposed) return;
    record('debug-removed');
    disposed = true;
    window.clearInterval(renderTimer);
    listeners.splice(0).forEach((unlisten) => unlisten());
    if (pipelineInstalled) {
      try { window.XR8?.removeCameraPipelineModule?.(PIPELINE_NAME); } catch (error) { /* diagnostic cleanup only */ }
    }
    toggle.remove();
    panel.remove();
    style.remove();
    delete window.STEAKOUT_AR_DIAGNOSTICS;
  };
  removeButton.addEventListener('click', remove);
  window.STEAKOUT_AR_DIAGNOSTICS.remove = remove;
  render();
})();
