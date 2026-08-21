# Steak Out marker tuning — print robustness

**Bottom line: ship the current `assets/steakout-marker.mind` unchanged.**

I compiled 26 variants of the flyer and 6 multi-target combinations, then measured
them with MindAR's own detector and matcher against 27 simulated photographs of
the printed sheet. No variant and no multi-target combination measurably improves
on the target that is already deployed. The multi-target idea specifically does
not work here, and would introduce a visible failure mode with the current
`marker.html` markup.

This is a negative result, reported as one. What follows is the evidence, and an
optional file-size optimisation that the numbers *do* support.

---

## 1. What I found before measuring anything

Three facts from the mind-ar 1.2.5 source change how every number below should be
read. All three are verifiable in `node_modules/mind-ar/src/image-target/`.

**The tracker only ever reads the 128px keyframe.** `tracker/tracker.js`:

```js
const TRACKING_KEYFRAME = 1; // 0: 256px, 1: 128px
```

`buildTrackingImageList()` compiles exactly two tracking levels, scaled so the
image's **short** edge is 256px and 128px. The tracker uses only the second. So
the deployed target's headline "92 tracking points" is 59 points at the 256px
level that are **never read at runtime**, plus 33 points at the 128px level that
are the entire tracking budget.

On the number that actually governs holding a lock, the deployed target scores
**33 against the sample card's 32** — parity, not the 92-vs-62 advantage the
`config.js` comment claims.

**"Matching points" is mostly a measure of source resolution.** `buildImageList()`
builds a scale pyramid from full resolution down to a 100px short edge in
2^(1/3) steps. A 1038px-wide source gets 11 levels; the 674px-wide sample card
gets 7. The deployed target's 3999 matching points versus the card's 593 is
therefore about six times more *pixels*, not six times more *trackability*. The
512px variant below scores 2149 matching points and acquires exactly as often.

**Acquisition never looks at the whole frame.** `detector/crop-detector.js` picks
a square window — the nearest power of two to half the short edge — and cycles it
through nine positions, one per frame. Everything reported as a "window" below is
one of those. Measured by instantiating the real `CropDetector`:

| stream | crop window |
|---|---|
| 640x480 | 256 |
| **1280x720 (deployed)** | **256** |
| 1280x960 | 512 |
| 1920x1080 | 512 |

---

## 2. How this was measured

Feature counts alone cannot answer the question, so the harness runs the real
algorithms. `tools/lib/scene.js` renders the flyer as a plane in 3D, projected
through the same pinhole model MindAR assumes for pose estimation (45 degree
vertical FOV, principal point centred). Because the scene is synthetic the exact
pose is known — the ground-truth pose reprojects the target's corners onto the
rendered quad to within 1.8e-13 px.

| tool | what it drives | what it answers |
|---|---|---|
| `tools/make-variants.js` | greyscale image pipeline | renders print-simulated sources |
| `tools/compile-mind-multi.js` | `OfflineCompiler` | compiles 1..N images into one `.mind` |
| `tools/mind-stats.js` | `@msgpack/msgpack` | decodes and reports what is really inside |
| `tools/match-sim.js` | **MindAR's own** `CropDetector` → `Matcher` → `Estimator` | does it lock on? |
| `tools/track-sim.js` | CPU port of `Tracker` (`tools/lib/track-cpu.js`) | does the lock survive movement? |

The full 19-candidate sweep in section 3 was run at **640x480**. `ar-camera-tune.js`
now asks the camera for **1280x720**, so section 3a re-runs the headline
candidates at that size. Both resolutions produce a 256px crop window and lead to
the same conclusions; 720p simply acquires more often, because the flyer covers
more pixels.

The 27 test scenarios in `tools/lib/scenarios.js` are **held out**: every
contrast endpoint, gamma, angle and glare position differs from the values used
to build the variants, and test blur is applied in frame pixels after projection
rather than in artwork pixels before it. Testing a target on the image it was
compiled from would prove nothing.

**The benchmark discriminates.** Two negative controls confirm it is not simply
approving everything:

- `card.mind`, MindAR's sample card — a completely different marker — scores
  **0%** acquisition and **0%** tracking against Steak Out frames.
