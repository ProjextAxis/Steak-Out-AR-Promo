(() => {
  /*
   * MindAR asks for the camera with only { facingMode: 'environment' } and then
   * feeds whatever resolution it gets straight into detection and tracking:
   *
   *   this.controller = new Controller({
   *     inputWidth: video.videoWidth, inputHeight: video.videoHeight, ...
   *
   * Detection crops a power-of-two square from the centre of the frame, sized
   * from the smaller dimension:
   *
   *   cropSize = 2 ** Math.round(Math.log2(minDimension))
   *
   * so a 1080p feed costs a 1024x1024 crop every frame, while 720p costs
   * 512x512 -- four times fewer pixels -- and tracking, which runs on the full
   * frame, roughly halves as well. On a phone that is the difference between a
   * steady lock and a stuttering one, and it compounds, because sustained load
   * makes the device throttle.
   *
   * Trade-off: the smaller crop covers less of the frame, so the marker has to
   * be nearer the centre to be ACQUIRED. Tracking once locked is unaffected.
   *
   * This wraps getUserMedia rather than forking MindAR. Only a request that
   * specifies no size at all is modified, so any other caller is left alone.
   */
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;

  const IDEAL_WIDTH = 1280;
  const IDEAL_HEIGHT = 720;

  const native = md.getUserMedia.bind(md);

  md.getUserMedia = function (constraints) {
    try {
      const video = constraints && constraints.video;
      const unsized =
        video && typeof video === 'object' &&
        video.width === undefined && video.height === undefined;

      if (unsized) {
        constraints = {
          ...constraints,
          video: { ...video, width: { ideal: IDEAL_WIDTH }, height: { ideal: IDEAL_HEIGHT } }
        };
      }
    } catch (error) {
      // Never let a tuning attempt stop the camera opening.
      return native(constraints);
    }

    return native(constraints).then((stream) => {
      // Publish what we actually got. `ideal` is a request, not a guarantee,
      // so this is the only way to know the ceiling took effect on a device.
      try {
        const s = stream.getVideoTracks()[0]?.getSettings?.();
        if (s) {
          const min = Math.min(s.width || 0, s.height || 0);
          window.__steakoutCamera = {
            width: s.width, height: s.height, frameRate: s.frameRate,
            detectionCrop: min ? 2 ** Math.round(Math.log2(min)) : null
          };
        }
      } catch (error) { /* reporting only */ }
      return stream;
    });
  };
})();
