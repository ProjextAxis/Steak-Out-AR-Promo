(() => {
  const viewer = document.querySelector('#meal-viewer');
  const launchButton = document.querySelector('#launch-ar-top');
  const guide = document.querySelector('#ar-guide');
  const guideStart = document.querySelector('#ar-guide-start');
  const pageSplash = document.querySelector('#ar-splash');

  // The branded animation is only for the first page load.
  // Never show either splash layer when the user launches AR.
  const style = document.createElement('style');
  style.textContent = `
    .browser-ar-loading { display: none !important; }
    #ar-splash.is-active:not(.is-page-load) { display: none !important; }
  `;
  document.head.appendChild(style);

  const clearLaunchSplash = () => {
    if (!pageSplash || pageSplash.classList.contains('is-page-load')) return;
    pageSplash.classList.remove('is-active', 'is-waiting', 'is-page-load-exit');
    pageSplash.setAttribute('aria-hidden', 'true');
  };

  const activateARImmediately = async () => {
    clearLaunchSplash();

    if (guide?.open) guide.close();
    launchButton?.setAttribute('aria-expanded', 'false');

    try {
      if (!viewer || typeof viewer.activateAR !== 'function') {
        throw new Error('AR unavailable');
      }
      await viewer.activateAR();
    } catch (error) {
      console.warn('AR launch failed:', error);
      viewer?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // Marker mode hands off to the in-page camera flow in app.js, which shows no
  // splash of its own. Only free placement needs the splash suppressed here.
  const currentMode = () =>
    document.querySelector('[data-ar-mode].is-active')?.dataset.arMode || 'free';

  // Stop app.js from replaying the full-page splash after the instruction sheet.
  guideStart?.addEventListener('click', (event) => {
    if (currentMode() === 'marker') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    activateARImmediately();
  }, true);

  // Fallback for browsers without <dialog> support: launch directly with no replayed splash.
  launchButton?.addEventListener('click', (event) => {
    if (currentMode() === 'marker') return;
    if (guide && typeof guide.showModal === 'function') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    activateARImmediately();
  }, true);
})();
