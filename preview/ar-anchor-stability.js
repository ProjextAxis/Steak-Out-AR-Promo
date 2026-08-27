/* Pure pose validation and clustering helpers for Steak Out's image-target
 * handoff. Kept independent from A-Frame so the stability rules can be tested
 * without a camera or browser. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SteakoutAnchorStability = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const DEFAULTS = Object.freeze({
    minSamples: 6,
    minWindowMs: 250,
    maxWindowMs: 600,
    maxSamples: 12,
    minSampleIntervalMs: 50,
    hardOutlierWindowMs: 250,
    hardTranslationMeters: 0.10,
    hardTranslationFlyerWidths: 0.50,
    hardScaleRatio: 1.25,
    hardRotationDegrees: 35,
    stableTranslationMeters: 0.015,
    stableTranslationFlyerWidths: 0.10,
    stableScaleRatio: 0.05,
    stableRotationDegrees: 8
  });

  const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const createPoseSample = (detail, time = 0) => {
    const position = detail?.position;
    const rotation = detail?.rotation;
    const scale = detail?.scale;
    const scaledWidth = detail?.scaledWidth;
    const scaledHeight = detail?.scaledHeight;
    const positionValues = position && [position.x, position.y, position.z];
    const rotationValues = rotation && [rotation.x, rotation.y, rotation.z, rotation.w];

    if (!positionValues?.every(isFiniteNumber) || !rotationValues?.every(isFiniteNumber) ||
        !isFiniteNumber(scale) || !isFiniteNumber(scaledWidth) || !isFiniteNumber(scaledHeight)) {
      return null;
    }

    const width = scale * scaledWidth;
    const height = scale * scaledHeight;
    const quaternionLength = Math.hypot(...rotationValues.map(Number));
    if (scale <= 0 || scaledWidth <= 0 || scaledHeight <= 0 || width <= 0 || height <= 0 ||
        !Number.isFinite(quaternionLength) || quaternionLength < 1e-6) {
      return null;
    }

    return {
      time: Number(time) || 0,
      position: { x: Number(position.x), y: Number(position.y), z: Number(position.z) },
      rotation: {
        x: Number(rotation.x) / quaternionLength,
        y: Number(rotation.y) / quaternionLength,
        z: Number(rotation.z) / quaternionLength,
        w: Number(rotation.w) / quaternionLength
      },
      scale,
      scaledWidth,
      scaledHeight,
      width,
      height
    };
  };

  const positionDistance = (first, second) => Math.hypot(
    first.position.x - second.position.x,
    first.position.y - second.position.y,
    first.position.z - second.position.z
  );

  const quaternionAngleDegrees = (first, second) => {
    const dot = Math.abs(
      first.rotation.x * second.rotation.x +
      first.rotation.y * second.rotation.y +
      first.rotation.z * second.rotation.z +
      first.rotation.w * second.rotation.w
    );
    return 2 * Math.acos(clamp(dot, -1, 1)) * 180 / Math.PI;
  };

  const scaleLogDelta = (first, second) => Math.abs(Math.log(first.width / second.width));

  const comparePoses = (sample, reference, options = DEFAULTS) => {
    const translation = positionDistance(sample, reference);
    const rotation = quaternionAngleDegrees(sample, reference);
    const scaleChange = scaleLogDelta(sample, reference);
    const scaleRatio = Math.expm1(scaleChange);
    const hardTranslationLimit = Math.max(
      options.hardTranslationMeters,
      options.hardTranslationFlyerWidths * reference.width
    );
    const hardScaleLimit = Math.log(options.hardScaleRatio);
    const withinHardWindow = Math.abs(sample.time - reference.time) <= options.hardOutlierWindowMs;
    const reasons = [];

    if (withinHardWindow && translation > hardTranslationLimit) reasons.push('translation');
    if (withinHardWindow && scaleChange > hardScaleLimit) reasons.push('scale');
    if (withinHardWindow && rotation > options.hardRotationDegrees) reasons.push('rotation');

    return {
      translation,
      rotation,
      scaleRatio,
      scaleLogDelta: scaleChange,
      hardTranslationLimit,
      hardScaleLimit,
      hard: reasons.length > 0,
      reasons
    };
  };

  const shouldRetainSample = (sample, previous, options = DEFAULTS) =>
    !previous || sample.time - previous.time >= options.minSampleIntervalMs;

  const medoidScore = (candidate, samples, options) => samples.reduce((score, sample) => {
    const positionLimit = Math.max(
      options.stableTranslationMeters,
      options.stableTranslationFlyerWidths * candidate.width
    );
    return score +
      positionDistance(candidate, sample) / positionLimit +
      quaternionAngleDegrees(candidate, sample) / options.stableRotationDegrees +
      scaleLogDelta(candidate, sample) / Math.log1p(options.stableScaleRatio);
  }, 0);

  const selectMedoid = (samples, options = DEFAULTS) => {
    if (!samples.length) return null;
    return samples.reduce((best, candidate) => {
      const score = medoidScore(candidate, samples, options);
      return !best || score < best.score ? { sample: candidate, score } : best;
    }, null).sample;
  };

  const evaluateCluster = (samples, options = DEFAULTS) => {
    if (samples.length < options.minSamples) {
      return { stable: false, reason: 'samples', sampleCount: samples.length, medoid: null };
    }

    const ordered = [...samples].sort((a, b) => a.time - b.time);
    const spanMs = ordered[ordered.length - 1].time - ordered[0].time;
    if (spanMs < options.minWindowMs) {
      return { stable: false, reason: 'window', sampleCount: samples.length, spanMs, medoid: null };
    }

    const medoid = selectMedoid(ordered, options);
    const positionLimit = Math.max(
      options.stableTranslationMeters,
      options.stableTranslationFlyerWidths * medoid.width
    );
    const residuals = ordered.map((sample) => ({
      translation: positionDistance(sample, medoid),
      rotation: quaternionAngleDegrees(sample, medoid),
      scaleLogDelta: scaleLogDelta(sample, medoid)
    }));
    const maxima = residuals.reduce((result, residual) => ({
      translation: Math.max(result.translation, residual.translation),
      rotation: Math.max(result.rotation, residual.rotation),
      scaleLogDelta: Math.max(result.scaleLogDelta, residual.scaleLogDelta)
    }), { translation: 0, rotation: 0, scaleLogDelta: 0 });
    maxima.scaleRatio = Math.expm1(maxima.scaleLogDelta);
    const stable = maxima.translation <= positionLimit &&
      maxima.rotation <= options.stableRotationDegrees &&
      maxima.scaleLogDelta <= Math.log1p(options.stableScaleRatio);

    return {
      stable,
      reason: stable ? 'stable' : 'residual',
      sampleCount: ordered.length,
      spanMs,
      medoid,
      maxima,
      limits: {
        translation: positionLimit,
        rotation: options.stableRotationDegrees,
        scaleRatio: options.stableScaleRatio
      }
    };
  };

  return Object.freeze({
    DEFAULTS,
    comparePoses,
    createPoseSample,
    evaluateCluster,
    positionDistance,
    quaternionAngleDegrees,
    scaleLogDelta,
    selectMedoid,
    shouldRetainSample
  });
});
