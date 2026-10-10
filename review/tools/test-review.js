'use strict';

/* THE REVIEW PAGE, CHECKED WITHOUT A PHONE (2026-10-08).
 *
 *   node review/tools/test-review.js              (from the repo root)
 *   node review/tools/test-review.js --selftest
 *
 * Plain node, no packages. It runs the REAL review-core.js and the REAL inline
 * script of review/index.html inside a small fake page (the same fake DOM the AR
 * tests use, preview/tools/fake-dom.js): a tiny HTML reader builds the elements
 * out of the real index.html, a fake browser delivers pointer events the way a
 * browser does, a fake clock and fake timers keep every time exact, a fake
 * sendBeacon and a fake fetch write down what would have left the phone.
 * Nothing here touches a network.
 *
 * What it proves:
 *   A. the contract: the event names, meta keys, screens, page parts and element
 *      names are Orbit's (read from libraries/orbit/src/site-events/
 *      site-events.types.ts when that checkout sits next to this one; otherwise
 *      the copy in this file), nothing else can leave, values are rebuilt and
 *      clamped, and nothing a person could type can pass any rule;
 *   B. which element and which page part a tap is filed under, and where it fell;
 *   C. what counts as a tap and as a hover;
 *   D. the visit: time on each screen (only while the page is visible), the
 *      cumulative review_end, its caps, a reload in the same tab, a new tab;
 *   E. the message: how it is built, held to the Collector's limits, and how a
 *      2xx, a 4xx, a 5xx, no connection and no answer are told apart;
 *   F. the whole page: TEST MODE sends nothing, an unusable address is said out
 *      loud, a visit's events in order and in the right shapes, the message goes
 *      to /feedback and never to /collect, nothing typed (and no user agent, no
 *      referrer, no language, no time zone, no address) is in any event, a robot
 *      is shown "sent" and nothing goes, a failure leaves the page usable;
 *   G. the real Collector (when ~/CODE/steak-out-ar-collector sits next to this
 *      repo): everything the page sent is fed to the real Worker and read back
 *      from its exports, in the shapes Orbit reads; otherwise the Collector's
 *      rules as copied in this file;
 *   H. the files: nothing loaded from anywhere but this site except the one
 *      non-blocking font, the four screens' look and words are the original's
 *      (only the settings and the tracking changed), the shipping page has
 *      its settings empty.
 *
 * NOT proven here: a real phone, real Safari, real Cloudflare. The page was also
 * opened in a real browser against the real Worker on this machine (see the
 * notes of the change), which this file cannot do for you.
 *
 * --selftest re-breaks the real source text (one mutation at a time, in memory
 * only; nothing on disk changes) and fails unless the named check goes red. It
 * also fails if any check is never made red by some mutation.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Target, El, parseHtml, selectAll, hooks } = require('../../preview/tools/fake-dom.js');

const reviewRoot = path.resolve(__dirname, '..');
const FILES = { core: 'review-core.js', page: 'index.html' };
const ORBIT_CONTRACT = process.env.ORBIT_SITE_EVENTS_TS ||
  path.resolve(__dirname, '../../../orbit/libraries/orbit/src/site-events/site-events.types.ts');
const COLLECTOR_ROOT = process.env.COLLECTOR_ROOT ||
  path.resolve(__dirname, '../../../steak-out-ar-collector');
// Where the page came from. Read only, never written.
const ORIGINAL_PAGE = process.env.ORIGINAL_REVIEW_PAGE ||
  path.join(process.env.HOME || '', 'Desktop/STEAK OUT/6 WEB & SEO/SO REVIEW PAGE/index.html');

/* THE POLISH OF 2026-10-08, the only places the page is allowed to differ from the owner's original.
   (1) A fenced block at the end of the page's <style>, which tools/test-review.js holds to sizes only (H8).
   (2) The footer in two lines, which are these two edits of the original's markup (as it reads after
       look() below has normalised it: attributes the tracking added are gone, white space is one space).
   Everything else is still compared word for word (H7, H7b). */
const POLISH_BLOCK = /\/\* ===== POLISH [0-9-]+ BEGIN =====[\s\S]*?===== POLISH END ===== \*\//;
const POLISH_EDITS = [
  ['<footer> Steak Out · 641 Woodbury Glassboro Rd, Sewell, NJ · <a id="footPhone"',
    '<footer> <div>Steak Out · 641 Woodbury Glassboro Rd, Sewell, NJ</div> <div><a id="footPhone"'],
  ['</span> </footer>', '</span></div> </footer>']
];
const withPolish = (originalLook) => POLISH_EDITS.reduce((text, [from, to]) => {
  if (text.split(from).length !== 2) throw new Error(`the approved polish edit "${from.slice(0, 40)}…" does not apply once to the original`);
  return text.replace(from, () => to);
}, originalLook);

/* --------------------------------------------------------------- sources */

function loadText(mutations = []) {
  const text = {};
  for (const [key, file] of Object.entries(FILES)) text[key] = fs.readFileSync(path.join(reviewRoot, file), 'utf8');
  for (const m of mutations) {
    // `also` is a second edit made by the same mutation, in the other file: a safety that lives in
    // two places has to be taken out of both places before anything can go wrong.
    for (const edit of [m, ...(m.also || [])]) {
      const files = edit.file === '*' ? Object.keys(text) : [edit.file];
      const hits = files.reduce((n, f) => n + text[f].split(edit.from).length - 1, 0);
      if (hits !== 1) throw new Error(`mutation "${m.name}": expected 1 match of its text in ${edit.file}, found ${hits}`);
      for (const f of files) {
        if (text[f].includes(edit.from)) text[f] = text[f].replace(edit.from, () => edit.to);
      }
    }
  }
  return text;
}

function loadCore(text) {
  const module = { exports: {} };
  // URL is the one browser global the core uses; a bare vm context does not have it.
  vm.runInNewContext(text.core, { module, URL }, { filename: 'review-core.js' });
  return module.exports;
}

/** The inline script of the page: the one <script> with no src. */
function inlineScript(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no inline script in index.html');
  return m[1];
}

/* The contract, as Orbit wrote it. */
function readContract() {
  let ts;
  try {
    ts = fs.readFileSync(ORBIT_CONTRACT, 'utf8');
  } catch (error) {
    return null;
  }
  const words = (name) => {
    const at = ts.indexOf(`export const ${name} = [`);
    if (at < 0) return null;
    return [...ts.slice(at, ts.indexOf('] as const;', at)).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  };
  // "(meta: w, h, vn = opens on this phone 1..99, typed 0|1, r = final face or 0)" -> w, h, vn, typed, r
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
    return out.split(',').map((piece) => {
      const head = piece.split('=')[0].trim();
      const m = /^([a-z_]+)(?: 0\|1)?$/.exec(head);
      return m ? m[1] : null;
    }).filter(Boolean);
  };
  const events = {};
  const start = ts.indexOf('export const ORBIT_REVIEW_EVENTS = [');
  if (start < 0) return null;
  for (const line of ts.slice(start, ts.indexOf('] as const;', start)).split('\n')) {
    const m = /^\s*'([a-z_]+)',?\s*(?:\/\/(.*))?$/.exec(line);
    if (m) events[m[1]] = metaKeys(m[2] || '');
  }
  const labelAt = ts.indexOf('export const ORBIT_REVIEW_ELEMENT_LABELS');
  const labelBlock = ts.slice(labelAt, ts.indexOf('};', labelAt));
  return {
    events,
    screens: words('ORBIT_REVIEW_SCREENS'),
    sections: words('ORBIT_REVIEW_SECTIONS'),
    pages: words('ORBIT_SITE_PAGES'),
    // 'other' (Orbit's SITE_OTHER_KEY) labels the one row a long list is folded into; it is not an element the page tags.
    labels: [...labelBlock.matchAll(/^\s*([a-z_0-9]+): '/gm)].map((m) => m[1]).filter((key) => key !== 'other')
  };
}

// The same lists by hand, for when the Orbit checkout is not next door. The
// test says which one it used.
const CONTRACT_COPY = {
  events: {
    review_open: ['w', 'h', 'dpr', 'os', 'hover', 'vn', 'hr', 'wd'],
    tap: ['el', 'sec', 'x', 'y', 'py', 't'],
    hover: ['el', 'ms'],
    screen_shown: ['scr'],
    rating_tap: ['r', 'prev'],
    answer_changed: ['from', 'scr'],
    google_tap: ['r', 'btn'],
    phone_tap: ['scr'],
    message_started: ['r'],
    message_sent: ['r', 'len', 'nm', 'ct'],
    message_failed: ['r', 'err'],
    review_end: ['s', 'scr', 'ms_rate', 'ms_happy', 'ms_owner', 'ms_sent', 'sd', 'taps', 'hov', 'r', 'tried', 'typed', 'sent', 'g', 'ph']
  },
  screens: ['rate', 'happy', 'owner', 'sent'],
  sections: ['header', 'rate', 'happy', 'owner', 'sent', 'footer'],
  pages: ['ar', 'review'],
  labels: ['face_1', 'face_2', 'face_3', 'face_4', 'face_5', 'google_main', 'google_footer', 'phone', 'back', 'msg', 'name', 'contact', 'send', 'badge', 'page']
};
const contractFile = readContract();
const CONTRACT = contractFile || CONTRACT_COPY;

/* The Collector's own rules (steak-out-ar-collector/src/index.js), copied, so
   every request the page makes is held to them even without the real Worker. */
function collectorAcceptsEvent(raw) {
  if (Buffer.byteLength(raw) > 2048) return 'body over 2048 bytes';
  let body;
  try { body = JSON.parse(raw); } catch (error) { return 'not JSON'; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'not an object';
  if (typeof body.name !== 'string' || !/^[a-z_]{1,40}$/.test(body.name)) return 'name';
  if (typeof body.source !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(body.source)) return 'source';
  if (typeof body.session !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.session)) return 'session';
  if (!Number.isSafeInteger(body.at) || body.at < 0) return 'at';
  if (body.page !== undefined && !['ar', 'review'].includes(body.page)) return 'page';
  const meta = body.meta === undefined ? {} : body.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return 'meta not an object';
  const unsafe = (v, d = 0) => d <= 20 && typeof v === 'object' && v !== null &&
    Object.entries(v).some(([k, inner]) => ['__proto__', 'constructor', 'prototype'].includes(k) || unsafe(inner, d + 1));
  if (unsafe(meta)) return 'meta has an unsafe key';
  if (Buffer.byteLength(JSON.stringify(meta)) > 1536) return 'meta over 1536 bytes';
  return null;
}

function collectorAcceptsFeedback(raw) {
  if (Buffer.byteLength(raw) > 4096) return 'body over 4096 bytes';
  let body;
  try { body = JSON.parse(raw); } catch (error) { return 'not JSON'; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'not an object';
  if (body.website !== undefined && body.website !== null && body.website !== '') return null; // quietly dropped
  if (typeof body.session !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.session)) return 'session';
  if (typeof body.source !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(body.source)) return 'source';
  if (body.at !== undefined && (!Number.isSafeInteger(body.at) || body.at < 0)) return 'at';
  if (body.page !== undefined && body.page !== 'review') return 'page';
  if (body.message_id !== undefined && body.message_id !== null && (typeof body.message_id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.message_id))) return 'message_id';
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) return 'rating';
  const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '').trim() : null);
  const message = clean(body.message);
  if (message === null || message.length < 1 || message.length > 2000) return 'message';
  const name = body.name === undefined || body.name === null ? '' : clean(body.name);
  if (name === null || name.length > 80) return 'name text';
  const contact = body.contact === undefined || body.contact === null ? '' : clean(body.contact);
  if (contact === null || contact.length > 120) return 'contact';
  return null;
}

/* ------------------------------------------------------------- fake page */

const BASE_EPOCH = 1791470000000;

/**
 * The real index.html, the real scripts, a fake browser.
 * opts: collector, google, url, hover, platform, touch, storage, local,
 * startAt, visible, hour, weekday, referrer, localStorageThrows, sessionStorageThrows.
 */
