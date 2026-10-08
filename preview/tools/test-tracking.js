'use strict';

/* THE TRACKING, CHECKED WITHOUT A PHONE (2026-10-08).
 *
 *   node preview/tools/test-tracking.js              (from the repo root)
 *   node preview/tools/test-tracking.js --selftest
 *
 * Plain node, no packages. It runs the REAL tracking-core.js, tracking.js and
 * app.js (and reads the real index.html, marker.html, marker.js, config.js)
 * inside a small fake page: a tiny HTML reader builds the elements out of the
 * real index.html, a fake browser delivers pointer events the way a browser
 * does (capture, then target, then bubble), a fake clock and fake timers keep
 * every time exact, and a fake sendBeacon writes down what would have left the
 * phone. Nothing here touches a network.
 *
 * What it proves:
 *   A. the contract: the event names and meta keys are Orbit's (read from
 *      libraries/orbit/src/site-events/site-events.types.ts when that checkout
 *      sits next to this one; otherwise the copy in this file), nothing else can
 *      leave, values are rebuilt and clamped, every event carries t, the
 *      address is https-only and empty means nothing is ever sent;
 *   B. which element and which page part a tap is filed under;
 *   C. where a tap fell (x, y in % of the screen, py in % of the page);
 *   D. what counts as a tap (a finger once, not a drag, a key press yes);
 *   E. hovers (0.4 s, once per rest), the model turned by hand, leaving links,
 *      the device (coarse OS, never the user agent);
 *   F. time on each page part (only while the page is visible, not under the
 *      AR) and the cumulative visit_end, its caps, and a reload in the same tab;
 *   G. the whole page: a scan, taps, a hover, a turn, the AR conversation with
 *      the frame, leaving, hidden twice; every message passes the Collector's
 *      own rules; nothing leaves while collectorUrl is empty;
 *   H. the files: every data-track / data-section in index.html is one Orbit
 *      knows, scripts load in order, no hard-coded collector address, no user
 *      agent read, marker.js reports its run and nothing it must not.
 *
 * NOT proven here: a real phone, real Safari, a real camera, the AR engine.
 * marker.js's lock / lost / refound messages are exercised by
 * test-marker-events.js, which runs the real marker.js against a fake scene.
 *
 * --selftest re-breaks the real source text (one mutation at a time, in memory
 * only; nothing on disk changes) and fails unless the named check goes red. It
 * also fails if any check is never made red by some mutation.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { El, Target, parseHtml, selectAll, hooks } = require('./fake-dom.js');

const previewRoot = path.resolve(__dirname, '..');
const FILES = {
  core: 'tracking-core.js',
  tracking: 'tracking.js',
  app: 'app.js',
  marker: 'marker.js',
  index: 'index.html',
  markerHtml: 'marker.html',
  config: 'config.js'
};
const ORBIT_CONTRACT = process.env.ORBIT_SITE_EVENTS_TS ||
  path.resolve(__dirname, '../../../orbit/libraries/orbit/src/site-events/site-events.types.ts');

/* --------------------------------------------------------------- sources */

function loadText(mutations = []) {
  const text = {};
  for (const [key, file] of Object.entries(FILES)) text[key] = fs.readFileSync(path.join(previewRoot, file), 'utf8');
  for (const m of mutations) {
    const files = m.file === '*' ? Object.keys(text) : [m.file];
    const hits = files.reduce((n, f) => n + text[f].split(m.from).length - 1, 0);
    if (hits !== 1) throw new Error(`mutation "${m.name}": expected 1 match of its text in ${m.file}, found ${hits}`);
    for (const f of files) {
      if (text[f].includes(m.from)) text[f] = text[f].replace(m.from, () => m.to);
    }
  }
  return text;
}

function loadCore(text) {
  const module = { exports: {} };
  // URL is the one browser global the core uses; a bare vm context does not have it.
  vm.runInNewContext(text.core, { module, URL }, { filename: 'tracking-core.js' });
  return module.exports;
}

