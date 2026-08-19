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
  const instructionToggle = document.querySelector('#marker-instruction-toggle');
  const instructionEyebrow = document.querySelector('#marker-instruction-eyebrow');
  const instructionTitle = document.querySelector('#marker-instruction-title');
  const instructionBody = document.querySelector('#marker-instruction-body');
  const sizeControl = document.querySelector('#marker-size-control');
  const socialDock = document.querySelector('#marker-social');
  const instagramLink = document.querySelector('#marker-instagram');
  const facebookLink = document.querySelector('#marker-facebook');
  const orderLink = document.querySelector('#marker-order');
  const status = document.querySelector('#marker-status');
  const splash = document.querySelector('#ar-splash');
  const down = document.querySelector('#scale-down');
  const up = document.querySelector('#scale-up');
  const scaleOutput = document.querySelector('#scale-output');
  const logoHome = document.querySelector('.marker-logo-home');

  if (!scene || !anchor || !food || !startButton) return;

  let scale = Number(markerConfig.modelScale || 0.32);
  let instructionCollapseTimer;
  let arSystem;
  let startPromise;
  let stopPromise;
  let isRunning = false;
  const initialScale = scale;
  const minScale = Number(markerConfig.minScale || 0.08);
  const maxScale = Number(markerConfig.maxScale || 1.25);
  const step = Number(markerConfig.scaleStep || 0.04);

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  const postToParent = (type) => {
    if (!isEmbedded || window.parent === window) return;
    window.parent.postMessage({ type }, window.location.origin);
  };

  const applyScale = () => {
    food.setAttribute('scale', `${scale} ${scale} ${scale}`);
    if (scaleOutput) scaleOutput.textContent = `${Math.round((scale / initialScale) * 100)}%`;
  };

  const clampScale = (next) => Math.min(maxScale, Math.max(minScale, next));

  const instructionStates = {
    scanning: {
      eyebrow: '1 · VIEW IN AR',
      title: 'POINT BACK AT THE TABLE GRAPHIC',
      body: 'Keep the full graphic in frame. Your $12 lunch will appear here.'
    },
    locked: {
      eyebrow: '2 · PORTION PREVIEW',
      title: 'YOUR $12 LUNCH IS RIGHT HERE',
      body: 'Move around it—the portion stays anchored to this table.'
    },
    lost: {
      eyebrow: 'FIND THE GRAPHIC',
      title: 'POINT BACK AT THE TABLE GRAPHIC',
      body: 'Keep the whole graphic visible and reduce glare.'
    },
    error: {
      eyebrow: 'CAMERA ACCESS',
      title: 'ALLOW THE CAMERA TO CONTINUE',
      body: 'Allow camera access, then tap this message to try again.'
    }
  };

  const renderInstruction = (state, { collapse = false } = {}) => {
    if (!instruction) return;
    const next = instructionStates[state] || instructionStates.scanning;
    window.clearTimeout(instructionCollapseTimer);
    instruction.dataset.state = state;
    instruction.classList.toggle('is-collapsed', collapse);
    instruction.hidden = false;
    if (instructionEyebrow) instructionEyebrow.textContent = next.eyebrow;
    if (instructionTitle) instructionTitle.textContent = next.title;
    if (instructionBody) instructionBody.textContent = next.body;
    instructionToggle?.setAttribute('aria-expanded', collapse ? 'false' : 'true');
  };

  const scheduleInstructionCollapse = () => {
    window.clearTimeout(instructionCollapseTimer);
    instructionCollapseTimer = window.setTimeout(() => {
      if (instruction?.dataset.state !== 'locked') return;
      instruction.classList.add('is-collapsed');
      instructionToggle?.setAttribute('aria-expanded', 'false');
    }, 1900);
  };

  food.setAttribute('src', config.modelUrl || '');
  food.setAttribute('position', markerConfig.modelPosition || '0 0 0.12');
  food.setAttribute('rotation', markerConfig.modelRotation || '90 0 0');
  applyScale();
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

  const start = () => {
    if (stopPromise) return stopPromise.then(start);
    if (isRunning) return Promise.resolve();
    if (startPromise) return startPromise;

    startPromise = (async () => {
      try {
        setStatus('STARTING', 'busy');
        intro.hidden = true;
        guide.hidden = true;
        if (instruction) instruction.hidden = true;
        sizeControl.hidden = true;
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
        setStatus('SCANNING', 'busy');
        guide.hidden = false;
        guide.classList.remove('is-found');
        renderInstruction('scanning');
        sizeControl.hidden = !config.demoAsset;
        if (socialDock) socialDock.hidden = false;
        if (orderLink) orderLink.hidden = false;
        await revealCamera();
        postToParent('steakout-ar-camera-live');
      } catch (error) {
        console.error(error);
        isRunning = false;
        if (splash) splash.hidden = true;
        setStatus('CAMERA ERROR', 'error');
        intro.hidden = isEmbedded;
        guide.hidden = true;
        sizeControl.hidden = true;
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
      window.clearTimeout(instructionCollapseTimer);
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
      sizeControl.hidden = true;
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
    setStatus('LOCKED', 'active');
    guide?.classList.add('is-found');
    renderInstruction('locked');
    scheduleInstructionCollapse();
  });

  anchor.addEventListener('targetLost', () => {
    setStatus('SEARCHING', 'busy');
    guide?.classList.remove('is-found');
    renderInstruction('lost');
  });

  instructionToggle?.addEventListener('click', () => {
    if (instruction?.dataset.state === 'error') {
      start();
      return;
    }
    if (instruction?.dataset.state !== 'locked') return;
    const willExpand = instruction.classList.contains('is-collapsed');
    instruction.classList.toggle('is-collapsed', !willExpand);
    instructionToggle.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
    if (willExpand) scheduleInstructionCollapse();
  });

  down?.addEventListener('click', () => {
    scale = clampScale(Number((scale - step).toFixed(3)));
    applyScale();
  });

  up?.addEventListener('click', () => {
    scale = clampScale(Number((scale + step).toFixed(3)));
    applyScale();
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
