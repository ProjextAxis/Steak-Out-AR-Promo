/*
 * Acquisition sweeps a MOVING window, and this box shows the area it covers.
 *
 * The previous version drew a single CENTRED crop, on the strength of
 * crop-detector's detect(). Reading the shipped mind-ar 1.2.5 bundle settles
 * that this is not the acquisition path at all:
 *
 *   async _detectAndMatch(t, e) {
 *     const { featurePoints: s } = this.cropDetector.detectMoving(t);
 *
 * _detectAndMatch is the ONLY thing processVideo calls while nothing is
 * tracked. The centred detect() is reached exactly once, from dummyRun().
 *
 * detectMoving cycles a 3x3 grid, one position per frame:
 *
 *   x = width/2  - cropSize + (i % 3) * cropSize/2
 *   y = height/2 - cropSize + floor(i / 3) * cropSize/2
 *
 * so the union of the nine windows spans 2 x cropSize in each axis, centred on
 * the frame -- 1024px across on a 1080-wide feed, not 512. The old box was
 * therefore HALF the linear size of the region actually searched, which told
 * customers to hold back twice as far as they needed to. That is the one thing
 * this promo cannot afford: the flyer is already small in frame and reprinting
 * it larger is out of budget, so every pixel has to come from framing.
 *
 * Override with ?ret=<multiple of cropSize> to A/B it against a recording.
 */
(() => {
  const ID = 'ar-reticle';

  /* SPAN 1, not 2 — and the difference is not the sweep geometry.
   *
   * The swept region really is 2 x cropSize (see the note above), so 2 is the
   * right answer to "where can the flyer BE". But a box also answers "how BIG
   * should it be", and that is capped by something else entirely: the compiled
   * target's largest keyframe.
   *
   * assets/steakout-marker-lean.mind decodes to one target, 351x512, with seven
   * keyframes at short edges 351/317/252/200/159/126/100. The matcher runs the
   * query against every keyframe and keeps the largest inlier set, so the flyer
   * must appear at a scale one of those covers. Above 351px short edge — 512px
   * long — there is no keyframe left, and a flyer filling a 1024px box sits at
   * roughly twice that. It cannot match at any scale.
   *
   * SPAN 2 shipped briefly in 52f92f6 and was wrong for this reason. The 60%
   * uptime recording ran SPAN 1: its reticle measures 262x266px in a 560px-wide
   * frame, and SPAN 1 predicts 512 * (560/1080) = 265.5px.
   *
   * If the FULL target is ever made the default, this changes — it is compiled
   * from 1038x1515, so its largest keyframe is three times bigger and a larger
   * box would then be correct. Tie any change here to the target in use.
   * ?ret=<n> overrides it so a device recording can settle it, not an argument.
   */
  const SPAN = (() => {
    const v = parseFloat(new URLSearchParams(location.search).get('ret'));
    return Number.isFinite(v) && v > 0 && v <= 4 ? v : 1;
  })();

  const sizeIt = (box, video, stage) => {
    if (!video || !video.videoWidth) return false;
    const vw = video.videoWidth, vh = video.videoHeight;
    const crop = Math.pow(2, Math.round(Math.log2(Math.min(vw, vh) / 2)));

    // The swept region, clamped to the frame the way detectMoving clamps its
    // own window, so the box never promises area the detector cannot reach.
    const spanX = Math.min(vw, crop * SPAN);
    const spanY = Math.min(vh, crop * SPAN);

    // MindAR covers the stage with the feed, so one camera pixel is this many
    // CSS pixels. Use the larger ratio, matching object-fit: cover.
    const rect = stage.getBoundingClientRect();
    const scale = Math.max(rect.width / vw, rect.height / vh);

    /* Clamp to what is actually on screen.
     *
     * Cover-fit crops the feed's sides, so the swept region can be wider than
     * the viewport -- at 1080x1920 on a phone it is. Drawn at true size the
     * corner brackets sit off both edges and the customer sees no box at all,
     * which is worse than a box that is slightly conservative. Clamping
     * horizontally is honest here: if the sweep is wider than the screen, then
     * anywhere across the screen is inside it. */
    const maxW = Math.max(120, rect.width - 28);
    const maxH = Math.max(120, rect.height - 28);

    box.style.width = Math.round(Math.min(spanX * scale, maxW)) + 'px';
    box.style.height = Math.round(Math.min(spanY * scale, maxH)) + 'px';
    box.dataset.arReticle = vw + 'x' + vh + ' crop ' + crop + ' span ' + SPAN + 'x';
    return true;
  };

  const build = () => {
    if (document.getElementById(ID)) return;
    const stage = document.querySelector('#marker-scene');
    if (!stage) return;

    const box = document.createElement('div');
    box.id = ID;
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<span></span><span></span><span></span><span></span>'
                  + '<b>PUT THE FLYER IN HERE</b>';
    document.body.appendChild(box);

    const video = document.querySelector('video');
    const tick = () => {
      if (!sizeIt(box, video || document.querySelector('video'), stage)) {
        setTimeout(tick, 250);
      }
    };
    tick();
    window.addEventListener('resize', () => sizeIt(box, document.querySelector('video'), stage));

    // Once it locks, the aim is done; get out of the way.
    const anchor = document.querySelector('#marker-anchor');
    if (anchor) {
      anchor.addEventListener('targetFound', () => box.classList.add('is-locked'));
      anchor.addEventListener('targetLost', () => box.classList.remove('is-locked'));
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
