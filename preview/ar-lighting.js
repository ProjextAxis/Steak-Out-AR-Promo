/*
 * The AR scene had no image-based lighting and no tone mapping, while the promo
 * page renders the same model through model-viewer with environment-image
 * "neutral" and ACES Filmic. That is the whole reason the meal looks flat in AR
 * and rich on the landing page -- same geometry, same textures, different light.
 *
 * three r158 ships PMREMGenerator but A-Frame's bundle does not expose
 * RoomEnvironment, so the neutral room is built here and baked to an env map.
 *
 * The default punctual lights are dimmed rather than removed: if the bake ever
 * fails, the meal is still lit instead of rendering black.
 */
AFRAME.registerComponent('ar-environment', {
  schema: {
    exposure: { type: 'number', default: 1.0 },
    ambient: { type: 'number', default: 0.12 },
    directional: { type: 'number', default: 0.18 }
  },

  init: function () {
    this.applied = false;
    this.apply = this.apply.bind(this);
    if (this.el.renderer) this.apply();
    else this.el.addEventListener('render-target-loaded', this.apply, { once: true });

    // A-Frame injects its default lights after the renderer exists, and if the
    // scene has already fired 'loaded' the listener alone never runs. Sweep on
    // the event, immediately when already loaded, and once more on a short
    // delay to catch lights added late.
    this.el.addEventListener('loaded', this.apply);
    if (this.el.hasLoaded) this.apply();
    this.sweepTimer = setTimeout(this.apply, 600);
  },

  buildRoom: function (THREE) {
    const room = new THREE.Scene();
    const box = new THREE.BoxGeometry();
    const panel = (color, intensity, w, h, d, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(box, new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: color, emissiveIntensity: intensity, side: THREE.BackSide
      }));
      m.scale.set(w, h, d); m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      room.add(m);
      return m;
    };
    // Enclosing shell: soft, slightly warm, so white ceramic does not go blue.
    const shell = new THREE.Mesh(box, new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xf2efe9, emissiveIntensity: 0.42, side: THREE.BackSide
    }));
    shell.scale.set(12, 6, 12);
    room.add(shell);
    // Overhead key, the dominant source for food on a table.
    panel(0xffffff, 1.5, 5.2, 0.1, 5.2, 0, 2.9, 0, 0, 0);
    // Side fills at different strengths so the model gets a gradient, not flat wash.
    panel(0xffffff, 0.5, 0.1, 3.2, 5.0, -5.6, 1.0, 0, 0, 0);
    panel(0xfff4e6, 0.32, 0.1, 3.2, 5.0, 5.6, 1.0, 0, 0, 0);
    // Front bounce keeps the near rim of the plate from going muddy.
    panel(0xffffff, 0.26, 5.0, 2.4, 0.1, 0, 0.8, 5.6, 0, 0);
    return room;
  },

  apply: function () {
    const el = this.el;
    const renderer = el.renderer;
    if (!renderer || this.applied) { this.dimDefaults(); return; }
    const THREE = AFRAME.THREE;

    try {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = this.data.exposure;

      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const room = this.buildRoom(THREE);
      const rt = pmrem.fromScene(room, 0.04);
      el.object3D.environment = rt.texture;
      this.envRT = rt;
      pmrem.dispose();
      room.traverse((o) => { if (o.isMesh) o.material.dispose(); });

      this.applied = true;
      el.setAttribute('data-ar-environment', 'ready');
    } catch (error) {
      console.warn('[ar-environment] bake failed, keeping punctual lights:', error);
      el.setAttribute('data-ar-environment', 'fallback');
      return; // leave the default lights at full strength
    }

    this.dimDefaults();
  },

  // With an env map doing the work, full-strength defaults wash the model out.
  dimDefaults: function () {
    if (!this.applied) return;
    const scene = this.el.object3D;
    if (!scene) return;
    scene.traverse((o) => {
      if (!o.isLight) return;
      // Identify the shadow rig by name, not by castShadow: A-Frame's own
      // default directional light is also a caster, so a castShadow guard
      // protects the very light that needs dimming.
      if (typeof o.name === 'string' && o.name.indexOf('steakoutShadow') === 0) return;
      if (o.userData && o.userData.steakoutShadowLight) return;

      if (o.isAmbientLight && o.intensity > this.data.ambient) o.intensity = this.data.ambient;
      else if (o.isDirectionalLight && o.intensity > this.data.directional) {
        o.intensity = this.data.directional;
      }
    });
  },

  remove: function () {
    clearTimeout(this.sweepTimer);
    if (this.envRT) { this.el.object3D.environment = null; this.envRT.dispose(); }
  }
});
