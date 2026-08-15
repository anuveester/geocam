/* ==========================================================================
   GeoCam — GPS Map Camera (PWA)
   A lightweight clone of the "GPS Map Camera" style geotagging camera app.
   Everything runs client-side in the browser: camera capture (getUserMedia),
   live location (Geolocation API), reverse geocoding + map tiles (OpenStreetMap
   / Esri, both free & keyless), and local photo storage (IndexedDB).
   ========================================================================== */

/* ---------------------------- small utilities ---------------------------- */
// Shown in Settings. If this number doesn't match the latest build you
// uploaded, your phone is still running an older cached copy of app.js —
// which looks exactly like "the fix didn't work".
const APP_BUILD = 12;
const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

/* ------------------------------- settings -------------------------------- */
const DEFAULT_SETTINGS = {
  coordFormat: 'latlong',
  mapStyle: 'satellite',
  dateFormat: 'full',
  theme: 'dark',
  showMap: true,
  showAddress: true,
  showFlag: true,
  showCoords: true,
  showPlusCode: true,
  showDatetime: true,
  showExtra: false,
  showBadge: true,
  showGrid: false,
  customText: '',
  quality: '0.9',
  marginPx: 30,     // gap from the photo's left/right/bottom edges, at a 900px-wide-equivalent baseline
  sizeScale: 1.1,    // multiplier on top of that for the map/box/font sizing (1 = 100%)
  photoOrientation: 'auto', // 'auto' | 'portrait' | 'landscape' — manual override for the saved photo's shape
  photoRotation: 'auto',    // 'auto' | '0' | '90' | '180' | '270' — turns the scene upright if the phone hands it over sideways
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('geocam_settings');
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem('geocam_settings', JSON.stringify(settings));
}
let settings = loadSettings();

function applySettingsToForm() {
  $('opt-coord-format').value = settings.coordFormat;
  $('opt-map-style').value = settings.mapStyle;
  $('opt-date-format').value = settings.dateFormat;
  $('opt-theme').value = settings.theme;
  $('opt-show-map').checked = settings.showMap;
  $('opt-show-address').checked = settings.showAddress;
  $('opt-show-flag').checked = settings.showFlag;
  $('opt-show-coords').checked = settings.showCoords;
  $('opt-show-pluscode').checked = settings.showPlusCode;
  $('opt-show-datetime').checked = settings.showDatetime;
  $('opt-show-extra').checked = settings.showExtra;
  $('opt-show-badge').checked = settings.showBadge;
  $('opt-show-grid').checked = settings.showGrid;
  $('opt-custom-text').value = settings.customText;
  $('opt-quality').value = settings.quality;
  $('opt-margin').value = settings.marginPx;
  $('margin-value').textContent = `${settings.marginPx}px`;
  $('opt-size-scale').value = Math.round(settings.sizeScale * 100);
  $('size-value').textContent = `${Math.round(settings.sizeScale * 100)}%`;
  $('opt-photo-orientation').value = settings.photoOrientation || 'auto';
  $('opt-photo-rotation').value = settings.photoRotation || 'auto';
  updateDiagnostics();
}

/* --------------------------- orientation plumbing --------------------------
   Reading the phone's physical orientation from a web page is genuinely
   unreliable, and different signals disagree on different devices:
     - video.videoWidth/Height : on many phones ALWAYS landscape-shaped
                                 (e.g. 1920x1080) regardless of how you hold
                                 it; only the content is rotated internally.
     - screen.orientation.angle: correct — but frozen at 0 if the phone's
                                 auto-rotate/rotation-lock is switched off.
     - the video element's CSS box: follows the browser viewport, which also
                                 won't rotate when rotation lock is on.
   So rather than trusting one of them blindly (which is what kept breaking),
   we check them in order of reliability and expose a manual override for the
   case where the phone simply refuses to report the truth. The Diagnostics
   block in Settings prints all of these live so a mismatch is visible
   instead of guessed at. -------------------------------------------------- */
function getScreenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return null;
}

/* ---- the accelerometer: the one signal that tells the truth ----
   When the phone's auto-rotate is switched OFF, the browser is never told
   the phone turned: screen.orientation.angle stays 0, the viewport never
   reshapes, and the camera keeps handing over frames in the phone's own
   portrait frame of reference — so the scene inside them lies on its side.
   Every earlier fix asked the browser and the browser genuinely did not
   know. The accelerometer does, because gravity doesn't care about a
   software rotation lock. accelerationIncludingGravity points UP in the
   real world (it reads +9.81 on the axis facing the sky), so whichever
   device axis it lines up with tells us how the phone is being held. */
let tiltAngle = null;          // 0 | 90 | 180 | 270  (physical rotation of the phone)
let lastAccel = null;          // kept for the Diagnostics readout
const TILT_MARGIN = 2.5;       // m/s^2 hysteresis so a near-45° hold doesn't flip-flop

function handleMotion(e) {
  const ag = e.accelerationIncludingGravity;
  if (!ag || (ag.x === null && ag.y === null)) return;
  const x = ag.x || 0, y = ag.y || 0;
  lastAccel = { x, y, z: ag.z || 0 };

  // Device axes: +x points right along the screen, +y points to the top of
  // the screen. The reading points skyward, so:
  //   y ~ +9.8  -> screen-top is up      -> held upright (portrait)
  //   y ~ -9.8  -> screen-top is down    -> upside down
  //   x ~ -9.8  -> screen-right is down  -> phone turned CLOCKWISE
  //   x ~ +9.8  -> screen-right is up    -> phone turned ANTI-CLOCKWISE
  if (Math.abs(x) > Math.abs(y) + TILT_MARGIN) {
    tiltAngle = x < 0 ? 90 : 270;
  } else if (Math.abs(y) > Math.abs(x) + TILT_MARGIN) {
    tiltAngle = y > 0 ? 0 : 180;
  }
  // otherwise: too close to 45° to call — keep the previous stable value
}

function startTiltSensing() {
  if (typeof DeviceMotionEvent === 'undefined') return;
  // iOS requires an explicit permission prompt from a user gesture; Android
  // does not. Either way, failure just leaves tiltAngle null and we fall
  // back to the browser's own (possibly wrong) idea of the orientation.
  const attach = () => window.addEventListener('devicemotion', handleMotion);
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().then((res) => { if (res === 'granted') attach(); }).catch(() => {});
  } else {
    attach();
  }
}