- `v61-skew-large`, compiled from a 25-degree-skewed source, collapses to
  **39.3%** acquisition and **0%** tracking.

`tools/track-sim.js` drives a reimplementation, not MindAR's own code: the
tracker's four hot kernels are WebGL `userCode` GLSL with no CPU fallback, so
`Tracker.track()` cannot run under Node's tfjs CPU backend. The port follows
`_computeProjection` and `_computeMatching` line by line with the same constants
and the same normalised-cross-correlation formula. Its absolute survivor counts
are a model; the comparisons between targets are what it is for.

---

## 3. Every variant tested

Sources are derived from `assets/steakout-marker.png` (1038x1515). "live pts" is
the 128px keyframe count — the only tracking number the runtime reads. "acq" is
the share of acquisition windows producing a solvable pose; "track" is the share
of movement trials keeping at least 4 correlated points. **normal** is 15
realistic scenarios, **hard** is 12 deliberately past the point of failure, which
is the only tier where candidates separate at all.

| target | tgts | KB | live pts | match pts | kf | acq normal % | acq hard % | inliers | ms/win | track normal % | track hard % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `steakout-marker.mind` **(deployed)** | 1 | 828 | 33 | 3999 | 11 | 97.0 | 52.8 | 49.6 | 21.3 | 100 | 83.3 |
| `v00-pristine` (recompile of deployed) | 1 | 827 | 34 | 3999 | 11 | 96.3 | 52.8 | 50.1 | 20.6 | 100 | 83.3 |
| `v12-res800` | 1 | 662 | 31 | 3063 | 9 | 97.0 | 53.7 | 49.0 | 17.7 | 100 | 76.7 |
| `v13-res640` | 1 | 579 | 34 | 2600 | 8 | 97.8 | 51.9 | 48.4 | 14.9 | 100 | 75.0 |
| `v14-res512` **(lean build)** | 1 | 499 | 36 | 2149 | 7 | 97.0 | 52.8 | 47.7 | 12.9 | 100 | 91.7 |
| `v21-contrast-hard` | 1 | 829 | 36 | 4002 | 11 | 97.0 | 54.6 | 49.0 | 20.4 | 100 | 75.0 |
| `v41-blur-motion` | 1 | 794 | 34 | 3802 | 11 | 97.0 | 53.7 | 50.2 | 20.8 | 100 | 80.0 |
| `v71-print-typical` | 1 | 654 | 35 | 3022 | 9 | 97.8 | 54.6 | 49.1 | 17.5 | 100 | 83.3 |
| `v73-print-typical-hires` | 1 | 808 | 33 | 3891 | 11 | 97.0 | 50.9 | 49.5 | 20.7 | 100 | 78.3 |
| `v80-sharpen` | 1 | 834 | 35 | 4022 | 11 | 97.8 | 53.7 | 49.7 | 19.9 | 100 | 78.3 |
| `v83-binarize` | 1 | 836 | 33 | 4030 | 11 | 97.0 | 54.6 | 48.4 | 19.9 | 100 | 71.7 |
| `v61-skew-large` *(control)* | 1 | 633 | 22 | 2930 | 11 | 39.3 | 14.8 | 28.4 | 12.9 | 0 | 0 |
| `m2a-pristine+typical` | 2 | 1481 | 34 | 7021 | 20 | 97.8 | 55.6 | 49.1 | 21.2 | 100 | 83.3 |
| `m2b-typical+pristine` | 2 | 1481 | 35 | 7021 | 20 | 97.8 | 55.6 | 49.1 | 18.8 | 100 | 83.3 |
| `m2c-pristine+skew` | 2 | 1460 | 34 | 6929 | 22 | 96.3 | 52.8 | 50.1 | 21.3 | 100 | 83.3 |
| `m3a-pristine+light+harsh` | 3 | 2123 | 34 | 9969 | 29 | 97.0 | 56.5 | 49.3 | 22.2 | 100 | 85.0 |
| `m3b-pristine+skews` | 3 | 2243 | 34 | 10687 | 33 | 96.3 | 58.3 | 48.9 | 22.4 | 100 | 83.3 |
| `m4a-full-ladder` | 4 | 2807 | 34 | 13176 | 39 | 97.8 | 61.1 | 48.1 | 23.0 | 100 | 85.0 |
| `card.mind` *(control)* | 1 | 251 | 32 | 593 | 7 | 0 | 0 | 0 | 3.8 | 0 | 0 |