function openPage(text, opts = {}) {
  const o = {
    collector: 'https://collector.example.workers.dev',
    google: 'https://g.page/r/TEST-ONLY/review',
    url: 'https://lunch.mysteakout.com/review/?c=receipt',
    hover: true,
    platform: 'iPhone',
    uaPlatform: undefined,
    touch: 5,
    storage: new Map(),
    local: new Map(),
    startAt: 3000,
    visible: true,
    hour: 14,
    weekday: 4,
    referrer: 'https://evil.example/where-they-came-from?secret=1',
    beaconWorks: true,
    ...opts
  };
  const u = new URL(o.url);
  let clock = o.startAt;
  const timers = [];
  const beacons = [];
  const fetches = [];
  const logs = [];
  const plan = [];
  let sessionCounter = 0;
  let timerSeq = 0;

  const winTarget = new Target();
  const document = new Target();
  document.readyState = 'complete';
  document.visibilityState = o.visible ? 'visible' : 'hidden';
  document.referrer = o.referrer;
  const elements = parseHtml(text.page, document);
  document.documentElement.scrollHeight = 900;
  document.body.scrollHeight = 900;
  document.querySelectorAll = (sel) => selectAll(elements, sel);
  document.querySelector = (sel) => selectAll(elements, sel)[0] || null;
  document.getElementById = (id) => elements.find((e) => e.getAttribute('id') === id) || null;
  document.createElement = (tag) => new El(tag, {}, null);

  // The form fields: values, a reset, and a disabled flag, which the page uses.
  // (The fake element has attributes only; a real one also has .id.)
  for (const el of elements) {
    Object.defineProperty(el, 'id', { get: () => el.getAttribute('id') || '' });
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = '';
    if (el.tagName === 'FORM') {
      el.reset = () => elements.forEach((f) => { if ((f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') && isInside(f, el)) f.value = ''; });
    }
  }
  function isInside(node, ancestor) {
    for (let n = node; n; n = n.parentElement) if (n === ancestor) return true;
    return false;
  }

  // Each case sets the settings on the copy that is run, never on the file,
  // whatever the shipping page has in them.
  let script = inlineScript(text.page);
  const setting = (name, value) => {
    const needle = new RegExp(`${name}: "[^"]*"`, 'g');
    if ((script.match(needle) || []).length !== 1) throw new Error(`the setting ${name} is not in the page exactly once`);
    script = script.replace(needle, () => `${name}: ${JSON.stringify(value)}`);
  };
  setting('COLLECTOR_URL', o.collector);
  setting('GOOGLE_REVIEW_URL', o.google);

  const fakeLocal = {
    getItem: (k) => { if (o.localStorageThrows) throw new Error('private mode'); return o.local.has(k) ? o.local.get(k) : null; },
    setItem: (k, v) => { if (o.localStorageThrows) throw new Error('private mode'); o.local.set(k, String(v)); }
  };
  const fakeSession = {
    getItem: (k) => { if (o.sessionStorageThrows) throw new Error('private mode'); return o.storage.has(k) ? o.storage.get(k) : null; },
    setItem: (k, v) => { if (o.sessionStorageThrows) throw new Error('private mode'); o.storage.set(k, String(v)); }
  };

  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(BASE_EPOCH + clock); }
    static now() { return BASE_EPOCH + clock; }
    getHours() { return o.hour; }
    getDay() { return o.weekday; }
  }

  const sandbox = {
    document,
    URL,
    URLSearchParams,
    AbortController,
    Date: FakeDate,
    console: { log: (...a) => logs.push(a), warn() {}, error() {} },
    Promise,
    innerWidth: 390,
    innerHeight: 750,
    scrollY: 0,
    pageYOffset: 0,
    devicePixelRatio: 3,
    screen: { width: 390, height: 844 },
    location: { search: u.search, href: u.href, origin: u.origin, pathname: u.pathname },
    navigator: {
      platform: o.platform,
      userAgent: 'Mozilla/5.0 SECRET-USER-AGENT-STRING',
      language: 'xx-SECRET-LANGUAGE',
      languages: ['xx-SECRET-LANGUAGE'],
      maxTouchPoints: o.touch,
      userAgentData: o.uaPlatform ? { platform: o.uaPlatform } : undefined,
      sendBeacon: o.beaconWorks ? (url, body) => { beacons.push({ url, raw: body, body: JSON.parse(body) }); return true; } : () => false
    },
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Zone/SECRET-TIMEZONE' }) }) },
    performance: { now: () => clock },
    sessionStorage: fakeSession,
    localStorage: fakeLocal,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sessionCounter + (o.uuidFrom || 0)).padStart(12, '0')}` },
    matchMedia: (query) => ({ matches: query === '(hover: hover)' ? Boolean(o.hover) : false }),
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    requestAnimationFrame: (fn) => sandbox.setTimeout(() => fn(clock), 0),
    fetch: async (url, init = {}) => {
      fetches.push({ url, init, raw: init.body, body: init.body ? safeJson(init.body) : null });
      const next = plan.length ? plan.shift() : { status: 201 };
      if (next.reject) throw new Error('offline');
      if (next.hang) {
        return new Promise((resolve, reject) => {
          if (init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return { ok: next.status >= 200 && next.status < 300, status: next.status };
    },
    addEventListener: (...a) => winTarget.addEventListener(...a),
    removeEventListener: (...a) => winTarget.removeEventListener(...a)
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.scrollTo = () => {};
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
        if (phase === 'target' || (phase === 'capture' && l.capture) || (phase === 'bubble' && !l.capture)) {
          // An async handler that fails is a rejected promise nobody awaits (in a browser, a line in the console).
          // Here it must not take the whole run down with it; the checks say what the page did.
          const out = l.fn(event);
          if (out && typeof out.catch === 'function') out.catch(() => {});
        }
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
  run(text.core, 'review-core.js');
  run(script, 'index.html (inline script)');

  const byId = (id) => elements.find((e) => e.getAttribute('id') === id);
  const world = {
    sandbox, document, elements, beacons, fetches, logs, plan, storage: o.storage, local: o.local, fire,
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
    async settle() { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); },
    // a finger
    tap(el, at = {}) {
      const p = { clientX: 120, clientY: 300, pointerId: 1, pointerType: 'touch', button: 0, ...at };
      fire(el, 'pointerdown', p);
      world.advance(60);
      fire(el, 'pointerup', p);
      fire(el, 'click', { clientX: p.clientX, clientY: p.clientY, detail: 1 });
    },
    // a mouse
    click(el, at = {}) { world.tap(el, { pointerType: 'mouse', pointerId: 2, ...at }); },
    scrollTo(y) { sandbox.scrollY = y; fire(sandbox, 'scroll'); world.advance(0); },
    hide() { document.visibilityState = 'hidden'; fire(document, 'visibilitychange'); },
    show() { document.visibilityState = 'visible'; fire(document, 'visibilitychange'); },
    pagehide() { fire(sandbox, 'pagehide', { persisted: false }); },
    type(id, value) {
      const el = byId(id);
      el.value = value;
      fire(el, 'input', {});
    },
    face(n) { world.tap(world.$(`[data-track="face_${n}"]`)); },
    async submit() { fire(byId('ownerForm'), 'submit', {}); await world.settle(); },
    visible(id) { return byId(id).classList.contains('on'); },
    screenOn() { return ['rate', 'happy', 'owner', 'sent'].find((id) => byId(id).classList.contains('on')); }
  };
  world.advance(0);
  return world;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (error) { return null; }
}

/** A visit to the unhappy screen, ready to submit: face, then the three boxes. */
async function toOwner(w, { face = 2, message = 'The fries were cold.', name = '', contact = '' } = {}) {
  w.advance(1000);
  w.face(face);
  w.type('msg', message);
  if (name) w.byId('name').value = name;
  if (contact) w.byId('contact').value = contact;
}

/* ---------------------------------------------------------------- checks */

const SAMPLE = {
  w: 390, h: 844, dpr: 3, os: 'ios', hover: false, vn: 7, hr: 14, wd: 4, el: 'face_2', sec: 'rate', x: 12.3, y: 45.6, py: 22.2, t: 1234, ms: 1500,
  scr: 'owner', r: 2, prev: 4, from: 5, btn: 'main', len: 65, nm: 1, ct: 0, err: 'http_5xx', s: 90, ms_rate: 1000, ms_happy: 2000, ms_owner: 3000, ms_sent: 4000,
  sd: 75, taps: 5, hov: 2, tried: 3, typed: 1, sent: 1, g: 0, ph: 1
};
const FULL_END = { ...SAMPLE, s: 1e9, ms_rate: 1e12, ms_happy: 1e12, ms_owner: 1e12, ms_sent: 1e12, taps: 1e9, hov: 1e9, tried: 1e9 };

/** What every beacon and dataLayer entry of a visit is searched for. */
const SECRETS = ['SECRET-MESSAGE-WORDS', 'SECRET-NAME', 'secret@example.com', 'SECRET-USER-AGENT-STRING', 'SECRET-LANGUAGE', 'SECRET-TIMEZONE', 'where-they-came-from', 'evil.example'];

const CASES = [
  {
    name: 'A the contract',
    async run(M, t) {
      const { core } = M;
      const names = Object.keys(core.EVENT_KEYS);
      t('A1 the events are exactly Orbit’s ORBIT_REVIEW_EVENTS',
        names.slice().sort(), Object.keys(CONTRACT.events).sort());
      t('A2 each event is allowed exactly Orbit’s meta keys',
        Object.fromEntries(names.map((n) => [n, [...core.EVENT_KEYS[n]].sort()])),
        Object.fromEntries(names.map((n) => [n, [...CONTRACT.events[n]].sort()])));
      t('A2b every event comes out with exactly Orbit’s meta keys and nothing added',
        Object.fromEntries(names.map((n) => [n, Object.keys(core.shapeEvent(n, SAMPLE).meta).sort()])),
        Object.fromEntries(names.map((n) => [n, [...CONTRACT.events[n]].sort()])));
      t('A3 the screens, page parts, and element names are Orbit’s',
        [core.SCREENS.slice().sort(), core.SECTIONS.slice().sort(), [...core.ELEMENTS, 'page'].sort()],
        [CONTRACT.screens.slice().sort(), CONTRACT.sections.slice().sort(), CONTRACT.labels.slice().sort()]);
      t('A4 a name or a key that is not in the list is dropped',
        [core.shapeEvent('cheat', { a: 1 }), core.shapeEvent('__proto__', {}), core.shapeEvent('toString', {}), core.shapeEvent('visit_end', { s: 5 }), core.shapeEvent('scan', {}),
          core.shapeEvent('rating_tap', { r: 5, prev: 0, evil: 'x', ua: 'Mozilla/5.0', message: 'hello' }).meta,
          core.shapeEvent('screen_shown', { scr: 'owner', name: 'Sam', contact: '856', msg: 'hi' }).meta,
          core.shapeEvent('message_sent', { r: 2, len: 5, nm: 1, ct: 1, message: 'SECRET', name: 'SECRET', contact: 'SECRET' }).meta,
          core.shapeEvent('message_started', { r: 2, message: 'SECRET', value: 'S' }).meta,
          core.shapeEvent('phone_tap', { scr: 'sent', href: 'tel:+18564648000' }).meta,
          core.shapeEvent('screen_shown', { scr: 'owner', r: 3, len: 12, s: 5, el: 'send' }).meta,
          core.shapeEvent('message_started', { r: 2, len: 40, nm: 1, typed: 1 }).meta],
        [null, null, null, null, null, { r: 5, prev: 0 }, { scr: 'owner' }, { r: 2, len: 5, nm: 1, ct: 1 }, { r: 2 }, { scr: 'sent' }, { scr: 'owner' }, { r: 2 }]);
      t('A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped',
        [core.shapeEvent('tap', { el: 'face_2', sec: 'rate', x: 12.349, y: -4, py: 140, t: 1500.6 }).meta,
          core.shapeEvent('tap', { el: 'Has Space', sec: 'nowhere', x: '12', y: NaN, py: null }).meta,
          core.shapeEvent('review_open', { w: 390.4, h: 844, dpr: 2.96, os: 'windows', hover: 'yes', vn: 500, hr: 99, wd: -3 }).meta,
          core.shapeEvent('review_open', { vn: 0, hr: -1, wd: 9 }).meta,
          core.shapeEvent('message_failed', { r: 9, err: 'Error: Failed to fetch https://c.example/feedback for jo@example.com' }).meta,
          core.shapeEvent('hover', { el: 'send', ms: 1e12 }).meta,
          core.shapeEvent('rating_tap', { r: 0, prev: 7 }).meta,
          core.shapeEvent('answer_changed', { from: 0, scr: 'rate' }).meta,
          core.shapeEvent('message_sent', { r: 2, len: 99999, nm: 'yes', ct: 2 }).meta,
          core.shapeEvent('google_tap', { r: 5, btn: 'https://evil.example' }).meta],
        [{ el: 'face_2', sec: 'rate', x: 12.3, y: 0, py: 100, t: 1501 }, {},
          { w: 390, h: 844, dpr: 3, vn: 99, hr: 23, wd: 0 }, { vn: 1, hr: 0, wd: 6 }, { r: 5 }, { el: 'send', ms: 86400000 },
          { r: 0, prev: 5 }, { from: 1, scr: 'rate' }, { r: 2, len: 2000 }, { r: 5 }]);
      t('A6 the yes/no keys are 0 or 1, from a real yes or no and nothing else; hover is a true or false',
        [core.shapeEvent('message_sent', { nm: true, ct: false }).meta, core.shapeEvent('message_sent', { nm: 1, ct: 0 }).meta,
          core.shapeEvent('review_end', { typed: '1', sent: 2, g: null, ph: true }).meta,
          core.shapeEvent('review_open', { hover: true }).meta, core.shapeEvent('review_open', { hover: 1 }).meta],
        [{ nm: 1, ct: 0 }, { nm: 1, ct: 0 }, { ph: 1 }, { hover: true }, {}]);
      t('A7 no value can carry free text: every word key takes only its own words, every number key only numbers',
        (() => {
          const free = 'SECRET-MESSAGE-WORDS and some more words, jo@example.com';
          const out = [];
          for (const [name, keys] of Object.entries(core.EVENT_KEYS)) {
            const meta = core.shapeEvent(name, Object.fromEntries(keys.map((k) => [k, free]))).meta;
            if (Object.keys(meta).length) out.push([name, meta]);
          }
          return out;
        })(), []);
      t('A8 the biggest possible review_end fits under the Collector’s limits, and under its own',
        (() => {
          const e = core.shapeEvent('review_end', FULL_END);
          const body = JSON.stringify({ name: 'review_end', source: 'x'.repeat(40), session: 'a'.repeat(64), at: 1790000000000, meta: e.meta, page: 'review' });
          return [JSON.stringify(e.meta).length < core.MAX_META_BYTES, body.length < core.MAX_BODY_BYTES, collectorAcceptsEvent(body)];
        })(), [true, true, null]);
      t('A9 the placement is made acceptable to the Collector; nothing usable means direct',
        ['Receipt', ' Table-4 ', 'a b/c?d', '', undefined, 'x'.repeat(60), 'üïö', '___', null, 5].map((s) => core.cleanSource(s)),
        ['receipt', 'table-4', 'abcd', 'direct', 'direct', 'x'.repeat(40), 'direct', '___', 'direct', 'direct']);
      t('A10 the address: empty means none; https yes; plain http only for this machine; no logins; a pasted /collect or / is forgiven',
        ['', '  ', undefined, null, 'http://collector.example.com', 'https://u:p@collector.example.com', 'ftp://x.example/', 'not a url',
          'https://collector.example.workers.dev', 'https://collector.example.workers.dev/', 'https://collector.example.workers.dev/collect', 'https://collector.example.workers.dev/collect/',
          'https://collector.example.workers.dev/feedback', 'https://collector.example.workers.dev/?x=1#y', ' https://collector.example.workers.dev ',
          'http://localhost:8788', 'http://127.0.0.1:8788/collect', 'http://[::1]:8788', 'https://c.example/sub/collect', 'https://c.example/collectors']
          .map((s) => core.normalizeCollectorBase(s)),
        ['', '', '', '', '', '', '', '',
          'https://collector.example.workers.dev', 'https://collector.example.workers.dev', 'https://collector.example.workers.dev', 'https://collector.example.workers.dev',
          'https://collector.example.workers.dev', 'https://collector.example.workers.dev', 'https://collector.example.workers.dev',
          'http://localhost:8788', 'http://127.0.0.1:8788', 'http://[::1]:8788', 'https://c.example/sub', 'https://c.example/collectors']);
      {
        const calls = [];
        const backups = [];
        const mk = (over = {}) => core.createSender({ base: 'https://c.example', source: 'Table', session: 'abc-123', beacon: (u, b) => { calls.push([u, JSON.parse(b)]); return true; }, fallback: (u, b) => backups.push([u, JSON.parse(b)]), now: () => 1790000000000, ...over });
        const shapedA = mk()('tap', { el: 'face_2', x: 1, y: 2, evil: 1 });
        mk({ base: '' })('screen_shown', { scr: 'rate' });
        mk({ base: undefined })('screen_shown', { scr: 'rate' });
        mk({ base: 'http://evil.example' })('screen_shown', { scr: 'rate' });
        mk({ session: 'has space' })('screen_shown', { scr: 'rate' });
        mk()('not_an_event', {});
        mk()('visit_end', { s: 3 });
        const shapedThrow = mk({ beacon: () => { throw new Error('offline'); } })('screen_shown', { scr: 'rate' });
        mk({ beacon: () => false })('phone_tap', { scr: 'sent' });
        t('A11 one beacon to /collect with name, source, session, at, meta and page "review"; no address, a bad address, a bad session or an unknown event sends nothing; a failing beacon is swallowed; a refused one tries the fallback once',
          [calls, shapedA, shapedThrow.meta, backups],
          [[['https://c.example/collect', { name: 'tap', source: 'table', session: 'abc-123', at: 1790000000000, meta: { el: 'face_2', x: 1, y: 2 }, page: 'review' }]],
            { name: 'tap', meta: { el: 'face_2', x: 1, y: 2 } }, { scr: 'rate' },
            [['https://c.example/collect', { name: 'phone_tap', source: 'table', session: 'abc-123', at: 1790000000000, meta: { scr: 'sent' }, page: 'review' }]]]);
      }
      t('A12 the per-tab caps leave room under the Collector’s 400: every capped kind at its cap, plus the opening, is under 400',
        [Object.values(core.CAPS).reduce((a, b) => a + b, 0) + 1 < 400, core.CAPS.tap, core.CAPS.hover, core.CAPS.review_end],
        [true, 60, 40, 40]);
    }
  },
  {
    name: 'B which element, which part of the page, where',
    async run(M, t) {
      const { core } = M;
      const mk = (attrs, parent) => ({ attrs, parentElement: parent, getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; } });
      const screen = mk({ 'data-section': 'owner' }, mk({}, null));
      const label = mk({ 'data-track': 'msg' }, screen);
      const span = mk({}, label);
      const odd = mk({ 'data-track': 'Not On The List' }, screen);
      const strange = mk({ 'data-section': 'sidebar' }, mk({}, null));
      const strangeKid = mk({ 'data-track': 'send' }, strange);
      const r = (node) => { const x = core.resolveTarget(node); return { el: x.el, sec: x.sec, tagged: x.node === null ? null : x.node.attrs['data-track'] }; };
      t('B1 the nearest data-track is the element, however deep the tap was; one not on the list is "page"',
        [r(span).el, r(label).el, r(odd).el, r(null).el, r(mk({}, null)).el], ['msg', 'msg', 'page', 'page', 'page']);
      t('B2 the nearest data-section is the page part; an unknown one is none, not its neighbour',
        [r(span).sec, r(screen).sec, r(strangeKid).sec], ['owner', 'owner', null]);
      t('B3 the tagged node comes back, for the hover to hold on to', r(span).tagged, 'msg');
      t('B4 percentages are to 0.1, held between 0 and 100, and null with nothing to measure against',
        [core.pct1(1, 3), core.pct1(150, 100), core.pct1(-5, 100), core.pct1(0, 0), core.pct1(5, -1), core.pct1(NaN, 10), core.pct1(195, 390)],
        [33.3, 100, 0, null, null, null, 50]);
      const base = { target: null, viewW: 400, viewH: 800, t: 10 };
      t('B5 x, y are of the screen; py is of the whole page, scrolled or not; no screen no tap',
        [core.tapDetail({ ...base, clientX: 100, clientY: 400, scrollY: 0, pageH: 2000 }),
          core.tapDetail({ ...base, clientX: 100, clientY: 400, scrollY: 800, pageH: 2000 }),
          core.tapDetail({ ...base, clientX: 100, clientY: 400, scrollY: 0, pageH: 300 }),
          core.tapDetail({ ...base, viewW: 0, clientX: 1, clientY: 1 })],
        [{ el: 'page', sec: null, x: 25, y: 50, py: 20, t: 10 }, { el: 'page', sec: null, x: 25, y: 50, py: 60, t: 10 },
          { el: 'page', sec: null, x: 25, y: 50, py: 50, t: 10 }, null]);
    }
  },
  {
    name: 'C what counts as a tap and a hover',
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
      t('C1 a finger that stays put is one tap; its click is the same tap', [finger, clickAfter], [true, false]);
      t('C2 a drag is not a tap, and the click that ends one is not either', [drag, clickAfterDrag], [false, false]);
      t('C3 a key press on a button (a click with no pointer before it) is a tap', keyboard, true);
      t('C4 not the right mouse button, not a cancelled touch, not a pointer-up with no press', [right, cancelled, strayUp], [false, false, false]);
      const rest = core.createHoverRest();
      const a = rest.move('A', 'face_1', 0);
      const b = rest.move('A', 'face_1', 300);
      const c = rest.move('B', 'face_2', 450);
      const d = rest.move(null, null, 450 + 399);
      const e = rest.move('B', 'face_2', 2000);
      const f2 = rest.flush(2000 + 1234);
      const g = rest.flush(5000);
      t('C5 a rest of 0.4 s on a tagged thing is one hover; shorter is none; moving inside it does not restart it; flush ends a rest in progress once',
        [a, b, c, d, f2, g, e], [null, null, { el: 'face_1', ms: 450 }, null, { el: 'face_2', ms: 1234 }, null, null]);
    }
  },
  {
    name: 'D the visit: time, scroll, caps, a reload',
    async run(M, t) {
      const { core } = M;
      {
        const v = core.createVisit({ startT: 0 });
        v.screen('owner', 2000);
        v.visible(false, 5000); // 3 s on the owner screen, then the phone goes in a pocket
        v.visible(true, 65000); // a minute later
        v.screen('sent', 66000); // 1 s more on owner
        const snap = v.snapshot(70000);
        t('D1 time is counted per screen and only while the page is visible; s is those seconds added up',
          [snap.ms_rate, snap.ms_owner, snap.ms_sent, snap.ms_happy, snap.s, snap.scr],
          [2000, 4000, 4000, 0, 10, 'sent']);
      }
      {
        const v = core.createVisit({ startT: 0, visible: false });
        v.screen('happy', 1000);
        v.visible(true, 4000);
        t('D2 a page opened in the background counts nothing until it is seen', [v.snapshot(6000).ms_happy, v.snapshot(6000).ms_rate, v.snapshot(6000).s], [2000, 0, 2]);
      }
      {
        const v = core.createVisit({ startT: 0 });
        v.scroll(40); v.scroll(180); v.scroll(25); v.scroll(NaN);
        const prev = [v.rated(2), v.rated(5), v.rated(5)];
        v.mark('typed'); v.mark('g'); v.mark('nonsense');
        for (let i = 0; i < 99; i++) v.tap();
        const snap = v.snapshot(0);
        for (let i = 0; i < 120; i++) v.rated(1 + (i % 5));
        t('D3 scroll keeps the deepest (held at 100); rated says the face before; tried counts every tap (to 99); yes/no marks; taps count past the cap',
          [snap.sd, prev, snap.r, snap.tried, snap.typed, snap.g, snap.ph, snap.sent, snap.taps, v.snapshot(0).tried], [100, [0, 2, 5], 5, 3, 1, 1, 0, 0, 99, 99]);
        const w = core.createVisit({ startT: 0 });
        w.scroll(60); w.scroll(30);
        t('D3b scroll depth is the deepest, not the last', [w.snapshot(0).sd], [60]);
      }
      {
        const v = core.createVisit({ startT: 0 });
        const sendable = (name, n) => Array.from({ length: n }, () => v.allow(name)).filter(Boolean).length;
        const taps = Array.from({ length: 70 }, () => v.tap()).filter(Boolean).length;
        const hovers = Array.from({ length: 50 }, () => v.hover()).filter(Boolean).length;
        t('D4 70 taps send 60 and 50 hovers send 40; other kinds stop at their own cap; a kind with no cap is always allowed; the totals keep counting',
          [taps, hovers, sendable('rating_tap', 40), sendable('message_sent', 9), sendable('review_open', 3), v.snapshot(0).taps, v.snapshot(0).hov],
          [60, 40, 30, 5, 3, 70, 50]);
      }
      {
        const v = core.createVisit({ startT: 0 });
        v.screen('owner', 1000);
        const first = v.flushEnd(4000);
        const again = v.flushEnd(4000);
        v.mark('sent');
        const next = v.flushEnd(4000);
        const sent = [first, again, next].filter(Boolean).length;
        let more = 0;
        for (let i = 0; i < 60; i++) { v.tap(); if (v.flushEnd(4000 + i * 1000)) more++; }
        t('D5 review_end is re-sent only when something changed, and at most 40 times a tab',
          [first && first.scr, again, next && next.sent, sent, sent + more], ['owner', null, 1, 2, 40]);
      }
      {
        const a = core.createVisit({ startT: 0 });
        a.screen('owner', 1000);
        a.rated(2); a.mark('typed'); a.scroll(60); a.tap(); a.hover(); a.flushEnd(3000);
        const stored = JSON.stringify(a.export(5000));
        const b = core.createVisit({ base: stored, startT: 0 });
        b.visible(false, 2000);
        const snap = b.snapshot(2000);
        t('D6 a reload in the same tab carries the visit on: time per screen, scroll, taps, the face, the yes/no marks and how many were sent',
          [snap.ms_rate, snap.ms_owner, snap.r, snap.tried, snap.typed, snap.taps, snap.hov, snap.sd, snap.s], [3000, 4000, 2, 1, 1, 1, 1, 60, 7]);
        t('D6b …and the caps carry on too, so a reload cannot send 60 taps again',
          (() => { const c = core.createVisit({ base: JSON.stringify({ ...JSON.parse(stored), sentCounts: { tap: 60, review_end: 40, rating_tap: 30 } }) }); return [c.tap(), c.allow('rating_tap'), c.flushEnd(1)]; })(),
          [false, false, null]);
        t('D7 a stored visit that is rubbish starts from zero',
          ['{not json', null, '[1]', '{"ms":{"rate":"lots"},"taps":"x","r":9,"tried":-4,"typed":"yes","sentCounts":{"tap":"many"}}', 12345]
            .map((x) => { const s = core.createVisit({ base: x, startT: 0 }).snapshot(0); return [s.s, s.taps, s.r, s.tried, s.typed]; }),
          [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 5, 0, 0], [0, 0, 0, 0, 0]]);
        t('D8 what a visit stores is counters only: no words, no ids',
          Object.keys(JSON.parse(stored)).sort(), ['g', 'hov', 'ms', 'ph', 'r', 'sd', 'sent', 'sentCounts', 'taps', 'tried', 'typed']);
      }
    }
  },
  {
    name: 'E the message: built, limited, sent',
    async run(M, t) {
      const { core } = M;
      const ok = (over = {}) => core.buildFeedback({ session: 'abc-123', source: 'Receipt', rating: 2, message: '  Cold fries.\nTable 4  ', name: ' Sam ', contact: ' 8565551234 ', at: 1790000000000, ...over });
      const built = ok();
      t('E1 the body is exactly what the Collector reads: session, source, page review, rating, message, name, contact, website empty, at; trimmed',
        [built.ok, JSON.parse(built.body), Object.keys(JSON.parse(built.body)), built.len, built.nm, built.ct, collectorAcceptsFeedback(built.body)],
        [true, { session: 'abc-123', source: 'receipt', page: 'review', rating: 2, message: 'Cold fries.\nTable 4', name: 'Sam', contact: '8565551234', website: '', at: 1790000000000 },
          ['session', 'source', 'page', 'rating', 'message', 'name', 'contact', 'website', 'at'], 19, 1, 1, null]);
      t('E2 a name and a contact left out are empty, and counted as no',
        (() => { const b = ok({ name: undefined, contact: '   ' }); return [JSON.parse(b.body).name, JSON.parse(b.body).contact, b.nm, b.ct]; })(), ['', '', 0, 0]);
      t('E3 not built for a bad visit, face or message',
        [ok({ session: 'has space' }), ok({ rating: 0 }), ok({ rating: 6 }), ok({ rating: 2.5 }), ok({ message: '   ' }), ok({ message: undefined })].map((b) => b.ok === false && b.reason),
        ['session', 'rating', 'rating', 'rating', 'empty', 'empty']);
      t('E4 the Collector’s limits: 2,000 characters of message yes, 2,001 no; a name is cut to 80 and a contact to 120; a body past 4,096 bytes is too long',
        [ok({ message: 'x'.repeat(2000) }).ok, ok({ message: 'x'.repeat(2001) }).reason,
          JSON.parse(ok({ name: 'n'.repeat(200), contact: 'c'.repeat(200) }).body).name.length, JSON.parse(ok({ name: 'n'.repeat(200), contact: 'c'.repeat(200) }).body).contact.length,
          ok({ message: 'é'.repeat(2000) }).reason, ok({ message: 'é'.repeat(1500) }).ok, ok({ message: '😡'.repeat(1000) }).reason],
        [true, 'too_long', 80, 120, 'too_long', true, 'too_long']);
      t('E5 whatever the box was cut to, the body passes the Collector’s rules',
        [ok({ message: 'é'.repeat(1500), name: 'n'.repeat(200), contact: 'c'.repeat(200) }), ok({ message: 'x'.repeat(2000) })].map((b) => collectorAcceptsFeedback(b.body)), [null, null]);
      // ---- a message sent again is one message: the id it carries
      const withId = ok({ messageId: '0b7d5d3e-6d0e-4b0e-9c61-3f5e7a2b9a11' });
      t('E9 a message_id goes last in the body, passes the Collector’s rules, and is left out when there is none; one the Collector would refuse is never sent',
        [Object.keys(JSON.parse(withId.body)).slice(-2), JSON.parse(withId.body).message_id, collectorAcceptsFeedback(withId.body),
          'message_id' in JSON.parse(ok({ messageId: undefined }).body), 'message_id' in JSON.parse(ok({ messageId: null }).body),
          ['has space', 'a'.repeat(65), '', 12345, { a: 1 }, 'a/b', 'ü'].map((id) => { const b = ok({ messageId: id }); return b.ok === false && b.reason; })],
        [['at', 'message_id'], '0b7d5d3e-6d0e-4b0e-9c61-3f5e7a2b9a11', null, false, false, ['message_id', 'message_id', 'message_id', 'message_id', 'message_id', 'message_id', 'message_id']]);
      const idsOf = (store, makeId, over = {}) => core.createMessageIds({
        read: (k) => (store.has(k) ? store.get(k) : null), write: (k, v) => { store.set(k, String(v)); }, makeId, ...over
      });
      const counter = () => { let n = 0; return () => `id-${++n}`; };
      const fields = { rating: 2, message: 'SECRET-MESSAGE-WORDS, cold fries', name: 'SECRET-NAME', contact: 'secret@example.com' };
      {
        const store = new Map();
        const ids = idsOf(store, counter());
        const a = ids.idFor(fields);
        const again = ids.idFor({ ...fields });
        const trimmed = ids.idFor({ ...fields, message: '  SECRET-MESSAGE-WORDS, cold fries \n', name: ' SECRET-NAME ', contact: ' secret@example.com ' });
        const reloaded = idsOf(store, () => 'a-new-page-made-this').idFor(fields);
        t('E10 the same message gets the same id every time it is asked for: again, with spaces round it, and after a reload of the tab (a new page, the same sessionStorage)',
          [a, again, trimmed, reloaded], ['id-1', 'id-1', 'id-1', 'id-1']);
        // (the reloaded page is given a different id to make, so it can only answer id-1 by finding the old one in the tab)
        t('E10b what is kept in the tab is the id and a short code, never a word the customer typed',
          [[...store.keys()], /^id-1_[0-9a-z]{1,16}$/.test(store.get(core.MESSAGE_ID_KEY)), JSON.stringify([...store]).match(/SECRET|cold|fries|secret@/)],
          [['steakout.review.msgid'], true, null]);
        const different = [
          { ...fields, message: 'SECRET-MESSAGE-WORDS, cold fries!' }, { ...fields, rating: 1 }, { ...fields, name: '' }, { ...fields, contact: '' }
        ].map((f) => idsOf(new Map(store), () => 'made-fresh').idFor(f)); // each against the tab as it was after the first message
        t('E11 different words, face, name or contact are a different message: a new id (a second thought is not a repeat)', different, ['made-fresh', 'made-fresh', 'made-fresh', 'made-fresh']);
        const ids2 = idsOf(new Map(), counter());
        const first = ids2.idFor(fields);
        const second = ids2.idFor({ ...fields, message: 'changed' });
        t('E11b …and an edit then a return to the first words is not the first message any more (only the message in hand keeps its id)',
          [first, second, ids2.idFor(fields)], ['id-1', 'id-2', 'id-3']);
        ids.stored();
        t('E12 once a message is stored the next one starts afresh (a new id, even with the same words); the tab keeps nothing of the stored one',
          [ids.idFor(fields), store.get(core.MESSAGE_ID_KEY).startsWith('id-2_'), (() => { ids.stored(); return store.get(core.MESSAGE_ID_KEY); })()], ['id-2', true, '']);
      }
      {
        // a phone whose storage throws: the id still holds within the page
        const throwing = { read() { throw new Error('private mode'); }, write() { throw new Error('private mode'); } };
        const ids = core.createMessageIds({ ...throwing, makeId: counter() });
        const a = ids.idFor(fields);
        const again = ids.idFor(fields);
        ids.stored();
        t('E13 with storage that throws the id still holds from one try to the next within the page, and a stored message ends it; nothing throws',
          [a, again, ids.idFor(fields)], ['id-1', 'id-1', 'id-2']);
        // no storage functions at all, an id maker that fails or makes something the Collector would refuse
        const bare = core.createMessageIds({ makeId: () => 'has a space' });
        const made = bare.idFor(fields);
        const broken = core.createMessageIds({ makeId: () => { throw new Error('no randomness'); } }).idFor(fields);
        t('E13b an id maker that fails or makes an id the Collector would refuse is replaced by one of the core’s own that it takes',
          [made, broken].map((id) => /^[A-Za-z0-9-]{1,64}$/.test(id)), [true, true]);
        // junk where the id should be: not believed
        const fp = core.messageFingerprint(fields);
        const junk = ['', 'no-underscore', `kept_${fp}_extra`, `has space_${fp}`, `_${fp}`, `kept_`, `${'x'.repeat(65)}_${fp}`, `kept-id_${fp.toUpperCase()}x`, 42];
        t('E13c junk in the stored value is not believed (even with the right code in it): a new id each time',
          junk.map((value) => idsOf(new Map([[core.MESSAGE_ID_KEY, value]]), () => 'made-fresh').idFor(fields)), junk.map(() => 'made-fresh'));
        t('E13d …but a good one is', idsOf(new Map([[core.MESSAGE_ID_KEY, `kept-id-7_${core.messageFingerprint(fields)}`]]), counter()).idFor(fields), 'kept-id-7');
      }
      const send = async (planned, over = {}) => {
        const seen = [];
        const timers = [];
        let abortReason = false;
        const fakeFetch = async (url, init) => {
          seen.push([url, init]);
          if (planned.reject) throw new Error('offline');
          if (planned.hang) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { abortReason = true; reject(new Error('aborted')); }));
          return { ok: planned.status >= 200 && planned.status < 300, status: planned.status };
        };
        const promise = core.postFeedback({
          base: 'https://c.example', body: '{"x":1}', fetch: fakeFetch, AbortController,
          setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: () => {}, ...over
        });
        if (planned.hang) { await new Promise((r) => setImmediate(r)); timers[0][0](); }
        // a real-time guard: a broken send that never answers must fail this check, not hang the run
        const out = await Promise.race([promise, new Promise((r) => setTimeout(() => r('HUNG'), 1500))]);
        return { out, seen, timers, abortReason };
      };
      const created = await send({ status: 201 });
      t('E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache',
        [created.out, created.seen[0][0], created.seen[0][1].method, created.seen[0][1].headers, created.seen[0][1].body, created.seen[0][1].credentials, created.seen[0][1].cache, created.timers[0][1]],
        [{ ok: true }, 'https://c.example/feedback', 'POST', { 'Content-Type': 'text/plain;charset=utf-8' }, '{"x":1}', 'omit', 'no-store', 15000]);
      t('E7 told apart: 204 ok, 400 / 403 / 413 / 429 are 4xx, 500 / 503 are 5xx, no connection is network, no answer is timeout (and the request is cancelled)',
        [(await send({ status: 204 })).out, (await send({ status: 400 })).out, (await send({ status: 403 })).out, (await send({ status: 413 })).out, (await send({ status: 429 })).out,
          (await send({ status: 500 })).out, (await send({ status: 503 })).out, (await send({ reject: true })).out, (await send({ hang: true })).out, (await send({ hang: true })).abortReason],
        [{ ok: true }, { ok: false, err: 'http_4xx' }, { ok: false, err: 'http_4xx' }, { ok: false, err: 'http_4xx' }, { ok: false, err: 'http_4xx' },
          { ok: false, err: 'http_5xx' }, { ok: false, err: 'http_5xx' }, { ok: false, err: 'network' }, { ok: false, err: 'timeout' }, true]);
      t('E8 a 3xx is not delivered, and nothing is sent without a usable address or a fetch',
        [(await send({ status: 302 })).out, (await core.postFeedback({ base: '', body: '{}', fetch: async () => ({ ok: true, status: 201 }), setTimeout() {}, clearTimeout() {} })),
          (await core.postFeedback({ base: 'http://evil.example', body: '{}', fetch: async () => ({ ok: true, status: 201 }), setTimeout() {}, clearTimeout() {} })),
          (await core.postFeedback({ base: 'https://c.example', body: '{}', setTimeout() {}, clearTimeout() {} }))],
        [{ ok: false, err: 'http_4xx' }, { ok: false, err: 'network' }, { ok: false, err: 'network' }, { ok: false, err: 'network' }]);
    }
  },
  {
    name: 'F the whole page',
    async run(M, t) {
      const text = M.text;
      // ---- TEST MODE: no Collector set
      {
        const w = openPage(text, { collector: '' });
        w.face(2);
        w.type('msg', 'SECRET-MESSAGE-WORDS');
        await w.submit();
        w.hide();
        t('F1 with no Collector address: the strip says so, nothing leaves the phone, the events are only in dataLayer, and a message pretends to send (the sent screen shows)',
          [w.byId('testStrip').hidden, w.byId('testStrip').textContent, w.beacons.length, w.fetches.length, w.dataLayer.map((e) => e.event), w.screenOn(), w.logs.filter((l) => l[0] === '[TEST MODE] event:').length, w.logs.filter((l) => l[0] === '[TEST MODE] would send to the Collector:').length],
          [false, 'TEST MODE · Collector not connected, messages and trackers are not sent', 0, 0,
            ['review_open', 'screen_shown', 'tap', 'rating_tap', 'screen_shown', 'message_started', 'message_sent', 'screen_shown', 'review_end'], 'sent', 9, 1]);
      }
      {
        const w = openPage(text, { collector: '', google: '' });
        w.byId('googleBtn').addEventListener; // present
        t('F1b with neither set, the strip names both',
          [w.byId('testStrip').hidden, w.byId('testStrip').textContent],
          [false, 'TEST MODE · Google link not set · Collector not connected, messages and trackers are not sent']);
      }
      // ---- an address that cannot be used
      for (const bad of ['http://collector.example.workers.dev', 'not a url', 'https://u:p@collector.example.com']) {
        const w = openPage(text, { collector: bad });
        w.face(2);
        w.type('msg', 'hello');
        await w.submit();
        t(`F2 an address that cannot be used (${bad.slice(0, 22)}…) is said out loud, nothing leaves, and a message is NOT shown as sent`,
          [w.byId('testStrip').textContent, w.beacons.length, w.fetches.length, w.screenOn(), w.byId('err').classList.contains('on'), w.byId('err').innerHTML.includes("That didn't go through")],
          ['TEST MODE · Collector address is not valid, messages and trackers are not sent', 0, 0, 'owner', true, true]);
      }
      // ---- the arrival, once per tab, and what it says
      {
        const w = openPage(text, { hour: 9, weekday: 2 });
        const first = w.beacons[0];
        t('F3 a new tab sends review_open first, with the screen, the phone, how many opens, the local hour and weekday, and nothing else; then the first screen',
          [w.names(), first.url, first.body.meta, first.body.page, first.body.source, first.body.session, collectorAcceptsEvent(first.raw)],
          [['review_open', 'screen_shown'], 'https://collector.example.workers.dev/collect',
            { w: 390, h: 844, dpr: 3, os: 'ios', hover: true, vn: 1, hr: 9, wd: 2 }, 'review', 'receipt', '00000000-0000-4000-8000-000000000001', null]);
        t('F3b the phone remembers how many times it opened the page (a count only), and the next tab says 2',
          [w.local.get('so-review-visits'), openPage(text, { local: w.local }).beacons[0].body.meta.vn, [...w.storage.keys()].sort()],
          ['1', 2, ['steakout.review.session', 'steakout.review.source']]);
        const noLocal = openPage(text, { localStorageThrows: true });
        t('F3c a phone that cannot keep a count still opens the page, and review_open simply has no vn',
          [noLocal.names(), 'vn' in noLocal.beacons[0].body.meta, noLocal.beacons[0].body.meta.os], [['review_open', 'screen_shown'], false, 'ios']);
      }
      // ---- a happy visit
      {
        const w = openPage(text);
        w.advance(2000);
        w.face(5);
        const tapPos = w.sent('tap').slice(-1)[0].meta;
        w.advance(3000);
        w.tap(w.byId('googleBtn'));
        w.hide();
        t('F4 a happy visit: tap, rating_tap (r 5, prev 0), the Google screen, a tap and google_tap (main), then review_end with the face and g',
          [w.names(), w.sent('rating_tap')[0].meta, w.sent('screen_shown').map((e) => e.meta.scr), w.sent('google_tap')[0].meta, w.screenOn(), w.byId('happyBar').textContent],
          [['review_open', 'screen_shown', 'tap', 'rating_tap', 'screen_shown', 'tap', 'google_tap', 'review_end'], { r: 5, prev: 0 }, ['rate', 'happy'], { r: 5, btn: 'main' }, 'happy', 'Glad you loved it']);
        t('F4b the tap says what it was and where: the face, the part of the page, x and y of the screen',
          [tapPos.el, tapPos.sec, tapPos.x, tapPos.y, typeof tapPos.t], ['face_5', 'rate', 30.8, 40, 'number']);
        const end = w.sent('review_end')[0].meta;
        t('F4c review_end says how long on each screen (the 5 s here split 2 and 3), the face, and that Google was tapped',
          [end.ms_rate, end.ms_happy, end.ms_owner, end.s, end.scr, end.r, end.tried, end.g, end.typed, end.sent, end.taps],
          [2060, 3060, 0, 5, 'happy', 5, 1, 1, 0, 0, 2]);
        const w4 = openPage(text);
        w4.face(4);
        t('F4d a 4 is "Glad you enjoyed it" and also goes to the Google screen', [w4.screenOn(), w4.byId('happyBar').textContent], ['happy', 'Glad you enjoyed it']);
      }
      // ---- the unhappy visit, the message, and what it is never mixed with
      {
        const w = openPage(text);
        await toOwner(w, { face: 2, message: 'SECRET-MESSAGE-WORDS\nsecond line', name: 'SECRET-NAME', contact: 'secret@example.com' });
        w.advance(4000);
        await w.submit();
        w.hide();
        const post = w.fetches[0];
        t('F5 a message goes to {base}/feedback and nowhere else, once: the face, the words, the name and contact, the visit, an empty hidden box',
          [w.fetches.length, post.url, post.init.method, post.init.headers, post.body],
          [1, 'https://collector.example.workers.dev/feedback', 'POST', { 'Content-Type': 'text/plain;charset=utf-8' },
            { session: '00000000-0000-4000-8000-000000000001', source: 'receipt', page: 'review', rating: 2, message: 'SECRET-MESSAGE-WORDS\nsecond line', name: 'SECRET-NAME', contact: 'secret@example.com', website: '', at: BASE_EPOCH + 8060, message_id: '00000000-0000-4000-8000-000000000002' }]);
        t('F5b …and the Collector would take it', collectorAcceptsFeedback(post.raw), null);
        t('F5c the events of that visit, in order, in Orbit’s shapes: the face, the unhappy screen, the first key (no words), the send, message_sent with only counts, the sent screen, review_end',
          [w.names(), w.sent('message_started')[0].meta, w.sent('message_sent')[0].meta, w.sent('screen_shown').map((e) => e.meta.scr)],
          [['review_open', 'screen_shown', 'tap', 'rating_tap', 'screen_shown', 'message_started', 'message_sent', 'screen_shown', 'review_end'], { r: 2 }, { r: 2, len: 32, nm: 1, ct: 1 }, ['rate', 'owner', 'sent']]);
        // (this visit never tapped a box with a pointer: the values were set directly)
        const all = JSON.stringify([w.beacons.map((b) => b.raw), w.dataLayer, w.sent('review_end')]);
        t('F6 nothing typed is in any event or in dataLayer; neither is the user agent, the language, the time zone, or where the visit came from',
          SECRETS.filter((s) => all.includes(s)), []);
        t('F6b the page after sending: "We’ll reach out to you", the phone link, a cleared form, and the review_end says sent and typed',
          [w.byId('sentLead').innerHTML.includes("We'll reach out to you."), w.byId('msg').value, w.byId('name').value, w.sent('review_end')[0].meta.sent, w.sent('review_end')[0].meta.typed, w.sent('review_end')[0].meta.s],
          [true, '', '', 1, 1, 5]);
        const noContact = openPage(text);
        await toOwner(noContact, { message: 'No phone number given' });
        await noContact.submit();
        t('F6c without a phone or email the sent screen offers a call back instead; message_sent says no name, no contact',
          [noContact.byId('sentLead').innerHTML.includes('Want a call back?'), noContact.sent('message_sent')[0].meta, noContact.byId('sentBar').textContent],
          [true, { r: 2, len: 21, nm: 0, ct: 0 }, 'We read every one']);
      }
      // ---- a message that does not go through
      {
        for (const [label, planned, code] of [['a 400', { status: 400 }, 'http_4xx'], ['a 429', { status: 429 }, 'http_4xx'], ['a 503', { status: 503 }, 'http_5xx'], ['no connection', { reject: true }, 'network']]) {
          const w = openPage(text);
          await toOwner(w, { face: 1, message: 'SECRET-MESSAGE-WORDS' });
          w.plan.push(planned);
          await w.submit();
          t(`F7 ${label}: the page says it did not go through (with the phone to call), shows no "sent", keeps what was typed, and reports only the short code`,
            [w.screenOn(), w.byId('err').classList.contains('on'), w.byId('err').innerHTML.startsWith("That didn't go through. Check your connection and try again, or call us at"), w.byId('msg').value,
              w.byId('sendBtn').disabled, w.byId('sendBtn').textContent, w.sent('message_failed').map((e) => e.meta), w.sent('message_sent').length],
            ['owner', true, true, 'SECRET-MESSAGE-WORDS', false, 'Leave your feedback!', [{ r: 1, err: code }], 0]);
        }
        const w = openPage(text);
        await toOwner(w, { face: 3, message: 'try again' });
        w.plan.push({ status: 503 });
        await w.submit();
        await w.submit();
        t('F7b after a failure the same message can be sent again, and then it is sent: one failure, one success, the error line goes away',
          [w.fetches.length, w.screenOn(), w.sent('message_failed').length, w.sent('message_sent').length, w.byId('err').classList.contains('on')],
          [2, 'sent', 1, 1, false]);
        // ---- the same message, sent again, is one message to the Collector
        {
          const r = openPage(text);
          await toOwner(r, { face: 2, message: 'SECRET-MESSAGE-WORDS', name: 'SECRET-NAME' });
          r.plan.push({ reject: true });
          await r.submit();
          const keptAfterFailure = r.storage.get('steakout.review.msgid');
          r.advance(7000);
          await r.submit();
          const [one, two] = r.fetches.map((f) => f.body);
          t('F7c a message whose answer never came is sent again with the SAME message_id (and a newer time); the id is kept in the tab until it is stored, then cleared',
            [r.fetches.length, typeof one.message_id, one.message_id === two.message_id, two.at > one.at, one.message === two.message, r.screenOn(), /^[0-9a-f-]{36}_[0-9a-z]+$/.test(keptAfterFailure), r.storage.get('steakout.review.msgid')],
            [2, 'string', true, true, true, 'sent', true, '']);
          t('F7c2 …and nothing the customer typed is in what the tab kept while the message was waiting to be stored (the id and a short code)', [keptAfterFailure.match(/SECRET|cold/), keptAfterFailure.split('_').length], [null, 2]);
          const e = openPage(text);
          await toOwner(e, { face: 2, message: 'first try' });
          e.plan.push({ status: 503 });
          await e.submit();
          e.type('msg', 'first try, with more words');
          await e.submit();
          const [before, after] = e.fetches.map((f) => f.body.message_id);
          t('F7d words changed between the tries are a different message: a new id', [e.fetches.length, typeof before, before !== after], [2, 'string', true]);
          const w1 = openPage(text);
          await toOwner(w1, { face: 2, message: 'weak signal at the table' });
          w1.plan.push({ hang: true });
          fireSubmit(w1);
          await w1.settle();
          w1.advance(15001);
          await w1.settle();
          const idWas = w1.fetches[0].body.message_id;
          // the tab reloads (same sessionStorage); the customer types the same words again
          const w2 = openPage(text, { storage: w1.storage, local: w1.local });
          await toOwner(w2, { face: 2, message: 'weak signal at the table' });
          await w2.submit();
          t('F7e a timeout, a reload of the tab, the same words typed again: the SAME message_id and the same visit, so the Collector can tell it is the message it already has',
            [w1.sent('message_failed').map((x) => x.meta.err), w2.fetches.length, w2.fetches[0].body.message_id === idWas, w2.fetches[0].body.session === w1.fetches[0].body.session, w2.screenOn()],
            [['timeout'], 1, true, true, 'sent']);
          const p = openPage(text, { sessionStorageThrows: true, localStorageThrows: true });
          await toOwner(p, { face: 2, message: 'private mode retry' });
          p.plan.push({ reject: true });
          await p.submit();
          await p.submit();
          t('F7f a phone that refuses storage still sends the retry with the same message_id (kept in the page)',
            [p.fetches.length, typeof p.fetches[0].body.message_id, p.fetches[0].body.message_id === p.fetches[1].body.message_id], [2, 'string', true]);
          const n = openPage(text);
          await toOwner(n, { face: 2, message: 'same words twice, on purpose' });
          await n.submit();
          await toOwner(n, { face: 2, message: 'same words twice, on purpose' });
          await n.submit();
          t('F7g a second message with the same words after the first was stored is a new message: a new id',
            [n.fetches.length, n.fetches[0].body.message_id !== n.fetches[1].body.message_id], [2, true]);
        }
        const slow = openPage(text);
        await toOwner(slow, { face: 2, message: 'nobody answers' });
        slow.plan.push({ hang: true });
        fireSubmit(slow);
        await slow.settle();
        const during = [slow.byId('sendBtn').disabled, slow.byId('sendBtn').textContent];
        slow.advance(14999);
        await slow.settle();
        const before = slow.byId('sendBtn').disabled;
        slow.advance(2);
        await slow.settle();
        t('F8 a Collector that never answers: the button says Sending… and is off, then after 15 s it gives up as a timeout, says it did not go through, and the button is back',
          [during, before, slow.byId('sendBtn').disabled, slow.byId('sendBtn').textContent, slow.sent('message_failed').map((e) => e.meta), slow.screenOn(), slow.byId('err').classList.contains('on')],
          [[true, 'Sending…'], true, false, 'Leave your feedback!', [{ r: 2, err: 'timeout' }], 'owner', true]);
      }
      // ---- a robot
      {
        const w = openPage(text);
        await toOwner(w, { face: 2, message: 'buy cheap watches' });
        w.byId('website').value = 'http://spam.example';
        const beforeCount = w.beacons.length;
        await w.submit();
        w.hide();
        w.pagehide();
        t('F9 a robot that fills the hidden box is shown "sent"; nothing is posted, and no event goes after that, not even the leaving one',
          [w.screenOn(), w.fetches.length, w.beacons.length === beforeCount, w.sent('message_sent').length, w.sent('review_end').length],
          ['sent', 0, true, 0, 0]);
      }
      // ---- an empty message, a double press, a message too long
      {
        const w = openPage(text);
        await toOwner(w, { face: 2, message: '   ' });
        await w.submit();
        t('F10 nothing typed: "Tell me what happened first.", nothing is sent', [w.byId('err').textContent, w.byId('err').classList.contains('on'), w.fetches.length, w.screenOn()], ['Tell me what happened first.', true, 0, 'owner']);
        // "Tell me what happened first." has done its job at the first letter typed (2026-10-08).
        const e = openPage(text);
        await toOwner(e, { face: 2, message: '   ' });
        await e.submit();
        const asked = e.byId('err').classList.contains('on');
        e.type('msg', 'T');
        t('F10b "Tell me what happened first." goes away at the first thing typed in the box, and was there before', [asked, e.byId('err').classList.contains('on')], [true, false]);
        // ...but only that line: the one for a send that failed is not taken away by typing (the customer is told to call).
        const f = openPage(text);
        await toOwner(f, { face: 2, message: '   ' });
        await f.submit();
        f.byId('msg').value = 'the fries were cold';
        f.plan.push({ status: 503 });
        await f.submit();
        const failedShown = [f.byId('err').classList.contains('on'), f.byId('err').innerHTML.includes("That didn't go through")];
        f.type('msg', 'the fries were cold!');
        t('F10c typing does not take away "That didn\'t go through" (only the empty-box line), even when the box was empty once before',
          [failedShown, f.byId('err').classList.contains('on'), f.byId('err').innerHTML.includes("That didn't go through")], [[true, true], true, true]);
        const d = openPage(text);
        await toOwner(d, { face: 2, message: 'press twice' });
        d.plan.push({ hang: true });
        fireSubmit(d);
        fireSubmit(d);
        await d.settle();
        t('F11 pressing Send twice while it is sending sends one message', d.fetches.length, 1);
        const big = openPage(text);
        await toOwner(big, { face: 2, message: 'é'.repeat(2000) });
        await big.submit();
        t('F12 a message the Collector could not take (too long in bytes) is not sent, is not reported as a failure, and the customer is asked to shorten it and given the phone',
          [big.fetches.length, big.sent('message_failed').length, big.byId('err').innerHTML.startsWith('That message is too long to send. Please shorten it a little, or call us at'), big.screenOn()],
          [0, 0, true, 'owner']);
      }
      // ---- the Google link, and a dead one
      {
        const w = openPage(text, { google: '' });
        w.face(5);
        w.tap(w.byId('googleBtn'));
        t('F13 with no Google link yet, a tap on the button only flashes the strip: no google_tap, no g; the strip says what is missing',
          [w.sent('google_tap').length, w.byId('testStrip').textContent, w.byId('testStrip').classList.contains('flash')],
          [0, 'TEST MODE · Google link not set', true]);
        const live = openPage(text);
        live.face(2);
        live.tap(live.byId('googleSmall'));
        live.hide();
        t('F13b the small Google link under the unhappy screen is google_tap with btn footer and the unhappy face; the link goes to the Google address',
          [live.sent('google_tap')[0].meta, live.sent('tap').slice(-1)[0].meta.el, live.byId('googleSmall').href, live.byId('googleBtn').href, live.byId('publicLink').hidden, live.sent('review_end')[0].meta.g],
          [{ r: 2, btn: 'footer' }, 'google_footer', 'https://g.page/r/TEST-ONLY/review', 'https://g.page/r/TEST-ONLY/review', false, 1]);
      }
      // ---- the phone
      {
        const w = openPage(text);
        w.tap(w.byId('footPhone'));
        w.face(2);
        await toOwner(w, { face: 2, message: 'x' });
        w.plan.push({ status: 500 });
        await w.submit();
        // The fake page does not turn innerHTML into elements, so the link the page wrote is made here from what it wrote.
        const written = w.byId('err').innerHTML;
        const link = new El('a', { href: /href="([^"]*)"/.exec(written)[1], 'data-track': /data-track="([^"]*)"/.exec(written)[1] }, w.byId('err'));
        w.tap(link);
        w.hide();
        t('F14 a tap on any phone number is phone_tap with the screen it was on: the footer, and the one in the "did not go through" line; el is phone; review_end says ph',
          [w.sent('phone_tap').map((e) => e.meta), w.sent('tap').filter((e) => e.meta.el === 'phone').map((e) => e.meta.sec), w.sent('review_end')[0].meta.ph, written.includes('href="tel:+18564648000" data-track="phone"')],
          [[{ scr: 'rate' }, { scr: 'owner' }], ['footer', 'owner'], 1, true]);
      }
      // ---- taps and hovers on the page
      {
        const w = openPage(text);
        w.advance(500);
        w.tap(w.byId('msg'), { clientX: 195, clientY: 420 });
        w.tap(w.$('header .badge'), { clientX: 195, clientY: 100 });
        w.tap(w.byId('footPhone'), { clientX: 10, clientY: 800 });
        w.tap(w.byId('rate'), { clientX: 10, clientY: 10 });
        w.fire(w.$('[data-track="face_1"]'), 'pointerdown', { clientX: 50, clientY: 400, pointerId: 3, pointerType: 'touch' });
        w.advance(100);
        w.fire(w.$('[data-track="face_1"]'), 'pointerup', { clientX: 50, clientY: 560, pointerId: 3, pointerType: 'touch', button: 0 });
        w.fire(w.$('[data-track="face_1"]'), 'click', { clientX: 50, clientY: 560, detail: 1 });
        const taps = w.sent('tap').map((e) => [e.meta.el, e.meta.sec]);
        t('F15 each tap is filed under what it landed on and the page part (the badge in the header, a label in a screen it is not on is still the screen it sits in, the footer), untagged is "page"; a drag is not a tap',
          taps, [['msg', 'owner'], ['badge', 'header'], ['phone', 'footer'], ['page', 'rate']]);
        const keyed = openPage(text);
        keyed.fire(keyed.$('[data-track="face_3"]'), 'click', { clientX: 0, clientY: 0, detail: 0 });
        t('F15b a key press on a face (a click with no position) is a tap at the middle of the button',
          [keyed.sent('tap')[0].meta.el, keyed.sent('tap')[0].meta.x, keyed.sent('rating_tap')[0].meta.r], ['face_3', 25.6, 3]);
        const many = openPage(text);
        for (let i = 0; i < 70; i++) many.tap(many.byId('rate'));
        many.hide();
        t('F15c 70 taps send 60 tap events; review_end still says 70', [many.sent('tap').length, many.sent('review_end')[0].meta.taps], [60, 70]);
        const mouse = openPage(text);
        mouse.fire(mouse.$('[data-track="face_4"]'), 'pointerover', { pointerType: 'mouse', relatedTarget: null });
        mouse.advance(1500);
        mouse.fire(mouse.$('[data-track="face_5"]'), 'pointerover', { pointerType: 'mouse' });
        mouse.advance(300);
        mouse.fire(mouse.byId('rate'), 'pointerover', { pointerType: 'mouse' });
        mouse.advance(100);
        mouse.fire(mouse.$('[data-track="face_1"]'), 'pointerover', { pointerType: 'touch' });
        mouse.advance(1000);
        mouse.hide();
        const touch = openPage(text, { hover: false });
        touch.fire(touch.$('[data-track="face_4"]'), 'pointerover', { pointerType: 'mouse' });
        touch.advance(2000);
        touch.hide();
        t('F16 a mouse resting 0.4 s or more on a tagged thing is one hover (element and ms); less is none; a touch is not a hover; a phone with no hover sends none; review_end counts them',
          [mouse.sent('hover').map((e) => e.meta), mouse.sent('review_end')[0].meta.hov, touch.sent('hover').length, touch.beacons[0].body.meta.hover],
          [[{ el: 'face_4', ms: 1500 }], 1, 0, false]);
        t('F16b the hover that is still going when the page is hidden is ended and counted first', (() => {
          const h = openPage(text);
          h.fire(h.$('[data-track="send"]'), 'pointerover', { pointerType: 'mouse' });
          h.advance(2500);
          h.hide();
          return [h.names().slice(-2), h.sent('hover')[0].meta, h.sent('review_end')[0].meta.hov];
        })(), [['hover', 'review_end'], { el: 'send', ms: 2500 }, 1]);
      }
      // ---- the leaving, a reload, a new tab
      {
        const storage = new Map();
        const w = openPage(text, { storage });
        w.advance(4000);
        w.face(2);
        w.advance(6000);
        w.hide();
        w.advance(60000);
        w.show();
        w.advance(2000);
        w.pagehide();
        const ends = w.sent('review_end');
        t('F17 each time the page is hidden review_end is sent with the whole visit so far; hidden time is not time on the page; leaving sends the new total only when something changed',
          [ends.length, ends[0].meta.s, ends[0].meta.ms_rate, ends[0].meta.ms_owner, ends[1] && ends[1].meta.ms_owner - ends[0].meta.ms_owner, ends[1] && ends[1].meta.s - ends[0].meta.s],
          [2, 10, 4060, 6000, 2000, 2]);
        const b = openPage(text, { storage, startAt: 1000 });
        b.advance(1000);
        b.hide();
        const last = b.sent('review_end').slice(-1)[0].meta;
        t('F18 a reload in the same tab sends no second review_open and the same session; its review_end is the whole visit (the time before, the face, the screen it came back on)',
          [b.sent('review_open').length, b.names()[0], b.beacons[0].body.session, last.s, last.r, last.tried, last.scr, last.ms_rate],
          [0, 'screen_shown', '00000000-0000-4000-8000-000000000001', 13, 2, 1, 'rate', 5060]);
        const c = openPage(text, { storage: new Map(), local: w.local });
        t('F18b a new tab is a new visit: its own session, review_open again, counters from zero',
          [c.sent('review_open').length, c.beacons[0].body.session, c.beacons[0].body.meta.vn], [1, '00000000-0000-4000-8000-000000000001', 2]);
        const stale = new Map([['steakout.review.visit', JSON.stringify({ ms: { rate: 9000, happy: 0, owner: 8000, sent: 7000 }, taps: 40, r: 4, tried: 9, sent: 1, sentCounts: { tap: 60 } })]]);
        const fresh = openPage(text, { storage: stale });
        fresh.advance(1000);
        fresh.face(1);
        fresh.hide();
        t('F18c a new tab ignores counters left in storage by an earlier tab’s visit', [fresh.sent('rating_tap')[0].meta.prev, fresh.sent('review_end')[0].meta.sent, fresh.sent('review_end')[0].meta.s, fresh.sent('tap').length], [0, 0, 1, 1]);
      }
      // ---- where the visit came from
      {
        const src = (url, storage = new Map()) => openPage(text, { url, storage }).beacons[0].body.source;
        const kept = new Map();
        const first = src('https://lunch.mysteakout.com/review/?c=Receipt', kept);
        const second = src('https://lunch.mysteakout.com/review/', kept);
        t('F19 the placement is the ?c= of the link (a-z 0-9 _ -, 40 long), ?src= is the old name, c wins, junk is direct, and a reload without it keeps it for the tab',
          [first, second, src('https://lunch.mysteakout.com/review/?src=Table-4'), src('https://lunch.mysteakout.com/review/?c=counter&src=table'), src('https://lunch.mysteakout.com/review/?c=%C3%BC%F0%9F%98%A1'),
            src('https://lunch.mysteakout.com/review/'), src('https://lunch.mysteakout.com/review/?c=' + 'a'.repeat(60)), src('https://lunch.mysteakout.com/review/?utm_source=x&fbclid=y&c=window')],
          ['receipt', 'receipt', 'table-4', 'counter', 'direct', 'direct', 'a'.repeat(40), 'window']);
        const all = JSON.stringify(openPage(text, { url: 'https://lunch.mysteakout.com/review/?c=receipt&name=SECRET-NAME&email=secret@example.com&utm_campaign=x' }).beacons.map((b) => [b.url, b.raw]));
        t('F19b the other ?tags on the link are never read, let alone sent', ['SECRET-NAME', 'secret@example.com', 'utm_campaign'].filter((s) => all.includes(s)), []);
      }
      // ---- its own keys, a browser that throws, a page whose tracking is broken
      {
        const w = openPage(text);
        w.hide();
        t('F20 the visit lives under its own sessionStorage keys, apart from the AR page’s (steakout.session, steakout.source, steakout.visit)',
          [[...w.storage.keys()].filter((k) => !k.startsWith('steakout.review.')), [...w.storage.keys()].sort()], [[], ['steakout.review.session', 'steakout.review.source', 'steakout.review.visit']]);
        const priv = openPage(text, { sessionStorageThrows: true, localStorageThrows: true });
        priv.face(2);
        priv.type('msg', 'private mode');
        await priv.submit();
        priv.hide();
        t('F20b a browser whose storage throws (Safari private mode) still opens, rates, sends and reports',
          [priv.screenOn(), priv.fetches.length, priv.names()[0], priv.names().includes('review_end')], ['sent', 1, 'review_open', true]);
        const noBeacon = openPage(text, { beaconWorks: false });
        const sentByFetch = noBeacon.fetches.map((f) => [f.url, f.init.mode, f.init.keepalive, f.init.credentials, f.body.name]).slice(0, 2);
        t('F21 a browser that cannot queue a beacon sends the event with one plain request instead (no-cors, keepalive, no credentials)',
          sentByFetch, [['https://collector.example.workers.dev/collect', 'no-cors', true, 'omit', 'review_open'], ['https://collector.example.workers.dev/collect', 'no-cors', true, 'omit', 'screen_shown']]);
        // review-core.js that loads but defines nothing, as when the file is missing or blocked
        const page = openPage({ ...text, core: 'window.nothing = 1;' });
        t('F22 if review-core.js does not load the page still works: it can be rated and the screens change; nothing is reported; and a message is not pretended sent',
          (() => {
            page.face(2);
            return [page.screenOn(), page.beacons.length, page.byId('testStrip').textContent];
          })(), ['owner', 0, 'TEST MODE · Collector address is not valid, messages and trackers are not sent']);
        page.type('msg', 'hello');
        await page.submit();
        t('F22b …and then a message says it did not go through and the phone to call, rather than "sent"',
          [page.screenOn(), page.fetches.length, page.byId('err').classList.contains('on')], ['owner', 0, true]);
        const broken = openPage(text);
        broken.sandbox.navigator.sendBeacon = () => { throw new Error('the browser is cross today'); };
        broken.face(5);
        broken.tap(broken.byId('googleBtn'));
        t('F23 a beacon that throws never breaks the page: the screens still change and the taps still work', [broken.screenOn(), broken.dataLayer.map((e) => e.event).includes('google_tap')], ['happy', true]);
      }
      // ---- the page knows what the person sees
      {
        const w = openPage(text);
        w.face(1);
        const sees = [w.byId('ownerTitle').textContent, w.byId('ownerEmoji').textContent, w.byId('ownerNote').textContent, w.byId('ownerSig').textContent, w.byId('sendBtn').textContent];
        w.byId('ownerForm');
        t('F24 the unhappy screen says what the original said, signed by the Steak Out family',
          sees, ["That's not the Steak Out way.", '😡', "We're sorry. That's not how we do things here. Tell us what happened and we'll make it right.", '— The Steak Out family', 'Leave your feedback!']);
        w.byId('ownerForm');
        const back = openPage(text);
        back.face(3);
        back.tap(back.$('#owner [data-back]'));
        t('F25 "Change my answer" is answer_changed (from the face, on which screen), then the first screen again, with the footer link hidden',
          [back.sent('answer_changed')[0].meta, back.screenOn(), back.byId('publicLink').hidden, back.sent('screen_shown').map((e) => e.meta.scr)],
          [{ from: 3, scr: 'owner' }, 'rate', true, ['rate', 'owner', 'rate']]);
        back.face(5);
        t('F25b the second tap says which face came before', back.sent('rating_tap').map((e) => e.meta), [{ r: 3, prev: 0 }, { r: 5, prev: 3 }]);
        const lots = openPage(text);
        for (let i = 0; i < 40; i++) { lots.face(1 + (i % 3)); lots.tap(lots.$('#owner [data-back]')); }
        lots.hide();
        t('F26 a thumb that keeps going sends 30 rating_taps and 30 answer_changed at most; review_end still counts the faces',
          [lots.sent('rating_tap').length, lots.sent('answer_changed').length, lots.sent('review_end')[0].meta.tried, lots.beacons.length <= 400], [30, 30, 40, true]);
      }
    }
  },
  {
    name: 'G the real Collector',
    async run(M, t) {
      const text = M.text;
      const workerPath = path.join(COLLECTOR_ROOT, 'src/index.js');
      const costumePath = path.join(COLLECTOR_ROOT, 'test/d1-costume.mjs');
      const have = fs.existsSync(workerPath) && fs.existsSync(costumePath);
      // One visit of each kind, sent out of the page.
      const visits = [];
      {
        const w = openPage(text, { url: 'https://lunch.mysteakout.com/review/?c=receipt' });
        await toOwner(w, { face: 1, message: 'The steak was cold.\nNobody came back.', name: 'Pat', contact: '856-555-0142' });
        w.advance(3000);
        w.tap(w.byId('msg'));
        await w.submit();
        w.hide();
        visits.push(w);
        const h = openPage(text, { url: 'https://lunch.mysteakout.com/review/?c=table', storage: new Map(), local: new Map(), startAt: 1000 });
        h.face(5);
        h.tap(h.byId('googleBtn'));
        h.hide();
        visits.push(h);
      }
      const events = visits.flatMap((w) => w.beacons.map((b) => b.raw));
      const messages = visits.flatMap((w) => w.fetches.map((f) => f.raw));
      t('G1 every event the page sent passes the Collector’s rules for /collect, and every message its rules for /feedback (the copy of them in this file)',
        [events.length > 10, events.map(collectorAcceptsEvent).filter(Boolean), messages.length, messages.map(collectorAcceptsFeedback).filter(Boolean)], [true, [], 1, []]);
      if (!have) {
        t('G2 (the real Collector is not next to this repo, so the copy of its rules above is all that was checked)', true, true);
        return;
      }
      const { default: worker } = await import(pathToFileURL(workerPath).href);
      const { makeD1, allMigrations } = await import(pathToFileURL(costumePath).href);
      const { d1 } = makeD1(allMigrations(COLLECTOR_ROOT));
      const env = { DB: d1, STATS_KEY: 'stats-key-for-tests', EXPORT_KEY: 'export-key-for-tests', ALLOWED_ORIGINS: 'https://lunch.mysteakout.com' };
      const origin = 'https://lunch.mysteakout.com';
      const call = (p, init) => worker.fetch(new Request('https://collector.test' + p, init), env);
      const statuses = [];
      for (const raw of events) statuses.push((await call('/collect', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8' }, body: raw })).status);
      const feedbackAnswers = [];
      for (const raw of messages) {
        const res = await call('/feedback', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain;charset=utf-8' }, body: raw });
        feedbackAnswers.push([res.status, res.headers.get('Access-Control-Allow-Origin'), await res.json()]);
      }
      t('G2 the REAL Worker takes every event (204) and the message (201, readable by this page)',
        [statuses.every((s) => s === 204), statuses.length === events.length, feedbackAnswers], [true, true, [[201, origin, { ok: true }]]]);
      const exportRows = (await (await call('/export?limit=1000', { headers: { Authorization: 'Bearer export-key-for-tests' } })).json()).rows;
      const first = exportRows.filter((r) => r.source === 'receipt');
      t('G3 read back from the real /export in the shape Orbit reads: id, received_at, at, name, source, session, meta, page "review"; names only from Orbit’s list; meta keys only from Orbit’s keys',
        [Object.keys(exportRows[0]), [...new Set(exportRows.map((r) => r.page))],
          exportRows.every((r) => Object.keys(CONTRACT.events).includes(r.name)),
          exportRows.every((r) => Object.keys(r.meta).every((k) => CONTRACT.events[r.name].includes(k))),
          first.map((r) => r.name).slice(0, 4)],
        [['id', 'received_at', 'at', 'name', 'source', 'session', 'meta', 'page'], ['review'], true, true, ['review_open', 'screen_shown', 'tap', 'rating_tap']]);
      const messagesBack = (await (await call('/feedback/export', { headers: { Authorization: 'Bearer export-key-for-tests' } })).json()).rows;
      t('G4 the message read back from the real /feedback/export in the shape Orbit reads, words intact, with the visit and the placement',
        [messagesBack.length, Object.keys(messagesBack[0]), (({ id, received_at, at, ...rest }) => rest)(messagesBack[0])],
        [1, ['id', 'received_at', 'at', 'session', 'source', 'page', 'rating', 'message', 'name', 'contact'],
          { session: '00000000-0000-4000-8000-000000000001', source: 'receipt', page: 'review', rating: 1, message: 'The steak was cold.\nNobody came back.', name: 'Pat', contact: '856-555-0142' }]);
      t('G5 the visit that sent the message and the message have the same session, so Orbit can open that visit from the message',
        exportRows.find((r) => r.name === 'message_sent').session === messagesBack[0].session, true);
      {
        // the page's retry after a lost answer, fed to the real Worker: both tries are answered 201, and one message is kept
        // (the stand-in randomUUID counts 1, 2, 3 in every page, so this page is given its own run of numbers: two real tabs never share an id)
        const r = openPage(text, { storage: new Map(), local: new Map(), uuidFrom: 500 });
        await toOwner(r, { face: 2, message: 'Lost reply, pressed Send twice.' });
        r.plan.push({ reject: true });
        await r.submit();
        r.advance(6000);
        await r.submit();
        const answers = [];
        for (const f of r.fetches) {
          const res = await call('/feedback', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain;charset=utf-8' }, body: f.raw });
          answers.push([res.status, (await res.json()).ok]);
        }
        const back = (await (await call('/feedback/export?limit=500', { headers: { Authorization: 'Bearer export-key-for-tests' } })).json()).rows;
        const mine = back.filter((m) => m.message === 'Lost reply, pressed Send twice.');
        t('G7 the page’s retry after a lost answer, sent to the REAL Worker: both tries are answered 201, and exactly one message is kept',
          [r.fetches.length, r.fetches[0].body.message_id === r.fetches[1].body.message_id, r.fetches[0].raw !== r.fetches[1].raw, answers, mine.length], [2, true, true, [[201, true], [201, true]], 1]);
      }
      const stats = await (await call('/stats', { headers: { Authorization: 'Bearer stats-key-for-tests' } })).text();
      t('G6 the review visits do not show up in the AR numbers, and no word of the message is in the events or the stats',
        [JSON.parse(stats).totals, /cold|Nobody|Pat|856/.test(stats), /cold|Nobody|"Pat"|856-555/.test(JSON.stringify(exportRows))], [[], false, false]);
    }
  },
  {
    name: 'H the files',
    async run(M, t) {
      const html = M.text.page;
      const core = M.text.core;
      const script = inlineScript(html);
      const body = html.slice(html.indexOf('<body>'));
      const tracks = [...body.matchAll(/data-track="([^"]*)"/g)].map((m) => m[1]);
      const sections = [...body.matchAll(/data-section="([^"]*)"/g)].map((m) => m[1]);
      const dynamicTracks = [...script.matchAll(/data-track="([^"]*)"/g)].map((m) => m[1]);
      t('H1 every data-track and data-section on the page is one Orbit knows, and every one Orbit lists is on the page',
        [[...new Set([...tracks, ...dynamicTracks])].sort(), [...new Set(sections)].sort()],
        [CONTRACT.labels.filter((l) => l !== 'page').sort(), CONTRACT.sections.slice().sort()]);
      t('H1b the faces are tagged one to five, the sections are header, the four screens and footer, and the screens carry the names of the contract',
        [tracks.filter((x) => x.startsWith('face_')), sections, [...body.matchAll(/<section class="screen[^"]*" id="([a-z]+)" data-section="([a-z]+)"/g)].map((m) => [m[1], m[2]])],
        [['face_1', 'face_2', 'face_3', 'face_4', 'face_5'], ['header', 'rate', 'happy', 'owner', 'sent', 'footer'], [['rate', 'rate'], ['happy', 'happy'], ['owner', 'owner'], ['sent', 'sent']]]);
      const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
      const links = [...html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
      const external = links.filter((l) => /href="https?:/.test(l));
      t('H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback',
        [srcs.length, /^\.\/review-core\.js\?v=\d{8}-[a-z0-9]+$/.test(srcs[0]), html.indexOf('<script src="./review-core.js') < html.indexOf('<script>\n/* ====='),
          external.map((l) => /fonts\.googleapis\.com\/css2\?family=Open\+Sans/.test(l) && /media="print"/.test(l) && /onload="this\.media='all'"/.test(l) || /rel="preconnect"/.test(l)),
          /<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Open\+Sans/.test(html),
          // every address written anywhere in the page, apart from the font host, the XML namespace the Google logo's svg names,
          // the two examples in the settings' comments (the Google link and the Collector), and the live Collector
          // the settings name (H3 holds it to exactly that address)
          (html.match(/https?:\/\/[^"'\s)<>]+/g) || []).map((u) => new URL(u).hostname).filter((h) => !['fonts.googleapis.com', 'fonts.gstatic.com', 'www.w3.org', 'g.page', 'steakout-ar-collector.your-subdomain.workers.dev', 'steakout-ar-collector.antsojo.workers.dev', 'search.google.com'].includes(h))],
        [1, true, true, [true, true, true], true, []]);
      t('H2b the page loads no script, stylesheet, image or frame from anywhere else: no @import, no url() to another site, no other src',
        [/@import/.test(html), (html.match(/url\(\s*['"]?https?:/g) || []).length, [...html.matchAll(/<(?:img|iframe|source|video|audio)\b[^>]*\ssrc="(https?:[^"]*)"/g)].length],
        [false, 0, 0]);
      const fontFiles = [...html.matchAll(/url\('\.\/(fonts\/[^']+)'\)/g)].map((m) => m[1]);
      t('H2c Bebas Neue is served from this site: both files named in the page exist beside it, and they are the AR page’s own files',
        [fontFiles, fontFiles.map((f) => fs.existsSync(path.join(reviewRoot, f))),
          fontFiles.map((f) => { const a = path.join(reviewRoot, f); const b = path.join(reviewRoot, '..', 'preview/assets', f); return fs.existsSync(b) ? fs.readFileSync(a).equals(fs.readFileSync(b)) : null; })],
        [['fonts/bebas-neue-latin.woff2', 'fonts/bebas-neue-latin-ext.woff2'], [true, true], [true, true]]);
      t('H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian',
        [html.match(/COLLECTOR_URL: "[^"]*",/g), html.match(/GOOGLE_REVIEW_URL: "[^"]*",/g), /OWNER_NAME: "Brian",/.test(html), /Brain/.test(html), /ORBIT_URL/.test(html)],
        [['COLLECTOR_URL: "https://steakout-ar-collector.antsojo.workers.dev",'], ['GOOGLE_REVIEW_URL: "https://search.google.com/local/writereview?placeid=ChIJ-TdkPLbQxokRgbjEMzNg37Y",'], true, false, false]);
      t('H4 nothing is read that could identify a person: not the user agent, the referrer, the language, the time zone, the address of the page, a cookie, or a form value outside the send',
        [/userAgent\b/.test(script + core), /document\.referrer/.test(script + core), /navigator\.language/.test(script + core), /timeZone|resolvedOptions/.test(script + core),
          /location\.(href|pathname|origin|hash)/.test(script + core), /document\.cookie/.test(script + core), (script.match(/location\.search/g) || []).length],
        [false, false, false, false, false, false, 1]);
      t('H5 the page keeps one count in localStorage (a number) and four sessionStorage keys of its own (three in the page, the message id in the core), nothing else',
        [[...script.matchAll(/localStorage\.(?:get|set)Item\("([^"]*)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i), [...script.matchAll(/const [A-Z_]+_KEY = "([^"]*)"/g)].map((m) => m[1]),
          [...core.matchAll(/const [A-Z_]+_KEY = '([^']*)'/g)].map((m) => m[1]), /indexedDB|caches\.|document\.cookie|localStorage/.test(core), /indexedDB|caches\.|document\.cookie/.test(script)],
        [['so-review-visits'], ['steakout.review.session', 'steakout.review.source', 'steakout.review.visit'], ['steakout.review.msgid'], false, false]);
      t('H6 events go to /collect and the message to /feedback and nowhere else; the message is sent from one place, with fetch (so its answer can be read); an event is sent with fetch only as the stand-in for a beacon (no-cors, keepalive)',
        [(core.match(/\/collect`/g) || []).length, (core.match(/\/feedback`/g) || []).length, (script.match(/window\.fetch\(/g) || []).length, (script.match(/\bfetch\(url,/g) || []).length, /sendBeacon\(url, body\)/.test(script), /keepalive: true, mode: "no-cors"/.test(script)],
        [1, 1, 1, 1, true, true]);
      // ---- the polish block (2026-10-08): sizes only, and the tap areas it exists for
      const polish = (POLISH_BLOCK.exec(/<style>([\s\S]*?)<\/style>/.exec(html)[1]) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '');
      const polishRules = [...polish.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), Object.fromEntries(m[2].split(';').map((d) => d.split(':')).filter((d) => d.length > 1).map(([k, ...v]) => [k.trim(), v.join(':').trim()]))]);
      const polishRule = (sel) => Object.assign({}, ...polishRules.filter(([s]) => s === sel).map(([, props]) => props));
      const SIZES_ONLY = ['padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin', 'margin-top', 'margin-bottom', 'white-space', 'text-wrap', 'min-height', 'min-width'];
      t('H8 the polish block changes sizes and wrapping only: nothing in it sets a colour, a font, a word (content) or a shadow',
        [polishRules.length > 0, polishRules.flatMap(([, props]) => Object.keys(props)).filter((k) => !SIZES_ONLY.includes(k)), /content\s*:/.test(polish)], [true, [], false]);
      t('H8b a finger can hit the small links and "Change my answer": the footer links, the phone in the "didn’t go through" line and the one on the sent screen get 13, 12 and 10px of padding above and below (the line is 17-18px), and the button grows 10px and takes it back in its margin',
        [polishRule('footer a').padding, polishRule('.err a').padding, polishRule('.lead a').padding, polishRule('.back').padding, polishRule('.back').margin],
        ['13px 0', '12px 0', '10px 0', '13px 8px', '17px auto -5px']);
      t('H8c the footer is two lines (the address, then the phone and the Google link), so no dot dangles at a line end; its words break evenly if they ever must, and on a 320px phone it has 8px a side to hold the address on one line',
        [(html.match(/<footer[^>]*>\s*<div>[^<]*<\/div>\s*<div><a id="footPhone"/g) || []).length, polishRule('footer')['text-wrap'], polishRule('footer')['padding-left'], polishRule('footer')['padding-right']],
        [1, 'balance', '8px', '8px']);
      // ---- the look and the words are the original's
      const look = (page, isNew) => {
        const style = /<style>([\s\S]*?)<\/style>/.exec(page)[1].replace(/@font-face\s*\{[^}]*\}/g, '').replace(POLISH_BLOCK, '');
        const bodyText = page.slice(page.indexOf('<body>'), page.lastIndexOf('</body>'))
          .replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/ data-(?:track|section)="[^"]*"/g, '');
        const head = (page.match(/<(?:meta|title)\b[^>]*>(?:[^<]*<\/title>)?/g) || []).join('');
        return `${head}\n${style}\n${bodyText}`.replace(/\s+/g, ' ').trim();
      };
      const newLook = look(html, true);
      // The look of the original page, as the owner made it, after the normalising above and with the approved
      // polish edits (POLISH_EDITS) made to it. If this check goes red and the change was meant, set it to the new
      // value the failure prints. (Before the polish of 2026-10-08 it was 819322f6913991ad9d1c78974483d0b19854f53967fb9c7f6ac4867f555214c2,
      // the original with nothing changed; before the owner's wording of 2026-10-10, "You're family here" on the
      // unhappy screen, it was 17f18b1dc1172afe91572c6ed68f18ed5cd285ecf6b7e5fcbb6e4789ab5fcdc0.)
      const LOOK_SHA256 = '79da1f62e06f44638471347a6b2a21af74760e36a57fec6587d2dbdc1829a5b2';
      const hash = crypto.createHash('sha256').update(newLook).digest('hex');
      t('H7 the four screens look and read as the original did, apart from the approved polish edits: the head, the styles (without the self-hosted font faces and the polish block) and the markup (without the tracking tags and the scripts) hash to the original’s with those edits',
        hash, LOOK_SHA256);
      let original = null;
      try { original = fs.readFileSync(ORIGINAL_PAGE, 'utf8'); } catch (error) { /* not on this machine */ }
      if (original) {
        const oldLook = withPolish(look(original, false));
        t('H7b …and set against the original page itself (the file the owner made), word for word, once the approved polish edits are made to it', oldLook === newLook, true);
        const strings = ['Tell me what happened first.', 'Sending…', 'Glad you loved it', 'Glad you enjoyed it', 'We read every one', "We'll reach out to you. Need us sooner? Call", 'Thanks for telling us straight. Want a call back? Ring us at',
          "That didn't go through. Check your connection and try again, or call us at", "That's not the Steak Out way.", 'Sorry we fell short.', "Just OK isn't OK with us."];
        const moods = (s) => /const MOODS = \{[\s\S]*?\n\};/.exec(s)[0];
        t('H7c the words in the script are the original’s: the same sentences are in both, and the three owner notes are the same text', [strings.filter((s) => !original.includes(s)), strings.filter((s) => !script.includes(s)), moods(original) === moods(script)], [[], [], true]);
      } else {
        t('H7b (the original page is not at ' + ORIGINAL_PAGE.replace(process.env.HOME || '', '~') + ', so only the hash above was checked)', true, true);
      }
    }
  }
];

function fireSubmit(w) {
  // A press of Send that is not awaited, to watch the page while it is still sending.
  w.fire(w.byId('ownerForm'), 'submit', {});
}

/* ------------------------------------------------------------- mutations */

const C = 'core';
const P = 'page';
const mut = (name, file, from, to, check, also) => ({ name, file, from, to, check, also });
const E9 = 'E9 a message_id goes last in the body, passes the Collector’s rules, and is left out when there is none; one the Collector would refuse is never sent';
const E10 = 'E10 the same message gets the same id every time it is asked for: again, with spaces round it, and after a reload of the tab (a new page, the same sessionStorage)';
const E10B = 'E10b what is kept in the tab is the id and a short code, never a word the customer typed';
const E11 = 'E11 different words, face, name or contact are a different message: a new id (a second thought is not a repeat)';
const E11B = 'E11b …and an edit then a return to the first words is not the first message any more (only the message in hand keeps its id)';
const E12 = 'E12 once a message is stored the next one starts afresh (a new id, even with the same words); the tab keeps nothing of the stored one';
const E13 = 'E13 with storage that throws the id still holds from one try to the next within the page, and a stored message ends it; nothing throws';
const E13B = 'E13b an id maker that fails or makes an id the Collector would refuse is replaced by one of the core’s own that it takes';
const E13C = 'E13c junk in the stored value is not believed (even with the right code in it): a new id each time';
const E13D = 'E13d …but a good one is';
const F7C = 'F7c a message whose answer never came is sent again with the SAME message_id (and a newer time); the id is kept in the tab until it is stored, then cleared';
const F7C2 = 'F7c2 …and nothing the customer typed is in what the tab kept while the message was waiting to be stored (the id and a short code)';
const F7D = 'F7d words changed between the tries are a different message: a new id';
const F7E = 'F7e a timeout, a reload of the tab, the same words typed again: the SAME message_id and the same visit, so the Collector can tell it is the message it already has';
const F7F = 'F7f a phone that refuses storage still sends the retry with the same message_id (kept in the page)';
const F7G = 'F7g a second message with the same words after the first was stored is a new message: a new id';
const G7 = 'G7 the page’s retry after a lost answer, sent to the REAL Worker: both tries are answered 201, and exactly one message is kept';
const F10B = 'F10b "Tell me what happened first." goes away at the first thing typed in the box, and was there before';
const F10C = 'F10c typing does not take away "That didn\'t go through" (only the empty-box line), even when the box was empty once before';
const H8 = 'H8 the polish block changes sizes and wrapping only: nothing in it sets a colour, a font, a word (content) or a shadow';
const H8B = 'H8b a finger can hit the small links and "Change my answer": the footer links, the phone in the "didn’t go through" line and the one on the sent screen get 13, 12 and 10px of padding above and below (the line is 17-18px), and the button grows 10px and takes it back in its margin';
const H8C = 'H8c the footer is two lines (the address, then the phone and the Google link), so no dot dangles at a line end; its words break evenly if they ever must, and on a 320px phone it has 8px a side to hold the address on one line';
const MUTATIONS = [
  // ---- A the contract
  mut('core: an event Orbit does not list', C, "    message_failed: Object.freeze(['r', 'err']),\n", "    message_failed: Object.freeze(['r', 'err']),\n    free_lunch: Object.freeze([]),\n", 'A1 the events are exactly Orbit’s ORBIT_REVIEW_EVENTS'),
  mut('core: an event Orbit lists is missing', C, "    phone_tap: Object.freeze(['scr']),\n", '', 'A1 the events are exactly Orbit’s ORBIT_REVIEW_EVENTS'),
  mut('core: tap loses its py key', C, "tap: Object.freeze(['el', 'sec', 'x', 'y', 'py', 't']),", "tap: Object.freeze(['el', 'sec', 'x', 'y', 't']),", 'A2 each event is allowed exactly Orbit’s meta keys'),
  mut('core: hover carries an extra key', C, "hover: Object.freeze(['el', 'ms']),", "hover: Object.freeze(['el', 'ms', 'x']),", 'A2 each event is allowed exactly Orbit’s meta keys'),
  mut('core: message_started carries the words', C, "message_started: Object.freeze(['r']),", "message_started: Object.freeze(['r', 'len']),", 'A2 each event is allowed exactly Orbit’s meta keys'),
  mut('core: every event gets a t', C, "    return { name, meta };\n  }\n\n  /** The ?c= placement", "    meta.t = 1;\n    return { name, meta };\n  }\n\n  /** The ?c= placement", 'A2b every event comes out with exactly Orbit’s meta keys and nothing added'),
  mut('core: a fifth screen', C, "const SCREENS = Object.freeze(['rate', 'happy', 'owner', 'sent']);", "const SCREENS = Object.freeze(['rate', 'happy', 'owner', 'sent', 'thanks']);", 'A3 the screens, page parts, and element names are Orbit’s'),
  mut('core: a page part Orbit does not know', C, "const SECTIONS = Object.freeze(['header', 'rate', 'happy', 'owner', 'sent', 'footer']);", "const SECTIONS = Object.freeze(['header', 'rate', 'happy', 'owner', 'sent', 'footer', 'sidebar']);", 'A3 the screens, page parts, and element names are Orbit’s'),
  mut('core: an element Orbit does not know', C, "'google_main', 'google_footer', 'phone', 'back', 'msg', 'name', 'contact', 'send', 'badge'\n", "'google_main', 'google_footer', 'phone', 'back', 'msg', 'name', 'contact', 'send', 'badge', 'mascot'\n", 'A3 the screens, page parts, and element names are Orbit’s'),
  mut('core: an unknown event is sent as it is', C, "if (typeof name !== 'string' || !hasOwn(EVENT_KEYS, name)) return null;", "if (typeof name !== 'string') return null;\n    if (!hasOwn(EVENT_KEYS, name)) return { name, meta: { ...(isObject(detail) ? detail : {}) } };", 'A4 a name or a key that is not in the list is dropped'),
  mut('core: any inherited name is an event', C, "!hasOwn(EVENT_KEYS, name)) return null;", "!(name in EVENT_KEYS)) return null;", 'A4 a name or a key that is not in the list is dropped'),
  mut('core: unlisted keys are forwarded', C, "for (const key of EVENT_KEYS[name]) {\n      if (!hasOwn(given, key)) continue;", "for (const key of Object.keys(given).filter((k) => hasOwn(RULES, k))) {\n      if (!hasOwn(given, key)) continue;", 'A4 a name or a key that is not in the list is dropped'),
  mut('core: numbers are not clamped', C, "const intBetween = (min, max) => (value) => (isNumber(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined);", "const intBetween = (min, max) => (value) => (isNumber(value) ? Math.round(value) : undefined);", 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: x is rounded to a whole number', C, "const tenthUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, round1(value))) : undefined);", "const tenthUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined);", 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: any word is accepted for a choice', C, "const oneOf = (words) => (value) => (typeof value === 'string' && words.includes(value) ? value : undefined);", "const oneOf = (words) => (value) => (typeof value === 'string' ? value : undefined);", 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: numeric strings are numbers', C, "const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);", "const isNumber = (value) => Number.isFinite(Number(value)) && value !== null && value !== '';", 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: the opening count may be 0', C, 'vn: intBetween(1, 99),', 'vn: intUpTo(99),', 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: the hour may be 99', C, 'hr: intBetween(0, 23),', 'hr: intUpTo(99),', 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: the weekday may be 9', C, 'wd: intBetween(0, 6),', 'wd: intUpTo(9),', 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: the face may be 9', C, '    r: intBetween(0, 5),', '    r: intUpTo(9),', 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: the length may be 99,999', C, 'len: intUpTo(FEEDBACK_MAX_MESSAGE),', 'len: intUpTo(99999),', 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: answer_changed may come from face 0', C, 'from: intBetween(1, 5),', 'from: intBetween(0, 5),', 'A5 values are rebuilt: numbers clamped and rounded, words checked, junk dropped'),
  mut('core: a yes or no is any truthy thing', C, "const bit = (value) => (value === true || value === 1 ? 1 : value === false || value === 0 ? 0 : undefined);", "const bit = (value) => (Number(value) ? 1 : 0);", 'A6 the yes/no keys are 0 or 1, from a real yes or no and nothing else; hover is a true or false'),
  mut('core: hover is any truthy thing', C, "const flag = (value) => (typeof value === 'boolean' ? value : undefined);", "const flag = (value) => Boolean(value);", 'A6 the yes/no keys are 0 or 1, from a real yes or no and nothing else; hover is a true or false'),
  mut('core: err takes any text', C, 'err: oneOf(FAIL_CODES),', "err: (v) => (typeof v === 'string' ? v : undefined),", 'A7 no value can carry free text: every word key takes only its own words, every number key only numbers'),
  mut('core: scr takes any text', C, 'scr: oneOf(SCREENS),', "scr: (v) => (typeof v === 'string' ? v : undefined),", 'A7 no value can carry free text: every word key takes only its own words, every number key only numbers'),
  mut('core: el takes any text', C, "el: oneOf([...ELEMENTS, OTHER_ELEMENT]),", "el: (v) => (typeof v === 'string' ? v : undefined),", 'A7 no value can carry free text: every word key takes only its own words, every number key only numbers'),
  mut('core: the meta limit is far too small', C, 'MAX_META_BYTES = 1400', 'MAX_META_BYTES = 14', 'A8 the biggest possible review_end fits under the Collector’s limits, and under its own'),
  mut('core: the body limit is far too small', C, 'MAX_BODY_BYTES = 1900', 'MAX_BODY_BYTES = 190', 'A8 the biggest possible review_end fits under the Collector’s limits, and under its own'),
  mut('core: the placement is not lowercased', C, 'raw.toLowerCase().replace(', 'raw.replace(', 'A9 the placement is made acceptable to the Collector; nothing usable means direct'),
  mut('core: the placement is not cut to 40', C, ".slice(0, 40) : '';", " : '';", 'A9 the placement is made acceptable to the Collector; nothing usable means direct'),
  mut('core: http is accepted', C, "(url.protocol === 'http:' && local)", "(url.protocol === 'http:')", 'A10 the address: empty means none; https yes; plain http only for this machine; no logins; a pasted /collect or / is forgiven'),
  mut('core: a login in the address is accepted', C, "if (url.username || url.password) return '';", '', 'A10 the address: empty means none; https yes; plain http only for this machine; no logins; a pasted /collect or / is forgiven'),
  mut('core: a pasted /collect is not forgiven', C, ".replace(/\\/(collect|feedback)$/, '')", '', 'A10 the address: empty means none; https yes; plain http only for this machine; no logins; a pasted /collect or / is forgiven'),
  mut('core: a pasted query is kept', C, 'return url.origin + path;', 'return url.href;', 'A10 the address: empty means none; https yes; plain http only for this machine; no logins; a pasted /collect or / is forgiven'),
  mut('core: a trailing slash is kept', C, ".replace(/\\/+$/, '').replace(/\\/(collect|feedback)$/, '')", ".replace(/\\/(collect|feedback)$/, '')", 'A10 the address: empty means none; https yes; plain http only for this machine; no logins; a pasted /collect or / is forgiven'),
  mut('core: no address still sends', C, "if (!shaped || !target || !sessionOk || typeof beacon !== 'function') return shaped;", "if (!shaped || !sessionOk || typeof beacon !== 'function') return shaped;", 'A11 one beacon to /collect with name, source, session, at, meta and page "review"; no address, a bad address, a bad session or an unknown event sends nothing; a failing beacon is swallowed; a refused one tries the fallback once'),
  mut('core: a bad session still sends', C, "if (!shaped || !target || !sessionOk || typeof beacon !== 'function') return shaped;", "if (!shaped || !target || typeof beacon !== 'function') return shaped;", 'A11 one beacon to /collect with name, source, session, at, meta and page "review"; no address, a bad address, a bad session or an unknown event sends nothing; a failing beacon is swallowed; a refused one tries the fallback once'),
  mut('core: an event does not say it is from the review page', C, "        meta: shaped.meta,\n        page: 'review'\n", "        meta: shaped.meta\n", 'A11 one beacon to /collect with name, source, session, at, meta and page "review"; no address, a bad address, a bad session or an unknown event sends nothing; a failing beacon is swallowed; a refused one tries the fallback once'),
  mut('core: the fallback is never used', C, "if (beacon(url, body) === false && typeof fallback === 'function') fallback(url, body);", 'beacon(url, body);', 'A11 one beacon to /collect with name, source, session, at, meta and page "review"; no address, a bad address, a bad session or an unknown event sends nothing; a failing beacon is swallowed; a refused one tries the fallback once'),
  mut('core: a beacon that fails breaks the sender', C, "      } catch (error) {\n        /* measurement never breaks the experience */\n      }", "      } catch (error) {\n        throw error;\n      }", 'A11 one beacon to /collect with name, source, session, at, meta and page "review"; no address, a bad address, a bad session or an unknown event sends nothing; a failing beacon is swallowed; a refused one tries the fallback once'),
  mut('core: a tap is allowed 600 times', C, '    tap: 60,\n', '    tap: 600,\n', 'A12 the per-tab caps leave room under the Collector’s 400: every capped kind at its cap, plus the opening, is under 400'),
  // ---- B where a tap fell
  mut('core: any data-track is an element', C, 'if (key && ELEMENTS.includes(key)) {', 'if (key) {', 'B1 the nearest data-track is the element, however deep the tap was; one not on the list is "page"'),
  mut('core: an unknown section is kept', C, 'sec = SECTIONS.includes(name) ? name : null;', 'sec = name;', 'B2 the nearest data-section is the page part; an unknown one is none, not its neighbour'),
  mut('core: the tagged node is not returned', C, '          el = key;\n          tagged = n;', '          el = key;', 'B3 the tagged node comes back, for the hover to hold on to'),
  mut('core: percentages are not held', C, 'return round1(Math.min(100, Math.max(0, (value / total) * 100)));', 'return round1((value / total) * 100);', 'B4 percentages are to 0.1, held between 0 and 100, and null with nothing to measure against'),
  mut('core: py ignores the scroll', C, 'py: pct1(clientY + (isNumber(scrollY) ? scrollY : 0), Math.max(isNumber(pageH) ? pageH : 0, viewH)),', 'py: pct1(clientY, Math.max(isNumber(pageH) ? pageH : 0, viewH)),', 'B5 x, y are of the screen; py is of the whole page, scrolled or not; no screen no tap'),
  mut('core: py ignores a short page', C, 'Math.max(isNumber(pageH) ? pageH : 0, viewH)),', '(isNumber(pageH) ? pageH : 0)),', 'B5 x, y are of the screen; py is of the whole page, scrolled or not; no screen no tap'),
  // ---- C taps and hovers
  mut('core: a drag is a tap', C, 'return Math.hypot(x - down.x, y - down.y) <= slop;', 'return true;', 'C2 a drag is not a tap, and the click that ends one is not either'),
  mut('core: a click after a tap is another tap', C, 'return time - lastUpAt > windowMs;', 'return true;', 'C1 a finger that stays put is one tap; its click is the same tap'),
  mut('core: a key press is not a tap', C, 'return time - lastUpAt > windowMs;', 'return false;', 'C3 a key press on a button (a click with no pointer before it) is a tap'),
  mut('core: the right button is a tap', C, "if (typeof button === 'number' && button !== 0) return false;", '', 'C4 not the right mouse button, not a cancelled touch, not a pointer-up with no press'),
  mut('core: a pointer-up with no press is a tap', C, 'if (!down) return false;', '', 'C4 not the right mouse button, not a cancelled touch, not a pointer-up with no press'),
  mut('core: a cancelled touch is a tap', C, '      cancel(id) {\n        downs.delete(id);\n      },', '      cancel(id) {},', 'C4 not the right mouse button, not a cancelled touch, not a pointer-up with no press'),
  mut('core: a short rest is a hover', C, 'return rest.ms >= minMs ? rest : null;', 'return rest;', 'C5 a rest of 0.4 s on a tagged thing is one hover; shorter is none; moving inside it does not restart it; flush ends a rest in progress once'),
  mut('core: moving inside restarts the rest', C, 'if (current && key !== null && current.key === key) return null;\n', '', 'C5 a rest of 0.4 s on a tagged thing is one hover; shorter is none; moving inside it does not restart it; flush ends a rest in progress once'),
  mut('core: a rest is reported twice', C, "      const rest = { el: current.el, ms: Math.round(t - current.since) };\n      current = null;", "      const rest = { el: current.el, ms: Math.round(t - current.since) };", 'C5 a rest of 0.4 s on a tagged thing is one hover; shorter is none; moving inside it does not restart it; flush ends a rest in progress once'),
  // ---- D the visit
  mut('core: hidden time is counted', C, '        pageVisible = next;\n        since = next ? t : null;', '        pageVisible = next;\n        since = t;', 'D1 time is counted per screen and only while the page is visible; s is those seconds added up'),
  mut('core: time on a screen is filed under the next one', C, '        bank(t);\n        screen = name;', '        screen = name;\n        bank(t);', 'D1 time is counted per screen and only while the page is visible; s is those seconds added up'),
  mut('core: s is the clock, not the visible time', C, 's: Math.round(all / 1000),', 's: Math.round((all + 60000) / 1000),', 'D1 time is counted per screen and only while the page is visible; s is those seconds added up'),
  mut('core: a page opened in the background counts', C, 'let since = pageVisible ? startT : null;', 'let since = startT;', 'D2 a page opened in the background counts nothing until it is seen'),
  mut('core: scroll keeps the last, not the deepest', C, 'if (isNumber(percent) && percent > deepest) deepest = Math.min(100, Math.round(percent));', 'if (isNumber(percent)) deepest = Math.min(100, Math.round(percent));', 'D3b scroll depth is the deepest, not the last'),
  mut('core: scroll is not held at 100', C, 'if (isNumber(percent) && percent > deepest) deepest = Math.min(100, Math.round(percent));', 'if (isNumber(percent) && percent > deepest) deepest = Math.round(percent);', 'D3 scroll keeps the deepest (held at 100); rated says the face before; tried counts every tap (to 99); yes/no marks; taps count past the cap'),
  mut('core: rated says nothing about the face before', C, '        const previous = face;\n', '        const previous = 0;\n', 'D3 scroll keeps the deepest (held at 100); rated says the face before; tried counts every tap (to 99); yes/no marks; taps count past the cap'),
  mut('core: tried is not held at 99', C, 'tried = Math.min(99, tried + 1);', 'tried += 1;', 'D3 scroll keeps the deepest (held at 100); rated says the face before; tried counts every tap (to 99); yes/no marks; taps count past the cap'),
  mut('core: taps stop counting at the cap', C, '        taps = Math.min(9999, taps + 1);\n        return this.allow(\'tap\');', '        if (!this.allow(\'tap\')) return false;\n        taps = Math.min(9999, taps + 1);\n        return true;', 'D4 70 taps send 60 and 50 hovers send 40; other kinds stop at their own cap; a kind with no cap is always allowed; the totals keep counting'),
  mut('core: hovers may be sent 400 times', C, '    hover: 40,\n', '    hover: 400,\n', 'D4 70 taps send 60 and 50 hovers send 40; other kinds stop at their own cap; a kind with no cap is always allowed; the totals keep counting'),
  mut('core: a kind with a cap is never held', C, 'if ((counts[name] || 0) >= CAPS[name]) return false;', '', 'D4 70 taps send 60 and 50 hovers send 40; other kinds stop at their own cap; a kind with no cap is always allowed; the totals keep counting'),
  mut('core: a kind with no cap is held', C, 'if (!hasOwn(CAPS, name)) return true;', 'if (!hasOwn(CAPS, name)) return false;', 'D4 70 taps send 60 and 50 hovers send 40; other kinds stop at their own cap; a kind with no cap is always allowed; the totals keep counting'),
  mut('core: review_end is sent when nothing changed', C, 'if (signature === lastEnd) return null;', '', 'D5 review_end is re-sent only when something changed, and at most 40 times a tab'),
  mut('core: review_end has no limit', C, "if ((counts.review_end || 0) >= CAPS.review_end) return null;", '', 'D5 review_end is re-sent only when something changed, and at most 40 times a tab'),
  mut('core: a reload forgets the time', C, '    ms: Object.fromEntries(SCREENS.map((name) => [name, Math.round(per[name])])),', '    ms: Object.fromEntries(SCREENS.map((name) => [name, 0])),', 'D6 a reload in the same tab carries the visit on: time per screen, scroll, taps, the face, the yes/no marks and how many were sent'),
  mut('core: a reload forgets the taps', C, "      taps: int('taps', 9999),", '      taps: 0,', 'D6 a reload in the same tab carries the visit on: time per screen, scroll, taps, the face, the yes/no marks and how many were sent'),
  mut('core: a reload forgets the face', C, '      r: intBetween(0, 5)(given.r) || 0,', '      r: 0,', 'D6 a reload in the same tab carries the visit on: time per screen, scroll, taps, the face, the yes/no marks and how many were sent'),
  mut('core: a reload forgets the scroll', C, "      sd: int('sd', 100),", '      sd: 0,', 'D6 a reload in the same tab carries the visit on: time per screen, scroll, taps, the face, the yes/no marks and how many were sent'),
  mut('core: a reload forgets what it sent', C, "    for (const name of Object.keys(CAPS)) sentCounts[name] = intUpTo(9999)(givenSent[name]) || 0;", '    for (const name of Object.keys(CAPS)) sentCounts[name] = 0;', 'D6b …and the caps carry on too, so a reload cannot send 60 taps again'),
  mut('core: a stored time that is text is believed', C, "    for (const screen of SCREENS) ms[screen] = intUpTo(2 * DAY_MS)(givenMs[screen]) || 0;", '    for (const screen of SCREENS) ms[screen] = givenMs[screen] || 0;', 'D7 a stored visit that is rubbish starts from zero'),
  mut('core: a stored face of 9 is believed', C, '      r: intBetween(0, 5)(given.r) || 0,', '      r: given.r || 0,', 'D7 a stored visit that is rubbish starts from zero'),
  mut('core: the stored visit carries an id', C, '          sentCounts: { ...counts }\n        };', "          sentCounts: { ...counts },\n          session: 'abc'\n        };", 'D8 what a visit stores is counters only: no words, no ids'),
  // ---- E the message
  mut('core: the message does not say it is from the review page', C, "      page: 'review',\n      rating: face,", '      rating: face,', 'E1 the body is exactly what the Collector reads: session, source, page review, rating, message, name, contact, website empty, at; trimmed'),
  mut('core: the hidden box is left out', C, "      website: '',\n", '', 'E1 the body is exactly what the Collector reads: session, source, page review, rating, message, name, contact, website empty, at; trimmed'),
  mut('core: the message is not trimmed', C, "words: typeof message === 'string' ? message.trim() : '',", "words: typeof message === 'string' ? message : '',", 'E1 the body is exactly what the Collector reads: session, source, page review, rating, message, name, contact, website empty, at; trimmed'),
  mut('core: the placement is sent raw with a message', C, '      source: cleanSource(source),\n      page: \'review\',', "      source,\n      page: 'review',", 'E1 the body is exactly what the Collector reads: session, source, page review, rating, message, name, contact, website empty, at; trimmed'),
  mut('core: a name left out counts as given', C, "nm: who ? 1 : 0, ct: reach ? 1 : 0", 'nm: 1, ct: reach ? 1 : 0', 'E2 a name and a contact left out are empty, and counted as no'),
  mut('core: a contact of spaces counts as given', C, "ct: reach ? 1 : 0", 'ct: contact ? 1 : 0', 'E2 a name and a contact left out are empty, and counted as no'),
  mut('core: a message with no face is built', C, "if (!Number.isInteger(face) || face < 1 || face > 5) return { ok: false, reason: 'rating' };", '', 'E3 not built for a bad visit, face or message'),
  mut('core: a message with a bad session is built', C, "if (typeof session !== 'string' || !SESSION_RE.test(session)) return { ok: false, reason: 'session' };", '', 'E3 not built for a bad visit, face or message'),
  mut('core: an empty message is built', C, "if (!words) return { ok: false, reason: 'empty' };", '', 'E3 not built for a bad visit, face or message'),
  mut('core: a message may be 5,000 characters', C, 'FEEDBACK_MAX_MESSAGE = 2000', 'FEEDBACK_MAX_MESSAGE = 5000', 'E4 the Collector’s limits: 2,000 characters of message yes, 2,001 no; a name is cut to 80 and a contact to 120; a body past 4,096 bytes is too long'),
  mut('core: a name may be 200 characters', C, 'FEEDBACK_MAX_NAME = 80', 'FEEDBACK_MAX_NAME = 200', 'E4 the Collector’s limits: 2,000 characters of message yes, 2,001 no; a name is cut to 80 and a contact to 120; a body past 4,096 bytes is too long'),
  mut('core: a contact may be 300 characters', C, 'FEEDBACK_MAX_CONTACT = 120', 'FEEDBACK_MAX_CONTACT = 300', 'E4 the Collector’s limits: 2,000 characters of message yes, 2,001 no; a name is cut to 80 and a contact to 120; a body past 4,096 bytes is too long'),
  mut('core: a body may be 40 KB', C, 'FEEDBACK_MAX_BODY_BYTES = 4096', 'FEEDBACK_MAX_BODY_BYTES = 40960', 'E4 the Collector’s limits: 2,000 characters of message yes, 2,001 no; a name is cut to 80 and a contact to 120; a body past 4,096 bytes is too long'),
  mut('core: every character is one byte', C, 'bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;', 'bytes += 1;', 'E4 the Collector’s limits: 2,000 characters of message yes, 2,001 no; a name is cut to 80 and a contact to 120; a body past 4,096 bytes is too long'),
  mut('core: a name is not cut', C, 'name.trim().slice(0, FEEDBACK_MAX_NAME)', 'name.trim()', 'E5 whatever the box was cut to, the body passes the Collector’s rules'),
  mut('core: a message is sent as a PUT', C, "          method: 'POST',\n          headers: { 'Content-Type': 'text/plain;charset=utf-8' },", "          method: 'PUT',\n          headers: { 'Content-Type': 'text/plain;charset=utf-8' },", 'E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache'),
  mut('core: a message is sent as JSON', C, "headers: { 'Content-Type': 'text/plain;charset=utf-8' },\n          body,", "headers: { 'Content-Type': 'application/json' },\n          body,", 'E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache'),
  mut('core: a message is sent with credentials', C, "credentials: 'omit',", "credentials: 'include',", 'E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache'),
  mut('core: a message may be cached', C, "cache: 'no-store',", "cache: 'default',", 'E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache'),
  mut('core: a message goes to /collect', C, '`${target}/feedback`', '`${target}/collect`', 'E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache'),
  mut('core: the wait is 1.5 seconds', C, 'FEEDBACK_TIMEOUT_MS = 15000', 'FEEDBACK_TIMEOUT_MS = 1500', 'E6 a 2xx is ok; the request is a POST of the body to {base}/feedback as text/plain, with no credentials and no cache'),
  mut('core: a 4xx is told as a 5xx', C, "res && res.status >= 500 ? 'http_5xx' : 'http_4xx'", "res && res.status >= 400 ? 'http_5xx' : 'http_4xx'", 'E7 told apart: 204 ok, 400 / 403 / 413 / 429 are 4xx, 500 / 503 are 5xx, no connection is network, no answer is timeout (and the request is cancelled)'),
  mut('core: a timeout is told as no connection', C, "        resolve({ ok: false, err: 'timeout' });", "        resolve({ ok: false, err: 'network' });", 'E7 told apart: 204 ok, 400 / 403 / 413 / 429 are 4xx, 500 / 503 are 5xx, no connection is network, no answer is timeout (and the request is cancelled)'),
  mut('core: a late request is not cancelled', C, '          try { controller.abort(); } catch (error) { /* already finished */ }', '', 'E7 told apart: 204 ok, 400 / 403 / 413 / 429 are 4xx, 500 / 503 are 5xx, no connection is network, no answer is timeout (and the request is cancelled)'),
  mut('core: a redirect counts as delivered', C, "if (res && res.ok === true && res.status >= 200 && res.status < 300) return { ok: true };", "if (res && res.status < 400) return { ok: true };", 'E8 a 3xx is not delivered, and nothing is sent without a usable address or a fetch'),
  mut('core: a message goes out with no address', C, "if (!target || typeof doFetch !== 'function') return { ok: false, err: 'network' };", "if (typeof doFetch !== 'function') return { ok: false, err: 'network' };", 'E8 a 3xx is not delivered, and nothing is sent without a usable address or a fetch'),
  // ---- F the whole page
  mut('core: with no Collector the core still sends', C, "if (!shaped || !target || !sessionOk || typeof beacon !== 'function') return shaped;", "if (!shaped || !sessionOk || typeof beacon !== 'function') return shaped;", 'F1 with no Collector address: the strip says so, nothing leaves the phone, the events are only in dataLayer, and a message pretends to send (the sent screen shows)'),
  mut('page: the strip does not say the Collector is missing', P, 'missing.push("Collector not connected, messages and trackers are not sent");', 'missing.push("Orbit not connected");', 'F1 with no Collector address: the strip says so, nothing leaves the phone, the events are only in dataLayer, and a message pretends to send (the sent screen shows)'),
  mut('page: dataLayer is not kept', P, 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session });', '', 'F1 with no Collector address: the strip says so, nothing leaves the phone, the events are only in dataLayer, and a message pretends to send (the sent screen shows)'),
  mut('page: test mode does not log', P, 'if (!collectorAsked && shaped) { try { console.log("[TEST MODE] event:", shaped); } catch (e) { /* no console */ } }', '', 'F1 with no Collector address: the strip says so, nothing leaves the phone, the events are only in dataLayer, and a message pretends to send (the sent screen shows)'),
  mut('page: test mode sends the message', P, '  if (!collectorAsked) {\n    console.log("[TEST MODE] would send to the Collector:", payload);\n    sentOk(payload);\n    return;\n  }\n', '', 'F1 with no Collector address: the strip says so, nothing leaves the phone, the events are only in dataLayer, and a message pretends to send (the sent screen shows)'),
  mut('page: the strip does not name the Google link', P, '  if (!CONFIG.GOOGLE_REVIEW_URL) missing.push("Google link not set");\n', '', 'F1b with neither set, the strip names both'),
  mut('page: an unusable address is not said', P, '  else if (!connected) missing.push("Collector address is not valid, messages and trackers are not sent");\n', '', 'F2 an address that cannot be used (https://u:p@collector.…) is said out loud, nothing leaves, and a message is NOT shown as sent'),
  mut('page: an unusable address pretends to send', P, 'if (!collectorAsked) {\n    console.log("[TEST MODE] would send', 'if (!connected) {\n    console.log("[TEST MODE] would send', 'F2 an address that cannot be used (https://u:p@collector.…) is said out loud, nothing leaves, and a message is NOT shown as sent'),
  mut('page: review_open is sent on every load', P, 'if (isNewVisit) {\n  let visits;', 'if (true) {\n  let visits;', 'F18 a reload in the same tab sends no second review_open and the same session; its review_end is the whole visit (the time before, the face, the screen it came back on)'),
  mut('core: review_open has no hour', C, 'hr: date instanceof Date ? date.getHours() : undefined,', 'hr: undefined,', 'F3 a new tab sends review_open first, with the screen, the phone, how many opens, the local hour and weekday, and nothing else; then the first screen'),
  mut('core: review_open has no weekday', C, 'wd: date instanceof Date ? date.getDay() : undefined', 'wd: undefined', 'F3 a new tab sends review_open first, with the screen, the phone, how many opens, the local hour and weekday, and nothing else; then the first screen'),
  mut('core: review_open always says it cannot hover', C, 'hover: Boolean(hover),', 'hover: false,', 'F3 a new tab sends review_open first, with the screen, the phone, how many opens, the local hour and weekday, and nothing else; then the first screen'),
  mut('page: the first screen is not reported', P, 'visit.screen("rate", now());\nemit("screen_shown", { scr: "rate" });', 'visit.screen("rate", now());', 'F3 a new tab sends review_open first, with the screen, the phone, how many opens, the local hour and weekday, and nothing else; then the first screen'),
  mut('page: the opening count is not kept', P, '    window.localStorage.setItem("so-review-visits", String(visits));\n', '', 'F3b the phone remembers how many times it opened the page (a count only), and the next tab says 2'),
  mut('page: a phone that cannot keep a count breaks the page', P, '  } catch (e) { visits = undefined; }', '  } catch (e) { throw e; }', 'F3c a phone that cannot keep a count still opens the page, and review_open simply has no vn'),
  mut('page: a face is not reported', P, '  emit("rating_tap", { r: rating, prev: before });\n', '', 'F4 a happy visit: tap, rating_tap (r 5, prev 0), the Google screen, a tap and google_tap (main), then review_end with the face and g'),
  mut('page: Google is not reported', P, '  emit("google_tap", { r: rating, btn: a.id === "googleBtn" ? "main" : "footer" });', '', 'F4 a happy visit: tap, rating_tap (r 5, prev 0), the Google screen, a tap and google_tap (main), then review_end with the face and g'),
  mut('page: the main Google button is called the footer one', P, 'btn: a.id === "googleBtn" ? "main" : "footer"', 'btn: a.id === "googleBtn" ? "footer" : "main"', 'F4 a happy visit: tap, rating_tap (r 5, prev 0), the Google screen, a tap and google_tap (main), then review_end with the face and g'),
  mut('core: a tap says x where it was y', C, 'const x = pct1(clientX, viewW);', 'const x = pct1(clientY, viewW);', 'F4b the tap says what it was and where: the face, the part of the page, x and y of the screen'),
  mut('core: time on a screen is not filed under it', C, '        bank(t);\n        screen = name;', '        screen = name;', 'F4c review_end says how long on each screen (the 5 s here split 2 and 3), the face, and that Google was tapped'),
  mut('page: the time is counted from the browser’s start', P, 'startT: now(),', 'startT: 0,', 'F4c review_end says how long on each screen (the 5 s here split 2 and 3), the face, and that Google was tapped'),
  mut('page: the Google tap is not marked', P, '  visit.mark("g");\n', '', 'F4c review_end says how long on each screen (the 5 s here split 2 and 3), the face, and that Google was tapped'),
  mut('page: a 4 is told it loved it', P, '$("happyBar").textContent = rating === 5 ? "Glad you loved it" : "Glad you enjoyed it";', '$("happyBar").textContent = "Glad you loved it";', 'F4d a 4 is "Glad you enjoyed it" and also goes to the Google screen'),
  mut('page: a 4 goes to the owner', P, 'if (rating >= 4) {', 'if (rating >= 5) {', 'F4d a 4 is "Glad you enjoyed it" and also goes to the Google screen'),
  mut('page: a message goes to another address', P, 'const out = await core.postFeedback({\n      base: collector,', 'const out = await core.postFeedback({\n      base: "https://evil.example",', 'F5 a message goes to {base}/feedback and nowhere else, once: the face, the words, the name and contact, the visit, an empty hidden box'),
  mut('page: a message is built with a new visit id', P, 'core.buildFeedback({ session, source, ...payload, messageId, at: Date.now() })', 'core.buildFeedback({ session: newSessionId(), source, ...payload, messageId, at: Date.now() })', 'F5 a message goes to {base}/feedback and nowhere else, once: the face, the words, the name and contact, the visit, an empty hidden box'),
  mut('page: a message goes without its placement', P, 'core.buildFeedback({ session, source, ...payload, messageId, at: Date.now() })', 'core.buildFeedback({ session, source: "direct", ...payload, messageId, at: Date.now() })', 'F5 a message goes to {base}/feedback and nowhere else, once: the face, the words, the name and contact, the visit, an empty hidden box'),
  mut('page: the first key is not reported', P, '  emit("message_started", { r: rating });\n', '', 'F5c the events of that visit, in order, in Orbit’s shapes: the face, the unhappy screen, the first key (no words), the send, message_sent with only counts, the sent screen, review_end'),
  mut('page: a sent message is not reported', P, '  emit("message_sent", {', '  void ({', 'F5c the events of that visit, in order, in Orbit’s shapes: the face, the unhappy screen, the first key (no words), the send, message_sent with only counts, the sent screen, review_end'),
  mut('page: message_sent counts the name wrongly', P, 'nm: payload.name ? 1 : 0,', 'nm: 1,', 'F6c without a phone or email the sent screen offers a call back instead; message_sent says no name, no contact'),
  mut('page: the sent screen is not reported', P, '  visit.screen(id, now());\n  emit("screen_shown", { scr: id });', '  visit.screen(id, now());', 'F5c the events of that visit, in order, in Orbit’s shapes: the face, the unhappy screen, the first key (no words), the send, message_sent with only counts, the sent screen, review_end'),
  mut('core: the events carry the user agent', C, '        at: now(),\n        meta: shaped.meta,', "        at: now(),\n        ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',\n        meta: shaped.meta,", 'F6 nothing typed is in any event or in dataLayer; neither is the user agent, the language, the time zone, or where the visit came from'),
  mut('page: dataLayer carries where the visit came from', P, 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session });', 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session, from: document.referrer });', 'F6 nothing typed is in any event or in dataLayer; neither is the user agent, the language, the time zone, or where the visit came from'),
  mut('page: dataLayer carries what was typed', P, 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session });', 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session, typed: $("msg").value });', 'F6 nothing typed is in any event or in dataLayer; neither is the user agent, the language, the time zone, or where the visit came from'),
  mut('page: dataLayer carries the language', P, 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session });', 'window.dataLayer.push({ event, ...(shaped ? shaped.meta : {}), source, session, lang: navigator.language });', 'F6 nothing typed is in any event or in dataLayer; neither is the user agent, the language, the time zone, or where the visit came from'),
  mut('page: the form is not cleared after sending', P, '  $("ownerForm").reset();\n', '', 'F6b the page after sending: "We’ll reach out to you", the phone link, a cleared form, and the review_end says sent and typed'),
  mut('page: the sent screen does not say we will reach out', P, "? `We'll reach out to you.", '? `Someone will reach out to you.', 'F6b the page after sending: "We’ll reach out to you", the phone link, a cleared form, and the review_end says sent and typed'),
  mut('page: sending is not marked', P, '  visit.mark("sent");\n', '', 'F6b the page after sending: "We’ll reach out to you", the phone link, a cleared form, and the review_end says sent and typed'),
  mut('page: typing is not marked', P, '  visit.mark("typed");\n', '', 'F6b the page after sending: "We’ll reach out to you", the phone link, a cleared form, and the review_end says sent and typed'),
  mut('page: the sent screen offers a call back to someone who gave a number', P, '$("sentLead").innerHTML = payload.contact\n', '$("sentLead").innerHTML = !payload.contact\n', 'F6c without a phone or email the sent screen offers a call back instead; message_sent says no name, no contact'),
  mut('page: a failure is not reported', P, '      emit("message_failed", { r: rating, err: out.err });\n', '', 'F7 a 400: the page says it did not go through (with the phone to call), shows no "sent", keeps what was typed, and reports only the short code'),
  mut('page: a failure says nothing to the customer', P, '      emit("message_failed", { r: rating, err: out.err });\n      err.innerHTML = failedLine;\n      err.classList.add("on");', '      emit("message_failed", { r: rating, err: out.err });', 'F7 a 400: the page says it did not go through (with the phone to call), shows no "sent", keeps what was typed, and reports only the short code'),
  mut('page: a failure is shown as sent', P, '    if (out.ok) {\n', '    if (true) {\n', 'F7 a 400: the page says it did not go through (with the phone to call), shows no "sent", keeps what was typed, and reports only the short code'),
  mut('page: the button stays off after a failure', P, '    sending = false;\n    btn.disabled = false;\n    btn.textContent = "Leave your feedback!";', '    sending = false;\n    btn.textContent = "Leave your feedback!";', 'F7 a 400: the page says it did not go through (with the phone to call), shows no "sent", keeps what was typed, and reports only the short code'),
  mut('page: the error line has no phone', P, 'or call us at <a href="tel:${CONFIG.PHONE_TEL}" data-track="phone">${CONFIG.PHONE}</a>.`;\nconst tooLongLine', 'or call us.`;\nconst tooLongLine', 'F7 a 400: the page says it did not go through (with the phone to call), shows no "sent", keeps what was typed, and reports only the short code'),
  mut('page: after one send the page cannot send again', P, '    sending = false;\n    btn.disabled = false;', '    btn.disabled = false;', 'F7b after a failure the same message can be sent again, and then it is sent: one failure, one success, the error line goes away'),
  mut('core: no answer is waited for for ever', C, 'return await Promise.race([attempt, clock]);', 'return await attempt;', 'F8 a Collector that never answers: the button says Sending… and is off, then after 15 s it gives up as a timeout, says it did not go through, and the button is back', [{ file: C, from: '          try { controller.abort(); } catch (error) { /* already finished */ }', to: '' }]),
  mut('core: no answer is waited for 150 seconds', C, 'FEEDBACK_TIMEOUT_MS = 15000', 'FEEDBACK_TIMEOUT_MS = 150000', 'F8 a Collector that never answers: the button says Sending… and is off, then after 15 s it gives up as a timeout, says it did not go through, and the button is back'),
  mut('page: the button does not say it is sending', P, '  btn.textContent = "Sending…";', '', 'F8 a Collector that never answers: the button says Sending… and is off, then after 15 s it gives up as a timeout, says it did not go through, and the button is back'),
  mut('page: a robot is not muted', P, 'if ($("website").value) { muted = true; done(payload); return; }', 'if ($("website").value) { done(payload); return; }', 'F9 a robot that fills the hidden box is shown "sent"; nothing is posted, and no event goes after that, not even the leaving one'),
  mut('page: a robot is not looked for', P, 'if ($("website").value) { muted = true; done(payload); return; }', '', 'F9 a robot that fills the hidden box is shown "sent"; nothing is posted, and no event goes after that, not even the leaving one'),
  mut('page: a robot is told it failed', P, 'if ($("website").value) { muted = true; done(payload); return; }', 'if ($("website").value) { muted = true; return; }', 'F9 a robot that fills the hidden box is shown "sent"; nothing is posted, and no event goes after that, not even the leaving one'),
  mut('page: an empty message is not noticed', P, 'const message = $("msg").value.trim();', 'const message = $("msg").value;', 'F10 nothing typed: "Tell me what happened first.", nothing is sent'),
  mut('page: pressing Send twice sends twice', P, '  if (sending) return;\n', '', 'F11 pressing Send twice while it is sending sends one message'),
  mut('page: a message too long is called a failure', P, 'err.innerHTML = built.reason === "too_long" ? tooLongLine : failedLine;', 'err.innerHTML = failedLine;', 'F12 a message the Collector could not take (too long in bytes) is not sent, is not reported as a failure, and the customer is asked to shorten it and given the phone'),
  mut('page: a dead Google link counts as a Google tap', P, '  // A tap on a link that goes nowhere (no Google link set yet) is not a tap on Google.\n  if (!CONFIG.GOOGLE_REVIEW_URL) return;\n', '', 'F13 with no Google link yet, a tap on the button only flashes the strip: no google_tap, no g; the strip says what is missing'),
  mut('page: the Google link does not flash the strip', P, 'else a.addEventListener("click", e => { e.preventDefault(); flashTest(); });', 'else a.addEventListener("click", e => { e.preventDefault(); });', 'F13 with no Google link yet, a tap on the button only flashes the strip: no google_tap, no g; the strip says what is missing'),
  mut('page: the Google link is not set', P, 'if (CONFIG.GOOGLE_REVIEW_URL) a.href = CONFIG.GOOGLE_REVIEW_URL;', 'if (CONFIG.GOOGLE_REVIEW_URL) a.href = "#";', 'F13b the small Google link under the unhappy screen is google_tap with btn footer and the unhappy face; the link goes to the Google address'),
  mut('page: the footer Google link is hidden on the unhappy screen', P, '$("publicLink").hidden = id !== "owner";', '$("publicLink").hidden = true;', 'F13b the small Google link under the unhappy screen is google_tap with btn footer and the unhappy face; the link goes to the Google address'),
  mut('page: a phone tap says the wrong screen', P, '  emit("phone_tap", { scr: visit.current() });', '  emit("phone_tap", { scr: "rate" });', 'F14 a tap on any phone number is phone_tap with the screen it was on: the footer, and the one in the "did not go through" line; el is phone; review_end says ph'),
  mut('page: a phone tap is not marked', P, '  visit.mark("ph");\n', '', 'F14 a tap on any phone number is phone_tap with the screen it was on: the footer, and the one in the "did not go through" line; el is phone; review_end says ph'),
  mut('page: the phone in the error line is untagged', P, 'or call us at <a href="tel:${CONFIG.PHONE_TEL}" data-track="phone">${CONFIG.PHONE}</a>.`;\nconst tooLongLine', 'or call us at <a href="tel:${CONFIG.PHONE_TEL}">${CONFIG.PHONE}</a>.`;\nconst tooLongLine', 'F14 a tap on any phone number is phone_tap with the screen it was on: the footer, and the one in the "did not go through" line; el is phone; review_end says ph'),
  mut('page: a drag is a tap', P, 'if (tapFilter.up(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.button)) recordTap(event);', 'recordTap(event);', 'F15 each tap is filed under what it landed on and the page part (the badge in the header, a label in a screen it is not on is still the screen it sits in, the footer), untagged is "page"; a drag is not a tap'),
  mut('page: the badge is not tagged', P, ' data-track="badge"', '', 'F15 each tap is filed under what it landed on and the page part (the badge in the header, a label in a screen it is not on is still the screen it sits in, the footer), untagged is "page"; a drag is not a tap'),
  mut('page: the message box is not tagged', P, '<label data-track="msg">', '<label>', 'F15 each tap is filed under what it landed on and the page part (the badge in the header, a label in a screen it is not on is still the screen it sits in, the footer), untagged is "page"; a drag is not a tap'),
  mut('page: the footer is not a page part', P, '<footer data-section="footer">', '<footer>', 'F15 each tap is filed under what it landed on and the page part (the badge in the header, a label in a screen it is not on is still the screen it sits in, the footer), untagged is "page"; a drag is not a tap'),
  mut('page: a key press has no position', P, '    if (clientX === 0 && clientY === 0 && event.detail === 0 && event.target && event.target.getBoundingClientRect) {', '    if (false) {', 'F15b a key press on a face (a click with no position) is a tap at the middle of the button'),
  mut('page: taps are not held at the cap', P, '    if (detail && mayBeSent) track("tap", detail);', '    if (detail) track("tap", detail);', 'F15c 70 taps send 60 tap events; review_end still says 70'),
  mut('page: a touch is a hover', P, '      if (event.pointerType !== "mouse") return;\n', '', 'F16 a mouse resting 0.4 s or more on a tagged thing is one hover (element and ms); less is none; a touch is not a hover; a phone with no hover sends none; review_end counts them'),
  mut('page: a phone with no hover gets hovers', P, '  if (canHover) {\n    const rest', '  if (true) {\n    const rest', 'F16 a mouse resting 0.4 s or more on a tagged thing is one hover (element and ms); less is none; a touch is not a hover; a phone with no hover sends none; review_end counts them'),
  mut('page: hovers are not counted', P, '    const hoverEnded = done => { if (done && visit.hover()) track("hover", done); };', '    const hoverEnded = done => { if (done) track("hover", done); };', 'F16 a mouse resting 0.4 s or more on a tagged thing is one hover (element and ms); less is none; a touch is not a hover; a phone with no hover sends none; review_end counts them'),
  mut('page: a hover in progress is lost when the page is hidden', P, '    flushers.push(() => hoverEnded(rest.flush(now())));\n', '', 'F16b the hover that is still going when the page is hidden is ended and counted first'),
  mut('page: hiding the page does not report the visit', P, '    if (document.visibilityState === "hidden") { visit.visible(false, t); flush(); }', '    if (document.visibilityState === "hidden") { visit.visible(false, t); }', 'F17 each time the page is hidden review_end is sent with the whole visit so far; hidden time is not time on the page; leaving sends the new total only when something changed'),
  mut('page: leaving does not report the visit', P, '  listen(window, "pagehide", () => { visit.visible(false, now()); flush(); });', '  listen(window, "pagehide", () => { visit.visible(false, now()); });', 'F17 each time the page is hidden review_end is sent with the whole visit so far; hidden time is not time on the page; leaving sends the new total only when something changed'),
  mut('page: coming back does not start the clock', P, '    else visit.visible(true, t);', '    else { /* nothing */ }', 'F17 each time the page is hidden review_end is sent with the whole visit so far; hidden time is not time on the page; leaving sends the new total only when something changed'),
  mut('page: a reload is a new visit', P, 'const isNewVisit = !readStore(SESSION_KEY);', 'const isNewVisit = true;', 'F18 a reload in the same tab sends no second review_open and the same session; its review_end is the whole visit (the time before, the face, the screen it came back on)'),
  mut('page: the visit is not stored for a reload', P, '    writeStore(VISIT_KEY, JSON.stringify(visit.export(t)));\n', '', 'F18 a reload in the same tab sends no second review_open and the same session; its review_end is the whole visit (the time before, the face, the screen it came back on)'),
  mut('page: a new tab starts from the last one’s counters', P, 'base: isNewVisit ? null : readStore(VISIT_KEY)', 'base: readStore(VISIT_KEY)', 'F18c a new tab ignores counters left in storage by an earlier tab’s visit'),
  mut('page: a new tab does not get its own id', P, '  const fresh = newSessionId();\n  writeStore(SESSION_KEY, fresh);\n  return fresh;', '  writeStore(SESSION_KEY, "fixed-session");\n  return "fixed-session";', 'F18b a new tab is a new visit: its own session, review_open again, counters from zero'),
  mut('page: the old name for the placement is not read', P, 'const asked = params.get("c") || params.get("src");', 'const asked = params.get("c");', 'F19 the placement is the ?c= of the link (a-z 0-9 _ -, 40 long), ?src= is the old name, c wins, junk is direct, and a reload without it keeps it for the tab'),
  mut('page: src wins over c', P, 'const asked = params.get("c") || params.get("src");', 'const asked = params.get("src") || params.get("c");', 'F19 the placement is the ?c= of the link (a-z 0-9 _ -, 40 long), ?src= is the old name, c wins, junk is direct, and a reload without it keeps it for the tab'),
  mut('page: the placement is not kept for the tab', P, '  return core.cleanSource(readStore(SOURCE_KEY));', '  return "direct";', 'F19 the placement is the ?c= of the link (a-z 0-9 _ -, 40 long), ?src= is the old name, c wins, junk is direct, and a reload without it keeps it for the tab'),
  mut('page: the whole link is sent as the placement', P, '  const fromUrl = asked ? core.cleanSource(asked) : "direct";', '  const fromUrl = asked ? "direct" : "direct";', 'F19 the placement is the ?c= of the link (a-z 0-9 _ -, 40 long), ?src= is the old name, c wins, junk is direct, and a reload without it keeps it for the tab'),
  mut('page: the link’s other tags are sent with each event', P, 'beacon: (url, body) => (navigator.sendBeacon ? navigator.sendBeacon(url, body) : false),', 'beacon: (url, body) => (navigator.sendBeacon ? navigator.sendBeacon(url + location.search, body) : false),', 'F19b the other ?tags on the link are never read, let alone sent'),
  mut('page: the AR page’s session key is used', P, 'const SESSION_KEY = "steakout.review.session";', 'const SESSION_KEY = "steakout.session";', 'F20 the visit lives under its own sessionStorage keys, apart from the AR page’s (steakout.session, steakout.source, steakout.visit)'),
  mut('page: the AR page’s visit key is used', P, 'const VISIT_KEY = "steakout.review.visit";', 'const VISIT_KEY = "steakout.visit";', 'F20 the visit lives under its own sessionStorage keys, apart from the AR page’s (steakout.session, steakout.source, steakout.visit)'),
  mut('page: a browser whose storage throws breaks the page', P, 'const readStore = key => { try { return window.sessionStorage.getItem(key); } catch (e) { return null; } };', 'const readStore = key => window.sessionStorage.getItem(key);', 'F20b a browser whose storage throws (Safari private mode) still opens, rates, sends and reports'),
  mut('page: a browser whose storage throws on writing breaks the page', P, 'const writeStore = (key, value) => { try { window.sessionStorage.setItem(key, value); } catch (e) { /* private mode */ } };', 'const writeStore = (key, value) => { window.sessionStorage.setItem(key, value); };', 'F20b a browser whose storage throws (Safari private mode) still opens, rates, sends and reports'),
  mut('page: there is no stand-in for a beacon', P, '    fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, keepalive: true, mode: "no-cors", credentials: "omit" })\n      .catch(() => {});', '    void 0;', 'F21 a browser that cannot queue a beacon sends the event with one plain request instead (no-cors, keepalive, no credentials)'),
  mut('page: the stand-in for a beacon sends cookies', P, 'keepalive: true, mode: "no-cors", credentials: "omit" })', 'keepalive: true, mode: "no-cors", credentials: "include" })', 'F21 a browser that cannot queue a beacon sends the event with one plain request instead (no-cors, keepalive, no credentials)'),
  mut('page: a page without its rules does not say so', P, 'const collector = core ? core.normalizeCollectorBase(CONFIG.COLLECTOR_URL) : "";', 'const collector = core ? core.normalizeCollectorBase(CONFIG.COLLECTOR_URL) : CONFIG.COLLECTOR_URL;', 'F22 if review-core.js does not load the page still works: it can be rated and the screens change; nothing is reported; and a message is not pretended sent'),
  mut('page: a page without its rules takes a message', P, ': { ok: false, reason: "unavailable" };', ': { ok: true, body: "{}" };', 'F22b …and then a message says it did not go through and the phone to call, rather than "sent"'),
  mut('page: a beacon that throws breaks the page', P, '  try { shaped = send ? send(event, detail) : null; } catch (e) { /* measurement never breaks the page */ }', '  shaped = send ? send(event, detail) : null;', 'F23 a beacon that throws never breaks the page: the screens still change and the taps still work', [{ file: C, from: "      } catch (error) {\n        /* measurement never breaks the experience */\n      }", to: "      } catch (error) {\n        throw error;\n      }" }]),
  mut('page: the owner is not Brian', P, 'OWNER_NAME: "Brian",', 'OWNER_NAME: "Brain",', 'H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian'),
  mut('page: the signature is changed', P, '$("ownerSig").textContent = "— The Steak Out family";', '$("ownerSig").textContent = "- The Steak Out family";', 'F24 the unhappy screen says what the original said, signed by the Steak Out family'),
  mut('page: the first sentence is changed', P, 'title: "That\'s not the Steak Out way.",', 'title: "That is not the Steak Out way.",', 'F24 the unhappy screen says what the original said, signed by the Steak Out family'),
  mut('page: changing the answer is not reported', P, '  emit("answer_changed", { from: rating, scr: visit.current() });\n', '', 'F25 "Change my answer" is answer_changed (from the face, on which screen), then the first screen again, with the footer link hidden'),
  mut('page: changing the answer says the wrong screen', P, 'emit("answer_changed", { from: rating, scr: visit.current() });', 'emit("answer_changed", { from: rating, scr: "rate" });', 'F25 "Change my answer" is answer_changed (from the face, on which screen), then the first screen again, with the footer link hidden'),
  mut('page: a second face does not say the first', P, '  const before = visit.rated(rating);', '  visit.rated(rating);\n  const before = 0;', 'F25b the second tap says which face came before'),
  mut('core: faces may be sent 300 times', C, '    rating_tap: 30,\n', '    rating_tap: 300,\n', 'F26 a thumb that keeps going sends 30 rating_taps and 30 answer_changed at most; review_end still counts the faces'),
  mut('core: changed answers may be sent 300 times', C, '    answer_changed: 30,\n', '    answer_changed: 300,\n', 'F26 a thumb that keeps going sends 30 rating_taps and 30 answer_changed at most; review_end still counts the faces'),
  // ---- G the real Collector
  mut('core: an event does not say its page', C, "        meta: shaped.meta,\n        page: 'review'\n", "        meta: shaped.meta,\n        page: 'ar'\n", 'G3 read back from the real /export in the shape Orbit reads: id, received_at, at, name, source, session, meta, page "review"; names only from Orbit’s list; meta keys only from Orbit’s keys'),
  mut('core: the face is sent as text', C, '      rating: face,', '      rating: String(face),', 'G2 the REAL Worker takes every event (204) and the message (201, readable by this page)'),
  mut('core: the message is sent without its contact', C, '      contact: reach,', "      contact: '',", 'G4 the message read back from the real /feedback/export in the shape Orbit reads, words intact, with the visit and the placement'),
  mut('page: a message is sent on another visit', P, 'core.buildFeedback({ session, source, ...payload, messageId, at: Date.now() })', 'core.buildFeedback({ session: "other-visit-0001", source, ...payload, messageId, at: Date.now() })', 'G5 the visit that sent the message and the message have the same session, so Orbit can open that visit from the message'),
  mut('core: a review visit says it is an AR visit', C, "        page: 'review'\n      });\n      if (utf8Length(body) > MAX_BODY_BYTES) return shaped;", "        page: 'ar'\n      });\n      if (utf8Length(body) > MAX_BODY_BYTES) return shaped;", 'G6 the review visits do not show up in the AR numbers, and no word of the message is in the events or the stats'),
  // ---- H the files
  mut('index: a data-track Orbit does not know', P, 'data-track="google_footer"', 'data-track="google_foot"', 'H1 every data-track and data-section on the page is one Orbit knows, and every one Orbit lists is on the page'),
  mut('index: a face is tagged wrongly', P, 'data-rating="3" data-track="face_3"', 'data-rating="3" data-track="face_9"', 'H1b the faces are tagged one to five, the sections are header, the four screens and footer, and the screens carry the names of the contract'),
  mut('index: a screen is not a page part', P, '<section class="screen" id="sent" data-section="sent"', '<section class="screen" id="sent" data-section="thanks"', 'H1b the faces are tagged one to five, the sections are header, the four screens and footer, and the screens carry the names of the contract'),
  mut('index: a script from another site', P, '<script src="./review-core.js?v=20261008-review1"></script>', '<script src="https://cdn.example.com/x.js"></script>', 'H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback'),
  mut('index: the core has no cache token', P, '<script src="./review-core.js?v=20261008-review1"></script>', '<script src="./review-core.js"></script>', 'H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback'),
  mut('index: the font holds the page back', P, ' media="print" onload="this.media=\'all\'">\n<noscript>', '>\n<noscript>', 'H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback'),
  mut('index: the font has no fallback without scripts', P, '<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap"></noscript>', '', 'H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback'),
  mut('index: a tracker host', P, '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="preconnect" href="https://stats.example.net">', 'H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback'),
  mut('index: a stylesheet import from another site', P, '<style>\n  @font-face {\n    font-family: \'Bebas Neue\';\n    font-style: normal;\n    font-weight: 400;\n    font-display: swap;\n    src: url(\'./fonts/bebas-neue-latin.woff2\')', '<style>\n  @import url("https://fonts.googleapis.com/css2?family=Bebas+Neue");\n  @font-face {\n    font-family: \'Bebas Neue\';\n    font-style: normal;\n    font-weight: 400;\n    font-display: swap;\n    src: url(\'./fonts/bebas-neue-latin.woff2\')', 'H2b the page loads no script, stylesheet, image or frame from anywhere else: no @import, no url() to another site, no other src'),
  mut('index: a font file that is not there', P, "src: url('./fonts/bebas-neue-latin-ext.woff2')", "src: url('./fonts/bebas-neue-ext.woff2')", 'H2c Bebas Neue is served from this site: both files named in the page exist beside it, and they are the AR page’s own files'),
  mut('index: another Collector address is written in', P, 'COLLECTOR_URL: "https://steakout-ar-collector.antsojo.workers.dev",', 'COLLECTOR_URL: "https://steakout-ar-collector.example.workers.dev",', 'H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian'),
  mut('index: the Collector address is emptied', P, 'COLLECTOR_URL: "https://steakout-ar-collector.antsojo.workers.dev",', 'COLLECTOR_URL: "",', 'H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian'),
  mut('index: the page names a second Collector', P, '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="preconnect" href="https://other-collector.example.workers.dev">', 'H2 the scripts are this site’s own, in order (the core, then the page), with a dated cache token; the only outside address is Google’s Open Sans, loaded so it cannot hold the page back (media=print until it arrives) with a noscript fallback'),
  mut('index: another Google link is written in', P, 'GOOGLE_REVIEW_URL: "https://search.google.com/local/writereview?placeid=ChIJ-TdkPLbQxokRgbjEMzNg37Y",', 'GOOGLE_REVIEW_URL: "https://g.page/r/ABC/review",', 'H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian'),
  mut('index: the Google link is emptied', P, 'GOOGLE_REVIEW_URL: "https://search.google.com/local/writereview?placeid=ChIJ-TdkPLbQxokRgbjEMzNg37Y",', 'GOOGLE_REVIEW_URL: "",', 'H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian'),
  mut('index: the old setting name comes back', P, '  COLLECTOR_URL: "https://steakout-ar-collector.antsojo.workers.dev",', '  COLLECTOR_URL: "https://steakout-ar-collector.antsojo.workers.dev",\n  ORBIT_URL: "",', 'H3 the shipping page sends to the live Collector and no other, its Google link is Steak Out Sewell’s write-a-review address, and the owner is Brian'),
  mut('page: the user agent is read', P, 'const nav = window.navigator || {};\n    const display', 'const nav = window.navigator || {};\n    const ua = nav.userAgent;\n    const display', 'H4 nothing is read that could identify a person: not the user agent, the referrer, the language, the time zone, the address of the page, a cookie, or a form value outside the send'),
  mut('page: the referrer is read', P, '    let canHover = false;\n    try { canHover = Boolean(window.matchMedia && window.matchMedia("(hover: hover)").matches); } catch (e) { /* no hover */ }\n    track("review_open"', '    const from = document.referrer;\n    let canHover = false;\n    try { canHover = Boolean(window.matchMedia && window.matchMedia("(hover: hover)").matches); } catch (e) { /* no hover */ }\n    track("review_open"', 'H4 nothing is read that could identify a person: not the user agent, the referrer, the language, the time zone, the address of the page, a cookie, or a form value outside the send'),
  mut('page: a cookie is read', P, 'const startedAt = Date.now();', 'const startedAt = Date.now() + (document.cookie ? 0 : 0);', 'H4 nothing is read that could identify a person: not the user agent, the referrer, the language, the time zone, the address of the page, a cookie, or a form value outside the send'),
  mut('page: the address of the page is read', P, 'const params = new URLSearchParams(location.search);', 'const params = new URLSearchParams(location.search);\n  const here = location.href;', 'H4 nothing is read that could identify a person: not the user agent, the referrer, the language, the time zone, the address of the page, a cookie, or a form value outside the send'),
  mut('page: the time zone is read', P, 'const startedAt = Date.now();', 'const startedAt = Date.now() + (Intl.DateTimeFormat().resolvedOptions().timeZone ? 0 : 0);', 'H4 nothing is read that could identify a person: not the user agent, the referrer, the language, the time zone, the address of the page, a cookie, or a form value outside the send'),
  mut('page: a third storage key', P, 'const VISIT_KEY = "steakout.review.visit";', 'const VISIT_KEY = "steakout.review.visit";\nconst PROFILE_KEY = "steakout.review.profile";', 'H5 the page keeps one count in localStorage (a number) and four sessionStorage keys of its own (three in the page, the message id in the core), nothing else'),
  mut('page: another thing kept on the phone', P, 'window.localStorage.setItem("so-review-visits", String(visits));', 'window.localStorage.setItem("so-review-visits", String(visits));\n    window.localStorage.setItem("so-review-name", $("name").value);', 'H5 the page keeps one count in localStorage (a number) and four sessionStorage keys of its own (three in the page, the message id in the core), nothing else'),
  mut('page: a second place sends a message', P, '    fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, keepalive: true, mode: "no-cors", credentials: "omit" })', '    fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, keepalive: true, mode: "cors", credentials: "omit" })', 'H6 events go to /collect and the message to /feedback and nowhere else; the message is sent from one place, with fetch (so its answer can be read); an event is sent with fetch only as the stand-in for a beacon (no-cors, keepalive)'),
  mut('core: events go to the message door', C, "const url = `${target}/collect`;", "const url = `${target}/feedback`;", 'H6 events go to /collect and the message to /feedback and nowhere else; the message is sent from one place, with fetch (so its answer can be read); an event is sent with fetch only as the stand-in for a beacon (no-cors, keepalive)'),
  mut('index: the look changes (a colour)', P, '--red: #ba202a;', '--red: #ca202a;', 'H7 the four screens look and read as the original did, apart from the approved polish edits: the head, the styles (without the self-hosted font faces and the polish block) and the markup (without the tracking tags and the scripts) hash to the original’s with those edits'),
  mut('index: a word changes', P, '<span class="bar">Tap one</span>', '<span class="bar">Tap a face</span>', 'H7 the four screens look and read as the original did, apart from the approved polish edits: the head, the styles (without the self-hosted font faces and the polish block) and the markup (without the tracking tags and the scripts) hash to the original’s with those edits'),
  mut('index: a sentence in the script changes', P, '"Tell me what happened first."', '"Please say what happened."', 'H7c the words in the script are the original’s: the same sentences are in both, and the three owner notes are the same text'),
  mut('index: an owner note changes', P, "Tell us what happened and we'll make it right.", "Tell us what happened and we will make it right.", 'H7c the words in the script are the original’s: the same sentences are in both, and the three owner notes are the same text'),
  // ---- a message sent again is one message (2026-10-08, after the review)
  mut('core: message_id is never sent', C, "    if (hasId) fields.message_id = messageId;\n", '', E9),
  mut('core: a message_id the Collector would refuse is sent', C, "    if (hasId && (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId))) return { ok: false, reason: 'message_id' };\n", '', E9),
  mut('core: a message_id may have spaces', C, "const MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;", "const MESSAGE_ID_RE = /^[A-Za-z0-9 -]{1,64}$/;", E9),
  mut('core: every try is given a new id', C, "        if (have && have.fp === fp) {", "        if (false) {", E10),
  mut('core: the id is not read back from the tab (a reload loses it)', C, "        const have = current || fromStorage();", "        const have = current;", E10),
  mut('core: spaces round the words make a different message', C, "const { words, who, reach } = typedFields({ message, name, contact });\n    return shortHash", "const { who, reach } = typedFields({ message, name, contact });\n    const words = String(message);\n    return shortHash", E10),
  mut('core: the words are kept in the tab', C, "write(MESSAGE_ID_KEY, id + '_' + fp);", "write(MESSAGE_ID_KEY, id + '_' + fp + '_' + String(fields && fields.message));", E10B),
  mut('core: the id is kept outside the visit’s keys', C, "const MESSAGE_ID_KEY = 'steakout.review.msgid';", "const MESSAGE_ID_KEY = 'steakout.msgid';", E10B),
  mut('core: an edited message keeps its id', C, "        if (have && have.fp === fp) {", "        if (have) {", E11),
  mut('core: the fingerprint ignores the name', C, "JSON.stringify([Number(rating), words, who, reach])", "JSON.stringify([Number(rating), words, reach])", E11),
  mut('core: the fingerprint ignores the face', C, "JSON.stringify([Number(rating), words, who, reach])", "JSON.stringify([words, who, reach])", E11),
  mut('core: a stored message keeps its id in the page', C, "      stored() {\n        current = null;\n", "      stored() {\n", E12),
  mut('core: a stored message keeps its id in the tab', C, "        try { if (typeof write === 'function') write(MESSAGE_ID_KEY, ''); } catch (error) { /* nothing to clear */ }", "", E12),
  mut('core: the id lives in the tab only, not in the page', C, "        current = { id, fp };\n        try { if (typeof write", "        try { if (typeof write", E13),
  mut('core: a storage that throws on read breaks the send', C, "catch (error) { raw = null; }", "catch (error) { throw error; }", E13),
  mut('core: a storage that throws on write breaks the send', C, "catch (error) { /* no storage: the id lives in this page only */ }", "catch (error) { throw error; }", E13),
  mut('core: an id the Collector would refuse is used as made', C, "        if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) id = 'mx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);\n", '', E13B),
  mut('core: junk in the tab is believed', C, "if (parts.length !== 2 || !MESSAGE_ID_RE.test(parts[0]) || !/^[0-9a-z]{1,16}$/.test(parts[1])) return null;", "if (parts.length < 2) return null;", E13C),
  mut('core: nothing in the tab is believed', C, "      return { id: parts[0], fp: parts[1] };", "      return null;", E13D),
  mut('page: the message is sent without an id', P, 'const messageId = connected && messageIds ? messageIds.idFor(payload) : null;', 'const messageId = null;', F7C),
  mut('page: every try is given a new id', P, 'messageIds.idFor(payload)', 'newMessageId()', F7C),
  mut('page: a failure forgets the id', P, '      emit("message_failed", { r: rating, err: out.err });\n', '      if (messageIds) messageIds.stored();\n      emit("message_failed", { r: rating, err: out.err });\n', F7C),
  mut('page: the visit’s id is the message’s id', P, 'messageIds.idFor(payload)', 'session', F7D),
  mut('page: a stored message does not end its id', P, '      if (messageIds) messageIds.stored(); // stored: the next message is a new one\n', '', F7G),
  mut('page: the id of a message is not kept for a reload', P, 'core.createMessageIds({ read: readStore, write: writeStore, makeId: newMessageId })', 'core.createMessageIds({ read: () => null, write: writeStore, makeId: newMessageId })', F7E),
  mut('page: the id is not kept in the page when storage throws', P, 'core.createMessageIds({ read: readStore, write: writeStore, makeId: newMessageId })', 'core.createMessageIds({ read: () => null, write: () => {}, makeId: newMessageId })', F7F),
  mut('page: the words are kept in the tab', P, 'core.createMessageIds({ read: readStore, write: writeStore, makeId: newMessageId })', 'core.createMessageIds({ read: readStore, write: (k, v) => writeStore(k, v + "_" + $("msg").value), makeId: newMessageId })', F7C2),
  mut('core: the id that is sent changes with the time of the try', C, "    if (hasId) fields.message_id = messageId;\n    const body = JSON.stringify(fields);", "    if (hasId) fields.message_id = messageId + String(fields.at);\n    const body = JSON.stringify(fields);", G7),
  // ---- the empty-box line goes at the first letter; the polish block is sizes and tap areas (2026-10-08)
  mut('page: typing does not clear the empty-box line', P, '  if (!emptyAsked) return;\n  emptyAsked = false;\n  $("err").classList.remove("on");\n', '  if (!emptyAsked) return;\n  emptyAsked = false;\n', F10B),
  mut('page: the empty-box line is never marked as such', P, '    emptyAsked = true;\n', '', F10B),
  mut('page: typing clears any line in the box, a failed send’s too', P, '  if (!emptyAsked) return;\n  emptyAsked = false;\n  $("err")', '  emptyAsked = false;\n  $("err")', F10C),
  mut('page: a send forgets that the empty-box line was up', P, '  err.classList.remove("on");\n  emptyAsked = false;\n\n  const payload', '  err.classList.remove("on");\n\n  const payload', F10C),
  mut('index: the polish block sets a colour', P, 'footer a { padding: 13px 0; }', 'footer a { padding: 13px 0; color: #fff; }', H8),
  mut('index: the polish block adds a word', P, 'footer { text-wrap: balance; }', 'footer { text-wrap: balance; }\n  footer::after { content: "!"; }', H8),
  mut('index: the footer links lose their tap area', P, 'footer a { padding: 13px 0; }', 'footer a { padding: 0; }', H8B),
  mut('index: the phone in the failed-send line loses its tap area', P, '.err a { padding: 12px 0; white-space: nowrap; }', '.err a { white-space: nowrap; }', H8B),
  mut('index: the phone on the sent screen loses its tap area', P, '.lead a { padding: 10px 0; white-space: nowrap; }', '.lead a { white-space: nowrap; }', H8B),
  mut('index: “Change my answer” is small again', P, '.back { padding: 13px 8px; margin: 17px auto -5px; }', '.back { padding: 8px 8px; margin: 17px auto 5px; }', H8B),
  mut('index: “Change my answer” grows and moves what is under it', P, '.back { padding: 13px 8px; margin: 17px auto -5px; }', '.back { padding: 13px 8px; margin: 17px auto 5px; }', H8B),
  mut('index: the footer is one line again', P, '  <div>Steak Out · 641 Woodbury Glassboro Rd, Sewell, NJ</div>', '  <p>Steak Out · 641 Woodbury Glassboro Rd, Sewell, NJ</p>', H8C),
  mut('index: the footer breaks anywhere', P, '  footer { text-wrap: balance; }\n', '', H8C),
  mut('index: the footer has no room for the address on a 320px phone', P, '    footer { padding-left: 8px; padding-right: 8px; }', '    footer { padding-left: 30px; padding-right: 30px; }', H8C),
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

module.exports = { openPage, loadText, loadCore };

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
  if (!contractFile) console.log(`  note: the Orbit checkout was not found at ${ORBIT_CONTRACT}; the contract was compared against the copy in this file.`);
  if (!fs.existsSync(path.join(COLLECTOR_ROOT, 'src/index.js'))) console.log(`  note: the Collector checkout was not found at ${COLLECTOR_ROOT}; only the copy of its rules in this file was used.`);
  process.exitCode = failed ? 1 : 0;
})();