// How far the phone is physically turned BEYOND what the browser already
// knows about. If auto-rotate is on, the browser has already rotated both
// the viewport and the camera frame, so this is 0 and we add no rotation of
// our own (rotating again would double-correct). If auto-rotate is off, the
// browser's angle is stuck at 0 while the phone really is at 90°, so this
// returns 90 — exactly the correction the picture needs.
function rotationCorrection() {
  if (tiltAngle === null) return 0;
  const known = getScreenAngle();
  const browserAngle = known === null ? 0 : ((known % 360) + 360) % 360;
  return ((tiltAngle - browserAngle) % 360 + 360) % 360;
}

// The phone's true physical orientation, preferring the accelerometer and
// falling back to the browser only when no motion sensor is available.
function physicalAngle() {
  if (tiltAngle !== null) return tiltAngle;
  const a = getScreenAngle();
  if (a !== null) return ((a % 360) + 360) % 360;
  return window.innerWidth > window.innerHeight ? 90 : 0;
}

// true = the saved photo should be landscape-shaped, false = portrait-shaped.
function wantLandscapePhoto() {
  const mode = settings.photoOrientation || 'auto';
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  const a = physicalAngle();
  return a === 90 || a === 270;
}

// The rotation actually applied to the captured frame.
function effectiveRotation() {
  const mode = settings.photoRotation || 'auto';
  if (mode !== 'auto') return ((parseInt(mode, 10) || 0) % 360 + 360) % 360;
  return rotationCorrection();
}

function updateDiagnostics() {
  const el = $('diag-readout');
  if (!el) return;
  const v = $('video');
  const box = v.getBoundingClientRect();
  const angle = getScreenAngle();
  const acc = lastAccel
    ? `x ${lastAccel.x.toFixed(1)}  y ${lastAccel.y.toFixed(1)}  z ${lastAccel.z.toFixed(1)}`
    : 'no motion sensor data yet';
  const rows = [
    `build          : v${APP_BUILD}`,
    `camera buffer  : ${v.videoWidth || 0} x ${v.videoHeight || 0}  (${(v.videoWidth || 0) >= (v.videoHeight || 0) ? 'landscape' : 'portrait'})`,
    `screen angle   : ${angle === null ? 'unavailable' : angle + '°'}${angle === 0 && (tiltAngle === 90 || tiltAngle === 270) ? '  <- stuck (auto-rotate off)' : ''}`,
    `accelerometer  : ${acc}`,
    `phone is held  : ${tiltAngle === null ? 'unknown' : tiltAngle + '°'} ${tiltAngle === 90 || tiltAngle === 270 ? '(LANDSCAPE)' : tiltAngle === null ? '' : '(PORTRAIT)'}`,
    `viewport       : ${window.innerWidth} x ${window.innerHeight}`,
    `preview box    : ${Math.round(box.width)} x ${Math.round(box.height)}`,
    `orientation set: ${settings.photoOrientation || 'auto'}`,
    `rotation set   : ${settings.photoRotation || 'auto'}`,
    `=> will rotate  : ${effectiveRotation()}°`,
    `=> photo will be: ${wantLandscapePhoto() ? 'LANDSCAPE' : 'PORTRAIT'}`,
    `zoom           : ${currentZoom.toFixed(1)}x (digital — 1x is always the untouched native stream)`,
  ];
  el.textContent = rows.join('\n');
}

// Live badge on the camera screen so you can SEE what the next shot will be
// before you take it, instead of finding out afterwards.
function updateOrientationBadge() {
  const el = $('orient-badge');
  if (!el) return;
  const land = wantLandscapePhoto();
  el.textContent = land ? '▭ Landscape' : '▯ Portrait';
  el.classList.toggle('landscape', land);
}

function bindSettingsForm() {
  const map = {
    'opt-coord-format': 'coordFormat',
    'opt-map-style': 'mapStyle',
    'opt-date-format': 'dateFormat',
    'opt-theme': 'theme',
    'opt-quality': 'quality',
  };
  Object.entries(map).forEach(([elId, key]) => {
    $(elId).addEventListener('change', (e) => {
      settings[key] = e.target.value;
      saveSettings();
      updateLiveStamp();
    });
  });
  const checks = {
    'opt-show-map': 'showMap',
    'opt-show-address': 'showAddress',
    'opt-show-flag': 'showFlag',
    'opt-show-coords': 'showCoords',
    'opt-show-pluscode': 'showPlusCode',
    'opt-show-datetime': 'showDatetime',
    'opt-show-extra': 'showExtra',
    'opt-show-badge': 'showBadge',
    'opt-show-grid': 'showGrid',
  };
  Object.entries(checks).forEach(([elId, key]) => {
    $(elId).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveSettings();
      updateLiveStamp();
      $('grid-overlay').classList.toggle('hidden', !settings.showGrid);
    });
  });
  $('opt-custom-text').addEventListener('input', (e) => {
    settings.customText = e.target.value;
    saveSettings();
    updateLiveStamp();
  });
  $('opt-margin').addEventListener('input', (e) => {
    settings.marginPx = parseInt(e.target.value, 10);
    $('margin-value').textContent = `${settings.marginPx}px`;
    saveSettings();
  });
  $('opt-size-scale').addEventListener('input', (e) => {
    settings.sizeScale = parseInt(e.target.value, 10) / 100;
    $('size-value').textContent = `${e.target.value}%`;
    saveSettings();
  });
  $('opt-photo-orientation').addEventListener('change', (e) => {
    settings.photoOrientation = e.target.value;
    saveSettings();
    updateDiagnostics();
  });
  $('opt-photo-rotation').addEventListener('change', (e) => {
    settings.photoRotation = e.target.value;
    saveSettings();
    updateDiagnostics();
  });
}

