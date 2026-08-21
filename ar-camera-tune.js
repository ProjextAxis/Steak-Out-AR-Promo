/*
 * Ask the camera for resolution, and record what it actually hands back.
 *
 * Measured on a real device, an UNCONSTRAINED getUserMedia returned 480x640.
 * That is 0.3 megapixels, and at that size the printed flyer has almost no
 * resolvable detail: the detector still finds 180-280 feature points a frame,
 * but they scatter across the room and the matcher scored single digits across
 * 500+ attempts. Tracking uptime sits at 10-14%.
 *
 * This is not known to be a device ceiling. It is a new iPhone, and Apple's own
 * ARKit is unaffected because it gets native camera access, while the web only
 * gets getUserMedia -- which on iOS defaults low unless explicitly constrained.
 *
 * THREE previous attempts to constrain it failed, each looking verified in
 * Chrome first (see tools/HANDOFF.md section 5b). The lesson from all three is
 * that reasoning about this from source produces confident wrong answers. So
 * this file's job is only half constraint. The other half is measurement: every
 * request made and every answer received is recorded on window.__steakoutCamera
 * and drawn in the ?xray=1 overlay, so a phone recording settles it.
 *
 * The single most decisive line it reports is `caps`, from getCapabilities():
 * a track that says it can do 1920 while handing back 480x640 proves this is a
 * constraint problem and not a hardware limit. That ends the argument.
 *
 * For reference, the acquisition crop is sized from HALF the smaller dimension:
 *     cropSize = 2 ** Math.round(Math.log2(Math.min(w, h) / 2))
 * so 480x640 gives 256, and 1080p gives 512.
 */
