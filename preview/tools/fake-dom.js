'use strict';

/* A small fake DOM for the tests that run the site's real scripts without a
 * browser (test-tracking.js, test-marker-events.js). Not a general DOM: just
 * what those scripts touch. A tiny HTML reader builds elements out of a real
 * page, so the tests use the page's real attributes. */

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class Target {
  constructor() { this._listeners = {}; }
  addEventListener(type, fn, options) {
    const capture = options === true || (options && options.capture === true);
    (this._listeners[type] = this._listeners[type] || []).push({ fn, capture });
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((l) => l.fn !== fn);
  }
}

class El extends Target {
  constructor(tag, attrs = {}, parent = null) {
    super();
    this.tagName = tag.toUpperCase();
    this._attrs = { ...attrs };
    this.parentElement = parent;
    this.children = [];
    if (parent) parent.children.push(this);
    this.hidden = 'hidden' in attrs;
    this.open = false;
    this.textContent = '';
    this.style = { setProperty() {} };
    this.offsetWidth = 0;
    this.contentWindow = null;
    this.rect = { left: 40, top: 100, width: 120, height: 40 };
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); }
    };
    this._classes = classes;
  }
  get dataset() {
    const attrs = this._attrs;
    return new Proxy({}, {
      get: (_, key) => attrs[`data-${kebab(String(key))}`],
      set: (_, key, value) => { attrs[`data-${kebab(String(key))}`] = String(value); return true; }
    });
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
  setAttribute(name, value) { this._attrs[name] = String(value); }
  removeAttribute(name) { delete this._attrs[name]; }
  closest(selector) {
    for (let n = this; n; n = n.parentElement) if (matchesCompound(n, selector)) return n;
    return null;
  }
  getBoundingClientRect() { return this.rect; }
  focus() {}
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; hooks.fire(this, 'close', {}); }
}

// El.close() fires 'close' like a <dialog> does; the test that owns the page
// points this at its own dispatcher.
const hooks = { fire: () => {} };

function parseHtml(html, document) {
  const VOID = new Set(['meta', 'link', 'img', 'br', 'hr', 'input']);
  const elements = [];
  const html$ = new El('html', {}, null);
  elements.push(html$);
  let parent = html$;
  const tokens = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let m;
  while ((m = tokens.exec(html))) {
    if (m[1]) {
      for (let n = parent; n; n = n.parentElement) {
        if (n.tagName === m[1].toUpperCase()) { parent = n.parentElement || html$; break; }
      }
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (tag === 'html') continue;
    const attrs = {};
    const attrText = m[3].replace(/\/\s*$/, '');
    for (const a of attrText.matchAll(/([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[a[1]] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
    }
    const el = new El(tag, attrs, parent);
    elements.push(el);
    if (tag === 'script') {
      const end = html.indexOf('</script>', tokens.lastIndex);
      tokens.lastIndex = end < 0 ? html.length : end + 9;
      continue;
    }
    const selfClosing = /\/\s*$/.test(m[3]) || VOID.has(tag);
    if (!selfClosing) parent = el;
  }
  document.documentElement = html$;
  document.body = elements.find((e) => e.tagName === 'BODY');
  return elements;
}

function matchesCompound(el, compound) {
  const re = /(^[a-z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gi;
  let m;
  while ((m = re.exec(compound))) {
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    if (m[2] && el.getAttribute('id') !== m[2]) return false;
    if (m[3] && !el._classes.has(m[3])) return false;
    if (m[4]) {
      if (!el.hasAttribute(m[4])) return false;
      if (m[5] !== undefined && el.getAttribute(m[4]) !== m[5]) return false;
    }
  }
  return true;
}

function selectAll(elements, selector) {
  const parts = selector.trim().split(/\s+/);
  return elements.filter((el) => {
    if (!matchesCompound(el, parts[parts.length - 1])) return false;
    let anc = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (anc && !matchesCompound(anc, parts[i])) anc = anc.parentElement;
      if (!anc) return false;
      anc = anc.parentElement;
    }
    return true;
  });
}

module.exports = { Target, El, parseHtml, matchesCompound, selectAll, kebab, hooks };
