'use strict';
/* Full-browser integration smoke test using a real Chromium instance with
   a fake camera device (--use-fake-device-for-media-stream) and mocked
   geolocation, exercising the actual app.js running in a real DOM: opens
   the app, waits for camera to start, flips camera, zooms, toggles grid,
   opens/closes settings, takes a real photo through the real capture
   pipeline, and checks for uncaught JS errors throughout. */

const { chromium } = require('playwright');

const BASE = 'http://localhost:8899';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: 47.365590, longitude: 8.524997, accuracy: 5 },
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  // This sandbox has no route to tile.openstreetmap.org / nominatim, so
  // real network calls the app makes for map tiles / reverse geocoding
  // will fail here (they work fine once deployed to the open internet).
  // The app is required to handle that gracefully (see tryLoadCorsImage's
  // resolve-null-on-error and maybeReverseGeocode's fetch().catch()), so
  // those specific expected failures are filtered out here; anything else
  // is a genuine bug.
  const NETWORK_NOISE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_ADDRESS_UNREACHABLE|tile\.openstreetmap|nominatim\.openstreetmap|arcgisonline/i;
  const errors = [];
  const filteredNetworkNoise = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (NETWORK_NOISE.test(text)) { filteredNetworkNoise.push(text); return; }
    errors.push('console.error: ' + text);
  });

  let ok = true;
  function check(label, cond) {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
    if (!cond) ok = false;
  }

  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const cameraActive = await page.evaluate(() => {
    const v = document.querySelector('#video');
    return v && v.videoWidth > 0 && v.videoHeight > 0;
  });
  check('camera stream started with real dimensions', cameraActive);

  const bufSize = await page.evaluate(() => {
    const v = document.querySelector('#video');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  console.log(`    camera buffer: ${bufSize.w}x${bufSize.h}`);

  await page.waitForTimeout(500);
  const gpsLocked = await page.evaluate(() => document.querySelector('#gpsBadge').classList.contains('locked'));
  check('GPS badge shows locked after mocked geolocation fix', gpsLocked);

  // No mirroring, ever, for either camera — the live preview transform
  // must never carry a negative scale.
  const rearTransform = await page.evaluate(() => document.querySelector('#video').style.transform);
  const rearNotMirrored = /scale\(-/.test(rearTransform) === false;
  check(`rear camera preview transform is never mirrored (negative scale): "${rearTransform}"`, rearNotMirrored);

  // zoom chips (0.5x-4x range; scale is coverScale*zoom, clamped at the
  // containScale floor, so exact values are device/viewport-dependent —
  // check monotonicity and clamping behavior instead of a literal string).
  async function appliedScale() {
    // transform is always `scale(scaleX, scaleY)` now — scaleX is negative
    // only for the front camera's un-mirror fix, scaleY never is, so use
    // its magnitude to compare zoom levels irrespective of mirroring.
    return page.evaluate(() => {
      const m = document.querySelector('#video').style.transform.match(/scale\(\s*-?[\d.]+\s*,\s*([\d.]+)\s*\)/);
      return m ? parseFloat(m[1]) : null;
    });
  }

  await page.click('.zoom-chip[data-zoom="1"]');
  await page.waitForTimeout(100);
  const scaleAt1x = await appliedScale();

  await page.click('.zoom-chip[data-zoom="2"]');
  await page.waitForTimeout(100);
  const scaleAt2x = await appliedScale();
  check(`2x zoom chip increases applied scale vs 1x (1x=${scaleAt1x} -> 2x=${scaleAt2x})`, scaleAt2x > scaleAt1x);

  await page.click('.zoom-chip[data-zoom="0.5"]');
  await page.waitForTimeout(100);
  const scaleAt05x = await appliedScale();
  check(`0.5x zoom-out chip decreases applied scale vs 1x (1x=${scaleAt1x} -> 0.5x=${scaleAt05x})`, scaleAt05x < scaleAt1x);

  await page.click('.zoom-chip[data-zoom="1"]');
  await page.waitForTimeout(100);

  // grid toggle
  await page.click('#btnGrid');
  await page.waitForTimeout(100);
  const gridShown = await page.evaluate(() => document.querySelector('#gridOverlay').classList.contains('show'));
  check('grid overlay toggles on', gridShown);
  await page.click('#btnGrid');

  // settings screen round-trip
  await page.click('#btnSettings');
  await page.waitForTimeout(200);
  const settingsActive = await page.evaluate(() => document.querySelector('#screen-settings').classList.contains('active'));
  check('settings screen opens', settingsActive);

  const diagText = await page.evaluate(() => document.querySelector('#diagnostics').textContent);
  check('diagnostics panel populated with build number', diagText.includes('Build: 6'));
  console.log('    diagnostics snapshot:\n' + diagText.split('\n').map(l => '      ' + l).join('\n'));

  const mapStyleDefault = await page.evaluate(() => document.querySelector('select[name="mapStyle"]').value);
  check(`map style defaults to satellite (was "${mapStyleDefault}")`, mapStyleDefault === 'satellite');

  await page.selectOption('select[name="theme"]', 'light');
  await page.selectOption('select[name="mapStyle"]', 'none');
  await page.click('#btnSettingsBack');
  await page.waitForTimeout(200);

  const themeApplied = await page.evaluate(() => document.querySelector('#liveStamp').classList.contains('theme-light'));
  check('theme setting change reflected in live overlay', themeApplied);

  // flip camera — front camera IS un-mirrored (negative scaleX), rear never is
  await page.click('#btnFlip');
  await page.waitForTimeout(1200);
  const flippedOk = await page.evaluate(() => document.querySelector('#video').videoWidth > 0);
  check('camera restarts cleanly after flip', flippedOk);
  const frontTransform = await page.evaluate(() => document.querySelector('#video').style.transform);
  check(`front camera preview IS un-mirrored (negative scaleX): "${frontTransform}"`, /scale\(-/.test(frontTransform));

  await page.click('#btnFlip');
  await page.waitForTimeout(1200);
  const backToRearTransform = await page.evaluate(() => document.querySelector('#video').style.transform);
  check(`rear camera preview is never mirrored after flipping back: "${backToRearTransform}"`, !/scale\(-/.test(backToRearTransform));

  // capture a real photo through the real pipeline
  await page.click('#btnShutter');
  await page.waitForTimeout(2500);
  const previewActive = await page.evaluate(() => document.querySelector('#screen-preview').classList.contains('active'));
  check('shutter capture navigates to preview screen', previewActive);

  const previewSrcLen = await page.evaluate(() => (document.querySelector('#previewImg').src || '').length);
  check('captured photo produced a non-trivial data URL', previewSrcLen > 5000);
  console.log(`    preview data URL length: ${previewSrcLen}`);

  // Auto-save: capture alone (no Save tap yet) must already have written
  // the photo to the gallery.
  const countRightAfterCapture = await page.evaluate(() => window.getAllPhotos().then(p => p.length));
  check(`capture auto-saves to the gallery with no Save tap needed (count=${countRightAfterCapture})`, countRightAfterCapture === 1);

  // Tapping Save afterward must not create a duplicate gallery entry.
  await page.click('#btnSave');
  await page.waitForTimeout(500);
  const galleryActive = await page.evaluate(() => document.querySelector('#screen-gallery').classList.contains('active'));
  check('save navigates back to camera (not gallery) per UX flow', !galleryActive);
  const countAfterSaveTap = await page.evaluate(() => window.getAllPhotos().then(p => p.length));
  check(`tapping Save after auto-save does not duplicate the gallery entry (count=${countAfterSaveTap})`, countAfterSaveTap === 1);

  await page.click('#btnGallery');
  await page.waitForTimeout(500);
  const galleryHasItem = await page.evaluate(() => document.querySelectorAll('.gallery-item').length > 0);
  check('saved photo appears in gallery grid', galleryHasItem);

  await page.click('.gallery-item');
  await page.waitForTimeout(300);
  const viewerActive = await page.evaluate(() => document.querySelector('#screen-viewer').classList.contains('active'));
  check('tapping gallery thumbnail opens viewer', viewerActive);

  await page.click('#btnViewerDelete');
  await page.waitForTimeout(500);
  const emptyAfterDelete = await page.evaluate(() => !document.querySelector('#galleryEmpty').classList.contains('hidden'));
  check('deleting the only photo empties the gallery', emptyAfterDelete);

  // Discard: capture again, then discard — must remove the auto-saved
  // gallery entry (undoing the auto-save), and must land back on the
  // camera screen with the live preview still playing (not blank/frozen).
  await page.click('#btnGalleryBack'); // back to camera first (we're on the gallery screen after delete)
  await page.waitForTimeout(300);
  await page.click('#btnShutter');
  await page.waitForTimeout(2500);
  const countBeforeDiscard = await page.evaluate(() => window.getAllPhotos().then(p => p.length));
  check(`second capture also auto-saved before Discard is tapped (count=${countBeforeDiscard})`, countBeforeDiscard === 1);

  // Simulate the exact bug being fixed: force the video into a paused
  // state (as some browsers do to a hidden <video>) before returning to
  // the camera screen, and confirm showScreen('camera') resumes it.
  await page.evaluate(() => document.querySelector('#video').pause());
  const pausedBeforeDiscard = await page.evaluate(() => document.querySelector('#video').paused);
  check('(test setup) video is paused right before Discard is tapped', pausedBeforeDiscard);

  await page.click('#btnDiscard');
  await page.waitForTimeout(400);
  const cameraActiveAfterDiscard = await page.evaluate(() => document.querySelector('#screen-camera').classList.contains('active'));
  check('Discard returns to the camera screen', cameraActiveAfterDiscard);
  const resumedAfterDiscard = await page.evaluate(() => document.querySelector('#video').paused === false);
  check('Discard resumes a paused video instead of leaving it blank/frozen', resumedAfterDiscard);
  const countAfterDiscard = await page.evaluate(() => window.getAllPhotos().then(p => p.length));
  check(`Discard removes the auto-saved gallery entry again (count=${countAfterDiscard})`, countAfterDiscard === 0);

  check('no uncaught JS errors or unexpected console.error during the whole run', errors.length === 0);
  if (errors.length) {
    console.log('    errors observed:');
    errors.forEach(e => console.log('      ' + e));
  }
  if (filteredNetworkNoise.length) {
    console.log(`    (also observed ${filteredNetworkNoise.length} expected sandbox-network failure(s) for map tiles / geocoding — filtered, not counted as failures; app handled them via its own try/catch fallbacks)`);
  }

  await browser.close();
  console.log(ok ? '\n>>> smoke_test.js: ALL PASS' : '\n>>> smoke_test.js: FAILURES DETECTED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
