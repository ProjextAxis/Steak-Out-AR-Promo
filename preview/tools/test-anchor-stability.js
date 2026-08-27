'use strict';

const assert = require('node:assert/strict');
const stability = require('../ar-anchor-stability.js');

const pose = ({ time = 0, x = 0, y = 0, z = -1, angle = 0, width = 0.2 } = {}) => {
  const halfAngle = angle * Math.PI / 360;
  return stability.createPoseSample({
    position: { x, y, z },
    rotation: { x: 0, y: Math.sin(halfAngle), z: 0, w: Math.cos(halfAngle) },
    scale: width,
    scaledWidth: 1,
    scaledHeight: 1.3
  }, time);
};

assert.equal(stability.createPoseSample({}, 0), null, 'rejects missing pose data');
assert.equal(stability.createPoseSample({
  position: { x: '0', y: 0, z: -1 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: 0.2,
  scaledWidth: 1,
  scaledHeight: 1.3
}, 0), null, 'rejects coerced non-number pose fields');
assert.equal(stability.createPoseSample({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 0 },
  scale: 1,
  scaledWidth: 1,
  scaledHeight: 1
}, 0), null, 'rejects a zero-length quaternion');

const normalized = stability.createPoseSample({
  position: { x: 0, y: 0, z: -1 },
  rotation: { x: 0, y: 0, z: 0, w: 2 },
  scale: 0.2,
  scaledWidth: 1,
  scaledHeight: 1.3
}, 10);
assert.equal(normalized.rotation.w, 1, 'normalizes accepted quaternions');
assert.equal(normalized.width, 0.2, 'derives target width from scale and scaledWidth');

const reference = pose({ time: 100, width: 0.2 });
assert.equal(stability.comparePoses(pose({ time: 200, x: 0.02 }), reference).hard, false,
  'accepts ordinary short-window translation');
assert.deepEqual(stability.comparePoses(pose({ time: 200, x: 0.12 }), reference).reasons, ['translation'],
  'rejects a large one-frame translation');
assert.deepEqual(stability.comparePoses(pose({ time: 200, width: 0.3 }), reference).reasons, ['scale'],
  'rejects a large one-frame scale change');
assert.deepEqual(stability.comparePoses(pose({ time: 200, angle: 40 }), reference).reasons, ['rotation'],
  'rejects a large one-frame rotation');

const forensicBefore = pose({ time: 13418.333, x: 0, width: 0.2 });
const forensicAfter = pose({ time: 13435, x: 0.18, width: 0.5 });
const forensicJump = stability.comparePoses(forensicAfter, forensicBefore);
assert.equal(forensicJump.hard, true, 'rejects the recorded 16.667 ms scale/position discontinuity');
assert.ok(forensicJump.reasons.includes('scale') && forensicJump.reasons.includes('translation'),
  'classifies both parts of the forensic discontinuity');

const smooth120Fps = Array.from({ length: 121 }, (_, index) => pose({
  time: index * 1000 / 120,
  x: index * 0.0005,
  angle: index * 0.05,
  width: 0.2 * (1 + index * 0.0002)
}));
assert.equal(smooth120Fps.slice(1).some((sample, index) =>
  stability.comparePoses(sample, smooth120Fps[index]).hard), false,
'accepts smooth high-rate camera motion');

const stableSamples = [0, 60, 120, 180, 240, 300].map((time, index) => pose({
  time,
  x: (index - 2.5) * 0.001,
  angle: (index - 2.5) * 0.4,
  width: 0.2 * (1 + (index - 2.5) * 0.002)
}));
const stableResult = stability.evaluateCluster(stableSamples);
assert.equal(stableResult.stable, true, 'accepts a stable multi-sample pose cluster');
assert.ok(stableSamples.includes(stableResult.medoid), 'chooses an observed pose as the medoid');

const unstableSamples = [...stableSamples.slice(0, 5), pose({ time: 300, x: 0.08 })];
assert.equal(stability.evaluateCluster(unstableSamples).stable, false,
  'refuses to commit a cluster with a large residual');

const shortWindow = [0, 20, 40, 60, 80, 100].map((time) => pose({ time }));
assert.equal(stability.evaluateCluster(shortWindow).reason, 'window',
  'requires observations across the minimum stability window');

const native60Fps = Array.from({ length: 61 }, (_, index) => pose({ time: index * 1000 / 60 }));
const retained60Fps = native60Fps.reduce((retained, sample) => {
  if (stability.shouldRetainSample(sample, retained[retained.length - 1])) retained.push(sample);
  return retained;
}, []);
const liveCadenceWindow = retained60Fps.filter((sample) => sample.time >= 400).slice(-12);
assert.equal(stability.evaluateCluster(liveCadenceWindow).stable, true,
  'a decimated 60 fps stream still spans a committable stability window');

const responsiveOptions = {
  ...stability.DEFAULTS,
  hardTranslationMeters: 0,
  stableTranslationMeters: 0
};
const smallResponsiveReference = pose({ time: 100, width: 0.02 });
const responsiveMove = stability.comparePoses(
  pose({ time: 200, width: 0.02, x: 0.011 }),
  smallResponsiveReference,
  responsiveOptions
);
assert.equal(responsiveMove.hard, true,
  'responsive outlier gates normalize translation by flyer width without a meter floor');

console.log('anchor stability tests passed');
