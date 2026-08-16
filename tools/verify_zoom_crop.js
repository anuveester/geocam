'use strict';
/* Verifies cropUprightCanvas()'s handling of the new 0.5x-4x zoom range,
   in particular the zoom<1 "zoom out" case: dividing the crop size by a
   zoom below 1 enlarges the requested crop, which must be clamped to the
   upright canvas's own bounds (there's no buffer data beyond it) rather
   than producing an out-of-range source rect. */

const { loadApp } = require('./load_app');

function run() {
  const app = loadApp();
  let allOk = true;

  function check(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (!cond) allOk = false;
  }

  // A landscape-shaped upright buffer.
  const W = 1000, H = 750; // 4:3
  const fakeCanvas = { width: W, height: H };

  console.log('=== cropUprightCanvas: zoom range 0.5x-4x ===');
  for (const zoom of [0.5, 0.75, 1, 2, 3, 4]) {
    const aspect = 3 / 4; // portrait target, arbitrary for this check
    const crop = app.cropUprightCanvas(fakeCanvas, aspect, zoom);
    const inBoundsW = crop.sw <= W + 1e-6 && crop.sw > 0;
    const inBoundsH = crop.sh <= H + 1e-6 && crop.sh > 0;
    const inBoundsX = crop.sx >= -1e-6 && crop.sx + crop.sw <= W + 1e-6;
    const inBoundsY = crop.sy >= -1e-6 && crop.sy + crop.sh <= H + 1e-6;
    const ok = inBoundsW && inBoundsH && inBoundsX && inBoundsY;
    check(`zoom=${zoom}: crop (${crop.sx.toFixed(1)},${crop.sy.toFixed(1)}) ${crop.sw.toFixed(1)}x${crop.sh.toFixed(1)} stays within ${W}x${H} bounds`, ok);
  }

  // At the smallest supported zoom (0.5x), the enlarged crop should be
  // LARGER than at 1x (more of the buffer revealed), confirming zoom-out
  // actually does something rather than being silently clamped away.
  const aspect = 3 / 4;
  const at1x = app.cropUprightCanvas(fakeCanvas, aspect, 1);
  const at05x = app.cropUprightCanvas(fakeCanvas, aspect, 0.5);
  const revealsMore = at05x.sw > at1x.sw || at05x.sh > at1x.sh;
  check(`0.5x crop is larger than 1x crop (genuine zoom-out, not a no-op): 1x=${at1x.sw.toFixed(1)}x${at1x.sh.toFixed(1)} vs 0.5x=${at05x.sw.toFixed(1)}x${at05x.sh.toFixed(1)}`, revealsMore);

  // Zoom in (3x, 4x) should still shrink the crop monotonically.
  const at2x = app.cropUprightCanvas(fakeCanvas, aspect, 2);
  const at4x = app.cropUprightCanvas(fakeCanvas, aspect, 4);
  const monotonic = at05x.sw > at1x.sw && at1x.sw > at2x.sw && at2x.sw > at4x.sw;
  check(`crop width shrinks monotonically as zoom increases (0.5x > 1x > 2x > 4x)`, monotonic);

  console.log('\n=== Default aspect ratio constants (long:short) ===');
  // ASPECT_LONG_SHORT_* are intentionally plain `const` (no reason for
  // anything else to mutate them), so — unlike `state`/`DEFAULT_SETTINGS`
  // — they're not exposed as sandbox globals; confirmed by source
  // inspection instead.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const portraitOk = /ASPECT_LONG_SHORT_PORTRAIT = 1\.2/.test(src);
  const landscapeOk = /ASPECT_LONG_SHORT_LANDSCAPE = 1\.5/.test(src);
  check('app.js defines ASPECT_LONG_SHORT_PORTRAIT = 1.20', portraitOk);
  check('app.js defines ASPECT_LONG_SHORT_LANDSCAPE = 1.50', landscapeOk);
  allOk = allOk && portraitOk && landscapeOk;

  console.log('\n=== Default settings ===');
  const mapStyleOk = /mapStyle: 'satellite'/.test(src);
  check("DEFAULT_SETTINGS.mapStyle === 'satellite'", mapStyleOk);
  allOk = allOk && mapStyleOk;

  console.log(allOk ? '\n>>> verify_zoom_crop.js: ALL PASS' : '\n>>> verify_zoom_crop.js: FAILURES DETECTED');
  process.exit(allOk ? 0 : 1);
}

run();
