# Steak Out AR Promo

Mobile-first augmented-reality promotional microsite for Steak Out Sewell.

## Prototype status

The current build is intentionally set up with **two AR modes** so development can continue before the final printed QR/table ad exists.

### 1. Free Place

Works without a printed marker.

- Uses Google's open-source `<model-viewer>`.
- Launches WebXR where available with Android Scene Viewer / iOS Quick Look fallbacks.
- Finds a horizontal surface and lets the tester place the food model in the room.
- Prototype uses `ar-scale="auto"` so the tester can pinch/resize the temporary model.
- Final Steak Out meal should be authored at correct real-world dimensions and switched to fixed scale.

### 2. QR Lock

Image-target tracking for the final under-glass Steak Out table promotion.

- Uses MindAR image tracking + A-Frame.
- Tracks a compiled `.mind` target and keeps the 3D object attached to that physical image.
- Includes temporary on-screen +/- scale controls while we tune the food model.
- Currently uses MindAR's sample tracking card so marker mode can be tested before the final artwork is designed.
- Once the actual Steak Out QR/table graphic is approved, compile that art with MindAR's target compiler and replace the marker target.

## Temporary food model

`config.js` currently points to a temporary burger GLB hosted in a public GitHub project. It is for internal prototype testing only and must be replaced before launch with the real Steak Out food model.

## Main configuration

Edit `config.js`:

```js
window.STEAKOUT_AR_CONFIG = {
  itemName: 'Test Burger',
  modelUrl: 'YOUR_GLTF_OR_GLB_URL',
  iosModelUrl: '',
  orderUrl: 'YOUR_TOAST_URL',
  defaultMode: 'free',
  showModeToggle: true,
  freePlace: {
    arScale: 'auto'
  },
  marker: {
    enabled: true,
    targetMindUrl: 'YOUR_COMPILED_TARGET.mind',
    targetPreviewUrl: 'YOUR_PRINTED_TARGET_IMAGE.png',
    modelPosition: '0 0 0.12',
    modelRotation: '90 0 0',
    modelScale: 0.32
  }
};
```

For the customer-facing launch, set `showModeToggle: false` and choose the intended default experience.

## Test pages

- `/index.html` - main Steak Out AR promo + Free Place mode.
- `/marker.html` - QR Lock / image-tracking camera mode.
- `/test-target.html` - temporary target image to show on another device or print while testing marker mode.

## Phone testing

Camera AR needs HTTPS on a real phone. Deploy the static files to an HTTPS host before testing on iPhone/Android.

Toast is **not required** to test this site. Toast will only link into the deployed microsite after the AR experience is approved.

## Final table workflow

1. Design the Steak Out printed ad with the QR code and distinctive surrounding artwork.
2. QR code opens this AR microsite.
3. Compile the complete printed artwork as a MindAR image target.
4. Put the print below the table glass.
5. Customer scans the QR, camera opens, then points back at the artwork.
6. Steak Out food model locks above the marker and appears to sit on the table glass.
7. CTA sends the customer into Toast ordering.

## AR foundations

- Google `<model-viewer>` for free-placement AR.
- MindAR for image-target/marker tracking.
- A-Frame for the marker-tracked 3D scene.

## What the page reports (Orbit Analytics)

The landing page (`preview/`) records what happens on it and can send it to the
Steak Out AR Collector, a small Cloudflare Worker that Orbit reads from. **Nothing
leaves the phone until `collectorUrl` in `preview/config.js` is filled in**; it is
empty in this repo. While it is empty the events are only kept in
`window.dataLayer`, which is how to look at them.

- `preview/app.js` owns the visit (session, `?c=` placement) and the one `track()`
  function that sends an event.
- `preview/tracking.js` watches the landing page: where it is tapped, where a
  mouse rests, how long each page part is on screen, scroll depth, the 3D model
  turned by hand, links that leave, and one cumulative `visit_end` each time the
  page is hidden.
