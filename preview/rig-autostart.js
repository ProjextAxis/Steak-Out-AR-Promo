/* RIG MODE: walk straight into the AR view with no taps.
 *
 * WHY
 * ---
 * The test phone is bolted to the gimbal, so nothing on screen can be tapped:
 * not "VIEW IN AR", not the guide's start button. Without this the rig can
 * never reach the AR view at all, and a reload strands it on the landing page.
 *
 * With this, a plain refresh is the whole recovery procedure -- reload and the
 * phone is back in AR, which is exactly what an unattended run needs.
 *
 * Set RIG_AUTO_AR = false to restore the normal tap-through flow before this
 * goes in front of customers. Only /preview/ (staging) carries this file; the
 * customer path at the repo root does not.
 */
(() => {
  const RIG_AUTO_AR = false;

  /* The remote-refresh watcher below is independent of the auto-entry above and
     stays available for debugging, but only when explicitly asked for with
     ?rig=1 -- a customer must never have a page that polls a build marker. */
  const RIG_REMOTE_REFRESH =
    new URLSearchParams(location.search).get('rig') === '1';

  const START_DELAY_MS = 900;    // let config.js/app.js bind their handlers
  const RETRY_EVERY_MS = 2500;   // camera prompts and slow warms need patience
  const MAX_ATTEMPTS = 8;

  const isOpen = () =>
    document.querySelector('#browser-ar-layer')?.classList.contains('is-open') ||
    document.body.classList.contains('browser-ar-open');

  let attempts = 0;

  const attempt = () => {
    if (isOpen()) return true;
    if (attempts++ >= MAX_ATTEMPTS) return true;   // stop trying, leave it alone

    const launch = document.querySelector('#launch-ar-top');
    const guide = document.querySelector('#ar-guide');
    const guideStart = document.querySelector('#ar-guide-start');

    // The customer path is: tap VIEW IN AR -> guide modal -> tap START.
    // Drive that same path rather than reaching past it, so anything the app
    // does on the way (analytics, warm-up, status) still happens normally.
    if (guide?.open && guideStart) {
      guideStart.click();
    } else if (launch) {
      launch.click();
      // The modal opens synchronously, so its start button is clickable now.
      window.setTimeout(() => {
        if (!isOpen() && document.querySelector('#ar-guide')?.open) {
          document.querySelector('#ar-guide-start')?.click();
        }
      }, 120);
    }
    return false;
  };

  const begin = () => {
    window.setTimeout(function tick() {
      if (attempt()) return;
      window.setTimeout(tick, RETRY_EVERY_MS);
    }, START_DELAY_MS);
  };

  if (RIG_AUTO_AR) {
    if (document.readyState === 'complete') begin();
    else window.addEventListener('load', begin, { once: true });
  }

  /* ------------------------------------------------------------------
   * Remote refresh, without touching the phone.
   *
   * The phone is mirrored to the Mac for viewing only -- that link carries no
   * input, so a deployed change could not be picked up without a human tapping
   * reload. Instead the page watches its own build marker and reloads when it
   * changes, which makes "deploy" and "refresh the phone" the same action.
   *
   * The first poll establishes the baseline rather than trusting a stamp
   * compiled into the HTML, so this cannot reload-loop on a stale cache.
   * ------------------------------------------------------------------ */
  const POLL_MS = 8000;
  let build = null;

  const poll = async () => {
    try {
      const r = await fetch('./rig-version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const next = (await r.json()).build;
      if (!next) return;
      if (build === null) { build = next; return; }   // baseline
      if (next !== build) location.reload();
    } catch (e) { /* offline or mid-deploy: just try again next tick */ }
  };

  if (RIG_REMOTE_REFRESH) {
    poll();
    window.setInterval(poll, POLL_MS);
  }
})();
