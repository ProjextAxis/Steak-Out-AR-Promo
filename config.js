window.STEAKOUT_AR_CONFIG = {
  itemName: 'Cheesesteak Special',
  modelUrl: './assets/cheesesteak-special-ar-optimized.glb',
  iosModelUrl: '',
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
    // Temporary MindAR sample target. Replace both URLs after the final QR ad
    // is designed and compiled to a .mind file.
    targetMindUrl: 'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind',
    targetPreviewUrl: 'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.png',

    modelPosition: '0 0 0.12',
    modelRotation: '90 0 0',
    modelScale: 0.32,
    minScale: 0.08,
    maxScale: 1.25,
    scaleStep: 0.04
  }
};

/* Warm the custom marker AR before the user taps VIEW IN AR.
   This does not request camera permission or start MindAR. It only loads the
   iframe, libraries, and model into the browser cache early. */
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

  const frame = document.querySelector('#browser-ar-frame');
  if (frame?.dataset.src && frame.src === 'about:blank') {
    frame.src = frame.dataset.src;
    frame.dataset.src = '';
  }

  const loading = document.querySelector('#browser-ar-loading');
  const loadingLogo = loading?.querySelector('img');
  if (loadingLogo) loadingLogo.src = './assets/STEAK OUT LOGO.svg';

  const pageSplashLogo = document.querySelector('#ar-splash img');
  if (pageSplashLogo) pageSplashLogo.src = './assets/STEAK OUT LOGO.svg';

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

    @keyframes steakoutOuterSwingUp {
      0% {
        opacity: 0;
        transform: translateY(54vh) rotate(-300deg) scale(.42);
      }
      54% {
        opacity: 1;
        transform: translateY(0) rotate(10deg) scale(1);
      }
      67% {
        transform: translateY(0) rotate(-3deg) scale(1.18);
      }
      78% {
        transform: translateY(0) rotate(0deg) scale(.96);
      }
      88% {
        transform: translateY(0) rotate(0deg) scale(1.04);
      }
      100% {
        opacity: 1;
        transform: translateY(0) rotate(0deg) scale(1);
      }
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
})();
