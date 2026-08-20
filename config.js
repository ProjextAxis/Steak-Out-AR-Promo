window.STEAKOUT_AR_CONFIG = {
  itemName: 'Cheesesteak Special',
  modelUrl: './assets/cheesesteak-special-draco.glb',
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
    // Scores 92 tracking / 3999 matching points against the MindAR sample's
    // 62 / 593, so it locks on well.
    targetMindUrl: './assets/steakout-marker.mind',
    targetPreviewUrl: './assets/steakout-marker.png',

    // MindAR normalises the marker to 1 unit wide, so scale is relative to the
    // printed width and needs no physical measurement. The model is 0.3521
    // wide, so 1 / 0.3521 = 2.84 makes the plate exactly as wide as the flyer.
    // 3.0 gives it a slight overhang so it covers the artwork.
    //   2.84 = exactly the flyer's width
    //   4.15 = tall enough to cover the whole portrait flyer
    modelPosition: '0 0 0',
    modelRotation: '90 0 0',
    modelScale: 3.0,
    minScale: 0.08,
    maxScale: 1.25,
    scaleStep: 0.04
  }
};

/* Warm the custom marker AR before the user taps VIEW IN AR.
   This does not request camera permission or start MindAR. */
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
      frame.src = frame.dataset.src;
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
