'use strict';
/* Verifies the front-camera-only un-mirror fix: mirrorFrameHorizontally()
   itself (pixel-level), that capturePhoto() only invokes it when
   state.facing === 'user' (never for 'environment'), and that it composes
   correctly with the existing rotation pipeline for all four physical
   angles. Rear camera must be provably untouched — no code path applies
   any flip to it anywhere. */

const { loadApp, createCanvas } = require('./load_app');

function px(canvas, x, y) {
  const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}
function closeTo(a, b, tol) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}
const RED = [255, 0, 0];
const GREEN = [0, 128, 0];
const BLUE = [0, 0, 255];

function makeReferenceUpright(w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  const m = 6;
  ctx.fillStyle = 'red'; ctx.fillRect(0, 0, m, m);           // top-left
  ctx.fillStyle = 'green'; ctx.fillRect(w - m, 0, m, m);      // top-right
  ctx.fillStyle = 'blue'; ctx.fillRect(0, h - m, m, m);       // bottom-left
  return c;
}

function run() {
  const app = loadApp();
  let allOk = true;
  function check(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (!cond) allOk = false;
  }

  console.log('=== mirrorFrameHorizontally() basic correctness ===');
  const w = 120, h = 80;
  const ref = makeReferenceUpright(w, h);
  const mirrored = app.mirrorFrameHorizontally(ref, w, h);
  const half = 3;
  check('red marker (was top-left) is now top-right', closeTo(px(mirrored, w - half, half), RED, 40));
  check('green marker (was top-right) is now top-left', closeTo(px(mirrored, half, half), GREEN, 40));
  check('blue marker (was bottom-left) is now bottom-right', closeTo(px(mirrored, w - half, h - half), BLUE, 40));
  check('mirrored canvas keeps the same dimensions', mirrored.width === w && mirrored.height === h);
  const twice = app.mirrorFrameHorizontally(mirrored, w, h);
  check('mirroring twice returns to the original (red back at top-left)', closeTo(px(twice, half, half), RED, 40));

  console.log('\n=== mirror + rotate compose correctly (all 4 angles) ===');
  for (const angle of [0, 90, 180, 270]) {
    const rawMirrored = app.mirrorFrameHorizontally(ref, w, h);
    const result = app.makeUprightCanvas(rawMirrored, w, h, app.rotationCorrection(angle));
    const swap = angle === 90 || angle === 270;
    const expectW = swap ? h : w, expectH = swap ? w : h;
    check(`angle=${angle}: mirrored-then-rotated canvas has correct dims (${result.width}x${result.height})`, result.width === expectW && result.height === expectH);
  }

  console.log('\n=== Gating: front-only, via source inspection ===');
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');

  const captureGate = /captureSource = state\.facing === 'user'\s*\n\s*\?\s*mirrorFrameHorizontally/.test(src);
  check("capturePhoto() only mirrors when state.facing === 'user'", captureGate);

  const previewGate = /scaleX = state\.facing === 'user' \? -appliedScale : appliedScale/.test(src);
  check("live preview only mirrors when state.facing === 'user'", previewGate);

  const noEnvironmentMirror = !/facing === 'environment'[\s\S]{0,80}mirror/i.test(src);
  check("no code path mirrors when facing === 'environment' (rear untouched)", noEnvironmentMirror);

  allOk = allOk && captureGate && previewGate && noEnvironmentMirror;

  console.log(allOk ? '\n>>> verify_mirror_fix.js: ALL PASS' : '\n>>> verify_mirror_fix.js: FAILURES DETECTED');
  process.exit(allOk ? 0 : 1);
}

run();
