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
| Camera | `ar-camera-tune.js` asks for 1080p and records what it gets — see 5b |

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

**Read that table as history, not as a description of the current builds.** It
was measured when `ar-camera-tune.js` capped resolution DOWN. It now asks UP,
and the letters were re-pointed to match: **A and B ask for 1080p, C and D leave
the request untouched as a control.** The labels in `config.js` said 720p/1080p
for one commit after the behaviour changed, so anyone who recorded `?ar=C`
during that window measured the browser default, not 1080p.

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

**This is NOT known to be a device ceiling.** It is a new iPhone, and Apple's own
AR is unaffected because ARKit gets native camera access while the web only gets
getUserMedia, which on iOS defaults low unless explicitly constrained.

Four attempts have been made. All four looked verified in Chrome first. Recorded
so nobody repeats them:

1. **Capping DOWN to 720p.** Wrong problem entirely. Detection cost was never the
   bottleneck; pixels on the marker are.
2. **`md.getUserMedia = fn`.** `getUserMedia` lives on `MediaDevices.prototype` and
   is non-writable on some browsers, so the assignment fails **silently** in
   non-strict code. Chrome accepted it, Safari ignored it.
3. **`Object.defineProperty` on the instance only.** Reported `patch instance`, and
   the device then reported `cam never called` — `install()` returned on first
   success so the prototype was never patched.
4. **A promise ladder whose trail lied.** Prototype + instance + legacy alias were
   all patched, and that part works. But the diagnostic reporting it did not: the
   `.then` handlers after each `.catch` also ran on the SUCCESS path, so a run
   that got exact 1920x1080 recorded "exact 1920x1080 OK > exact 1280x720 OK >
   fell back to ideal". And `.slice(-40)` cut the front off, which made "ideal
   honoured, 1080x1920" and "ideal ignored, still 480x640" render as identical
   text. **Had the recording been taken against that build, it would have
   produced a confident wrong answer.** Caught by replaying the deployed bytes
   against synthetic cameras, not by reading the source.

### What the current build does

One `getUserMedia` call on the customer path: `width/height: {ideal: 1920/1080}`,
which is orientation-tolerant and, per spec, cannot raise `OverconstrainedError`.
It either honours the hint or ignores it silently, and the recorded size says
which. Only `OverconstrainedError` is ever retried, so a denied permission costs
one failure rather than three.

`applyConstraints` then runs on the live track as an independent lever, on the
normal path as well as under `?xray=1` — some engines ignore the getUserMedia
hint but honour it. Only the `exact` ladder is diagnostic-only: it costs extra
`getUserMedia` calls, and it is tried in **both** orientations because a portrait
phone can refuse 1920x1080 while happily delivering 1080x1920.

**As of this writing the 1080p request has still never been exercised on
hardware.** Every 480x640 measurement so far is the UNCONSTRAINED default, not a
refusal.

### The recording that settles it

Record ~20s of, held the way a customer would hold it:

```
https://projextaxis.github.io/Steak-Out-AR-Promo/preview/?ar=A&xray=1
```

Read these three lines off the overlay. They no longer truncate, and each
request now prints its own answer on its own line.

| line | meaning |
|---|---|
| `CAPS  max 1920x1080` | the camera CAN do HD — anything less is a constraint problem, keep pushing |
| `CAPS  max 640x480` | genuine ceiling for getUserMedia on this device — stop pushing, change the print instead |
| `CAPS  unsupported` | this engine has no `getCapabilities`; fall back to reading `grant` |
| `ask   ideal1080=1920x1080` | the hint was honoured — resolution was the problem, and it is now fixed |
| `ask   ideal1080=480x640` | the hint was ignored; read the `exact` lines beneath it |
| `grant …` | what mind-ar actually received |
| `feed  …  crop …` | what the tracker sees, read independently from the video element |

`CAPS` against `grant` is the whole question. A track that reports 1920 while
`grant` reads 480x640 proves the pixels are being withheld by software, and that
is worth another attempt. If `CAPS` reports 640x480, the web camera on this
device genuinely cannot do better and the remaining lever is physical: print the
flyer larger so it fills more of whatever frame we get.