Variants generated but not simulated (feature counts only, all compiled and
decoded cleanly): `v01-grey-only`, `v10-res1200`, `v11-res1024`,
`v20-contrast-mild`, `v30-bright-gamma`, `v31-dim-gamma`, `v40-blur-slight`,
`v50-glare`, `v60-skew-small`, `v70-print-light`, `v72-print-harsh`,
`v74-print-skewed-typical`, `v81-sharpen-strong`, `v82-contrast-boost`,
`v84-sharpen-800`. Their live-point counts all fall in the 22–36 band; only
glare (22) and skew (22–26) fall below the pristine 34.

### 3a. The same candidates at the deployed 1280x720

The flyer occupies more pixels at 720p, so everything acquires more often — but
the ranking, and every conclusion, is unchanged.

| target | tgts | KB | acq normal % | acq hard % | total hits | **hits on target 0** | ms/win |
|---|---:|---:|---:|---:|---:|---:|---:|
| `steakout-marker.mind` **(deployed)** | 1 | 828 | 97.8 | 77.8 | 216 | **216** | 25.7 |
| `steakout-marker-lean.mind` | 1 | 499 | 97.8 | 78.7 | 217 | **217** | **16.1** |
| `v71-print-typical` | 1 | 654 | 97.8 | 80.6 | 219 | 219 | 20.9 |
| `m2a-pristine+typical` | 2 | 1481 | 98.5 | 81.5 | 221 | **216** | 26.7 |
| `m4a-full-ladder` | 4 | 2807 | 98.5 | 82.4 | 222 | **216** | 29.0 |

Note the target-0 column: **216 for the single target and 216 for both
multi-target files.** At the deployed resolution, exactly as at 640x480,
multi-target adds nothing whatsoever to the only index `marker.html` can render.

Two results from the feature-count group are worth stating outright:

- **Greyscaling the source changes nothing.** `v01-grey-only` is byte-identical
  to `v00-pristine` (same SHA-1). The compiler already reduces every pixel to
  `(R+G+B)/3` in `compiler-base.js` before detecting anything.
- **Source resolution barely touches tracking.** The lean 351x512 build compiles
  tracking levels of 256x373 and 128x187; the 1038x1515 build compiles 256x374
  and 128x187. Identical, because `buildTrackingImageList()` resamples to fixed
  short-edge sizes regardless of input.

---

## 4. Why print simulation does not help

The intuition — "compile from something that looks like the print" — is
reasonable and turns out to be wrong, for a specific reason: **both stages of
MindAR are already contrast-invariant.**

The tracker scores points by *normalised* cross-correlation, which is invariant
to any affine change in brightness and contrast. A crisp high-contrast template
costs nothing when matched against a washed-out photograph of the print. The
matcher uses FREAK descriptors, which are binary intensity comparisons between
point pairs — invariant to monotonic intensity changes for the same reason.

So contrast compression, gamma shift and brightness lift, which is most of what
printing and restaurant lighting do, are removed by the algorithms before they
can hurt. Simulating them into the target buys nothing and costs something:
`tracker/extract.js` only selects points where the local 13x13 standard deviation
clears `SD_THRESH = 8.0`, so a flatter source yields *fewer* points.

This also predicted the failure of the opposite approach, which I tested to be
sure: sharpening (`v80`, 78.3%) and hard binarisation (`v83`, 71.7%) do not help
either, and binarisation is the one candidate that is significantly *worse*.

What the algorithms are *not* invariant to is **geometry and lost detail** —
which is exactly what the two controls show. Skew (`v61`) and heavy blur destroy
structure, and no amount of photometric simulation compensates.

---

## 5. Why multi-target specifically does not work here

**The extra targets never win the match on the index the page can display.**
`controller.worker.js` walks the target list and breaks on the first target that
produces a keyframe match. Target 0 is checked first and almost always succeeds.
Counting which target won across all 243 acquisition windows:

