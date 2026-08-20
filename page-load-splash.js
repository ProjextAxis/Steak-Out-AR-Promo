(() => {
  const splash = document.querySelector('#ar-splash');
  if (!splash) return;

  const logo = splash.querySelector('img');
  const MIN_MS = 5200;
  const MAX_MS = 14000;
  const FOCUS_SETTLE_MS = 650;
  const ENTRANCE_MS = 3200;
  const PULSE_MS = 6200;
  // In-app WebViews often never report focus. Without these the entrance never
  // starts, and every exit path below waits on it.
  const ENTRANCE_FALLBACK_MS = 2600;
  const AR_FRAME_GRACE_MS = 4200;
  const started = performance.now();

  let modelReady = false;
  let arFrameReady = false;
  let entranceDone = false;
  let finished = false;
  let dotTimer;
  let dotCount = 0;
  let entranceAnimation;
  let pulseAnimation;
  let entranceScheduled = false;
  let focusTimer;
  let cleanLogoUrl;

  splash.classList.add('is-page-load', 'is-active');
  splash.classList.remove('is-entering', 'is-waiting', 'is-page-load-exit');
  splash.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('is-preloading-ar');

  const loadingText = splash.querySelector('span');
  if (loadingText) {
    loadingText.className = 'page-load-status';
    loadingText.innerHTML = '<span class="page-load-status__word">LOADING EXPERIENCE</span><span class="page-load-status__dots" aria-hidden="true">.</span>';
  }
  const dots = splash.querySelector('.page-load-status__dots');

  const startDots = () => {
    if (dotTimer || !dots) return;
    dotTimer = window.setInterval(() => {
      dotCount = (dotCount % 3) + 1;
      dots.textContent = '.'.repeat(dotCount);
    }, 700);
  };

  const prepareTransparentSvg = async () => {
    if (!logo) return;
    try {
      const response = await fetch('./assets/STEAK%20OUT%20LOGO.svg', { cache: 'force-cache' });
      if (!response.ok) throw new Error('SVG load failed');
      let svg = await response.text();
      svg = svg.replace(/<path\b[^>]*fill=["']#ffffff["'][^>]*\/>/i, '');
      cleanLogoUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      await new Promise((resolve) => {
        const done = () => resolve();
        logo.addEventListener('load', done, { once: true });
        logo.addEventListener('error', done, { once: true });
        logo.src = cleanLogoUrl;
      });
    } catch (error) {
      console.warn('Using fallback splash logo:', error);
      logo.src = './assets/steakout-logo.webp';
    }
  };

  const startPulse = () => {
    if (!logo || finished) return;
    splash.classList.add('is-waiting');
    startDots();
    pulseAnimation = logo.animate([
      { transform: 'translateY(0) rotate(0deg) scale(.98)', opacity: 1, filter: 'drop-shadow(0 0 0 rgba(186,31,44,0))' },
      { transform: 'translateY(0) rotate(0deg) scale(1.14)', opacity: .9, filter: 'drop-shadow(0 0 40px rgba(186,31,44,.46))', offset: .5 },
      { transform: 'translateY(0) rotate(0deg) scale(.98)', opacity: 1, filter: 'drop-shadow(0 0 0 rgba(186,31,44,0))' }
    ], { duration: PULSE_MS, easing: 'ease-in-out', iterations: Infinity });
  };

  const startEntrance = () => {
    if (!logo || finished || entranceAnimation) return;
    entranceAnimation = logo.animate([
      { transform: 'translateY(108vh) rotate(-220deg) scale(.28)', opacity: .08 },
      { transform: 'translateY(82vh) rotate(-175deg) scale(.38)', opacity: .42, offset: .16 },
      { transform: 'translateY(54vh) rotate(-118deg) scale(.52)', opacity: .7, offset: .34 },
      { transform: 'translateY(30vh) rotate(-66deg) scale(.68)', opacity: .9, offset: .52 },
      { transform: 'translateY(12vh) rotate(-24deg) scale(.84)', opacity: 1, offset: .68 },
      { transform: 'translateY(2vh) rotate(-5deg) scale(.96)', opacity: 1, offset: .8 },
      { transform: 'translateY(0) rotate(3deg) scale(1.04)', opacity: 1, offset: .88 },
      { transform: 'translateY(0) rotate(-1deg) scale(.99)', opacity: 1, offset: .95 },
      { transform: 'translateY(0) rotate(0deg) scale(1)', opacity: 1 }
    ], { duration: ENTRANCE_MS, easing: 'cubic-bezier(.16,.72,.18,1)', fill: 'forwards' });

    entranceAnimation.finished.then(() => {
      entranceDone = true;
      startPulse();
      maybeFinish();
    }).catch(() => {});
  };

  const pageIsActuallyForeground = () =>
    document.visibilityState === 'visible' && document.hasFocus();

  const scheduleEntranceOnRealFocus = () => {
    if (finished || entranceAnimation || entranceScheduled || !pageIsActuallyForeground()) return;
    entranceScheduled = true;
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      if (!pageIsActuallyForeground()) {
        entranceScheduled = false;
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(startEntrance));
    }, FOCUS_SETTLE_MS);
  };

  const waitForFocus = () => {
    scheduleEntranceOnRealFocus();
    if (!entranceAnimation && !finished) window.setTimeout(waitForFocus, 120);
  };

  window.addEventListener('focus', scheduleEntranceOnRealFocus);
  window.addEventListener('pageshow', scheduleEntranceOnRealFocus);
  document.addEventListener('visibilitychange', scheduleEntranceOnRealFocus);

  prepareTransparentSvg().finally(() => waitForFocus());

  window.setTimeout(() => {
    if (!entranceAnimation && !finished) startEntrance();
  }, ENTRANCE_FALLBACK_MS);

  // The AR frame is only a warm-up; it must never hold the splash open.
  window.setTimeout(() => {
    if (arFrameReady) return;
    arFrameReady = true;
    maybeFinish();
  }, AR_FRAME_GRACE_MS);

  const viewer = document.querySelector('#meal-viewer');
  if (viewer) {
    if (viewer.loaded) modelReady = true;
    viewer.addEventListener('load', () => { modelReady = true; maybeFinish(); }, { once: true });
    viewer.addEventListener('error', () => { modelReady = true; maybeFinish(); }, { once: true });
  } else {
    modelReady = true;
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'steakout-ar-ready') {
      arFrameReady = true;
      maybeFinish();
    }
  });

  const finish = (force) => {
    if (finished) return;
    if (!force && !entranceDone) return;
    finished = true;
    window.clearInterval(dotTimer);
    window.clearTimeout(focusTimer);
    pulseAnimation?.cancel();
    splash.classList.add('is-page-load-exit');
    window.setTimeout(() => {
      splash.classList.remove('is-active', 'is-page-load', 'is-waiting', 'is-page-load-exit');
      splash.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('is-preloading-ar');
      if (cleanLogoUrl) URL.revokeObjectURL(cleanLogoUrl);
    }, 820);
  };

  function maybeFinish() {
    if (finished || !entranceDone) return;
    const elapsed = performance.now() - started;
    if (elapsed < MIN_MS) {
      window.setTimeout(maybeFinish, MIN_MS - elapsed);
      return;
    }
    if (modelReady && arFrameReady) finish();
  }

  // Unconditional. Whatever stalled, the page must become usable.
  window.setTimeout(() => finish(true), MAX_MS);
})();
