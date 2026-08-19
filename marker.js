(() => {
  const config = window.STEAKOUT_AR_CONFIG || {};
  const markerConfig = config.marker || {};
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

  if (!scene || !anchor || !food || !startButton) return;

  let scale = Number(markerConfig.modelScale || 0.32);
  let instructionCollapseTimer;
  const initialScale = scale;
  const minScale = Number(markerConfig.minScale || 0.08);
  const maxScale = Number(markerConfig.maxScale || 1.25);
  const step = Number(markerConfig.scaleStep || 0.04);

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
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
    if (!scene.hasLoaded) {
      await new Promise((resolve) => scene.addEventListener('loaded', resolve, { once: true }));
    }
    return scene.systems['mindar-image-system'];
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

  const start = async () => {
    try {
      setStatus('STARTING', 'busy');
      intro.hidden = true;
      guide.hidden = true;
      if (instruction) instruction.hidden = true;
      sizeControl.hidden = true;
      if (socialDock) socialDock.hidden = true;
      if (orderLink) orderLink.hidden = true;
      showSplash();

      const minSplashTime = new Promise((resolve) => setTimeout(resolve, 1050));
      const arSystem = await getArSystem();
      if (!arSystem) throw new Error('MindAR image system failed to initialize.');

      await arSystem.start();
      await minSplashTime;
      setStatus('SCANNING', 'busy');
      guide.hidden = false;
      guide.classList.remove('is-found');
      renderInstruction('scanning');
      sizeControl.hidden = false;
      if (socialDock) socialDock.hidden = false;
      if (orderLink) orderLink.hidden = false;
      await revealCamera();
    } catch (error) {
      console.error(error);
      if (splash) splash.hidden = true;
      setStatus('CAMERA ERROR', 'error');
      intro.hidden = false;
      guide.hidden = true;
      if (instruction) instruction.hidden = true;
      sizeControl.hidden = true;
      if (socialDock) socialDock.hidden = true;
      if (orderLink) orderLink.hidden = true;
    }
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
})();
