(() => {
  const config = window.STEAKOUT_AR_CONFIG || {};
  const markerConfig = config.marker || {};
  const isEmbedded = new URLSearchParams(window.location.search).get('embedded') === '1';
  const scene = document.querySelector('#marker-scene');
  const anchor = document.querySelector('#marker-anchor');
  const food = document.querySelector('#marker-food');
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

  let arSystem;
  let startPromise;
  let stopPromise;
  let isRunning = false;
  let targetVisible = false;
  let progressAdvanceTimer;

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  const postToParent = (type) => {
    if (!isEmbedded || window.parent === window) return;
    window.parent.postMessage({ type }, window.location.origin);
  };

  const setProgressStep = (currentStep) => {
    if (instruction) instruction.dataset.currentStep = String(currentStep);

    progressSteps.forEach((progressStep) => {
      const stepNumber = Number(progressStep.dataset.step);
      const state = stepNumber === currentStep
        ? 'active'
        : stepNumber < currentStep
          ? 'complete'
          : 'upcoming';

      progressStep.dataset.state = state;
      progressStep.setAttribute('aria-current', state === 'active' ? 'step' : 'false');
    });
  };

  const instructionStates = {
    scanning: {
      step: 2,
      title: 'POINT BACK AT THE TABLE GRAPHIC',
      body: 'Keep the full graphic in frame. Your $12 lunch will appear here.',
      status: 'SCANNING',
      statusState: 'busy'
    },
    holding: {
      step: 3,
      title: 'KEEP THE FULL GRAPHIC IN FRAME',
      body: 'Hold steady while Steak Out locks your $12 lunch to this table.',
      status: 'HOLD STEADY',
      statusState: 'busy'
    },
    locked: {
      step: 4,
      title: 'YOUR $12 LUNCH IS RIGHT HERE',
      body: 'Move around it to see the portion before you order.',
      status: 'MEAL READY',
      statusState: 'active'
    },
    lost: {
      step: 2,
      title: 'POINT BACK AT THE TABLE GRAPHIC',
      body: 'Bring the full graphic back into frame and reduce glare.',
      status: 'SEARCHING',
      statusState: 'busy'
    },
    error: {
      step: 2,
      title: 'ALLOW THE CAMERA TO CONTINUE',
      body: 'Allow camera access, then close and reopen Steak Out AR.',
      status: 'CAMERA ERROR',
      statusState: 'error'
    }
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

  if (orderLink && config.orderUrl) orderLink.href = config.orderUrl;
  if (instagramLink && config.social?.instagramUrl) instagramLink.href = config.social.instagramUrl;
  if (facebookLink && config.social?.facebookUrl) facebookLink.href = config.social.facebookUrl;

  const getArSystem = async () => {
    if (arSystem) return arSystem;
    if (!scene.hasLoaded) {
      await new Promise((resolve) => scene.addEventListener('loaded', resolve, { once: true }));
    }
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

  const start = () => {
    if (stopPromise) return stopPromise.then(start);
    if (isRunning) return Promise.resolve();
    if (startPromise) return startPromise;

    startPromise = (async () => {
      try {
        clearProgressAdvance();
        targetVisible = false;
        setStatus('STARTING', 'busy');
        intro.hidden = true;
        guide.hidden = true;
        if (instruction) instruction.hidden = true;
        if (socialDock) socialDock.hidden = true;
        if (orderLink) orderLink.hidden = true;
        showSplash();
        window.dispatchEvent(new Event('resize'));

        const minSplashTime = new Promise((resolve) => setTimeout(resolve, 1050));
        const system = await getArSystem();
        if (!system) throw new Error('MindAR image system failed to initialize.');

        await system.start();
        isRunning = true;
        await minSplashTime;
        guide.hidden = false;
        guide.classList.remove('is-found');
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
      if (splash) splash.hidden = true;
      guide.hidden = true;
      guide.classList.remove('is-found');
      if (instruction) instruction.hidden = true;
      if (socialDock) socialDock.hidden = true;
      if (orderLink) orderLink.hidden = true;
      intro.hidden = isEmbedded;
      setStatus('READY');
    })().finally(() => {
      stopPromise = null;
    });

    return stopPromise;
  };

  anchor.addEventListener('targetFound', () => {
    if (!isRunning) return;
    targetVisible = true;
    clearProgressAdvance();
    guide?.classList.add('is-found');
    renderInstruction('holding');

    progressAdvanceTimer = window.setTimeout(() => {
      if (!isRunning || !targetVisible) return;
      renderInstruction('locked');
    }, 900);
  });

  anchor.addEventListener('targetLost', () => {
    if (!isRunning) return;
    targetVisible = false;
    clearProgressAdvance();
    guide?.classList.remove('is-found');
    renderInstruction('lost');
  });

  startButton.addEventListener('click', start);

  if (isEmbedded) {
    intro.hidden = true;
    logoHome?.setAttribute('aria-label', 'Close Steak Out AR');
    logoHome?.addEventListener('click', (event) => {
      event.preventDefault();
      postToParent('steakout-ar-close');
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      if (event.data?.type === 'steakout-ar-start') start();
      else if (event.data?.type === 'steakout-ar-stop') stop();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') postToParent('steakout-ar-close');
    });

    getArSystem()
      .then(() => postToParent('steakout-ar-ready'))
      .catch(() => postToParent('steakout-ar-camera-error'));
  }
})();