/* -------------------------- Open Location Code (Plus Codes) -------------------------- */
// Compact, from-spec implementation of Google's open Open Location Code
// standard (https://github.com/google/open-location-code) — computed
// entirely on-device, no API call. We compute the standard 10-digit code
// then drop the leading 4 characters to get a short "local" style code,
// e.g. "7J4VV9R3+F2" -> "V9R3+F2" (mirrors how Google Maps/Photos display
// a shortened Plus Code once you're within the named locality).
const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_SEP = '+';
const OLC_SEP_POS = 8;
const OLC_PAIR_RES = [20.0, 1.0, 0.05, 0.0025, 0.000125];
function encodeOLC(lat, lon, codeLength = 10) {
  lat = Math.min(90, Math.max(-90, lat));
  if (lat === 90) lat -= 0.000001;
  lon = (((lon + 180) % 360) + 360) % 360 - 180;
  let adjLat = lat + 90, adjLon = lon + 180, code = '', digitCount = 0;
  while (digitCount < codeLength) {
    const placeValue = OLC_PAIR_RES[Math.floor(digitCount / 2)];
    let dv = Math.floor(adjLat / placeValue);
    adjLat -= dv * placeValue;
    code += OLC_ALPHABET[dv];
    digitCount++;
    dv = Math.floor(adjLon / placeValue);
    adjLon -= dv * placeValue;
    code += OLC_ALPHABET[dv];
    digitCount++;
    if (digitCount === OLC_SEP_POS && digitCount < codeLength) code += OLC_SEP;
  }
  if (code.length < OLC_SEP_POS) code += '0'.repeat(OLC_SEP_POS - code.length);
  if (code.length === OLC_SEP_POS) code += OLC_SEP;
  return code;
}
function shortPlusCode(lat, lon) {
  const full = encodeOLC(lat, lon, 10);
  return full.length > 4 ? full.slice(4) : full;
}

// ISO 3166-1 alpha-2 country code -> flag emoji (regional indicator symbols).
function flagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  return String.fromCodePoint(...countryCode.toUpperCase().split('').map((c) => 127397 + c.charCodeAt(0)));
}

// Turn a Nominatim `address` object into a short bold title (locality, state,
// country) and a fuller address line (locality, state + postcode, country),
// matching the layout used by geotagging-camera apps.
function buildPlaceInfo(addr, displayName) {
  addr = addr || {};
  const locality = addr.village || addr.town || addr.city || addr.hamlet || addr.suburb || addr.county || '';
  const state = addr.state || addr.state_district || '';
  const country = addr.country || '';
  const postcode = addr.postcode || '';
  const title = [locality, state, country].filter(Boolean).join(', ') || displayName || 'Unknown location';
  const addrLine = [locality, [state, postcode].filter(Boolean).join(' '), country].filter(Boolean).join(', ') || displayName || '';
  return { title, addrLine, countryCode: addr.country_code || '' };
}

/* ------------------------------- geolocation ------------------------------ */
let geoState = {
  lat: null, lon: null, accuracy: null, altitude: null, heading: null,
  address: 'Locating…', title: 'Locating…', addrLine: '', flag: '', plusCode: '',
  addressAt: 0, watchId: null,
};

// If we have a GPS fix but reverse-geocoding hasn't finished yet (or failed),
// fall back to showing the raw coordinates instead of leaving "Locating…" —
// this is what gets baked into a photo if you capture the instant GPS locks,
// before the address lookup has had time to return.
function resolvedTitle() {
  if (geoState.title && geoState.title !== 'Locating…' && geoState.title !== 'Address unavailable') {
    return geoState.title;
  }
  if (geoState.lat !== null) return `${geoState.lat.toFixed(5)}, ${geoState.lon.toFixed(5)}`;
  return 'Locating…';
}
function resolvedAddrLine() {
  if (geoState.addrLine) return geoState.addrLine;
  if (geoState.lat !== null) return 'Fetching address…';
  return '';
}

function startGeolocation() {
  if (!('geolocation' in navigator)) {
    $('gps-text').textContent = 'GPS not supported';
    $('gps-dot').classList.add('error');
    return;
  }
  // If it's taking a while, GPS most likely can't see enough sky (indoors,
  // under cover, near tall buildings) — nudge the user rather than leave
  // them guessing why the shutter is greyed out.
  setTimeout(() => {
    if (geoState.lat === null) $('gps-text').textContent = 'No fix yet — try near a window or outdoors';
  }, 8000);
  geoState.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      geoState.lat = pos.coords.latitude;
      geoState.lon = pos.coords.longitude;
      geoState.accuracy = pos.coords.accuracy;
      geoState.altitude = pos.coords.altitude;
      geoState.plusCode = shortPlusCode(geoState.lat, geoState.lon);
      $('gps-dot').classList.add('locked');
      $('gps-dot').classList.remove('error');
      $('gps-text').textContent = `${geoState.accuracy ? Math.round(geoState.accuracy) + 'm' : 'GPS locked'}`;
      maybeReverseGeocode();
      updateLiveStamp();
      updateLiveMapThumb();
    },
    (err) => {
      $('gps-dot').classList.add('error');
      $('gps-text').textContent = err.code === 1 ? 'Location permission denied' : 'GPS unavailable';
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

// Reverse-geocode via Nominatim (OpenStreetMap), throttled to ~1 request / 8s
// and only when the position has moved meaningfully.
let lastGeocodeLat = null, lastGeocodeLon = null, geocodeInFlight = false;
function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function maybeReverseGeocode() {
  const now = Date.now();
  if (geocodeInFlight) return;
  if (lastGeocodeLat !== null) {
    const moved = distMeters(lastGeocodeLat, lastGeocodeLon, geoState.lat, geoState.lon);
    if (moved < 25 && now - geoState.addressAt < 8000) return;
  }
  geocodeInFlight = true;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${geoState.lat}&lon=${geoState.lon}&zoom=17&addressdetails=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      geoState.address = data.display_name || `${geoState.lat.toFixed(5)}, ${geoState.lon.toFixed(5)}`;
      const info = buildPlaceInfo(data.address, data.display_name);
      geoState.title = info.title;
      geoState.addrLine = info.addrLine;
      geoState.flag = flagEmoji(info.countryCode);
    }
  } catch (e) {
    if (geoState.title === 'Locating…') { geoState.title = 'Address unavailable'; geoState.addrLine = ''; }
  } finally {
    geoState.addressAt = Date.now();
    lastGeocodeLat = geoState.lat;
    lastGeocodeLon = geoState.lon;
    geocodeInFlight = false;
    updateLiveStamp();
  }
}

