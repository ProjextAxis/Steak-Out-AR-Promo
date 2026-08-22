/* Public-engine diagnostic overlay. It is opt-in with ?xray=1 and never
 * participates in camera or tracking control. */
(() => {
  if (new URLSearchParams(location.search).get('xray') !== '1') return;

  const scene = document.querySelector('#marker-scene');
  if (!scene) return;
  const state = {
    camera: 'not requested',
    tracking: 'not started',
    image: 'not found',
    pose: '',
    readyAt: 0,
    foundAt: 0
  };

  scene.addEventListener('camerastatuschange', ({ detail = {} }) => {
    state.camera = detail.status || 'unknown';
  });
  scene.addEventListener('realityready', () => {
    state.readyAt = performance.now();
  });
  scene.addEventListener('xrtrackingstatus', ({ detail = {} }) => {
    state.tracking = detail.status || detail.state || 'active';
  });
  scene.addEventListener('xrimagescanning', () => {
    state.image = 'scanning';
  });
  scene.addEventListener('xrimagefound', ({ detail = {} }) => {
    state.image = 'found ' + (detail.name || 'target');
    state.foundAt = performance.now();
    state.pose = poseSummary(detail);
  });
  scene.addEventListener('xrimageupdated', ({ detail = {} }) => {
    state.image = 'tracking ' + (detail.name || 'target');
    state.pose = poseSummary(detail);
  });
  scene.addEventListener('xrimagelost', ({ detail = {} }) => {
    state.image = 'lost ' + (detail.name || 'target');
  });
  scene.addEventListener('realityerror', ({ detail = {} }) => {
    const error = detail.error || detail;
    state.camera = 'error ' + (error?.name || 'unknown');
  });

  const poseSummary = (detail) => {
    const p = detail.position;
    const width = Number(detail.scale) * Number(detail.scaledWidth);
    if (!p) return '';
    const widthText = Number.isFinite(width) ? width.toFixed(3) + 'm flyer' : 'width ?';
    return `pose ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}  ${widthText}`;
  };

  const canvas = document.createElement('canvas');
  canvas.id = 'ar-xray';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:21;pointer-events:none';
  document.body.appendChild(canvas);

  const elapsed = (time) => time ? ((performance.now() - time) / 1000).toFixed(1) + 's' : 'never';
  const draw = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = '600 13px ui-monospace, Menlo, monospace';
    const lines = [
      'ENGINE 8th Wall SLAM',
      'camera ' + state.camera,
      'tracking ' + state.tracking,
      'image ' + state.image,
      state.pose || 'pose waiting',
      'ready ' + elapsed(state.readyAt),
      'found ' + elapsed(state.foundAt)
    ];
    const boxWidth = Math.min(width - 20, Math.max(...lines.map((line) => context.measureText(line).width)) + 20);
    const lineHeight = 19;
    context.fillStyle = 'rgba(0,0,0,.64)';
    context.fillRect(10, 106, boxWidth, lines.length * lineHeight + 12);
    context.fillStyle = '#7fffb1';
    lines.forEach((line, index) => context.fillText(line, 20, 106 + lineHeight + index * lineHeight));
    requestAnimationFrame(draw);
  };
  draw();
})();
