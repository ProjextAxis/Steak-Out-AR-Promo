/*
 * The scan guide is deliberately visual, rather than a promise about a
 * tracker-private search crop. 8th Wall scans the configured image target, so
 * a stable centre guide is more honest and preserves the customer-facing UI.
 */
(() => {
  const ID = 'ar-reticle';

  const build = () => {
    if (document.getElementById(ID) || !document.querySelector('#marker-scene')) return;

    const box = document.createElement('div');
    box.id = ID;
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<span></span><span></span><span></span><span></span>' +
      '<b>PUT THE FLYER IN HERE</b>';
    document.body.appendChild(box);

    const sizeIt = () => {
      // Preserve the familiar compact square guide while keeping its corners
      // inside every supported phone viewport.
      const edge = Math.round(Math.min(window.innerWidth * 0.475, window.innerHeight * 0.34, 280));
      box.style.width = Math.max(150, edge) + 'px';
      box.style.height = Math.max(150, edge) + 'px';
    };
    sizeIt();
    window.addEventListener('resize', sizeIt);

    // marker.js emits these compatibility events from public XR8 image events.
    // After the meal locks it intentionally leaves the guide hidden, even if
    // the flyer moves out of frame.
    const anchor = document.querySelector('#marker-anchor');
    anchor?.addEventListener('targetFound', () => box.classList.add('is-locked'));
    anchor?.addEventListener('targetLost', () => box.classList.remove('is-locked'));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