/* The contract, as Orbit wrote it. */
function readContract() {
  let ts;
  try {
    ts = fs.readFileSync(ORBIT_CONTRACT, 'utf8');
  } catch (error) {
    return null;
  }
  const metaKeys = (comment) => {
    const at = comment.indexOf('meta:');
    if (at < 0) return [];
    let depth = 0;
    let out = '';
    for (const ch of comment.slice(at + 5)) {
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0) out += ch;
    }
    return out.split(',').map((piece) => piece.split('=')[0].trim()).filter((k) => /^[a-z]+$/.test(k));
  };
  const events = {};
  const block = ts.slice(ts.indexOf('export const ORBIT_SITE_EVENTS = ['), ts.indexOf('] as const;'));
  for (const line of block.split('\n')) {
    const m = /^\s*'([a-z_]+)',?\s*(?:\/\/(.*))?$/.exec(line);
    if (m) events[m[1]] = metaKeys(m[2] || '');
  }
  const sections = [...ts.slice(ts.indexOf('ORBIT_SITE_SECTIONS = ['), ts.indexOf('] as const;', ts.indexOf('ORBIT_SITE_SECTIONS = [')))
    .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const labelBlock = ts.slice(ts.indexOf('ORBIT_SITE_ELEMENT_LABELS'), ts.indexOf('};', ts.indexOf('ORBIT_SITE_ELEMENT_LABELS')));
  const labels = [...labelBlock.matchAll(/^\s*([a-z_]+): '/gm)].map((m) => m[1]);
  return { events, sections, labels };
}

// The same lists by hand, for when the Orbit checkout is not next door. The
// test says which one it used.
const CONTRACT_COPY = {
  events: {
    scan: ['w', 'h', 'dpr', 'os', 'hover'], tap: ['el', 'sec', 'x', 'y', 'py', 't'], hover: ['el', 'ms'],
    viewer_spin: ['ms', 'n'], leave: ['to'], visit_end: ['s', 'v', 'sec', 'sd', 'taps', 'hov', 'vw', 'ar'],
    ar_guide_opened: [], guide_cancel: [], ar_launch_tapped: [], motion_blocked: [], browser_ar_opened: [],
    camera_live: ['ms', 'run'], camera_error: ['err'], lock: ['ms', 'run'], lost: ['run', 'n'],
    refound: ['run', 'ms'], order_shown: [], order_tapped: ['from'], ar_closed: ['run', 'ms', 'locked', 'lost'],
    browser_ar_closed: [], ar_mode_changed: []
  },
  sections: ['header', 'hero', 'viewer', 'cta', 'order_bar', 'guide', 'ar'],
  labels: ['menu', 'logo', 'cart', 'sign_in', 'offer', 'viewer', 'ar_button', 'guide_start', 'guide_cancel',
    'guide_close', 'order_bar', 'ar_order', 'ar_close', 'page']
};
const contractFile = readContract();
const CONTRACT = contractFile || CONTRACT_COPY;

/* The Collector's own rules for /collect (steak-out-ar-collector/src/index.js),
   copied so every message the page sends is held to them. */
function collectorAccepts(raw) {
  if (Buffer.byteLength(raw) > 2048) return 'body over 2048 bytes';
  let body;
  try { body = JSON.parse(raw); } catch (error) { return 'not JSON'; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'not an object';
  if (typeof body.name !== 'string' || !/^[a-z_]{1,40}$/.test(body.name)) return 'name';
  if (typeof body.source !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(body.source)) return 'source';
  if (typeof body.session !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.session)) return 'session';
  if (!Number.isSafeInteger(body.at) || body.at < 0) return 'at';
  const meta = body.meta === undefined ? {} : body.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return 'meta not an object';
  const unsafe = (v, d = 0) => d <= 20 && typeof v === 'object' && v !== null &&
    Object.entries(v).some(([k, inner]) => ['__proto__', 'constructor', 'prototype'].includes(k) || unsafe(inner, d + 1));
  if (unsafe(meta)) return 'meta has an unsafe key';
  if (Buffer.byteLength(JSON.stringify(meta)) > 1536) return 'meta over 1536 bytes';
  return null;
}

/* ------------------------------------------------------------- fake page */

/**
 * The real index.html, the real scripts, a fake browser.
 * opts: collector, hover, platform, touch, storage, url, startAt, visible.
 */
function openPage(text, opts = {}) {
  const o = {
    collector: 'https://collector.example.workers.dev/collect',
    url: 'https://lunch.mysteakout.com/preview/?c=table',
    hover: true,
    platform: 'iPhone',
    uaPlatform: undefined,
    touch: 5,
    storage: new Map(),
    startAt: 3000,
    visible: true,
    ...opts
  };
  const u = new URL(o.url);
  let clock = o.startAt;
  const timers = [];
  const beacons = [];
  const toFrame = [];
  let sessionCounter = 0;
  let timerSeq = 0;
  const observers = [];

  const winTarget = new Target();
  const document = new Target();
  document.readyState = 'loading';
  document.visibilityState = o.visible ? 'visible' : 'hidden';
  const elements = parseHtml(text.index, document);
  document.documentElement.scrollHeight = 1900;
  document.body.scrollHeight = 1900;
  document.querySelectorAll = (sel) => selectAll(elements, sel);
  document.querySelector = (sel) => selectAll(elements, sel)[0] || null;
  document.createElement = (tag) => new El(tag, {}, null);
  document.head = new El('head', {}, null);

  const sandbox = {
    document,
    URL,
    URLSearchParams,
    console,
    Promise,
    innerWidth: 390,
    innerHeight: 750,
    scrollY: 0,
    pageYOffset: 0,
    devicePixelRatio: 3,
    screen: { width: 390, height: 844 },
    location: { search: u.search, href: u.href, origin: u.origin },
    navigator: {
      platform: o.platform,
      userAgent: 'Mozilla/5.0 SECRET-USER-AGENT-STRING',
      maxTouchPoints: o.touch,
      userAgentData: o.uaPlatform ? { platform: o.uaPlatform } : undefined,
      sendBeacon: (url, body) => { beacons.push({ url, raw: body, body: JSON.parse(body) }); return true; }
    },
    performance: { now: () => clock },
    sessionStorage: {
      getItem: (k) => (o.storage.has(k) ? o.storage.get(k) : null),
      setItem: (k, v) => { o.storage.set(k, String(v)); }
    },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, '0')}` },
    matchMedia: (query) => ({ matches: query === '(hover: hover)' ? Boolean(o.hover) : false }),
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: (fn) => sandbox.setTimeout(() => fn(clock), 0),
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = []; observers.push(this); }
      observe(el) { this.targets.push(el); }
      disconnect() { this.targets = []; }
    },
    addEventListener: (...a) => winTarget.addEventListener(...a),
    removeEventListener: (...a) => winTarget.removeEventListener(...a)
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.scrollTo = () => {};
  document.addEventListener = Target.prototype.addEventListener;
  vm.createContext(sandbox);

  // Real dispatch: capture from the window down, the target, then bubble back up.
  const listenersOf = (node) => (node === sandbox ? winTarget : node);
  function fire(target, type, init = {}) {
    const event = {
      type, target, isTrusted: true, isPrimary: true, timeStamp: clock, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init
    };
    const chain = [];
    if (target === sandbox) chain.push(sandbox);
    else if (target === document) chain.push(sandbox, document);
    else {
      chain.push(sandbox, document);
      const up = [];
      for (let n = target; n; n = n.parentElement) up.push(n);
      chain.push(...up.reverse());
    }
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

  const run = (code, filename) => vm.runInContext(code, sandbox, { filename });
  run(text.config.slice(0, text.config.indexOf('\n(() => {')), 'config.js');
  sandbox.STEAKOUT_AR_CONFIG.collectorUrl = o.collector;
  run(text.core, 'tracking-core.js');
  run(text.tracking, 'tracking.js');
  run(text.app, 'app.js');

  const byId = (id) => elements.find((e) => e.getAttribute('id') === id);
  const frame = byId('browser-ar-frame');
  frame.contentWindow = { postMessage: (message) => toFrame.push(message) };

  const world = {
    sandbox, document, elements, beacons, toFrame, storage: o.storage, fire,
    $: (sel) => document.querySelector(sel),
    $$: (sel) => document.querySelectorAll(sel),
    byId,
    get now() { return clock; },
    get dataLayer() { return JSON.parse(JSON.stringify(sandbox.dataLayer || [])); },
    names: () => beacons.map((b) => b.body.name),
    sent: (name) => beacons.filter((b) => b.body.name === name).map((b) => b.body),
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers.find((t) => t.at <= until);
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        clock = Math.max(clock, next.at);
        next.fn();
      }
      clock = until;
    },
    async settle() { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); },
    // a finger
    tap(el, at = {}) {
      const p = { clientX: 120, clientY: 300, pointerId: 1, pointerType: 'touch', button: 0, ...at };
      fire(el, 'pointerdown', p);
      world.advance(60);
      fire(el, 'pointerup', p);
      fire(el, 'click', { clientX: p.clientX, clientY: p.clientY, detail: 1 });
    },
    // a mouse
    click(el, at = {}) {
      world.tap(el, { pointerType: 'mouse', pointerId: 2, ...at });
    },
    scrollTo(y) { sandbox.scrollY = y; fire(sandbox, 'scroll'); world.advance(0); },
    hide() { document.visibilityState = 'hidden'; fire(document, 'visibilitychange'); },
    show() { document.visibilityState = 'visible'; fire(document, 'visibilitychange'); },
    pagehide() { fire(sandbox, 'pagehide', { persisted: false }); },
    inView(sectionName, on = true, ratio = 1) {
      const target = elements.find((e) => e.getAttribute('data-section') === sectionName);
      const entry = { target, isIntersecting: on, intersectionRatio: on ? ratio : 0, intersectionRect: { height: on ? 700 * ratio : 0 }, rootBounds: { height: 750 } };
      observers.forEach((ob) => ob.callback([entry]));
    },
    fromFrame(type, detail) {
      fire(sandbox, 'message', {
        source: frame.contentWindow, origin: u.origin, data: detail === undefined ? { type } : { type, detail }
      });
    }
  };
  return world;
}

/* ---------------------------------------------------------------- checks */

const SAMPLE = { w: 390, h: 844, dpr: 3, os: 'ios', hover: false, el: 'cart', sec: 'hero', x: 12.3, y: 45.6, py: 22.2, t: 1234, ms: 1500, n: 7, to: 'order', s: 90, v: 80, sd: 75, taps: 5, hov: 2, vw: 4000, ar: 9000, run: 2, from: 'ar', err: 'permission', locked: 3000, lost: 1 };
const FULL_SECTIONS = { header: 1e6, hero: 1e6, viewer: 1e6, cta: 1e6, order_bar: 1e6, guide: 1e6, ar: 1e6 };

const CASES = [
  {
    name: 'A the contract',
    async run(M, t) {
      const { core } = M;
      const names = Object.keys(core.EVENT_KEYS);
      t('A1 the events are exactly Orbit’s list',
        names.slice().sort(), Object.keys(CONTRACT.events).sort());
      t('A2 each event is allowed exactly Orbit’s meta keys',
        Object.fromEntries(names.map((n) => [n, [...core.EVENT_KEYS[n]].sort()])),
        Object.fromEntries(names.map((n) => [n, [...CONTRACT.events[n]].sort()])));
      t('A2b every event comes out with exactly Orbit’s meta keys, plus t',
        Object.fromEntries(names.map((n) => [n, Object.keys(core.shapeEvent(n, { ...SAMPLE, sec: n === 'visit_end' ? FULL_SECTIONS : SAMPLE.sec }, { t: 1 }).meta).sort()])),
        Object.fromEntries(names.map((n) => [n, [...new Set([...CONTRACT.events[n], 't'])].sort()])));
      t('A3 a name or a key that is not in the list is dropped',
        [core.shapeEvent('cheat', { a: 1 }), core.shapeEvent('__proto__', {}), core.shapeEvent('toString', {}),
          core.shapeEvent('lock', { ms: 5, run: 1, evil: 'x', ua: 'Mozilla/5.0', item: 'Cheesesteak' }, { t: 9 }).meta,
          core.shapeEvent('browser_ar_opened', { item: 'Cheesesteak Special' }, { t: 9 }).meta,
          core.shapeEvent('ar_mode_changed', { mode: 'free' }, { t: 9 }).meta,
          core.shapeEvent('lock', { ms: 5, run: 1, x: 50, to: 'order', taps: 3, os: 'ios', el: 'cart' }, { t: 9 }).meta],
        [null, null, null, { ms: 5, run: 1, t: 9 }, { t: 9 }, { t: 9 }, { ms: 5, run: 1, t: 9 }]);
      t('A4 values are rebuilt: numbers clamped and rounded, words checked, junk dropped',
        [core.shapeEvent('tap', { el: 'cart', sec: 'hero', x: 12.349, y: -4, py: 140, t: 1500.6 }, { t: 1 }).meta,
          core.shapeEvent('tap', { el: 'Has Space', sec: 'nowhere', x: '12', y: NaN, py: null }, { t: 1 }).meta,
          core.shapeEvent('scan', { w: 390.4, h: 844, dpr: 2.96, os: 'windows', hover: 'yes' }, { t: 1 }).meta,
          core.shapeEvent('leave', { to: 'https://evil.example' }, { t: 1 }).meta,
          core.shapeEvent('camera_error', { err: 'NotAllowedError: Permission denied for jo@example.com' }, { t: 1 }).meta,
          core.shapeEvent('hover', { el: 'cart', ms: 1e12 }, { t: 1 }).meta],
        [{ el: 'cart', sec: 'hero', x: 12.3, y: 0, py: 100, t: 1501 }, { t: 1 },
          { w: 390, h: 844, dpr: 3, t: 1 }, { t: 1 }, { t: 1 }, { el: 'cart', ms: 86400000, t: 1 }]);
      t('A5 every event carries t; a tap brings its own, the rest are stamped as sent',
        [core.shapeEvent('lock', { ms: 1, run: 1, t: 77 }, { t: 5000.4 }).meta.t, core.shapeEvent('tap', { el: 'cart', x: 1, y: 1, t: 77 }, { t: 5000 }).meta.t,
          core.shapeEvent('scan', {}, {}).meta, core.shapeEvent('scan', {}, { t: NaN }).meta],
        [5000, 77, {}, {}]);
      const biggest = core.shapeEvent('visit_end', { s: 1e9, v: 1e9, sec: FULL_SECTIONS, sd: 100, taps: 1e9, hov: 1e9, vw: 1e12, ar: 1e12 }, { t: 1e12 });
      t('A6 the biggest possible visit_end fits under the Collector’s meta limit',
        [JSON.stringify(biggest.meta).length < core.MAX_META_BYTES, Object.keys(biggest.meta.sec).length],
        [true, 7]);
      t('A7 the placement is made acceptable to the Collector; nothing usable means direct',
        ['Table', ' Window ', 'a b/c?d', '', undefined, 'x'.repeat(60), 'üïö', '___'].map((s) => core.cleanSource(s)),
        ['table', 'window', 'abcd', 'direct', 'direct', 'x'.repeat(40), 'direct', '___']);
      t('A8 the address: empty means none; https yes; plain http only for this machine; no logins',
        ['', '  ', undefined, 'http://collector.example.com/collect', 'https://u:p@collector.example.com/collect', 'ftp://x.example/', 'not a url',
          'https://collector.example.com/collect', 'http://localhost:8787/collect', 'http://127.0.0.1:8787/collect']
          .map((s) => core.normalizeCollectorUrl(s)),
        ['', '', '', '', '', '', '', 'https://collector.example.com/collect', 'http://localhost:8787/collect', 'http://127.0.0.1:8787/collect']);
      {
        const calls = [];
        const mk = (over = {}) => core.createSender({ url: 'https://c.example/collect', source: 'Table', session: 'abc-123', beacon: (u, b) => calls.push([u, JSON.parse(b)]), now: () => 1790000000000, since: () => 2500.2, ...over });
        const shapedA = mk()('tap', { el: 'cart', x: 1, y: 2, evil: 1 });
        mk({ url: '' })('lock', { ms: 1, run: 1 });
        mk({ url: undefined })('lock', { ms: 1, run: 1 });
        mk({ session: 'has space' })('lock', { ms: 1, run: 1 });
        mk()('not_an_event', {});
        const shapedThrow = mk({ beacon: () => { throw new Error('offline'); } })('lock', { ms: 1, run: 1 });
        t('A9 one beacon with name, source, session, at and meta; no address or a bad session sends nothing; a failing beacon is swallowed',
          [calls, shapedA, shapedThrow.meta],
          [[['https://c.example/collect', { name: 'tap', source: 'table', session: 'abc-123', at: 1790000000000, meta: { el: 'cart', x: 1, y: 2, t: 2500 } }]],
            { name: 'tap', meta: { el: 'cart', x: 1, y: 2, t: 2500 } }, { ms: 1, run: 1, t: 2500 }]);
      }
    }
  },
  {
    name: 'B which element, which part of the page',
    async run(M, t) {
      const { core } = M;
      const tree = (spec) => {
        const mk = (attrs, parent) => ({ attrs, parentElement: parent, getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; } });
        const root = mk({ 'data-section': 'hero' }, null);
        const outer = mk({ 'data-track': 'viewer', 'data-section': 'viewer' }, root);
        const inner = mk({ 'data-track': 'ar_button' }, outer);
        const plain = mk({}, inner);
        const strangeSec = mk({ 'data-section': 'sidebar' }, root);
        const strangeKid = mk({ 'data-track': 'Bad Key' }, strangeSec);
        const loose = mk({}, null);
        return { root, outer, inner, plain, strangeSec, strangeKid, loose };
      };
      const n = tree();
      const r = (node) => { const x = core.resolveTarget(node); return { el: x.el, sec: x.sec, tagged: x.node === null ? null : x.node.attrs['data-track'] }; };
      t('B1 the nearest data-track is the element, however deep the tap was',
        [r(n.plain), r(n.inner), r(n.outer)].map((x) => x.el), ['ar_button', 'ar_button', 'viewer']);
      t('B2 the nearest data-section is the page part; an unknown one is none, not its neighbour',
        [r(n.plain).sec, r(n.outer).sec, r(n.root).sec, r(n.strangeKid).sec], ['viewer', 'viewer', 'hero', null]);
      t('B3 nothing tagged is "page", with no page part; a bad key is not an element',
        [r(n.loose), r(n.strangeKid).el, core.resolveTarget(null).el], [{ el: 'page', sec: null, tagged: null }, 'page', 'page']);
    }
  },
  {
    name: 'C where a tap fell',
    async run(M, t) {
      const { core } = M;
      t('C1 percentages are to 0.1, held between 0 and 100, and null with nothing to measure against',
        [core.pct1(1, 3), core.pct1(150, 100), core.pct1(-5, 100), core.pct1(0, 0), core.pct1(5, -1), core.pct1(NaN, 10), core.pct1(195, 390)],
        [33.3, 100, 0, null, null, null, 50]);
      const base = { target: null, viewW: 400, viewH: 800, t: 10 };
      t('C2 x, y are of the screen; py is of the whole page, scrolled or not; no screen no tap',
        [core.tapDetail({ ...base, clientX: 100, clientY: 400, scrollY: 0, pageH: 2000 }),
          core.tapDetail({ ...base, clientX: 100, clientY: 400, scrollY: 800, pageH: 2000 }),
          core.tapDetail({ ...base, clientX: 100, clientY: 400, scrollY: 0, pageH: 300 }),
          core.tapDetail({ ...base, viewW: 0, clientX: 1, clientY: 1 })],
        [{ el: 'page', sec: null, x: 25, y: 50, py: 20, t: 10 }, { el: 'page', sec: null, x: 25, y: 50, py: 60, t: 10 },
          { el: 'page', sec: null, x: 25, y: 50, py: 50, t: 10 }, null]);
      t('C3 a tap reported by the AR frame is filed under ar, and only if it is whole',
        [core.frameTapDetail({ el: 'ar_order', x: 50.04, y: 90 }, 7), core.frameTapDetail({ el: 'Bad Key', x: 1, y: 1 }, 7),
          core.frameTapDetail({ el: 'ar_close', x: 1 }, 7), core.frameTapDetail('nope', 7), core.frameTapDetail({ el: 'ar_close', x: 120, y: -3 }, 7)],
        [{ el: 'ar_order', sec: 'ar', x: 50, y: 90, t: 7 }, null, null, null, { el: 'ar_close', sec: 'ar', x: 100, y: 0, t: 7 }]);
    }
  },
  {
    name: 'D what counts as a tap',
    async run(M, t) {
      const { core } = M;
      const f = core.createTapFilter();
      f.down(1, 100, 100, 1000);
      const finger = f.up(1, 103, 102, 1060, 0);
      const clickAfter = f.click(1062);
      f.down(1, 100, 100, 2000);
      const drag = f.up(1, 100, 180, 2300, 0);
      const clickAfterDrag = f.click(2302);
      const keyboard = f.click(9000);
      f.down(1, 5, 5, 9500);
      const right = f.up(1, 5, 5, 9550, 2);
      f.down(1, 5, 5, 9600);
      f.cancel(1);
      const cancelled = f.up(1, 5, 5, 9650, 0);
      const strayUp = f.up(7, 5, 5, 9700, 0);
      t('D1 a finger that stays put is one tap; its click is the same tap',
        [finger, clickAfter], [true, false]);
      t('D2 a drag is not a tap, and the click that ends one is not either',
        [drag, clickAfterDrag], [false, false]);
      t('D3 a key press on a button (a click with no pointer before it) is a tap',
        keyboard, true);
      t('D4 not the right mouse button, not a cancelled touch, not a pointer-up with no press',
        [right, cancelled, strayUp], [false, false, false]);
    }
  },
  {
    name: 'E hovers, the model in hand, leaving, the device',
    async run(M, t) {
      const { core } = M;
      let h = core.createHoverRest();
      const a = {};
      const b = {};
      const out = [];
      out.push(h.move(a, 'cart', 1000));
      out.push(h.move(a, 'cart', 1200));
      out.push(h.move(b, 'logo', 1500));
      out.push(h.move(null, null, 1800));
      out.push(h.move(a, 'cart', 2000));
      out.push(h.move(null, null, 2399));
      out.push(h.move(b, 'logo', 3000));
      out.push(h.flush(3400));
      out.push(h.flush(3500));
      t('E1 a hover is a rest of 400 ms or more on a tagged thing, reported once when it ends, with its ms',
        out, [null, null, { el: 'cart', ms: 500 }, null, null, null, null, { el: 'logo', ms: 400 }, null]);
      t('E2 staying on the same thing is one rest, however many pointer moves reach it',
        (() => { h = core.createHoverRest(); h.move(a, 'cart', 0); h.move(a, 'cart', 100); h.move(a, 'cart', 600); return h.move(null, null, 900); })(),
        { el: 'cart', ms: 900 });
      const sp = core.createSpinBurst();
      const none = sp.finish();
      sp.event(1000); sp.event(1100); sp.event(1900);
      const active = sp.active();
      const turned = sp.finish();
      t('E3 many camera changes are one turn: how long, and how many changes; none is nothing',
        [none, active, turned, sp.active(), sp.finish()], [null, true, { ms: 900, n: 3 }, false, null]);
      const pageHref = 'https://lunch.mysteakout.com/preview/?c=table';
      const leave = (href, extra = {}) => core.classifyLeave({ href, pageHref, track: null, isOrderLink: false, ...extra });
      t('E4 where a tap on a link goes: order, website, sign in, other; the same site, mail and phone are not leaving',
        [leave('https://order.toasttab.com/online/steakout-sewell'), leave('https://order.toasttab.com/x', { isOrderLink: true }),
          leave('https://mysteakout.com/'), leave('https://mysteakout.com/', { track: 'sign_in' }), leave('https://www.instagram.com/steakout.sewell/'),
          leave('./marker.html'), leave('/preview/'), leave('mailto:a@b.co'), leave('tel:+15555550100'), leave('https://lunch.mysteakout.com/other'),
          core.classifyLeave({ href: 'http://[bad', pageHref: 'nonsense' })],
        ['order', 'order', 'website', 'signin', 'other', null, null, null, null, null, null]);
      const os = (platform, uaPlatform, maxTouchPoints) => core.classifyOs({ platform, uaPlatform, maxTouchPoints });
      t('E5 the OS is only ios, android or other, from platform hints (an iPad that says it is a Mac is still ios)',
        [os('iPhone', undefined, 5), os('iPad', undefined, 5), os('MacIntel', undefined, 5), os('MacIntel', undefined, 0), os('MacIntel', 'macOS', 0),
          os('Linux armv8l', 'Android', 5), os('Linux aarch64', undefined, 5), os('Linux x86_64', undefined, 0), os('Win32', 'Windows', 0), os(undefined, undefined, undefined)],
        ['ios', 'ios', 'ios', 'other', 'other', 'android', 'android', 'other', 'other', 'other']);
      t('E6 the device facts are screen size, density, os and hover, and nothing else',
        core.deviceDetail({ screenW: 390, screenH: 844, dpr: 3, platform: 'iPhone', uaPlatform: undefined, maxTouchPoints: 5, hover: 0, userAgent: 'Mozilla/5.0 SECRET' }),
        { w: 390, h: 844, dpr: 3, os: 'ios', hover: false });
    }
  },
  {
    name: 'F time on page: stay, visit_end, caps, a reload',
    async run(M, t) {
      const { core } = M;
      {
        const st = core.createStay();
        st.setInView('hero', true, 0);
        st.setInView('order_bar', true, 0);
        st.setVisible(false, 10000);
        const frozen = st.totals(40000);
        st.setVisible(true, 50000);
        st.setInView('hero', false, 52000);
        st.setInView('nowhere', true, 52000);
        t('F1 a page part is timed only while the page is visible, and only while it is in view',
          [frozen, st.totals(60000)], [{ hero: 10000, order_bar: 10000 }, { hero: 12000, order_bar: 20000 }]);
      }
      {
        const st = core.createStay();
        st.setInView('hero', true, 0);
        st.setInView('header', true, 0);
        st.setInView('ar', true, 5000);
        st.setCovered(true, 5000);
        const covered = st.totals(9000);
        st.setCovered(false, 9000);
        st.setInView('ar', false, 9000);
        t('F2 while the AR covers the page only the AR is timed; the parts under it stop and carry on after',
          [covered, st.totals(11000)], [{ header: 5000, hero: 5000, ar: 4000 }, { header: 7000, hero: 7000, ar: 4000 }]);
      }
      {
        const v = core.createVisit({ startT: 0 });
        v.inView('hero', true, 0);
        v.inView('viewer', true, 2000);
        v.scroll(40); v.scroll(80); v.scroll(55); v.scroll(NaN);
        v.tap(); v.tap(); v.hover(); v.spin(2500); v.spin(500);
        v.visible(false, 10000);
        v.visible(true, 25000);
        v.covered(true, 26000); v.inView('ar', true, 26000);
        const snap = v.snapshot(30000);
        t('F3 visit_end adds up: seconds on page and visible, each part in ms, deepest scroll, taps, hovers, model ms, AR ms',
          snap, { s: 30, v: 15, sec: { hero: 11000, viewer: 9000, ar: 4000 }, sd: 80, taps: 2, hov: 1, vw: 3000, ar: 4000 });
      }
      {
        const v = core.createVisit({ startT: 0 });
        v.inView('hero', true, 0);
        v.visible(false, 5000);
        const first = v.flushEnd(5000);
        const again = v.flushEnd(5000);
        const pagehideToo = v.flushEnd(5001);
        v.visible(true, 9000);
        const afterReturn = v.flushEnd(12000);
        t('F4 the same visit_end is not sent twice in a row; anything new makes the next one',
          [first && first.v, again, pagehideToo, afterReturn && afterReturn.v], [5, null, null, 8]);
      }
      {
        const v = core.createVisit({ startT: 0 });
        const taps = Array.from({ length: 70 }, () => v.tap());
        const hovers = Array.from({ length: 45 }, () => v.hover());
        const spins = Array.from({ length: 35 }, () => v.spin(100));
        let ends = 0;
        for (let i = 0; i < 50; i++) { v.tap(); if (v.flushEnd(1000 + i * 10)) ends++; }
        const snap = v.snapshot(2000);
        t('F5 caps: 60 taps, 40 hovers, 30 turns, 40 visit_ends are sent per session; every tap is still counted',
          [taps.filter(Boolean).length, hovers.filter(Boolean).length, spins.filter(Boolean).length, ends, snap.taps, snap.hov, snap.vw],
          [60, 40, 30, 40, 120, 45, 3500]);
      }
      {
        const first = core.createVisit({ startT: 0 });
        first.inView('hero', true, 0);
        first.scroll(70);
        for (let i = 0; i < 59; i++) first.tap();
        first.visible(false, 20000);
        const saved = JSON.stringify(first.export(20000));
        const second = core.createVisit({ base: saved, startT: 0 });
        second.inView('hero', true, 0);
        const okTap = second.tap();
        const noTap = second.tap();
        const snap = second.snapshot(5000);
        t('F6 a reload in the same tab carries the visit on: seconds, parts, scroll, taps and the caps',
          [snap.s, snap.sec.hero, snap.sd, snap.taps, snap.v, okTap, noTap], [25, 25000, 70, 61, 25, true, false]);
      }
      {
        const junk = ['{not json', '[]', 'null', JSON.stringify({ s: 'abc', taps: -4, sd: 900, sec: { nowhere: 5, hero: 'x' }, evil: 1 }), undefined];
        t('F7 a bad or hostile saved visit is read as nothing, never trusted',
          junk.map((j) => core.parseBase(j)).map((b) => JSON.stringify(b)),
          junk.map(() => JSON.stringify({ s: 0, v: 0, sec: {}, sd: 0, taps: 0, hov: 0, vw: 0, tapsSent: 0, hovSent: 0, spinSent: 0, endSent: 0 })).map((s, i) =>
            i === 3 ? JSON.stringify({ s: 0, v: 0, sec: {}, sd: 100, taps: 0, hov: 0, vw: 0, tapsSent: 0, hovSent: 0, spinSent: 0, endSent: 0 }) : s));
      }
    }
  },
  {
    name: 'G the whole page',
    async run(M, t, ctx) {
      const text = M.text;
      // ---- a visit with no Collector address: nothing leaves
      {
        const w = openPage(text, { collector: '' });
        w.tap(w.$('.cart-pill'));
        w.hide();
        t('G1 with no collector address nothing leaves the phone; the events are still kept in dataLayer, shaped',
          [w.beacons.length, w.dataLayer.map((e) => e.event), w.dataLayer[0].source, Object.keys(w.dataLayer[0]).sort()],
          [0, ['scan', 'tap', 'leave', 'order_tapped', 'visit_end'], 'table', ['dpr', 'event', 'h', 'hover', 'os', 'session', 'source', 't', 'w']]);
      }
      // ---- a normal visit
      {
        const w = openPage(text);
        const scan = w.sent('scan');
        t('G2 arriving sends one scan: where from, the screen, the OS, hover; no user agent, anywhere',
          [scan.length, scan[0] && scan[0].source, scan[0] && scan[0].meta, w.beacons.every((b) => !b.raw.includes('SECRET-USER-AGENT'))],
          [1, 'table', { w: 390, h: 844, dpr: 3, os: 'ios', hover: true, t: 3000 }, true]);
        w.advance(500);
        w.tap(w.$('#launch-ar-top'), { clientX: 200, clientY: 600 });
        t('G3 a tap says what it was, which part of the page, where on the screen and on the page, and when',
          w.sent('tap')[0].meta,
          { el: 'ar_button', sec: 'cta', x: 51.3, y: 80, py: 31.6, t: 3560, });
        w.tap(w.$('.offer-headline'), { clientX: 10, clientY: 100 });
        w.tap(w.$('.cart-pill'), { clientX: 350, clientY: 30 });
        const names = w.names();
        t('G4 a tap on something tagged, on nothing tagged, and on a link that leaves: tap, leave and order_tapped, each once',
          [w.sent('tap').map((e) => [e.meta.el, e.meta.sec || null]), w.sent('leave').map((e) => e.meta.to), w.sent('order_tapped').map((e) => e.meta.from),
            names.filter((n) => n === 'tap').length],
          [[['ar_button', 'cta'], ['page', 'hero'], ['cart', 'header']], ['order'], ['landing'], 3]);
        const guide = w.byId('ar-guide');
        t('G5 the start sheet opens (ar_guide_opened), and NOT NOW, the x, or a tap outside it is a guide_cancel, but START CAMERA is not',
          (() => {
            const before = w.names().filter((n) => n === 'guide_cancel').length;
            w.tap(w.$('#launch-ar-top'));          // opens
            const cancelByNotNow = (w.tap(w.$('.ar-guide__cancel')), w.names().filter((n) => n === 'guide_cancel').length);
            w.tap(w.$('#launch-ar-top'));
            const byX = (w.tap(w.$('.ar-guide__close')), w.names().filter((n) => n === 'guide_cancel').length);
            w.tap(w.$('#launch-ar-top'));
            guide.close();
            const byEscape = w.names().filter((n) => n === 'guide_cancel').length;
            const opened = w.names().filter((n) => n === 'ar_guide_opened').length;
            w.tap(w.$('#launch-ar-top'));
            w.tap(w.$('#ar-guide-start'));
            const afterStart = w.names().filter((n) => n === 'guide_cancel').length;
            return [before, cancelByNotNow, byX, byEscape, opened, afterStart];
          })(), [0, 1, 2, 3, 4, 3]);
      }
      // ---- a press with no click after it, and a click made by a script
      {
        const w = openPage(text);
        const press = { clientX: 195, clientY: 375, pointerId: 3, pointerType: 'touch', button: 0 };
        w.fire(w.$('#meal-viewer'), 'pointerdown', press);
        w.advance(80);
        w.fire(w.$('#meal-viewer'), 'pointerup', press);
        w.fire(w.$('.cart-pill'), 'click', { clientX: 5, clientY: 5, detail: 1, isTrusted: false });
        w.fire(w.$('.cart-pill'), 'pointerup', { clientX: 5, clientY: 5, pointerId: 4, pointerType: 'touch', button: 0, isTrusted: false });
        t('G4b a press that ends with no click still counts once; a click or press made by a script counts for nothing',
          [w.sent('tap').map((e) => [e.meta.el, e.meta.sec, e.meta.x, e.meta.y]), w.sent('leave').length],
          [[['viewer', 'viewer', 50, 50]], 0]);
      }
      // ---- hovers, the model, scroll, stay, visit_end, hidden twice
      {
        const w = openPage(text);
        const button = w.$('#launch-ar-top');
        w.fire(button, 'pointerover', { pointerType: 'mouse' });
        w.advance(650);
        w.fire(w.$('.offer-headline'), 'pointerover', { pointerType: 'mouse' });
        w.fire(w.$('.cart-pill'), 'pointerover', { pointerType: 'mouse' });
        w.advance(200);
        w.fire(w.$('.offer-headline'), 'pointerover', { pointerType: 'mouse' });
        w.fire(w.$('.site-logo'), 'pointerover', { pointerType: 'touch' });
        w.advance(600);
        w.fire(w.$('.offer-headline'), 'pointerover', { pointerType: 'mouse' });
        t('G6 a mouse resting 400 ms on a tagged thing is one hover with its ms; a shorter rest and a touch are none',
          w.sent('hover').map((e) => [e.meta.el, e.meta.ms]), [['ar_button', 650]]);
        const viewer = w.$('#meal-viewer');
        for (let i = 0; i < 12; i++) { w.fire(viewer, 'camera-change', { detail: { source: 'user-interaction' } }); w.advance(100); }
        w.fire(viewer, 'camera-change', { detail: { source: 'none' } });
        w.fire(viewer, 'camera-change', { detail: { source: 'interaction-prompt' } });
        w.fire(viewer, 'camera-change', {});
        const beforeIdle = w.sent('viewer_spin').length;
        w.advance(1600);
        t('G7 the model turned by hand is one viewer_spin when it is left alone for 1.5 s; its own spinning is not counted',
          [beforeIdle, w.sent('viewer_spin').map((e) => [e.meta.ms, e.meta.n])], [0, [[1100, 12]]]);
        w.inView('header'); w.inView('hero'); w.inView('viewer'); w.inView('order_bar');
        w.advance(10000);
        w.scrollTo(1200);
        for (let i = 0; i < 3; i++) { w.fire(viewer, 'camera-change', { detail: { source: 'user-interaction' } }); w.advance(100); }
        w.hide();
        const lastTwo = w.names().slice(-2);
        const firstEnd = w.sent('visit_end').slice(-1)[0].meta;
        w.advance(60000);
        w.show();
        w.advance(4000);
        w.pagehide();
        const ends = w.sent('visit_end');
        const lastEnd = ends[ends.length - 1].meta;
        t('G8 hidden: visit_end with seconds, visible seconds, each part, scroll depth, taps, hovers, model ms; hidden time is not stay time; leaving sends the new total',
          [ends.length, firstEnd.sd, firstEnd.hov, firstEnd.vw, firstEnd.sec.header >= 10000, lastEnd.s - firstEnd.s, lastEnd.v - firstEnd.v, lastEnd.sec.order_bar - firstEnd.sec.order_bar, firstEnd.ar, lastTwo],
          [2, 100, 1, 1300, true, 64 + 0, 4, 4000, 0, ['viewer_spin', 'visit_end']]);
        t('G9 a stored visit is left for a reload to carry on',
          Object.keys(JSON.parse(w.storage.get('steakout.visit'))).sort(),
          ['endSent', 'hov', 'hovSent', 'sd', 'sec', 's', 'spinSent', 'taps', 'tapsSent', 'v', 'vw'].sort());
      }
      // ---- caps and a reload in the same tab
      {
        const storage = new Map();
        const a = openPage(text, { storage });
        for (let i = 0; i < 70; i++) a.tap(a.$('.offer-headline'));
        a.hide();
        const b = openPage(text, { storage, startAt: 2000 });
        for (let i = 0; i < 5; i++) b.tap(b.$('.offer-headline'));
        b.hide();
        const lastEnd = b.sent('visit_end').slice(-1)[0].meta;
        t('G10 70 taps send 60; a reload in the same tab sends no second scan, no more taps, and a visit_end that is the whole visit',
          [a.sent('tap').length, b.sent('scan').length, b.sent('tap').length, lastEnd.taps], [60, 0, 0, 75]);
      }
      // ---- the AR conversation
      {
        const w = openPage(text);
        w.fromFrame('steakout-ar-ready');
        w.tap(w.$('#launch-ar-top'));
        w.tap(w.$('#ar-guide-start'));
        await w.settle();
        w.fromFrame('steakout-ar-camera-live', { ms: 1840.4, run: 1 });
        w.fromFrame('steakout-ar-order-shown');
        w.fromFrame('steakout-ar-locked', { ms: 3200, run: 1 });
        w.fromFrame('steakout-ar-lost', { run: 1, n: 1 });
        w.fromFrame('steakout-ar-refound', { run: 1, ms: 900 });
        w.advance(5000);
        w.fromFrame('steakout-ar-tap', { el: 'ar_order', x: 50, y: 92 });
        w.fromFrame('steakout-ar-order-tapped');
        w.fromFrame('steakout-ar-close', { run: 1, ms: 8200, locked: 5000, lost: 1 });
        w.advance(3000);
        const get = (name) => w.sent(name).map((e) => e.meta);
        t('G11 the AR is told through the frame: camera_live, lock, lost, refound, a tap in AR, order_tapped from ar, ar_closed, browser_ar_closed',
          [get('ar_launch_tapped').length, get('browser_ar_opened').length, get('camera_live').map((m) => [m.ms, m.run]), get('lock').map((m) => [m.ms, m.run]),
            get('lost').map((m) => [m.run, m.n]), get('refound').map((m) => [m.run, m.ms]),
            get('tap').filter((m) => m.sec === 'ar').map((m) => [m.el, m.x, m.y, m.py === undefined]),
            get('order_tapped').map((m) => m.from), get('ar_closed').map((m) => [m.run, m.ms, m.locked, m.lost]), get('browser_ar_closed').length],
          [1, 1, [[1840, 1]], [[3200, 1]], [[1, 1]], [[1, 900]], [['ar_order', 50, 92, true]], ['ar'], [[1, 8200, 5000, 1]], 1]);
        w.hide();
        t('G12 time in AR is the AR layer open and the page visible; the page parts under it do not count meanwhile',
          (() => { const e = w.sent('visit_end').slice(-1)[0].meta; return [e.ar, e.sec.ar]; })(), [5000, 5000]);
        // a frame that sends rubbish
        const x = openPage(text);
        x.fromFrame('steakout-ar-ready');
        x.tap(x.$('#launch-ar-top'));
        x.tap(x.$('#ar-guide-start'));
        await x.settle();
        x.fromFrame('steakout-ar-camera-live', { ms: 'soon', run: -4, secret: 'poses', ua: 'Mozilla' });
        x.fromFrame('steakout-ar-camera-error', { err: 'NotAllowedError: Permission denied (jo@example.com)' });
        x.fromFrame('steakout-ar-camera-error', { err: 'permission' });
        x.fromFrame('steakout-ar-lost', 'not even an object');
        x.fromFrame('steakout-ar-tap', { el: 'Bad Key', x: 1, y: 1 });
        x.fromFrame('steakout-ar-unheard-of', { ms: 1 });
        const noT = (e) => { const { t: when, ...rest } = e.meta; return rest; };
        t('G13 a frame message with junk in it sends only what is whole and listed',
          [x.sent('camera_live').map(noT), x.sent('camera_error').map(noT), x.sent('lost').map(noT), x.sent('tap').filter((e) => e.meta.sec === 'ar').length],
          [[{ run: 0 }], [{}, { err: 'permission' }], [{}], 0]);
        // a frame from somewhere else is ignored
        const y = openPage(text);
        y.fire(y.sandbox, 'message', { source: {}, origin: 'https://lunch.mysteakout.com', data: { type: 'steakout-ar-locked' } });
        y.fire(y.sandbox, 'message', { source: y.byId('browser-ar-frame').contentWindow, origin: 'https://evil.example', data: { type: 'steakout-ar-locked' } });
        t('G14 a message from another window or another origin is ignored', y.sent('lock').length, 0);
      }
      // ---- a touch phone has no hover; a throwing beacon breaks nothing
      {
        const w = openPage(text, { hover: false, platform: 'Linux armv8l', uaPlatform: 'Android' });
        w.fire(w.$('#launch-ar-top'), 'pointerover', { pointerType: 'mouse' });
        w.advance(2000);
        w.fire(w.$('.cart-pill'), 'pointerover', { pointerType: 'mouse' });
        t('G15 where a mouse cannot hover nothing is tracked as a hover, and the scan says so and says android',
          [w.sent('hover').length, w.sent('scan')[0].meta.hover, w.sent('scan')[0].meta.os], [0, false, 'android']);
        const z = openPage(text);
        z.sandbox.navigator.sendBeacon = () => { throw new Error('offline'); };
        Object.defineProperty(z.document.documentElement, 'scrollHeight', { get() { throw new Error('layout broke'); } });
        let broke = null;
        try {
          z.tap(z.$('.cart-pill'));
          z.fromFrame('steakout-ar-locked', { get ms() { throw new Error('bad detail'); } });
          z.hide();
        } catch (error) { broke = error.message; }
        t('G16 a page whose tracking is broken still works: the order tap goes on', [broke, z.dataLayer.some((e) => e.event === 'order_tapped')], [null, true]);
      }
      // ---- every message held to the Collector's rules
      {
        const w = openPage(text, { url: 'https://lunch.mysteakout.com/preview/?c=Table%20Top%21' });
        w.fromFrame('steakout-ar-ready');
        w.tap(w.$('#launch-ar-top'));
        w.tap(w.$('#ar-guide-start'));
        await w.settle();
        w.fromFrame('steakout-ar-camera-live', { ms: 1000, run: 1 });
        w.fromFrame('steakout-ar-locked', { ms: 2000, run: 1 });
        w.fromFrame('steakout-ar-close', { run: 1, ms: 5000, locked: 3000, lost: 0 });
        w.tap(w.$('.bottom-order-bar a'));
        w.hide();
        const names = new Set(w.names());
        const refused = w.beacons.map((b) => collectorAccepts(b.raw)).filter(Boolean);
        const strangers = w.beacons.filter((b) => !Object.prototype.hasOwnProperty.call(CONTRACT.events, b.body.name)
          || Object.keys(b.body.meta).some((k) => k !== 't' && !CONTRACT.events[b.body.name].includes(k))).length;
        t('G17 every message passes the Collector’s own rules, is an Orbit event, and carries only Orbit’s keys',
          [refused, strangers, names.has('scan'), names.has('visit_end'), w.beacons.every((b) => b.url === 'https://collector.example.workers.dev/collect'), [...new Set(w.beacons.map((b) => b.body.source))]],
          [[], 0, true, true, true, ['tabletop']]);
      }
    }
  },
  {
    name: 'H the files',
    async run(M, t) {
      const { text } = M;
      const dataTracks = [...text.index.matchAll(/data-track="([^"]*)"/g)].map((m) => m[1]);
      const arTracks = [...text.markerHtml.matchAll(/data-track="([^"]*)"/g)].map((m) => m[1]);
      const sections = [...text.index.matchAll(/data-section="([^"]*)"/g)].map((m) => m[1]);
      t('H1 every data-track and data-section Orbit is told about is on the page, and nothing Orbit does not know',
        [dataTracks.filter((k) => !CONTRACT.labels.includes(k)), arTracks.filter((k) => !CONTRACT.labels.includes(k)),
          sections.filter((s) => !CONTRACT.sections.includes(s)),
          CONTRACT.labels.filter((k) => k !== 'page' && ![...dataTracks, ...arTracks].includes(k)),
          CONTRACT.sections.filter((s) => !sections.includes(s)), M.core.SECTIONS.slice().sort()],
        [[], [], [], [], [], CONTRACT.sections.slice().sort()]);
      const order = ['config.js', 'tracking-core.js', 'tracking.js', 'app.js'].map((f) => text.index.indexOf(`./${f}?v=`));
      t('H2 the scripts load in order (config, core, tracking, app) and carry a dated cache token',
        [order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), /tracking\.js\?v=\d{8}-[a-z0-9]+/.test(text.index), /marker\.html\?embedded=1&amp;v=\d{8}-[a-z0-9]+/.test(text.index)],
        [true, true, true]);
      t('H3 no collector address is written into the site: config.collectorUrl is empty, app.js reads it, no constant is left',
        [/collectorUrl:\s*''/.test(text.config), /config\.collectorUrl/.test(text.app), /COLLECTOR_URL\s*=/.test(text.app), /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/.test(text.app + text.config + text.core + text.tracking)],
        [true, true, false, false]);
      const tracked = text.core + text.tracking;
      t('H4 the user agent, cookies, local storage, the camera and form fields are never read by the tracking',
        [/\buserAgent\b(?!Data)/.test(tracked), /document\.cookie/.test(tracked), /localStorage/.test(tracked), /getUserMedia|mediaDevices/.test(tracked), /\.value\b/.test(tracked), /querySelector\(['"]input|textarea/.test(tracked)],
        [false, false, false, false, false, false]);
      t('H5 sessionStorage holds the two old keys and one new one, counters only',
        [[...(text.app.matchAll(/steakout\.[a-z]+/g))].map((m) => m[0]).sort(), [...tracked.matchAll(/'steakout\.[a-z]+'/g)].map((m) => m[0])],
        [['steakout.session', 'steakout.source'], ["'steakout.visit'"]]);
      t('H6 marker.js reports its run through one message with a detail, closes through one function, and the in-AR buttons are tagged',
        [/const postToParent = \(type, detail\)/.test(text.marker), (text.marker.match(/postToParent\('steakout-ar-close'/g) || []).length,
          /data-track="ar_order"/.test(text.markerHtml), /data-track="ar_close"/.test(text.markerHtml),
          /steakout-ar-lost/.test(text.marker) && /steakout-ar-refound/.test(text.marker), /MAX_LOST_EVENTS = 10;/.test(text.marker),
          /steakout-ar-camera-error', \{ err: faultKind\(\) \}/.test(text.marker), /err: 'load'/.test(text.marker)],
        [true, 1, true, true, true, true, true, true]);
    }
  }
];

/* ------------------------------------------------------------- mutations */

const C = 'core';
const MUTATIONS = [
  // the contract
  { name: 'core: tap loses its py key', file: C, from: "tap: Object.freeze(['el', 'sec', 'x', 'y', 'py', 't'])", to: "tap: Object.freeze(['el', 'sec', 'x', 'y', 't'])", check: 'A2 each event is allowed exactly Orbit’s meta keys' },
  { name: 'core: lock carries an extra key', file: C, from: "lock: Object.freeze(['ms', 'run'])", to: "lock: Object.freeze(['ms', 'run', 'item'])", check: 'A2 each event is allowed exactly Orbit’s meta keys' },
  { name: 'core: an event Orbit does not list', file: C, from: "ar_mode_changed: Object.freeze([])", to: "ar_mode_changed: Object.freeze([]),\n    free_lunch: Object.freeze([])", check: 'A1 the events are exactly Orbit’s list' },
  { name: 'core: an unknown event is sent as it is', file: C, from: "if (typeof name !== 'string' || !hasOwn(EVENT_KEYS, name)) return null;", to: "if (typeof name !== 'string') return null;\n    if (!hasOwn(EVENT_KEYS, name)) return { name, meta: { ...(isObject(detail) ? detail : {}) } };", check: 'A3 a name or a key that is not in the list is dropped' },
  { name: 'core: any inherited name is an event', file: C, from: 'hasOwn(EVENT_KEYS, name)', to: '(name in EVENT_KEYS)', check: 'A3 a name or a key that is not in the list is dropped' },
  { name: 'core: unlisted keys are forwarded', file: C, from: "for (const key of EVENT_KEYS[name]) {\n      if (!hasOwn(given, key)) continue;", to: "for (const key of Object.keys(given).filter((k) => hasOwn(RULES, k))) {\n      if (!hasOwn(given, key)) continue;", check: 'A3 a name or a key that is not in the list is dropped' },
  { name: 'core: numbers are not clamped', file: C, from: 'const intUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined);', to: 'const intUpTo = (max) => (value) => (isNumber(value) ? Math.round(value) : undefined);', check: 'A4 values are rebuilt: numbers clamped and rounded, words checked, junk dropped' },
  { name: 'core: x is rounded to a whole number', file: C, from: 'const tenthUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, round1(value))) : undefined);', to: 'const tenthUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined);', check: 'A4 values are rebuilt: numbers clamped and rounded, words checked, junk dropped' },
  { name: 'core: any word is accepted for a choice', file: C, from: "const oneOf = (words) => (value) => (typeof value === 'string' && words.includes(value) ? value : undefined);", to: "const oneOf = (words) => (value) => (typeof value === 'string' ? value : undefined);", check: 'A4 values are rebuilt: numbers clamped and rounded, words checked, junk dropped' },
  { name: 'core: err takes any text', file: C, from: 'err: matching(ERR_RE),', to: "err: (v) => (typeof v === 'string' ? v : undefined),", check: 'A4 values are rebuilt: numbers clamped and rounded, words checked, junk dropped' },
  { name: 'core: numeric strings are numbers', file: C, from: "const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);", to: 'const isNumber = (value) => Number.isFinite(Number(value)) && value !== null && value !== \'\';', check: 'A4 values are rebuilt: numbers clamped and rounded, words checked, junk dropped' },
  { name: 'core: t is left off', file: C, from: 'if (t !== undefined) meta.t = t;', to: '', check: 'A5 every event carries t; a tap brings its own, the rest are stamped as sent' },
  { name: 'core: every event may bring its own t', file: C, from: "name === 'tap' && isNumber(given.t) ? given.t : ctx.t", to: 'isNumber(given.t) ? given.t : ctx.t', check: 'A5 every event carries t; a tap brings its own, the rest are stamped as sent' },
  { name: 'core: the meta limit is far too small', file: C, from: 'MAX_META_BYTES = 1400', to: 'MAX_META_BYTES = 14', check: 'A6 the biggest possible visit_end fits under the Collector’s meta limit' },
  { name: 'core: section times are all dropped', file: C, from: "      if (!hasOwn(value, section)) continue;\n      const ms = clamp(value[section]);", to: "      if (!hasOwn(value, section)) continue;\n      const ms = clamp(value[section]) && 0;", check: 'A6 the biggest possible visit_end fits under the Collector’s meta limit' },
  { name: 'core: the placement is not lowercased', file: C, from: 'raw.toLowerCase().replace(', to: 'raw.replace(', check: 'A7 the placement is made acceptable to the Collector; nothing usable means direct' },
  { name: 'core: the placement is not cut to 40', file: C, from: '.slice(0, 40) : \'\';', to: ' : \'\';', check: 'A7 the placement is made acceptable to the Collector; nothing usable means direct' },
  { name: 'core: http is accepted', file: C, from: "(url.protocol === 'http:' && local)", to: "(url.protocol === 'http:')", check: 'A8 the address: empty means none; https yes; plain http only for this machine; no logins' },
  { name: 'core: a login in the address is accepted', file: C, from: 'if (url.username || url.password) return \'\';', to: '', check: 'A8 the address: empty means none; https yes; plain http only for this machine; no logins' },
  { name: 'core: sends even with no address', file: C, from: 'if (!shaped || !target || !sessionOk || typeof beacon !== \'function\') return shaped;', to: 'if (!shaped || !sessionOk || typeof beacon !== \'function\') return shaped;', check: 'A9 one beacon with name, source, session, at and meta; no address or a bad session sends nothing; a failing beacon is swallowed' },
  { name: 'core: a bad session id is sent', file: C, from: 'const sessionOk = typeof session === \'string\' && SESSION_RE.test(session);', to: 'const sessionOk = true;', check: 'A9 one beacon with name, source, session, at and meta; no address or a bad session sends nothing; a failing beacon is swallowed' },
  { name: 'core: a failing beacon throws', file: C, from: '      try {\n        beacon(target, body);\n      } catch (error) {\n        /* measurement never breaks the experience */\n      }', to: '      beacon(target, body);', check: 'A9 one beacon with name, source, session, at and meta; no address or a bad session sends nothing; a failing beacon is swallowed' },
  // element and page part
  { name: 'core: the farthest data-track wins', file: C, from: "      if (el === null) {\n        const key = n.getAttribute('data-track');\n        if (key && TOKEN_RE.test(key)) {", to: "      {\n        const key = n.getAttribute('data-track');\n        if (key && TOKEN_RE.test(key)) {", check: 'B1 the nearest data-track is the element, however deep the tap was' },
  { name: 'core: an unknown section falls through to the next', file: C, from: 'sec = SECTIONS.includes(name) ? name : null;', to: 'if (SECTIONS.includes(name)) sec = name; else secSeen = false;', check: 'B2 the nearest data-section is the page part; an unknown one is none, not its neighbour' },
  { name: 'core: nothing tagged is not "page"', file: C, from: "return { el: el === null ? 'page' : el, node: tagged, sec };", to: "return { el: el === null ? 'unknown' : el, node: tagged, sec };", check: 'B3 nothing tagged is "page", with no page part; a bad key is not an element' },
  // positions
  { name: 'core: percentages are not held at 100', file: C, from: 'return round1(Math.min(100, Math.max(0, (value / total) * 100)));', to: 'return round1((value / total) * 100);', check: 'C1 percentages are to 0.1, held between 0 and 100, and null with nothing to measure against' },
  { name: 'core: py is measured on the screen, not the page', file: C, from: 'py: pct1(clientY + (isNumber(scrollY) ? scrollY : 0), Math.max(isNumber(pageH) ? pageH : 0, viewH)),', to: 'py: pct1(clientY, viewH),', check: 'C2 x, y are of the screen; py is of the whole page, scrolled or not; no screen no tap' },
  { name: 'core: a tap with no screen is sent anyway', file: C, from: 'if (x === null || y === null) return null;\n    const hit', to: 'const hit', check: 'C2 x, y are of the screen; py is of the whole page, scrolled or not; no screen no tap' },
  { name: 'core: an AR frame tap is filed under the page', file: C, from: "return { el, sec: 'ar', x, y, t };", to: "return { el, sec: null, x, y, t };", check: 'C3 a tap reported by the AR frame is filed under ar, and only if it is whole' },
  // what counts as a tap
  { name: 'core: the click after a pointer-up counts again', file: C, from: 'return time - lastUpAt > windowMs;', to: 'return true;', check: 'D1 a finger that stays put is one tap; its click is the same tap' },
  { name: 'core: a drag is a tap', file: C, from: 'return Math.hypot(x - down.x, y - down.y) <= slop;', to: 'return true;', check: 'D2 a drag is not a tap, and the click that ends one is not either' },
  { name: 'core: a keyboard click is lost', file: C, from: 'return time - lastUpAt > windowMs;', to: 'return false;', check: 'D3 a key press on a button (a click with no pointer before it) is a tap' },
  { name: 'core: the right button is a tap', file: C, from: "if (typeof button === 'number' && button !== 0) return false;", to: '', check: 'D4 not the right mouse button, not a cancelled touch, not a pointer-up with no press' },
  { name: 'core: a pointer-up with no press is a tap', file: C, from: 'if (!down) return false;', to: 'if (!down) return true;', check: 'D4 not the right mouse button, not a cancelled touch, not a pointer-up with no press' },
  // hover, spin, leave, device
  { name: 'core: any rest is a hover', file: C, from: 'HOVER_MIN_MS = 400', to: 'HOVER_MIN_MS = 1', check: 'E1 a hover is a rest of 400 ms or more on a tagged thing, reported once when it ends, with its ms' },
  { name: 'core: a rest starts over on every move', file: C, from: 'if (current && key !== null && current.key === key) return null;', to: '', check: 'E2 staying on the same thing is one rest, however many pointer moves reach it' },
  { name: 'core: a turn forgets how many changes', file: C, from: 'burst.n += 1;', to: '', check: 'E3 many camera changes are one turn: how long, and how many changes; none is nothing' },
  { name: 'core: sign in is not told from the website', file: C, from: "if (track === 'sign_in') return 'signin';", to: '', check: 'E4 where a tap on a link goes: order, website, sign in, other; the same site, mail and phone are not leaving' },
  { name: 'core: the same site is leaving', file: C, from: 'if (to.origin === here.origin) return null;', to: '', check: 'E4 where a tap on a link goes: order, website, sign in, other; the same site, mail and phone are not leaving' },
  { name: 'core: a phone number is leaving', file: C, from: "if (to.protocol !== 'http:' && to.protocol !== 'https:') return null;", to: '', check: 'E4 where a tap on a link goes: order, website, sign in, other; the same site, mail and phone are not leaving' },
  { name: 'core: an iPad is a Mac', file: C, from: "if (/mac/.test(hint) && touch > 1) return 'ios';", to: '', check: 'E5 the OS is only ios, android or other, from platform hints (an iPad that says it is a Mac is still ios)' },
  { name: 'core: a Linux box is Android', file: C, from: "if (/linux/.test(hint) && touch > 0) return 'android';", to: "if (/linux/.test(hint)) return 'android';", check: 'E5 the OS is only ios, android or other, from platform hints (an iPad that says it is a Mac is still ios)' },
  { name: 'core: the device facts bring the user agent', file: C, from: 'function deviceDetail({ screenW, screenH, dpr, platform, uaPlatform, maxTouchPoints, hover }) {\n    return {', to: 'function deviceDetail({ screenW, screenH, dpr, platform, uaPlatform, maxTouchPoints, hover, userAgent }) {\n    return {\n      userAgent,', check: 'E6 the device facts are screen size, density, os and hover, and nothing else' },
  // time
  { name: 'core: stay counts while the page is hidden', file: C, from: 'const counting = (section) => pageVisible && on.has(section)', to: 'const counting = (section) => on.has(section)', check: 'F1 a page part is timed only while the page is visible, and only while it is in view' },
  { name: 'core: the AR does not cover the page', file: C, from: "(section === 'ar' || !covered)", to: 'true', check: 'F2 while the AR covers the page only the AR is timed; the parts under it stop and carry on after' },
  { name: 'core: visible time is not kept', file: C, from: 'v: Math.round((visibleMs + (pageVisible ? t - visibleSince : 0)) / 1000),', to: 's2: 0, v: Math.round((pageVisible ? t - visibleSince : 0) / 1000),', check: 'F3 visit_end adds up: seconds on page and visible, each part in ms, deepest scroll, taps, hovers, model ms, AR ms' },
  { name: 'core: scroll depth is the last, not the deepest', file: C, from: 'if (isNumber(percent) && percent > deepest) deepest = Math.min(100, Math.round(percent));', to: 'if (isNumber(percent)) deepest = Math.min(100, Math.round(percent));', check: 'F3 visit_end adds up: seconds on page and visible, each part in ms, deepest scroll, taps, hovers, model ms, AR ms' },
  { name: 'core: the AR time is not reported', file: C, from: 'ar: sec.ar || 0', to: 'ar: 0', check: 'F3 visit_end adds up: seconds on page and visible, each part in ms, deepest scroll, taps, hovers, model ms, AR ms' },
  { name: 'core: the same visit_end is sent twice', file: C, from: 'if (signature === lastEnd) return null;', to: '', check: 'F4 the same visit_end is not sent twice in a row; anything new makes the next one' },
  { name: 'core: a visit_end is never sent again after the first', file: C, from: 'if (signature === lastEnd) return null;', to: 'if (lastEnd !== null) return null;', check: 'F4 the same visit_end is not sent twice in a row; anything new makes the next one' },
  { name: 'core: the tap cap is 600', file: C, from: 'taps: 60, hovers: 40', to: 'taps: 600, hovers: 40', check: 'F5 caps: 60 taps, 40 hovers, 30 turns, 40 visit_ends are sent per session; every tap is still counted' },
  { name: 'core: capped taps are not counted', file: C, from: "tap() {\n        taps += 1;\n        if (sent.taps >= CAPS.taps) return false;", to: "tap() {\n        if (sent.taps >= CAPS.taps) return false;\n        taps += 1;", check: 'F5 caps: 60 taps, 40 hovers, 30 turns, 40 visit_ends are sent per session; every tap is still counted' },
  { name: 'core: no visit_end cap', file: C, from: 'if (sent.ends >= CAPS.ends) return null;', to: '', check: 'F5 caps: 60 taps, 40 hovers, 30 turns, 40 visit_ends are sent per session; every tap is still counted' },
  { name: 'core: the hover cap is forgotten', file: C, from: 'if (sent.hovers >= CAPS.hovers) return false;', to: '', check: 'F5 caps: 60 taps, 40 hovers, 30 turns, 40 visit_ends are sent per session; every tap is still counted' },
  { name: 'core: the turn cap is forgotten', file: C, from: 'if (sent.spins >= CAPS.spins) return false;', to: '', check: 'F5 caps: 60 taps, 40 hovers, 30 turns, 40 visit_ends are sent per session; every tap is still counted' },
  { name: 'core: a reload starts the seconds again', file: C, from: 's: Math.round((prior.s + (t - startT)) / 1000),', to: 's: Math.round((t - startT) / 1000),', check: 'F6 a reload in the same tab carries the visit on: seconds, parts, scroll, taps and the caps' },
  { name: 'core: a reload forgets the tap cap', file: C, from: 'tapsSent: int(\'tapsSent\', 9999),', to: 'tapsSent: 0,', check: 'F6 a reload in the same tab carries the visit on: seconds, parts, scroll, taps and the caps' },
  { name: 'core: a reload forgets the page parts', file: C, from: 'stay.load(prior.sec);', to: '', check: 'F6 a reload in the same tab carries the visit on: seconds, parts, scroll, taps and the caps' },
  { name: 'core: a saved visit is trusted as it is', file: C, from: 'const given = isObject(raw) ? raw : {};\n    const int = (key, max) => intUpTo(max)(given[key]) || 0;', to: 'const given = isObject(raw) ? raw : {};\n    const int = (key, max) => given[key] || 0;', check: 'F7 a bad or hostile saved visit is read as nothing, never trusted' },
  // the page: tracking.js and app.js
  { name: 'tracking: pointer-up is not watched', file: 'tracking', from: "listen(document, 'pointerup', (event) => {\n      if (!event.isPrimary || !event.isTrusted) return;", to: "listen(document, 'pointerup', (event) => {\n      return;", check: 'G4b a press that ends with no click still counts once; a click or press made by a script counts for nothing' },
  { name: 'tracking: a script-made click counts', file: 'tracking', from: "listen(document, 'click', (event) => {\n      if (!event.isTrusted) return;", to: "listen(document, 'click', (event) => {", check: 'G4b a press that ends with no click still counts once; a click or press made by a script counts for nothing' },
  { name: 'tracking: leaving is not reported', file: 'tracking', from: "if (to) emit('leave', { to });", to: '', check: 'G4 a tap on something tagged, on nothing tagged, and on a link that leaves: tap, leave and order_tapped, each once' },
  { name: 'tracking: the click is counted as a second tap', file: 'tracking', from: 'if (tapFilter.click(event.timeStamp)) recordTap(event);', to: 'recordTap(event);', check: 'G4 a tap on something tagged, on nothing tagged, and on a link that leaves: tap, leave and order_tapped, each once' },
  { name: 'app: a cancelled start sheet is not reported', file: 'app', from: "if (!guideStarted) track('guide_cancel');", to: '', check: 'G5 the start sheet opens (ar_guide_opened), and NOT NOW, the x, or a tap outside it is a guide_cancel, but START CAMERA is not' },
  { name: 'app: START CAMERA counts as a cancel', file: 'app', from: '    guideStarted = true;\n    closeARGuide();', to: '    closeARGuide();', check: 'G5 the start sheet opens (ar_guide_opened), and NOT NOW, the x, or a tap outside it is a guide_cancel, but START CAMERA is not' },
  { name: 'tracking: hover waits on nothing', file: 'tracking', from: 'const rest = core.createHoverRest();', to: 'const rest = core.createHoverRest({ minMs: 0 });', check: 'G6 a mouse resting 400 ms on a tagged thing is one hover with its ms; a shorter rest and a touch are none' },
  { name: 'tracking: a touch is a hover', file: 'tracking', from: "if (event.pointerType !== 'mouse') return;\n        const hit", to: 'const hit', check: 'G6 a mouse resting 400 ms on a tagged thing is one hover with its ms; a shorter rest and a touch are none' },
  { name: 'tracking: the model\'s own spinning is counted', file: 'tracking', from: "if (!event.detail || event.detail.source !== 'user-interaction') return;", to: '', check: 'G7 the model turned by hand is one viewer_spin when it is left alone for 1.5 s; its own spinning is not counted' },
  { name: 'tracking: a turn is sent on every change', file: 'tracking', from: 'idleTimer = window.setTimeout(safely(finishSpin), core.SPIN_IDLE_MS);', to: 'idleTimer = window.setTimeout(safely(finishSpin), 0); finishSpin();', check: 'G7 the model turned by hand is one viewer_spin when it is left alone for 1.5 s; its own spinning is not counted' },
  { name: 'tracking: hidden sends no visit_end', file: 'tracking', from: "if (document.visibilityState === 'hidden') {\n        visit.visible(false, t);\n        flush();", to: "if (document.visibilityState === 'hidden') {\n        visit.visible(false, t);", check: 'G8 hidden: visit_end with seconds, visible seconds, each part, scroll depth, taps, hovers, model ms; hidden time is not stay time; leaving sends the new total' },
  { name: 'tracking: scroll depth is not watched', file: 'tracking', from: "listen(window, 'scroll', queueScroll, { passive: true });", to: '', check: 'G8 hidden: visit_end with seconds, visible seconds, each part, scroll depth, taps, hovers, model ms; hidden time is not stay time; leaving sends the new total' },
  { name: 'tracking: leaving the page sends nothing', file: 'tracking', from: "listen(window, 'pagehide', () => {\n      visit.visible(false, now());\n      flush();\n    });", to: '', check: 'G8 hidden: visit_end with seconds, visible seconds, each part, scroll depth, taps, hovers, model ms; hidden time is not stay time; leaving sends the new total' },
  { name: 'tracking: a turn in progress is lost when hidden', file: 'tracking', from: 'flushers.push(finishSpin);', to: '', check: 'G8 hidden: visit_end with seconds, visible seconds, each part, scroll depth, taps, hovers, model ms; hidden time is not stay time; leaving sends the new total' },
  { name: 'tracking: the visit is not saved', file: 'tracking', from: 'const persist = (t) => writeStore(VISIT_KEY, JSON.stringify(visit.export(t)));', to: 'const persist = (t) => {};', check: 'G9 a stored visit is left for a reload to carry on' },
  { name: 'tracking: a reload starts the visit over', file: 'tracking', from: 'base: readStore(VISIT_KEY),', to: 'base: null,', check: 'G10 70 taps send 60; a reload in the same tab sends no second scan, no more taps, and a visit_end that is the whole visit' },
  { name: 'app: a reload scans again', file: 'app', from: 'if (isNewVisit) {', to: 'if (true) {', check: 'G10 70 taps send 60; a reload in the same tab sends no second scan, no more taps, and a visit_end that is the whole visit' },
  { name: 'app: the AR opening is not told to tracking', file: 'app', from: "    notifyTracking('arState', true);", to: '', check: 'G12 time in AR is the AR layer open and the page visible; the page parts under it do not count meanwhile' },
  { name: 'app: the AR closing is not told to tracking', file: 'app', from: "    notifyTracking('arState', false);", to: '', check: 'G12 time in AR is the AR layer open and the page visible; the page parts under it do not count meanwhile' },
  { name: 'app: the detail of lock is dropped', file: 'app', from: "track('lock', event.data.detail);", to: "track('lock');", check: 'G11 the AR is told through the frame: camera_live, lock, lost, refound, a tap in AR, order_tapped from ar, ar_closed, browser_ar_closed' },
  { name: 'app: ar_closed loses its detail', file: 'app', from: "track('ar_closed', event.data.detail);", to: "track('ar_closed');", check: 'G11 the AR is told through the frame: camera_live, lock, lost, refound, a tap in AR, order_tapped from ar, ar_closed, browser_ar_closed' },
  { name: 'app: AR frame taps are ignored', file: 'app', from: "notifyTracking('frameTap', event.data.detail);", to: '', check: 'G11 the AR is told through the frame: camera_live, lock, lost, refound, a tap in AR, order_tapped from ar, ar_closed, browser_ar_closed' },
  { name: 'app: lost is not reported', file: 'app', from: "track('lost', event.data.detail);", to: '', check: 'G11 the AR is told through the frame: camera_live, lock, lost, refound, a tap in AR, order_tapped from ar, ar_closed, browser_ar_closed' },
  { name: 'app: camera_live forwards the raw message', file: 'app', from: "track('camera_live', event.data.detail);", to: "track('camera_live', event.data);", check: 'G13 a frame message with junk in it sends only what is whole and listed' },
  { name: 'app: any window may talk to the page', file: 'app', from: 'if (!browserARFrame?.contentWindow || event.source !== browserARFrame.contentWindow) return;', to: 'if (!browserARFrame?.contentWindow) return;', check: 'G14 a message from another window or another origin is ignored' },
  { name: 'app: any origin may talk to the page', file: 'app', from: 'if (event.origin !== window.location.origin) return;\n\n    if (event.data?.type === \'steakout-ar-ready\')', to: 'if (event.data?.type === \'steakout-ar-ready\')', check: 'G14 a message from another window or another origin is ignored' },
  { name: 'tracking: hover is watched on a touch phone too', file: 'tracking', from: 'if (canHover()) {', to: 'if (true) {', check: 'G15 where a mouse cannot hover nothing is tracked as a hover, and the scan says so and says android' },
  { name: 'app: the scan brings no device facts', file: 'app', from: "track('scan', device);", to: "track('scan');", check: 'G2 arriving sends one scan: where from, the screen, the OS, hover; no user agent, anywhere' },
  { name: 'app: a failing shaper breaks track', file: 'app', from: 'try { shaped = send ? send(eventName, detail) : null; } catch (error) { /* measurement never breaks the experience */ }', to: 'shaped = send ? send(eventName, detail) : null;', check: 'G16 a page whose tracking is broken still works: the order tap goes on' },
  { name: 'tracking: a failing handler breaks the page', file: 'tracking', from: "target.addEventListener(type, safely(handler), options);", to: "target.addEventListener(type, handler, options);", check: 'G16 a page whose tracking is broken still works: the order tap goes on' },
  { name: 'app: the placement is sent raw', file: 'core', from: 'source: cleanedSource,', to: 'source,', check: 'G17 every message passes the Collector’s own rules, is an Orbit event, and carries only Orbit’s keys' },
  // the files
  { name: 'index: a data-track key Orbit does not know', file: 'index', from: 'data-track="sign_in"', to: 'data-track="signin_link"', check: 'H1 every data-track and data-section Orbit is told about is on the page, and nothing Orbit does not know' },
  { name: 'index: tracking loads after app', file: 'index', from: '<script defer src="./tracking.js?v=20261008-track1"></script>\n  <script defer src="./app.js?v=20261008-track1"></script>', to: '<script defer src="./app.js?v=20261008-track1"></script>\n  <script defer src="./tracking.js?v=20261008-track1"></script>', check: 'H2 the scripts load in order (config, core, tracking, app) and carry a dated cache token' },
  { name: 'config: a collector address is written in', file: 'config', from: "collectorUrl: '',", to: "collectorUrl: 'https://steakout-ar-collector.example.workers.dev/collect',", check: 'H3 no collector address is written into the site: config.collectorUrl is empty, app.js reads it, no constant is left' },
  { name: 'tracking: reads the user agent', file: 'tracking', from: "const nav = window.navigator || {};", to: "const nav = window.navigator || {};\n    const ua = nav.userAgent;", check: 'H4 the user agent, cookies, local storage, the camera and form fields are never read by the tracking' },
  { name: 'tracking: a fourth storage key', file: 'tracking', from: "const VISIT_KEY = 'steakout.visit';", to: "const VISIT_KEY = 'steakout.visit';\n  const PROFILE_KEY = 'steakout.profile';", check: 'H5 sessionStorage holds the two old keys and one new one, counters only' },
  { name: 'marker: closes without going through requestClose', file: 'marker', from: "event.preventDefault(); requestClose(); });", to: "event.preventDefault(); postToParent('steakout-ar-close'); });", check: 'H6 marker.js reports its run through one message with a detail, closes through one function, and the in-AR buttons are tagged' },
  { name: 'marker: more than ten lost a run', file: 'marker', from: 'MAX_LOST_EVENTS = 10', to: 'MAX_LOST_EVENTS = 100', check: 'H6 marker.js reports its run through one message with a detail, closes through one function, and the in-AR buttons are tagged' },
  { name: 'marker.html: the in-AR order button is untagged', file: 'markerHtml', from: ' data-track="ar_order"', to: '', check: 'H6 marker.js reports its run through one message with a detail, closes through one function, and the in-AR buttons are tagged' },
];

/* --------------------------------------------------------------- running */

async function runAll(mutations, { quiet } = {}) {
  const text = loadText(mutations);
  const M = { text, core: loadCore(text) };
  const all = [];
  let passed = 0;
  for (const c of CASES) {
    const results = [];
    const t = (name, got, want) => {
      const g = JSON.stringify(got === undefined ? '__undefined__' : got);
      const w = JSON.stringify(want);
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

(async () => {
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
  if (!contractFile) console.log(`  note: the Orbit checkout was not found at ${ORBIT_CONTRACT}; the contract was compared against the copy in this file.`);
  process.exitCode = failed ? 1 : 0;
})();
