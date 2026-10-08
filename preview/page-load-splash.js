(() => {
  const splash = document.querySelector('#ar-splash');
  if (!splash) return;

  const logo = splash.querySelector('img');
  const MIN_MS = 700;
  const MAX_MS = 9000;
  // The logo's entrance and pulse are CSS now (page-load-splash.css), started by
  // the img's own onload in the markup. They used to be scripted here, armed off
  // timers that a busy main thread let fire back to back: the pulse replaced the
  // entrance in the same frame and the logo popped in without its spin.
  // This file no longer starts, stops or replaces any animation. It builds the
  // loading line and decides when the splash may leave.
  //
  // Backstops for an animation that never reports finishing. They only allow
  // the exit; they cannot cut anything short that is still on screen.
  const LOGO_BACKSTOP_MS = 1500;
  const ANIMATION_BACKSTOP_MS = 1600;
  const AR_FRAME_GRACE_MS = 600;
  const started = performance.now();

  let modelReady = false;
  let arFrameReady = false;
  let entranceDone = false;
  let lineDone = false;
  let finished = false;
  let dotTimer;
  let dotCount = 0;

  splash.classList.add('is-page-load', 'is-active');
  splash.classList.remove('is-entering', 'is-page-load-exit');
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

  // The CSS animations with these names running inside the splash.
  // document.getAnimations() flushes style first, so animations a class change
  // has only just triggered are already in the list.
  const splashAnimations = (names) => document.getAnimations().filter((a) =>
    names.includes(a.animationName) && splash.contains(a.effect?.target));

  const whenFinished = (animations, done) => {
    let called = false;
    const once = () => { if (!called) { called = true; done(); } };
    Promise.all(animations.map((a) => a.finished.catch(() => {}))).then(once);
    window.setTimeout(once, ANIMATION_BACKSTOP_MS);
  };

  // Normally the markup's onload has already set is-logo-ready and the entrance
  // is in flight (or done) by the time this deferred file runs. Setting it here
  // too covers a logo that loaded before the attribute could see it, or never.
  let watchingEntrance = false;
  const watchEntrance = () => {
    if (watchingEntrance) return;
    watchingEntrance = true;
    splash.classList.add('is-logo-ready');
    whenFinished(splashAnimations(['pageLoadLogoIn']), () => { entranceDone = true; maybeFinish(); });
  };
  if (!logo || logo.complete || splash.classList.contains('is-logo-ready')) watchEntrance();
  else {
    logo.addEventListener('load', watchEntrance, { once: true });
    logo.addEventListener('error', watchEntrance, { once: true });
    window.setTimeout(watchEntrance, LOGO_BACKSTOP_MS);
  }

  // The loading line runs alongside the logo, and the splash holds until it has
  // landed -- a fast load used to cut it off mid-flight.
  splash.classList.add('is-waiting');
  startDots();
  whenFinished(splashAnimations(['statusCharIn', 'statusCharInAlt', 'statusDotsIn']), () => {
    lineDone = true;
    maybeFinish();
  });

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
    if (!force && !(entranceDone && lineDone)) return;
    finished = true;
    window.clearInterval(dotTimer);
    splash.classList.add('is-page-load-exit');

    // Belt and braces. Guarding the code paths that could re-show the splash
    // was not enough -- it still flashed back over the rendered page for four
    // frames. So stop relying on knowing WHICH path does it.
    //
    // An inline style beats any stylesheet rule, any class, and any CSS
    // animation, including ones marked !important. Once the fade is done the
    // element is made unable to paint at all, BEFORE it is detached, so there
    // is no window in which a stray class or a late animation can bring it
    // back. Removal then just tidies up.
    const kill = () => {
      splash.style.setProperty('animation', 'none', 'important');
      splash.style.setProperty('opacity', '0', 'important');
      splash.style.setProperty('visibility', 'hidden', 'important');
      splash.style.setProperty('display', 'none', 'important');
      splash.style.setProperty('pointer-events', 'none', 'important');
      splash.classList.remove('is-active', 'is-page-load', 'is-waiting', 'is-page-load-exit', 'is-logo-ready');
      splash.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('is-preloading-ar');
      splash.remove();
    };

    // Prefer the animation's own end over a hand-tuned timeout: a timeout that
    // is even slightly short kills it mid-fade, and one that is long leaves the
    // element alive with nothing holding it invisible.
    let killed = false;
    const once = () => { if (!killed) { killed = true; kill(); } };
    // Only the splash's own exit counts. animationend bubbles, and a letter or
    // dot finishing on the exit's first frame used to remove the splash 17ms in.
    const onExitEnd = (event) => {
      if (event.target !== splash || event.animationName !== 'pageLoadSplashExit') return;
      splash.removeEventListener('animationend', onExitEnd);
      once();
    };
    splash.addEventListener('animationend', onExitEnd);
    window.setTimeout(once, 600);   // fallback if the animation never fires
  };

  function maybeFinish() {
    if (finished || !entranceDone || !lineDone) return;
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
