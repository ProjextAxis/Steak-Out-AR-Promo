window.STEAKOUT_AR_CONFIG = {
  itemName: 'Cheesesteak Special',
  modelUrl: './assets/cheesesteak-special-v2.glb',
  orderUrl: 'https://order.toasttab.com/online/steakout-sewell',
  demoAsset: false,

  social: {
    instagramUrl: 'https://www.instagram.com/steakout.sewell/',
    facebookUrl: 'https://www.facebook.com/SteakOutSewellNJ/'
  },

  // The branded in-browser Steak Out camera experience is the primary flow.
  // FREE PLACE stays available only as a developer/test option.
  defaultMode: 'marker',
  showModeToggle: true,

  freePlace: {
    arScale: 'auto'
  },

  marker: {
    enabled: true,
    // The printed $12 LUNCH MYSTERY flyer, compiled with tools/compile-mind.js.
    //
    // Do not trust a total tracking-point count. mind-ar compiles two tracking
    // levels, at 256px and 128px on the short edge, and tracker.js reads only
    // the second:
    //     const TRACKING_KEYFRAME = 1; // 0: 256px, 1: 128px
    // On that level this target scores 33 points against the MindAR sample
    // card's 32 -- parity, not the comfortable margin a summed count implies.
    // Matching-point counts mislead the same way: they scale with source
    // resolution, because the pyramid builds more levels from a larger image.
    //
    // The practical consequence is that source resolution barely moves
    // tracking, so a better target file is not the lever. What moves it is how
    // much of the camera sensor the flyer physically fills, i.e. print size.
    // Lean build: 7 pyramid levels instead of 11, so 41% cheaper matching per
    // frame and 40% smaller, with 36 points on the 128px keyframe against the
    // full build's 33 and the sample card's 32. Measured as equal on
    // acquisition, so this is a cost saving, not a robustness gain.
    // Overridden below by ?ar=A|B|C|D for the acquisition A/B.
    targetMindUrl: './assets/steakout-marker-lean.mind',
    targetPreviewUrl: './assets/steakout-marker.png',

    // MindAR normalises the marker to 1 unit wide, so scale is relative to the
    // printed width and needs no physical measurement. The model is 0.3521
    // wide, so 1 / 0.3521 = 2.84 makes the plate exactly as wide as the flyer.
    // 3.0 gives it a slight overhang so it covers the artwork.
    // Plate width as a multiple of the flyer's width is 0.3521 * scale:
    //    2.84 -> 1.0x, sits exactly within the flyer
    //    6.00 -> 2.1x
    //    9.00 -> 3.2x, current
    //   12.00 -> 4.2x
    //   17.00 -> 6.0x
    modelPosition: '0 0 0',
    modelRotation: '90 0 0',
    modelScale: 9.0,
    minScale: 0.08,
    maxScale: 1.25,
    scaleStep: 0.04
  }
};

/* Warm the custom marker AR before the user taps VIEW IN AR.
   This does not request camera permission or start MindAR. */
/* Acquisition A/B, switchable from the URL so the same scene can be recorded
 * against each build and the question decided by measurement.
 *
 * These labels previously read "720p" and "1080p" and were INVERTED against
 * what the code did: ar-camera-tune.js stopped capping down to 720p and
 * started asking UP, and only these strings were left behind. Anyone recording
 * ?ar=C believing they were testing 1080p was testing the browser default.
 * The labels now name the two axes that actually vary.
 *
 *   ?ar=A  ask + lean    (current)
 *   ?ar=B  ask + full
 *   ?ar=C  default + lean    <- camera request left untouched: the control
 *   ?ar=D  default + full
 *
 * "ask" means ar-camera-tune.js requests 1080p; "default" means it stands
 * aside and lets the browser choose, which measured 480x640 on device.
 */
(() => {
  const VARIANTS = {
    A: { target: './assets/steakout-marker-lean.mind', label: 'A ask/lean' },
    B: { target: './assets/steakout-marker.mind',      label: 'B ask/full' },
    C: { target: './assets/steakout-marker-lean.mind', label: 'C default/lean' },
    D: { target: './assets/steakout-marker.mind',      label: 'D default/full' }
  };
  const params = new URLSearchParams(location.search);
  const raw = params.get('ar');
  const key = (raw || 'A').toUpperCase();
  const variant = VARIANTS[key] || VARIANTS.A;

  window.STEAKOUT_AR_VARIANT = key in VARIANTS ? key : 'A';
  window.STEAKOUT_AR_CONFIG.marker.targetMindUrl = variant.target;

  /* Label it on screen, or the test is not worth running -- but only when a
   * test is actually being run. This badge was ungated, and since the key
   * defaults to 'A' it shipped a yellow debug tag in the AR header to every
   * customer, reading a resolution the build no longer used. */
  const isTest = !!raw || params.get('xray') === '1';
  const badge = () => {
    const host = document.querySelector('.marker-brand');
    if (!host || host.querySelector('[data-ar-variant-badge]')) return;
    const tag = document.createElement('span');
    tag.setAttribute('data-ar-variant-badge', '');
    tag.textContent = ' \u00b7 ' + variant.label;
    tag.style.cssText = 'font:600 11px/1 Arial,sans-serif;color:#ffd34d;letter-spacing:.04em';
    host.appendChild(tag);
  };
  if (!isTest) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', badge);
  else badge();
})();

