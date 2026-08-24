(() => {
  const viewer = document.querySelector('#meal-viewer');
  const status = document.querySelector('#ar-status');
  const modeToggle = document.querySelector('#mode-toggle');
  const modeButtons = [...document.querySelectorAll('[data-ar-mode]')];
  const modeCopy = document.querySelector('#mode-copy');
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
  const browserARSplashMinimum = 1200;
  let announcementIndex = 0;
  let announcementSlot = 1;
  let announcementTimer;
  let announcementIsTransitioning = false;
  let announcementPointerStart = null;
  let browserARFrameReady = false;
  let browserARIsLoaded = false;
  let browserARShouldStart = false;
  let browserARSplashStartedAt = 0;
  let browserARSplashTimer;

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

  /* Safari caches a motion refusal for the origin and will not ask again --
     not on reload, not on a new tab. Only clearing the site's data or quitting
     Safari resets it. So a refusal is not a transient error to retry, it is a
     state the customer has to be walked out of, and the AR frame is told about
     it explicitly rather than being left to fail and guess. */
  let motionBlocked = false;
  const startMessage = () =>
    (motionBlocked ? 'steakout-ar-motion-blocked' : 'steakout-ar-start');

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

  const showBrowserARSplash = () => {
    if (!browserARLoading) return;
    window.clearTimeout(browserARSplashTimer);
    browserARSplashStartedAt = window.performance?.now?.() || Date.now();
    browserARLoading.hidden = false;
    browserARLoading.classList.remove('is-active');
    void browserARLoading.offsetWidth;
    browserARLoading.classList.add('is-active');
  };

  const hideBrowserARSplash = () => {
    if (!browserARLoading) return;
    const now = window.performance?.now?.() || Date.now();
    const remaining = Math.max(0, browserARSplashMinimum - (now - browserARSplashStartedAt));
    window.clearTimeout(browserARSplashTimer);
    browserARSplashTimer = window.setTimeout(() => {
      browserARLoading.hidden = true;
    }, remaining);
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
    showBrowserARSplash();
    loadBrowserAR();

    if (browserARFrameReady) postToBrowserAR(startMessage());
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
    window.clearTimeout(browserARSplashTimer);
    if (browserARLoading) browserARLoading.hidden = true;
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
        postToBrowserAR(startMessage());
      }
    } else if (event.data?.type === 'steakout-ar-camera-live') {
      if (!browserARShouldStart) {
        postToBrowserAR('steakout-ar-stop');
        return;
      }
      hideBrowserARSplash();
      setStatus('AR ACTIVE', 'active');
    } else if (event.data?.type === 'steakout-ar-camera-error') {
      if (!browserARShouldStart) return;
      hideBrowserARSplash();
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
      // The instruction sheet primes the camera permission, so it runs in both modes.
      launchButton.setAttribute('aria-haspopup', 'dialog');
      launchButton.setAttribute('aria-controls', 'ar-guide');
      launchButton.setAttribute('aria-expanded', 'false');
    }

    setStatus(activeMode === 'marker' ? 'QR READY' : '3D READY', 'ready');
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

  /* iOS requires this permission request to originate in the top-level tap,
     not in the iframe reached through postMessage. It is a no-op everywhere
     else and intentionally runs before the AR frame is asked to start. */
  const requestMotionPermissions = () => {
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
    // Not iOS (no requestPermission at all): nothing to grant, carry on.
    if (!requests.length) return Promise.resolve(true);
    return Promise.allSettled(requests).then(
      (results) => results.every((r) => r.status === 'fulfilled' && r.value === 'granted'));
  };

  const launchAR = async () => {
    // The requestPermission() calls must be issued SYNCHRONOUSLY here, while
    // the tap's user gesture is still live -- iOS ignores them otherwise.
    const motionGrant = requestMotionPermissions();
    track('ar_launch_tapped', { mode: activeMode, item: config.itemName || 'test-food' });

    /* ...but the RESULT has to settle before the AR frame is allowed to start.
       Firing this off without awaiting is what produced the engine's own purple
       "AR requires access to device motion sensors" box: 8th Wall calls
       requestPermission() itself, and while our grant is still in flight that
       call throws, which xr.js treats as "retry" and answers by drawing its
       unbranded .prompt-box-8w over our camera. Awaiting means the grant is
       already recorded for this origin by the time the engine asks. */
    motionBlocked = !(await motionGrant);

    // Steak Out AR is always the branded in-page camera. Apple's AR Quick Look
    // and Scene Viewer are never used, whatever mode the dev toggle is on.
    openBrowserAR();
  };

  const closeARGuide = () => {
    if (arGuide?.open) arGuide.close();
  };

  launchButton?.addEventListener('click', () => {
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
