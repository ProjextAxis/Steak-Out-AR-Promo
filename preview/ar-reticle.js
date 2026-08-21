/*
 * Acquisition only ever inspects a CENTRED crop of the camera frame.
 * controller.js calls cropDetector.detect() to find the target, and detect()
 * takes a square from the middle:
 *
 *   startX = width/2 - cropSize/2;  startY = height/2 - cropSize/2;
 *
 * with cropSize derived from HALF the smaller dimension, so 256 at 720p and 512
 * at 1080p. That is 20% and 27% of frame width. detectMoving(), which walks nine
 * positions, only runs once a target is already being tracked.
 *
 * Measured over four builds, the meal was on screen 10-14% of the time, and the
 * only windows where it locked were the ones where the flyer happened to sit
 * centred and close. "KEEP IT IN FRAME" is the wrong instruction: in frame is
 * not enough, it has to be in the middle.
 *
 * This draws the actual detection window so there is something to aim at. It is
 * sized from the real crop maths against the live video, not guessed.
 */
(() => {
  const ID = 'ar-reticle';

  const sizeIt = (box, video, stage) => {
    if (!video || !video.videoWidth) return false;
    const vw = video.videoWidth, vh = video.videoHeight;
    const crop = Math.pow(2, Math.round(Math.log2(Math.min(vw, vh) / 2)));

    // MindAR covers the stage with the feed, so one camera pixel is this many
    // CSS pixels. Use the larger ratio, matching object-fit: cover.
    const rect = stage.getBoundingClientRect();
    const scale = Math.max(rect.width / vw, rect.height / vh);
    const side = Math.round(crop * scale);

    box.style.width = side + 'px';
    box.style.height = side + 'px';
    box.dataset.arReticle = vw + 'x' + vh + ' crop ' + crop;
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
