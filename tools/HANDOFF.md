# Steak Out AR — handoff

Written for someone picking this up cold. Read this before changing anything in
the AR path; several of the facts below cost real time to establish and are not
obvious from the code.

---

## 1. What this is

A tabletop promo. A printed flyer ($12 LUNCH MYSTERY) sits on a Steak Out table.
The customer opens the site, taps VIEW IN AR, points their phone at the flyer, and
a 3D cheesesteak plate appears on it.

- Repo: `ProjextAxis/Steak-Out-AR-Promo`, GitHub Pages.
- **All work is on branch `hero-split-and-speed`** — 28 commits ahead of `main`.
- `main`'s root is still the OLD site (62.5 MB model, no side-by-side hero).
- A copy of the branch is deployed at **`/preview/`** on `main` for phone testing:
  `https://projextaxis.github.io/Steak-Out-AR-Promo/preview/`
- Deploy the preview from a SEPARATE clone. Switching branches in the working tree
  while an agent is running there can discard its uncommitted work.

## 2. Standing constraint — do not violate

**Never hand off to Apple AR Quick Look or Android Scene Viewer.** Only the branded
in-page camera (`marker.html` in an iframe, MindAR image tracking) is acceptable.
This is an absolute brand rule from the owner.

Practically: keep `ar` and `ar-modes` off `<model-viewer>`, never call
`viewer.activateAR()`, never set `ios-src`. All AR routes through `openBrowserAR()`.

## 3. Current configuration

| | |
|---|---|
| Model | `assets/cheesesteak-special-v2.glb` — 0.99 MB, 104k tris, Draco + WebP |
| Model native size | 0.3521 x 0.1198 x 0.3523 m, **origin at the base** |
| Tracking target | `assets/steakout-marker-lean.mind` (full build also present) |
| modelScale / position / rotation | `9.0` / `0 0 0` / `90 0 0` |
| MindAR | filterMinCF `0.001`, filterBeta `1000` (both stock), missTolerance `10`, warmupTolerance `2` |
| Camera | capped to 720p by `ar-camera-tune.js` |

Scale needs no tape measure: MindAR normalises the marker to **1 unit wide**, so
plate width as a multiple of flyer width is `0.3521 * scale`. 2.84 makes them equal.

## 4. Facts established from the mind-ar source — trust these

All verifiable in `mindc/node_modules/mind-ar/src/image-target/`.

**Only the 128px tracking keyframe is ever read.** `tracker.js`:
`const TRACKING_KEYFRAME = 1; // 0: 256px, 1: 128px`. A compiled target holds two
levels; the 256px one is inert at runtime. On the level that matters this flyer
scores **33 points against MindAR's sample card's 32 — parity**, not the 1.5x a
summed count suggests.

**"Matching points" mostly measures source resolution.** The pyramid runs to a
100px short edge, so a 1038px source gets 11 levels and the 674px card gets 7.
3999 vs 593 is a pixel-count comparison, not a quality one.

**Acquisition only inspects a CENTRED crop.** `controller.js` calls
`cropDetector.detect()`, which slices from the middle. `detectMoving()`, which
walks nine positions, only runs once something is already tracked.

**The crop is sized from HALF the smaller dimension** — easy to misread:
```js
let minDimension = Math.min(width, height) / 2;
let cropSize = 2 ** Math.round(Math.log2(minDimension));
```
So **256 at 720p, 512 at 1080p** — a fifth to a quarter of frame width.

**missTolerance is not persistence.** Within tolerance the controller re-emits the
last *camera-relative* matrix, so the model stays fixed to the SCREEN and floats
over whatever the camera points at. Raising it makes detachment last longer.

**MindAR has no world tracking at all.** Pose exists only while the target is
detected. "Leave the flyer and come back" is unreachable by tuning.

## 5. The open problem

Measured across four builds, ~29s each, same scene:

| Build | Camera | Target | Uptime |
|---|---|---|---|
| A | 720p | lean | 11% |
| B | 720p | full | 10% |
| C | 1080p | lean | 14% |
| D | 1080p | full | 13% |

**All within noise.** Neither the 720p cap nor the lean target caused it — D
predates both. The meal is on screen 10-14% of the time.

Frame inspection shows it locks only when the phone is close and the flyer is
centred, which matches the centred-crop finding. Leading hypothesis is therefore
**how much of the frame the flyer physically fills**, i.e. print size. That is the
one factor the tuning study explicitly could not model.

Variants are switchable at runtime: `?ar=A|B|C|D`, each labelled on screen.
`?xray=1` overlays the live search window, feature points and match state.

## 5b. The camera resolution thread — read before touching `ar-camera-tune.js`

Measured on device with `?xray=1`: the camera feed is **480x640**, 0.3 MP. At that
size the flyer has almost no resolvable detail. The detector still returns 120-290
feature points a frame but they scatter across the room, and the matcher scored
single digits across 500+ attempts.