| file | hits on target 0 | hits on targets 1..N | total |
|---|---:|---:|---:|
| `v00-pristine` (single) | 187 | — | 187 |
| `m2a-pristine+typical` | 187 | 5 | 192 |
| `m3a-pristine+light+harsh` | 187 | 3 + 2 | 192 |
| `m4a-full-ladder` | 187 | 3 + 5 + 3 | 198 |

Target 0 scores **exactly 187 in every case**. Multi-target adds zero
acquisitions on target 0 — every gain lands on a higher index.

**And `marker.html` cannot render those indices.** Line 85 declares a single
anchor:

```html
<a-entity id="marker-anchor" mindar-image-target="targetIndex: 0">
```

`maxTrack` is not set anywhere, and `aframe.js` defaults it to 1. So when target
2 wins a match, three things happen: no `targetFound` fires for the index-0
anchor so **nothing appears**; `trackingStates[2].isTracking` becomes true so
`nTracking` reaches `maxTrack`; and the controller therefore **stops trying to
match target 0 entirely** until target 2's phantom track dies. The user sees the
camera find nothing at all. That is a regression, not an improvement.

**The cost is real.** Worst case per acquisition frame — marker absent from the
crop window, so every target and keyframe is scanned with no early exit — using
54 real query sets averaging 152 feature points:

| file | targets | keyframes | KB | decode | ms/frame | vs deployed |
|---|---:|---:|---:|---:|---:|---:|
| `steakout-marker.mind` | 1 | 11 | 828 | 16ms | 34.8 | 1.00x |
| `steakout-marker-lean.mind` | 1 | 7 | 499 | 3ms | 20.4 | **0.59x** |
| `v71-print-typical` | 1 | 9 | 654 | 4ms | 29.9 | 0.86x |
| `m2a-pristine+typical` | 2 | 20 | 1481 | 9ms | 52.2 | 1.50x |
| `m3a-pristine+light+harsh` | 3 | 29 | 2123 | 12ms | 71.2 | 2.04x |
| `m4a-full-ladder` | 4 | 39 | 2807 | 17ms | 99.0 | **2.84x** |

Measured on an Apple-silicon Mac. A mid-range phone is typically 3–5x slower, so
`m4a` would spend roughly 300–500ms per frame scanning while the user hunts for
the flyer. This cost is paid **only while not locked on** — matching stops
entirely once `nTracking` reaches `maxTrack` — which means it is paid precisely
during re-acquisition after a drop, making the reported symptom *worse*.

**Some added targets carry unusable tracking data.** In `m4a`, target 3 has
**0%** tracking survival in the hard tier. An acquisition landing there produces
a lock that dies immediately.

So: +8.3 points of hard-tier acquisition, none of it on a renderable target index,
for 3.4x the download, 2.8x the per-frame cost, and a new failure mode.

---

## 6. Is any difference statistically real?

Paired McNemar exact tests against the deployed target, on the 60 hard-tier
tracking trials (the normal tier is 100% for every credible candidate, so there
is nothing to test there):

| candidate | track hard % | better | worse | p |
|---|---:|---:|---:|---:|
| `v14-res512` | 91.7 | 5 | 0 | 0.063 |
| `m3a` / `m4a` | 85.0 | 1 | 0 | 1.000 |
| `v00-pristine`, `v71-print-typical`, all `m2*`, `m3b` | 83.3 | 2 | 2 | 1.000 |
| `v41-blur-motion` | 80.0 | 0 | 2 | 0.500 |
| `v73-print-typical-hires`, `v80-sharpen` | 78.3 | 0 | 3 | 0.250 |
| `v12-res800` | 76.7 | 0 | 4 | 0.125 |
| `v13-res640`, `v21-contrast-hard` | 75.0 | 0 | 5 | 0.063 |
| `v83-binarize` | 71.7 | 0 | 7 | **0.016** |

**Not one candidate significantly beats the deployed target.** The only result
below p=0.05 is `v83-binarize`, and it is *worse* — and across 16 comparisons even
that does not survive a Bonferroni correction (0.05/16 = 0.003).