(() => {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;

  const params = new URLSearchParams(location.search);
  const VARIANT = (params.get('ar') || 'A').toUpperCase();
  // C and D deliberately leave the request alone, so the browser's own default
  // is measurable as a control against a constrained run in the same session.
  const LEAVE_ALONE = VARIANT === 'C' || VARIANT === 'D';
  // The exact-constraint ladder tells a refusal apart from a silent downgrade,
  // but it costs extra getUserMedia calls. A customer never runs it.
  const DIAGNOSTIC = params.get('xray') === '1';

  /* What to ask for. The default is unchanged, because 1920x1080 is what the
   * current 60%-uptime build measured and nothing here should risk that
   * without a recording to justify it.
   *
   * The reason higher is interesting: MindAR sizes its detection window as
   *     cropSize = 2 ** round(log2(min(w, h) / 2))
   * so the window only grows when the SHORT edge crosses a power-of-two
   * boundary. 1080 gives 512. The next step up needs a short edge of ~1448,
   * which no 16:9 mode below 4K reaches -- but 4:3 modes do, and this phone
   * reports getCapabilities max 4032x3024. Bigger window AND more pixels on
   * the flyer, which is the only lever left now that a larger print is out.
   *
   * It costs frame rate: tracking runs on the full frame, not the crop. The
   * x-ray HUD reports windows/second so that cost is measurable rather than
   * argued. */
  const RES = {
    '1080': [1920, 1080],   // default, crop 512
    '1536': [2048, 1536],   // 4:3,     crop 1024
    '2160': [3840, 2160],   // 4K 16:9, crop 1024
    'max':  [4032, 3024]    // 4:3,     crop 2048
  };
  const askFor = RES[(params.get('res') || '1080').toLowerCase()] || RES['1080'];

  const predictCrop = (w, h) => Math.pow(2, Math.round(Math.log2(Math.min(w, h) / 2)));

  const native = md.getUserMedia.bind(md);

  // One object, one source of truth. The overlay reads this and infers nothing.
  const report = {
    rungs: [],       // every request made, and what came back
    granted: null,   // what mind-ar finally receives
    caps: null,      // what the track claims it is capable of
    applied: null,   // result of the applyConstraints attempt, if one was made
    wanted: null,    // what ?res= asked for
    cropIfHonoured: null, // the detection window that request would produce
    crop: null,      // the acquisition window that resolution implies
    constrained: !LEAVE_ALONE,
    summary: 'not started'
  };
  window.__steakoutCamera = report;

  // Long edge at which we consider the request honoured. Derived from what we
  // asked for rather than fixed, or a 4K request that returned 1080p would look
  // like a success and the exact ladder would never run.
  const hdEdge = () => Math.min(1200, Math.round(Math.max(askFor[0], askFor[1]) * 0.85));

  const trackOf = (s) => { try { return s.getVideoTracks()[0] || null; } catch (e) { return null; } };
  const sizeOf = (s) => {
    const t = trackOf(s);
    const g = t && t.getSettings && t.getSettings();
    return g && g.width ? { w: g.width, h: g.height } : null;
  };
  const area = (z) => (z ? z.w * z.h : 0);
  const isSmall = (s) => { const z = sizeOf(s); return !z || Math.max(z.w, z.h) < hdEdge(); };
  const release = (s) => { try { if (s) s.getTracks().forEach((t) => t.stop()); } catch (e) { /* best effort */ } };

  // Only a constraint refusal is worth retrying differently. A denied
  // permission or a missing camera will refuse every rung identically, and
  // retrying just costs the customer three failures instead of one.
  const retryable = (e) =>
    !!e && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError');

  const askOnce = async (tag, videoExtra, base) => {
    try {
      const s = await native({ ...base, video: { ...base.video, ...videoExtra } });
      const z = sizeOf(s);
      report.rungs.push(tag + '=' + (z ? z.w + 'x' + z.h : 'granted'));
      return s;
    } catch (e) {
      report.rungs.push(tag + '=' + ((e && e.name) || 'Error'));
      if (!retryable(e)) throw e;
      return null;
    }
  };

  const run = async (base) => {
    /* Rung 1 is the entire customer path: one call, one permission prompt.
     *
     * `ideal` is orientation-tolerant -- the browser picks the nearest mode it
     * has rather than refusing -- and per spec it can never raise
     * OverconstrainedError. So this rung either honours the hint or quietly
     * ignores it, and the recorded size says which. */
    const [AW, AH] = askFor;
    let best = await askOnce('ideal' + AH, { width: { ideal: AW }, height: { ideal: AH } }, base);

    /* A device that ignores `ideal` returns its default with no error at all,
     * which is indistinguishable from "this is genuinely the best I have".
     * `exact` REJECTS instead, which is a real answer. But `exact` also pins
     * the orientation, and a phone held in portrait can refuse 1920x1080 while
     * happily delivering 1080x1920 -- so a single exact request would read as a
     * hardware refusal when it is nothing of the kind. Try both ways round. */
    if (DIAGNOSTIC && isSmall(best)) {
      const rungs = [['exact' + AH + 'land', AW, AH], ['exact' + AH + 'port', AH, AW]];
      /* try/finally, not just the happy path: rung 1's stream is LIVE while
       * these run, and askOnce rethrows anything that is not a constraint
       * refusal. Asking for a second stream while one is open is exactly where
       * iOS raises NotReadableError, and without this the camera would stay on
       * with no reference left to stop it. */
      try {
        for (const [tag, w, h] of rungs) {
          const s = await askOnce(tag, { width: { exact: w }, height: { exact: h } }, base);
          if (!s) continue;
          if (area(sizeOf(s)) > area(sizeOf(best))) { release(best); best = s; }
          else release(s);
        }
      } catch (e) {
        release(best);
        throw e;
      }
    }

    // Nothing took. Hand back the plain request so AR still works.
    if (!best) { report.rungs.push('plain'); best = await native(base); }
    return best;
  };

  const finish = async (stream) => {
    const t = trackOf(stream);

    /* What does the hardware say it can do? This is the datum that ends the
     * argument. Older engines omit getCapabilities entirely -- report that
     * plainly rather than letting a missing value read as a low ceiling. */
    try {
      const c = t && t.getCapabilities && t.getCapabilities();
      if (!c) report.caps = 'unsupported';
      else if (c.width && c.width.max) report.caps = 'max ' + c.width.max + 'x' + (c.height && c.height.max);
      else report.caps = 'no size range';
    } catch (e) { report.caps = 'threw'; }

    /* Second, independent lever: raise the live track instead of re-requesting
     * it. Some engines ignore the getUserMedia hint but honour this.
     *
     * It must complete BEFORE this promise resolves. mind-ar assigns
     * video.srcObject in its own .then and reads videoWidth on loadedmetadata,
     * so a resize that lands after that point would leave the controller sized
     * to a frame the video no longer produces. */
    if (t && t.applyConstraints && !LEAVE_ALONE && isSmall(stream)) {
      try {
        await t.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } });
        const after = sizeOf(stream);
        report.applied = after ? after.w + 'x' + after.h : 'no reading';
      } catch (e) { report.applied = (e && e.name) || 'failed'; }
    }

    const z = sizeOf(stream);
    report.granted = z ? z.w + 'x' + z.h : 'unknown';
    const min = z ? Math.min(z.w, z.h) : 0;
    report.crop = min ? Math.pow(2, Math.round(Math.log2(min / 2))) : null;
    report.wanted = askFor[0] + 'x' + askFor[1];
    report.cropIfHonoured = predictCrop(askFor[0], askFor[1]);
    report.summary = report.rungs.join(' ') +
      (report.applied ? ' ac=' + report.applied : '') +
      ' caps=' + report.caps;
    return stream;
  };

  // A failure is a measurement too. Without this the report would still read
  // "not started" after a rung had already recorded why it failed.
  const failed = (e) => {
    report.granted = 'FAILED';
    report.summary = (report.rungs.join(' ') || 'no request made') +
                     ' -> ' + ((e && e.name) || 'Error');
    throw e;
  };

  const wrapped = function (constraints) {
    /* Reset per attempt.
     *
     * mind-ar issues a fresh getUserMedia on every system.start(), and the
     * retry button re-enters start(). Without this the rungs array accumulates
     * across attempts, and marker.js classifies its fault copy by regex over
     * the joined summary in a fixed order -- so a first attempt that was
     * DENIED and a second that failed because the camera was BUSY would still
     * be reported as "CAMERA ACCESS IS OFF", sending the customer into browser
     * settings to fix a permission they had already granted. */
    report.rungs = [];
    report.granted = null;
    report.caps = null;
    report.applied = null;
    report.crop = null;
    report.summary = 'in progress';

    const video = constraints && constraints.video;
    // mind-ar 1.2.5 asks for {audio:false, video:{facingMode:'environment'}} --
    // an object carrying no size. Verified in the shipped bundle, not assumed.
    const unsized = video && typeof video === 'object' &&
                    video.width === undefined && video.height === undefined;

    if (LEAVE_ALONE || !unsized) {
      report.rungs.push(LEAVE_ALONE ? 'untouched(control)' : 'untouched(already sized)');
      return native(constraints).then(finish, failed);
    }
    return run(constraints).then(finish, failed);
  };

  /* Installing the wrapper is not just an assignment.
   *
   * getUserMedia lives on MediaDevices.prototype and on some browsers is
   * non-writable, so a plain `md.getUserMedia = fn` fails SILENTLY in
   * non-strict code. Chrome accepted it and Safari ignored it, which is how an
   * override that looked installed under test never applied on the phone.
   *
   * A later attempt defined it on the instance only and returned on first
   * success, so the prototype was never touched -- and the device then reported
   * the wrapper was never called. Patch both, plus the legacy alias, and record
   * which routes took so the overlay shows it instead of us assuming. */
  const install = () => {
    const done = [];
    try {
      const proto = Object.getPrototypeOf(md);
      if (proto && proto.getUserMedia) {
        Object.defineProperty(proto, 'getUserMedia', { value: wrapped, writable: true, configurable: true });
        if (proto.getUserMedia === wrapped) done.push('proto');
      }
    } catch (e) { /* keep going */ }

    try {
      Object.defineProperty(md, 'getUserMedia', { value: wrapped, writable: true, configurable: true });
      if (md.getUserMedia === wrapped) done.push('inst');
    } catch (e) { /* keep going */ }

    try {
      if (navigator.getUserMedia && navigator.getUserMedia !== wrapped) {
        navigator.getUserMedia = function (c, ok, err) { wrapped(c).then(ok, err); };
        done.push('legacy');
      }
    } catch (e) { /* keep going */ }

    return done.length ? done.join('+') : 'FAILED';
  };

  window.__steakoutCameraPatch = install();
})();
