(() => {
  // The branded AR flow shows its own loading state, and the full-page splash
  // belongs to first page load only. Never replay either when AR launches.
  const style = document.createElement('style');
  style.textContent = `
    .browser-ar-loading { display: none !important; }
    #ar-splash.is-active:not(.is-page-load) { display: none !important; }
  `;
  document.head.appendChild(style);

  const pageSplash = document.querySelector('#ar-splash');
  if (!pageSplash || pageSplash.classList.contains('is-page-load')) return;
  pageSplash.classList.remove('is-active', 'is-waiting', 'is-page-load-exit');
  pageSplash.setAttribute('aria-hidden', 'true');
})();
