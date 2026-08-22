# Steak Out AR spatial-lock research

Status: research complete. The approved instrumented stability build was implemented locally on 2026-08-22; deployment remains pending final verification.

## Implemented build checklist

- [x] Default to target-relative `responsive` scale; retain `?xrscale=absolute` for comparison.
- [x] Use a nonzero A-Frame camera height (`1.6`) required by responsive world scale.
- [x] Validate finite pose, quaternion, target scale, and target dimensions.
- [x] Check every raw target event for a one-frame translation, rotation, or scale discontinuity.
- [x] Downsample accepted candidate evidence to 20 Hz so a 12-sample ring spans 550 ms at both 60 and 120 Hz input rates.
- [x] Replace timer-only placement with `candidate → stabilize → commit`.
- [x] Add a cancellable deadline reevaluation so stable tracking cannot remain in “holding” merely because updates stopped.
- [x] Quarantine one bad pose; require a new three-sample cluster before treating a persistent correction as fresh evidence.
- [x] Require continuous visibility, `NORMAL` tracking, lifecycle quiet time, and a stable medoid before commit.
- [x] Keep the committed root anchor immutable when the flyer leaves view or returns.
- [x] Reset only uncommitted evidence on target loss, tracking limitation, visibility/orientation changes, and warm camera lifecycle transitions.
- [x] Add the opt-in `?ar-debug=1` corner dot, removable panel, copied 60-second event log, and no-upload privacy boundary.
- [x] Keep a lightweight every-engine-frame camera/projection ring and preserve pre/post frames when a one-frame anomaly is detected.
- [x] Add deterministic tests for the recorded 16.667 ms, 2.5× discontinuity; stable 60 fps acquisition; smooth 120 fps motion; input validation; dependency order; cache keys; and debug gating.
- [ ] Run the physical iPhone printed-flyer matrix and calibrate provisional thresholds from the copied log.

## Goal

Keep the meal at a stable real-world pose and physical size after the flyer leaves the camera, including when the phone moves away, the anchor leaves the screen, and the user returns to it.

## Recording evidence

Source: `ScreenRecording_08-21-2026 23-07-36_1.MP4`

- Container duration: 26.668 seconds.
- Video duration: 26.663 seconds.
- Resolution: 1320 × 2868.
- Codec: HEVC.
- Nominal rate: 60 fps; average rate: 59.775 fps.
- Total decoded frames: 1,595.
- Native frame interval: about 16.7 ms.
- The full recording was surveyed at 500 ms intervals.
- The suspected sections were then decoded at every native frame, including the complete transition around 13.4 seconds.
- A genuine discontinuity occurs between source timestamps 13.418333 and 13.435000 seconds: the meal changes from a normal plate-scale rendering to a screen-filling scale/position in one adjacent 16.667 ms frame.
- There is no source-frame timestamp gap at that boundary. The one-frame change rules out ordinary camera perspective as the cause of the reported failure.
- After the discontinuity, the meal remains huge and subsequent motion is continuous. Later perspective growth is real camera motion layered on top of the already-failed state.

| Zero-based source frame | Timestamp | Observation |
| ---: | ---: | --- |
| 805 | 13.418333 s | Normal meal size and placement |
| 806 | 13.435000 s | Meal becomes roughly 2–3× larger and shifts in one frame |
| 807 | 13.451667 s | Oversized state persists |

Three later 33.333 ms recording-cadence gaps occur at 15.085000, 15.268333, and 15.468333 seconds. They happen after the main jump and do not explain it.

## Confirmed implementation facts

- The active camera path is 8th Wall XR Engine plus 8Frame; the legacy `ar-camera-tune.js` file is not loaded.
- World tracking is enabled and configured with `scale: "absolute"`.
- `xrimagefound` immediately applies the first target pose and starts a fixed 900 ms timer.
- `xrimageupdated` updates the target pose only before lock.
- Lock does not require a minimum number of good update samples, pose stability, or stable absolute scale.
- After 900 ms, all future image-target updates and reacquisitions are ignored.
- The anchor is a plain A-Frame world transform; there is no pose-quality gate, jump rejection, or relocalization state machine.

