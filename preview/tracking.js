(() => {
  /* ------------------------------------------------------------------
   * What the diner does on the landing page, watched and handed to track().
   *
   * app.js owns the visit (session, source) and the one function that sends an
   * event; this file only WATCHES and calls track(name, detail). It adds, on
   * top of the AR events app.js already reports:
   *
   *   tap          where a finger or a click landed (x, y as % of the screen,
   *                py as % of the whole page), and what it landed on
   *   hover        a mouse resting on something for 0.4 s or more (desktop only)
   *   viewer_spin  the 3D cheesesteak turned or zoomed by hand
   *   leave        a tap on a link that goes somewhere else
   *   visit_end    the whole visit added up, re-sent each time the page is
   *                hidden: seconds on page, seconds visible, time each page
   *                part was on screen, deepest scroll, taps, hovers, time with
   *                the model in hand, time in the AR
   *
   * The rules (what counts as a tap, which keys may be sent, the caps) are in
   * tracking-core.js, where a test can reach them. This file is the part that
   * needs a browser.
   *
   * Never sent: camera frames, poses, QR text, the user agent, anything typed,
   * anything personal. A tap is a position and a tag name, nothing about the
   * person who made it.
   *
   * Everything here runs inside try/catch. Measuring must never break the meal.
   *
   * ONE storage key, `steakout.visit`, in sessionStorage like the other two:
   * it dies with the tab and holds only counters. It exists so that a reload in
   * the same tab (the AR's "try again" does one) carries the visit on instead
   * of starting a second, smaller one, and so the caps hold for the session
   * rather than for one page load.
   * ------------------------------------------------------------------ */
  const core = window.SteakoutTrackingCore;
  if (!core) return;

  const VISIT_KEY = 'steakout.visit';

  const readStore = (key) => {
    try { return window.sessionStorage.getItem(key); } catch (error) { return null; }
  };
  const writeStore = (key, value) => {
    try { window.sessionStorage.setItem(key, value); } catch (error) { /* private mode */ }
  };

  const loadedAt = Date.now();
  // ms since the page loaded: performance.now() counts from navigation start.
  const now = () => (window.performance && typeof window.performance.now === 'function'
    ? window.performance.now()
    : Date.now() - loadedAt);

  const safely = (fn) => (...args) => {
    try { return fn(...args); } catch (error) { /* tracking never breaks the page */ return undefined; }
  };

  const canHover = () => {
    try { return Boolean(window.matchMedia && window.matchMedia('(hover: hover)').matches); } catch (error) { return false; }
  };

  /* What `scan` says about the device. Screen size, pixel density, a coarse OS
     from the platform hints, whether a mouse can hover. Never the user agent. */
  const deviceDetail = () => {
    const nav = window.navigator || {};
    const screen = window.screen || {};
    return core.deviceDetail({
      screenW: screen.width,
      screenH: screen.height,
      dpr: window.devicePixelRatio,
      platform: nav.platform,
      uaPlatform: nav.userAgentData && nav.userAgentData.platform,
      maxTouchPoints: nav.maxTouchPoints,
      hover: canHover()
    });
  };

  let visit = null;
  let track = null;
  // Things to finish before a visit_end is written (a hover or a turn in progress).
  const flushers = [];

  const emit = (name, detail) => {
    if (track) track(name, detail);
  };

  const start = (options) => {
    if (visit || !options || typeof options.track !== 'function') return;
    track = options.track;
    visit = core.createVisit({
      base: readStore(VISIT_KEY),
      startT: 0,
      visible: document.visibilityState !== 'hidden'
    });
    safely(watch)();
  };

  /* A tap from inside the AR frame. The frame is another document, so its taps
     cannot be seen from here; marker.js reports the ones on tagged buttons. */
  const frameTap = safely((raw) => {
    if (!visit) return;
    const detail = core.frameTapDetail(raw, Math.round(now()));
    if (detail && visit.tap()) emit('tap', detail);
  });

  /* The AR layer opened or closed. While it is open it covers the landing page,
     so only the AR is "on screen". */
  const arState = safely((open) => {
    if (!visit) return;
    const t = now();
    visit.covered(Boolean(open), t);
    visit.inView('ar', Boolean(open), t);
  });

  function watch() {
    const tapFilter = core.createTapFilter();

    /* ----- taps ------------------------------------------------------- */
    const recordTap = (event) => {
      let { clientX, clientY } = event;
      // A key press on a button is a click with no position. Use the button's middle.
      if (clientX === 0 && clientY === 0 && event.detail === 0 && event.target && event.target.getBoundingClientRect) {
        const rect = event.target.getBoundingClientRect();
        clientX = rect.left + rect.width / 2;
        clientY = rect.top + rect.height / 2;
      }
      const detail = core.tapDetail({
        target: event.target,
        clientX,
        clientY,
        viewW: window.innerWidth,
        viewH: window.innerHeight,
        scrollY: window.scrollY || window.pageYOffset || 0,
        pageH: document.documentElement.scrollHeight,
        t: Math.round(event.timeStamp || now())
      });
      const mayBeSent = visit.tap();
      if (detail && mayBeSent) emit('tap', detail);
    };

    const listen = (target, type, handler, options) => {
      target.addEventListener(type, safely(handler), options);
    };

    listen(document, 'pointerdown', (event) => {
      if (event.isPrimary) tapFilter.down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    }, { capture: true, passive: true });

    listen(document, 'pointercancel', (event) => {
      tapFilter.cancel(event.pointerId);
    }, { capture: true, passive: true });

    listen(document, 'pointerup', (event) => {
      if (!event.isPrimary || !event.isTrusted) return;
      if (tapFilter.up(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.button)) recordTap(event);
    }, { capture: true, passive: true });

    listen(document, 'click', (event) => {
      if (!event.isTrusted) return;

      // A tap on a link that leaves this site. The page is about to go, so this
      // is sent now; sendBeacon outlives the document.
      const anchor = core.findAnchor(event.target);
      if (anchor) {
        const to = core.classifyLeave({
          href: anchor.getAttribute('href'),
          pageHref: window.location.href,
          track: anchor.getAttribute('data-track'),
          isOrderLink: anchor.hasAttribute('data-order-link')
        });
        if (to) emit('leave', { to });
      }

      if (tapFilter.click(event.timeStamp)) recordTap(event);
    }, { capture: true, passive: true });

    /* ----- hovers: only where a mouse can rest --------------------------- */
    if (canHover()) {
      const rest = core.createHoverRest();
      const hoverEnded = (done) => {
        if (done && visit.hover()) emit('hover', done);
      };
      listen(document, 'pointerover', (event) => {
        if (event.pointerType !== 'mouse') return;
        const hit = core.resolveTarget(event.target);
        hoverEnded(rest.move(hit.node, hit.el, now()));
      }, { capture: true, passive: true });
      // The mouse left the window while resting on something.
      listen(document, 'pointerout', (event) => {
        if (event.pointerType === 'mouse' && !event.relatedTarget) hoverEnded(rest.move(null, null, now()));
      }, { capture: true, passive: true });
      flushers.push(() => hoverEnded(rest.flush(now())));
    }

    /* ----- stay: how long each page part is really on screen -------------- */
    if ('IntersectionObserver' in window) {
      const observer = new window.IntersectionObserver(safely((entries) => {
        const t = now();
        for (const entry of entries) {
          const name = entry.target.getAttribute('data-section');
          const viewportH = entry.rootBounds ? entry.rootBounds.height : window.innerHeight;
          // On screen: at least half of it, or enough of it to fill half the screen.
          const onScreen = entry.isIntersecting &&
            (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= viewportH * 0.5);
          visit.inView(name, onScreen, t);
        }
      }), { threshold: [0, 0.25, 0.5, 0.75, 1] });
      // 'ar' is not watched here: its layer is always laid out, only hidden, so
      // the observer would call it on screen. arState() says when it is open.
      document.querySelectorAll('[data-section]').forEach((element) => {
        if (element.getAttribute('data-section') !== 'ar') observer.observe(element);
      });
    }

    /* ----- scroll depth ------------------------------------------------------ */
    let scrollQueued = false;
    const measureScroll = () => {
      scrollQueued = false;
      const doc = document.documentElement;
      const pageH = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
      const y = window.scrollY || window.pageYOffset || 0;
      visit.scroll(core.pct1(y + window.innerHeight, pageH));
    };
    const queueScroll = () => {
      if (scrollQueued) return;
      scrollQueued = true;
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(safely(measureScroll));
      else measureScroll();
    };
    listen(window, 'scroll', queueScroll, { passive: true });
    listen(window, 'resize', queueScroll, { passive: true });
    listen(window, 'load', queueScroll, { passive: true });
    queueScroll();

    /* ----- the 3D model turned by hand ------------------------------------- */
    const viewer = document.querySelector('#meal-viewer');
    if (viewer) {
      const burst = core.createSpinBurst();
      let idleTimer;
      const finishSpin = () => {
        window.clearTimeout(idleTimer);
        const done = burst.finish();
        if (done && visit.spin(done.ms)) emit('viewer_spin', done);
      };
      listen(viewer, 'camera-change', (event) => {
        // model-viewer also reports its own auto-rotate; only a hand counts.
        if (!event.detail || event.detail.source !== 'user-interaction') return;
        burst.event(now());
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(safely(finishSpin), core.SPIN_IDLE_MS);
      });
      flushers.push(finishSpin);
    }

    /* ----- leaving: the whole visit, added up ------------------------------ */
    const persist = (t) => writeStore(VISIT_KEY, JSON.stringify(visit.export(t)));

    const flush = () => {
      const t = now();
      flushers.forEach((fn) => safely(fn)());
      const detail = visit.flushEnd(t);
      persist(t);
      if (detail) emit('visit_end', detail);
    };

    listen(document, 'visibilitychange', () => {
      const t = now();
      if (document.visibilityState === 'hidden') {
        visit.visible(false, t);
        flush();
      } else {
        visit.visible(true, t);
      }
    });
    listen(window, 'pagehide', () => {
      visit.visible(false, now());
      flush();
    });
    // Back/forward can bring a finished page back from the browser's memory.
    listen(window, 'pageshow', (event) => {
      if (event.persisted) visit.visible(document.visibilityState !== 'hidden', now());
    });
  }

  window.SteakoutTracking = Object.freeze({ start, deviceDetail: safely(deviceDetail), arState, frameTap });
})();
