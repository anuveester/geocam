'use strict';
/* Verifies makeUprightCanvas() against the full 0/90/180/270 physical-angle
   case table, for both a landscape-shaped and a portrait-shaped raw buffer,
   per project spec §9 ("write out the full case table... check every case
   explicitly"). Independent of app.js's own rotation math: builds synthetic
   "raw" inputs with its own separate rotate implementation, so a directional
   bug in makeUprightCanvas can't cancel itself out by being used both ways. */

const { loadApp, createCanvas } = require('./load_app');

function px(canvas, x, y) {
  const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function closeTo(a, b, tol) {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

const RED = [255, 0, 0];
const GREEN = [0, 128, 0]; // canvas 'green' CSS keyword is #008000, not lime
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

// Independent rotate-by-degrees-clockwise, built without reusing app.js code.
function independentRotateCW(source, sw, sh, deg) {
  const rad = deg * Math.PI / 180;
  const swap = deg % 180 !== 0;
  const outW = swap ? sh : sw;
  const outH = swap ? sw : sh;
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
  return canvas;
}

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

function checkUpright(canvas, w, h, label, results) {
  const m = 6, half = m / 2;
  const tl = px(canvas, half, half);
  const tr = px(canvas, w - half, half);
  const bl = px(canvas, half, h - half);
  const ok = closeTo(tl, RED, 40) && closeTo(tr, GREEN, 40) && closeTo(bl, BLUE, 40);
  results.push({ label, ok, tl, tr, bl, size: `${canvas.width}x${canvas.height}` });
  return ok;
}

function run() {
  const app = loadApp();
  const results = [];
  let allOk = true;

  for (const [w, h, shapeLabel] of [[120, 80, 'landscape-shaped raw buffer'], [80, 120, 'portrait-shaped raw buffer']]) {
    const upright = makeReferenceUpright(w, h);
    for (const angle of [0, 90, 180, 270]) {
      // Raw frame at physicalAngle A is DEFINED (see app.js comment on
      // rotationCorrection) as upright content rotated CCW by A, i.e.
      // clockwise by (360-A) mod 360.
      const raw = independentRotateCW(upright, w, h, (360 - angle) % 360);
      const rawW = (angle % 180 === 0) ? w : h;
      const rawH = (angle % 180 === 0) ? h : w;
      if (raw.width !== rawW || raw.height !== rawH) {
        results.push({ label: `${shapeLabel} angle=${angle} DIM MISMATCH`, ok: false });
        allOk = false;
        continue;
      }
      const corrected = app.makeUprightCanvas(raw, raw.width, raw.height, app.rotationCorrection(angle));
      const label = `${shapeLabel}, physicalAngle=${angle}°`;
      const ok = checkUpright(corrected, w, h, label, results);
      if (!ok) allOk = false;
    }
  }

  console.log('=== Orientation case table (makeUprightCanvas) ===');
  for (const r of results) {
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.label}  size=${r.size || ''}  tl=${r.tl} tr=${r.tr} bl=${r.bl}`);
  }
  console.log(allOk ? '\nALL ORIENTATION CASES PASS' : '\nORIENTATION VERIFICATION FAILED');

  // --- wantLandscapePhoto() / physicalAngle bucket case table ---
  console.log('\n=== wantLandscapePhoto() case table ===');
  let bucketOk = true;
  app.state.settings = Object.assign({}, app.DEFAULT_SETTINGS);
  for (const angle of [0, 90, 180, 270]) {
    app.state.motion.hasMotion = true;
    app.state.motion.angle = angle;
    const landscape = app.wantLandscapePhoto();
    const expected = (angle === 90 || angle === 270);
    const ok = landscape === expected;
    if (!ok) bucketOk = false;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] angle=${angle} -> wantLandscape=${landscape} (expected ${expected})`);
  }
  // savedOrientation overrides must win regardless of sensor angle
  app.state.settings.savedOrientation = 'portrait';
  app.state.motion.angle = 90;
  const overridePortraitOk = app.wantLandscapePhoto() === false;
  console.log(`[${overridePortraitOk ? 'PASS' : 'FAIL'}] savedOrientation=portrait override forces portrait even at angle=90`);
  app.state.settings.savedOrientation = 'landscape';
  app.state.motion.angle = 0;
  const overrideLandscapeOk = app.wantLandscapePhoto() === true;
  console.log(`[${overrideLandscapeOk ? 'PASS' : 'FAIL'}] savedOrientation=landscape override forces landscape even at angle=0`);
  app.state.settings.savedOrientation = 'auto';
  bucketOk = bucketOk && overridePortraitOk && overrideLandscapeOk;

  // --- hysteresis dead-zone check ---
  console.log('\n=== bucketFromContinuous hysteresis ===');
  let hystOk = true;
  let bucket = 0;
  // Just past the 45deg boundary but within the 2.5deg margin: should NOT switch.
  bucket = app.bucketFromContinuous(46, 0, 2.5);
  let ok1 = bucket === 0;
  console.log(`[${ok1 ? 'PASS' : 'FAIL'}] 46° with current=0 stays at 0 (within margin)`);
  // Well past the boundary: should switch.
  bucket = app.bucketFromContinuous(60, 0, 2.5);
  let ok2 = bucket === 90;
  console.log(`[${ok2 ? 'PASS' : 'FAIL'}] 60° with current=0 switches to 90`);
  hystOk = ok1 && ok2;

  const overallOk = allOk && bucketOk && hystOk;
  console.log(overallOk ? '\n>>> verify_orientation.js: ALL PASS' : '\n>>> verify_orientation.js: FAILURES DETECTED');
  process.exit(overallOk ? 0 : 1);
}

run();
