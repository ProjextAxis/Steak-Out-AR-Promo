(() => {
  const install = async () => {
    const splashLogo = document.querySelector('#splash-logo');
    if (!splashLogo) return;

    try {
      const response = await fetch('./assets/STEAK OUT LOGO.svg', { cache: 'force-cache' });
      if (!response.ok) throw new Error(`SVG ${response.status}`);
      const source = await response.text();
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      const svg = doc.documentElement;
      const firstPath = svg.querySelector('path');
      const fill = firstPath?.getAttribute('fill')?.toLowerCase();
      const pathData = firstPath?.getAttribute('d') || '';

      if ((fill === '#ffffff' || fill === '#fff' || fill === 'white') && /^M\s*0(?:\.0+)?\s+0(?:\.0+)?/i.test(pathData)) {
        firstPath.remove();
      }

      svg.removeAttribute('width');
      svg.removeAttribute('height');
      const cleaned = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(new Blob([cleaned], { type: 'image/svg+xml' }));
      splashLogo.src = url;

      // Give the HEADER logo the same artwork. The splash logo docks onto the
      // header logo and then hands over to it -- but they were different images:
      // this cleaned SVG at 173x150 with object-fit:fill, versus a 128x128 webp
      // with object-fit:contain. Landing on the identical rect still swapped one
      // rendering for another, so the bull visibly jumped size and proportion at
      // the handoff. Same source and same fit means the swap is invisible.
      const headerLogo = document.querySelector('.marker-logo-home img');
      if (headerLogo) {
        headerLogo.src = url;
        headerLogo.style.objectFit = 'fill';
      }
    } catch (error) {
      console.warn('Could not clean marker splash SVG:', error);
    }
  };

  install();
})();