/* ------------------------------ formatting -------------------------------- */
function toDMS(deg, isLat) {
  const dir = deg >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = ((minFloat - m) * 60).toFixed(1);
  return `${d}°${m}'${s}"${dir}`;
}
function formatCoords() {
  if (geoState.lat === null) return '--';
  if (settings.coordFormat === 'dms') {
    return `${toDMS(geoState.lat, true)} ${toDMS(geoState.lon, false)}`;
  }
  if (settings.coordFormat === 'latlong') {
    return `Lat ${geoState.lat.toFixed(6)}°  Long ${geoState.lon.toFixed(6)}°`;
  }
  return `${geoState.lat.toFixed(6)}° ${geoState.lat >= 0 ? 'N' : 'S'}, ${geoState.lon.toFixed(6)}° ${geoState.lon >= 0 ? 'E' : 'W'}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function tzOffsetString(d) {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `GMT ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function formatDatetime(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const hh24 = d.getHours(), mm = pad(d.getMinutes());
  const hh12 = ((hh24 % 12) || 12);
  const ampm = hh24 >= 12 ? 'PM' : 'AM';
  switch (settings.dateFormat) {
    case 'full':
      return `${days[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(hh12)}:${mm} ${ampm} ${tzOffsetString(d)}`;
    case 'mdy12':
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(hh12)}:${mm} ${ampm}`;
    case 'long':
      return `${months[d.getMonth()]} ${pad(d.getDate())}, ${d.getFullYear()}, ${pad(hh12)}:${mm} ${ampm}`;
    case 'iso':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh24)}:${mm}`;
    case 'dmy24':
    default:
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(hh24)}:${mm}`;
  }
}
function formatExtra() {
  const bits = [];
  if (geoState.altitude !== null && geoState.altitude !== undefined) bits.push(`Alt ${Math.round(geoState.altitude)}m`);
  if (geoState.accuracy) bits.push(`±${Math.round(geoState.accuracy)}m`);
  return bits.join('  ·  ');
}

/* ------------------------------ live stamp UI ------------------------------ */
function updateLiveStamp() {
  $('stamp-title').style.display = settings.showAddress ? '' : 'none';
  $('stamp-flag').style.display = settings.showAddress && settings.showFlag && geoState.flag ? '' : 'none';
  $('stamp-address').style.display = settings.showAddress ? '' : 'none';
  $('stamp-coords').style.display = settings.showCoords ? '' : 'none';
  $('stamp-datetime').style.display = settings.showDatetime ? '' : 'none';
  $('stamp-extra').style.display = settings.showExtra ? '' : 'none';
  $('stamp-map').style.display = settings.showMap ? '' : 'none';
  $('stamp-logo').style.display = settings.customText ? '' : 'none';
  $('stamp-badge-row').style.display = settings.showBadge ? '' : 'none';
  $('stamp-map-brand').textContent = settings.mapStyle === 'satellite' ? 'Esri' : 'OSM';

  $('stamp-title').textContent = resolvedTitle();
  $('stamp-flag').textContent = geoState.flag;
  const plusPrefix = settings.showPlusCode && geoState.plusCode ? `${geoState.plusCode}, ` : '';
  $('stamp-address').textContent = plusPrefix + resolvedAddrLine();
  $('stamp-coords').textContent = formatCoords();
  $('stamp-extra').textContent = formatExtra();
  $('stamp-datetime').textContent = formatDatetime(new Date());
  $('stamp-logo').textContent = settings.customText;

  // Grey out the shutter until we actually have a GPS fix, or while the
  // camera is mid-restart after a rotation — so you can't accidentally bake
  // a blank/"Locating…" stamp, or a stale rotated frame, into a photo.
  $('btn-capture').classList.toggle('waiting', geoState.lat === null || cameraSettling);
  updateDiagnostics();
  updateOrientationBadge();
}
setInterval(updateLiveStamp, 1000);

let liveMapUpdatedAt = 0;
function updateLiveMapThumb() {
  if (!settings.showMap || geoState.lat === null) return;
  const now = Date.now();
  if (now - liveMapUpdatedAt < 4000) return; // throttle tile requests
  liveMapUpdatedAt = now;
  const mapEl = $('stamp-map');
  let img = mapEl.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    mapEl.insertBefore(img, mapEl.firstChild);
  }
  img.src = tileUrlForPoint(geoState.lat, geoState.lon, settings.mapStyle, 16).url;
}

/* --------------------------- map tile math / URLs --------------------------- */
function lonLatToTilePixel(lon, lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  return { tileX, tileY, px: (x - tileX) * 256, py: (y - tileY) * 256 };
}
function tileUrlForPoint(lat, lon, style, zoom) {
  const t = lonLatToTilePixel(lon, lat, zoom);
  let url;
  if (style === 'satellite') {
    url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${t.tileY}/${t.tileX}`;
  } else {
    const sub = ['a', 'b', 'c'][(t.tileX + t.tileY) % 3];
    url = `https://${sub}.tile.openstreetmap.org/${zoom}/${t.tileX}/${t.tileY}.png`;
  }
  return { url, px: t.px, py: t.py };
}

/* ------------------------------- camera setup ------------------------------- */
let mediaStream = null;
let currentFacing = 'environment';

