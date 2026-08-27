'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const previewRoot = path.resolve(__dirname, '..');
const markerHtml = fs.readFileSync(path.join(previewRoot, 'marker.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(previewRoot, 'index.html'), 'utf8');
const configSource = fs.readFileSync(path.join(previewRoot, 'config.js'), 'utf8');
const diagnosticsSource = fs.readFileSync(path.join(previewRoot, 'ar-xray.js'), 'utf8');

const localAssets = [...markerHtml.matchAll(/(?:src|href)="(\.\/[^"?#]+)/g)].map((match) => match[1]);
localAssets.forEach((asset) => {
  assert.ok(fs.existsSync(path.resolve(previewRoot, asset)), `marker entry references missing asset: ${asset}`);
});

const configIndex = markerHtml.indexOf('./config.js');
const stabilityIndex = markerHtml.indexOf('./ar-anchor-stability.js');
const diagnosticsIndex = markerHtml.indexOf('./ar-xray.js');
const markerIndex = markerHtml.indexOf('./marker.js');
assert.ok(configIndex >= 0 && configIndex < stabilityIndex && stabilityIndex < diagnosticsIndex && diagnosticsIndex < markerIndex,
  'AR dependencies load before diagnostics and marker runtime');
assert.match(markerHtml, /scale: responsive/, 'responsive scale is the default test mode');
assert.doesNotMatch(markerHtml, /<a-camera\s+position="0\s+0\s+0"/, 'responsive mode never starts at camera Y zero');
assert.match(markerHtml, /<a-camera\s+position="0\s+1\.6\s+0"/, 'camera uses the calibrated nonzero start height');
assert.match(indexHtml, /marker\.html\?embedded=1&amp;v=20260827-ground1/, 'parent iframe carries the new immutable cache token');
assert.match(indexHtml, /allow="[^"]*clipboard-write/, 'AR iframe grants clipboard-write so the diagnostics log can be saved/copied');
assert.match(configSource, /'ar-debug'/, 'parent forwards the opt-in diagnostics flag');
assert.match(configSource, /'xrscale'/, 'parent forwards the scale A\/B flag');
assert.match(diagnosticsSource, /const ALWAYS_ON = true;/,
  'DEBUGGING: HUD forced on. Flip to false before ship.');
assert.match(diagnosticsSource, /!ALWAYS_ON && params\.get\('ar-debug'\) !== '1'/,
  'with ALWAYS_ON false, diagnostics still exit early for normal customers');

console.log('static AR entry tests passed');
