# Changes made to the vendored A-Frame

`aframe-v1.5.0.min.js` is A-Frame 1.5.0 as published, with **one** local change
(2026-10-08): both `DPDB_URL:"https://dpdb.webvr.rocks/dpdb.json"` became
`DPDB_URL:""`. Nothing else in the file differs.

**Why.** A-Frame starts its bundled phone-VR polyfill (webvr-polyfill with
cardboard-vr-display) on any phone that has no native WebXR, which is every
iPhone. The polyfill then asks `dpdb.webvr.rocks` for a list of phone and
headset sizes. That host is dead (the 2026-10-08 look-check found its TLS
failing), so every load of the AR page on an iPhone made a request that fails
and wrote two errors to the console. The download added nothing: the polyfill starts from a
built-in copy and only replaces it when the download works, and with the host
dead it cannot. With an empty address the polyfill does not make the request
(`if(e){...XMLHttpRequest...}` in its `Dpdb` constructor) and keeps using the
built-in copy, which is what already happened.

**Why the file and not a setting.** The polyfill does have a `DPDB_URL`
setting, but A-Frame builds it with its own fixed settings
(`new WebVRPolyfill({BUFFER_SCALE, CARDBOARD_UI_DISABLED,
ROTATE_INSTRUCTIONS_DISABLED, MOBILE_WAKE_LOCK})`) and never reads
`window.WebVRConfig`, so nothing set before the file loads can reach it. This
was run, not assumed: with `window.WebVRConfig = { DPDB_URL: '' }` defined
first, the polyfill's config still held the dead address and the request still
went out.

**When A-Frame is updated.** The new file will ask `dpdb.webvr.rocks` again.
Repeat the change (both `DPDB_URL` defaults), or check whether the new version
lets the setting through. `preview/tools/test-static-ar-entry.js` fails while
the dead address is in the file, so it cannot come back unnoticed. Bump the
`?v=` on the script tag in `preview/marker.html` and the iframe's `v=` in
`preview/index.html` when the file changes.
