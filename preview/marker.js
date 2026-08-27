(() => {
  const config = window.STEAKOUT_AR_CONFIG || {};
  const markerConfig = config.marker || {};
  const queryParams = new URLSearchParams(window.location.search);
  const isEmbedded = queryParams.get('embedded') === '1';
  const requestedScaleMode = queryParams.get('xrscale');
  const configuredScaleMode = requestedScaleMode || markerConfig.scaleMode || 'responsive';
  const scaleMode = configuredScaleMode === 'absolute' ? 'absolute' : 'responsive';
  const stability = window.SteakoutAnchorStability;
  const scene = document.querySelector('#marker-scene');
  const anchor = document.querySelector('#marker-anchor');
  const food = document.querySelector('#marker-food');
  const shadow = document.querySelector('#marker-shadow');
  const startButton = document.querySelector('#marker-start');
  const intro = document.querySelector('#marker-intro');
  const guide = document.querySelector('#marker-scan-guide');
  const instruction = document.querySelector('#marker-instruction');
  const instructionTitle = document.querySelector('#marker-instruction-title');
  const instructionBody = document.querySelector('#marker-instruction-body');
  const progressSteps = [...document.querySelectorAll('.marker-progress__step')];
  const socialDock = document.querySelector('#marker-social');
  const instagramLink = document.querySelector('#marker-instagram');
  const facebookLink = document.querySelector('#marker-facebook');
  const orderLink = document.querySelector('#marker-order');
  const status = document.querySelector('#marker-status');
  const splash = document.querySelector('#ar-splash');
  const logoHome = document.querySelector('.marker-logo-home');
  const fault = document.querySelector('#marker-fault');
  const faultTitle = document.querySelector('#marker-fault-title');
  const faultBody = document.querySelector('#marker-fault-body');
  const faultRetry = document.querySelector('#marker-fault-retry');
  const faultBack = document.querySelector('#marker-fault-back');

  /* Recovering from a fault means reloading the WHOLE experience, not
     restarting the engine in place.

     iOS holds a motion/camera denial for the life of the page, so a retry
     inside the same document is answered with the same refusal instantly --
     which is what made this panel reappear the moment it was dismissed and
     left people locked out of AR with no way back in. A reload clears that
     state and lets the phone ask again.

     Embedded, the AR page is an iframe: reloading only the frame would leave
     the denied top-level document in place, and the permission has to be
     requested from a top-level tap. So reload the top document, which returns
     the customer to the landing page and the branded start popup. */
  const reloadExperience = () => {
    try {
      if (isEmbedded && window.top && window.top !== window) {
        window.top.location.reload();
        return;
      }
    } catch (error) {
      // A cross-origin top would throw; fall through and reload ourselves.
      console.warn('Could not reload the top document:', error);
    }
    window.location.reload();
  };

  if (!scene || !anchor || !food || !startButton) return;
  if (!stability) {
    const showDependencyFault = () => {
      console.error('AR pose-stability helper did not load.');
      if (faultTitle) faultTitle.textContent = 'AR COULDN\'T LOAD';
      if (faultBody) faultBody.textContent = 'Refresh the page and try again.';
      if (intro) intro.hidden = true;
      if (guide) guide.hidden = true;
      if (fault) fault.hidden = false;
      if (isEmbedded && window.parent !== window) {
        window.parent.postMessage({ type: 'steakout-ar-camera-error' }, window.location.origin);
      }
    };
    startButton.addEventListener('click', showDependencyFault);
    // This branch returns before the main handlers below are bound, which left
    // both buttons inert -- the panel was a dead end.
    faultRetry?.addEventListener('click', reloadExperience);
    faultBack?.addEventListener('click', () => {
      if (isEmbedded && window.parent !== window) {
        window.parent.postMessage({ type: 'steakout-ar-close' }, window.location.origin);
      } else {
        reloadExperience();
      }
    });
    if (isEmbedded) showDependencyFault();
    return;
  }

  const BOOT_TIMEOUT_MS = 20000;
  const TARGET_DWELL_MS = 900;
  const TRACKING_NORMAL_MS = 500;
  const LIFECYCLE_QUIET_MS = 750;
  const REJECT_QUIET_MS = 400;
  const TARGET_LOST_GRACE_MS = 1600;
  const LOCKED_COPY_HIDE_MS = 2200;
  const stabilityOptions = Object.freeze({
    ...stability.DEFAULTS,
    // Responsive coordinates are target-relative, not metres. In that mode,
    // all translation gates scale only with the observed flyer width.
    hardTranslationMetres: scaleMode === 'absolute' ? stability.DEFAULTS.hardTranslationMetres : 0,
    stableTranslationMetres: scaleMode === 'absolute' ? stability.DEFAULTS.stableTranslationMetres : 0
  });

  let startPromise;
  let stopPromise;
  let targetDataPromise;
  let isRunning = false;
  let sessionActive = false;
  let cameraLive = false;
  let targetVisible = false;
  let hasLocked = false;
  let progressAdvanceTimer;
  let lostGraceTimer;
  let lockedHideTimer;
  let cameraWatchdog;
  let faultShown = false;
  let lastEngineError;
  let sessionToken = 0;
  let hasStartedEngine = false;
  let trackingStatus = 'UNKNOWN';

  /* ------------------------------------------------------------------
   * GROUNDING: keep the meal on the flyer after commit.
   *
   * The anchor is committed once into SLAM WORLD space, not to the flyer. When
   * the world origin drifts -- dim light, a glossy table, thermal throttling,
   * fast motion -- the world moves and the meal goes with it while the flyer
   * stays put. Nothing corrected that, because the one signal which could was
   * observed after commit, written to the diagnostics log, and discarded.
   *
   * It is now used, but only under evidence. Continuously driving the anchor
   * from the tracker is what commit-once was avoiding: it jitters every frame
   * and the meal vanishes the moment a hand or a plate covers the flyer. And a
   * correction the diner can SEE is worse than the drift it fixes -- a meal
   * that pops or swims reads as broken, a meal 2cm off does not.
   *
   * So: prove the drift with the same clustering used for the original commit,
   * then remove it slower than the eye tracks.
   * ------------------------------------------------------------------ */

  // Deadband. Below this the drift is not worth touching, and correcting it
  // would mean moving the meal more often than the world actually drifts.
  // Sits just above stabilityOptions.stableTranslationMetres (0.015), which is
  // the spread a GOOD lock already shows -- correcting inside that would be
  // chasing measurement noise.
  const GROUND_DEADBAND_M = 0.022;
  const GROUND_DEADBAND_FLYER = 0.09;      // or 9% of flyer width, whichever is larger
  // Slower than the eye follows on a static object. 3cm of drift takes ~3s to
  // remove, spread over ~180 frames, so no single frame moves it perceptibly.
  const GROUND_MAX_M_PER_S = 0.010;
  const GROUND_MAX_DEG_PER_S = 2.0;
  // Stop before the deadband so it cannot oscillate around the threshold.
  const GROUND_SETTLE_M = 0.004;
  // Upper gate. Genuine SLAM drift over a sitting is centimetres. A discrepancy
  // this large is far more likely a mis-detection, a reflection, or a second
  // copy of the flyer than the world having moved 15cm -- and because the
  // correction is rate-capped, creeping toward a WRONG target would drag the
  // meal for 15+ seconds. That is the worst outcome available, so refuse it and
  // say so instead.
  const GROUND_MAX_ERROR_M = 0.15;

  let groundSamples = [];
  let groundTarget = null;          // { position: THREE.Vector3, quaternion: THREE.Quaternion }
  let groundRaf = null;
  let groundLastFrameAt = 0;
  let groundCorrections = 0;
  let trackingNormalSince = 0;
  let lastLifecycleChangeAt = performance.now();
  let candidate;
  let candidateEpoch = 0;
  let lockedSnapshot;
  let lastCommittedTargetLogAt = 0;
  const cameraWaiters = new Set();

  const recordDiagnostic = (type, detail = {}) => {
    window.STEAKOUT_AR_DIAGNOSTICS?.record(type, detail);
  };

  const setDiagnosticState = (state, detail = {}) => {
    window.STEAKOUT_AR_DIAGNOSTICS?.setAnchorState(state, detail);
  };

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  const setShadowStrength = (strength) => {
    if (!shadow || !window.AFRAME || !AFRAME.components['ar-contact-shadow']) return;
    shadow.setAttribute('ar-contact-shadow', 'strength', strength);
  };

  const setFoodOpacity = (opacity) => {
    setShadowStrength(opacity);
    const root = food.getObject3D('mesh');
    if (!root) return;
    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => {
        material.transparent = opacity < 1;
        material.opacity = opacity;
        material.depthWrite = opacity >= 1;
        material.needsUpdate = true;
      });
    });
  };

  const setPlacementGhost = () => {
    food.classList.remove('is-placement-solid');
    food.classList.add('is-placement-ghost');
    setFoodOpacity(0.34);
  };

  const setPlacementSolid = () => {
    food.classList.remove('is-placement-ghost');
    food.classList.add('is-placement-solid');
    setFoodOpacity(1);
  };

  const postToParent = (type) => {
    if (!isEmbedded || window.parent === window) return;
    window.parent.postMessage({ type }, window.location.origin);
  };

  const requestTopLevelMotionPermissions = () => {
    const requests = [];
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        requests.push(DeviceMotionEvent.requestPermission());
      }
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        requests.push(DeviceOrientationEvent.requestPermission());
      }
    } catch (error) {
      console.warn('Could not request motion permission:', error);
    }
    if (requests.length) Promise.allSettled(requests).catch(() => {});
  };

  const setProgressStep = (currentStep) => {
    if (instruction) instruction.dataset.currentStep = String(currentStep);
    progressSteps.forEach((progressStep) => {
      const stepNumber = Number(progressStep.dataset.step);
      const state = stepNumber === currentStep ? 'active' : stepNumber < currentStep ? 'complete' : 'upcoming';
      progressStep.dataset.state = state;
      progressStep.setAttribute('aria-current', state === 'active' ? 'step' : 'false');
    });
  };

  const instructionStates = {
    scanning: { step: 2, title: 'POINT BACK AT THE TABLE GRAPHIC', body: 'Put the flyer inside the box and move a little closer.', status: '', statusState: '' },
    holding: { step: 3, title: 'CENTRE THE GRAPHIC AND MOVE CLOSER', body: 'Hold steady while Steak Out locks your $12 lunch to this table.', status: '', statusState: '' },
    locked: { step: 4, title: 'YOUR $12 LUNCH IS RIGHT HERE', body: 'Move around it to see the portion before you order.', status: '', statusState: 'active' },
    lost: { step: 2, title: 'POINT BACK AT THE TABLE GRAPHIC', body: 'Bring the full graphic back into frame and reduce glare.', status: '', statusState: '' },
    error: { step: 2, title: 'ALLOW THE CAMERA TO CONTINUE', body: 'Allow camera access, then close and reopen Steak Out AR.', status: 'CAMERA ERROR', statusState: 'error' }
  };

  const renderInstruction = (state) => {
    if (!instruction) return;
    const next = instructionStates[state] || instructionStates.scanning;
    instruction.dataset.state = state;
    instruction.hidden = false;
    if (instructionTitle) instructionTitle.textContent = next.title;
    if (instructionBody) instructionBody.textContent = next.body;
    setProgressStep(next.step);
    setStatus(next.status, next.statusState);
  };

  food.setAttribute('src', config.modelUrl || '');
  food.setAttribute('position', markerConfig.modelPosition || '0 0 0');
  food.setAttribute('rotation', markerConfig.modelRotation || '90 0 0');
  const modelScale = Number(markerConfig.modelScale || 9);
  food.setAttribute('scale', `${modelScale} ${modelScale} ${modelScale}`);
  food.addEventListener('model-loaded', () => {
    // Compile the opaque variant NOW, behind the splash. Flipping
    // material.transparent at commit otherwise triggers a GLSL link on the
    // render thread at the worst possible moment.
    try {
      setFoodOpacity(1);
      const sc = food.sceneEl;
      if (sc && sc.renderer && sc.object3D && sc.camera) {
        sc.renderer.compile(sc.object3D, sc.camera);
      }
    } catch (e) { /* warming is an optimisation; never block the model */ }
    return hasLocked ? setPlacementSolid() : setPlacementGhost();
  });

  if (orderLink && config.orderUrl) orderLink.href = config.orderUrl;
  if (instagramLink && config.social?.instagramUrl) instagramLink.href = config.social.instagramUrl;
  if (facebookLink && config.social?.facebookUrl) facebookLink.href = config.social.facebookUrl;

  const clearProgressAdvance = () => {
    window.clearTimeout(progressAdvanceTimer);
    progressAdvanceTimer = undefined;
  };

  const clearLostGrace = () => {
    window.clearTimeout(lostGraceTimer);
    lostGraceTimer = undefined;
  };

  const clearLockedHide = () => {
    window.clearTimeout(lockedHideTimer);
    lockedHideTimer = undefined;
  };

  const clearCameraWatchdog = () => {
    window.clearTimeout(cameraWatchdog);
    cameraWatchdog = undefined;
  };

  const resolveCameraWaiters = (value) => {
    cameraWaiters.forEach((resolve) => resolve(value));
    cameraWaiters.clear();
  };

  const waitForCamera = () => new Promise((resolve) => {
    if (cameraLive) return resolve(true);
    cameraWaiters.add(resolve);
  });

  const showSplash = () => {
    if (!splash) return;
    splash.hidden = false;
    splash.classList.remove('is-live', 'is-revealing');
    void splash.offsetWidth;
    splash.classList.add('is-live');
  };

  const revealCamera = async () => {
    if (!splash) return;
    splash.classList.add('is-revealing');
    await new Promise((resolve) => setTimeout(resolve, 620));
    splash.hidden = true;
    splash.classList.remove('is-live', 'is-revealing');
  };

  const errorSummary = () => {
    const error = lastEngineError || {};
    return [error.name, error.message, error.type].filter(Boolean).join(' ');
  };

  const faultCopy = () => {
    const summary = errorSummary();
    if (/NotAllowedError|SecurityError|PermissionDenied/i.test(summary)) {
      return {
        title: 'CAMERA ACCESS IS OFF',
        body: 'Tap Allow when your phone asks. If you already said no, turn the camera on for this site in your browser settings.'
      };
    }
    if (/NotReadableError|AbortError|TrackStartError|busy/i.test(summary)) {
      return {
        title: 'THE CAMERA IS BUSY',
        body: 'Another app may be using it. Close your other camera apps, then try again.'
      };
    }
    if (/NotFoundError|OverconstrainedError|DevicesNotFound|unsupported/i.test(summary)) {
      return {
        title: 'NO CAMERA AVAILABLE',
        body: 'This device did not offer a camera we can use. Try opening this page in Safari or Chrome directly.'
      };
    }
    return {
      title: 'AR COULDN\'T LOAD',
      body: 'Tap Try Again to start over, and choose Allow when your phone asks for camera and motion access.'
    };
  };

  const showFault = () => {
    if (!fault || faultShown) return;
    faultShown = true;
    sessionActive = false;
    resolveCameraWaiters(false);
    clearCameraWatchdog();
    clearProgressAdvance();
    const copy = faultCopy();
    if (faultTitle) faultTitle.textContent = copy.title;
    if (faultBody) faultBody.textContent = copy.body;
    // showMotionBlockedFault rewrites this label; put it back for normal faults.
    if (faultRetry) faultRetry.textContent = 'TRY AGAIN';
    if (splash) splash.hidden = true;
    guide.hidden = true;
    if (instruction) instruction.hidden = true;
    if (socialDock) socialDock.hidden = true;
    if (orderLink) orderLink.hidden = true;
    intro.hidden = true;
    fault.hidden = false;
    postToParent('steakout-ar-camera-error');
  };

  /* Distinct from every other fault here: there is nothing to retry. Safari has
     already recorded the refusal for this origin and will not prompt again, so
     the honest thing is to name the one action that does work. */
  const showMotionBlockedFault = () => {
    if (!fault) return;
    faultShown = true;
    sessionActive = false;
    resolveCameraWaiters(false);
    clearCameraWatchdog();
    clearProgressAdvance();
    if (faultTitle) faultTitle.textContent = 'MOTION ACCESS IS OFF';
    if (faultBody) {
      faultBody.textContent = 'Safari saved your \u2018Don\u2019t Allow\u2019 for this ' +
        'site and will not ask again. Fully quit Safari from the app switcher, ' +
        'then reopen this page.';
    }
    if (faultRetry) faultRetry.textContent = 'I\u2019VE REOPENED SAFARI';
    if (splash) splash.hidden = true;
    if (guide) guide.hidden = true;
    if (instruction) instruction.hidden = true;
    if (socialDock) socialDock.hidden = true;
    if (orderLink) orderLink.hidden = true;
    if (intro) intro.hidden = true;
    fault.hidden = false;
  };

  const hideFault = () => {
    faultShown = false;
    if (fault) fault.hidden = true;
  };

  const waitFor = (test, message) => new Promise((resolve, reject) => {
    if (test()) return resolve();
    const started = Date.now();
    const probe = window.setInterval(() => {
      if (test()) {
        window.clearInterval(probe);
        resolve();
      } else if (Date.now() - started >= BOOT_TIMEOUT_MS) {
        window.clearInterval(probe);
        reject(new Error(message));
      }
    }, 40);
  });

  const waitForEvent = (target, name, timeoutMessage) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      target.removeEventListener(name, done);
      reject(new Error(timeoutMessage));
    }, BOOT_TIMEOUT_MS);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    target.addEventListener(name, done, { once: true });
  });

  const getEngine = async () => {
    if (!scene.hasLoaded) await waitForEvent(scene, 'loaded', 'A-Frame did not boot within 20000ms');
    if (!window.XR8?.XrController) {
      await waitForEvent(window, 'xrloaded', 'The AR engine did not boot within 20000ms');
    }
    await waitFor(() => !!(scene.components.xrweb && scene.components.xrconfig), 'The AR scene did not initialize within 20000ms');
    return window.XR8;
  };

  const getTargetData = () => {
    if (targetDataPromise) return targetDataPromise;
    targetDataPromise = (async () => {
      const source = markerConfig.targetDataUrl;
      if (!source) throw new Error('Missing image target data URL.');
      const url = new URL(source, window.location.href).href;
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Image target ${response.status}`);
      const target = await response.json();
      target.imagePath = new URL(target.imagePath, url).href;
      return target;
    })().catch((error) => {
      targetDataPromise = undefined;
      throw error;
    });
    return targetDataPromise;
  };

  /* 8th Wall reports the target's local image width separately from its world
     scale. The validated sample has already combined those values into width,
     keeping the existing food scale relative to one flyer width. */
  const applyPoseSample = (sample) => {
    if (!sample) return false;
    const object = anchor.object3D;
    object.position.set(sample.position.x, sample.position.y, sample.position.z);
    object.quaternion.set(sample.rotation.x, sample.rotation.y, sample.rotation.z, sample.rotation.w);
    object.scale.setScalar(sample.width);
    object.visible = true;
    object.updateMatrix();
    object.updateMatrixWorld(true);
    return true;
  };

  const isOurTarget = (event) => !markerConfig.targetName || event.detail?.name === markerConfig.targetName;

  const poseForLog = (sample) => sample ? {
    time: sample.time,
    position: sample.position,
    rotation: sample.rotation,
    scale: sample.scale,
    scaledWidth: sample.scaledWidth,
    scaledHeight: sample.scaledHeight,
    width: sample.width,
    height: sample.height
  } : null;

  const transformSnapshot = () => {
    const object = anchor.object3D;
    object.updateMatrixWorld(true);
    return {
      position: object.position.toArray(),
      quaternion: object.quaternion.toArray(),
      scale: object.scale.toArray(),
      matrix: object.matrix.toArray(),
      matrixWorld: object.matrixWorld.toArray()
    };
  };

  const resetCandidate = (reason, options = {}) => {
    const { hideAnchor = true, emitLost = true, instructionState } = options;
    clearProgressAdvance();
    const previousCandidate = candidate;
    if (previousCandidate) {
      recordDiagnostic('candidate-reset', {
        reason,
        epoch: previousCandidate.epoch,
        sampleCount: previousCandidate.samples.length
      });
    }
    candidate = undefined;
    if (!hasLocked && hideAnchor) anchor.object3D.visible = false;
    if (!hasLocked && previousCandidate && emitLost) anchor.emit('targetLost');
    if (!hasLocked && previousCandidate && instructionState && sessionActive) {
      setPlacementGhost();
      renderInstruction(instructionState);
    }
    setDiagnosticState(trackingStatus === 'NORMAL' ? 'scanning' : 'limited', { reason });
  };

  const beginCandidate = (now, source) => {
    clearProgressAdvance();
    clearLostGrace();
    candidate = {
      epoch: ++candidateEpoch,
      startedAt: now,
      lastRejectedAt: -Infinity,
      samples: [],
      lastRawSample: undefined,
      pendingOutlier: undefined
    };

    anchor.emit('targetFound');
    setPlacementGhost();
    renderInstruction('holding');
    setDiagnosticState('candidate', { epoch: candidate.epoch, source });
    recordDiagnostic('candidate-start', { epoch: candidate.epoch, source, scaleMode });
  };

  /* Collect post-commit observations of the flyer and, only when they agree
   * with each other AND disagree with where the meal currently sits, aim a slow
   * correction at them. */
  const considerGroundCorrection = (sample, now) => {
    if (!sample || !hasLocked) return;
    // Never correct on a degraded pose. LIMITED tracking is exactly when the
    // engine's own estimate is least trustworthy, so a "drift" measured then is
    // as likely to be the measurement moving as the meal.
    if (trackingStatus !== 'NORMAL') { groundSamples.length = 0; return; }

    const previous = groundSamples[groundSamples.length - 1];
    if (!stability.shouldRetainSample(sample, previous, stabilityOptions)) return;

    groundSamples.push(sample);
    groundSamples = groundSamples
      .filter((entry) => now - entry.time <= stabilityOptions.maxWindowMs)
      .slice(-stabilityOptions.maxSamples);

    // Same bar the original commit had to clear: a real cluster, not one frame.
    const evaluation = stability.evaluateCluster(groundSamples, stabilityOptions);
    if (!evaluation.stable || !evaluation.medoid) return;

    const medoid = evaluation.medoid;
    const object = anchor.object3D;
    const dx = medoid.position.x - object.position.x;
    const dy = medoid.position.y - object.position.y;
    const dz = medoid.position.z - object.position.z;
    const error = Math.hypot(dx, dy, dz);
    const deadband = Math.max(GROUND_DEADBAND_M, GROUND_DEADBAND_FLYER * medoid.width);
    if (error <= deadband) return;

    if (error > GROUND_MAX_ERROR_M) {
      // Do not chase it. Surface it -- this is the signal that the lock itself
      // is wrong, which is a different problem from drift.
      recordDiagnostic('ground-correction-refused', {
        error: Number(error.toFixed(4)), limit: GROUND_MAX_ERROR_M,
        reason: 'too large to be drift; likely a mis-detection'
      });
      groundSamples.length = 0;
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;
    groundTarget = {
      position: new THREE.Vector3(medoid.position.x, medoid.position.y, medoid.position.z),
      quaternion: new THREE.Quaternion(medoid.rotation.x, medoid.rotation.y,
                                       medoid.rotation.z, medoid.rotation.w)
    };
    groundCorrections += 1;
    recordDiagnostic('ground-correction-started', {
      error: Number(error.toFixed(4)), deadband: Number(deadband.toFixed(4)),
      samples: evaluation.sampleCount, spanMs: Math.round(evaluation.spanMs || 0),
      corrections: groundCorrections
    });
    startGroundLoop();
  };

  const stopGroundLoop = () => {
    if (groundRaf !== null) { window.cancelAnimationFrame(groundRaf); groundRaf = null; }
    groundLastFrameAt = 0;
  };

  const startGroundLoop = () => {
    if (groundRaf !== null) return;
    groundLastFrameAt = performance.now();
    const step = () => {
      groundRaf = null;
      if (!groundTarget || !hasLocked) { stopGroundLoop(); return; }

      const nowMs = performance.now();
      const dt = Math.min(0.05, Math.max(0, (nowMs - groundLastFrameAt) / 1000));
      groundLastFrameAt = nowMs;

      const object = anchor.object3D;
      const remaining = object.position.distanceTo(groundTarget.position);
      if (remaining <= GROUND_SETTLE_M) {
        recordDiagnostic('ground-correction-settled', {
          residual: Number(remaining.toFixed(4)), corrections: groundCorrections
        });
        groundTarget = null;
        stopGroundLoop();
        return;
      }

      // Rate-capped, never proportional: a proportional move is fastest exactly
      // when the error is largest, which is when a jump is most visible.
      const maxStep = GROUND_MAX_M_PER_S * dt;
      object.position.lerp(groundTarget.position, Math.min(1, maxStep / remaining));

      const maxRad = (GROUND_MAX_DEG_PER_S * Math.PI / 180) * dt;
      const angle = object.quaternion.angleTo(groundTarget.quaternion);
      if (angle > 1e-4) {
        object.quaternion.rotateTowards(groundTarget.quaternion, Math.min(maxRad, angle));
      }

      // Scale is deliberately NOT corrected. A scale error means a distance
      // estimate moved, and resizing food in front of someone judging a PORTION
      // is the one change they are guaranteed to notice.
      object.updateMatrix();
      object.updateMatrixWorld(true);

      groundRaf = window.requestAnimationFrame(step);
    };
    groundRaf = window.requestAnimationFrame(step);
  };

  // Let the diagnostics HUD read the grounding state; without this a silent
  // correction is indistinguishable from no correction at all.
  window.STEAKOUT_GROUND_STATE = () => ({
    corrections: groundCorrections,
    correcting: !!groundTarget,
    samples: groundSamples.length
  });

  const commitCandidate = (sample, evaluation, now) => {
    if (!candidate || hasLocked || !sample) return;
    const committedEpoch = candidate.epoch;
    clearProgressAdvance();

    // Set the guard first so no subsequent image event can write the anchor.
    hasLocked = true;
    applyPoseSample(sample);
    lockedSnapshot = transformSnapshot();
    candidate = undefined;
    setPlacementSolid();
    renderInstruction('locked');
    setDiagnosticState('committed', { epoch: committedEpoch });
    recordDiagnostic('anchor-committed', {
      epoch: committedEpoch,
      at: now,
      scaleMode,
      trackingStatus,
      sample: poseForLog(sample),
      evaluation: {
        sampleCount: evaluation.sampleCount,
        spanMs: evaluation.spanMs,
        maxima: evaluation.maxima,
        limits: evaluation.limits
      },
      anchor: lockedSnapshot
    });

    // XR8 SLAM now moves only the camera around this immutable world anchor.
    clearLockedHide();
    lockedHideTimer = window.setTimeout(() => {
      if (sessionActive && hasLocked && instruction) instruction.hidden = true;
    }, LOCKED_COPY_HIDE_MS);
  };

  const scheduleCandidateEvaluation = (now) => {
    clearProgressAdvance();
    if (!candidate || hasLocked || !targetVisible || trackingStatus !== 'NORMAL') return;
    const nextEvaluationAt = Math.max(
      candidate.startedAt + TARGET_DWELL_MS,
      trackingNormalSince + TRACKING_NORMAL_MS,
      lastLifecycleChangeAt + LIFECYCLE_QUIET_MS,
      candidate.lastRejectedAt + REJECT_QUIET_MS
    );
    const delay = Math.max(0, Math.ceil(nextEvaluationAt - now));
    progressAdvanceTimer = window.setTimeout(() => {
      progressAdvanceTimer = undefined;
      if (!candidate || hasLocked || !targetVisible) return;
      const evaluation = stability.evaluateCluster(candidate.samples, stabilityOptions);
      maybeCommitCandidate(performance.now(), evaluation);
    }, delay);
  };

  function maybeCommitCandidate(now, evaluation) {
    if (!candidate || hasLocked || !targetVisible || !evaluation.stable) return;
    const gates = {
      dwell: now - candidate.startedAt >= TARGET_DWELL_MS,
      tracking: trackingStatus === 'NORMAL' && now - trackingNormalSince >= TRACKING_NORMAL_MS,
      lifecycle: now - lastLifecycleChangeAt >= LIFECYCLE_QUIET_MS,
      rejection: now - candidate.lastRejectedAt >= REJECT_QUIET_MS
    };
    recordDiagnostic('candidate-evaluated', {
      epoch: candidate.epoch,
      sampleCount: evaluation.sampleCount,
      spanMs: evaluation.spanMs,
      stable: evaluation.stable,
      gates,
      maxima: evaluation.maxima
    });
    if (Object.values(gates).every(Boolean)) commitCandidate(evaluation.medoid, evaluation, now);
    else scheduleCandidateEvaluation(now);
  }

  const acceptTargetSample = (detail, source) => {
    const now = performance.now();
    const sample = stability.createPoseSample(detail, now);
    targetVisible = true;

    if (hasLocked) {
      if (source === 'found' || now - lastCommittedTargetLogAt >= 250) {
        lastCommittedTargetLogAt = now;
        recordDiagnostic('target-after-commit', { source, sample: poseForLog(sample) });
      }
      considerGroundCorrection(sample, now);
      return;
    }
    if (!sample) {
      recordDiagnostic('candidate-rejected', { source, reason: 'invalid-pose' });
      return;
    }

    if (!candidate) beginCandidate(now, source);
    let previous = candidate.samples[candidate.samples.length - 1];

    // Never mix a new pose burst with evidence older than the candidate window.
    if (previous && now - previous.time > stabilityOptions.maxWindowMs) {
      recordDiagnostic('candidate-restarted', { reason: 'sample-gap', previousEpoch: candidate.epoch });
      resetCandidate('sample-gap', { hideAnchor: false, emitLost: false });
      beginCandidate(now, 'sample-gap');
      previous = undefined;
    }

    const previousRaw = candidate.lastRawSample;
    candidate.lastRawSample = sample;

    if (candidate.pendingOutlier && previous) {
      const activeComparison = stability.comparePoses(sample, previous, stabilityOptions);
      if (!activeComparison.hard) {
        // A lone bad frame returned to the existing cluster; quarantine ends.
        recordDiagnostic('candidate-outlier-cleared', { epoch: candidate.epoch, reason: 'returned-to-cluster' });
        candidate.pendingOutlier = undefined;
      } else {
        const pending = candidate.pendingOutlier;
        const pendingPrevious = pending.samples[pending.samples.length - 1];
        const pendingComparison = stability.comparePoses(sample, pendingPrevious, stabilityOptions);
        if (pendingComparison.hard) {
          pending.startedAt = now;
          pending.samples = [sample];
        } else if (stability.shouldRetainSample(sample, pendingPrevious, stabilityOptions)) {
          pending.samples.push(sample);
        }

        if (pending.samples.length >= 3) {
          const confirmationOptions = {
            ...stabilityOptions,
            minSamples: 3,
            minWindowMs: 100,
            maxSamples: 3
          };
          const confirmation = stability.evaluateCluster(pending.samples.slice(-3), confirmationOptions);
          if (confirmation.stable) {
            candidate.startedAt = pending.startedAt;
            candidate.samples = pending.samples.slice(-3);
            candidate.pendingOutlier = undefined;
            candidate.lastRejectedAt = now;
            recordDiagnostic('candidate-restarted', {
              reason: 'confirmed-new-cluster',
              epoch: candidate.epoch,
              sample: poseForLog(confirmation.medoid)
            });
          }
        }
        return;
      }
    }

    if (previousRaw) {
      const comparison = stability.comparePoses(sample, previousRaw, stabilityOptions);
      if (comparison.hard) {
        candidate.lastRejectedAt = now;
        candidate.pendingOutlier = { startedAt: now, samples: [sample] };
        clearProgressAdvance();
        recordDiagnostic('candidate-rejected', {
          epoch: candidate.epoch,
          source,
          reason: comparison.reasons.join(','),
          comparison,
          sample: poseForLog(sample)
        });
        setDiagnosticState('candidate-warning', { reason: comparison.reasons.join(',') });
        return;
      }
    }

    // Decimate high-rate target events to 20 Hz. This lets the 12-sample ring
    // span more than 250 ms even when the engine reports at 60/120 Hz, while
    // the hard-jump check above still examines every raw event.
    if (!stability.shouldRetainSample(sample, previous, stabilityOptions)) return;

    candidate.samples.push(sample);
    candidate.samples = candidate.samples
      .filter((entry) => now - entry.time <= stabilityOptions.maxWindowMs)
      .slice(-stabilityOptions.maxSamples);
    const evaluation = stability.evaluateCluster(candidate.samples, stabilityOptions);
    const displayPose = evaluation.medoid || sample;
    applyPoseSample(displayPose);
    setDiagnosticState(evaluation.stable ? 'stabilizing' : 'candidate', {
      epoch: candidate.epoch,
      sampleCount: candidate.samples.length,
      reason: evaluation.reason
    });
    maybeCommitCandidate(now, evaluation);
  };

  const onImageFound = (event) => {
    if (!sessionActive || !isOurTarget(event)) return;
    acceptTargetSample(event.detail, 'found');
  };

  const onImageUpdated = (event) => {
    if (!sessionActive || !isOurTarget(event)) return;
    acceptTargetSample(event.detail, 'updated');
  };

  const onImageLost = (event) => {
    if (!sessionActive || !isOurTarget(event)) return;
    targetVisible = false;
    recordDiagnostic('target-lost', { committed: hasLocked, epoch: candidate?.epoch });
    if (hasLocked) return;
    anchor.emit('targetLost');
    resetCandidate('target-lost', { emitLost: false });
    clearLostGrace();
    lostGraceTimer = window.setTimeout(() => {
      if (!sessionActive || targetVisible || hasLocked) return;
      setPlacementGhost();
      renderInstruction('lost');
    }, TARGET_LOST_GRACE_MS);
  };

  const normalizeTrackingStatus = (detail = {}) => String(
    detail.status || detail.state || detail.trackingStatus || 'UNKNOWN'
  ).toUpperCase();

  const onTrackingStatus = (event) => {
    const now = performance.now();
    const nextStatus = normalizeTrackingStatus(event.detail);
    const changed = nextStatus !== trackingStatus;
    trackingStatus = nextStatus;
    if (trackingStatus === 'NORMAL') {
      if (changed || !trackingNormalSince) trackingNormalSince = now;
      setDiagnosticState(hasLocked ? 'committed' : candidate ? 'candidate' : 'scanning');
      if (candidate) {
        const evaluation = stability.evaluateCluster(candidate.samples, stabilityOptions);
        maybeCommitCandidate(now, evaluation);
      }
    } else {
      trackingNormalSince = 0;
      if (!hasLocked) {
        resetCandidate(`tracking-${trackingStatus.toLowerCase()}`, { instructionState: 'scanning' });
      }
      setDiagnosticState('limited', { status: trackingStatus });
    }
    recordDiagnostic('tracking-status', { status: trackingStatus, changed });
  };

  const invalidatePreLockEvidence = (reason) => {
    lastLifecycleChangeAt = performance.now();
    if (!hasLocked) resetCandidate(reason, { instructionState: 'scanning' });
    recordDiagnostic('lifecycle-epoch', { reason, committed: hasLocked });
  };

  scene.addEventListener('xrimagefound', onImageFound);
  scene.addEventListener('xrimageupdated', onImageUpdated);
  scene.addEventListener('xrimagelost', onImageLost);
  scene.addEventListener('xrtrackingstatus', onTrackingStatus);
  scene.addEventListener('realityerror', (event) => {
    lastEngineError = event.detail?.error || event.detail || new Error('AR engine failed');
    recordDiagnostic('reality-error', {
      name: lastEngineError?.name,
      message: lastEngineError?.message
    });
    setDiagnosticState('fault');
    if (startPromise || isRunning) showFault();
  });
  scene.addEventListener('camerastatuschange', (event) => {
    const detail = event.detail || {};
    recordDiagnostic('camera-status', { status: detail.status || 'unknown' });
    if (detail.status === 'hasVideo') {
      invalidatePreLockEvidence('camera-has-video');
      if (startPromise && !faultShown) {
        cameraLive = true;
        resolveCameraWaiters(true);
      }
    } else if (detail.status === 'failed' && (startPromise || isRunning)) {
      lastEngineError = detail.error || new Error('Camera failed to start');
      setDiagnosticState('fault');
      showFault();
    }
  });

  document.addEventListener('visibilitychange', () => {
    invalidatePreLockEvidence(`visibility-${document.visibilityState}`);
  });
  window.addEventListener('blur', () => invalidatePreLockEvidence('window-blur'));
  window.addEventListener('pageshow', () => invalidatePreLockEvidence('page-show'));
  window.addEventListener('orientationchange', () => invalidatePreLockEvidence('orientation-change'));

  const armCameraWatchdog = () => {
    clearCameraWatchdog();
    cameraWatchdog = window.setTimeout(() => {
      if (!cameraLive) {
        lastEngineError = new Error('Camera did not provide video in time');
        showFault();
      }
    }, BOOT_TIMEOUT_MS);
  };

  const resetVisibleUi = () => {
    if (splash) splash.hidden = true;
    guide.hidden = true;
    if (instruction) instruction.hidden = true;
    if (socialDock) socialDock.hidden = true;
    if (orderLink) orderLink.hidden = true;
    setStatus('');
  };

  const start = () => {
    if (stopPromise) return stopPromise.then(start);
    if (isRunning) return Promise.resolve();
    if (startPromise) return startPromise;

    const runToken = ++sessionToken;
    const operation = (async () => {
      try {
        clearProgressAdvance();
        clearLostGrace();
        clearLockedHide();
        // A correction loop must never outlive the lock it was correcting: the
        // anchor is about to be re-acquired, and a surviving rAF would keep
        // dragging it toward a target measured against the OLD lock.
        stopGroundLoop();
        groundTarget = null;
        groundSamples.length = 0;
        groundCorrections = 0;
        hasLocked = false;
        targetVisible = false;
        candidate = undefined;
        lockedSnapshot = undefined;
        if (!hasStartedEngine) trackingStatus = 'UNKNOWN';
        trackingNormalSince = trackingStatus === 'NORMAL' ? performance.now() : 0;
        lastLifecycleChangeAt = performance.now();
        lastCommittedTargetLogAt = 0;
        sessionActive = false;
        cameraLive = false;
        lastEngineError = undefined;
        hideFault();
        anchor.object3D.visible = false;
        setPlacementGhost();
        intro.hidden = true;
        guide.hidden = true;
        if (instruction) instruction.hidden = true;
        if (socialDock) socialDock.hidden = true;
        if (orderLink) orderLink.hidden = true;
        showSplash();
        window.dispatchEvent(new Event('resize'));

        const minSplashTime = new Promise((resolve) => setTimeout(resolve, 1250));
        const [engine, target] = await Promise.all([getEngine(), getTargetData()]);
        if (runToken !== sessionToken) return;

        // Configure before run. World tracking remains enabled and the engine
        // owns the camera constraints, avoiding a post-open zoom that would
        // invalidate its calibrated SLAM projection.
        armCameraWatchdog();
        const cameraReady = waitForCamera();
        const wasResume = hasStartedEngine && engine.isPaused?.();
        if (wasResume) {
          sessionActive = true;
          await engine.resume();
        } else {
          engine.XrController.configure({
            imageTargetData: [target],
            scale: scaleMode,
            disableWorldTracking: false,
            enableLighting: false
          });
          hasStartedEngine = true;
          sessionActive = true;
          scene.emit('runreality');
        }
        recordDiagnostic('session-start', { scaleMode, resumed: Boolean(wasResume) });
        setDiagnosticState('camera');
        await minSplashTime;
        const live = await cameraReady;
        if (runToken !== sessionToken || !live || faultShown) return;

        isRunning = true;
        clearCameraWatchdog();
        if (!targetVisible && !hasLocked) renderInstruction('scanning');
        if (socialDock) socialDock.hidden = false;
        if (orderLink) orderLink.hidden = false;
        guide.hidden = false;
        await revealCamera();
        if (runToken === sessionToken && isRunning) postToParent('steakout-ar-camera-live');
      } catch (error) {
        if (runToken !== sessionToken) return;
        console.error(error);
        isRunning = false;
        sessionActive = false;
        targetVisible = false;
        lastEngineError = error;
        intro.hidden = isEmbedded;
        showFault();
      } finally {
        if (startPromise === operation) startPromise = null;
      }
    })();
    startPromise = operation;
    return operation;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    ++sessionToken;
    startPromise = null;
    stopPromise = (async () => {
      targetVisible = false;
      isRunning = false;
      sessionActive = false;
      cameraLive = false;
      candidate = undefined;
      resolveCameraWaiters(false);
      clearCameraWatchdog();
      clearProgressAdvance();
      clearLostGrace();
      clearLockedHide();
      try {
        if (hasStartedEngine && window.XR8?.pause) await window.XR8.pause();
      } catch (error) {
        console.warn('Unable to stop AR cleanly:', error);
      }
      anchor.object3D.visible = false;
      setPlacementGhost();
      resetVisibleUi();
      intro.hidden = isEmbedded;
      setDiagnosticState('idle');
      recordDiagnostic('session-stop');
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  };

  startButton.addEventListener('click', () => {
    if (!isEmbedded) requestTopLevelMotionPermissions();
    start();
  });

  faultRetry?.addEventListener('click', reloadExperience);
  faultBack?.addEventListener('click', () => {
    hideFault();
    if (isEmbedded) postToParent('steakout-ar-close');
    else { stop(); intro.hidden = false; }
  });

  if (isEmbedded) {
    intro.hidden = true;
    logoHome?.setAttribute('aria-label', 'Close Steak Out AR');
    logoHome?.addEventListener('click', (event) => { event.preventDefault(); postToParent('steakout-ar-close'); });
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      if (event.data?.type === 'steakout-ar-start') start();
      else if (event.data?.type === 'steakout-ar-stop') stop();
      else if (event.data?.type === 'steakout-ar-motion-blocked') showMotionBlockedFault();
    });
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') postToParent('steakout-ar-close'); });

    // Parent app.js gates start on this message. It must precede the engine
    // warm-up so a slow engine still receives the user's start request.
    postToParent('steakout-ar-ready');
    getEngine().catch(() => { /* start() surfaces this through the fault panel */ });
  }

  // A normal close keeps the warm iframe resumable. Once the browser is
  // actually discarding this document, release the engine and camera fully.
  window.addEventListener('pagehide', () => {
    try { window.XR8?.stop?.(); } catch (error) { /* best effort final cleanup */ }
    hasStartedEngine = false;
  });
})();