/* ---------------------------------- zoom -----------------------------------
   The first version of this tried hardware zoom (MediaTrackConstraints'
   `zoom`) when a camera reported support for it, on the theory that it'd
   give better quality than a digital crop. That backfired: a device's
   reported zoom.min isn't guaranteed to actually BE "1x, no zoom" — it's
   whatever the platform's driver happens to call its floor, and on this
   phone touching that API at all — even to request the reported minimum —
   pushed BOTH cameras in visibly zoomed, not just the front one like
   before. There's no reliable way to ask "give me the true native FOV"
   through that API, so it's not used anymore.
   Zoom is now ALWAYS digital and identical on both cameras: 1x means the
   camera stream is never touched by any zoom constraint at all — scale(1)
   is a no-op, so it's guaranteed pixel-identical to a plain, unzoomed
   stream. Above 1x, the live preview is scaled with CSS and the saved
   photo is produced by cropping a smaller, centred region out of the full
   frame before drawing — the standard "zoom by cropping tighter" every
   camera app falls back to when it doesn't have optical zoom. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

let currentZoom = 1;

function applyZoom(value) {
  currentZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
  // scale(1) at the minimum is a genuine no-op — nothing about the video
  // element or the underlying stream is touched, so 1x is always exactly
  // what the camera's native stream looks like.
  $('video').style.transform = currentZoom === 1 ? '' : `scale(${currentZoom})`;
  updateZoomUI();
}

function updateZoomUI() {
  const slider = $('opt-zoom'), label = $('zoom-level');
  if (!slider) return;
  slider.min = ZOOM_MIN; slider.max = ZOOM_MAX; slider.step = 0.1;
  slider.value = currentZoom;
  if (label) label.textContent = `${currentZoom.toFixed(1)}x`;
}

// THE REAL ROOT CAUSE of "camera is zoomed in by default" (both cameras,
// present since before any zoom-control code existed) was here, not in the
// zoom code. This used to change its requested width/height to match the
// phone's current portrait/landscape orientation (e.g. asking for a tall
// 1080x1920 "ideal" frame in portrait). That coupling was never necessary —
// capturePhoto() already rotates and crops whatever raw shape the camera
// hands back to match the screen (see effectiveRotation() and the "upright"
// canvas step below), and the live preview does the same visually via
// `object-fit: cover`. So the requested ideal never needed to track screen
// orientation at all.
//
// Worse, asking for a narrow ideal aspect ratio that doesn't match a
// camera's NATIVE widest field-of-view mode pushes the browser's constraint
// negotiation to pick a pre-cropped resolution instead of the sensor's full
// view. This hits front (selfie) cameras hardest: many are natively 16:9
// (e.g. 1920x1080 is their widest mode), but a portrait "ideal" of
// 1080x1920 is closer in shape to a cropped 4:3 mode (e.g. 1280x960), so
// the browser silently picks that narrower, already-cropped mode — which
// looks exactly like the camera being zoomed in compared to the phone's own
// camera app. This is why the front camera looked "zoomed by default" from
// the very first report, and why none of the zoom-control fixes (which only
// ever touched CSS scale / capture-time crop) could have fixed it — the FOV
// was already lost upstream, before a single frame reached our code.
//
// Fix: ask for a generously large SQUARE ideal (equal width & height, not
// tied to orientation). Because it doesn't favour any particular aspect
// ratio, the browser's constraint algorithm ends up picking each camera's
// natural widest-FOV mode at a healthy resolution instead of a cropped one
// — verified against real Android supported-resolution lists in
// /tmp/fitness_test.js (both a 4:3 rear sensor and a 16:9 front sensor
// landed on their true widest mode with this constraint, where the old
// orientation-tied ideal did not).
function idealCameraDims() {
  return { width: { ideal: 2560 }, height: { ideal: 2560 } };
}

// Waits for the <video> element to report real pixel dimensions for the
// CURRENT stream. Right after srcObject is assigned, videoWidth/videoHeight
// can briefly still be 0 (or hold a stale value from the previous stream)
// until the browser decodes the first frame — capturing during that window
// is exactly how a rotated/mismatched photo slips through, so every caller
// that needs a trustworthy frame awaits this instead of assuming srcObject
// being set means the stream is actually ready.
function waitForVideoReady(video, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('loadedmetadata', onReady);
      clearTimeout(timer);
      resolve();
    };
    const onReady = () => finish();
    video.addEventListener('loadedmetadata', onReady);
    const timer = setTimeout(finish, timeoutMs); // don't hang forever if the event never fires
  });
}

async function startCamera(facing = currentFacing) {
  stopCamera();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, ...idealCameraDims() },
      audio: false,
    });
    const video = $('video');
    video.srcObject = mediaStream;
    currentFacing = facing;
    $('start-hint').classList.add('hidden');
    await waitForVideoReady(video);

    // Re-apply the current digital zoom to the fresh stream's live preview
    // (currentZoom is intentionally NOT reset here — only the flip button
    // resets it — so a rotation restart doesn't silently snap your zoom
    // back to 1x mid-shot). This never touches the camera hardware itself,
    // only the CSS scale on the <video> element, so it's always exact.
    applyZoom(currentZoom);
  } catch (e) {
    toast('Camera access failed: ' + e.message, 4000);
    $('start-hint').classList.remove('hidden');
  }
}
function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

// A camera stream's resolution is fixed at the moment it's opened — turning
// the phone after that doesn't make the browser renegotiate it on its own.
// So after a rotation we restart the stream so the new
// video.videoWidth/videoHeight — and therefore the captured photo — actually
// match the orientation you're holding the phone in.
//
// The first version of this fix just fired the restart after a timer and
// assumed it would be done in time. In practice you can rotate the phone
// and tap the shutter faster than that restart finishes, which captured a
// frame from the OLD (now-mismatched) stream — a landscape-shaped photo
// with the scene still rotated inside it, exactly the bug you saw. So now
// `cameraSettling` is held true for the *entire* window from the moment a
// rotation is detected until the new stream is confirmed ready, and
// capturePhoto() below refuses to shoot while it's true.
let orientationRestartTimer = null;
let cameraSettling = false;
function handleOrientationChange() {
  if (!mediaStream) return;
  cameraSettling = true;
  updateLiveStamp();
  clearTimeout(orientationRestartTimer);
  orientationRestartTimer = setTimeout(async () => {
    const cam = $('camera-screen');
    if (cam && cam.classList.contains('active')) {
      await startCamera(currentFacing);
    }
    cameraSettling = false;
    updateLiveStamp();
  }, 250); // small debounce so a fast rotation only restarts the stream once
}
window.addEventListener('orientationchange', handleOrientationChange);
window.addEventListener('resize', handleOrientationChange);

/* --------------------------------- capture ---------------------------------- */
let lastCaptureDataUrl = null;

async function tryLoadCorsImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
    setTimeout(() => resolve(null), 4000); // don't block capture forever
  });
}

