/* Keep both pages upright.
 *
 * Rotating the device mid-session is genuinely destructive here: the AR camera
 * projection and the canvas are rebuilt, and 8th Wall's tracking has to
 * re-settle -- which looks exactly like the meal coming unstuck.
 *
 * There is no way to actually lock orientation in iOS Safari.
 * screen.orientation.lock() exists but is rejected outside fullscreen, and iOS
 * does not implement it at all. So: TRY the real API for the browsers that have
 * it (Android Chrome), and everywhere else put a gate over the page in
 * landscape. The gate is not decoration -- it stops the customer using the
 * experience in the orientation that breaks it, and tells them why in one line.
 *
 * Loaded by BOTH the landing page and the AR page, because rotating on either
 * one lands you in a broken AR.
 */
(() => {
  const ID = 'steakout-portrait-gate';
  if (document.getElementById(ID)) return;

  // NEVER run inside an iframe. The AR view is an embedded document whose
  // viewport is the iframe's, not the device's -- so a landscape media query
  // can match on an upright phone and paint an opaque panel over the entire AR
  // experience. That is exactly what happened. The top-level page is the only
  // place that can correctly judge device orientation.
  try { if (window.top !== window.self) return; } catch (e) { return; }

  // 1. The real thing, where it exists. Rejection is expected and harmless.
  const tryLock = () => {
    try {
      const o = window.screen && window.screen.orientation;
      if (o && typeof o.lock === 'function') {
        const p = o.lock('portrait');
        if (p && typeof p.catch === 'function') p.catch(() => { /* iOS: expected */ });
      }
    } catch (e) { /* not supported; the gate below covers it */ }
  };

  const style = document.createElement('style');
  style.textContent = `
    #${ID}{
      position:fixed; inset:0; z-index:2147483000; display:none;
      flex-direction:column; align-items:center; justify-content:center; gap:18px;
      background:#0b0b0c; color:#fff; text-align:center; padding:32px;
      font-family:inherit; -webkit-user-select:none; user-select:none;
    }
    #${ID} .pg-icon{
      width:54px; height:86px; border:3px solid #fff; border-radius:10px;
      position:relative; animation:pgTurn 2.4s ease-in-out infinite;
    }
    #${ID} .pg-icon::after{
      content:''; position:absolute; left:50%; bottom:6px; width:18px; height:3px;
      background:#fff; border-radius:2px; transform:translateX(-50%);
    }
    #${ID} h2{
      margin:0; font-size:19px; letter-spacing:.06em; text-transform:uppercase;
    }
    #${ID} p{ margin:0; font-size:15px; opacity:.72; max-width:22em; line-height:1.5 }
    @keyframes pgTurn{
      0%,45%   { transform: rotate(90deg) }
      55%,100% { transform: rotate(0deg) }
    }
    @media (prefers-reduced-motion: reduce){
      #${ID} .pg-icon{ animation:none; transform:rotate(0deg) }
    }
    /* Phones only. A landscape tablet or desktop is a legitimate way to view
       this, and gating those would lock people out for no reason. */
    @media screen and (orientation: landscape) and (max-height: 560px){
      #${ID}{ display:flex }
    }
  `;
  document.head.appendChild(style);

  const gate = document.createElement('div');
  gate.id = ID;
  gate.setAttribute('role', 'alertdialog');
  gate.setAttribute('aria-label', 'Please turn your phone upright');
  gate.innerHTML =
    '<div class="pg-icon" aria-hidden="true"></div>' +
    '<h2>Turn your phone upright</h2>' +
    '<p>Steak Out AR needs a portrait screen to keep your meal locked to the table.</p>';

  const attach = () => {
    if (document.body && !document.getElementById(ID)) document.body.appendChild(gate);
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  tryLock();
  window.addEventListener('orientationchange', tryLock);
})();
