(() => {
  const config = window.STEAKOUT_AR_CONFIG || {};
  const markerConfig = config.marker || {};
  const isEmbedded = new URLSearchParams(window.location.search).get('embedded') === '1';
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

  if (!scene || !anchor || !food || !startButton) return;

  const BOOT_TIMEOUT_MS = 20000;
  const TARGET_LOCK_MS = 900;
  const TARGET_LOST_GRACE_MS = 1600;
  const LOCKED_COPY_HIDE_MS = 2200;

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
  const cameraWaiters = new Set();

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
  food.addEventListener('model-loaded', () => hasLocked ? setPlacementSolid() : setPlacementGhost());

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
      body: 'Check your connection and try again. If you opened this from another app, try opening it in your browser instead.'
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
    if (splash) splash.hidden = true;
    guide.hidden = true;
    if (instruction) instruction.hidden = true;
    if (socialDock) socialDock.hidden = true;
    if (orderLink) orderLink.hidden = true;
    intro.hidden = true;
    fault.hidden = false;
    postToParent('steakout-ar-camera-error');
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
     scale. Multiplying them converts this anchor back to one local flyer unit,
     so the existing food scale remains a 3.2x-flyer plate rather than growing
     by the target's 3:4 geometry ratio. */
  const applyTargetPose = (detail) => {
    const scale = Number(detail.scale);
    const width = Number(detail.scaledWidth);
    const anchorScale = scale * width;
    if (!detail.position || !detail.rotation || !Number.isFinite(anchorScale) || anchorScale <= 0) return false;
    const object = anchor.object3D;
    object.position.set(detail.position.x, detail.position.y, detail.position.z);
    object.quaternion.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w);
    object.scale.setScalar(anchorScale);
    object.visible = true;
    object.updateMatrix();
    object.updateMatrixWorld(true);
    return true;
  };

  const isOurTarget = (event) => !markerConfig.targetName || event.detail?.name === markerConfig.targetName;

  const beginTargetLock = () => {
    targetVisible = true;
    clearProgressAdvance();
    clearLostGrace();
    if (hasLocked) return;

    anchor.emit('targetFound');
    setPlacementGhost();
    renderInstruction('holding');
    progressAdvanceTimer = window.setTimeout(() => {
      if (!sessionActive || !targetVisible || hasLocked) return;
      setPlacementSolid();
      renderInstruction('locked');
      hasLocked = true;

      // The world-space anchor is now intentionally frozen. XR8 SLAM keeps
      // that pose on the table after the printed trigger leaves the camera.
      clearLockedHide();
      lockedHideTimer = window.setTimeout(() => {
        if (sessionActive && hasLocked && instruction) instruction.hidden = true;
      }, LOCKED_COPY_HIDE_MS);
    }, TARGET_LOCK_MS);
  };

  const onImageFound = (event) => {
    if (!sessionActive || !isOurTarget(event)) return;
    if (hasLocked) return;
    if (!applyTargetPose(event.detail)) return;
    beginTargetLock();
  };

  const onImageUpdated = (event) => {
    if (!sessionActive || hasLocked || !isOurTarget(event)) return;
    applyTargetPose(event.detail);
  };

  const onImageLost = (event) => {
    if (!sessionActive || hasLocked || !isOurTarget(event)) return;
    targetVisible = false;
    anchor.object3D.visible = false;
    anchor.emit('targetLost');
    clearProgressAdvance();
    clearLostGrace();
    lostGraceTimer = window.setTimeout(() => {
      if (!sessionActive || targetVisible || hasLocked) return;
      setPlacementGhost();
      renderInstruction('lost');
    }, TARGET_LOST_GRACE_MS);
  };

  scene.addEventListener('xrimagefound', onImageFound);
  scene.addEventListener('xrimageupdated', onImageUpdated);
  scene.addEventListener('xrimagelost', onImageLost);
  scene.addEventListener('realityerror', (event) => {
    lastEngineError = event.detail?.error || event.detail || new Error('AR engine failed');
    if (startPromise || isRunning) showFault();
  });
  scene.addEventListener('camerastatuschange', (event) => {
    const detail = event.detail || {};
    if (detail.status === 'hasVideo' && startPromise && !faultShown) {
      cameraLive = true;
      resolveCameraWaiters(true);
    } else if (detail.status === 'failed' && (startPromise || isRunning)) {
      lastEngineError = detail.error || new Error('Camera failed to start');
      showFault();
    }
  });

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
        hasLocked = false;
        targetVisible = false;
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
        if (hasStartedEngine && engine.isPaused?.()) {
          sessionActive = true;
          await engine.resume();
        } else {
          engine.XrController.configure({
            imageTargetData: [target],
            scale: 'absolute',
            disableWorldTracking: false,
            enableLighting: true
          });
          hasStartedEngine = true;
          sessionActive = true;
          scene.emit('runreality');
        }
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
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  };

  startButton.addEventListener('click', () => {
    if (!isEmbedded) requestTopLevelMotionPermissions();
    start();
  });

  faultRetry?.addEventListener('click', () => {
    hideFault();
    stop().then(start);
  });
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