// Draw "Google"-style per-letter... no: draw our OWN small brand label
// (OSM/Esri, whichever tile source is actually powering the thumbnail) in
// the bottom-left corner of the map thumbnail, same spot real geotag-camera
// apps put their map-provider watermark.
function drawMapBrand(ctx, x, y, scale) {
  const label = settings.mapStyle === 'satellite' ? 'Esri' : 'OSM';
  ctx.save();
  ctx.font = `700 ${15 * scale}px sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillText(label, x + 1, y + 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x, y);
  ctx.restore();
}

// Traces a rounded-rectangle path (does not fill/stroke/clip — caller decides).
function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStampBar(ctx, W, H, mapImg, mapPx, mapPy) {
  // Floating-card layout: a separate rounded map thumbnail bottom-left and a
  // separate translucent rounded text card to its right, spanning the full
  // photo width (minus a margin on each side) and held up off the bottom
  // edge by that same margin. The strip's height is a fixed 25% of the
  // photo's height, and the map's width is a responsive share of the
  // available width rather than forced into a square — so this adapts
  // cleanly between portrait and landscape captures with no special-case
  // rotation logic: whatever W×H the camera actually gives us, the stamp
  // just occupies the bottom 25% of it, edge to edge. Margin and overall
  // stamp size are both user-adjustable from Settings.
  const baseScale = Math.min(W, H) / 900;
  const scale = baseScale * (settings.sizeScale || 1);
  const margin = (settings.marginPx || 30) * baseScale;   // gap from the left/right/bottom edges of the photo
  const gap = 18 * scale;      // gap between the map thumbnail and the text card
  const boxPad = 24 * scale;   // inner padding of the text card

  const boxH = H * 0.25;                       // stamp occupies 25% of the photo's height
  const bottom = H - margin;
  const boxTop = bottom - boxH;
  const lineGap = Math.min(40 * scale, (boxH - boxPad * 2) / 5.2); // shrink line spacing if 25% height is tight, so content still fits

  const totalContentW = (W - margin * 2);
  const mapW = settings.showMap ? totalContentW * 0.32 : 0; // responsive width — not forced to a square
  const mapSize = boxH; // map height always matches the tag-detail box height

  ctx.save();
  const textColor = settings.theme === 'light' ? '#0f172a' : '#ffffff';
  const cardFill = settings.theme === 'minimal'
    ? 'rgba(0,0,0,0)'
    : settings.theme === 'light' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';

  // ---- badge, floats above the card, right-aligned ----
  if (settings.showBadge) {
    const badgeText = 'GeoCam';
    ctx.font = `700 ${17 * scale}px sans-serif`;
    const tw = ctx.measureText(badgeText).width;
    const bw = tw + 48 * scale, bh = 32 * scale;
    const bx = W - margin - bw, by = boxTop - 14 * scale - bh;
    roundedRectPath(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = cardFill;
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.font = `${18 * scale}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('📍', bx + 11 * scale, by + bh / 2 + 1);
    ctx.font = `700 ${17 * scale}px sans-serif`;
    ctx.fillText(badgeText, bx + 31 * scale, by + bh / 2 + 1);
  }

  // ---- map thumbnail (own rounded card, bottom-left) ----
  let textX = margin;
  if (settings.showMap) {
    const mx = margin, my = boxTop;
    ctx.save();
    roundedRectPath(ctx, mx, my, mapW, mapSize, 18 * scale);
    ctx.clip();
    if (mapImg) {
      const sw = mapW, sh = mapSize;
      ctx.drawImage(mapImg, mapPx - sw / 2, mapPy - sh / 2, sw, sh, mx, my, mapW, mapSize);
    } else {
      ctx.fillStyle = '#274b6d';
      ctx.fillRect(mx, my, mapW, mapSize);
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(mx, my + (mapSize / 3) * i); ctx.lineTo(mx + mapW, my + (mapSize / 3) * i); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mx + (mapW / 3) * i, my); ctx.lineTo(mx + (mapW / 3) * i, my + mapSize); ctx.stroke();
      }
    }
    // pin — drawn dead-centre of the box, exactly where the map image was
    // cropped around (mapPx, mapPy) so it lines up with the true GPS point.
    // This used to be offset 10*scale px upward (a leftover from an earlier
    // teardrop-shaped pin icon whose pointed tip needed to touch the exact
    // spot), but this is a plain circle with no tip, so that offset just
    // pushed the dot off the real location — which is the "map point moves
    // up when you capture" bug. Matches the live preview too, which centres
    // the pin with no offset.
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(mx + mapW / 2, my + mapSize / 2, 13 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * scale; ctx.stroke();
    drawMapBrand(ctx, mx + 8 * scale, my + mapSize - 10 * scale, scale);
    ctx.restore();
    textX = mx + mapW + gap;
  }

  // ---- text card (own rounded, 70%-opacity background) ----
  const boxX = textX;
  const boxW = (W - margin) - boxX;
  roundedRectPath(ctx, boxX, boxTop, boxW, boxH, 18 * scale);
  ctx.fillStyle = cardFill;
  ctx.fill();

  ctx.save();
  roundedRectPath(ctx, boxX, boxTop, boxW, boxH, 18 * scale);
  ctx.clip();
  ctx.fillStyle = textColor;
  ctx.textBaseline = 'top';
  const innerX = boxX + boxPad;

  // Every field wraps onto as many lines as it needs instead of being cut
  // off with an ellipsis — a long address or full Plus Code now prints in
  // full rather than "…"-truncated. Because that means we don't know the
  // line count up front, this is a two-pass build: first measure every
  // field's wrapped lines (with its own font, since each field's size
  // differs), then vertically center the WHOLE block using the real total
  // height, then actually draw it. If everything still doesn't fit the
  // fixed-height box even after wrapping (a very long address), we shrink
  // the text size and re-wrap rather than letting the box clip lose it —
  // "print all the text" wins over a fixed font size.
  const innerMaxW = boxW - boxPad * 2;
  const availH = boxH - boxPad * 2;

  function buildBlocks(sh) {
    const b = []; // { lines, font, lineH }
    if (settings.showAddress) {
      ctx.font = `800 ${32 * scale * sh}px sans-serif`;
      b.push({ lines: wrapTextLines(ctx, resolvedTitle(), innerMaxW), font: ctx.font, lineH: lineGap * sh });
      if (settings.showFlag && geoState.flag) {
        b.push({ lines: [geoState.flag], font: `${24 * scale * sh}px sans-serif`, lineH: lineGap * 0.8 * sh });
      }
      ctx.font = `500 ${23 * scale * sh}px sans-serif`;
      const plusPrefix = settings.showPlusCode && geoState.plusCode ? `${geoState.plusCode}, ` : '';
      b.push({ lines: wrapTextLines(ctx, plusPrefix + resolvedAddrLine(), innerMaxW), font: ctx.font, lineH: lineGap * 0.85 * sh });
    }
    if (settings.showCoords) {
      ctx.font = `500 ${23 * scale * sh}px sans-serif`;
      b.push({ lines: wrapTextLines(ctx, formatCoords(), innerMaxW), font: ctx.font, lineH: lineGap * 0.85 * sh });
    }
    if (settings.showExtra && formatExtra()) {
      ctx.font = `400 ${19 * scale * sh}px sans-serif`;
      b.push({ lines: wrapTextLines(ctx, formatExtra(), innerMaxW), font: ctx.font, lineH: lineGap * 0.8 * sh });
    }
    if (settings.showDatetime) {
      ctx.font = `500 ${23 * scale * sh}px sans-serif`;
      b.push({ lines: wrapTextLines(ctx, formatDatetime(new Date()), innerMaxW), font: ctx.font, lineH: lineGap * 0.85 * sh });
    }
    if (settings.customText) {
      ctx.font = `italic 400 ${19 * scale * sh}px sans-serif`;
      b.push({ lines: wrapTextLines(ctx, settings.customText, innerMaxW), font: ctx.font, lineH: lineGap * 0.85 * sh });
    }
    return b;
  }
  const blockHeight = (b) => b.reduce((sum, item) => sum + item.lines.length * item.lineH, 0);

  let shrink = 1;
  let blocks = buildBlocks(shrink);
  let estContentH = blockHeight(blocks);
  let tries = 0;
  while (estContentH > availH && shrink > 0.55 && tries < 8) {
    shrink *= 0.92;
    blocks = buildBlocks(shrink);
    estContentH = blockHeight(blocks);
    tries++;
  }

  // The box height is a fixed 25% of the photo — vertically center the
  // whole text block inside it (rather than always hugging the top), so
  // short content doesn't leave a slab of empty space at the bottom.
  let y = boxTop + boxPad + Math.max(0, (availH - estContentH) / 2);

  for (const b of blocks) {
    ctx.font = b.font;
    for (const line of b.lines) {
      ctx.fillText(line, innerX, y);
      y += b.lineH;
    }
  }
  ctx.restore();

  ctx.restore();
}
// Wraps text onto as many lines as needed to fit maxWidth — no truncation,
// no ellipsis, no line cap. Used for every stamp field so long addresses
// and full Plus Codes always print completely instead of being cut off.
function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text || '').split(' ').filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function capturePhoto() {
  const video = $('video');
  if (!video.videoWidth) { toast('Camera not ready yet'); return; }
  if (cameraSettling) {
    toast('Still adjusting the camera to the new orientation — hold still a moment and try again', 2400);
    return;
  }
  if (geoState.lat === null) {
    toast('Still finding your GPS location — move near a window or outdoors and try again', 3200);
    return;
  }
  // Many phones always hand the browser a landscape-shaped sensor buffer
  // (e.g. 1920x1080) no matter how you're holding it, rotating only the
  // *content* internally — the frame's own shape never becomes portrait.
  // That's why reading video.videoWidth/videoHeight produced a landscape
  // photo every time. So we decide the output shape from the orientation
  // signals resolved in wantLandscapePhoto() (screen angle, then the preview
  // box, with a manual override in Settings for phones that report neither
  // honestly), then crop the raw buffer to fit — the same centre-crop the
  // live preview is already doing visually via `object-fit: cover`.
  const rawW = video.videoWidth, rawH = video.videoHeight;
  const wantLandscape = wantLandscapePhoto();

  // Step 1 — put the scene upright FIRST, in its own buffer. If the phone
  // handed us a frame whose content is turned on its side, rotating here
  // (rather than trying to compensate later) means everything downstream —
  // the crop AND the stamp — works on an already-correct picture. Rotation
  // is 0 by default; the Settings override exists for phones that hand over
  // a sideways frame, which no web API reliably reports.
  const rot = effectiveRotation();
  const swap = (rot === 90 || rot === 270);
  const effW = swap ? rawH : rawW;      // scene dimensions once it's upright
  const effH = swap ? rawW : rawH;

  const upright = document.createElement('canvas');
  upright.width = effW; upright.height = effH;
  const uctx = upright.getContext('2d');
  uctx.save();
  if (rot === 90)       { uctx.translate(effW, 0);      uctx.rotate(Math.PI / 2); }
  else if (rot === 180) { uctx.translate(effW, effH);   uctx.rotate(Math.PI); }
  else if (rot === 270) { uctx.translate(0, effH);      uctx.rotate(-Math.PI / 2); }
  if (currentFacing === 'user') { uctx.translate(rawW, 0); uctx.scale(-1, 1); }  // mirror selfies
  uctx.drawImage(video, 0, 0, rawW, rawH);
  uctx.restore();

  // Step 2 — decide the output shape, then centre-crop the upright scene to
  // it (the same "cover" crop the live preview does visually).
  const longEdge = Math.max(effW, effH), shortEdge = Math.min(effW, effH);
  const effAspect = effW / effH;

  // Prefer the preview box's exact aspect (so the photo matches what you
  // framed), but only when it agrees with the orientation we resolved —
  // otherwise fall back to the sensor's own ratio, turned the right way up.
  const box = video.getBoundingClientRect();
  let outAspect;
  if (box.width > 0 && box.height > 0 && (box.width > box.height) === wantLandscape) {
    outAspect = box.width / box.height;
  } else {
    outAspect = wantLandscape ? (longEdge / shortEdge) : (shortEdge / longEdge);
  }

  let sx = 0, sy = 0, sw = effW, sh = effH;
  if (effAspect > outAspect) {
    sw = effH * outAspect;       // scene is relatively wider than we want -> crop its left/right sides
    sx = (effW - sw) / 2;
  } else {
    sh = effW / outAspect;       // scene is relatively taller than we want -> crop its top/bottom
    sy = (effH - sh) / 2;
  }

  // Digital zoom: the raw frame is always the camera's full, un-zoomed
  // field of view — the live preview only LOOKS zoomed in because of a CSS
  // scale on the video element. To make the saved photo match that, crop
  // tighter around the same centre point before drawing, by the same factor.
  if (currentZoom > 1) {
    const zsw = sw / currentZoom, zsh = sh / currentZoom;
    sx += (sw - zsw) / 2;
    sy += (sh - zsh) / 2;
    sw = zsw; sh = zsh;
  }

  // Keep the exported resolution close to the sensor's native pixel count
  // rather than shrinking it down to the (much smaller) CSS box size.
  let W, H;
  if (outAspect >= 1) { W = longEdge; H = Math.round(longEdge / outAspect); }
  else { H = longEdge; W = Math.round(longEdge * outAspect); }

  const canvas = $('hidden-canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Step 3 — the scene is upright and correctly shaped, so the stamp is
  // always drawn flat along the bottom, never rotated. Portrait shot -> tall
  // photo, upright scene, horizontal stamp. Landscape shot -> wide photo,
  // upright scene, horizontal stamp. Same rules either way.
  const drawFrame = () => ctx.drawImage(upright, sx, sy, sw, sh, 0, 0, W, H);
  drawFrame();

  let mapImg = null, mapPx = 0, mapPy = 0;
  if (settings.showMap && geoState.lat !== null) {
    const t = tileUrlForPoint(geoState.lat, geoState.lon, settings.mapStyle, 16);
    mapPx = t.px; mapPy = t.py;
    mapImg = await tryLoadCorsImage(t.url);
  }

  drawStampBar(ctx, W, H, mapImg, mapPx, mapPy);

  const quality = parseFloat(settings.quality);
  try {
    lastCaptureDataUrl = canvas.toDataURL('image/jpeg', quality);
  } catch (secErr) {
    // canvas got tainted by a non-CORS map tile — redraw without the map image
    ctx.clearRect(0, 0, W, H);
    drawFrame();
    drawStampBar(ctx, W, H, null, 0, 0);
    lastCaptureDataUrl = canvas.toDataURL('image/jpeg', quality);
  }

  $('preview-img').src = lastCaptureDataUrl;
  showScreen('preview-screen');
}

/* --------------------------------- storage ---------------------------------- */
let db = null;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('geocam_db', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('photos')) {
        d.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function savePhotoToGallery(dataUrl) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').add({ dataUrl, ts: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function getAllPhotos() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readonly');
    const req = tx.objectStore('photos').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.ts - a.ts));
    req.onerror = () => reject(req.error);
  });
}
function deletePhoto(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
async function shareDataUrl(dataUrl, filename) {
  if (navigator.canShare && navigator.share) {
    try {
      const blob = dataUrlToBlob(dataUrl);
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'GeoCam photo' });
        return;
      }
    } catch (e) { /* fall through to download */ }
  }
  downloadDataUrl(dataUrl, filename);
  toast('Share not supported here — downloaded instead');
}

