# Steak Out AR Promo

Mobile-first augmented-reality promotional microsite for Steak Out Sewell.

## Prototype status

The current build is intentionally set up with **two AR modes** so development can continue before the final printed QR/table ad exists.

### 1. Free Place

Works without a printed marker.

- Uses Google's open-source `<model-viewer>`.
- Launches WebXR where available with Android Scene Viewer / iOS Quick Look fallbacks.
- Finds a horizontal surface and lets the tester place the food model in the room.
- Prototype uses `ar-scale="auto"` so the tester can pinch/resize the temporary model.
- Final Steak Out meal should be authored at correct real-world dimensions and switched to fixed scale.

### 2. QR Lock

Image-target tracking for the final under-glass Steak Out table promotion.

- Uses MindAR image tracking + A-Frame.
- Tracks a compiled `.mind` target and keeps the 3D object attached to that physical image.
- Includes temporary on-screen +/- scale controls while we tune the food model.
- Currently uses MindAR's sample tracking card so marker mode can be tested before the final artwork is designed.
- Once the actual Steak Out QR/table graphic is approved, compile that art with MindAR's target compiler and replace the marker target.

## Temporary food model

`config.js` currently points to a temporary burger GLB hosted in a public GitHub project. It is for internal prototype testing only and must be replaced before launch with the real Steak Out food model.

## Main configuration

Edit `config.js`:

```js
window.STEAKOUT_AR_CONFIG = {
  itemName: 'Test Burger',
  modelUrl: 'YOUR_GLTF_OR_GLB_URL',
  iosModelUrl: '',
  orderUrl: 'YOUR_TOAST_URL',
  defaultMode: 'free',
  showModeToggle: true,
  freePlace: {
    arScale: 'auto'
  },
  marker: {
    enabled: true,
    targetMindUrl: 'YOUR_COMPILED_TARGET.mind',
    targetPreviewUrl: 'YOUR_PRINTED_TARGET_IMAGE.png',
    modelPosition: '0 0 0.12',
    modelRotation: '90 0 0',
    modelScale: 0.32
  }
};
```

For the customer-facing launch, set `showModeToggle: false` and choose the intended default experience.

## Test pages

- `/index.html` - main Steak Out AR promo + Free Place mode.
- `/marker.html` - QR Lock / image-tracking camera mode.
- `/test-target.html` - temporary target image to show on another device or print while testing marker mode.

## Phone testing

Camera AR needs HTTPS on a real phone. Deploy the static files to an HTTPS host before testing on iPhone/Android.

Toast is **not required** to test this site. Toast will only link into the deployed microsite after the AR experience is approved.

## Final table workflow

1. Design the Steak Out printed ad with the QR code and distinctive surrounding artwork.
2. QR code opens this AR microsite.
3. Compile the complete printed artwork as a MindAR image target.
4. Put the print below the table glass.
5. Customer scans the QR, camera opens, then points back at the artwork.
6. Steak Out food model locks above the marker and appears to sit on the table glass.
7. CTA sends the customer into Toast ordering.

## AR foundations

- Google `<model-viewer>` for free-placement AR.
- MindAR for image-target/marker tracking.
- A-Frame for the marker-tracked 3D scene.