(() => {
  const modelUrl = window.STEAKOUT_AR_CONFIG.modelUrl;

  if (modelUrl && !document.querySelector('link[data-steakout-model-preload]')) {
    const preload = document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'fetch';
    preload.href = modelUrl;
    preload.crossOrigin = 'anonymous';
    preload.setAttribute('data-steakout-model-preload', '');
    document.head.appendChild(preload);
  }

  // Let app.js attach its iframe message listener first, then warm the AR frame.
  window.setTimeout(() => {
    const frame = document.querySelector('#browser-ar-frame');
    if (frame?.dataset.src && frame.src === 'about:blank') {
      const v = window.STEAKOUT_AR_VARIANT || 'A';
      const xray = new URLSearchParams(location.search).get('xray') === '1' ? '&xray=1' : '';
      frame.src = frame.dataset.src + (frame.dataset.src.indexOf('?') === -1 ? '?' : '&') + 'ar=' + v + xray;
      frame.dataset.src = '';
    }
  }, 0);

  /* The uploaded SVG contains a full-canvas white path as its first path.
     Strip only that background path in memory so the original source asset
     remains untouched and the splash gets a true transparent logo. */
  const installTransparentSplashLogo = async () => {
    try {
      const response = await fetch('./assets/STEAK OUT LOGO.svg', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`SVG ${response.status}`);
      const source = await response.text();
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      const svg = doc.documentElement;
      const firstPath = svg.querySelector('path');
      const fill = firstPath?.getAttribute('fill')?.toLowerCase();
      const pathData = firstPath?.getAttribute('d') || '';

      if ((fill === '#ffffff' || fill === '#fff' || fill === 'white') && /^M\s*0(?:\.0+)?\s+0(?:\.0+)?/i.test(pathData)) {
        firstPath.remove();
      }

      svg.removeAttribute('width');
      svg.removeAttribute('height');
      const cleaned = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(new Blob([cleaned], { type: 'image/svg+xml' }));

      document.querySelectorAll('#browser-ar-loading img, #ar-splash img').forEach((img) => {
        img.src = url;
      });
    } catch (error) {
      console.warn('Could not clean Steak Out SVG splash:', error);
    }
  };

  // Single owner of the logo swap. page-load-splash.js waits on this instead of
  // repeating the work, so nothing reassigns the src mid-animation.
  window.STEAKOUT_LOGO_READY = installTransparentSplashLogo();

  const style = document.createElement('style');
  style.textContent = `
    #browser-ar-loading img {
      width: min(58vw, 300px) !important;
      max-height: 34vh;
      object-fit: contain;
      transform-origin: 50% 58%;
    }

    #browser-ar-loading.is-active img {
      animation: steakoutOuterSwingUp 1.25s cubic-bezier(.18,.86,.22,1) both !important;
    }

    #browser-ar-loading.is-active span {
      animation: steakoutOuterWord 1.05s .42s ease both !important;
    }

    #meal-viewer {
      opacity: 1 !important;
      visibility: visible !important;
    }

    @keyframes steakoutOuterSwingUp {
      0% { opacity: 0; transform: translateY(54vh) rotate(-300deg) scale(.42); }
      54% { opacity: 1; transform: translateY(0) rotate(10deg) scale(1); }
      67% { transform: translateY(0) rotate(-3deg) scale(1.18); }
      78% { transform: translateY(0) rotate(0deg) scale(.96); }
      88% { transform: translateY(0) rotate(0deg) scale(1.04); }
      100% { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
    }

    @keyframes steakoutOuterWord {
      0%, 25% { opacity: 0; transform: translateY(12px); }
      100% { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);

  const forceARReady = () => {
    const status = document.querySelector('#ar-status');
    if (status && status.textContent.trim() === 'QR READY') status.textContent = 'AR READY';
  };

  forceARReady();
  const status = document.querySelector('#ar-status');
  if (status) {
    new MutationObserver(forceARReady).observe(status, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  /* Safari was leaving model-viewer's first rendered frame behind its reveal
     layer until the viewer received a touch. Explicitly dismiss the reveal
     layer and kick the camera renderer as soon as the GLB is actually loaded. */
  const installModelRevealFix = async () => {
    if (!window.customElements) return;
    try {
      await customElements.whenDefined('model-viewer');
    } catch (_) {
      return;
    }

    const viewer = document.querySelector('#meal-viewer');
    if (!viewer) return;

    viewer.setAttribute('reveal', 'auto');
    viewer.setAttribute('interaction-prompt', 'none');

    const reveal = () => {
      try { viewer.dismissPoster?.(); } catch (_) {}
      try { viewer.jumpCameraToGoal?.(); } catch (_) {}
      viewer.style.opacity = '1';
      viewer.style.visibility = 'visible';

      // Toggling auto-rotate for one frame forces Safari/WebGL to paint the
      // first canvas frame without requiring a user tap.
      const hadAutoRotate = viewer.hasAttribute('auto-rotate');
      viewer.removeAttribute('auto-rotate');
      requestAnimationFrame(() => {
        if (hadAutoRotate) viewer.setAttribute('auto-rotate', '');
      });
    };

    viewer.addEventListener('load', reveal);
    if (viewer.loaded) reveal();
  };

  installModelRevealFix();
})();