## Hypotheses considered

1. Premature lock: the first target pose or metric scale has not converged when the 900 ms timer expires.
2. World-scale refinement: absolute-scale SLAM continues correcting its scale after the anchor is frozen, changing the meal's apparent size or location relative to the flyer.
3. Tracking degradation/relocalization: rapid motion, blur, low-parallax movement, or losing the mapped scene causes a camera-pose correction that moves a plain world anchor.
4. Target-pose outlier: one bad `xrimageupdated` sample is accepted immediately before lock.
5. Resume/orientation/intrinsics transition: a camera or page lifecycle transition changes projection or world tracking. The recording must be checked for the corresponding event.
6. Expected perspective only: rejected for the main frame-805-to-806 discontinuity; it does explain some later smooth growth as the phone moves closer.

## Current cause ranking

1. **Medium-high confidence:** a SLAM camera/world-pose relocalization or metric-world-scale correction occurs after the application has frozen the anchor. This best fits a one-frame discontinuity after the normal app path has stopped writing the anchor.
2. **Medium confidence:** the camera projection/intrinsics changes internally. The video alone cannot distinguish this from a camera/world-pose correction.
3. **Medium confidence as a contributing weakness:** a provisional image-target or absolute-scale pose was committed during the fixed 900 ms window, then exposed by a later engine correction. The timer-only lock is unsafe even if it is not the immediate frame-806 trigger.
4. **Low-medium confidence:** an unexpected session/lifecycle reset or hidden post-lock pose application. The visible UI does not show a restart and the intended code path blocks it, but telemetry is required to rule it out.
5. **Very low confidence:** direct target reacquisition, an application model-scale feedback loop, or ordinary handheld motion. Post-lock image events are ignored, model scale is not continuously updated, and the change occurs in one frame.

## Primary-source findings

- 8th Wall documents that absolute scale returns world and image-target values in meters only **once scale has been estimated**. The current build has no explicit scale-ready gate: <https://8thwall.org/docs/api/engine/xrcontroller/configure>
- 8th Wall provides an Absolute Scale Coaching Overlay specifically to gather scale-estimation motion. Its default instruction is to move the phone forward and back, and its hide event indicates that the scale flow has completed. The current build uses a fixed 900 ms timer instead: <https://8thwall.org/docs/engine/guides/coaching-overlays>
- 8th Wall now distributes the Absolute Scale Coaching Overlay as a local package, so the calibration step can remain self-hosted: <https://www.npmjs.com/package/@8thwall/coaching-overlay>
- `xrimageupdated` is emitted when an image target's position, rotation, or scale changes. The official A-Frame pattern applies both `xrimagefound` and `xrimageupdated`; our code stops accepting updates after lock: <https://8thwall.org/docs/api/engine/aframeevents/xrimagelost>
- The engine exposes per-frame camera position, rotation, projection intrinsics, tracking status/reason, and optional world points. That is enough to distinguish an image-pose outlier from a camera/SLAM correction in the diagnostic build: <https://8thwall.org/docs/api/engine/xrcontroller/pipelinemodule>
- Camera frames expose `videoTime`, dimensions, orientation, and whether a frame is repeated. Lifecycle hooks cover pause, resume, video-size changes, and orientation changes: <https://8thwall.org/docs/api/engine/camerapipelinemodule/onprocessgpu> and <https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule>
- Official troubleshooting warns that repetitive tiles, reflective surfaces, rapid motion, multiple visible planes, and tight spaces can cause tracking loss or an incorrectly redefined plane. Several of those conditions are visible in the test recording: <https://8thwall.org/docs/troubleshooting/world-tracking-issues>
- World tracking reports `LIMITED` or `NORMAL`. The current lock logic does not require `NORMAL` or react to a later limited period: <https://8thwall.org/docs/api/studio/events/xr/world>
- The distributed SLAM binary does not include VPS. Durable same-session offscreen locking is a valid goal, but globally persistent or guaranteed cross-session anchors are not available through this package: <https://8thwall.org/docs/open-source>

