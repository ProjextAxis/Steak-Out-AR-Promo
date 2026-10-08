'use strict';

/* THE REVIEW PAGE ON THIS MACHINE, with its settings filled in for a test.
 *
 *   node review/tools/serve-local.js                      (from the repo root)
 *   node review/tools/serve-local.js --port 8766 --collector http://127.0.0.1:8788
 *
 * Serves the repo as a static site on 127.0.0.1 (nothing leaves this machine) so
 * the page can be opened at http://localhost:8766/review/?c=receipt. Only the
 * copy of review/index.html that is SERVED has its two settings changed: the
 * Collector address (so events and messages go to a Collector on this machine,
 * see steak-out-ar-collector/test/local-server.mjs) and a Google link that only
 * has to be a real-looking address. The file in the repo is never touched; it
 * holds the live settings (filled 2026-10-08), which the served copy replaces.
 *
 * The served copy also leaves out the Google Fonts tags (see below), so a look at
 * the page here asks nothing of any other machine. Reads files only inside the
 * repo root, and only with GET.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const port = Number(arg('port', '8766'));
const collector = arg('collector', 'http://127.0.0.1:8788');
const google = arg('google', 'https://g.page/r/TEST-ONLY/review');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.json': 'application/json', '.glb': 'model/gltf-binary'
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    let body = fs.readFileSync(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (path.relative(root, file) === path.join('review', 'index.html')) {
      let page = body.toString('utf8')
        .replace(/COLLECTOR_URL: "[^"]*"/, () => `COLLECTOR_URL: ${JSON.stringify(collector)}`)
        .replace(/GOOGLE_REVIEW_URL: "[^"]*"/, () => `GOOGLE_REVIEW_URL: ${JSON.stringify(google)}`);
      // Nothing leaves this machine, so the served copy does not ask Google for
      // Open Sans either: it shows the page the way a guest network that blocks
      // Google would. (--google-fonts leaves the real tags in.)
      if (!process.argv.includes('--google-fonts')) {
        page = page.replace(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '').replace(/<noscript>\s*<\/noscript>/g, '');
      }
      body = Buffer.from(page);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Review page on http://localhost:${port}/review/?c=receipt`);
  console.log(`  Collector: ${collector}   Google link (test only): ${google}`);
});