The 71.7%–91.7% spread is noise, and its non-monotonicity gives it away:
512px scores 91.7 while 640px scores 75.0 and 800px scores 76.7. **`v14-res512`
does not track better than the deployed target** — its 5-trial edge is p=0.063,
all five in the borderline 2-to-6-surviving-point band right at the 4-point cliff.
It should be adopted, if at all, for its cost, not its robustness.

---

## 7. Recommendation

### Ship `assets/steakout-marker.mind` unchanged.

It acquires in 97% of realistic windows, keeps the lock in 100% of realistic
movement trials, and is matched or beaten by nothing tested. `targetMindUrl`
stays as it is:

```js
targetMindUrl: './assets/steakout-marker.mind',
```

### Do not change `maxTrack`, `missTolerance` or `warmupTolerance`.

`missTolerance: 10` and `warmupTolerance: 2` in `marker.html` are already more
forgiving than MindAR's defaults of 5 and 5. Nothing measured here argues for
moving them, and `maxTrack` must stay at its default of 1 while there is one
anchor entity.

### Optional, cost only: `assets/steakout-marker-lean.mind`

I have also produced a lean build (compiled from a 351x512 source, alongside its
source `assets/steakout-marker-lean.png`). It is **not more robust** — see
section 6 — but it is cheaper for identical acquisition:

| | deployed | lean | change |
|---|---:|---:|---:|
| file size | 828 KB | 499 KB | **-40%** |
| matching keyframes | 11 | 7 | -36% |
| worst-case matcher cost | 34.8 ms | 20.4 ms | **-41%** |
| msgpack decode at startup | 16 ms | 3 ms | -81% |
| live tracking points | 33 | 36 | +3 |
| acquisition, normal tier | 97.0% | 97.0% | none |
| acquisition, hard tier | 52.8% | 52.8% | none |
| tracking, normal tier | 100% | 100% | none |

The argument for it is narrow but real: halving matcher cost halves how long
re-acquisition takes after a drop, which shortens the visible gap the user is
complaining about. It does not reduce how *often* drops occur — `missTolerance`
counts frames, not milliseconds, so the number of re-acquisition attempts before
the model hides is unchanged.

To adopt it, one line in `config.js`:

```js
targetMindUrl: './assets/steakout-marker-lean.mind',
```

`modelScale`, `modelPosition` and `modelRotation` need **no change**. I checked
this rather than assuming: `aframe.js setupMarker()` composes a post-matrix that
scales the anchor space by the marker's width, so a child at scale 1 spans
exactly the marker width whatever the target's pixel dimensions. The aspect ratio
shifts by 0.058% (0.685149 → 0.685547) from rounding 1038x1515 down to 351x512,
which is invisible at any practical size.

**The contact shadow is also safe.** `ar-shadow.js` is the one other place that
depends on the target's pixel width, because MindAR's anchor carries a world
scale equal to it (1038 today, 351 with the lean build) and a directional light's
shadow frustum is sized in world units. I read it rather than assuming: it
recovers the scale from the live anchor matrix each frame
(`Math.sqrt(e[0]²+e[1]²+e[2]²)`) and re-fits the frustum whenever it moves by
more than 1%. A 1038 → 351 swap is a 66% change, so it re-fits on its own. There
is no hard-coded 1038 anywhere outside `tools/`.

Both files decode cleanly at version 2 with correct dimensions and a single
target — verified with `tools/mind-stats.js`, not assumed from the compiler.

**If in doubt, keep the deployed file.** The lean build's only proven benefit is
cost, and the deployed file is not broken.

---

## 8. Limits — what these numbers do and do not establish

**There is no camera here. Nothing below was confirmed against a real phone
pointed at a real printed flyer, and none of it should be reported as if it
were.**

What feature counts do **not** tell you:

- "Matching points" is dominated by source resolution, not target quality. The
  3999-vs-593 figure in the `config.js` comment compares pixel counts.
- "Tracking points" as usually quoted double-counts a 256px level the runtime
  never reads. The real figure for the deployed target is 33, not 92.
- Neither count says anything about whether points *survive* under blur, glare
  or motion. That is what sections 3 and 6 measure instead.

What the simulations do **not** cover:

- **Real print structure.** Halftone dots, ink spread, paper grain and stock
  texture are not modelled — only contrast, blur, glare, skew and noise.
