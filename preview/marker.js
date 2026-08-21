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

  // marker.html hard-codes a sample target in its mindar-image attribute, so
  // config.marker.targetMindUrl was doing nothing. Swapping the printed marker
  // should be one config change, not an edit in two files.
  if (markerConfig.targetMindUrl) {
    scene.setAttribute('mindar-image', 'imageTargetSrc', markerConfig.targetMindUrl);
  }

  let arSystem;
  let startPromise;
  let stopPromise;
  let isRunning = false;
  let targetVisible = false;
  let progressAdvanceTimer;
  let hasLocked = false;
  let lostGraceTimer;
  let lockedHideTimer;

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  // A model at 34% opacity still writes a fully opaque silhouette into the
  // shadow map, so the contact shadow has to be faded by hand alongside the
  // placement ghost or the meal floats above a solid shadow while it is still
  // translucent. setAttribute rather than a direct call so the value survives
  // if the component has not initialised yet.
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

  /* These fallbacks must match what config.js actually ships, or a dropped key
   * renders the plate at a wildly wrong size. '0 0 0.12' and 0.32 were
   * README-era values: 0.32 puts the meal at about 11% of the flyer's width
   * instead of 3.2x it, a 28-fold error that would look like a broken model
   * rather than a missing config value. */
  food.setAttribute('src', config.modelUrl || '');
  food.setAttribute('position', markerConfig.modelPosition || '0 0 0');
  food.setAttribute('rotation', markerConfig.modelRotation || '90 0 0');
  const modelScale = Number(markerConfig.modelScale || 9.0);
  food.setAttribute('scale', `${modelScale} ${modelScale} ${modelScale}`);
  food.addEventListener('model-loaded', () => setPlacementGhost());

  if (orderLink && config.orderUrl) orderLink.href = config.orderUrl;
  if (instagramLink && config.social?.instagramUrl) instagramLink.href = config.social.instagramUrl;
  if (facebookLink && config.social?.facebookUrl) facebookLink.href = config.social.facebookUrl;

  const getArSystem = async () => {
    if (arSystem) return arSystem;
    if (!scene.hasLoaded) await new Promise((resolve) => scene.addEventListener('loaded', resolve, { once: true }));
    arSystem = scene.systems['mindar-image-system'];
    return arSystem;
  };

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

  /* Camera failure used to be completely silent, for three stacked reasons:
   *   - mind-ar's system.start() is synchronous and returns undefined, so the
   *     `await system.start()` below always resolves even when the camera died;
   *   - _startVideo catches the getUserMedia rejection itself and re-emits it
   *     as an `arError` event, which nothing in this repo listened for;
   *   - the 'error' instruction state renders into .marker-instruction__copy
   *     and .marker-status, both of which the compact-layout sheets hide with
   *     display:none !important.
   * The customer was left on a black screen reading "POINT BACK AT THE TABLE
   * GRAPHIC". This is the missing detection and the missing surface.
   *
   * ar-camera-tune.js already recorded WHY the request failed, so name the
   * cause rather than offering one generic apology for four different faults. */
  let faultShown = false;
  let cameraWatchdog;

  const clearCameraWatchdog = () => {
    window.clearTimeout(cameraWatchdog);
    cameraWatchdog = undefined;
  };

  const cameraLooksLive = () => {
    const v = document.querySelector('.marker-shell video, a-scene video');
    return !!(v && v.videoWidth > 0);
  };

  const faultCopy = () => {
    const summary = (window.__steakoutCamera && window.__steakoutCamera.summary) || '';
    if (/NotAllowedError|SecurityError|PermissionDenied/i.test(summary)) {
      return {
        title: 'CAMERA ACCESS IS OFF',
        body: 'Tap Allow when your phone asks. If you already said no, turn the camera on for this site in your browser settings.'
      };
    }
    if (/NotReadableError|AbortError|TrackStartError/i.test(summary)) {
      return {
        title: 'THE CAMERA IS BUSY',
        body: 'Another app may be using it. Close your other camera apps, then try again.'
      };
    }
    if (/NotFoundError|OverconstrainedError|DevicesNotFound/i.test(summary)) {
      return {
        title: 'NO CAMERA AVAILABLE',
        body: 'This device did not offer a camera we can use. Try opening this page in Safari or Chrome directly.'
      };
    }
    // No report at all: the wrapper never ran, so A-Frame or mind-ar never
    // arrived. That is the CDN case HANDOFF section 9 flags as unmitigated.
    return {
      title: 'AR COULDN\u2019T LOAD',
      body: 'Check your connection and try again. If you opened this from another app, try opening it in your browser instead.'
    };
  };

  const showFault = () => {
    if (!fault || faultShown) return;
    faultShown = true;
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
    fault.hidden = false;
    postToParent('steakout-ar-camera-error');
  };

  const hideFault = () => {
    faultShown = false;
    if (fault) fault.hidden = true;
  };

  // mind-ar emits this for a failed getUserMedia and for an unsupported
  // browser. It is the fast, definite signal; the watchdog below is the
  // backstop for the cases that hang instead of erroring.
  scene.addEventListener('arError', showFault);

  const armCameraWatchdog = () => {
    clearCameraWatchdog();
    /* Generous on purpose. The permission prompt sits in front of the user for
     * an unknown time, and mind-ar only fetches the .mind target AFTER
     * getUserMedia resolves -- half a megabyte on a restaurant connection.
     * This fires only if nothing is producing frames well past both. */
    cameraWatchdog = window.setTimeout(() => {
      if (!cameraLooksLive()) showFault();
    }, 20000);
  };

  const start = () => {
    if (stopPromise) return stopPromise.then(start);
    if (isRunning) return Promise.resolve();
    if (startPromise) return startPromise;

    startPromise = (async () => {
      try {
        clearProgressAdvance();
        clearLostGrace();
        clearLockedHide();
        hasLocked = false;
        targetVisible = false;
        hideFault();
        armCameraWatchdog();
        setPlacementGhost();
        intro.hidden = true;
        guide.hidden = true;
        if (instruction) instruction.hidden = true;
        if (socialDock) socialDock.hidden = true;
        if (orderLink) orderLink.hidden = true;
        showSplash();
        window.dispatchEvent(new Event('resize'));

        const minSplashTime = new Promise((resolve) => setTimeout(resolve, 1250));
        const system = await getArSystem();
        if (!system) throw new Error('MindAR image system failed to initialize.');
        await system.start();
        isRunning = true;
        await minSplashTime;
        /* mind-ar's start() is synchronous and returns undefined, so getting
         * here proves nothing about whether the camera came up. If the arError
         * listener has already raised the fault, stop -- otherwise the scanning
         * HUD is painted underneath the error the customer is reading. */
        if (faultShown) return;
        renderInstruction('scanning');
        if (socialDock) socialDock.hidden = false;
        if (orderLink) orderLink.hidden = false;
        clearCameraWatchdog();
        await revealCamera();
        postToParent('steakout-ar-camera-live');
      } catch (error) {
        console.error(error);
        isRunning = false;
        targetVisible = false;
        intro.hidden = isEmbedded;
        // showFault() clears the progress timer, hides the splash and the rest
        // of the HUD, and posts steakout-ar-camera-error itself.
        showFault();
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      targetVisible = false;
      // Or it fires 20s later and drops a camera error over a closed session.
      clearCameraWatchdog();
      clearProgressAdvance();
      if (startPromise) await startPromise;
      try {
        const system = await getArSystem();
        if (isRunning && system?.stop) await system.stop();
      } catch (error) {
        console.warn('Unable to stop AR cleanly:', error);
      }
      isRunning = false;
      setPlacementGhost();
      if (splash) splash.hidden = true;
      guide.hidden = true;
      if (instruction) instruction.hidden = true;
      if (socialDock) socialDock.hidden = true;
      if (orderLink) orderLink.hidden = true;
      intro.hidden = isEmbedded;
      setStatus('');
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  };

  anchor.addEventListener('targetFound', () => {
    if (!isRunning) return;
    targetVisible = true;
    clearProgressAdvance();
    clearLostGrace();

    // Already locked once: re-acquiring after a wobble should be silent rather
    // than replaying the whole walkthrough.
    if (hasLocked) {
      setPlacementSolid();
      if (instruction) instruction.hidden = true;
      return;
    }

    setPlacementGhost();
    renderInstruction('holding');
    progressAdvanceTimer = window.setTimeout(() => {
      if (!isRunning || !targetVisible) return;
      setPlacementSolid();
      renderInstruction('locked');
      hasLocked = true;

      // The steps have done their job the moment the meal is on the table.
      clearLockedHide();
      lockedHideTimer = window.setTimeout(() => {
        if (!isRunning || !targetVisible) return;
        if (instruction) instruction.hidden = true;
      }, 2200);
    }, 900);
  });

  anchor.addEventListener('targetLost', () => {
    if (!isRunning) return;
    targetVisible = false;
    clearProgressAdvance();

    // A momentary wobble should not tear the guidance back over the screen.
    // Only admit we lost it if it stays lost.
    clearLostGrace();
    lostGraceTimer = window.setTimeout(() => {
      if (!isRunning || targetVisible) return;
      hasLocked = false;
      setPlacementGhost();
      renderInstruction('lost');
    }, 1600);
  });

  startButton.addEventListener('click', start);

  faultRetry?.addEventListener('click', () => {
    hideFault();
    // A fresh attempt needs a fresh permission request, so drop any half-built
    // session first rather than resolving straight out of the isRunning guard.
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
    getArSystem().then(() => postToParent('steakout-ar-ready')).catch(() => postToParent('steakout-ar-camera-error'));
  }
})();