## Upgrade research

- The project already vendors `@8thwall/engine-binary` 1.0.0.
- The official engine repository currently declares 1.0.0 and recommends the `@1` release line, so no newer binary upgrade has been identified: <https://github.com/8thwall/engine/blob/main/package.json>
- The largest immediate gains therefore appear to be integration fixes: wait for scale readiness, use target update samples correctly, add tracking-state gates, and support validated reacquisition.
- Keep the distributed engine files unmodified and replace them only as a complete official bundle if a newer release appears.

## Scale-mode decision to test

| Mode | Best fit | Main advantage | Main risk/cost |
| --- | --- | --- | --- |
| `responsive` | The meal only needs to stay proportioned to the flyer | Avoids waiting for metric absolute-scale estimation and may remove the current failure trigger | Must be phone-tested to prove the frozen target-relative world pose stays stable offscreen |
| `absolute` plus coaching | The meal must have a true real-world size in meters | Preserves metric scale | Requires a forward/back calibration step, a scale-ready gate, and stable-pose sampling before lock |

The product requirement currently sounds target-relative rather than metric. Therefore `responsive` is the preferred first A/B candidate, not yet a decided production change.

## Current solution direction

1. Acquire the flyer but do not commit the anchor from the first found event.
2. Collect a rolling window of target updates while tracking is `NORMAL`.
3. Require stable translation, rotation, and flyer-width estimates. If the `absolute` mode survives the A/B test, also require scale-coaching completion.
4. Commit a robust pose derived from the stable sample window.
5. When the flyer leaves view, hold the committed world pose and let SLAM move only the camera.
6. When the flyer returns, measure its stable candidate pose against the committed pose for telemetry and validation.
7. In the first conservative build, never silently correct a committed anchor from reacquisition data. If later phone logs prove a correction is needed, use one validated correction behind a recovery state or an explicit re-anchor action.
8. During `LIMITED` tracking, never accept a new commit or correction.
9. Record every transition and threshold result in the opt-in HUD ring buffer.

Initial diagnostic thresholds, to be calibrated from phone logs rather than treated as final constants:

- Minimum continuously visible dwell: 900 ms.
- `NORMAL` tracking required immediately before commit: 500 ms.
- No resume, visibility, orientation, or camera-epoch transition before commit: 750 ms.
- Candidate window: last 250–600 ms, capped at 12 accepted samples.
- Hard translation outlier within 250 ms: more than `max(0.10 m, 0.50 × flyer width)`.
- Hard scale outlier within 250 ms: more than a 25% flyer-width change.
- Hard rotation outlier within 250 ms: more than 35 degrees.
- Stable medoid residual: at most `max(0.015 m, 0.10 × flyer width)`, 5% scale, and 8 degrees.
- Quiet time after a rejected sample: 400 ms.

## Developer HUD research specification

The proposed diagnostic control is a 9 px, low-opacity dot with a larger safe tap target in a screen corner. It is enabled only by `?ar-debug=1`; without that query it creates no DOM, listeners, pipeline module, or storage. A tap opens the panel, and a user-triggered action copies a capped 60-second in-memory log. Removing one script inclusion removes the feature.

Candidate live fields:

- Engine frame/time and rendered frame rate.
- Camera status and XR tracking status.
- Page visibility, focus, orientation, pause, resume, and resize events.
- Image state: scanning/found/updated/lost, sample count, and age of last sample.
- Raw target position, rotation, `scale`, `scaledWidth`, and computed physical flyer width.
- Candidate pose versus committed anchor pose.
- Per-frame translation, rotation, and scale deltas.
- Rolling jitter and stability windows.
- Rejected-sample count and rejection reason.
- Lock state and reason: acquiring, stabilizing, locked, tracking-limited, relocalizing, or recovered.
- Camera/world pose deltas and any available projection/intrinsics values.
- A short in-memory event ring buffer that can be copied after a failure.

