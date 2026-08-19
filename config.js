window.STEAKOUT_AR_CONFIG = {
  itemName: 'Test Burger',
  modelUrl: 'https://raw.githubusercontent.com/tommykho/tommykho.github.io/main/assets/models/Burger.glb',
  iosModelUrl: '',
  orderUrl: 'https://order.toasttab.com/online/steakout-sewell',
  demoAsset: true,

  social: {
    instagramUrl: 'https://www.instagram.com/steakout.sewell/',
    facebookUrl: 'https://www.facebook.com/SteakOutSewellNJ/'
  },

  // Prototype controls. Set showModeToggle to false for the customer launch.
  defaultMode: 'free',
  showModeToggle: true,

  freePlace: {
    // "auto" lets us pinch/resize while testing. Change to "fixed" once the
    // final Steak Out meal is authored at real-world dimensions.
    arScale: 'auto'
  },

  marker: {
    enabled: true,
    // Temporary MindAR sample target. Replace both URLs after the final QR ad
    // is designed and compiled to a .mind file.
    targetMindUrl: 'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind',
    targetPreviewUrl: 'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.png',

    // A-Frame/MindAR transforms for the temporary food model.
    modelPosition: '0 0 0.12',
    modelRotation: '90 0 0',
    modelScale: 0.32,
    minScale: 0.08,
    maxScale: 1.25,
    scaleStep: 0.04
  }
};
