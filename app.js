(() => {
  const viewer = document.querySelector('#meal-viewer');
  const status = document.querySelector('#ar-status');
  const itemName = document.querySelector('#item-name');
  const prototypeNote = document.querySelector('#prototype-note');
  const modeToggle = document.querySelector('#mode-toggle');
  const modeButtons = [...document.querySelectorAll('[data-ar-mode]')];
  const modeTitle = document.querySelector('#mode-title');
  const modeCopy = document.querySelector('#mode-copy');
  const modeBadge = document.querySelector('#mode-badge');
  const launchButtons = [
    document.querySelector('#launch-ar-top'),
    document.querySelector('#launch-ar-mobile')
  ].filter(Boolean);

  const config = window.STEAKOUT_AR_CONFIG || {};
  let activeMode = config.defaultMode === 'marker' ? 'marker' : 'free';

  if (!viewer) return;

  if (config.modelUrl) viewer.src = config.modelUrl;
  if (config.iosModelUrl) viewer.setAttribute('ios-src', config.iosModelUrl);
  if (config.itemName && itemName) itemName.textContent = config.itemName;
  viewer.setAttribute('ar-scale', config.freePlace?.arScale || 'auto');

  document.querySelectorAll('[data-order-link]').forEach((link) => {
    if (config.orderUrl) link.href = config.orderUrl;
  });

  if (!config.demoAsset && prototypeNote) prototypeNote.hidden = true;
  if (!config.showModeToggle && modeToggle) modeToggle.hidden = true;

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  const track = (eventName, detail = {}) => {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: eventName, ...detail });
  };

  const renderMode = () => {
    const marker = activeMode === 'marker';

    modeButtons.forEach((button) => {
      const selected = button.dataset.arMode === activeMode;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    if (modeTitle) modeTitle.textContent = marker ? 'LOCK TO QR / TABLE MARKER' : 'PLACE IT ANYWHERE';
    if (modeCopy) {
      modeCopy.textContent = marker
        ? 'Camera tracks a printed image and keeps the meal locked to that exact spot on the table.'
        : 'No printed marker needed. Scan a horizontal surface and drop the test meal wherever you want.';
    }
    if (modeBadge) modeBadge.textContent = marker ? 'FINAL TABLE MODE' : 'TEST NOW';

    launchButtons.forEach((button) => {
      button.lastChild.textContent = marker ? ' START QR LOCK' : ' VIEW IN AR';
    });

    setStatus(marker ? 'MARKER READY' : '3D READY', 'ready');
  };

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.arMode;
      if (next === 'marker' && config.marker?.enabled === false) return;
      activeMode = next === 'marker' ? 'marker' : 'free';
      renderMode();
      track('ar_mode_changed', { mode: activeMode });
    });
  });

  viewer.addEventListener('load', () => {
    setStatus(activeMode === 'marker' ? 'MARKER READY' : '3D READY', 'ready');
    track('ar_model_loaded', { item: config.itemName || 'unknown' });
  });

  viewer.addEventListener('error', () => setStatus('MODEL ERROR', 'error'));

  viewer.addEventListener('ar-status', (event) => {
    const arStatus = event.detail?.status;
    if (activeMode !== 'free') return;

    if (arStatus === 'session-started') {
      setStatus('AR ACTIVE', 'active');
      track('ar_session_started', { item: config.itemName || 'unknown', mode: 'free' });
    } else if (arStatus === 'object-placed') {
      setStatus('PLACED', 'active');
      track('ar_object_placed', { item: config.itemName || 'unknown', mode: 'free' });
    } else if (arStatus === 'failed') {
      setStatus('AR UNAVAILABLE', 'error');
    } else if (arStatus === 'not-presenting') {
      setStatus('3D READY', 'ready');
    }
  });

  const launchAR = async () => {
    track('ar_launch_tapped', { item: config.itemName || 'unknown', mode: activeMode });

    if (activeMode === 'marker') {
      window.location.href = './marker.html';
      return;
    }

    if (typeof viewer.activateAR !== 'function') {
      viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setStatus('USE AR BUTTON', 'error');
      return;
    }

    try {
      await viewer.activateAR();
    } catch (error) {
      viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setStatus('AR UNAVAILABLE', 'error');
      console.warn('AR launch failed:', error);
    }
  };

  launchButtons.forEach((button) => button.addEventListener('click', launchAR));
  renderMode();
})();
