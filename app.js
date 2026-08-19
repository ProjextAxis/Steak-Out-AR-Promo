(() => {
  const viewer = document.querySelector('#meal-viewer');
  const status = document.querySelector('#ar-status');
  const modeToggle = document.querySelector('#mode-toggle');
  const modeButtons = [...document.querySelectorAll('[data-ar-mode]')];
  const modeCopy = document.querySelector('#mode-copy');
  const splash = document.querySelector('#ar-splash');
  const launchButton = document.querySelector('#launch-ar-top');
  const arGuide = document.querySelector('#ar-guide');
  const arGuideStart = document.querySelector('#ar-guide-start');
  const arGuideCloseButtons = [...document.querySelectorAll('[data-guide-close]')];
  const browserARLayer = document.querySelector('#browser-ar-layer');
  const browserARFrame = document.querySelector('#browser-ar-frame');
  const browserARLoading = document.querySelector('#browser-ar-loading');
  const announcementViewport = document.querySelector('.announcement__viewport');
  const announcementTrack = document.querySelector('.announcement__track');
  const announcementDots = [...document.querySelectorAll('.announcement__dots span')];

  const announcementDelay = 8000;
  const announcementTransitionDuration = 300;
  const announcementMessageCount = 2;
  let announcementIndex = 0;
  let announcementSlot = 1;
  let announcementTimer;
  let announcementIsTransitioning = false;
  let announcementPointerStart = null;
  let browserARFrameReady = false;
  let browserARIsLoaded = false;
  let browserARShouldStart = false;

  const updateAnnouncementDots = () => {
    announcementDots.forEach((dot, dotIndex) => {
      dot.style.background = dotIndex === announcementIndex
        ? 'var(--white)'
        : 'rgba(255,255,255,.42)';
    });
  };

  const positionAnnouncementTrack = (animate) => {
    announcementTrack.style.transition = animate
      ? `transform ${announcementTransitionDuration}ms ease`
      : 'none';
    announcementTrack.style.transform = `translate3d(-${announcementSlot * 100}%, 0, 0)`;
  };

  const scheduleAnnouncement = () => {
    window.clearTimeout(announcementTimer);
    announcementTimer = window.setTimeout(() => moveAnnouncement(1), announcementDelay);
  };

  const finishAnnouncementMove = () => {
    if (announcementSlot === 0) {
      announcementSlot = 2;
      positionAnnouncementTrack(false);
    } else if (announcementSlot === 3) {
      announcementSlot = 1;
      positionAnnouncementTrack(false);
    }

    announcementIsTransitioning = false;
    scheduleAnnouncement();
  };

  function moveAnnouncement(direction) {
    if (announcementIsTransitioning) return;

    window.clearTimeout(announcementTimer);
    announcementIsTransitioning = true;
    announcementIndex = (announcementIndex + direction + announcementMessageCount) % announcementMessageCount;
    announcementSlot += direction;
    updateAnnouncementDots();

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      positionAnnouncementTrack(false);
      finishAnnouncementMove();
      return;
    }

    positionAnnouncementTrack(true);
  }

  if (announcementViewport && announcementTrack && announcementDots.length === announcementMessageCount) {
    positionAnnouncementTrack(false);
    updateAnnouncementDots();

    announcementTrack.addEventListener('transitionend', (event) => {
      if (event.target === announcementTrack && event.propertyName === 'transform') {
        finishAnnouncementMove();
      }
    });

    announcementViewport.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary) return;
      announcementPointerStart = { id: event.pointerId, x: event.clientX };
      window.clearTimeout(announcementTimer);
    });

    announcementViewport.addEventListener('pointerup', (event) => {
      if (!announcementPointerStart || announcementPointerStart.id !== event.pointerId) return;
      const swipeDistance = event.clientX - announcementPointerStart.x;
      announcementPointerStart = null;

      if (Math.abs(swipeDistance) >= 32) moveAnnouncement(swipeDistance < 0 ? 1 : -1);
      else scheduleAnnouncement();
    });

    announcementViewport.addEventListener('pointercancel', () => {
      announcementPointerStart = null;
      scheduleAnnouncement();
    });

    scheduleAnnouncement();
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

  const postToBrowserAR = (type) => {
    if (!browserARFrameReady || !browserARFrame?.contentWindow) return;
    browserARFrame.contentWindow.postMessage({ type }, window.location.origin);
  };

  const loadBrowserAR = () => {
    if (!browserARFrame || browserARIsLoaded) return;
    const source = browserARFrame.dataset.src;
    if (!source) return;
    browserARIsLoaded = true;
    browserARFrame.src = source;
  };

  const openBrowserAR = () => {
    if (!browserARLayer || !browserARFrame) {
      window.location.href = './marker.html';
      return;
    }

    browserARShouldStart = true;
    browserARLayer.classList.add('is-open');
    browserARLayer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('browser-ar-open');
    if (browserARLoading) browserARLoading.hidden = browserARFrameReady;
    loadBrowserAR();

    if (browserARFrameReady) postToBrowserAR('steakout-ar-start');
    setStatus('OPENING AR', 'active');
    track('browser_ar_opened', { item: config.itemName || 'test-food' });
  };

  const closeBrowserAR = () => {
    if (!browserARLayer?.classList.contains('is-open')) return;
    browserARShouldStart = false;
    postToBrowserAR('steakout-ar-stop');
    browserARLayer.classList.remove('is-open');
    browserARLayer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('browser-ar-open');
    setStatus('QR READY', 'ready');
    track('browser_ar_closed');
    window.setTimeout(() => launchButton?.focus(), 0);
  };

  window.addEventListener('message', (event) => {
    if (!browserARFrame?.contentWindow || event.source !== browserARFrame.contentWindow) return;
    if (event.origin !== window.location.origin) return;

    if (event.data?.type === 'steakout-ar-ready') {
      browserARFrameReady = true;
      if (browserARShouldStart) {
        if (browserARLoading) browserARLoading.hidden = true;
        postToBrowserAR('steakout-ar-start');
      }
    } else if (event.data?.type === 'steakout-ar-camera-live') {
      if (!browserARShouldStart) {
        postToBrowserAR('steakout-ar-stop');
        return;
      }
      if (browserARLoading) browserARLoading.hidden = true;
      setStatus('AR ACTIVE', 'active');
    } else if (event.data?.type === 'steakout-ar-camera-error') {
      if (!browserARShouldStart) return;
      if (browserARLoading) browserARLoading.hidden = true;
      setStatus('CAMERA ERROR', 'error');
    } else if (event.data?.type === 'steakout-ar-close') {
      closeBrowserAR();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeBrowserAR();
  });

  window.addEventListener('pagehide', () => postToBrowserAR('steakout-ar-stop'));

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

    if (launchButton) {
      if (activeMode === 'marker') {
        launchButton.removeAttribute('aria-haspopup');
        launchButton.removeAttribute('aria-controls');
        launchButton.removeAttribute('aria-expanded');
      } else {
        launchButton.setAttribute('aria-haspopup', 'dialog');
        launchButton.setAttribute('aria-controls', 'ar-guide');
        launchButton.setAttribute('aria-expanded', 'false');
      }
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
    if (arStatus === 'session-started') {
      setStatus('AR ACTIVE', 'active');
    } else if (arStatus === 'object-placed') {
      setStatus('PLACED', 'active');
    } else if (arStatus === 'failed') {
      setStatus('AR UNAVAILABLE', 'error');
    } else if (arStatus === 'not-presenting') setStatus('3D READY', 'ready');
  });

  const launchAR = async () => {
    track('ar_launch_tapped', { mode: activeMode, item: config.itemName || 'test-food' });

    if (activeMode === 'marker') {
      openBrowserAR();
      return;
    }

    await runSplash();

    try {
      if (typeof viewer.activateAR !== 'function') throw new Error('AR unavailable');
      await viewer.activateAR();
    } catch (error) {
      console.warn('AR launch failed:', error);
      viewer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setStatus('USE AR BUTTON', 'error');
    }
  };

  const closeARGuide = () => {
    if (arGuide?.open) arGuide.close();
  };

  launchButton?.addEventListener('click', () => {
    if (activeMode === 'marker') {
      launchAR();
      return;
    }

    if (!arGuide || typeof arGuide.showModal !== 'function') {
      launchAR();
      return;
    }

    arGuide.showModal();
    launchButton.setAttribute('aria-expanded', 'true');
    track('ar_guide_opened', { item: config.itemName || 'test-food' });
  });

  arGuideCloseButtons.forEach((button) => button.addEventListener('click', closeARGuide));

  arGuide?.addEventListener('click', (event) => {
    if (event.target === arGuide) closeARGuide();
  });

  arGuide?.addEventListener('close', () => {
    launchButton?.setAttribute('aria-expanded', 'false');
  });

  arGuideStart?.addEventListener('click', () => {
    closeARGuide();
    launchAR();
  });

  const warmBrowserAR = () => {
    if (config.marker?.enabled === false) return;
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(loadBrowserAR, { timeout: 1600 });
    } else {
      window.setTimeout(loadBrowserAR, 500);
    }
  };

  if (document.readyState === 'complete') warmBrowserAR();
  else window.addEventListener('load', warmBrowserAR, { once: true });

  renderMode();
})();