- `preview/marker.js` (the AR frame) reports its own moments to the landing page:
  camera live, lock, lost and found again, and how long the AR was used.
- `preview/tracking-core.js` holds the rules: which events and which keys may
  leave the phone (Orbit's `ORBIT_SITE_EVENTS`), how a tap becomes a position,
  caps (60 taps, 40 hovers, 30 turns, 40 `visit_end`s per tab). It has no browser
  code so it can be tested.
- `data-track` and `data-section` attributes in `index.html` name the elements
  and page parts a tap is filed under. Taps in the AR frame use the same two
  names (`ar_order`, `ar_close`).

Never sent: camera frames, poses, QR text, the user agent, anything typed,
anything personal. The device is a coarse `ios` / `android` / `other`, the screen
size, and whether a mouse can hover. Two extra `sessionStorage` keys,
`steakout.visit` (counters) and `steakout.ar.run` (how many times START CAMERA has
been pressed in this tab, so a reload of the tab carries on from there: Orbit tells
AR runs apart by visit and run number, and a second attempt that started again at
"run 1" would be thrown away as a repeat of the first), hold counts only and die
with the tab.

Checks (plain node, no packages), from the repo root:

```
node preview/tools/test-tracking.js              # rules, the page, the contract
node preview/tools/test-marker-events.js         # the AR frame's messages
node preview/tools/test-static-ar-entry.js
node preview/tools/test-anchor-stability.js
```

Add `--selftest` to the first two: it breaks the real source one change at a time
and fails unless the named check goes red.

## The review page (lunch.mysteakout.com/review/)

"How was your experience?": a customer taps a face. A 4 or 5 is sent on to leave a
Google review; a 1, 2 or 3 gets a note from the owner and a box to tell him what
went wrong, and that message goes to Brian through Orbit. It is one page,
`review/index.html`, served by the same GitHub Pages site as everything else
(`https://lunch.mysteakout.com/review/`, which the root redirect does not touch,
because it only covers `/`). It is the owner's own page, kept as he made it: the
four screens, their look and their words are the original's. Only the owner's name
(Brian), the settings' names, the tracking and the sending are new.

**Three settings**, at the top of the script in `review/index.html`:

| Setting | What it is | Now |
|---|---|---|
| `OWNER_NAME` | Not shown to guests since 2026-10-10: the note is signed “— The Steak Out family” and the button says “Leave your feedback!” | `Brian` |
| `GOOGLE_REVIEW_URL` | Google Business Profile, then "Ask for reviews", then copy the link (`https://g.page/r/XXXX/review`) | empty: waiting for the link |
| `COLLECTOR_URL` | The Collector's address, the same Worker the AR page reports to, but **without** `/collect` (`https://steakout-ar-collector.YOUR-SUBDOMAIN.workers.dev`) | empty: nothing leaves the phone |

While either is empty the page shows a yellow **TEST MODE** strip saying what is
missing. With `COLLECTOR_URL` empty nothing leaves the phone at all (events are only
kept in `window.dataLayer`, and a message only pretends to send). With it set to
something that can't be used (not https, a typo) the strip says so and a message is
**not** pretended sent: the customer is told to call.

**Where the QR codes point.** `https://lunch.mysteakout.com/review/?c=receipt`,
`?c=table`, `?c=counter`: whatever follows `c=` (letters, digits, `_` and `-`, 40
long) is the placement, and Orbit shows it per visit. `?src=` is the old name and
still works; any other `?tag` on the link is never read.

**What it reports** (to `{COLLECTOR_URL}/collect`, one small event at a time, the
names and numbers Orbit's `ORBIT_REVIEW_EVENTS` lists and nothing else): the page
opened (screen size, coarse OS, whether a mouse can hover, how many times this
phone has opened it, the local hour and weekday), every tap and where, mouse hovers,
each screen shown, which face (and the one before it), "Change my answer", the
Google tap (never proof a review was posted), a phone-number tap, the first key
pressed in the box (never the words), a message sent (how many characters, and
whether a name and a phone or email were given, yes or no), a message that failed
(a short code), and one `review_end` each time they leave or switch apps (seconds on
the page and on each screen, how far they scrolled, taps, hovers, the face they left
with, and yes/no for typed, sent, Google tapped, phone tapped). Each event carries
`page: "review"` so the Collector keeps it apart from the AR's.

**What it never sends in an event:** anything typed, the browser's name, where they
came from, their language or time zone, the address of the page, the other `?tags`
on the link. Every value is rebuilt from an allowlist in `review/review-core.js`, so
a free-text value cannot pass any rule.

**The message** goes only to `{COLLECTOR_URL}/feedback`, only when they press Send:
the face, the words, and a name and a phone or email only if they typed them, plus the
visit's id and placement, and a random `message_id` (made when Send is first pressed
and kept in the tab until the message is stored). The page believes only a 2xx answer ("stored"); anything
else shows "That didn't go through. Check your connection and try again, or call us
at (856) 464-8000." and reports only a short code (`http_4xx`, `http_5xx`, `network`
or `timeout`). A robot that fills the hidden box is shown "sent" and nothing goes. The
Collector keeps a message 30 days and Orbit keeps the copy.

