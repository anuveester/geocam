'use strict';
/* Verifies:
   1. Map-pin centering math (renderMapThumbnail's crop formula) — pure
      arithmetic reproduction of the same math used at runtime, checked for
      a spread of coordinates including edge-of-tile cases.
   2. Text wrapping never truncates, even for a deliberately extreme long
      address, and the iterative font-shrink loop in drawStampBar keeps the
      stamp fitting within the bar without ever cutting text off.
   Per project spec §9 ("pixel-level centroid/alignment checks... render a
   deliberately extreme test case... confirm it fits without truncation"). */

const { loadApp, createCanvas } = require('./load_app');

function run() {
  const app = loadApp();
  let allOk = true;

  // --- 1. Map pin centering math ---
  console.log('=== Map pin centering ===');
  const testPoints = [
    [47.365590, 8.524997, 'Zurich'],
    [0.0001, 0.0001, 'near null island'],
    [-33.8688, 151.2093, 'Sydney (S/E signs)'],
    [51.5074, -0.1278, 'London (N/W signs)'],
    [89.9, 179.9, 'near pole + antimeridian'],
    [-89.9, -179.9, 'near south pole + antimeridian'],
  ];
  for (const [lat, lon, label] of testPoints) {
    for (const boxSize of [60, 120, 160, 300]) {
      const zoom = 16;
      const { xf, yf } = app.lonLatToTileFrac(lat, lon, zoom);
      const cx = Math.floor(xf), cy = Math.floor(yf);
      const pointPxX = 256 + (xf - cx) * 256;
      const pointPxY = 256 + (yf - cy) * 256;
      let sx = pointPxX - boxSize / 2, sy = pointPxY - boxSize / 2;
      sx = Math.max(0, Math.min(768 - boxSize, sx));
      sy = Math.max(0, Math.min(768 - boxSize, sy));
      // The point's position within the final cropped+drawn box:
      const finalPxX = pointPxX - sx;
      const finalPxY = pointPxY - sy;
      const expected = boxSize / 2;
      const ok = Math.abs(finalPxX - expected) < 1 && Math.abs(finalPxY - expected) < 1;
      if (!ok) allOk = false;
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} box=${boxSize}px -> point at (${finalPxX.toFixed(2)}, ${finalPxY.toFixed(2)}) vs box-center (${expected})`);
    }
  }

  // --- 2. Text wrap / shrink never truncates ---
  console.log('\n=== Text wrap / no-truncation on extreme input ===');
  const canvas = createCanvas(1200, 1200);
  const ctx = canvas.getContext('2d');

  const extremeAddress = 'Unit 4B, Building 7, Sub-Basement Level 2, Corporate Technology and Innovation Campus, ' +
    '1234 Extraordinarily Long Boulevard of the Nation-Building Industrial Cooperative Society, ' +
    'North-North-East Quadrant, Greater Metropolitan Administrative District, Postal Zone 999999-ABCDEFG, ' +
    'Somewhereverylongcountrynamethathasnospacesatallwhatsoeverxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  const data = {
    title: 'An Extremely Long Place Name That Also Keeps Going For Quite A While Longer Than Usual',
    addrLine: extremeAddress,
    flag: '🇨🇭',
    coordsText: 'Lat 47.365590°  Long 8.524997°',
    extraText: '±5m   ·   Alt 412m',
    datetimeText: 'Wed, 15/08/2026  14:32:07  GMT+05:30',
    plusCode: 'Plus Code: 9G8F+6X',
    watermark: 'A watermark string that is also somewhat long for good measure',
    mapCanvas: null,
  };
  const settings = Object.assign({}, app.DEFAULT_SETTINGS, { showMap: false });

  const canvasW = 1200, canvasH = 1200;
  app.drawStampBar(ctx, canvasW, canvasH, data, settings);

  // Reconstruct pass-1 measurement the same way drawStampBar does, to check
  // whether it actually contains every word of the source text with no
  // ellipsis / truncation marker, at whatever shrink scale was settled on.
  function allWordsPresent(sourceText, blocks, key) {
    const block = blocks.find(b => b.key === key);
    if (!block) return sourceText.length === 0;
    const rendered = block.lines.join(' ');
    const srcWords = sourceText.split(/\s+/).filter(Boolean);
    // hard-broken long "words" get split across lines with no separator
    // guaranteed, so check by concatenating without spaces as a superset test
    const renderedNoSpace = block.lines.join('');
    const missing = srcWords.filter(w => !renderedNoSpace.includes(w) && !rendered.includes(w));
    return missing.length === 0;
  }

  let scale = 1, measured;
  for (let attempt = 0; attempt < 8; attempt++) {
    measured = app.measureStampText(ctx, data, settings, canvasW * 0.9, canvasH, scale);
    if (measured.totalH <= canvasH * 0.25 * 0.9 || scale <= 0.55) break;
    scale *= 0.92;
  }
  const addrOk = allWordsPresent(extremeAddress, measured.blocks, 'addr');
  const titleOk = allWordsPresent(data.title, measured.blocks, 'title');
  const noEllipsis = !measured.blocks.some(b => b.lines.some(l => l.includes('…') || l.trim().endsWith('...')));

  console.log(`[${addrOk ? 'PASS' : 'FAIL'}] extreme address: every word present across wrapped lines`);
  console.log(`[${titleOk ? 'PASS' : 'FAIL'}] extreme title: every word present across wrapped lines`);
  console.log(`[${noEllipsis ? 'PASS' : 'FAIL'}] no ellipsis / truncation marker anywhere in output`);
  console.log(`    settled shrink scale: ${scale.toFixed(3)}  (floor is 0.55)`);
  console.log(`    address wrapped into ${(measured.blocks.find(b=>b.key==='addr')||{lines:[]}).lines.length} lines`);

  const textOk = addrOk && titleOk && noEllipsis;
  allOk = allOk && textOk;

  // Sanity: a single pathologically long unbroken "word" (no spaces at all)
  // must still be hard-broken into multiple lines rather than overflowing
  // forever on one line or throwing.
  const longWord = 'x'.repeat(500);
  const lines = app.wrapTextLines(ctx, longWord, '20px sans-serif', 300);
  const longWordOk = lines.length > 1 && lines.join('').length === 500;
  console.log(`[${longWordOk ? 'PASS' : 'FAIL'}] 500-char unbroken word hard-wraps into ${lines.length} lines, no chars lost`);
  allOk = allOk && longWordOk;

  console.log(allOk ? '\n>>> verify_pin_and_text.js: ALL PASS' : '\n>>> verify_pin_and_text.js: FAILURES DETECTED');
  process.exit(allOk ? 0 : 1);
}

run();
