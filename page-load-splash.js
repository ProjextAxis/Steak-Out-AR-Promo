(() => {
  const splash = document.querySelector('#ar-splash');
  if (!splash) return;

  const MIN_MS = 2400;
  const MAX_MS = 8000;
  const PULSE_START_MS = 1550;
  const started = performance.now();
  let modelReady = false;
  let arFrameReady = false;
  let finished = false;
  let dotTimer;
  let dotCount = 0;

  // This is a page-load/preload splash only. Camera permission remains tied to VIEW IN AR.
  splash.classList.add('is-page-load', 'is-active');
  splash.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('is-preloading-ar');

  const loadingText = splash.querySelector('span');
  if (loadingText) {
    loadingText.className = 'page-load-status';
    loadingText.innerHTML = '<span class="page-load-status__word">LOADING</span><span class="page-load-status__dots" aria-hidden="true">.</span>';
  }

  const dots = splash.querySelector('.page-load-status__dots');

  const startWaitingPulse = () => {
    if (finished) return;
    splash.classList.add('is-waiting');
    if (dotTimer || !dots) return;
    dotTimer = window.setInterval(() => {
      dotCount = (dotCount % 3) + 1;
      dots.textContent = '.'.repeat(dotCount);
    }, 430);
  };

  window.setTimeout(startWaitingPulse, PULSE_START_MS);

  const viewer = document.querySelector('#meal-viewer');
  if (viewer) {
    if (viewer.loaded) modelReady = true;
    viewer.addEventListener('load', () => {
      modelReady = true;
      maybeFinish();
    }, { once: true });
    viewer.addEventListener('error', () => {
      // Do not trap the customer on the splash if the preview fails.
      modelReady = true;
      maybeFinish();
    }, { once: true });
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

  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearInterval(dotTimer);
    splash.classList.add('is-page-load-exit');
    window.setTimeout(() => {
      splash.classList.remove('is-active', 'is-page-load', 'is-waiting', 'is-page-load-exit');
      splash.setAttribute('aria-hidden', 'true');
      document.documentElement.classList.remove('is-preloading-ar');
    }, 650);
  };

  function maybeFinish() {
    if (finished) return;
    const elapsed = performance.now() - started;
    if (elapsed < MIN_MS) {
      window.setTimeout(maybeFinish, MIN_MS - elapsed);
      return;
    }
    // Prefer both assets ready, but never hold the page indefinitely.
    if (modelReady && arFrameReady) finish();
  }

  window.setTimeout(finish, MAX_MS);
})();