async function refreshGallery() {
  const photos = await getAllPhotos();
  const grid = $('gallery-grid');
  grid.innerHTML = '';
  $('gallery-empty').style.display = photos.length ? 'none' : 'block';
  photos.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'g-item';
    const img = document.createElement('img');
    img.src = p.dataUrl;
    div.appendChild(img);
    div.addEventListener('click', () => openViewer(p));
    grid.appendChild(div);
  });
  // thumbnail on the camera screen's gallery button
  if (photos[0]) $('btn-gallery').style.backgroundImage = `url('${photos[0].dataUrl}')`;
}

let viewerCurrent = null;
function openViewer(photo) {
  viewerCurrent = photo;
  $('viewer-img').src = photo.dataUrl;
  showScreen('viewer-screen');
}

/* ---------------------------------- events ----------------------------------- */
function bindEvents() {
  $('btn-start').addEventListener('click', async () => {
    await startCamera();
    startGeolocation();
    startTiltSensing();   // iOS only grants motion access from a user gesture
  });
  $('btn-flip').addEventListener('click', () => {
    currentZoom = 1; // front/back cameras have different natural field of view — start fresh
    startCamera(currentFacing === 'environment' ? 'user' : 'environment');
  });
  $('btn-capture').addEventListener('click', capturePhoto);
  $('opt-zoom').addEventListener('input', (e) => applyZoom(parseFloat(e.target.value)));
  document.querySelectorAll('.zoom-chip').forEach((chip) => {
    chip.addEventListener('click', () => applyZoom(parseFloat(chip.dataset.zoom)));
  });
  $('btn-flash').addEventListener('click', () => {
    settings.showGrid = !settings.showGrid;
    saveSettings();
    $('grid-overlay').classList.toggle('hidden', !settings.showGrid);
    $('opt-show-grid').checked = settings.showGrid;
  });

  $('btn-settings').addEventListener('click', () => { applySettingsToForm(); showScreen('settings-screen'); });
  $('btn-settings-close').addEventListener('click', () => showScreen('camera-screen'));

  $('btn-gallery').addEventListener('click', async () => { await refreshGallery(); showScreen('gallery-screen'); });
  $('btn-gallery-close').addEventListener('click', () => showScreen('camera-screen'));

  $('btn-discard').addEventListener('click', () => { lastCaptureDataUrl = null; showScreen('camera-screen'); });
  $('btn-save').addEventListener('click', async () => {
    if (!lastCaptureDataUrl) return;
    await savePhotoToGallery(lastCaptureDataUrl);
    downloadDataUrl(lastCaptureDataUrl, `geocam_${Date.now()}.jpg`);
    toast('Photo saved');
    showScreen('camera-screen');
  });
  $('btn-share').addEventListener('click', () => lastCaptureDataUrl && shareDataUrl(lastCaptureDataUrl, `geocam_${Date.now()}.jpg`));

  $('btn-viewer-close').addEventListener('click', () => showScreen('gallery-screen'));
  $('btn-viewer-save').addEventListener('click', () => viewerCurrent && downloadDataUrl(viewerCurrent.dataUrl, `geocam_${viewerCurrent.ts}.jpg`));
  $('btn-viewer-share').addEventListener('click', () => viewerCurrent && shareDataUrl(viewerCurrent.dataUrl, `geocam_${viewerCurrent.ts}.jpg`));
  $('btn-viewer-delete').addEventListener('click', async () => {
    if (!viewerCurrent) return;
    await deletePhoto(viewerCurrent.id);
    toast('Photo deleted');
    showScreen('gallery-screen');
    refreshGallery();
  });
}

/* ----------------------------------- init ------------------------------------- */
async function init() {
  applySettingsToForm();
  bindSettingsForm();
  bindEvents();
  updateLiveStamp();
  try { await openDb(); } catch (e) { console.warn('IndexedDB unavailable', e); }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  startTiltSensing();

  // Try to auto-start; browsers that need a user gesture will fall back to the button.
  try {
    await startCamera();
    startGeolocation();
  } catch (e) {
    $('start-hint').classList.remove('hidden');
  }
}
init();
