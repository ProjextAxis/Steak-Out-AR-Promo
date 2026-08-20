(() => {
  const splash = document.querySelector('#ar-splash');
  if (!splash) return;

  const logo = splash.querySelector('img');
  if (!logo) return;

  // Guarantee Safari paints the logo in its below-screen start state first.
  splash.classList.remove('is-entering', 'is-waiting');
  splash.classList.add('is-sequence-ready');

  const startEntrance = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        splash.classList.add('is-entering');
      });
    });
  };

  const onEntranceEnd = (event) => {
    if (event.target !== logo || event.animationName !== 'pageLoadSteakOutSwingVisible') return;
    logo.removeEventListener('animationend', onEntranceEnd);
    splash.classList.remove('is-entering');
    splash.classList.add('is-waiting');
  };

  logo.addEventListener('animationend', onEntranceEnd);
  startEntrance();
})();
