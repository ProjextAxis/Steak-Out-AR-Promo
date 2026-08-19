(() => {
  const viewer = document.querySelector('#meal-viewer');
  const status = document.querySelector('#ar-status');
  const modeToggle = document.querySelector('#mode-toggle');
  const modeButtons = [...document.querySelectorAll('[data-ar-mode]')];
  const modeCopy = document.querySelector('#mode-copy');
  const splash = document.querySelector('#ar-splash');
  const launchButtons = [document.querySelector('#launch-ar-top')].filter(Boolean);
  const announcementCopy = document.querySelector('.announcement__copy');
  const announcementDots = [...document.querySelectorAll('.announcement__dots span')];

  const announcementMessages = [
    'Gift Cards Available In-Store Now!',
    'No Gift Idea? Give The Steak Out Experience'
  ];

  let announcementIndex = 0;

  const renderAnnouncement = (index, animate = true) => {
    if (!announcementCopy || announcementDots.length !== announcementMessages.length) return;

    const update = () => {
      announcementIndex = index;
      announcementCopy.textContent = announcementMessages[index];
      announcementDots.forEach((dot, dotIndex) => {
        dot.style.background = dotIndex === index
          ? 'var(--white)'
          : 'rgba(255,255,255,.42)';
      });
    };

    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      update();
      return;
    }

    const fadeOut = announcementCopy.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 180, easing: 'ease', fill: 'forwards' }
    );

    fadeOut.finished.then(() => {
      update();
      announcementCopy.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 180, easing: 'ease', fill: 'forwards' }
      );
    });
  };

  if (announcementCopy && announcementDots.length === announcementMessages.length) {
    renderAnnouncement(announcementIndex, false);
    window.setInterval(() => {
      renderAnnouncement((announcementIndex + 1) % announcementMessages.length);
    }, 5000);
  }

  const config = window.STEAKOUT_AR_CONFIG || {};
  let activeMode = config.defaultMode === 'marker' ? 'marker' : 'free';

  if (!viewer) return;

  if (config.modelUrl) viewer.src = config.modelUrl;
  if (config.iosModelUrl) viewer.setAttribute('ios-src', config.iosModelUrl);
  viewer.setAttribute('ar-scale', config.freePlace?.arScale || 'auto');

  document.querySelectorAll('[data-order-link]').forEach((link) => {
    if (config.orderUrl) link.href = config.orderUrl;
  });

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
    modeButtons.forEach((button) => {
      const selected = button.dataset.arMode === activeMode;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    if (modeCopy) {
      modeCopy.textContent = activeMode === 'marker'
        ? 'Lock the test model to the printed table marker.'
        : 'Place the test model anywhere without a printed marker.';
    }

    setStatus(activeMode === 'marker' ? 'QR READY' : '3D READY', 'ready');
  };

  const runSplash = async () => {
    if (!splash) return;
    splash.classList.remove('is-active');
    void splash.offsetWidth;
    splash.classList.add('is-active');
    await new Promise((resolve) => setTimeout(resolve, 900));
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
    setStatus(activeMode === 'marker' ? 'QR READY' : '3D READY', 'ready');
  });

  viewer.addEventListener('error', () => setStatus('MODEL ERROR', 'error'));

  viewer.addEventListener('ar-status', (event) => {
    if (activeMode !== 'free') return;
    const arStatus = event.detail?.status;
    if (arStatus === 'session-started') setStatus('AR ACTIVE', 'active');
    else if (arStatus === 'object-placed') setStatus('PLACED', 'active');
    else if (arStatus === 'failed') setStatus('AR UNAVAILABLE', 'error');
    else if (arStatus === 'not-presenting') setStatus('3D READY', 'ready');
  });

  const launchAR = async () => {
    track('ar_launch_tapped', { mode: activeMode, item: config.itemName || 'test-food' });
    await runSplash();

    if (activeMode === 'marker') {
      window.location.href = './marker.html';
      return;
    }

    try {
      if (typeof viewer.activateAR !== 'function') throw new Error('AR unavailable');
      await viewer.activateAR();
    } catch (error) {
      console.warn('AR launch failed:', error);
      viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setStatus('USE AR BUTTON', 'error');
    }
  };

  launchButtons.forEach((button) => button.addEventListener('click', launchAR));
  renderMode();
})();
