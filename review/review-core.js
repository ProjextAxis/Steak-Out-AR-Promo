/* The pure rules for what the review page tells the Collector.
 *
 * Kept free of the DOM so they can be tested with plain node
 * (review/tools/test-review.js): which events and which keys may leave the
 * phone, how a tap becomes a screen position, which page part it was on, what
 * counts as a tap or a hover, how long each screen was really in front of the
 * person, what the cumulative `review_end` says, and how the message to the
 * owner is built and sent.
 *
 * THE CONTRACT. The event names and their meta keys below are Orbit's
 * ORBIT_REVIEW_EVENTS (libraries/orbit/src/site-events/site-events.types.ts in
 * the Orbit repo), and the screens, page parts and element names are its
 * ORBIT_REVIEW_SCREENS / SECTIONS / ELEMENT_LABELS. They are copied from it, not
 * invented here, and test-review.js checks them against that file whenever the
 * Orbit checkout sits next to this one. Change one side and the test says so.
 *
 * WHAT NEVER LEAVES THE PHONE IN AN EVENT. Anything typed, the user agent, the
 * referrer, the language, the time zone, the address of the page, the ?tags on
 * the link. Every value is rebuilt from an allowlist: a key that is not listed
 * for its event is dropped, a number is clamped, a word is checked against a
 * fixed set. A free-text value cannot get through, because no rule accepts one.
 * What a customer TYPES goes only to the Collector's separate /feedback door
 * (buildFeedback / postFeedback), never as an event.
 *
 * This is a deliberate sibling of preview/tracking-core.js (the AR page's), not
 * a shared module: the AR's rules and tests stay exactly as they were.
 */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SteakoutReviewCore = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  /* ------------------------------------------------------------ vocabulary */

  // The four screens, in the order a visit meets them.
  const SCREENS = Object.freeze(['rate', 'happy', 'owner', 'sent']);
  // The page parts a tap or a hover is counted against (data-section).
  const SECTIONS = Object.freeze(['header', 'rate', 'happy', 'owner', 'sent', 'footer']);
  // What the page tags with data-track. Anything else a tap lands on is "page".
  const ELEMENTS = Object.freeze([
    'face_1', 'face_2', 'face_3', 'face_4', 'face_5',
    'google_main', 'google_footer', 'phone', 'back', 'msg', 'name', 'contact', 'send', 'badge'
  ]);
  const OTHER_ELEMENT = 'page';

  const OS_NAMES = Object.freeze(['ios', 'android', 'other']);
  const GOOGLE_BUTTONS = Object.freeze(['main', 'footer']);
  // Why a message did not go through. Short codes only, never a message.
  const FAIL_CODES = Object.freeze(['http_4xx', 'http_5xx', 'network', 'timeout']);

  // Event name -> the meta keys it may carry. Exactly Orbit's list, nothing added.
  const EVENT_KEYS = Object.freeze({
    review_open: Object.freeze(['w', 'h', 'dpr', 'os', 'hover', 'vn', 'hr', 'wd']),
    tap: Object.freeze(['el', 'sec', 'x', 'y', 'py', 't']),
    hover: Object.freeze(['el', 'ms']),
    screen_shown: Object.freeze(['scr']),
    rating_tap: Object.freeze(['r', 'prev']),
    answer_changed: Object.freeze(['from', 'scr']),
    google_tap: Object.freeze(['r', 'btn']),
    phone_tap: Object.freeze(['scr']),
    message_started: Object.freeze(['r']),
    message_sent: Object.freeze(['r', 'len', 'nm', 'ct']),
    message_failed: Object.freeze(['r', 'err']),
    review_end: Object.freeze([
      's', 'scr', 'ms_rate', 'ms_happy', 'ms_owner', 'ms_sent', 'sd', 'taps', 'hov', 'r', 'tried', 'typed', 'sent', 'g', 'ph'
    ])
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Per tab, client side. The Collector keeps its own, harder cap (400 rows a
  // session); these keep a restless thumb from reaching it. Added up they stay
  // well under 400. The totals shown in review_end (taps, hov, tried) keep
  // counting past them.
  const CAPS = Object.freeze({
    tap: 60,
    hover: 40,
    screen_shown: 60,
    rating_tap: 30,
    answer_changed: 30,
    google_tap: 10,
    phone_tap: 10,
    message_started: 3,
    message_sent: 5,
    message_failed: 10,
    review_end: 40
  });

  const HOVER_MIN_MS = 400; // a pointer has to stay this long to count as a hover
  const TAP_SLOP_PX = 10; // a press that travels further than this was a drag, not a tap
  const CLICK_DEDUPE_MS = 800; // a click this soon after a pointer-up is the same tap

  // The Collector refuses an event body over 2048 bytes and meta over 1536.
  const MAX_META_BYTES = 1400;
  const MAX_BODY_BYTES = 1900;

  // What the Collector's /feedback takes (steak-out-ar-collector/src/index.js).
  const FEEDBACK_MAX_BODY_BYTES = 4096;
  const FEEDBACK_MAX_MESSAGE = 2000;
  const FEEDBACK_MAX_NAME = 80;
  const FEEDBACK_MAX_CONTACT = 120;
  const FEEDBACK_TIMEOUT_MS = 15000;

  const SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
  const SOURCE_RE = /^[a-z0-9_-]{1,40}$/;

  /* --------------------------------------------------------------- cleaning */

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  const round1 = (value) => Math.round(value * 10) / 10;
  const intBetween = (min, max) => (value) => (isNumber(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined);
  const intUpTo = (max) => intBetween(0, max);
  const tenthUpTo = (max) => (value) => (isNumber(value) ? Math.min(max, Math.max(0, round1(value))) : undefined);
  const oneOf = (words) => (value) => (typeof value === 'string' && words.includes(value) ? value : undefined);
  const flag = (value) => (typeof value === 'boolean' ? value : undefined);
  // A yes/no the Collector's reader keeps as a number: 0 or 1. Only a real boolean or 0/1 counts.
  const bit = (value) => (value === true || value === 1 ? 1 : value === false || value === 0 ? 0 : undefined);

  // How each meta key is rebuilt. A key means one thing on every event that
  // carries it, so one rule per key.
  const RULES = Object.freeze({
    w: intUpTo(20000),
    h: intUpTo(20000),
    dpr: tenthUpTo(10),
    os: oneOf(OS_NAMES),
    hover: flag,
    vn: intBetween(1, 99),
    hr: intBetween(0, 23),
    wd: intBetween(0, 6),
    el: oneOf([...ELEMENTS, OTHER_ELEMENT]),
    sec: oneOf(SECTIONS),
    x: tenthUpTo(100),
    y: tenthUpTo(100),
    py: tenthUpTo(100),
    t: intUpTo(DAY_MS),
    ms: intUpTo(DAY_MS),
    scr: oneOf(SCREENS),
    r: intBetween(0, 5),
    prev: intBetween(0, 5),
    from: intBetween(1, 5),
    btn: oneOf(GOOGLE_BUTTONS),
    len: intUpTo(FEEDBACK_MAX_MESSAGE),
    nm: bit,
    ct: bit,
    err: oneOf(FAIL_CODES),
    s: intUpTo(2 * 86400),
    ms_rate: intUpTo(DAY_MS),
    ms_happy: intUpTo(DAY_MS),
    ms_owner: intUpTo(DAY_MS),
    ms_sent: intUpTo(DAY_MS),
    sd: intUpTo(100),
    taps: intUpTo(9999),
    hov: intUpTo(9999),
    tried: intUpTo(99),
    typed: bit,
    sent: bit,
    g: bit,
    ph: bit
  });

  /**
   * The event as it may leave the phone: `{ name, meta }`, or null for a name
   * that is not in the contract. A key that is not listed for the event, or a
   * value its rule does not accept, is simply not there.
   */
  function shapeEvent(name, detail) {
    if (typeof name !== 'string' || !hasOwn(EVENT_KEYS, name)) return null;
    const given = isObject(detail) ? detail : {};
    const meta = {};
    for (const key of EVENT_KEYS[name]) {
      if (!hasOwn(given, key)) continue;
      const value = RULES[key](given[key]);
      if (value !== undefined) meta[key] = value;
    }
    return { name, meta };
  }

  /** The ?c= placement as the Collector will accept it (a-z 0-9 _ -, 40 long), else "direct". The AR's rule, word for word. */
  function cleanSource(raw) {
    const text = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) : '';
    return SOURCE_RE.test(text) ? text : 'direct';
  }

  /**
   * The Collector's BASE address (no /collect on the end), or '' while there is
   * none worth using. https only, no credentials in the address; plain http only
   * for a Collector run on this very machine while testing. Forgiving about what
   * is easy to paste by mistake: a trailing slash, a /collect or /feedback on the
   * end (the AR page's setting ends in /collect), a ?query or #hash.
   */
  function normalizeCollectorBase(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    let url;
    try {
      url = new URL(raw.trim());
    } catch (error) {
      return '';
    }
    if (url.username || url.password) return '';
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return '';
    const path = url.pathname.replace(/\/+$/, '').replace(/\/(collect|feedback)$/, '').replace(/\/+$/, '');
    return url.origin + path;
  }

  const utf8Length = (text) => {
    let bytes = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  };

  /**
   * One function to call for every event: shape it, and hand it to `beacon`
   * when there is somewhere to send it. Returns what was shaped (also when
   * nothing was sent), so the page's local dataLayer can mirror the wire.
   * With no address, `beacon` is never called: nothing leaves the phone.
   *
   * `beacon(url, body)` returns false when the browser could not queue it;
   * `fallback(url, body)` is then tried once.
   */
  function createSender({ base, source, session, beacon, fallback, now }) {
    const target = normalizeCollectorBase(base);
    const cleanedSource = cleanSource(source);
    const sessionOk = typeof session === 'string' && SESSION_RE.test(session);
    return function send(name, detail) {
      const shaped = shapeEvent(name, detail);
      if (!shaped || !target || !sessionOk || typeof beacon !== 'function') return shaped;
      const body = JSON.stringify({
        name: shaped.name,
        source: cleanedSource,
        session,
        at: now(),
        meta: shaped.meta,
        page: 'review'
      });
      if (utf8Length(body) > MAX_BODY_BYTES) return shaped;
      const url = `${target}/collect`;
      try {
        if (beacon(url, body) === false && typeof fallback === 'function') fallback(url, body);
      } catch (error) {
        /* measurement never breaks the experience */
      }
      return shaped;
    };
  }

  /* ------------------------------------------------------ the message itself */

  /**
   * The body of POST {base}/feedback, or why there is none. Only what the
   * customer chose to give is in it: the words, a face, and optionally a name and
   * a phone or email; plus the visit's own session and placement, and
   * `website: ""` (the box no person sees; the Collector throws away a message
   * that has anything in it).
   */
  function buildFeedback({ session, source, rating, message, name, contact, at }) {
    if (typeof session !== 'string' || !SESSION_RE.test(session)) return { ok: false, reason: 'session' };
    const face = Number(rating);
    if (!Number.isInteger(face) || face < 1 || face > 5) return { ok: false, reason: 'rating' };
    const words = typeof message === 'string' ? message.trim() : '';
    if (!words) return { ok: false, reason: 'empty' };
    if (words.length > FEEDBACK_MAX_MESSAGE) return { ok: false, reason: 'too_long' };
    const who = typeof name === 'string' ? name.trim().slice(0, FEEDBACK_MAX_NAME) : '';
    const reach = typeof contact === 'string' ? contact.trim().slice(0, FEEDBACK_MAX_CONTACT) : '';
    const body = JSON.stringify({
      session,
      source: cleanSource(source),
      page: 'review',
      rating: face,
      message: words,
      name: who,
      contact: reach,
      website: '',
      at: isNumber(at) && at >= 0 ? Math.round(at) : Date.now()
    });
    // Longer than the Collector will read (accented letters and emoji take more
    // than one byte each): refused here, so the customer is told to shorten it
    // instead of being sent into a retry that can never work.
    if (utf8Length(body) > FEEDBACK_MAX_BODY_BYTES) return { ok: false, reason: 'too_long' };
    return { ok: true, body, len: words.length, nm: who ? 1 : 0, ct: reach ? 1 : 0 };
  }

  /**
   * Send a built message and say what happened: `{ ok: true }` only when the
   * Collector answered with a 2xx (it answers 201 once the row is stored), else
   * `{ ok: false, err }` with a short code: http_4xx, http_5xx, network or
   * timeout. Never throws. The text of the answer is never read.
   *
   * text/plain on purpose: the browser then needs no preflight, and the
   * Collector reads the JSON whatever the Content-Type says.
   */
  async function postFeedback({ base, body, fetch: doFetch, timeoutMs = FEEDBACK_TIMEOUT_MS, setTimeout: setTimer, clearTimeout: clearTimer, AbortController: Abort }) {
    const target = normalizeCollectorBase(base);
    if (!target || typeof doFetch !== 'function') return { ok: false, err: 'network' };
    const controller = typeof Abort === 'function' ? new Abort() : null;
    let timer;
    // The clock answers first and then cancels the request, so a slow Collector is a
    // timeout whatever the cancelled request does next. (A browser with no way to
    // cancel simply stops waiting.)
    const clock = new Promise((resolve) => {
      timer = setTimer(() => {
        resolve({ ok: false, err: 'timeout' });
        if (controller) {
          try { controller.abort(); } catch (error) { /* already finished */ }
        }
      }, timeoutMs);
    });
    const attempt = (async () => {
      let res;
      try {
        res = await doFetch(`${target}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body,
          credentials: 'omit',
          cache: 'no-store',
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        return { ok: false, err: 'network' };
      }
      if (res && res.ok === true && res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, err: res && res.status >= 500 ? 'http_5xx' : 'http_4xx' };
    })();
    try {
      return await Promise.race([attempt, clock]);
    } finally {
      clearTimer(timer);
    }
  }

  /* ------------------------------------------------------- where a tap fell */

  /** value as a percentage of total, to 0.1, held between 0 and 100. null when there is nothing to measure against. */
  function pct1(value, total) {
    if (!isNumber(value) || !isNumber(total) || total <= 0) return null;
    return round1(Math.min(100, Math.max(0, (value / total) * 100)));
  }

  /**
   * Walk up from where a tap landed to the nearest `data-track` (what it was)
   * and the nearest `data-section` (which part of the page it was in). A tap on
   * nothing tagged, or tagged with a word that is not on the list, is filed under
   * "page". Works on anything with getAttribute and parentElement, so a test needs
   * no browser.
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
        if (key && ELEMENTS.includes(key)) {
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
    return { el: el === null ? OTHER_ELEMENT : el, node: tagged, sec };
  }

  /**
   * A tap, ready to send: what it was, which page part, where on the screen
   * (x, y in % of the viewport) and where on the page (py, % of the whole page
   * height). null when the viewport has no size to measure against.
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

  /**
   * What `review_open` says about the device and the moment: screen size, pixel
   * density, coarse OS, whether it can hover, how many times this phone has
   * opened the page (vn, 1..99, from a counter the phone keeps; absent when it
   * cannot keep one), and the local hour and weekday as plain numbers (no time
   * zone, no date).
   */
  function openDetail({ screenW, screenH, dpr, platform, uaPlatform, maxTouchPoints, hover, visits, date }) {
    return {
      w: screenW,
      h: screenH,
      dpr,
      os: classifyOs({ platform, uaPlatform, maxTouchPoints }),
      hover: Boolean(hover),
      vn: visits,
      hr: date instanceof Date ? date.getHours() : undefined,
      wd: date instanceof Date ? date.getDay() : undefined
    };
  }

  /* ------------------------------------------------------------- the visit */

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
    const givenMs = isObject(given.ms) ? given.ms : {};
    const givenSent = isObject(given.sentCounts) ? given.sentCounts : {};
    const ms = {};
    for (const screen of SCREENS) ms[screen] = intUpTo(2 * DAY_MS)(givenMs[screen]) || 0;
    const sentCounts = {};
    for (const name of Object.keys(CAPS)) sentCounts[name] = intUpTo(9999)(givenSent[name]) || 0;
    return {
      ms,
      sd: int('sd', 100),
      taps: int('taps', 9999),
      hov: int('hov', 9999),
      r: intBetween(0, 5)(given.r) || 0,
      tried: int('tried', 99),
      typed: bit(given.typed) || 0,
      sent: bit(given.sent) || 0,
      g: bit(given.g) || 0,
      ph: bit(given.ph) || 0,
      sentCounts
    };
  }

  /**
   * Everything `review_end` adds up, for one tab's visit. Cumulative: a reload
   * in the same tab hands its totals to the next page load (`base`), so the LAST
   * review_end of a session is always the whole visit.
   *
   * The clock is the caller's, in ms (0 at page load in a browser). Time counts
   * only while the page is visible: a phone in a pocket is not a person reading.
   * `s` is those seconds added up; ms_rate / ms_happy / ms_owner / ms_sent split
   * them by the screen that was showing.
   */
  function createVisit({ base = null, startT = 0, visible = true } = {}) {
    const prior = parseBase(base);
    const ms = { ...prior.ms };
    let screen = 'rate';
    let pageVisible = Boolean(visible);
    let since = pageVisible ? startT : null;
    let deepest = prior.sd;
    let taps = prior.taps;
    let hovers = prior.hov;
    let face = prior.r;
    let tried = prior.tried;
    const flags = { typed: prior.typed, sent: prior.sent, g: prior.g, ph: prior.ph };
    const counts = { ...prior.sentCounts };
    let lastEnd = null;

    const bank = (t) => {
      if (since !== null && t > since) ms[screen] += t - since;
      since = pageVisible ? t : null;
    };
    const total = (t) => {
      const out = { ...ms };
      if (since !== null && t > since) out[screen] += t - since;
      return out;
    };

    const snapshot = (t) => {
      const per = total(t);
      const all = per.rate + per.happy + per.owner + per.sent;
      return {
        s: Math.round(all / 1000),
        scr: screen,
        ms_rate: Math.round(per.rate),
        ms_happy: Math.round(per.happy),
        ms_owner: Math.round(per.owner),
        ms_sent: Math.round(per.sent),
        sd: deepest,
        taps,
        hov: hovers,
        r: face,
        tried,
        typed: flags.typed,
        sent: flags.sent,
        g: flags.g,
        ph: flags.ph
      };
    };

    return {
      /** The page became visible or hidden. */
      visible(value, t) {
        const next = Boolean(value);
        if (next === pageVisible) return;
        bank(t);
        pageVisible = next;
        since = next ? t : null;
      },
      /** A screen came up. Time so far is filed against the one that was showing. */
      screen(name, t) {
        if (!SCREENS.includes(name)) return;
        bank(t);
        screen = name;
      },
      current() {
        return screen;
      },
      /** Deepest scroll so far, 0..100. */
      scroll(percent) {
        if (isNumber(percent) && percent > deepest) deepest = Math.min(100, Math.round(percent));
      },
      /** A face was tapped. Returns the face tapped before it in this visit (0 if none). */
      rated(value) {
        const previous = face;
        face = intBetween(1, 5)(value);
        tried = Math.min(99, tried + 1);
        return previous;
      },
      lastRating() {
        return face;
      },
      /** Something happened that review_end reports as a yes/no: typed | sent | g | ph. */
      mark(name) {
        if (hasOwn(flags, name)) flags[name] = 1;
      },
      /** A tap happened. True while it is still under the per-tab cap and may be sent. */
      tap() {
        taps = Math.min(9999, taps + 1);
        return this.allow('tap');
      },
      /** A hover ended. True while it may still be sent. */
      hover() {
        hovers = Math.min(9999, hovers + 1);
        return this.allow('hover');
      },
      /** May another event of this kind be sent? Counts it when it may. */
      allow(name) {
        if (!hasOwn(CAPS, name)) return true;
        if ((counts[name] || 0) >= CAPS[name]) return false;
        counts[name] = (counts[name] || 0) + 1;
        return true;
      },
      snapshot,
      /** The review_end to send now, or null if there is nothing new since the last one (or too many were sent). */
      flushEnd(t) {
        if ((counts.review_end || 0) >= CAPS.review_end) return null;
        const snap = snapshot(t);
        const signature = JSON.stringify(snap);
        if (signature === lastEnd) return null;
        lastEnd = signature;
        counts.review_end = (counts.review_end || 0) + 1;
        return snap;
      },
      /** What the next page load of this tab starts from. */
      export(t) {
        const per = total(t);
        return {
          ms: Object.fromEntries(SCREENS.map((name) => [name, Math.round(per[name])])),
          sd: deepest,
          taps,
          hov: hovers,
          r: face,
          tried,
          typed: flags.typed,
          sent: flags.sent,
          g: flags.g,
          ph: flags.ph,
          sentCounts: { ...counts }
        };
      }
    };
  }

  return Object.freeze({
    SCREENS,
    SECTIONS,
    ELEMENTS,
    EVENT_KEYS,
    CAPS,
    HOVER_MIN_MS,
    TAP_SLOP_PX,
    CLICK_DEDUPE_MS,
    MAX_META_BYTES,
    MAX_BODY_BYTES,
    FEEDBACK_MAX_BODY_BYTES,
    FEEDBACK_MAX_MESSAGE,
    FEEDBACK_TIMEOUT_MS,
    shapeEvent,
    cleanSource,
    normalizeCollectorBase,
    createSender,
    buildFeedback,
    postFeedback,
    pct1,
    resolveTarget,
    tapDetail,
    createTapFilter,
    createHoverRest,
    classifyOs,
    openDetail,
    parseBase,
    createVisit
  });
});
