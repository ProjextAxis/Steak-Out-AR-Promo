'use strict';

/* THE AR FRAME'S MESSAGES, CHECKED WITHOUT A CAMERA (2026-10-08).
 *
 *   node preview/tools/test-marker-events.js              (from the repo root)
 *   node preview/tools/test-marker-events.js --selftest
 *
 * Plain node, no packages. It runs the REAL marker.js and the REAL
 * ar-anchor-stability.js inside the real marker.html, in a fake browser: a fake
 * A-Frame scene, a fake 8th Wall engine that "has video" when the test says so,
 * a fake clock and fake timers, and a parent window that writes down every
 * message it is sent. The test feeds the scene what a camera looking at the
 * flyer would: tracking NORMAL, then a steady pose every 60 ms.
 *
 * What it proves, about the messages marker.js sends the landing page:
 *   M1. START CAMERA to camera live: camera_live carries ms (from START
 *       CAMERA) and run, once;
 *   M2. the meal still LOCKS onto a steady flyer, exactly as before (the
 *       anchor is shown, the locked copy is on screen, ORDER NOW is there),
 *       and lock carries ms (from camera live) and run, once;
 *   M3. the flyer lost AFTER the lock is lost / refound with run, n, ms;
 *       a second loss with no refound between is the same loss; a loss before
 *       the lock is not reported; at most ten a run; refound only for a loss
 *       that was reported; the true count still reaches ar_closed;
 *   M4. every way out of the AR (the logo, Escape, GO BACK on the fault panel)
 *       sends ar_closed's numbers: run, ms in AR, ms locked, times lost;
 *   M5. a second START CAMERA is run 2, with nothing carried over;
 *   M6. a camera fault sends a short code (permission, busy, no_camera,
 *       other) and the panel the customer reads is the one it always was;
 *       the AR helper not loading sends "load";
 *   M7. a tap on a tagged button in the AR (ORDER NOW, close) is passed up
 *       with where it landed; a tap on anything else, or by a script, is not;
 *   M8. outside the landing page's frame nothing is posted and nothing breaks;
 *   R.  the run number is kept in the tab's sessionStorage, so a RELOAD of the
 *       tab does not start counting from 1 again (Orbit tells runs apart by
 *       visit and run, and the visit survives a reload); with no storage, or
 *       garbage in it, the count still works and nothing breaks.
 *
 * NOT proven here: the real engine, a real camera, a real phone. The lock rule
 * itself (ar-anchor-stability.js) has its own test, test-anchor-stability.js.
 *
 * --selftest re-breaks the real source text (one mutation at a time, in memory
 * only) and fails unless the named check goes red. It also fails if any check
 * is never made red by some mutation.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { El, Target, parseHtml, selectAll, hooks } = require('./fake-dom.js');

const previewRoot = path.resolve(__dirname, '..');
const FILES = {
  marker: 'marker.js',
  markerHtml: 'marker.html',
  config: 'config.js',
  stability: 'ar-anchor-stability.js'
};

function loadText(mutations = []) {
  const text = {};
  for (const [key, file] of Object.entries(FILES)) text[key] = fs.readFileSync(path.join(previewRoot, file), 'utf8');
  for (const m of mutations) {
    const hits = text[m.file].split(m.from).length - 1;
    if (hits !== 1) throw new Error(`mutation "${m.name}": expected 1 match of its text in ${m.file}, found ${hits}`);
    text[m.file] = text[m.file].replace(m.from, () => m.to);
  }
  return text;
}

const POSE = {
  name: 'steakout-flyer',
  position: { x: 0.02, y: 1.4, z: -0.5 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: 0.2,
  scaledWidth: 1,
  scaledHeight: 1.3
};

function fakeObject3D() {
  const vec = () => ({
    x: 0, y: 0, z: 0,
    set(x, y, z) { this.x = x; this.y = y; this.z = z; },
    setScalar(v) { this.x = this.y = this.z = v; },
    toArray() { return [this.x, this.y, this.z]; },
    distanceTo() { return 0; },
    lerp() {}
  });
  const quat = { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }, toArray() { return [this.x, this.y, this.z, this.w]; }, angleTo() { return 0; }, rotateTowards() {} };
  const matrix = { toArray: () => new Array(16).fill(0) };
  return { visible: false, position: vec(), quaternion: quat, scale: vec(), matrix, matrixWorld: matrix, updateMatrix() {}, updateMatrixWorld() {} };
}

/**
 * The real marker.html, marker.js and ar-anchor-stability.js, a fake browser.
 * opts: embedded (default true), stability (default true).
 */