**This is NOT a device ceiling.** It is a new iPhone, and Apple's own AR is
unaffected because ARKit gets native camera access while the web only gets
getUserMedia, which on iOS defaults low unless explicitly constrained.

Three attempts were made to constrain it, and all three failed for different
reasons. Each looked verified in Chrome first. Recorded so nobody repeats them:

1. **Capping DOWN to 720p.** Wrong problem entirely. Detection cost was never the
   bottleneck; pixels on the marker are.
2. **`md.getUserMedia = fn`.** `getUserMedia` lives on `MediaDevices.prototype` and
   is non-writable on some browsers, so the assignment fails **silently** in
   non-strict code. Chrome accepted it, Safari ignored it.
3. **`Object.defineProperty` on the instance only.** Reported `patch instance`, and
   the device then reported `cam never called` — the override was installed on the
   object captured at load, and mind-ar reached the camera through another one.
   `install()` returned on first success so the prototype was never patched.

Current state patches prototype + instance + legacy alias and traces entry and
every exit path. **As of this writing the 1080p request has still never been
exercised on hardware** — every 480x640 measurement so far is the UNCONSTRAINED
default, not a refusal.

The lesson worth carrying: reasoning from the mind-ar source repeatedly produced
confident wrong answers. What worked was putting a trace in the code and letting
the phone report. Do that first.

One genuine improvement did land alongside this: the run after the reticle showed
`match 2/294 LOCKED`, the first successful locks observed, where earlier runs sat
at zero across 400+ attempts.

## 6. Do not redo these — negative results, already paid for

- **Print-simulation variants of the marker.** 26 tested. Both stages are already
  contrast-invariant (NCC for tracking, FREAK for matching), so contrast, gamma and
  blur are normalised away, and a flatter source yields *fewer* points against
  `SD_THRESH`. Sharpening and binarising also fail; binarising notably.
- **Multi-target `.mind` files.** 6 combinations. The worker breaks on first match
  and every gain landed on a higher target index, but `marker.html` declares one
  anchor at `targetIndex: 0` with `maxTrack` 1 — so those matches render nothing
  AND block target 0. Costs 2.84x per frame.

Full detail in `tools/MARKER-TUNING.md`. Open list in `tools/AR-REFINEMENTS.md`.

## 7. Verified vs assumed — important

**Verified** (structurally, headless, no camera): env map applied and ACES tone
mapping on; exactly one shadow-casting light; lean target resolving at both call
sites; camera wrapper installed before A-Frame; variant switches; model dimensions
identical across builds; fonts self-hosted with no external font requests.

**NOT verified — nobody has judged these through a camera:**
- Contact shadow opacity (0.30) and its 11 degree light tilt against a real print.
- The environment lighting and tone mapping on a phone.
- Whether the 720p cap hurt acquisition in practice.
- Everything in section 5 beyond the uptime numbers themselves.

There is no camera or gyro in the dev environment. Any claim about how the AR
*looks or feels* is inference unless a recording backs it.

## 8. Traps

- `mind-ar` ships its **own nested copy of `canvas`**. An Image loaded from any
  other install is rejected with "Image or Canvas expected". Load via
  `require('mind-ar/node_modules/canvas')`.
- **A-Frame 1.5.0's default directional light has `castShadow: true`.** Enabling
  shadow maps silently adds a second shadow pass and a second shadow that swings
  with the phone. Identify the real shadow rig by NAME, not by `castShadow`.
- **The MindAR anchor carries a world scale equal to the target's pixel width**
  (1038 here). A shadow camera frustum sized in world units must track it or it
  covers a fraction of a percent of the plate.
- **A-Frame may already have fired `loaded`** before a component's `init` runs, so
  a listener alone never fires. Check `el.hasLoaded` too.
- `marker.html` carries its own `imageTargetSrc` as well as taking one from config.
  **Change both** or the markup silently wins on first load.
- Cache-bust `?v=` on every changed file, and bump the iframe's
  `marker.html?embedded=1&v=` in `index.html` when `marker.html` changes, or
  returning users run a stale AR page.
- `model-viewer` does NOT ship the meshopt decoder — Draco only.
- `track()` in `app.js` pushes to `window.dataLayer`, but **no GTM/GA is loaded**.
  Analytics is currently a no-op. Parked until the domain is settled.

## 9. Blocked on the owner

- **QR destination URL** — DNS transfer in flight. The QR is part of what the
  tracker reads, so changing it changes the artwork, which forces a marker
  recompile. Sequence: final URL -> final QR -> final artwork -> recompile
  (`tools/compile-mind.js`, ~33s) -> print. Recommend the QR point at a short
  redirect the owner controls, so hosting can move without reprinting.
- **Self-hosting the four runtime CDNs** (aframe.io, jsdelivr, unpkg,
  www.gstatic.com). Any outage kills the AR during service. Deferred as step 2.
- **Merging `hero-split-and-speed` to `main`.**
