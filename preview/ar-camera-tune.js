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

  const native = md.getUserMedia.bind(md);

  // One object, one source of truth. The overlay reads this and infers nothing.
  const report = {
    rungs: [],       // every request made, and what came back
    granted: null,   // what mind-ar finally receives
    caps: null,      // what the track claims it is capable of
    applied: null,   // result of the applyConstraints attempt, if one was made
    crop: null,      // the acquisition window that resolution implies
    constrained: !LEAVE_ALONE,
    summary: 'not started'
  };
  window.__steakoutCamera = report;

  const HD_EDGE = 1200; // long edge above which we have a genuinely HD feed

  const trackOf = (s) => { try { return s.getVideoTracks()[0] || null; } catch (e) { return null; } };
  const sizeOf = (s) => {
    const t = trackOf(s);
    const g = t && t.getSettings && t.getSettings();
    return g && g.width ? { w: g.width, h: g.height } : null;
  };
  const area = (z) => (z ? z.w * z.h : 0);
  const isSmall = (s) => { const z = sizeOf(s); return !z || Math.max(z.w, z.h) < HD_EDGE; };
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
    let best = await askOnce('ideal1080', { width: { ideal: 1920 }, height: { ideal: 1080 } }, base);

    /* A device that ignores `ideal` returns its default with no error at all,
     * which is indistinguishable from "this is genuinely the best I have".
     * `exact` REJECTS instead, which is a real answer. But `exact` also pins
     * the orientation, and a phone held in portrait can refuse 1920x1080 while
     * happily delivering 1080x1920 -- so a single exact request would read as a
     * hardware refusal when it is nothing of the kind. Try both ways round. */
    if (DIAGNOSTIC && isSmall(best)) {
      const rungs = [['exact1080land', 1920, 1080], ['exact1080port', 1080, 1920]];
      for (const [tag, w, h] of rungs) {
        const s = await askOnce(tag, { width: { exact: w }, height: { exact: h } }, base);
        if (!s) continue;
        if (area(sizeOf(s)) > area(sizeOf(best))) { release(best); best = s; }
        else release(s);
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
