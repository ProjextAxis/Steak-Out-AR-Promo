(() => {
  const config = window.STEAKOUT_AR_CONFIG || {};
  const markerConfig = config.marker || {};
  const scene = document.querySelector('#marker-scene');
  const anchor = document.querySelector('#marker-anchor');
  const food = document.querySelector('#marker-food');
  const startButton = document.querySelector('#marker-start');
  const intro = document.querySelector('#marker-intro');
  const guide = document.querySelector('#marker-scan-guide');
  const sizeControl = document.querySelector('#marker-size-control');
  const status = document.querySelector('#marker-status');
  const down = document.querySelector('#scale-down');
  const up = document.querySelector('#scale-up');
  const scaleOutput = document.querySelector('#scale-output');

  if (!scene || !anchor || !food || !startButton) return;

  let scale = Number(markerConfig.modelScale || 0.32);
  const initialScale = scale;
  const minScale = Number(markerConfig.minScale || 0.08);
  const maxScale = Number(markerConfig.maxScale || 1.25);
  const step = Number(markerConfig.scaleStep || 0.04);

  const setStatus = (label, state = '') => {
    if (!status) return;
    status.textContent = label;
    status.dataset.state = state;
  };

  const applyScale = () => {
    food.setAttribute('scale', `${scale} ${scale} ${scale}`);
    if (scaleOutput) scaleOutput.textContent = `${Math.round((scale / initialScale) * 100)}%`;
  };

  const clampScale = (next) => Math.min(maxScale, Math.max(minScale, next));

  food.setAttribute('src', config.modelUrl || '');
  food.setAttribute('position', markerConfig.modelPosition || '0 0 0.12');
  food.setAttribute('rotation', markerConfig.modelRotation || '90 0 0');
  applyScale();

  const getArSystem = async () => {
    if (!scene.hasLoaded) {
      await new Promise((resolve) => scene.addEventListener('loaded', resolve, { once: true }));
    }
    return scene.systems['mindar-image-system'];
  };

  const start = async () => {
    try {
      setStatus('STARTING', 'busy');
      intro.hidden = true;
      guide.hidden = false;
      sizeControl.hidden = false;

      const arSystem = await getArSystem();
      if (!arSystem) throw new Error('MindAR image system failed to initialize.');

      await arSystem.start();
      setStatus('SCANNING', 'busy');
    } catch (error) {
      console.error(error);
      setStatus('CAMERA ERROR', 'error');
      intro.hidden = false;
      guide.hidden = true;
      sizeControl.hidden = true;
    }
  };

  anchor.addEventListener('targetFound', () => {
    setStatus('LOCKED', 'active');
    guide.querySelector('strong').textContent = 'LOCKED TO MARKER';
    guide.querySelector('span:last-child').textContent = 'Move around it. The meal should stay attached to the printed target.';
  });

  anchor.addEventListener('targetLost', () => {
    setStatus('SEARCHING', 'busy');
    guide.querySelector('strong').textContent = 'FIND THE MARKER AGAIN';
    guide.querySelector('span:last-child').textContent = 'Keep the full printed target visible and reduce glare on the glass.';
  });

  down?.addEventListener('click', () => {
    scale = clampScale(Number((scale - step).toFixed(3)));
    applyScale();
  });

  up?.addEventListener('click', () => {
    scale = clampScale(Number((scale + step).toFixed(3)));
    applyScale();
  });

  startButton.addEventListener('click', start);
})();
