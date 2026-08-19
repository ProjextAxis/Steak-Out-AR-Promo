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