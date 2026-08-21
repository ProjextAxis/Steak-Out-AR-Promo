/*
 * resolve-mindar.js — find the mind-ar install and hand back its modules.
 *
 * These tools live in the site repo, which deliberately has no node_modules.
 * Node resolves `require` relative to the FILE, not the cwd, so running them
 * from the toolchain directory is not enough on its own. This walks out from
 * the cwd (and honours MINDAR_ROOT / NODE_PATH) to find the install, then
 * requires through it.
 *
 * THE GOTCHA THIS EXISTS FOR: mind-ar ships its own nested copy of `canvas`.
 * An Image loaded from any other canvas install is rejected by mind-ar's
 * drawing context with "Image or Canvas expected". Everything here therefore
 * goes through `mind-ar/node_modules/canvas`, never the top-level one.
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function candidateRoots() {
  const roots = [];
  if (process.env.MINDAR_ROOT) roots.push(process.env.MINDAR_ROOT);

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    roots.push(path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const p of (process.env.NODE_PATH || '').split(path.delimiter)) {
    if (p) roots.push(p);
  }
  return roots;
}

function findModulesDir() {
  for (const root of candidateRoots()) {
    if (fs.existsSync(path.join(root, 'mind-ar', 'package.json'))) return root;
  }
  throw new Error(
    'Could not find node_modules/mind-ar.\n' +
    'Run these tools from the toolchain directory (the one holding node_modules),\n' +
    'or set MINDAR_ROOT=/path/to/node_modules.'
  );
}

const modulesDir = findModulesDir();
// Anchor the require at a real file inside the modules dir so relative
// resolution behaves exactly as it would for a package installed there.
const req = createRequire(path.join(modulesDir, 'mind-ar', 'package.json'));

module.exports = {
  modulesDir,
  // mind-ar's OWN canvas. Do not swap this for the top-level `canvas`.
  canvas: req('./node_modules/canvas'),
  msgpack: req('@msgpack/msgpack'),
  loadOfflineCompiler: () => req('./src/image-target/offline-compiler.js'),
  loadDetector: () => req('./src/image-target/detector/detector.js'),
  loadCropDetector: () => req('./src/image-target/detector/crop-detector.js'),
  loadMatcher: () => req('./src/image-target/matching/matcher.js'),
  loadEstimator: () => req('./src/image-target/estimation/estimator.js'),
  loadCpuKernels: () => req('./src/image-target/detector/kernels/cpu/index.js'),
  loadTf: () => req('@tensorflow/tfjs')
};