**Pressing Send again is safe.** On a weak signal the Collector can store a message
while its answer never reaches the phone; the page then says it didn't go through and
the customer presses Send again. The retry carries the same `message_id` (the same
words, face, name and contact), and the Collector answers `201` without storing it a
second time. Different words are a different message and get a new id; so does the
next message after one was stored. The tab keeps only the id and a short code of the
words (never the words) until the message is stored.

**What it keeps on the phone:** one count in `localStorage` (`so-review-visits`,
how many times this phone opened the page), and four `sessionStorage` keys of its
own (`steakout.review.session`, `.source`, `.visit`, `.msgid`: a random id, the
placement, counters, and the id of a message waiting to be stored) that die with the
tab. Not the AR page's keys.

**Fonts.** Bebas Neue (the headings) is served from `review/fonts/`, the same files
the AR page uses. Open Sans (the body text) still comes from Google Fonts, but it is
loaded so it can't hold the page back: on a guest network that blocks Google the page
draws at once in the phone's own font. To serve it from here too, put the Open Sans
`.woff2` files in `review/fonts/`, add `@font-face` rules for them and remove the
Google tags from the head.

Looking at it on this machine, with the real Collector code and nothing leaving the
machine (the Collector's repo is `~/CODE/steak-out-ar-collector`):

```
node ../steak-out-ar-collector/test/local-server.mjs     # the real Worker on 127.0.0.1:8788
node review/tools/serve-local.js                         # the page on http://localhost:8766/review/?c=receipt
```

`serve-local.js` fills the two settings in on the copy it serves (never in the file)
and leaves out the Google Fonts tags, so a look at the page asks nothing of any other
machine.

Checks (plain node, no packages), from the repo root:

```
node review/tools/test-review.js              # the contract, the page, the Collector, the files
node review/tools/test-review.js --selftest   # breaks the real source one change at a time
```

`test-review.js` reads Orbit's contract (`ORBIT_REVIEW_EVENTS`, the screens, parts and
element names) from `../orbit/libraries/orbit/src/site-events/site-events.types.ts`
when that checkout sits next to this one, and feeds everything the page sends to the
real Worker from `../steak-out-ar-collector` when that one does; otherwise it says it
used its own copies. It also compares the page's look and words with the original
file on the owner's Desktop when that is there.

**Going live, in this order** (the first two are the Collector's README, "Updating a
Collector that is already live"): migrate and deploy the Collector, with the owner's
own hands; then fill `COLLECTOR_URL` here and `collectorUrl` in `preview/config.js`;
add the Google link when it exists; then push this branch's changes to `main`, which
is the public deploy (GitHub Pages publishes `main`). Pushing `main` before the
Collector is updated would only leave the page in TEST MODE, but do it in this order
anyway.