Performance limits:

- Sample numeric engine state at 10 Hz plus state changes/anomalies; update the visible panel at 4 Hz.
- Keep only cloned scalar values in a capped ring buffer.
- Do not log/serialize or write the DOM per render frame.
- Never read pixels, retain camera textures/video frames, take screenshots, or upload diagnostics.
- Make pipeline installation and removal idempotent so iPhone iframe resumes cannot register duplicates.

## Chosen safeguards for the proposed build

- Replace the 900 ms timer with a sample-count plus stability gate.
- Use robust filtering over multiple `xrimageupdated` poses instead of accepting one sample.
- Reject impossible single-frame translation, rotation, and scale changes.
- Separate immutable model scale from target/world scale estimation.
- Freeze a committed anchor only after absolute scale is stable.
- Detect tracking-limited/relocalization periods and suppress visible pose jumps.
- Keep post-lock target reacquisition telemetry-only in the first instrumented build.
- If phone evidence later justifies correction, require a new stable cluster, hysteresis, and a deliberate recovery transition so it cannot oscillate or screen-pin the model.
- Define explicit fallback behavior when durable offscreen relocalization is not possible in a browser session.

## Proposed implementation order

1. Add the opt-in diagnostic dot and ring buffer without changing normal-user behavior.
2. Run identical phone tests in `responsive` and `absolute` modes; use the logs to classify the one-frame jump.
3. Replace raw pre-lock writes and the 900 ms timer-only lock with `candidate → stabilize → commit` using validated finite samples and a pose medoid.
4. Make the committed anchor immutable and add invariant warnings if application code changes its local/world transform.
5. Reset only uncommitted evidence on target loss, limited tracking, pause/resume, visibility, orientation, or camera-epoch changes.
6. Keep flyer re-entry telemetry-only until tests prove whether one validated recovery correction is necessary.
7. Run the full iPhone matrix, tune thresholds from copied logs, then remove or disable the HUD for the shipping link.

## Research tasks

- [x] Identify the exact failure frame and timestamp at native cadence.
- [x] Measure the discontinuity at adjacent-frame cadence and distinguish it from later perspective movement.
- [x] Correlate the visual change with current lock logic and identify what the video cannot prove without telemetry.
- [x] Collect official 8th Wall guidance for image-target updates and absolute scale.
- [x] Collect official guidance for tracking status, world points/anchors, lifecycle, and relocalization.
- [x] Confirm which required telemetry is exposed by the vendored engine version.
- [x] Rank anchor strategies by stability, compatibility, cost, and UI impact.
- [x] Define provisional numeric stability and outlier thresholds.
- [ ] Calibrate thresholds from real phone telemetry.
- [x] Define a repeatable iPhone test matrix.
- [x] Produce the implementation plan, then stop for approval before building.

## Planned phone validation matrix

- Slow orbit with the flyer continuously visible.
- Slow orbit after the flyer leaves view.
- Move the anchor fully offscreen for 2, 5, and 10 seconds, then return.
- Walk closer and farther without pointing at the flyer.
- Fast pan away and slow return.
- Temporary blur/occlusion and recovery.
- Reacquire the flyer from a different angle and distance.
- Background/foreground, screen lock/unlock, and close/reopen.
- Portrait-only first; orientation change tested separately.
- Normal light, low light, glare, and repetitive/low-feature surroundings.

## Decision log

- 2026-08-21: Keep this phase research-only.
- 2026-08-21: Preserve the current UI and customer flow.
- 2026-08-21: Diagnostics may use a tiny removable dot toggle.
- 2026-08-21: Do not reintroduce the legacy camera-zoom wrapper into the XR Engine path.
- 2026-08-21: The main failure is a real one-frame discontinuity at frame 806, not ordinary perspective growth.
- 2026-08-21: Test target-relative `responsive` scale before adding an absolute-scale coaching requirement.
- 2026-08-21: The first instrumented build will not silently auto-correct an already committed anchor.