function openMarker(text, opts = {}) {
  const o = { embedded: true, stability: true, storage: null, ...opts };
  let clock = 10000;
  let timerSeq = 0;
  const timers = [];
  const toParent = [];
  const winTarget = new Target();
  const document = new Target();
  document.readyState = 'complete';
  document.visibilityState = 'visible';
  const elements = parseHtml(text.markerHtml, document);
  document.querySelectorAll = (sel) => selectAll(elements, sel);
  document.querySelector = (sel) => selectAll(elements, sel)[0] || null;
  document.createElement = (tag) => new El(tag, {}, null);
  const byId = (id) => elements.find((e) => e.getAttribute('id') === id);

  const parent = { postMessage: (message, origin) => { toParent.push({ message, origin, at: clock }); } };
  const sandbox = {
    document,
    URL,
    URLSearchParams,
    // the 'AR helper did not load' scenario logs an error on purpose; keep the output clean
    console: o.stability ? console : { ...console, error() {} },
    Promise,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    innerWidth: 400,
    innerHeight: 800,
    location: { search: o.embedded ? '?embedded=1' : '', href: 'https://lunch.mysteakout.com/preview/marker.html' + (o.embedded ? '?embedded=1' : ''), origin: 'https://lunch.mysteakout.com' },
    performance: { now: () => clock },
    fetch: async () => ({ ok: true, json: async () => ({ imagePath: './x.png' }) }),
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, at: clock + ms, every: ms }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener: (...a) => winTarget.addEventListener(...a),
    removeEventListener: (...a) => winTarget.removeEventListener(...a),
    dispatchEvent: (ev) => fire(sandbox, ev.type, ev),
    parent,
    ...(o.storage ? { sessionStorage: o.storage } : {}),
    localStorage: profile.storage,
    XR8: {
      XrController: { configure() {} },
      _paused: false,
      isPaused() { return this._paused; },
      async pause() { this._paused = true; },
      async resume() { this._paused = false; },
      stop() {}
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // On its own, a window's parent is itself; posting to it would only talk to itself.
  if (!o.embedded) { sandbox.parent = sandbox; sandbox.postMessage = parent.postMessage; }
  vm.createContext(sandbox);

  function fire(target, type, init = {}) {
    const event = {
      type, target, isTrusted: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init
    };
    const chain = [sandbox, document];
    if (target !== sandbox && target !== document) {
      const up = [];
      for (let n = target; n; n = n.parentElement) up.push(n);
      chain.push(...up.reverse());
    }
    if (target === sandbox) chain.length = 1;
    const listenersOf = (node) => (node === sandbox ? winTarget : node);
    const call = (node, phase) => {
      for (const l of [...(listenersOf(node)._listeners[type] || [])]) {
        if (phase === 'target' || (phase === 'capture' && l.capture) || (phase === 'bubble' && !l.capture)) l.fn(event);
      }
    };
    const last = chain.length - 1;
    for (let i = 0; i < last; i++) call(chain[i], 'capture');
    call(chain[last], 'target');
    for (let i = last - 1; i >= 0; i--) call(chain[i], 'bubble');
    return event;
  }
  hooks.fire = fire;

  const scene = byId('marker-scene');
  const anchor = byId('marker-anchor');
  const food = byId('marker-food');
  scene.hasLoaded = true;
  scene.components = { xrweb: {}, xrconfig: {} };
  scene.emit = (name, detail) => fire(scene, name, { detail });
  anchor.object3D = fakeObject3D();
  anchor.emit = () => {};
  food.getObject3D = () => null;

  const run = (code, filename) => vm.runInContext(code, sandbox, { filename });
  run(text.config.slice(0, text.config.indexOf('\n(() => {')), 'config.js');
  if (o.stability) run(text.stability, 'ar-anchor-stability.js');
  run(text.marker, 'marker.js');

  const world = {
    sandbox, scene, anchor, toParent, fire, byId,
    $: (sel) => document.querySelector(sel),
    get now() { return clock; },
    sent: (type) => toParent.filter((m) => m.message.type === type),
    types: () => toParent.map((m) => m.message.type),
    fromParent(type, extra = {}) {
      fire(sandbox, 'message', { source: parent, origin: 'https://lunch.mysteakout.com', data: { type, ...extra } });
    },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers.find((t) => t.at <= until);
        if (!next) break;
        if (next.every) next.at += next.every; else timers.splice(timers.indexOf(next), 1);
        clock = Math.max(clock, next.at - (next.every || 0));
        next.fn();
      }
      clock = until;
    },
    // run the clock in small steps, letting promises settle in between
    async run(ms, step = 20) {
      for (let spent = 0; spent < ms; spent += step) {
        world.advance(Math.min(step, ms - spent));
        await new Promise((r) => setImmediate(r));
      }
    },
    async settle() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); },
    // START CAMERA, camera video 300 ms later, the splash and the reveal, camera live
    async startCamera() {
      const startedAt = clock;
      world.fromParent('steakout-ar-start');
      await world.run(300);
      scene.emit('camerastatuschange', { status: 'hasVideo' });
      await world.run(1700);
      return startedAt;
    },
    // tracking NORMAL and a steady flyer until the meal locks (or `ms` runs out)
    async showFlyer(ms = 3000) {
      scene.emit('xrtrackingstatus', { status: 'NORMAL' });
      const before = world.sent('steakout-ar-locked').length;
      for (let spent = 0; spent < ms && world.sent('steakout-ar-locked').length === before; spent += 60) {
        scene.emit(spent === 0 ? 'xrimagefound' : 'xrimageupdated', POSE);
        await world.run(60);
      }
    },
    flyerLost() { scene.emit('xrimagelost', { name: POSE.name }); },
    flyerFound() { scene.emit('xrimagefound', POSE); },
    click(el, init = {}) { fire(el, 'click', { clientX: 200, clientY: 400, detail: 1, ...init }); }
  };
  return world;
}