- **Real camera behaviour.** No rolling shutter, JPEG artefacts, chroma noise,
  autofocus hunting or auto-exposure oscillation.
- **The real physical size of the flyer**, which sets how many camera pixels it
  occupies and is probably the single biggest unmodelled factor.
- **The tracking stage as MindAR actually runs it.** `track-sim` is a CPU port;
  the shipped path is WebGL, on GPUs with 16-bit float precision limits that
  `tracker.js` explicitly works around via `PRECISION_ADJUST`.
- **Close range on a high-resolution stream** for the lean build. I tested
  1280x720 (97.8% normal, 78.7% hard — matching the deployed target) and
  640x480, but a 351x512 target has no keyframe above 512px. If a device ignores
  the 720p `ideal` and delivers 1080p, the crop grows to 512 and the flyer can
  fill more of it than any lean keyframe covers. That is the case most likely to
  behave differently on real hardware, and it is untested.
- **Phone-class timings.** All milliseconds are Apple-silicon Mac numbers; treat
  them as ratios, not absolutes.

### One correction in a neighbouring file I do not own

`ar-camera-tune.js` justifies its 720p cap with:

> so a 1080p feed costs a 1024x1024 crop every frame, while 720p costs
> 512x512 -- four times fewer pixels

Both figures are one power of two too high. `CropDetector` takes
`2 ** round(log2(shortEdge / 2))`, and instantiating the real class gives 256 for
720p, 256 for 480p, and 512 for 1080p (table in section 1).

The cap is still worth keeping — tracking runs on the **full** frame, so 720p
genuinely halves that, and it cuts video decode and texture upload. But the
acquisition crop is 256x256 at 480p and at 720p alike, so capping at 720p does
not reduce acquisition cost at all. Only the claimed mechanism is wrong, not the
decision. Worth a comment fix by whoever owns that file.

### What to check on a real phone, with the real print

1. Whether the drops are acquisition or tracking. Log `targetFound` /
   `targetLost` against timestamps — `marker.js` already listens to both. Rapid
   found/lost cycling is a tracking problem; long silences are acquisition.
2. The printed flyer's physical size and how far away users actually hold it.
   If the flyer occupies less than about a third of the viewfinder, that alone
   explains the symptom and no target change will fix it.
3. Whether the print's real contrast is worse than the 95..160 crush of the hard
   tier. Photograph it under the actual restaurant lighting and compare.
4. Whether glare from the venue's lighting sits over the QR block. Section 3's
   `h08-centre-glare` models this and it is one of the harder cases.

---

## 9. Reproducing this

```sh
sh tools/run-experiment.sh /path/to/toolchain-dir   # dir holding node_modules
```

Roughly 25–35 minutes, mostly compilation. Individual tools:

```sh
export MINDAR_ROOT=/path/to/node_modules

node tools/make-variants.js assets/steakout-marker.png work/variants
node tools/compile-mind-multi.js out.mind a.png [b.png ...]   # 1..N targets
node tools/mind-stats.js out.mind                              # decode + verify
node tools/match-sim.js  --set all [--frame 1280x720] out.mind # acquisition
node tools/track-sim.js  --set all out.mind                    # tracking
node tools/summarize.js  match.json track.json [--md]
```

`tools/lib/resolve-mindar.js` locates the install via `MINDAR_ROOT`, the cwd, or
`NODE_PATH`, and routes every image through **mind-ar's own nested `canvas`** —
an Image from any other canvas install is rejected with "Image or Canvas
expected".

### Two fixes to the existing `tools/compile-mind.js`

It was broken exactly as its own docstring instructed. "Run it from the mindc
directory" cannot work, because Node resolves `require` relative to the **file**,
not the working directory, and the script lives in this repo, which has no
`node_modules`. It failed with `Cannot find module 'mind-ar/node_modules/canvas'`
unless `NODE_PATH` was set. It now goes through the resolver and works from any
directory.

It also reported `tracking points 92` — the sum across both levels, 59 of which
the tracker never reads. It now leads with the live 128px count and labels all
three numbers with what they actually mean.

Nothing outside `assets/` (two new files) and `tools/` was modified.
