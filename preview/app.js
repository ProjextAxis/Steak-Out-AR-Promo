(() => {
  /* ------------------------------------------------------------------
   * Visit identity: which flyer sent them, and one id to stitch the visit.
   *
   * `c` only ever appears on the FIRST url (?c=window, ?c=table). Every step
   * after that is a tap inside this document or a hop into the AR iframe, so
   * it has to be captured on arrival and carried, or it is gone by the time
   * anything worth measuring happens.
   *
   * sessionStorage on purpose: it dies with the tab. A cookie or localStorage
   * would outlive the visit and start identifying a PERSON across visits,
   * which is not what this measures and not something a lunch promo should be
   * doing. Two keys, no personal data, nothing that survives the tab closing.
   *
   * Every accessor is wrapped: Safari private mode THROWS on sessionStorage
   * rather than returning null, and measurement must never break the meal.
   * ------------------------------------------------------------------ */
  const SESSION_KEY = 'steakout.session';
  const SOURCE_KEY = 'steakout.source';

  const readStore = (key) => {
    try { return window.sessionStorage.getItem(key); } catch (error) { return null; }
  };
  const writeStore = (key, value) => {
    try { window.sessionStorage.setItem(key, value); } catch (error) { /* private mode */ }
  };

  const newSessionId = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (error) { /* fall through to the manual id */ }
    // randomUUID needs a secure context AND Safari 15.4+. Neither is
    // guaranteed on a diner's phone, and an unstitched visit is worse than an
    // ugly id.
    return 'sx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  const session = (() => {
    const existing = readStore(SESSION_KEY);
    if (existing) return existing;
    const fresh = newSessionId();
    writeStore(SESSION_KEY, fresh);
    return fresh;
  })();

  const source = (() => {
    // A `c` on the url always wins and is remembered for the rest of the tab.
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl) { writeStore(SOURCE_KEY, fromUrl); return fromUrl; }
    return readStore(SOURCE_KEY) || 'direct';
  })();

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

  if (!config.showModeToggle && modeToggle) modeToggle.hidden = true;

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  /* Where events go once there is somewhere to send them.
   *
   * Deliberately EMPTY. sendBeacon is skipped entirely while it is, so this
   * whole path ships and is verifiable today against window.dataLayer, and
   * starts reporting the moment this one string is filled in -- no other
   * change, no redeploy of the AR itself.
   *
   * sendBeacon rather than fetch: it never blocks the main thread, never
   * rejects on a dead host, and is the only send that reliably survives the
   * document being torn down. That last part is the whole reason it is here --
   * order_tapped fires as the tab is already navigating to Toast, which is
   * exactly the case a normal fetch loses. */
  const COLLECTOR_URL = '';

  const track = (eventName, detail = {}) => {
    // dataLayer stays the local, inspectable record -- now stamped with the
    // visit so every entry can be tied to one diner and one flyer.
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: eventName, ...detail, source, session });

    if (!COLLECTOR_URL) return;
    try {
      navigator.sendBeacon?.(COLLECTOR_URL, JSON.stringify({
        name: eventName, source, session, at: Date.now(), meta: detail
      }));
    } catch (error) { /* measurement never breaks the experience */ }
  };

  /* Carry the visit into Toast so an order can be matched back to the flyer
   * that produced it, if Toast ever exposes order data. `c` and the session
   * id only -- nothing that identifies a person. */
  const decorateOrderUrl = (base) => {
    if (!base) return base;
    try {
      const url = new URL(base, location.href);
      url.searchParams.set('c', source);
      url.searchParams.set('s', session);
      return url.toString();
    } catch (error) { return base; }
  };

  /* Order links on the LANDING page. This loop used to sit further up and only
   * set the href; it lives here now because it needs decorateOrderUrl, which
   * needs the session. The in-AR ORDER NOW button is a different element in a
   * different document and is handled over postMessage below. */
  document.querySelectorAll('[data-order-link]').forEach((link) => {
    if (config.orderUrl) link.href = decorateOrderUrl(config.orderUrl);
    link.addEventListener('click', () => track('order_tapped', { from: 'landing' }));
  });

  /* Safari caches a motion refusal for the origin and will not ask again --
     not on reload, not on a new tab. Only clearing the site's data or quitting
     Safari resets it. So a refusal is not a transient error to retry, it is a
     state the customer has to be walked out of, and the AR frame is told about
     it explicitly rather than being left to fail and guess. */
  let motionBlocked = false;
  const startMessage = () =>
    (motionBlocked ? 'steakout-ar-motion-blocked' : 'steakout-ar-start');

  const postToBrowserAR = (type, extra) => {
    if (!browserARFrameReady || !browserARFrame?.contentWindow) return;
    browserARFrame.contentWindow.postMessage({ type, ...extra }, window.location.origin);
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
      /* The AR document owns the ORDER NOW button but not the visit, so hand
         it the decorated url rather than widening the iframe's query-param
         allowlist. That allowlist deliberately strips everything it does not
         recognise, and `c` has no business being a url parameter on a frame a
         customer can see. */
      postToBrowserAR('steakout-ar-order-url', { url: decorateOrderUrl(config.orderUrl) });
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
      track('camera_live');
    } else if (event.data?.type === 'steakout-ar-camera-error') {
      if (!browserARShouldStart) return;
      hideBrowserARSplash();
      setStatus('CAMERA ERROR', 'error');
      track('camera_error');
    } else if (event.data?.type === 'steakout-ar-locked') {
      /* THE success event. "Camera started" only means they got past the
         permission prompt; this means the meal is actually sitting on their
         table. lock -> order_tapped is the number that says whether any of
         this sells a cheesesteak. */
      track('lock');
    } else if (event.data?.type === 'steakout-ar-order-shown') {
      track('order_shown');
    } else if (event.data?.type === 'steakout-ar-order-tapped') {
      track('order_tapped', { from: 'ar' });
    } else if (event.data?.type === 'steakout-ar-close') {
      /* Distinct from browser_ar_closed, which fires for EVERY close including
         Escape and the parent tearing the layer down. This one means the
         customer deliberately left from inside AR. */
      track('ar_closed');
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
    /* Terminal, not transient. Safari caches a motion refusal against the
       ORIGIN -- it will not ask again on reload or in a new tab, only after
       the site's data is cleared or Safari is quit. So this is the end of the
       funnel for that phone, and worth counting as its own outcome rather
       than being buried in the camera errors. */
    if (motionBlocked) track('motion_blocked');

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
      window.setTimeout(loadBrowserAR, 150);   // warm the AR frame sooner
    }
  };

  if (document.readyState === 'complete') warmBrowserAR();
  else window.addEventListener('load', warmBrowserAR, { once: true });

  renderMode();
})();
