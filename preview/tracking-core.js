/* The pure rules for what this page tells the Collector about a visit.
 *
 * Kept free of the DOM so they can be tested with plain node
 * (preview/tools/test-tracking.js): which events and which keys may leave the
 * phone, how a tap is turned into a screen position, which page part it was
 * on, what counts as a tap or a hover, how long each part of the page was
 * really on screen, and what the cumulative `visit_end` says.
 *
 * THE CONTRACT. The event names and their meta keys below are Orbit's
 * ORBIT_SITE_EVENTS (libraries/orbit/src/site-events/site-events.types.ts in
 * the Orbit repo). Names and keys are copied from it, not invented here, and
 * test-tracking.js checks them against that file whenever the Orbit checkout
 * sits next to this one. Change one side and the test says so.
 *
 * WHAT NEVER LEAVES THE PHONE. Camera frames, poses, QR text, the user agent,
 * anything typed, anything personal. Every value is rebuilt from an allowlist:
 * a key that is not listed for its event is dropped, a number is clamped, a
 * word is checked against a fixed set. Even a bug further up cannot send a
 * stray field, because there is no path that forwards one.
 */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SteakoutTrackingCore = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  /* ------------------------------------------------------------ vocabulary */

  // The page parts a tap, a hover or a stay is counted against (data-section).
  const SECTIONS = Object.freeze(['header', 'hero', 'viewer', 'cta', 'order_bar', 'guide', 'ar']);

  const OS_NAMES = Object.freeze(['ios', 'android', 'other']);
  const LEAVE_TARGETS = Object.freeze(['order', 'website', 'signin', 'other']);
  const ORDER_FROM = Object.freeze(['ar', 'landing']);

  // Event name -> the meta keys it may carry. `t` (ms since the page loaded) is
  // added to every event on top of these.
  const EVENT_KEYS = Object.freeze({
    // the visit
    scan: Object.freeze(['w', 'h', 'dpr', 'os', 'hover']),
    tap: Object.freeze(['el', 'sec', 'x', 'y', 'py', 't']),
    hover: Object.freeze(['el', 'ms']),
    viewer_spin: Object.freeze(['ms', 'n']),
    leave: Object.freeze(['to']),
    visit_end: Object.freeze(['s', 'v', 'sec', 'sd', 'taps', 'hov', 'vw', 'ar']),
    // the AR
    ar_guide_opened: Object.freeze([]),
    guide_cancel: Object.freeze([]),
    ar_launch_tapped: Object.freeze([]),
    motion_blocked: Object.freeze([]),
    browser_ar_opened: Object.freeze([]),
    camera_live: Object.freeze(['ms', 'run']),
    camera_error: Object.freeze(['err']),
    lock: Object.freeze(['ms', 'run']),
    lost: Object.freeze(['run', 'n']),
    refound: Object.freeze(['run', 'ms']),
    order_shown: Object.freeze([]),
    order_tapped: Object.freeze(['from']),
    ar_closed: Object.freeze(['run', 'ms', 'locked', 'lost']),
    browser_ar_closed: Object.freeze([]),
    ar_mode_changed: Object.freeze([])
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Per session, client side. The Collector keeps its own, harder cap (400 rows
  // a session); these keep a restless thumb from reaching it.
  const CAPS = Object.freeze({ taps: 60, hovers: 40, spins: 30, ends: 40 });

  const HOVER_MIN_MS = 400; // a pointer has to stay this long to count as a hover
  const SPIN_IDLE_MS = 1500; // the model has been left alone this long: the turn is over
  const TAP_SLOP_PX = 10; // a press that travels further than this was a drag, not a tap
  const CLICK_DEDUPE_MS = 800; // a click this soon after a pointer-up is the same tap

  // The Collector refuses a body over 2048 bytes and meta over 1536. Stay under.
  const MAX_META_BYTES = 1400;
  const MAX_BODY_BYTES = 1900;

  const SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
  const SOURCE_RE = /^[a-z0-9_-]{1,40}$/;
  const TOKEN_RE = /^[a-z0-9_]{1,32}$/;
  const ERR_RE = /^[a-z0-9_]{1,24}$/;

  /* --------------------------------------------------------------- cleaning */

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  const round1 = (value) => Math.round(value * 10) / 10;
  const intUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, Math.round(value))) : undefined);
  const tenthUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, round1(value))) : undefined);
  const oneOf = (words) => (value) => (typeof value === 'string' && words.includes(value) ? value : undefined);
  const matching = (pattern) => (value) => (typeof value === 'string' && pattern.test(value) ? value : undefined);
  const flag = (value) => (typeof value === 'boolean' ? value : undefined);

  // How each meta key is rebuilt. `sec` is a word on a tap and a table on a
  // visit_end; shapeEvent handles the table.
  const RULES = Object.freeze({
    w: intUpTo(20000),
    h: intUpTo(20000),
    dpr: tenthUpTo(10),
    os: oneOf(OS_NAMES),
    hover: flag,
    el: matching(TOKEN_RE),
    sec: oneOf(SECTIONS),
    x: tenthUpTo(100),
    y: tenthUpTo(100),
    py: tenthUpTo(100),
    t: intUpTo(DAY_MS),
    ms: intUpTo(DAY_MS),
    n: intUpTo(9999),
    to: oneOf(LEAVE_TARGETS),
    s: intUpTo(2 * 86400),
    v: intUpTo(2 * 86400),
    sd: intUpTo(100),
    taps: intUpTo(9999),
    hov: intUpTo(9999),
    vw: intUpTo(DAY_MS),
    ar: intUpTo(DAY_MS),
    run: intUpTo(999),
    from: oneOf(ORDER_FROM),
    err: matching(ERR_RE),
    locked: intUpTo(DAY_MS),
    lost: intUpTo(9999)
  });

  /** {section: ms} with only known sections and whole, positive milliseconds. */
  function cleanSectionTable(value) {
    if (!isObject(value)) return undefined;
    const out = {};
    const clamp = intUpTo(DAY_MS);
    for (const section of SECTIONS) {
      if (!hasOwn(value, section)) continue;
      const ms = clamp(value[section]);
      if (ms) out[section] = ms;
    }
    return out;
  }

  /**
   * The event as it may leave the phone: `{ name, meta }`, or null for a name
   * that is not in the contract. `ctx.t` is ms since the page loaded.
   */
  function shapeEvent(name, detail, ctx = {}) {
    if (typeof name !== 'string' || !hasOwn(EVENT_KEYS, name)) return null;
    const given = isObject(detail) ? detail : {};
    let meta = {};

    for (const key of EVENT_KEYS[name]) {
      if (!hasOwn(given, key)) continue;
      const value = name === 'visit_end' && key === 'sec'
        ? cleanSectionTable(given.sec)
        : RULES[key](given[key]);
      if (value !== undefined) meta[key] = value;
    }

    // Every event says when, in ms since the page loaded. A tap brings its own
    // (the moment of the touch); everything else is stamped as it is sent.
    const t = RULES.t(name === 'tap' && isNumber(given.t) ? given.t : ctx.t);
    if (t !== undefined) meta.t = t;

    if (JSON.stringify(meta).length > MAX_META_BYTES) {
      delete meta.sec;
      if (JSON.stringify(meta).length > MAX_META_BYTES) meta = t !== undefined ? { t } : {};
    }
    return { name, meta };
  }

  /** The ?c= placement as the Collector will accept it (a-z 0-9 _ -, 40 long), else "direct". */
  function cleanSource(raw) {
    const text = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) : '';
    return SOURCE_RE.test(text) ? text : 'direct';
  }

  /**
   * The Collector's address, or '' while there is none worth using. https only,
   * no credentials in the address; plain http only for a Collector run on this
   * very machine while testing.
   */
  function normalizeCollectorUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    let url;
    try {
      url = new URL(raw.trim());
    } catch (error) {
      return '';
    }
    if (url.username || url.password) return '';
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.href;
    return '';
  }

  /**
   * One function to call for every event: shape it, and hand it to `beacon`
   * when there is somewhere to send it. Returns what was shaped (also when
   * nothing was sent), so the page's local dataLayer can mirror the wire.
   * With no address, `beacon` is never called: nothing leaves the phone.
   */
  function createSender({ url, source, session, beacon, now, since }) {
    const target = normalizeCollectorUrl(url);
    const cleanedSource = cleanSource(source);
    const sessionOk = typeof session === 'string' && SESSION_RE.test(session);
    return function send(name, detail) {
      const shaped = shapeEvent(name, detail, { t: typeof since === 'function' ? since() : undefined });
      if (!shaped || !target || !sessionOk || typeof beacon !== 'function') return shaped;
      const body = JSON.stringify({
        name: shaped.name,
        source: cleanedSource,
        session,
        at: now(),
        meta: shaped.meta
      });
      if (body.length > MAX_BODY_BYTES) return shaped;
      try {
        beacon(target, body);
      } catch (error) {
        /* measurement never breaks the experience */
      }
      return shaped;
    };
  }

  /* ------------------------------------------------------- where a tap fell */

  /** value as a percentage of total, to 0.1, held between 0 and 100. null when there is nothing to measure against. */
  function pct1(value, total) {
    if (!isNumber(value) || !isNumber(total) || total <= 0) return null;
    return round1(Math.min(100, Math.max(0, (value / total) * 100)));
  }

  /**
   * Walk up from where a tap landed to the nearest `data-track` (what it was)
   * and the nearest `data-section` (which part of the page it was in). A tap
   * on nothing tagged is filed under "page". Works on anything with
   * getAttribute and parentElement, so a test needs no browser.
   */
  function resolveTarget(node) {
    let el = null;
    let tagged = null;
    let sec = null;
    let secSeen = false;
    for (let n = node, depth = 0; n && depth < 60; n = n.parentElement, depth++) {
      if (typeof n.getAttribute !== 'function') continue;
      if (el === null) {
        const key = n.getAttribute('data-track');
        if (key && TOKEN_RE.test(key)) {
          el = key;
          tagged = n;
        }
      }
      if (!secSeen) {
        const name = n.getAttribute('data-section');
        if (name) {
          secSeen = true;
          sec = SECTIONS.includes(name) ? name : null;
        }
      }
      if (el !== null && secSeen) break;
    }
    return { el: el === null ? 'page' : el, node: tagged, sec };
  }

  /** The nearest <a href> at or above a node, or null. */
  function findAnchor(node) {
    for (let n = node, depth = 0; n && depth < 60; n = n.parentElement, depth++) {
      if (typeof n.getAttribute === 'function' && String(n.tagName || '').toUpperCase() === 'A' && n.getAttribute('href')) {
        return n;
      }
    }
    return null;
  }

  /**
   * A tap, ready to send: what it was, which page part, where on the screen
   * (x, y in % of the viewport) and where on the page (py, % of the whole
   * page height). null when the viewport has no size to measure against.
   */
  function tapDetail({ target, clientX, clientY, viewW, viewH, scrollY, pageH, t }) {
    const x = pct1(clientX, viewW);
    const y = pct1(clientY, viewH);
    if (x === null || y === null) return null;
    const hit = resolveTarget(target);
    return {
      el: hit.el,
      sec: hit.sec,
      x,
      y,
      py: pct1(clientY + (isNumber(scrollY) ? scrollY : 0), Math.max(isNumber(pageH) ? pageH : 0, viewH)),
      t
    };
  }

  /** A tap reported by the AR frame (it cannot see our page, we cannot see its). Always filed under "ar". */
  function frameTapDetail(raw, t) {
    if (!isObject(raw)) return null;
    const el = matching(TOKEN_RE)(raw.el);
    const x = tenthUpTo(100)(raw.x);
    const y = tenthUpTo(100)(raw.y);
    if (el === undefined || x === undefined || y === undefined) return null;
    return { el, sec: 'ar', x, y, t };
  }

  /* ----------------------------------------------- what counts as a tap/hover */

  /**
   * Taps arrive twice: pointerup, then click. pointerup is the one that is
   * always there on a phone; click is the one a keyboard or a screen reader
   * produces. So: count the pointerup (if the finger stayed put), and count a
   * click only when no pointer was just involved. A drag is not a tap, and the
   * click some browsers still send at the end of one is not either.
   */
  function createTapFilter({ slop = TAP_SLOP_PX, windowMs = CLICK_DEDUPE_MS } = {}) {
    const downs = new Map();
    let lastUpAt = -Infinity;
    return {
      down(id, x, y, time) {
        if (downs.size > 16) downs.clear();
        downs.set(id, { x, y, time });
      },
      cancel(id) {
        downs.delete(id);
      },
      up(id, x, y, time, button) {
        const down = downs.get(id);
        downs.delete(id);
        lastUpAt = time;
        if (!down) return false;
        if (typeof button === 'number' && button !== 0) return false;
        return Math.hypot(x - down.x, y - down.y) <= slop;
      },
      click(time) {
        return time - lastUpAt > windowMs;
      }
    };
  }

  /**
   * A mouse resting on something tagged. `move(key, el, t)` says where the
   * pointer is now (key null = over nothing tagged) and returns the rest that
   * just ended, `{ el, ms }`, if it lasted long enough. One rest, one answer.
   */
  function createHoverRest({ minMs = HOVER_MIN_MS } = {}) {
    let current = null;
    const end = (t) => {
      if (!current) return null;
      const rest = { el: current.el, ms: Math.round(t - current.since) };
      current = null;
      return rest.ms >= minMs ? rest : null;
    };
    return {
      move(key, el, t) {
        if (current && key !== null && current.key === key) return null;
        const done = end(t);
        if (key !== null) current = { key, el, since: t };
        return done;
      },
      flush(t) {
        return end(t);
      }
    };
  }

  /** The 3D model turned by hand: many camera-change events become one `{ ms, n }`. */
  function createSpinBurst() {
    let burst = null;
    return {
      event(t) {
        if (!burst) burst = { first: t, last: t, n: 0 };
        burst.last = t;
        burst.n += 1;
      },
      active() {
        return burst !== null;
      },
      finish() {
        if (!burst) return null;
        const out = { ms: Math.round(burst.last - burst.first), n: Math.min(burst.n, 9999) };
        burst = null;
        return out;
      }
    };
  }

  /** Where a tap on a link takes the diner: order | website | signin | other, or null when it does not leave this site. */
  function classifyLeave({ href, pageHref, track, isOrderLink }) {
    let to;
    let here;
    try {
      to = new URL(href, pageHref);
      here = new URL(pageHref);
    } catch (error) {
      return null;
    }
    if (to.protocol !== 'http:' && to.protocol !== 'https:') return null;
    if (to.origin === here.origin) return null;
    const host = to.hostname.toLowerCase();
    if (isOrderLink || host === 'toasttab.com' || host.endsWith('.toasttab.com')) return 'order';
    if (track === 'sign_in') return 'signin';
    if (host === 'mysteakout.com' || host.endsWith('.mysteakout.com')) return 'website';
    return 'other';
  }

  /** ios | android | other, from the platform hints only. The user agent is never read, never sent. */
  function classifyOs({ platform, uaPlatform, maxTouchPoints }) {
    const hint = `${uaPlatform || ''} ${platform || ''}`.toLowerCase();
    const touch = isNumber(maxTouchPoints) ? maxTouchPoints : 0;
    if (/iphone|ipad|ipod|\bios\b/.test(hint)) return 'ios';
    // iPadOS reports itself as a Mac, with a touch screen no Mac has.
    if (/mac/.test(hint) && touch > 1) return 'ios';
    if (/android/.test(hint)) return 'android';
    if (/linux/.test(hint) && touch > 0) return 'android';
    return 'other';
  }

  /** What `scan` says about the device: screen size, pixel density, coarse OS, whether it can hover. */
  function deviceDetail({ screenW, screenH, dpr, platform, uaPlatform, maxTouchPoints, hover }) {
    return {
      w: screenW,
      h: screenH,
      dpr,
      os: classifyOs({ platform, uaPlatform, maxTouchPoints }),
      hover: Boolean(hover)
    };
  }

  /* ------------------------------------------------------------- time on page */

  /**
   * How long each page part was really on screen: only while the page itself
   * is visible, and (for the page parts under it) not while the AR covers
   * them. Times are ms on one clock, passed in by the caller.
   */
  function createStay({ visible = true } = {}) {
    const done = {};
    const on = new Set();
    const since = {};
    let pageVisible = visible;
    let covered = false;

    const counting = (section) => pageVisible && on.has(section) && (section === 'ar' || !covered);
    const sync = (t) => {
      for (const section of SECTIONS) {
        const want = counting(section);
        if (want && since[section] === undefined) {
          since[section] = t;
        } else if (!want && since[section] !== undefined) {
          done[section] = (done[section] || 0) + (t - since[section]);
          delete since[section];
        }
      }
    };

    return {
      setVisible(value, t) {
        pageVisible = Boolean(value);
        sync(t);
      },
      setInView(section, value, t) {
        if (!SECTIONS.includes(section)) return;
        if (value) on.add(section);
        else on.delete(section);
        sync(t);
      },
      setCovered(value, t) {
        covered = Boolean(value);
        sync(t);
      },
      load(table) {
        const clean = cleanSectionTable(table) || {};
        for (const section of Object.keys(clean)) done[section] = (done[section] || 0) + clean[section];
      },
      totals(t) {
        const out = {};
        for (const section of SECTIONS) {
          const ms = (done[section] || 0) + (since[section] !== undefined ? t - since[section] : 0);
          if (ms > 0) out[section] = Math.round(ms);
        }
        return out;
      }
    };
  }

  /** What an earlier page load of this same tab left behind, or all zeros. */
  function parseBase(text) {
    let raw = text;
    if (typeof text === 'string') {
      try {
        raw = JSON.parse(text);
      } catch (error) {
        raw = null;
      }
    }
    const given = isObject(raw) ? raw : {};
    const int = (key, max) => intUpTo(max)(given[key]) || 0;
    return {
      s: int('s', 2 * DAY_MS),
      v: int('v', 2 * DAY_MS),
      sec: cleanSectionTable(given.sec) || {},
      sd: int('sd', 100),
      taps: int('taps', 9999),
      hov: int('hov', 9999),
      vw: int('vw', DAY_MS),
      tapsSent: int('tapsSent', 9999),
      hovSent: int('hovSent', 9999),
      spinSent: int('spinSent', 9999),
      endSent: int('endSent', 9999)
    };
  }

  /**
   * Everything `visit_end` adds up, for one tab's visit. Cumulative: a reload
   * in the same tab hands its totals to the next page load (`base`), so the
   * LAST visit_end of a session is always the whole visit.
   *
   * `startT` is when this page load began, on the caller's clock (0 in a
   * browser, where the clock starts at navigation). Every method that takes a
   * time takes it on that clock.
   */
  function createVisit({ base = null, startT = 0, visible = true } = {}) {
    const prior = parseBase(base);
    const stay = createStay({ visible });
    stay.load(prior.sec);

    let pageVisible = Boolean(visible);
    let visibleMs = prior.v;
    let visibleSince = pageVisible ? startT : null;
    let deepest = prior.sd;
    let taps = prior.taps;
    let hovers = prior.hov;
    let viewerMs = prior.vw;
    const sent = { taps: prior.tapsSent, hovers: prior.hovSent, spins: prior.spinSent, ends: prior.endSent };
    let lastEnd = null;

    const snapshot = (t) => {
      const sec = stay.totals(t);
      return {
        s: Math.round((prior.s + (t - startT)) / 1000),
        v: Math.round((visibleMs + (pageVisible ? t - visibleSince : 0)) / 1000),
        sec,
        sd: deepest,
        taps,
        hov: hovers,
        vw: Math.round(viewerMs),
        ar: sec.ar || 0
      };
    };

    return {
      /** The page became visible or hidden. */
      visible(value, t) {
        const next = Boolean(value);
        if (next === pageVisible) return;
        if (pageVisible) visibleMs += t - visibleSince;
        pageVisible = next;
        visibleSince = next ? t : null;
        stay.setVisible(next, t);
      },
      /** A data-section came into or went out of view. */
      inView(section, value, t) {
        stay.setInView(section, value, t);
      },
      /** The AR now covers the page (or stopped). While it does, the page parts under it do not count. */
      covered(value, t) {
        stay.setCovered(value, t);
      },
      /** Deepest scroll so far, 0..100. */
      scroll(percent) {
        if (isNumber(percent) && percent > deepest) deepest = Math.min(100, Math.round(percent));
      },
      /** A tap happened. True while it is still under the per-session cap and may be sent. */
      tap() {
        taps += 1;
        if (sent.taps >= CAPS.taps) return false;
        sent.taps += 1;
        return true;
      },
      /** A hover ended. True while it may still be sent. */
      hover() {
        hovers += 1;
        if (sent.hovers >= CAPS.hovers) return false;
        sent.hovers += 1;
        return true;
      },
      /** The model was turned for `ms`. True while it may still be sent. */
      spin(ms) {
        viewerMs += isNumber(ms) && ms > 0 ? ms : 0;
        if (sent.spins >= CAPS.spins) return false;
        sent.spins += 1;
        return true;
      },
      snapshot,
      /** The visit_end to send now, or null if there is nothing new since the last one (or too many were sent). */
      flushEnd(t) {
        if (sent.ends >= CAPS.ends) return null;
        const snap = snapshot(t);
        const { s, ...rest } = snap;
        const signature = JSON.stringify(rest);
        if (signature === lastEnd) return null;
        lastEnd = signature;
        sent.ends += 1;
        return snap;
      },
      /** What the next page load of this tab starts from. */
      export(t) {
        const snap = snapshot(t);
        return {
          s: Math.round(prior.s + (t - startT)),
          v: Math.round(visibleMs + (pageVisible ? t - visibleSince : 0)),
          sec: snap.sec,
          sd: deepest,
          taps,
          hov: hovers,
          vw: Math.round(viewerMs),
          tapsSent: sent.taps,
          hovSent: sent.hovers,
          spinSent: sent.spins,
          endSent: sent.ends
        };
      }
    };
  }

  return Object.freeze({
    SECTIONS,
    EVENT_KEYS,
    CAPS,
    HOVER_MIN_MS,
    SPIN_IDLE_MS,
    TAP_SLOP_PX,
    CLICK_DEDUPE_MS,
    MAX_META_BYTES,
    MAX_BODY_BYTES,
    shapeEvent,
    cleanSource,
    normalizeCollectorUrl,
    createSender,
    pct1,
    resolveTarget,
    findAnchor,
    tapDetail,
    frameTapDetail,
    createTapFilter,
    createHoverRest,
    createSpinBurst,
    classifyLeave,
    classifyOs,
    deviceDetail,
    createStay,
    parseBase,
    createVisit
  });
});
