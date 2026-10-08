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

## What the page reports (Orbit Analytics)

The landing page (`preview/`) records what happens on it and can send it to the
Steak Out AR Collector, a small Cloudflare Worker that Orbit reads from. **Nothing
leaves the phone until `collectorUrl` in `preview/config.js` is filled in**; it is
empty in this repo. While it is empty the events are only kept in
`window.dataLayer`, which is how to look at them.

- `preview/app.js` owns the visit (session, `?c=` placement) and the one `track()`
  function that sends an event.
- `preview/tracking.js` watches the landing page: where it is tapped, where a
  mouse rests, how long each page part is on screen, scroll depth, the 3D model
  turned by hand, links that leave, and one cumulative `visit_end` each time the
  page is hidden.
- `preview/marker.js` (the AR frame) reports its own moments to the landing page:
  camera live, lock, lost and found again, and how long the AR was used.
- `preview/tracking-core.js` holds the rules: which events and which keys may
  leave the phone (Orbit's `ORBIT_SITE_EVENTS`), how a tap becomes a position,
  caps (60 taps, 40 hovers, 30 turns, 40 `visit_end`s per tab). It has no browser
  code so it can be tested.
- `data-track` and `data-section` attributes in `index.html` name the elements
  and page parts a tap is filed under. Taps in the AR frame use the same two
  names (`ar_order`, `ar_close`).

Never sent: camera frames, poses, QR text, the user agent, anything typed,
anything personal. The device is a coarse `ios` / `android` / `other`, the screen
size, and whether a mouse can hover. One extra `sessionStorage` key,
`steakout.visit`, holds counters only and dies with the tab.

Checks (plain node, no packages), from the repo root:

```
node preview/tools/test-tracking.js              # rules, the page, the contract
node preview/tools/test-marker-events.js         # the AR frame's messages
node preview/tools/test-static-ar-entry.js
node preview/tools/test-anchor-stability.js
```

Add `--selftest` to the first two: it breaks the real source one change at a time
and fails unless the named check goes red.
