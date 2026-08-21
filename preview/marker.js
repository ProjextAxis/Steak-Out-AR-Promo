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
    scanning: { step: 2, title: 'POINT BACK AT THE TABLE GRAPHIC', body: 'Keep the full graphic in frame. Your $12 lunch will appear here.', status: '', statusState: '' },
    holding: { step: 3, title: 'KEEP THE FULL GRAPHIC IN FRAME', body: 'Hold steady while Steak Out locks your $12 lunch to this table.', status: '', statusState: '' },
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
  food.setAttribute('position', markerConfig.modelPosition || '0 0 0.12');
  food.setAttribute('rotation', markerConfig.modelRotation || '90 0 0');
  const modelScale = Number(markerConfig.modelScale || 0.32);
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
        renderInstruction('scanning');
        if (socialDock) socialDock.hidden = false;
        if (orderLink) orderLink.hidden = false;
        await revealCamera();
        postToParent('steakout-ar-camera-live');
      } catch (error) {
        console.error(error);
        isRunning = false;
        targetVisible = false;
        clearProgressAdvance();
        if (splash) splash.hidden = true;
        intro.hidden = isEmbedded;
        guide.hidden = true;
        if (socialDock) socialDock.hidden = true;
        if (orderLink) orderLink.hidden = true;
        if (isEmbedded) renderInstruction('error');
        else if (instruction) instruction.hidden = true;
        postToParent('steakout-ar-camera-error');
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
