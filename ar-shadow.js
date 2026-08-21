/*
  Steak Out AR — contact shadow.

  The meal used to float: no shadow meant no contact, so the plate read as a
  sticker pasted over the flyer instead of an object resting on it. This adds
  two grounding layers, both parented to the tracked marker so they travel with
  the printed flyer:

    1. A soft baked "pool" of darkness (a radial-gradient plane) that hugs the
       plate's footprint. This is ambient occlusion — the light a plate blocks
       just by sitting there. It costs nothing per frame and it is also the
       fallback: if shadow maps are unavailable, this alone still grounds the
       meal.

    2. A real cast shadow: one directional light, near-vertical, rendered onto
       a THREE.ShadowMaterial plane. ShadowMaterial is alpha-zero everywhere it
       is not shadowed, so the camera feed shows through the plane untouched —
       essential, because the a-scene runs with `renderer="alpha: true"` and an
       ordinary opaque ground plane would black out the video.

  Everything is sized from the meal's MEASURED bounding box rather than from
  hard-coded numbers, so changing `marker.modelScale` in config.js re-fits the
  shadow automatically. Lengths in the schema are multiples of that footprint.

  Two structural facts drive the geometry, both verified against the asset:
    * The GLB's origin is at its base (POSITION Y runs 0 -> 0.1198), and
      marker.js rotates it "90 0 0", which maps model +Y onto the anchor's +Z.
      So the plate's underside sits exactly on the anchor's z = 0 plane, which
      is the printed flyer. The shadow planes therefore need no rotation, only
      a hair of lift out of z = 0.
    * MindAR's anchor carries a large world-space scale (its post-matrix scales
      anchor-local units by the target's pixel width). A directional light's
      shadow camera is positioned and sized in WORLD units, so the orthographic
      frustum has to be multiplied by that live scale or the shadow silently
      misses the meal entirely. `tick` tracks it.
*/
(() => {
  if (typeof AFRAME === 'undefined' || !AFRAME.registerComponent) return;
  if (AFRAME.components['ar-contact-shadow']) return;

  const THREE = AFRAME.THREE;

  // Alpha falloff of the baked pool, as (radius fraction, alpha) pairs. It
  // stays near-solid out to 0.55 and then rolls off, so the part that actually
  // peeks out past the plate rim is a tight, soft fringe rather than a halo.
  const POOL_STOPS = [
    [0.00, 1.00], [0.55, 1.00], [0.72, 0.92], [0.82, 0.72],
    [0.90, 0.44], [0.95, 0.22], [0.98, 0.08], [1.00, 0.00]
  ];

  const buildPoolTexture = () => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    POOL_STOPS.forEach(([stop, alpha]) => gradient.addColorStop(stop, `rgba(0, 0, 0, ${alpha})`));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    return texture;
  };

  AFRAME.registerComponent('ar-contact-shadow', {
    schema: {
      // The entity whose model casts the shadow and whose bounds set the scale.
      caster: { default: '#marker-food' },
      // Darkness of the cast shadow and of the baked pool. Kept low on purpose:
      // a printed flyer under diffuse indoor light does not throw a hard blot.
      opacity: { default: 0.30, min: 0, max: 1 },
      poolOpacity: { default: 0.30, min: 0, max: 1 },
      // Sizes as multiples of the meal's footprint.
      poolSize: { default: 1.18, min: 0 },
      receiverSize: { default: 1.30, min: 0 },
      // Light position in footprint units, relative to the meal's centre on the
      // flyer. Mostly overhead (z) with a small lean so the shadow reads as
      // directional without sliding out from under the plate.
      lightOffset: { type: 'vec3', default: { x: 0.12, y: 0.19, z: 1.15 } },
      lightIntensity: { default: 0, min: 0 },
      shadowMapSize: { default: 512, min: 64 },
      // Lift out of the flyer plane, in footprint units.
      lift: { default: 0.0015, min: 0 },
      // Driven by marker.js so the shadow fades with the placement ghost.
      strength: { default: 1, min: 0, max: 1 },
      helper: { default: false }
    },

    init() {
      this.built = false;
      this.measured = false;
      this.worldScale = 0;
      this.footprint = 0;
      this.centre = { x: 0, y: 0 };
      this.orthoHalf = 0;
      this.shadowNear = 0;
      this.shadowFar = 0;

      this.group = null;
      this.pool = null;
      this.receiver = null;
      this.light = null;
      this.lightRig = null;
      this.geometry = null;
      this.poolTexture = null;
      this.helperObject = null;

      this.matrix = new THREE.Matrix4();
      this.onModelLoaded = this.measure.bind(this);
      this.setState('pending');

      const sceneEl = this.el.sceneEl;
      if (!sceneEl) return;
      if (sceneEl.renderer) this.build();
      else sceneEl.addEventListener('renderstart', () => this.build(), { once: true });
    },

    update(oldData) {
      this.applyStrength();
      if (!this.built) return;

      const data = this.data;
      const previous = oldData || {};

      if (this.light && data.shadowMapSize !== previous.shadowMapSize) {
        this.light.shadow.mapSize.set(data.shadowMapSize, data.shadowMapSize);
        if (this.light.shadow.map) {
          this.light.shadow.map.dispose();
          this.light.shadow.map = null;
        }
      }

      if (this.measured) this.applyLayout();
    },

    setState(state) {
      this.el.setAttribute('data-ar-shadow', state);
    },

    /* ---------------------------------------------------------------- build */

    build() {
      const sceneEl = this.el.sceneEl;
      if (!sceneEl || this.built) return;

      this.group = new THREE.Group();
      this.group.name = 'steakoutContactShadow';
      this.el.setObject3D('contactShadow', this.group);

      this.geometry = new THREE.PlaneGeometry(1, 1);

      // Layer 1 — the baked pool. Always present, never needs a shadow map.
      this.poolTexture = buildPoolTexture();
      if (this.poolTexture) {
        this.pool = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({
          map: this.poolTexture,
          color: 0x000000,
          transparent: true,
          opacity: this.data.poolOpacity,
          depthWrite: false,
          toneMapped: false
        }));
        this.pool.name = 'steakoutShadowPool';
        this.pool.castShadow = false;
        this.pool.receiveShadow = false;
        // Drawn ahead of the meal so the placement ghost blends over it.
        this.pool.renderOrder = -2;
        this.pool.visible = false;
        this.group.add(this.pool);
      }

      // Layer 2 — the real cast shadow, only if the renderer will give us one.
      if (this.enableShadowMap()) {
        this.buildCastShadow();
        // A-Frame injects its default lights on the scene's `loaded` event,
        // which can land after the renderer exists and therefore after this
        // runs. Sweep now and again once the scene has finished loading.
        this.retireCompetingShadowCasters();
        if (!sceneEl.hasLoaded) {
          sceneEl.addEventListener('loaded', () => this.retireCompetingShadowCasters(), { once: true });
        }
      }

      this.built = true;

      const caster = document.querySelector(this.data.caster);
      this.casterEl = caster;
      if (!caster) {
        this.setState('no-caster');
        return;
      }
      caster.addEventListener('model-loaded', this.onModelLoaded);
      if (caster.getObject3D('mesh')) this.measure();
      else this.setState(this.light ? 'waiting-for-model' : 'waiting-for-model-pool-only');
    },

    /*
      A-Frame leaves renderer.shadowMap.enabled false until something asks for
      it, and its shadow system can only apply the flag once the renderer
      exists — which is after the system itself initialises. So ask twice: once
      through the system (keeps its bookkeeping honest and respects
      `shadow="enabled: false"` on the scene) and once directly.
    */
    enableShadowMap() {
      const sceneEl = this.el.sceneEl;
      const renderer = sceneEl && sceneEl.renderer;
      if (!renderer || !renderer.shadowMap || !THREE.ShadowMaterial) return false;

      try {
        const system = sceneEl.systems && sceneEl.systems.shadow;
        if (system && system.setShadowMapEnabled) system.setShadowMapEnabled(true);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.autoUpdate = true;
        if (THREE.PCFSoftShadowMap !== undefined) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      } catch (error) {
        console.warn('Steak Out AR: shadow maps unavailable, falling back to the baked pool.', error);
        return false;
      }

      if (!renderer.shadowMap.enabled) return false;

      // shadowMap.enabled and shadowMap.type are both part of three's program
      // cache key, so anything already compiled needs a relink.
      sceneEl.object3D.traverse((node) => {
        if (!node.material) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((material) => { material.needsUpdate = true; });
      });

      return true;
    },

    /*
      A-Frame's injected default directional light ships with castShadow: true.
      Harmless while shadow maps are off — but the moment we switch them on it
      would render a second shadow map every frame and throw a second shadow
      from a world-space direction that swings around as the phone moves. Turn
      its shadow off while leaving the light itself (and the ambient light)
      exactly as they are, so the meal's shading does not change at all.
    */
    retireCompetingShadowCasters() {
      document.querySelectorAll('[data-aframe-default-light]').forEach((el) => {
        const light = el.getObject3D && el.getObject3D('light');
        if (light && light.castShadow) light.castShadow = false;
        const component = el.components && el.components.light;
        if (component && component.data && component.data.castShadow) {
          el.setAttribute('light', 'castShadow', false);
        }
      });
    },

    /*
      The light lives on the scene root rather than inside the marker anchor,
      and `tick` copies the anchor's transform onto it. Two reasons:

        * MindAR keeps the anchor invisible until the flyer is found, and three
          skips invisible subtrees entirely — so a light parented under the
          anchor would be absent from the lights list until the first lock, and
          every material in the scene would have to recompile at exactly the
          moment the meal appears. Out here the light count never changes.
        * It still has to be rigid with respect to the flyer, or the shadow
          would swing as the phone moves. Copying the anchor matrix gives that,
          with no frame of lag: the anchor's parent is the scene, and we read
          the same local matrix the renderer is about to use this frame.
    */
    buildCastShadow() {
      const data = this.data;

      this.receiver = new THREE.Mesh(this.geometry, new THREE.ShadowMaterial({
        opacity: data.opacity,
        transparent: true,
        depthWrite: false
      }));
      this.receiver.name = 'steakoutShadowReceiver';
      this.receiver.receiveShadow = true;
      this.receiver.castShadow = false;
      this.receiver.renderOrder = -1;
      this.receiver.visible = false;
      this.group.add(this.receiver);

      this.lightRig = new THREE.Group();
      this.lightRig.name = 'steakoutShadowLightRig';
      this.lightRig.matrixAutoUpdate = false;

      // Intensity 0 by default: this light exists to produce a shadow mask, not
      // to relight the meal. ShadowMaterial's alpha comes from the shadow test,
      // not from the light's colour, so the meal keeps A-Frame's default
      // lighting untouched.
      this.light = new THREE.DirectionalLight(0xffffff, data.lightIntensity);
      this.light.name = 'steakoutShadowLight';
      this.light.castShadow = true;
      this.light.shadow.mapSize.set(data.shadowMapSize, data.shadowMapSize);
      // Nothing here self-shadows (the planes never cast, the meal never
      // receives), so no bias is needed and any bias would only push the
      // shadow off its contact edge. Raise these only if the meal is ever set
      // to receive shadows.
      this.light.shadow.bias = 0;
      this.light.shadow.normalBias = 0;
      this.lightRig.add(this.light);

      this.light.target = new THREE.Object3D();
      this.light.target.name = 'steakoutShadowLightTarget';
      this.lightRig.add(this.light.target);

      this.el.sceneEl.object3D.add(this.lightRig);
    },

    /* -------------------------------------------------------------- measure */

    /*
      Bounding box of the loaded meal expressed in the marker anchor's own
      space. Box3.setFromObject would give world space, which is useless here:
      MindAR parks the anchor on a zero matrix until it locks on. So walk the
      local matrix chain instead, starting from identity at the caster entity —
      the caster and this entity are both untransformed children of the anchor,
      so the result drops straight into our local coordinates.
    */
    measure() {
      if (!this.built || !this.casterEl || !this.casterEl.object3D) return;

      const box = new THREE.Box3();
      const walk = (object, parentMatrix) => {
        if (object.matrixAutoUpdate) object.updateMatrix();
        const matrix = parentMatrix.clone().multiply(object.matrix);
        if (object.isMesh && object.geometry) {
          if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
          if (object.geometry.boundingBox) {
            box.union(object.geometry.boundingBox.clone().applyMatrix4(matrix));
          }
        }
        object.children.forEach((child) => walk(child, matrix));
      };
      walk(this.casterEl.object3D, new THREE.Matrix4());

      if (box.isEmpty()) {
        this.setState('unmeasurable');
        return;
      }

      // x/y span the flyer, z stands off it.
      this.footprint = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
      this.centre.x = (box.max.x + box.min.x) / 2;
      this.centre.y = (box.max.y + box.min.y) / 2;
      this.height = box.max.z - Math.min(0, box.min.z);

      if (!(this.footprint > 0)) {
        this.setState('unmeasurable');
        return;
      }

      this.measured = true;
      // Last sweep: model-loaded always lands after the scene has loaded, so
      // any default light that appeared late is definitely caught here.
      if (this.light) this.retireCompetingShadowCasters();
      this.el.setAttribute('data-ar-shadow-footprint', this.footprint.toFixed(4));
      this.el.setAttribute('data-ar-shadow-height', this.height.toFixed(4));
      this.applyLayout();
      this.setState(this.light ? 'ready' : 'ready-pool-only');
    },

    applyLayout() {
      const data = this.data;
      const footprint = this.footprint;
      const lift = footprint * data.lift;

      if (this.pool) {
        const size = footprint * data.poolSize;
        this.pool.scale.set(size, size, 1);
        this.pool.position.set(this.centre.x, this.centre.y, lift);
      }

      if (this.receiver) {
        const size = footprint * data.receiverSize;
        this.receiver.scale.set(size, size, 1);
        this.receiver.position.set(this.centre.x, this.centre.y, lift * 2);
        // Frustum exactly covers the receiver: no wasted shadow-map texels, and
        // nothing that could catch a shadow falls outside it.
        this.orthoHalf = size / 2;
      }

      if (this.light) {
        this.light.position.set(
          this.centre.x + footprint * data.lightOffset.x,
          this.centre.y + footprint * data.lightOffset.y,
          footprint * data.lightOffset.z
        );
        this.light.target.position.set(this.centre.x, this.centre.y, 0);
        // Brackets the meal comfortably: the light sits ~1.17 footprints off
        // the flyer, the meal's crown reaches ~0.34 of a footprint up.
        this.shadowNear = footprint * 0.35;
        this.shadowFar = footprint * 2.60;
        // Force a frustum rebuild on the next tick.
        this.worldScale = 0;
      }

      this.applyStrength();
      this.updateHelper();
    },

    applyStrength() {
      const strength = Math.max(0, Math.min(1, this.data.strength));
      const live = this.measured && strength > 0.001;

      if (this.pool) {
        this.pool.material.opacity = this.data.poolOpacity * strength;
        this.pool.visible = live;
      }
      if (this.receiver) {
        this.receiver.material.opacity = this.data.opacity * strength;
        this.receiver.visible = live;
      }
    },

    /* ----------------------------------------------------------------- tick */

    tick() {
      const light = this.light;
      const rig = this.lightRig;
      if (!light || !rig || !this.measured) return;

      const anchor = this.el.parentEl && this.el.parentEl.object3D;
      if (!anchor) return;

      const parent = anchor.parent;
      if (parent) this.matrix.multiplyMatrices(parent.matrixWorld, anchor.matrix);
      else this.matrix.copy(anchor.matrix);

      const e = this.matrix.elements;
      const scale = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      // MindAR parks a lost target on an all-zero matrix; never adopt it.
      if (!(scale > 1e-8) || !Number.isFinite(scale)) return;

      rig.matrix.copy(this.matrix);
      rig.matrixWorldNeedsUpdate = true;

      // A directional light's shadow camera is placed and sized in WORLD units,
      // but everything above is in anchor-local units, and MindAR's anchor
      // carries a large scale. Re-fit the frustum whenever that scale moves.
      if (Math.abs(scale - this.worldScale) > this.worldScale * 0.01) {
        this.worldScale = scale;
        const camera = light.shadow.camera;
        camera.left = -this.orthoHalf * scale;
        camera.right = this.orthoHalf * scale;
        camera.top = this.orthoHalf * scale;
        camera.bottom = -this.orthoHalf * scale;
        camera.near = this.shadowNear * scale;
        camera.far = this.shadowFar * scale;
        camera.updateProjectionMatrix();
        this.el.setAttribute('data-ar-shadow-world-scale', scale.toFixed(4));
        this.updateHelper();
      }
    },

    /* --------------------------------------------------------------- helper */

    // On-device tuning aid: `ar-contact-shadow="helper: true"` draws the shadow
    // camera frustum. Off by default and never shipped on.
    updateHelper() {
      if (!this.lightRig) return;
      if (this.data.helper && !this.helperObject && this.light) {
        this.helperObject = new THREE.CameraHelper(this.light.shadow.camera);
        this.el.sceneEl.object3D.add(this.helperObject);
      }
      if (!this.data.helper && this.helperObject) {
        this.el.sceneEl.object3D.remove(this.helperObject);
        this.helperObject.dispose();
        this.helperObject = null;
      }
      if (this.helperObject) this.helperObject.update();
    },

    /* --------------------------------------------------------------- remove */

    remove() {
      if (this.casterEl) this.casterEl.removeEventListener('model-loaded', this.onModelLoaded);
      if (this.helperObject) {
        this.el.sceneEl.object3D.remove(this.helperObject);
        this.helperObject.dispose();
        this.helperObject = null;
      }
      if (this.lightRig) {
        if (this.light && this.light.shadow && this.light.shadow.map) {
          this.light.shadow.map.dispose();
          this.light.shadow.map = null;
        }
        this.el.sceneEl.object3D.remove(this.lightRig);
        this.lightRig = null;
        this.light = null;
      }
      if (this.pool) this.pool.material.dispose();
      if (this.receiver) this.receiver.material.dispose();
      if (this.poolTexture) this.poolTexture.dispose();
      if (this.geometry) this.geometry.dispose();
      if (this.el.getObject3D('contactShadow')) this.el.removeObject3D('contactShadow');
      this.pool = null;
      this.receiver = null;
      this.built = false;
      this.measured = false;
    }
  });
})();