If the overlay does not appear at all, the AR iframe is not receiving the
parameters — `config.js` forwards `ar=` and `xray=1` into `marker.html`, and that
forwarding was confirmed working on the deployed preview.

### Analysing the recording

Use ffmpeg frame-by-frame. Do not eyeball, and do not trust a summary: an earlier
measurement reported 79% uptime and was wrong, because the detector counted a
yellow snack bag in frame as fries. The real figure was 20%.

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

Added since, all measured rather than argued:
- `config.js` really does forward `ar=` and `xray=1` into the `marker.html`
  iframe — read off the deployed preview, not the source.
- mind-ar 1.2.5 asks for `{audio:false, video:{facingMode:'environment'}}`, an
  object carrying no size, freshly on every call — read out of the shipped
  bundle. So the wrapper's "is it unsized" guard matches, and patching
  `MediaDevices.prototype` is reached.
- The camera ladder replayed against synthetic cameras across nine scenarios:
  ideal honoured, ideal ignored, exact refused in one orientation and not the
  other, a genuine 640 ceiling, `getCapabilities` absent, permission denied, and
  the untouched control. Every one is now distinguishable on the overlay.
- The whole shipped pipeline driven against a synthetic 1920x1080 feed:
  `crop 512`, 274 feature points, and a successful match. The crop formula in
  section 4 is confirmed against the runtime — 256 at 480x640, 512 at 1080p.
- The no-camera journey driven end to end in a browser: one `getUserMedia` call,
  the fault panel visible and naming the cause, retry working.

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
- **`config.js` wins the `imageTargetSrc`, not `marker.html` — the opposite of
  what this note used to say.** `marker.js` calls `setAttribute('mindar-image',
  'imageTargetSrc', ...)` before A-Frame initialises the component, and the
  `mindar-image` component has an `init` and **no `update`** (confirmed in the
  shipped 1.2.5 bundle), so the one read it ever does happens after that write.
  The markup value is only a fallback, used when `marker.js`'s early-return
  guard fires. The real hazard is the reverse of the old advice: "fixing"
  `marker.html` to match config hard-codes one target and silently breaks the
  `?ar=` switch.
- Cache-bust `?v=` on every changed file, and bump the iframe's
  `marker.html?embedded=1&v=` in `index.html` when `marker.html` changes, or
  returning users run a stale AR page.
- `model-viewer` does NOT ship the meshopt decoder — Draco only.
- `track()` in `app.js` pushes to `window.dataLayer`, but **no GTM/GA is loaded**.
  Analytics is currently a no-op. Parked until the domain is settled.
- **`mindar-image-system.start()` is synchronous and returns `undefined`.**
  `await system.start()` therefore always resolves, even when the camera never
  came up. It is not a signal that anything worked. mind-ar catches the
  `getUserMedia` rejection itself and re-emits it as an **`arError`** event on the
  scene — listen for that, not for a rejected promise.
- **A `<canvas>` is a replaced element.** `position:fixed; inset:0` with
  `width:auto` gives it its *intrinsic* size, which is the backing-store size in
  CSS pixels — 750px wide on a 375px phone at dpr 2, so everything drew at double
  scale and ran off-screen. Any full-screen canvas overlay needs an explicit
  `width:100%; height:100%`.
- **The compact-layout sheets hide the instruction copy.** `marker-target.css`
  sets `.marker-instruction__copy { display:none !important }` and
  `marker-ghost-placement.css` does the same to `.marker-status`. Anything routed
  through `renderInstruction()` for a message the user must read will render
  nothing. The camera fault panel has its own class for this reason.

## 9. Blocked on the owner

- **QR destination URL** — DNS transfer in flight. The QR is part of what the
  tracker reads, so changing it changes the artwork, which forces a marker
  recompile. Sequence: final URL -> final QR -> final artwork -> recompile
  (`tools/compile-mind.js`, ~33s) -> print. Recommend the QR point at a short
  redirect the owner controls, so hosting can move without reprinting.
- **Self-hosting the four runtime CDNs** (aframe.io, jsdelivr, unpkg,
  www.gstatic.com). Any outage kills the AR during service. Deferred as step 2.
- **Merging `hero-split-and-speed` to `main`.**
