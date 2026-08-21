# AR refinements — open list

Measured from `ScreenRecording_08-20-2026 23-42-17_1.mov`, 38.6s, 1320x2868, 120fps.

## The headline measurement

Over **25.1s of live camera**, with the flyer in view essentially the whole time:

| | |
|---|---|
| Meal visible | **5.1s across 2 appearances** |
| Meal absent | **20.0s across 3 dropouts** |
| **Uptime** | **20%** |
| Longest hold | 3.50s |
| Longest gap | **9.47s** |

```
timeline, 0.5s per char, from 13.5s
...........###...................#######...........
```

This is not flicker around a working lock. It is **mostly not acquiring**, with two
brief windows where it does.

### Correction to an earlier measurement

A first pass reported 79% uptime, 24 appearances and sub-0.2s flicker. That was
wrong. The detector counted warm saturated pixels across a wide centre crop, and a
**yellow snack bag sat in frame** on the left, tripping it constantly. Re-measured on
a tight box over the flyer only, absent frames read 0.02 and present frames 0.43-0.77
— an unambiguous gap. Trust the 20%, not the 79%.

Frame-by-frame inspection of 15.85s-16.60s confirms it: the flyer is sharp,
well-lit and unoccluded in all 12 frames, and the meal renders in none of them.

## Suspects, most likely first

**1. The flyer is small and steeply oblique in frame.** In the recording it fills a
minority of the width and is viewed at a shallow angle across a dark table. The
marker-tuning study already concluded physical print size is probably the dominant
real-world factor, and it is unmodelled in that study. Cheapest test available:
print the flyer larger and re-record the same way.

**2. The 720p camera cap may have shrunk the acquisition window.** `CropDetector`
sizes its square from HALF the smaller dimension, so 1080p gives a 512 crop and 720p
gives 256. That is a 4x cut in detection work, which was the point, but it also
halves the linear search window. If the flyer sits low or off-centre it can fall
outside. This is a change made shortly before this recording.

**3. The lean target has 7 pyramid levels against the full build's 11.** Fewer levels
means fewer apparent sizes the target can be recognised at, which bites hardest when
the marker is small in frame — exactly this situation. Measured as equal on
acquisition in simulation, but that simulation did not model print size.

Suspects 2 and 3 were both introduced immediately before this recording and both
plausibly hurt acquisition of a small marker. Neither has been tested against a real
print.

## Proposed next step

Revert 2 and 3 independently and re-record the same scene, so each is measured rather
than argued:

- A: current build (720p cap + lean target)
- B: 720p cap + **full** target
- C: **1080p** + lean target
- D: neither — the build from before both changes

The same measurement script gives an uptime number per run, so this is decidable
rather than a matter of opinion.

## Also open

- Shadow opacity 0.30 and the 11 degree light tilt are unverified against a real print.
- Environment lighting and ACES tone mapping are unverified on a phone.
- `marker.html` heading still reads "LOCK THE MEAL TO ONE SPOT", which oversells what
  image tracking does once the flyer leaves frame.
- Spatial persistence when the flyer leaves frame remains unbuilt; MindAR has no world
  tracking, so this needs gyro or a SLAM platform.
