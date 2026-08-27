(() => {
  const splash = document.querySelector('#ar-splash');
  if (!splash) return;

  const logo = splash.querySelector('img');
  const MIN_MS = 700;
  const MAX_MS = 9000;
  const FOCUS_SETTLE_MS = 220;
  const ENTRANCE_MS = 700;
  const PULSE_MS = 6200;
  // In-app WebViews often never report focus. Without these the entrance never
  // starts, and every exit path below waits on it.
  const ENTRANCE_FALLBACK_MS = 300;
  const AR_FRAME_GRACE_MS = 600;
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

  splash.classList.add('is-page-load', 'is-active');
  splash.classList.remove('is-entering', 'is-waiting', 'is-page-load-exit');
  splash.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('is-preloading-ar');

  const loadingText = splash.querySelector('span');
  if (loadingText) {
    loadingText.className = 'page-load-status';
    loadingText.innerHTML = '<span class="page-load-status__word">LOADING EXPERIENCE</span><span class="page-load-status__dots" aria-hidden="true">.</span>';
  }
  // Split into per-letter spans so they can stagger up from below. The letters
  // are decorative once split, so the word keeps the readable label.
  const wordEl = splash.querySelector('.page-load-status__word');
  if (wordEl) {
    const label = wordEl.textContent;
    wordEl.setAttribute('aria-label', label);
    wordEl.innerHTML = label
      .split('')
      .map((ch, i) => '<span class="page-load-status__ch" aria-hidden="true" style="--i:' + i + '">'
        + (ch === ' ' ? '&nbsp;' : ch) + '</span>')
      .join('');
  }

  const dots = splash.querySelector('.page-load-status__dots');

  const startDots = () => {
    if (dotTimer || !dots) return;
    dotTimer = window.setInterval(() => {
      dotCount = (dotCount % 3) + 1;
      dots.textContent = '.'.repeat(dotCount);
    }, 700);
  };

  const startPulse = () => {
    if (!logo || finished || pulseAnimation) return;
    splash.classList.add('is-waiting');
    startDots();
    pulseAnimation = logo.animate([
      { transform: 'translateY(0) rotate(0deg) scale(.98)', opacity: 1, filter: 'drop-shadow(0 0 0 rgba(186,31,44,0))' },
      { transform: 'translateY(0) rotate(0deg) scale(1.14)', opacity: .9, filter: 'drop-shadow(0 0 40px rgba(186,31,44,.46))', offset: .5 },
      { transform: 'translateY(0) rotate(0deg) scale(.98)', opacity: 1, filter: 'drop-shadow(0 0 0 rgba(186,31,44,0))' }
    ], { duration: PULSE_MS, easing: 'ease-in-out', iterations: Infinity });
  };

  const startEntrance = () => {
    // Once finish() has run the splash is on its way out (or already gone).
    // Replaying the entrance here puts the logo back at full opacity ON TOP of
    // the rendered page -- the 4-frame flash. clearTimeout in finish() cannot
    // prevent this on its own, because a timer that has ALREADY fired is by
    // then sitting in the double-rAF below and is no longer cancellable.
    if (finished) return;
    if (!logo || finished || entranceAnimation) return;

    // Run the loading line with the logo, not after it. The splash is now short
    // enough that waiting for the entrance would cut the letters off.
    splash.classList.add('is-waiting');
    startDots();

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
      if (finished) { entranceScheduled = false; return; }
      requestAnimationFrame(() => {
        if (finished) return;
        requestAnimationFrame(() => { if (!finished) startEntrance(); });
      });
    }, FOCUS_SETTLE_MS);
  };

  const waitForFocus = () => {
    scheduleEntranceOnRealFocus();
    if (!entranceAnimation && !finished) window.setTimeout(waitForFocus, 120);
  };

  window.addEventListener('focus', scheduleEntranceOnRealFocus);
  window.addEventListener('pageshow', scheduleEntranceOnRealFocus);
  document.addEventListener('visibilitychange', scheduleEntranceOnRealFocus);

  // Let the logo settle before animating it, but never let a slow fetch hold
  // the splash open — the markup already ships a usable logo.
  Promise.race([
    window.STEAKOUT_LOGO_READY || Promise.resolve(),
    new Promise((resolve) => window.setTimeout(resolve, 220))
  ]).finally(() => waitForFocus());

  window.setTimeout(() => {
    if (!entranceAnimation && !finished) startEntrance();
  }, ENTRANCE_FALLBACK_MS);

  // A paused document (backgrounded tab, throttled WebView) can leave the
  // entrance promise unresolved forever. Treat the entrance as done on time
  // regardless, so the normal exit runs instead of falling through to MAX_MS.
  window.setTimeout(() => {
    if (entranceDone || finished) return;
    entranceDone = true;
    startPulse();
    maybeFinish();
  }, ENTRANCE_FALLBACK_MS + ENTRANCE_MS + 200);

  // The AR frame is only a warm-up; it must never hold the splash open.
  window.setTimeout(() => {
    if (arFrameReady) return;
    arFrameReady = true;
    maybeFinish();
  }, AR_FRAME_GRACE_MS);

  const viewer = document.querySelector('#meal-viewer');
  if (viewer) {
    if (viewer.loaded) modelReady = true;
    else viewer.classList.add('is-model-pending');
    const revealModel = () => viewer.classList.remove('is-model-pending');
    viewer.addEventListener('load', () => { modelReady = true; revealModel(); maybeFinish(); }, { once: true });
    viewer.addEventListener('error', () => { modelReady = true; revealModel(); maybeFinish(); }, { once: true });
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
    // Detach the schedulers outright. A guard that is merely checked can still
    // be raced; a listener that no longer exists cannot fire at all.
    window.removeEventListener('focus', scheduleEntranceOnRealFocus);
    window.removeEventListener('pageshow', scheduleEntranceOnRealFocus);
    document.removeEventListener('visibilitychange', scheduleEntranceOnRealFocus);
    pulseAnimation?.cancel();
    splash.classList.add('is-page-load-exit');
    window.setTimeout(() => {
      splash.classList.remove('is-active', 'is-page-load', 'is-waiting', 'is-page-load-exit');
      splash.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('is-preloading-ar');
      // Hidden is not enough: it stays a full-screen fixed layer holding the
      // logo, so any stray class or animation can flash it back over the page.
      splash.remove();
    }, 420);   // must stay >= the .38s CSS exit or it snaps away mid-fade
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