// The phone's localStorage: ONE per run of the checks, shared by every page and every tab opened in it (that is
// what makes it localStorage). marker.js must never touch it; `touched` says if it did.
let profile = { touched: false, storage: null };
function newProfile() {
  const data = new Map();
  const mark = () => { profile.touched = true; };
  profile = {
    touched: false,
    storage: { getItem(key) { mark(); return data.has(key) ? data.get(key) : null; }, setItem(key, value) { mark(); data.set(key, String(value)); } }
  };
}
newProfile();

/**
 * A tab's sessionStorage: shared by every page loaded in that tab, gone when the
 * tab is. `throws` is Safari private mode, which throws on every call.
 */
function fakeStorage(initial = {}, { throws = false } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = () => { if (throws) throw new Error('SecurityError: the operation is insecure'); };
  return {
    getItem(key) { guard(); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { guard(); data.set(key, String(value)); }
  };
}

/* ---------------------------------------------------------------- checks */

const detailsOf = (w, type) => w.sent(type).map((m) => m.message.detail);

const CASES = [
  {
    name: 'M a run, as marker.js reports it',
    async run(M, t) {
      const { text } = M;

      // ---- the first run: camera live, lock
      const w = openMarker(text);
      t('M0 the first message is ready, with no detail', [w.types(), w.toParent[0] && w.toParent[0].message.detail], [['steakout-ar-ready'], undefined]);
      const startedAt = await w.startCamera();
      const live = w.sent('steakout-ar-camera-live');
      const liveAt = live.length ? live[0].at : 0;
      t('M1 camera live is sent once, with ms from START CAMERA and the run, after the splash and reveal',
        [live.length, live[0] && live[0].message.detail.run, live[0] && live[0].message.detail.ms === liveAt - startedAt, liveAt - startedAt >= 1870 && liveAt - startedAt < 1950,
          w.sent('steakout-ar-order-shown').length],
        [1, 1, true, true, 1]);
      await w.showFlyer();
      const lock = w.sent('steakout-ar-locked');
      const lockAt = lock.length ? lock[0].at : 0;
      await w.run(1500);                         // a steady flyer for a while longer
      t('M2 the meal locks exactly once on a steady flyer; lock carries ms from camera live and the run',
        [w.sent('steakout-ar-locked').length, lock[0] && lock[0].message.detail.run, lock[0] && lock[0].message.detail.ms === lockAt - liveAt, lockAt - liveAt > 0 && lockAt - liveAt < 4000],
        [1, 1, true, true]);
      t('M2b and the customer sees what they always saw: the meal shown, the locked copy, ORDER NOW',
        [w.anchor.object3D.visible, w.$('#marker-instruction-title').textContent, w.$('#marker-order').hidden, w.anchor.object3D.scale.x, w.byId('marker-food').classList.contains('is-placement-solid')],
        [true, 'YOUR $12 LUNCH IS RIGHT HERE', false, 0.2, true]);

      // ---- losing and finding the flyer after the lock
      w.flyerLost();
      const lostAt = w.now;
      w.flyerLost();                             // the engine says it again: the same loss
      await w.run(800);
      w.flyerFound();
      const foundAt = w.now;
      t('M3 a loss after the lock is lost{run,n:1} once; finding it again is refound{run,ms} with how long it was lost',
        [w.sent('steakout-ar-lost').length, detailsOf(w, 'steakout-ar-lost')[0], w.sent('steakout-ar-refound').length, detailsOf(w, 'steakout-ar-refound')[0]],
        [1, { run: 1, n: 1 }, 1, { run: 1, ms: foundAt - lostAt }]);
      // twelve more losses and returns: only ten are reported, the count is the true one
      for (let i = 0; i < 12; i++) { w.flyerLost(); await w.run(100); w.flyerFound(); await w.run(100); }
      t('M3b at most ten losses are reported in a run, each with its refound; none are made up',
        [w.sent('steakout-ar-lost').length, w.sent('steakout-ar-refound').length, detailsOf(w, 'steakout-ar-lost').map((d) => d.n).join(','), detailsOf(w, 'steakout-ar-refound').every((d) => d.ms >= 0)],
        [10, 10, '1,2,3,4,5,6,7,8,9,10', true]);

      // ---- leaving: the logo, Escape
      await w.run(500);
      const closeAt = w.now;
      w.click(w.$('.marker-logo-home'));
      const closeA = detailsOf(w, 'steakout-ar-close')[0];
      t('M4 leaving by the logo sends ar_closed’s numbers: the run, ms in AR, ms locked, times lost (the true count)',
        closeA, { run: 1, ms: closeAt - liveAt, locked: closeAt - lockAt, lost: 13 });
      w.fire(w.sandbox, 'keydown', { key: 'Escape' });
      t('M4b Escape sends the same, from the same function', [w.sent('steakout-ar-close').length, detailsOf(w, 'steakout-ar-close')[1]], [2, closeA]);

      // ---- a second run
      w.fromParent('steakout-ar-stop');
      await w.run(200);
      const secondStart = await w.startCamera();
      const lives = w.sent('steakout-ar-camera-live');
      const live2 = lives[1];
      await w.showFlyer();
      const lock2 = w.sent('steakout-ar-locked')[1];
      w.flyerLost();
      const close2At = w.now;
      w.fire(w.sandbox, 'keydown', { key: 'Escape' });
      t('M5 the next START CAMERA is run 2, timed from its own start, with nothing carried over from run 1',
        [live2 && live2.message.detail.run, live2 && live2.message.detail.ms === live2.at - secondStart, lock2 && lock2.message.detail.run,
          lock2 && lock2.message.detail.ms === lock2.at - live2.at, detailsOf(w, 'steakout-ar-lost').slice(-1)[0], detailsOf(w, 'steakout-ar-close').slice(-1)[0]],
        [2, true, 2, true, { run: 2, n: 1 }, { run: 2, ms: close2At - live2.at, locked: close2At - lock2.at, lost: 1 }]);
    }
  },
  {
    name: 'R the run number survives a reload of the tab',
    async run(M, t) {
      const { text } = M;
      const RUN_KEY = 'steakout.ar.run';
      // one attempt: START CAMERA, lock, a loss, leave. Returns every `run` it reported.
      const attempt = async (w) => {
        await w.startCamera();
        await w.showFlyer();
        w.flyerLost();
        w.fire(w.sandbox, 'keydown', { key: 'Escape' });
        const runs = (type) => detailsOf(w, type).map((d) => d.run);
        return { live: runs('steakout-ar-camera-live'), lock: runs('steakout-ar-locked'), lost: runs('steakout-ar-lost'), close: runs('steakout-ar-close') };
      };

      const tab = fakeStorage();
      const first = await attempt(openMarker(text, { storage: tab }));
      t('R1 the first attempt in a tab is run 1 in every message, and the count is written down',
        [first, tab.getItem(RUN_KEY)], [{ live: [1], lock: [1], lost: [1], close: [1] }, '1']);

      // the tab reloads (refresh, TRY AGAIN, a phone dropping the tab): a NEW page, the same tab storage
      const reloaded = openMarker(text, { storage: tab });
      const second = await attempt(reloaded);
      t('R2 after a reload of the tab the next attempt is run 2, not run 1 again (or Orbit would throw its timings away as repeats of the first)',
        [second, tab.getItem(RUN_KEY)], [{ live: [2], lock: [2], lost: [2], close: [2] }, '2']);

      reloaded.fromParent('steakout-ar-stop');
      await reloaded.run(200);
      await reloaded.startCamera();
      t('R3 a further attempt in the same page continues, run 3', [detailsOf(reloaded, 'steakout-ar-camera-live').map((d) => d.run), tab.getItem(RUN_KEY)], [[2, 3], '3']);

      const third = await attempt(openMarker(text, { storage: tab }));
      t('R3b and the next reload continues from there, run 4', [third.live, third.close, tab.getItem(RUN_KEY)], [[4], [4], '4']);

      // another tab has its own sessionStorage, so its own count. (The browser's localStorage, shared by every tab
      // on the phone, is there too, and must stay untouched: a count that outlived the tab would start to
      // identify a phone across visits, which is what sessionStorage was chosen to avoid.)
      const otherTab = await attempt(openMarker(text, { storage: fakeStorage() }));
      t('R4 another tab counts from 1 on its own: the count belongs to the tab, never to the phone', [otherTab.live, profile.touched], [[1], false]);

      // no storage (Safari private mode throws on every call): counted in the page, nothing breaks
      const priv = openMarker(text, { storage: fakeStorage({}, { throws: true }) });
      const p1 = await attempt(priv);
      priv.fromParent('steakout-ar-stop');
      await priv.run(200);
      await priv.startCamera();
      t('R5 with a storage that throws the AR still starts, and still counts runs within the page (1, then 2)',
        [p1.live, p1.lock, detailsOf(priv, 'steakout-ar-camera-live').map((d) => d.run)], [[1], [1], [1, 2]]);
      // no storage object at all (an old engine)
      const none = await attempt(openMarker(text));
      t('R5b with no storage at all it is run 1 and nothing breaks', none.live, [1]);

      // garbage in the key is not believed: not a number, a fraction, negative, zero, huge, past what tracking will send
      const garbage = ['abc', '2.5', '-3', '0', '', '1e9', '1000', '99999999999999999999'];
      const got = [];
      for (const value of garbage) got.push((await attempt(openMarker(text, { storage: fakeStorage({ [RUN_KEY]: value }) }))).live[0]);
      t('R6 garbage in the stored count is ignored: the attempt is run 1', got, garbage.map(() => 1));
      // a good number is believed, whatever the page itself has counted
      const trusted = await attempt(openMarker(text, { storage: fakeStorage({ [RUN_KEY]: '7' }) }));
      t('R7 a stored 7 makes the next attempt run 8', trusted.live, [8]);
    }
  },
  {
    name: 'N what is not reported',
    async run(M, t) {
      const { text } = M;
      // a loss before the meal has locked is not a loss
      const w = openMarker(text);
      await w.startCamera();
      w.scene.emit('xrtrackingstatus', { status: 'NORMAL' });
      w.flyerFound();
      await w.run(120);
      w.flyerLost();
      await w.run(100);
      w.flyerFound();
      await w.run(100);
      t('N1 losing the flyer before the meal has locked is not reported (nothing was lost yet)',
        [w.sent('steakout-ar-lost').length, w.sent('steakout-ar-refound').length, w.sent('steakout-ar-locked').length], [0, 0, 0]);
      // closing without ever having been live
      const x = openMarker(text);
      x.click(x.$('.marker-logo-home'));
      t('N2 leaving before the camera was ever live says so with zeros',
        detailsOf(x, 'steakout-ar-close')[0], { run: 0, ms: 0, locked: 0, lost: 0 });
    }
  },
  {
    name: 'F a fault, what it says and what the customer reads',
    async run(M, t) {
      const { text } = M;
      const fault = async (error) => {
        const w = openMarker(text);
        w.fromParent('steakout-ar-start');
        await w.run(300);
        w.scene.emit('camerastatuschange', { status: 'failed', error });
        return { code: detailsOf(w, 'steakout-ar-camera-error'), title: w.$('#marker-fault-title').textContent, shown: !w.$('#marker-fault').hidden, w };
      };
      const a = await fault({ name: 'NotAllowedError', message: 'Permission denied by jo@example.com' });
      const b = await fault({ name: 'NotReadableError', message: 'Could not start video source' });
      const c = await fault({ name: 'NotFoundError', message: 'Requested device not found' });
      const d = await fault({ name: 'Error', message: 'something else entirely, with 555-0100 in it' });
      t('F1 a camera fault sends one short code, never the message; the panel is the one it always was',
        [a, b, c, d].map((x) => [x.code, x.title, x.shown]),
        [[[{ err: 'permission' }], 'CAMERA ACCESS IS OFF', true], [[{ err: 'busy' }], 'THE CAMERA IS BUSY', true],
          [[{ err: 'no_camera' }], 'NO CAMERA AVAILABLE', true], [[{ err: 'other' }], 'AR COULDN\'T LOAD', true]]);
      t('F1b the panel’s words are unchanged',
        [a.w.$('#marker-fault-body').textContent, b.w.$('#marker-fault-body').textContent, c.w.$('#marker-fault-body').textContent, d.w.$('#marker-fault-body').textContent],
        ['Tap Allow when your phone asks. If you already said no, turn the camera on for this site in your browser settings.',
          'Another app may be using it. Close your other camera apps, then try again.',
          'This device did not offer a camera we can use. Try opening this page in Safari or Chrome directly.',
          'Tap Try Again to start over, and choose Allow when your phone asks for camera and motion access.']);
      a.w.click(a.w.$('#marker-fault-back'));
      t('F2 GO BACK on the fault panel leaves the AR through the same close', detailsOf(a.w, 'steakout-ar-close'), [{ run: 1, ms: 0, locked: 0, lost: 0 }]);
      const dep = openMarker(text, { stability: false });
      t('F3 when the AR helper did not load, the page is told "load"', detailsOf(dep, 'steakout-ar-camera-error'), [{ err: 'load' }]);
    }
  },
  {
    name: 'T taps inside the AR',
    async run(M, t) {
      const { text } = M;
      const w = openMarker(text);
      w.click(w.$('#marker-order'), { clientX: 100, clientY: 720 });
      w.click(w.$('.marker-logo-home'), { clientX: 40, clientY: 40 });
      const cameraView = w.$('#marker-scene');
      w.click(cameraView, { clientX: 200, clientY: 400 });
      w.click(w.$('#marker-order'), { clientX: 100, clientY: 720, isTrusted: false });
      w.click(w.$('#marker-order'), { clientX: 0, clientY: 0, detail: 0 });
      t('T1 a tap on ORDER NOW or the close button is passed up with where it landed (% of the screen); the camera view, a script, nothing else is',
        [detailsOf(w, 'steakout-ar-tap'), w.sent('steakout-ar-order-tapped').length],
        [[{ el: 'ar_order', x: 25, y: 90 }, { el: 'ar_close', x: 10, y: 5 }, { el: 'ar_order', x: 25, y: 15 }], 3]);
      // not inside the landing page: nothing posted, nothing breaks
      const solo = openMarker(text, { embedded: false });
      let broke = null;
      try {
        solo.click(solo.$('#marker-order'));
        solo.click(solo.$('#marker-start'));
        await solo.run(400);
        solo.scene.emit('camerastatuschange', { status: 'hasVideo' });
        await solo.run(2000);
        await solo.showFlyer();
        solo.flyerLost();
        solo.flyerFound();
      } catch (error) { broke = error.message; }
      t('T2 opened on its own (not inside the landing page) it posts nothing and breaks nothing, and still locks',
        [broke, solo.toParent.length, solo.anchor.object3D.visible], [null, 0, true]);
    }
  }
];

/* ------------------------------------------------------------- mutations */

const K = 'marker';
const MUTATIONS = [
  { name: 'ready arrives with extra detail', file: K, from: "postToParent('steakout-ar-ready');", to: "postToParent('steakout-ar-ready', { run: arRun });", check: 'M0 the first message is ready, with no detail' },
  { name: 'camera live loses its ms', file: K, from: "postToParent('steakout-ar-camera-live', { ms: msSince(arStartedAt), run: arRun });", to: "postToParent('steakout-ar-camera-live', { run: arRun });", check: 'M1 camera live is sent once, with ms from START CAMERA and the run, after the splash and reveal' },
  { name: 'camera live ms from the wrong moment', file: K, from: "{ ms: msSince(arStartedAt), run: arRun }", to: "{ ms: msSince(arLiveAt), run: arRun }", check: 'M1 camera live is sent once, with ms from START CAMERA and the run, after the splash and reveal' },
  { name: 'camera live sent before the reveal', file: K, from: "        if (runToken === sessionToken && isRunning) {\n          arLiveAt = performance.now();\n          postToParent('steakout-ar-camera-live'", to: "        if (runToken === sessionToken && isRunning) {\n          arLiveAt = performance.now() + 5;\n          postToParent('steakout-ar-camera-live'", check: 'M2 the meal locks exactly once on a steady flyer; lock carries ms from camera live and the run' },
  { name: 'lock loses its detail', file: K, from: "postToParent('steakout-ar-locked', { ms: msSince(arLiveAt), run: arRun });", to: "postToParent('steakout-ar-locked');", check: 'M2 the meal locks exactly once on a steady flyer; lock carries ms from camera live and the run' },
  { name: 'lock ms from START CAMERA', file: K, from: "postToParent('steakout-ar-locked', { ms: msSince(arLiveAt), run: arRun });", to: "postToParent('steakout-ar-locked', { ms: msSince(arStartedAt), run: arRun });", check: 'M2 the meal locks exactly once on a steady flyer; lock carries ms from camera live and the run' },
  { name: 'the meal never locks', file: K, from: "if (Object.values(gates).every(Boolean)) commitCandidate(evaluation.medoid, evaluation, now);", to: "if (Object.values(gates).every(Boolean)) void now;", check: 'M2 the meal locks exactly once on a steady flyer; lock carries ms from camera live and the run' },
  { name: 'the meal stays a ghost after the lock', file: K, from: "    setPlacementSolid();\n    renderInstruction('locked');", to: "    renderInstruction('locked');", check: 'M2b and the customer sees what they always saw: the meal shown, the locked copy, ORDER NOW' },
  { name: 'lost reported every time it is said', file: K, from: 'if (arLostSince) return;\n    arLostSince = performance.now();', to: 'arLostSince = performance.now();', check: 'M3 a loss after the lock is lost{run,n:1} once; finding it again is refound{run,ms} with how long it was lost' },
  { name: 'refound ms from the wrong moment', file: K, from: 'const ms = msSince(arLostSince);', to: 'const ms = msSince(arLiveAt);', check: 'M3 a loss after the lock is lost{run,n:1} once; finding it again is refound{run,ms} with how long it was lost' },
  { name: 'lost loses its count', file: K, from: "postToParent('steakout-ar-lost', { run: arRun, n: arLostCount });", to: "postToParent('steakout-ar-lost', { run: arRun });", check: 'M3 a loss after the lock is lost{run,n:1} once; finding it again is refound{run,ms} with how long it was lost' },
  { name: 'no cap on losses', file: K, from: 'MAX_LOST_EVENTS = 10;', to: 'MAX_LOST_EVENTS = 1000;', check: 'M3b at most ten losses are reported in a run, each with its refound; none are made up' },
  { name: 'a refound for a loss that was not reported', file: K, from: "if (arLostWasSent) postToParent('steakout-ar-refound', { run: arRun, ms });", to: "postToParent('steakout-ar-refound', { run: arRun, ms });", check: 'M3b at most ten losses are reported in a run, each with its refound; none are made up' },
  { name: 'losses before the lock are reported', file: K, from: 'if (hasLocked) { noteLost(); qrRecoveryEnabled(true); return; }', to: 'noteLost();\n    if (hasLocked) { qrRecoveryEnabled(true); return; }', check: 'N1 losing the flyer before the meal has locked is not reported (nothing was lost yet)' },
  { name: 'ar_closed loses the lost count', file: K, from: '      lost: arLostCount\n    });\n  };', to: '      lost: 0\n    });\n  };', check: 'M4 leaving by the logo sends ar_closed’s numbers: the run, ms in AR, ms locked, times lost (the true count)' },
  { name: 'ar_closed ms from START CAMERA', file: K, from: '      ms: msSince(arLiveAt),\n      locked:', to: '      ms: msSince(arStartedAt),\n      locked:', check: 'M4 leaving by the logo sends ar_closed’s numbers: the run, ms in AR, ms locked, times lost (the true count)' },
  { name: 'ar_closed locked is always zero', file: K, from: 'locked: hasLocked ? msSince(arLockedAt) : 0,', to: 'locked: 0,', check: 'M4 leaving by the logo sends ar_closed’s numbers: the run, ms in AR, ms locked, times lost (the true count)' },
  { name: 'the logo closes without the numbers', file: K, from: "event.preventDefault(); requestClose(); });", to: "event.preventDefault(); postToParent('steakout-ar-close'); });", check: 'M4 leaving by the logo sends ar_closed’s numbers: the run, ms in AR, ms locked, times lost (the true count)' },
  { name: 'Escape closes without the numbers', file: K, from: "if (event.key === 'Escape') requestClose(); });", to: "if (event.key === 'Escape') postToParent('steakout-ar-close'); });", check: 'M4b Escape sends the same, from the same function' },
  { name: 'the next run carries the loss count over', file: K, from: '    arLostCount = 0;\n    arLostSince = 0;\n    arLostWasSent = false;\n    const operation', to: '    arLostSince = 0;\n    arLostWasSent = false;\n    const operation', check: 'M5 the next START CAMERA is run 2, timed from its own start, with nothing carried over from run 1' },
  { name: 'the next run is not a new run', file: K, from: '    arRun = Math.max(arRun, readRunCount()) + 1;\n    writeRunCount(arRun);\n', to: '', check: 'M5 the next START CAMERA is run 2, timed from its own start, with nothing carried over from run 1' },
  { name: 'the next run keeps the old start time', file: K, from: '    arStartedAt = performance.now();\n    arLiveAt = 0;', to: '    arLiveAt = 0;', check: 'M5 the next START CAMERA is run 2, timed from its own start, with nothing carried over from run 1' },
  { name: 'closing before ever being live reports ghosts', file: K, from: 'const msSince = (from) => (from ? Math.max(0, Math.round(performance.now() - from)) : 0);', to: 'const msSince = (from) => Math.max(0, Math.round(performance.now() - from));', check: 'N2 leaving before the camera was ever live says so with zeros' },
  { name: 'a permission fault is called other', file: K, from: "if (/NotAllowedError|SecurityError|PermissionDenied/i.test(summary)) return 'permission';", to: "if (/NotAllowedError|SecurityError|PermissionDenied/i.test(summary)) return 'other';", check: 'F1 a camera fault sends one short code, never the message; the panel is the one it always was' },
  { name: 'the fault sends the message', file: K, from: "postToParent('steakout-ar-camera-error', { err: faultKind() });", to: "postToParent('steakout-ar-camera-error', { err: errorSummary() });", check: 'F1 a camera fault sends one short code, never the message; the panel is the one it always was' },
  { name: 'the busy panel loses its title', file: K, from: "if (kind === 'busy') {", to: "if (kind === 'busyx') {", check: 'F1 a camera fault sends one short code, never the message; the panel is the one it always was' },
  { name: 'the no-camera panel changes its words', file: K, from: "body: 'This device did not offer a camera we can use. Try opening this page in Safari or Chrome directly.'", to: "body: 'This device did not offer a camera.'", check: 'F1b the panel’s words are unchanged' },
  { name: 'GO BACK closes without the numbers', file: K, from: "    if (isEmbedded) requestClose();\n    else { stop(); intro.hidden = false; }", to: "    if (isEmbedded) postToParent('steakout-ar-close');\n    else { stop(); intro.hidden = false; }", check: 'F2 GO BACK on the fault panel leaves the AR through the same close' },
  { name: 'the helper fault does not say load', file: K, from: "detail: { err: 'load' }", to: "detail: {}", check: 'F3 when the AR helper did not load, the page is told "load"' },
  { name: 'every click in the AR is passed up', file: K, from: "const tagged = event.target.closest('[data-track]');\n        if (!tagged) return;", to: "const tagged = event.target.closest('[data-track]') || event.target;", check: 'T1 a tap on ORDER NOW or the close button is passed up with where it landed (% of the screen); the camera view, a script, nothing else is' },
  { name: 'a script-made click is passed up', file: K, from: "if (!event.isTrusted || !event.target || !event.target.closest) return;", to: "if (!event.target || !event.target.closest) return;", check: 'T1 a tap on ORDER NOW or the close button is passed up with where it landed (% of the screen); the camera view, a script, nothing else is' },
  { name: 'the tap position is in pixels', file: K, from: 'x: pct(clientX, window.innerWidth),', to: 'x: clientX,', check: 'T1 a tap on ORDER NOW or the close button is passed up with where it landed (% of the screen); the camera view, a script, nothing else is' },
  { name: 'a key press has no position', file: K, from: "if (clientX === 0 && clientY === 0 && event.detail === 0) {\n          const rect = tagged.getBoundingClientRect();", to: "if (false) {\n          const rect = tagged.getBoundingClientRect();", check: 'T1 a tap on ORDER NOW or the close button is passed up with where it landed (% of the screen); the camera view, a script, nothing else is' },
  { name: 'the run count is not written down', file: K, from: '    writeRunCount(arRun);\n', to: '', check: 'R2 after a reload of the tab the next attempt is run 2, not run 1 again (or Orbit would throw its timings away as repeats of the first)' },
  { name: 'the run count is not read back (a reload counts from 1)', file: K, from: 'arRun = Math.max(arRun, readRunCount()) + 1;', to: 'arRun += 1;', check: 'R2 after a reload of the tab the next attempt is run 2, not run 1 again (or Orbit would throw its timings away as repeats of the first)' },
  { name: 'the stored count wins over the page’s own', file: K, from: 'arRun = Math.max(arRun, readRunCount()) + 1;', to: 'arRun = readRunCount() + 1;', check: 'R5 with a storage that throws the AR still starts, and still counts runs within the page (1, then 2)' },
  { name: 'the page’s own count wins over the stored one', file: K, from: 'arRun = Math.max(arRun, readRunCount()) + 1;', to: 'arRun = arRun + 1;', check: 'R7 a stored 7 makes the next attempt run 8' },
  { name: 'the count is stored one behind', file: K, from: '    writeRunCount(arRun);\n', to: '    writeRunCount(arRun - 1);\n', check: 'R3 a further attempt in the same page continues, run 3' },
  { name: 'any stored text is believed', file: K, from: 'return Number.isInteger(stored) && stored > 0 && stored <= MAX_RUN ? stored : 0;', to: 'return stored || 0;', check: 'R6 garbage in the stored count is ignored: the attempt is run 1' },
  { name: 'a stored count past 999 is believed', file: K, from: 'stored > 0 && stored <= MAX_RUN ? stored : 0;', to: 'stored > 0 ? stored : 0;', check: 'R6 garbage in the stored count is ignored: the attempt is run 1' },
  { name: 'a storage that throws on read breaks the AR', file: K, from: '    } catch (error) { return 0; }\n  };\n  const writeRunCount', to: '    } catch (error) { throw error; }\n  };\n  const writeRunCount', check: 'R5 with a storage that throws the AR still starts, and still counts runs within the page (1, then 2)' },
  { name: 'a storage that throws on write breaks the AR', file: K, from: "setItem(RUN_KEY, String(count)); } catch (error) { /* private mode */ }", to: "setItem(RUN_KEY, String(count)); } catch (error) { throw error; }", check: 'R5 with a storage that throws the AR still starts, and still counts runs within the page (1, then 2)' },
  { name: 'the count is kept for the whole phone, not the tab', file: K, from: 'const runStore = () => window.sessionStorage;', to: 'const runStore = () => window.localStorage;', check: 'R4 another tab counts from 1 on its own: the count belongs to the tab, never to the phone' },
  { name: 'it posts outside the landing page too', file: K, from: "const postToParent = (type, detail) => {\n    if (!isEmbedded || window.parent === window) return;", to: "const postToParent = (type, detail) => {", check: 'T2 opened on its own (not inside the landing page) it posts nothing and breaks nothing, and still locks' }
];

/* --------------------------------------------------------------- running */

async function runAll(mutations, { quiet } = {}) {
  newProfile();
  const text = loadText(mutations);
  const M = { text };
  const all = [];
  let passed = 0;
  for (const c of CASES) {
    const results = [];
    const t = (name, got, want) => {
      const g = JSON.stringify(got === undefined ? '__undefined__' : got);
      const w = JSON.stringify(want === undefined ? '__undefined__' : want);
      results.push({ name, ok: g === w, detail: `got  ${g}\n          want ${w}` });
    };
    let threw = null;
    try {
      await c.run(M, t);
    } catch (error) {
      threw = error;
    }
    if (!quiet) console.log(`\n${c.name}`);
    for (const r of results) {
      all.push({ case: c.name, ...r });
      if (r.ok) passed++;
      if (!quiet) console.log(`    ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n          ${r.detail}`}`);
    }
    if (threw) {
      all.push({ case: c.name, name: `${c.name} threw`, ok: false, detail: String((threw && threw.stack) || threw) });
      if (!quiet) console.log(`    FAIL  the case threw: ${(threw && threw.stack) || threw}`);
    }
  }
  return { passed, total: all.length, all };
}

async function selftest() {
  let bad = 0;
  const baseline = await runAll([], { quiet: true });
  if (baseline.passed !== baseline.total) {
    console.error(`SELFTEST FAIL  ${baseline.total - baseline.passed} check(s) are red WITHOUT any mutation; run without --selftest first.`);
    return false;
  }
  const names = baseline.all.map((x) => x.name);
  const everRed = new Set();
  let red = 0;
  for (const m of MUTATIONS) {
    if (!names.includes(m.check)) {
      bad++;
      console.error(`SELFTEST FAIL  mutation "${m.name}": no check named "${m.check}".`);
      continue;
    }
    let r;
    try {
      r = await runAll([m], { quiet: true });
    } catch (error) {
      bad++;
      console.error(`SELFTEST FAIL  mutation "${m.name}": ${String(error.message || error).split('\n')[0]}`);
      continue;
    }
    for (const x of r.all) if (!x.ok) everRed.add(x.name);
    for (const n of names) if (!r.all.some((x) => x.name === n)) everRed.add(n);
    const hit = r.all.find((x) => x.name === m.check);
    if (!hit || !hit.ok) {
      red++;
      console.log(`  red   ${m.name}  ->  ${m.check.slice(0, 60)}`);
    } else {
      bad++;
      console.error(`SELFTEST FAIL  mutation "${m.name}": "${m.check}" still passes with the fix removed.`);
    }
  }
  console.log(`selftest: ${red}/${MUTATIONS.length} mutations correctly went red`);
  const neverRed = names.filter((n) => !everRed.has(n));
  for (const n of neverRed) {
    bad++;
    console.error(`SELFTEST FAIL  check "${n}" is never made red by any mutation.`);
  }
  if (!neverRed.length) console.log(`selftest: all ${names.length} checks went red under at least one mutation`);
  return bad === 0 && red === MUTATIONS.length;
}

module.exports = { openMarker, loadText };

if (require.main === module) (async () => {
  if (process.argv.includes('--selftest')) {
    const ok = await selftest();
    if (!ok) {
      console.error('\nSELFTEST FAILED: the test itself is broken.');
      process.exitCode = 1;
    } else {
      console.log('selftest OK: every mutation went red and every check can fail.');
    }
    return;
  }
  // --mutation=N runs the checks with just mutation N applied (to see what it breaks)
  const only = process.argv.find((a) => a.startsWith('--mutation='));
  if (only) {
    const m = MUTATIONS[Number(only.split('=')[1])];
    console.log(`with mutation: ${m.name}  (expected to break: ${m.check})`);
    const r = await runAll([m]);
    process.exitCode = r.total - r.passed ? 1 : 0;
    return;
  }
  const r = await runAll([]);
  const failed = r.total - r.passed;
  console.log(failed ? `\n  ${failed} of ${r.total} FAILED` : `\n  ${r.total}/${r.total} pass`);
  process.exitCode = failed ? 1 : 0;
})();
