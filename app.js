'use strict';
/* =========================================================================
   GeoCam — GPS Map Camera PWA
   Single-file application logic. No build step, no frameworks.
   Bump APP_BUILD (and CACHE_NAME in service-worker.js) on every shipped
   change, however small — the Settings > Diagnostics panel prints this
   number so stale-cache issues can be told apart from real bugs at a glance.
   ========================================================================= */

const APP_BUILD = 2;

/* ---------------------------------------------------------------------
   1. Utilities & screen management
   --------------------------------------------------------------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

let toastTimer = null;
function toast(msg, ms) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function showScreen(name) {
  $all('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  state.currentScreen = name;
  if (name === 'settings') updateDiagnostics();
  if (name === 'gallery') refreshGallery();
}

/* ---------------------------------------------------------------------
   Global state
   --------------------------------------------------------------------- */

var state = {
  settings: null,
  currentScreen: 'camera',
  facing: 'environment',
  zoom: 1,
  coverScale: 1,
  containScale: 1,
  stream: null,
  restarting: false,
  capturing: false,
  position: null,
  place: null,
  lastGeocodeAt: 0,
  lastGeocodeLat: null,
  lastGeocodeLon: null,
  geocodeInFlight: false,
  motion: { angle: 0, tiltDeg: 0, hasMotion: false, ax: 0, ay: 0, az: 0 },
  db: null,
  lastCapture: null,
  currentViewerId: null,
  currentViewerDataUrl: null,
  lastRestartAngle: undefined,
};

/* ---------------------------------------------------------------------
   2. Settings persistence
   --------------------------------------------------------------------- */

var DEFAULT_SETTINGS = {
  coordFormat: 'latlong',
  mapStyle: 'satellite',
  datetimeFormat: 'full',
  theme: 'dark',
  watermark: '',
  quality: '0.9',
  showMap: true,
  showAddress: true,
  showFlag: true,
  showCoords: true,
  showPlusCode: true,
  showDatetime: true,
  showAccuracy: true,
  showBadge: true,
  showGrid: false,
  savedOrientation: 'auto',
  rotationFix: 'auto',
  stampMargin: 0,
  fontScale: 1,
};

const SETTINGS_KEY = 'geocam_settings_v1';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    state.settings = raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
  } catch (e) {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function applySettingsToForm() {
  const form = $('#settingsForm');
  if (!form) return;
  const s = state.settings;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key];
  }
  $('#marginVal').textContent = s.stampMargin;
  $('#fontScaleVal').textContent = Number(s.fontScale).toFixed(2);
}

function bindSettingsForm() {
  const form = $('#settingsForm');
  if (!form) return;
  form.addEventListener('input', () => {
    const s = Object.assign({}, state.settings);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const el = form.elements[key];
      if (!el) continue;
      s[key] = el.type === 'checkbox' ? el.checked : el.value;
    }
    state.settings = s;
    saveSettings();
    $('#marginVal').textContent = s.stampMargin;
    $('#fontScaleVal').textContent = Number(s.fontScale).toFixed(2);
    updateLiveStamp();
    const grid = $('#gridOverlay');
    if (grid) {
      if (s.showGrid) { grid.classList.add('show'); drawGridOverlay(); }
      else { grid.classList.remove('show'); }
    }
  });
}

/* ---------------------------------------------------------------------
   3. Orientation / diagnostics subsystem
   -----------------------------------------------------------------------
   Three compounding bugs are guarded against here (see project spec §5):
   (a) manifest.json must not lock screen orientation (handled in manifest)
   (b) screen.orientation.angle alone is unreliable when auto-rotate is
       off, so the accelerometer (DeviceMotionEvent) is the primary signal
   (c) raw video buffer dimensions do not reflect visual orientation, so
       the desired output shape is derived from the resolved physical
       angle, never from video.videoWidth/videoHeight.
   --------------------------------------------------------------------- */

function getScreenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360;
  return 0;
}

// Signed shortest angular distance from b to a, in (-180, 180].
function angleDelta(a, b) {
  return (((a - b + 540) % 360) + 360) % 360 - 180;
}

// Snap a continuous 0-360 heading to the nearest of {0,90,180,270}, but
// only switch away from the current bucket once the new bucket is closer
// by more than marginDeg — a dead-zone that stops flicker right at the
// 45/135/225/315 boundaries.
function bucketFromContinuous(contDeg, currentBucket, marginDeg) {
  const buckets = [0, 90, 180, 270];
  let nearest = buckets[0];
  let best = Infinity;
  for (const b of buckets) {
    const d = Math.abs(angleDelta(contDeg, b));
    if (d < best) { best = d; nearest = b; }
  }
  if (nearest === currentBucket) return currentBucket;
  const distToCurrent = Math.abs(angleDelta(contDeg, currentBucket));
  if (distToCurrent - best > marginDeg) return nearest;
  return currentBucket;
}

// Primary orientation signal: real accelerometer data, immune to the
// "auto-rotate switched off" trap that breaks screen.orientation-only logic.
function handleMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || (g.x === null && g.y === null)) return;
  const ax = g.x || 0, ay = g.y || 0, az = g.z || 0;
  state.motion.ax = ax; state.motion.ay = ay; state.motion.az = az;
  const mag = Math.sqrt(ax * ax + ay * ay);
  if (mag < 3) return; // device roughly flat (face up/down) — reading is ambiguous, keep last bucket
  state.motion.hasMotion = true;
  // atan2(-ax, ay): 0deg = portrait upright (ay dominant positive),
  // 90deg = ax dominant negative, 180deg = ay dominant negative, 270deg = ax dominant positive.
  const contDeg = (Math.atan2(-ax, ay) * 180 / Math.PI + 360) % 360;
  state.motion.tiltDeg = contDeg;
  state.motion.angle = bucketFromContinuous(contDeg, state.motion.angle, 2.5);
}

function startTiltSensing() {
  const attach = () => window.addEventListener('devicemotion', handleMotion);
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    // iOS 13+: permission must be requested from a user gesture. Try once
    // immediately (works if already granted from a previous visit), and
    // again on the first tap anywhere as a guaranteed-gesture fallback.
    DeviceMotionEvent.requestPermission().then(res => { if (res === 'granted') attach(); }).catch(() => {});
    document.addEventListener('click', function onceClick() {
      document.removeEventListener('click', onceClick);
      DeviceMotionEvent.requestPermission().then(res => { if (res === 'granted') attach(); }).catch(() => {});
    }, { once: true });
  } else {
    attach(); // Android and most other browsers: no permission prompt needed
  }
}

// Resolved current physical rotation of the device, 0/90/180/270,
// accelerometer-first, screen.orientation as a secondary fallback.
function physicalAngle() {
  if (state.motion.hasMotion) return state.motion.angle;
  const a = getScreenAngle();
  const buckets = [0, 90, 180, 270];
  return buckets.reduce((best, b) => Math.abs(angleDelta(a, b)) < Math.abs(angleDelta(a, best)) ? b : best, 0);
}

// Degrees to rotate the raw camera buffer CLOCKWISE to make its content
// upright, given the device has physically rotated by `angle` degrees from
// natural portrait. (See makeUprightCanvas — verified against a full
// 0/90/180/270 case table in tools/verify_orientation.js.)
function rotationCorrection(angle) {
  return ((angle % 360) + 360) % 360;
}

function wantLandscapePhoto() {
  const so = state.settings.savedOrientation;
  if (so === 'portrait') return false;
  if (so === 'landscape') return true;
  const a = physicalAngle();
  return a === 90 || a === 270;
}

function effectiveRotation() {
  const rf = state.settings.rotationFix;
  if (rf && rf !== 'auto') return rf === 'none' ? 0 : (parseInt(rf, 10) || 0);
  return rotationCorrection(physicalAngle());
}

function updateOrientationBadge() {
  const el = $('#orientBadge');
  if (!el) return;
  const a = physicalAngle();
  const landscape = a === 90 || a === 270;
  el.textContent = `${landscape ? 'Landscape' : 'Portrait'} · ${a}°`;
}

function updateDiagnostics() {
  const el = $('#diagnostics');
  if (!el) return;
  const video = $('#video');
  const wrap = $('#videoWrap');
  const m = state.motion;
  const a = physicalAngle();
  const rot = effectiveRotation();
  el.textContent = [
    `Build: ${APP_BUILD}`,
    `Camera buffer: ${video ? video.videoWidth : 0} x ${video ? video.videoHeight : 0}`,
    `Screen angle (raw): ${getScreenAngle()}°`,
    `Accel x/y/z: ${m.ax.toFixed(2)} / ${m.ay.toFixed(2)} / ${m.az.toFixed(2)}`,
    `Computed tilt: ${m.tiltDeg.toFixed(1)}°`,
    `Motion sensor active: ${m.hasMotion}`,
    `Resolved physical angle: ${a}°`,
    `Resolved rotation fix: ${rot}°`,
    `Want landscape photo: ${wantLandscapePhoto()}`,
    `Viewport: ${window.innerWidth} x ${window.innerHeight}`,
    `Preview box: ${wrap ? Math.round(wrap.clientWidth) : 0} x ${wrap ? Math.round(wrap.clientHeight) : 0}`,
    `Saved-orientation setting: ${state.settings.savedOrientation}`,
    `Rotation-fix setting: ${state.settings.rotationFix}`,
    `Zoom: ${state.zoom.toFixed(2)}x  (range ${ZOOM_MIN}x-${ZOOM_MAX}x)`,
    `Cover/contain scale: ${state.coverScale.toFixed(3)} / ${state.containScale.toFixed(3)}`,
    `Facing: ${state.facing}`,
  ].join('\n');
}

/* ---------------------------------------------------------------------
   4. Geo / place logic
   --------------------------------------------------------------------- */

// --- Open Location Code (Plus Codes) — from-scratch encoder ------------
const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_BASE = OLC_ALPHABET.length; // 20
const OLC_LAT_MAX = 90;
const OLC_LON_MAX = 180;
const OLC_SEP = '+';
const OLC_SEP_POS = 8;
const OLC_PAD = '0';
const OLC_PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];
const OLC_MIN_TRIMMABLE_LEN = 6;

function olcClipLatitude(lat) { return Math.min(90, Math.max(-90, lat)); }
function olcNormalizeLongitude(lon) {
  let l = lon;
  while (l < -180) l += 360;
  while (l >= 180) l -= 360;
  return l;
}
function olcComputeLatPrecision(codeLength) {
  if (codeLength <= 10) return Math.pow(20, Math.floor(codeLength / -2 + 2));
  return Math.pow(20, -3) / Math.pow(5, codeLength - 10);
}

function encodeOLC(latitude, longitude, codeLength) {
  codeLength = codeLength || 10;
  let lat = olcClipLatitude(latitude);
  const lon = olcNormalizeLongitude(longitude);
  if (lat === 90) lat -= olcComputeLatPrecision(codeLength);

  let adjLat = lat + OLC_LAT_MAX;
  let adjLon = lon + OLC_LON_MAX;
  let code = '';
  let digitCount = 0;
  while (digitCount < codeLength) {
    const placeValue = OLC_PAIR_RESOLUTIONS[Math.floor(digitCount / 2)];
    let digitValue = Math.floor(adjLat / placeValue);
    adjLat -= digitValue * placeValue;
    code += OLC_ALPHABET.charAt(digitValue);
    digitCount++;
    digitValue = Math.floor(adjLon / placeValue);
    adjLon -= digitValue * placeValue;
    code += OLC_ALPHABET.charAt(digitValue);
    digitCount++;
    if (digitCount === OLC_SEP_POS && digitCount < codeLength) code += OLC_SEP;
  }
  if (code.length < OLC_SEP_POS) code += OLC_PAD.repeat(OLC_SEP_POS - code.length);
  if (code.length === OLC_SEP_POS) code += OLC_SEP;
  return code;
}

function olcDecodeApprox(code) {
  // Minimal decoder used only to compute a code's center point, so
  // shortPlusCode() can decide how much of the code is safe to trim.
  const clean = code.replace(OLC_SEP, '').replace(new RegExp(OLC_PAD, 'g'), '');
  let lat = -OLC_LAT_MAX, lon = -OLC_LON_MAX;
  let latPlace = OLC_LAT_MAX * 2, lonPlace = OLC_LON_MAX * 2;
  let digitCount = 0;
  for (let i = 0; i < clean.length; i++) {
    const digitValue = OLC_ALPHABET.indexOf(clean[i]);
    if (digitValue < 0) continue;
    const placeValue = OLC_PAIR_RESOLUTIONS[Math.floor(digitCount / 2)];
    if (digitCount % 2 === 0) { lat += digitValue * placeValue; latPlace = placeValue; }
    else { lon += digitValue * placeValue; lonPlace = placeValue; }
    digitCount++;
  }
  return { latCenter: lat + latPlace / 2, lonCenter: lon + lonPlace / 2 };
}

// Shorten a full Plus Code relative to a reference point, matching the
// standard "9G8F+6X, City" display convention. When refLat/refLon are
// omitted, the code's own point is used as the reference, which always
// yields the compact ~8-character local form meant to be read alongside
// a locality name.
function shortPlusCode(lat, lon, refLat, refLon) {
  const code = encodeOLC(lat, lon, 10);
  if (refLat == null || refLon == null) {
    // No genuine external reference point given (the common in-app case):
    // trim exactly the first pair, matching the standard "9G8F+6X, City"
    // display convention where the code is always read alongside a
    // locality name. Using the code's own center as its own "reference"
    // would make range collapse to 0 and over-trim to a near-useless
    // 3-character remainder — deliberately not done here.
    return code.substring(4);
  }
  // A real external reference (e.g. a city/locality centroid) was given:
  // trim as aggressively as the distance from that reference allows,
  // following the standard Open Location Code shortening algorithm.
  const center = olcDecodeApprox(code);
  const range = Math.max(Math.abs(center.latCenter - refLat), Math.abs(center.lonCenter - refLon));
  for (let i = OLC_PAIR_RESOLUTIONS.length - 2; i >= 1; i--) {
    if (range < OLC_PAIR_RESOLUTIONS[i] * 0.3) {
      return code.substring((i + 1) * 2);
    }
  }
  return code;
}

function flagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  const cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  const codePoints = cc.split('').map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function buildPlaceInfo(json) {
  const a = (json && json.address) || {};
  const title = a.attraction || a.building || a.road || a.neighbourhood || a.suburb ||
    a.village || a.town || a.city_district || a.city || a.county || (json && json.name) || 'Unknown location';
  const addrLine = (json && json.display_name) ||
    [a.road, a.suburb, a.city, a.state, a.postcode, a.country].filter(Boolean).join(', ') ||
    'Address unavailable';
  const countryCode = (a.country_code || '').toUpperCase();
  return { title, addrLine, countryCode, raw: json };
}

function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

function updateGpsBadge(locked) {
  const badge = $('#gpsBadge');
  if (!badge) return;
  badge.classList.toggle('locked', !!locked);
  $('#gpsBadgeText').textContent = locked ? 'GPS locked' : 'Searching…';
}

function startGeolocation() {
  if (!('geolocation' in navigator)) { toast('Geolocation not supported on this device'); return; }
  navigator.geolocation.watchPosition(
    pos => {
      state.position = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        timestamp: pos.timestamp,
      };
      updateGpsBadge(true);
      updateLiveStamp();
      maybeReverseGeocode();
    },
    err => { updateGpsBadge(false); console.warn('Geolocation error', err); },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

let geocodeDebounceTimer = null;
function maybeReverseGeocode() {
  if (!state.position) return;
  clearTimeout(geocodeDebounceTimer);
  geocodeDebounceTimer = setTimeout(() => {
    const p = state.position;
    const now = Date.now();
    const movedFar = state.lastGeocodeLat == null ||
      distMeters(p.lat, p.lon, state.lastGeocodeLat, state.lastGeocodeLon) > 35;
    const longEnough = now - state.lastGeocodeAt > 45000;
    if (state.geocodeInFlight || (!movedFar && !longEnough)) return;
    state.geocodeInFlight = true;
    state.lastGeocodeAt = now;
    state.lastGeocodeLat = p.lat;
    state.lastGeocodeLon = p.lon;
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lon}&zoom=17&addressdetails=1`;
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(json => { if (json) { state.place = buildPlaceInfo(json); updateLiveStamp(); } })
      .catch(err => console.warn('Reverse geocode failed', err))
      .finally(() => { state.geocodeInFlight = false; });
  }, 900);
}

/* ---------------------------------------------------------------------
   5. Formatting
   --------------------------------------------------------------------- */

function toDMS(deg, isLat) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = ((minFloat - m) * 60).toFixed(1);
  const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
  return `${d}°${m}'${s}"${dir}`;
}

function formatCoords(lat, lon, format) {
  if (format === 'dms') return `${toDMS(lat, true)} ${toDMS(lon, false)}`;
  if (format === 'decimal') return `${lat.toFixed(6)}°, ${lon.toFixed(6)}°`;
  return `Lat ${lat.toFixed(6)}°  Long ${lon.toFixed(6)}°`;
}

function tzOffsetString(date) {
  const offMin = -date.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `GMT${sign}${hh}:${mm}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDatetime(date, format) {
  const pad = n => String(n).padStart(2, '0');
  const dd = pad(date.getDate()), MM = pad(date.getMonth() + 1), yyyy = date.getFullYear();
  const hh24 = date.getHours(), mm = pad(date.getMinutes()), ss = pad(date.getSeconds());
  const hh12 = (hh24 % 12) || 12;
  const ampm = hh24 < 12 ? 'AM' : 'PM';
  switch (format) {
    case 'dmy24': return `${dd}/${MM}/${yyyy} ${pad(hh24)}:${mm}`;
    case 'mdy12': return `${MM}/${dd}/${yyyy} ${pad(hh12)}:${mm} ${ampm}`;
    case 'longmonth': return `${date.getDate()} ${MONTHS_LONG[date.getMonth()]} ${yyyy}`;
    case 'iso': return date.toISOString();
    case 'full':
    default:
      return `${WEEKDAYS[date.getDay()]}, ${dd}/${MM}/${yyyy}  ${pad(hh24)}:${mm}:${ss}  ${tzOffsetString(date)}`;
  }
}

function formatExtra(position) {
  const parts = [];
  if (position.accuracy != null) parts.push(`±${Math.round(position.accuracy)}m`);
  if (position.altitude != null && !Number.isNaN(position.altitude)) parts.push(`Alt ${Math.round(position.altitude)}m`);
  return parts.join('   ·   ');
}

/* ---------------------------------------------------------------------
   6. Live preview (overlay + map thumbnail)
   --------------------------------------------------------------------- */

function lonLatToTileFrac(lat, lon, zoom) {
  const latRad = lat * Math.PI / 180;
  const n = Math.pow(2, zoom);
  const xf = (lon + 180) / 360 * n;
  const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { xf, yf };
}

function tileUrlForPoint(x, y, z, style) {
  if (style === 'satellite') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function tryLoadCorsImage(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 4000);
    img.onload = () => { if (!done) { done = true; clearTimeout(timer); resolve(img); } };
    img.onerror = () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } };
    img.src = url;
  });
}

function drawPin(ctx, cx, cy, r) {
  // Dead-center pin, drawn with zero manual offset. A previous version had
  // a leftover -10px y-offset left over from an old teardrop icon; the
  // marker must land exactly at (cx, cy) with no correction whatsoever.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239,68,68,0.22)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, r * 0.28);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

const tileImageCache = new Map();
function loadTileCached(x, y, z, style) {
  const key = `${style}/${z}/${x}/${y}`;
  if (tileImageCache.has(key)) return tileImageCache.get(key);
  const p = tryLoadCorsImage(tileUrlForPoint(x, y, z, style));
  tileImageCache.set(key, p);
  return p;
}

// Shared by both the live overlay and the captured-photo stamp, so the pin
// position logic can never drift between what the user sees and what gets
// baked into the photo. boxSize must stay well under 768 (the stitched
// 3x3-tile canvas size) for the exact-centering guarantee to hold.
async function renderMapThumbnail(boxSize, lat, lon, style) {
  const canvas = document.createElement('canvas');
  canvas.width = boxSize; canvas.height = boxSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a222b';
  ctx.fillRect(0, 0, boxSize, boxSize);
  if (style === 'none' || lat == null || lon == null) return canvas;

  const zoom = 16;
  const { xf, yf } = lonLatToTileFrac(lat, lon, zoom);
  const cx = Math.floor(xf), cy = Math.floor(yf);

  const big = document.createElement('canvas');
  big.width = 768; big.height = 768;
  const bctx = big.getContext('2d');

  const loads = [];
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) {
      const tx = cx + col, ty = cy + row;
      loads.push(loadTileCached(tx, ty, zoom, style).then(img => {
        if (img) bctx.drawImage(img, (col + 1) * 256, (row + 1) * 256, 256, 256);
      }));
    }
  }
  await Promise.all(loads);

  const pointPxX = 256 + (xf - cx) * 256;
  const pointPxY = 256 + (yf - cy) * 256;
  let sx = pointPxX - boxSize / 2;
  let sy = pointPxY - boxSize / 2;
  sx = Math.max(0, Math.min(768 - boxSize, sx));
  sy = Math.max(0, Math.min(768 - boxSize, sy));

  ctx.drawImage(big, sx, sy, boxSize, boxSize, 0, 0, boxSize, boxSize);
  drawPin(ctx, boxSize / 2, boxSize / 2, Math.max(4, boxSize * 0.09));
  return canvas;
}

function updateLiveStamp() {
  const s = state.settings;
  if (!s) return;
  const pos = state.position;
  const place = state.place;

  $('#liveBadge').classList.toggle('hidden', !s.showBadge);
  $('#liveMapThumb').classList.toggle('hidden', !s.showMap || s.mapStyle === 'none');
  $('#liveFlag').classList.toggle('hidden', !s.showFlag);
  $('#liveAddr').classList.toggle('hidden', !s.showAddress);
  $('#liveCoords').classList.toggle('hidden', !s.showCoords);
  $('#liveExtra').classList.toggle('hidden', !s.showAccuracy);
  $('#liveDatetime').classList.toggle('hidden', !s.showDatetime);
  $('#liveWatermark').classList.toggle('hidden', !s.watermark);

  $('#liveTitle').textContent = place ? place.title : (pos ? 'Resolving…' : 'Locating…');
  $('#liveFlag').textContent = place ? flagEmoji(place.countryCode) : '';
  $('#liveAddr').textContent = place ? place.addrLine : (pos ? 'Fetching address…' : 'Waiting for GPS…');
  $('#liveCoords').textContent = pos ? formatCoords(pos.lat, pos.lon, s.coordFormat) : '—';
  $('#liveExtra').textContent = pos ? formatExtra(pos) : '';
  $('#liveDatetime').textContent = formatDatetime(new Date(), s.datetimeFormat);
  $('#liveWatermark').textContent = s.watermark || '';

  $('#liveStamp').className = 'live-stamp theme-' + (s.theme || 'dark');
}

let liveMapLastLat = null, liveMapLastLon = null;
async function updateLiveMapThumbThrottled() {
  const pos = state.position;
  const s = state.settings;
  if (!pos || !s || !s.showMap || s.mapStyle === 'none') return;
  if (liveMapLastLat != null && distMeters(pos.lat, pos.lon, liveMapLastLat, liveMapLastLon) < 20) return;
  liveMapLastLat = pos.lat; liveMapLastLon = pos.lon;
  const canvas = await renderMapThumbnail(160, pos.lat, pos.lon, s.mapStyle);
  const target = $('#liveMapCanvas');
  if (!target) return;
  const tctx = target.getContext('2d');
  tctx.clearRect(0, 0, target.width, target.height);
  tctx.drawImage(canvas, 0, 0, target.width, target.height);
}

function drawGridOverlay() {
  const canvas = $('#gridOverlay');
  const wrap = $('#videoWrap');
  if (!canvas || !wrap) return;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const x = canvas.width * i / 3;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    const y = canvas.height * i / 3;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}

/* ---------------------------------------------------------------------
   7. Zoom — purely digital, identical for front/back cameras (see spec §6)
   -----------------------------------------------------------------------
   Range is 0.5x-4x: 1x-4x zooms IN (crops tighter, as before). Below 1x
   is a genuine zoom-OUT that reveals more of the buffer the camera
   already captured — not a fake shrink. This only works because
   idealCameraDims() (§5d) requests a generously large, aspect-neutral
   buffer, which on most phones is noticeably wider-framed than what a
   plain object-fit:cover crop shows on a tall phone screen; zooming out
   reveals that extra margin, down to the point where the whole buffer is
   visible (further "zoom out" than that has no more image data to show).

   Because of this, #video's sizing can no longer be delegated to CSS
   object-fit:cover (which would already have discarded that extra
   margin before any JS transform ever saw it) — this code owns the
   cover-fit math itself via updateCoverScale()/applyZoom(), using an
   explicit translate+scale transform. That also means the previous
   "empty-string transform at 1x" invariant no longer applies: the base
   cover-fit scale is now always present in the transform, with `zoom`
   layered on top of it.
   --------------------------------------------------------------------- */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_CHIP_VALUES = [0.5, 1, 2, 3];

// Recomputes the base "cover" and "contain" scale factors for the current
// video buffer size vs. the on-screen preview box, and re-applies the
// current zoom on top. Must be called whenever either changes: after the
// camera (re)starts, and on window resize.
function updateCoverScale() {
  const video = $('#video');
  const wrap = $('#videoWrap');
  if (!video || !wrap || !video.videoWidth || !video.videoHeight) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = wrap.clientWidth || 1, ch = wrap.clientHeight || 1;
  // Render the video at its own intrinsic pixel size; translate+scale
  // (below) handles both centering and the cover/zoom math explicitly.
  video.style.width = vw + 'px';
  video.style.height = vh + 'px';
  state.coverScale = Math.max(cw / vw, ch / vh);   // smallest scale that still fills the box (old object-fit:cover)
  state.containScale = Math.min(cw / vw, ch / vh);  // scale at which the WHOLE buffer is visible — the zoom-out floor
  applyZoom(state.zoom);
}

function applyZoom(z) {
  state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const video = $('#video');
  const cover = state.coverScale || 1;
  const contain = state.containScale || cover;
  // Never shrink past "contain" — beyond that there is no more of the
  // buffer left to reveal, only wasted empty space.
  const appliedScale = Math.max(contain, cover * state.zoom);
  video.style.transform = `translate(-50%, -50%) scale(${appliedScale})`;
  updateZoomUI();
}

function updateZoomUI() {
  $('#zoomSlider').value = state.zoom;
  $all('.zoom-chip').forEach(btn => {
    btn.classList.toggle('active', Math.abs(parseFloat(btn.dataset.zoom) - state.zoom) < 0.05);
  });
}

/* ---------------------------------------------------------------------
   8. Camera lifecycle
   --------------------------------------------------------------------- */

// Deliberately orientation-neutral and aspect-ratio-neutral (see spec §5d):
// an equal ideal width/height pushes getUserMedia's constraint-selection
// algorithm toward each sensor's native widest-field-of-view mode, instead
// of a pre-cropped "portrait" or "landscape" mode that looks pre-zoomed.
// Verified against a W3C fitness-distance simulation — see
// tools/verify_camera_constraints.js. Treat any edit to this function with
// suspicion and re-run that verification before shipping.
function idealCameraDims() {
  return { width: { ideal: 2560 }, height: { ideal: 2560 } };
}

function waitForVideoReady(video) {
  return new Promise((resolve) => {
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
    const onReady = () => { cleanup(); resolve(); };
    function cleanup() {
      video.removeEventListener('loadedmetadata', onReady);
      clearTimeout(timer);
    }
    video.addEventListener('loadedmetadata', onReady);
    const timer = setTimeout(() => { cleanup(); resolve(); }, 4000);
  });
}

function showCameraOverlayMsg(msg) {
  const el = $('#cameraOverlayMsg');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideCameraOverlayMsg() {
  const el = $('#cameraOverlayMsg');
  if (el) el.classList.add('hidden');
}

async function startCamera() {
  const video = $('#video');
  stopCamera();
  const dims = idealCameraDims();
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: state.facing },
      width: dims.width,
      height: dims.height,
    },
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    video.srcObject = stream;
    await waitForVideoReady(video);
    await video.play().catch(() => {});
    updateCoverScale();
  } catch (err) {
    console.error('getUserMedia failed', err);
    toast('Could not access camera: ' + (err && err.message ? err.message : err));
  }
  updateDiagnostics();
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
}

let orientationDebounceTimer = null;
function handleOrientationChange() {
  clearTimeout(orientationDebounceTimer);
  orientationDebounceTimer = setTimeout(async () => {
    if (state.restarting || !state.stream) return;
    state.restarting = true;
    const btn = $('#btnShutter');
    if (btn) btn.disabled = true;
    showCameraOverlayMsg('Adjusting for rotation…');
    try { await startCamera(); }
    finally {
      state.restarting = false;
      if (btn) btn.disabled = false;
      hideCameraOverlayMsg();
    }
  }, 250);
}

/* ---------------------------------------------------------------------
   9. Stamp drawing
   --------------------------------------------------------------------- */

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Word-wrap that never truncates: falls back to hard character-breaking
// for a single "word" wider than the box (e.g. a very long unbroken
// address token), rather than ever ending a line with an ellipsis.
function wrapTextLines(ctx, text, font, maxWidth) {
  ctx.font = font;
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let cur = '';

  function hardBreak(word) {
    let chunk = '';
    for (const ch of word) {
      const test = chunk + ch;
      if (ctx.measureText(test).width <= maxWidth || !chunk) chunk = test;
      else { lines.push(chunk); chunk = ch; }
    }
    return chunk;
  }

  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else if (!cur) {
      cur = hardBreak(w);
    } else {
      lines.push(cur);
      cur = ctx.measureText(w).width <= maxWidth ? w : hardBreak(w);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function buildStampFieldSpecs(data, settings, canvasH, fontScale) {
  const specs = [];
  const titleSize = canvasH * 0.032 * fontScale;
  const addrSize = canvasH * 0.021 * fontScale;
  const coordSize = canvasH * 0.020 * fontScale;
  const extraSize = canvasH * 0.017 * fontScale;
  const dtSize = canvasH * 0.019 * fontScale;
  const wmSize = canvasH * 0.017 * fontScale;

  if (settings.showAddress !== false) {
    const titleText = (data.title || '') + (settings.showFlag && data.flag ? '   ' + data.flag : '');
    specs.push({ key: 'title', text: titleText, font: `700 ${titleSize}px sans-serif`, size: titleSize, color: 'main' });
    if (data.addrLine) {
      specs.push({ key: 'addr', text: data.addrLine, font: `400 ${addrSize}px sans-serif`, size: addrSize, color: 'sub' });
    }
  }
  if (settings.showCoords !== false && data.coordsText) {
    specs.push({ key: 'coords', text: data.coordsText, font: `500 ${coordSize}px monospace`, size: coordSize, color: 'sub' });
  }
  if (settings.showPlusCode && data.plusCode) {
    specs.push({ key: 'pluscode', text: 'Plus Code: ' + data.plusCode, font: `500 ${coordSize}px monospace`, size: coordSize, color: 'sub' });
  }
  if (settings.showAccuracy && data.extraText) {
    specs.push({ key: 'extra', text: data.extraText, font: `400 ${extraSize}px sans-serif`, size: extraSize, color: 'sub' });
  }
  if (settings.showDatetime !== false && data.datetimeText) {
    specs.push({ key: 'dt', text: data.datetimeText, font: `500 ${dtSize}px sans-serif`, size: dtSize, color: 'sub' });
  }
  if (data.watermark) {
    specs.push({ key: 'wm', text: data.watermark, font: `italic 400 ${wmSize}px sans-serif`, size: wmSize, color: 'accent' });
  }
  return specs;
}

// Pass 1 (measure): wrap every field with its own font BEFORE any drawing,
// so the total block height is known up front for vertical centering.
function measureStampText(ctx, data, settings, maxWidth, canvasH, fontScale) {
  const specs = buildStampFieldSpecs(data, settings, canvasH, fontScale);
  let totalH = 0;
  const blocks = [];
  for (const spec of specs) {
    const lines = wrapTextLines(ctx, spec.text, spec.font, maxWidth);
    const lineH = spec.size * 1.28;
    const blockH = lines.length * lineH;
    const spacing = spec.size * 0.22;
    blocks.push(Object.assign({}, spec, { lines, lineH, blockH }));
    totalH += blockH + spacing;
  }
  return { blocks, totalH, maxWidth };
}

// Pass 2 (draw): reuses the exact blocks/lines computed in pass 1, so
// measurement and drawing can never disagree.
function drawMeasuredText(ctx, measured, x, startY, mainColor, subColor) {
  let y = startY;
  ctx.textBaseline = 'top';
  for (const block of measured.blocks) {
    ctx.fillStyle = block.color === 'main' ? mainColor : block.color === 'accent' ? '#7dd3fc' : subColor;
    ctx.font = block.font;
    for (const line of block.lines) {
      ctx.fillText(line, x, y);
      y += block.lineH;
    }
    y += block.size * 0.22;
  }
}

function drawStampBar(ctx, canvasW, canvasH, data, settings) {
  const barH = canvasH * 0.25;
  const barY = canvasH - barH;
  const margin = settings.stampMargin || 0;
  const baseFontScale = settings.fontScale || 1;
  const theme = settings.theme || 'dark';
  const isLight = theme === 'light';
  const textColor = isLight ? '#12181f' : '#ffffff';
  const subColor = isLight ? 'rgba(18,24,31,0.78)' : 'rgba(255,255,255,0.85)';

  if (theme !== 'minimal') {
    const grad = ctx.createLinearGradient(0, barY, 0, canvasH);
    if (isLight) {
      grad.addColorStop(0, 'rgba(255,255,255,0.0)');
      grad.addColorStop(0.25, 'rgba(255,255,255,0.88)');
      grad.addColorStop(1, 'rgba(255,255,255,0.94)');
    } else {
      grad.addColorStop(0, 'rgba(0,0,0,0.0)');
      grad.addColorStop(0.25, 'rgba(0,0,0,0.74)');
      grad.addColorStop(1, 'rgba(0,0,0,0.84)');
    }
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, barY, canvasW, barH);
    ctx.restore();
  }

  const padX = Math.max(canvasW * 0.035, 16) + margin;
  const contentTop = barY + Math.max(canvasH * 0.015, 8) + margin * 0.5;
  const contentBottom = canvasH - Math.max(canvasH * 0.015, 8) - margin;
  const contentH = contentBottom - contentTop;
  const contentW = canvasW - padX * 2;

  const badgeFontBase = canvasH * 0.018;
  const badgeH = settings.showBadge ? badgeFontBase * baseFontScale * 1.9 : 0;

  const mapBoxMax = Math.min(contentH - badgeH, canvasW * 0.22);
  const wantMap = settings.showMap && data.mapCanvas;
  const mapBox = wantMap ? Math.max(40, mapBoxMax) : 0;
  const textAreaW = contentW - (mapBox ? mapBox + contentW * 0.03 : 0);

  // ---- Pass 1: measure, shrinking iteratively (never truncating) ----
  let scale = 1;
  let measured = measureStampText(ctx, data, settings, textAreaW, canvasH, baseFontScale);
  let attempt = 0;
  while (attempt < 8) {
    const available = contentH - badgeH;
    if (measured.totalH <= available || scale <= 0.55) break;
    scale *= 0.92;
    measured = measureStampText(ctx, data, settings, textAreaW, canvasH, baseFontScale * scale);
    attempt++;
  }
  if (scale < 0.55) scale = 0.55;

  // ---- Pass 2: draw ----
  let cursorY = contentTop;
  if (settings.showBadge) {
    const bf = badgeFontBase * baseFontScale * scale;
    ctx.font = `700 ${bf}px sans-serif`;
    const label = '📍 GeoCam';
    const tw = ctx.measureText(label).width;
    const bh = bf * 1.8, bw = tw + bf * 1.6;
    roundedRectPath(ctx, padX, cursorY, bw, bh, bh / 2);
    ctx.fillStyle = isLight ? 'rgba(18,24,31,0.10)' : 'rgba(56,189,248,0.22)';
    ctx.fill();
    ctx.fillStyle = isLight ? '#0ea5e9' : '#7dd3fc';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, padX + bf * 0.8, cursorY + bh / 2 + bf * 0.05);
    cursorY += bh + bf * 0.5;
  }

  const rowTop = cursorY;
  const rowAvailH = contentBottom - rowTop;
  const textStartY = rowTop + Math.max(0, (rowAvailH - measured.totalH) / 2);

  if (mapBox) {
    const mapY = rowTop + Math.max(0, (rowAvailH - mapBox) / 2);
    ctx.save();
    roundedRectPath(ctx, padX, mapY, mapBox, mapBox, mapBox * 0.12);
    ctx.clip();
    ctx.drawImage(data.mapCanvas, padX, mapY, mapBox, mapBox);
    ctx.restore();
    ctx.lineWidth = Math.max(1, mapBox * 0.02);
    ctx.strokeStyle = isLight ? 'rgba(18,24,31,0.35)' : 'rgba(255,255,255,0.4)';
    roundedRectPath(ctx, padX, mapY, mapBox, mapBox, mapBox * 0.12);
    ctx.stroke();
  }

  const textX = padX + (mapBox ? mapBox + contentW * 0.03 : 0);
  drawMeasuredText(ctx, measured, textX, textStartY, textColor, subColor);
}

/* ---------------------------------------------------------------------
   10. Capture pipeline
   -----------------------------------------------------------------------
   Ordered: upright-rotate raw buffer -> decide output aspect from the
   resolved orientation signal (never from videoWidth/videoHeight) ->
   center-crop to it -> apply zoom crop -> draw final canvas -> draw stamp.
   --------------------------------------------------------------------- */

// Default output aspect ratios, expressed as long-edge : short-edge:
//   portrait  -> 1.20 : 1  (height:width) — close to a 6:5 frame
//   landscape -> 1.50 : 1  (width:height) — classic 3:2 frame
// aspectWH below is always width/height, so portrait needs the reciprocal.
const ASPECT_LONG_SHORT_PORTRAIT = 1.20;
const ASPECT_LONG_SHORT_LANDSCAPE = 1.50;

// Rotates `source` (sw x sh) clockwise by correctionDeg into a new canvas,
// swapping width/height for 90/270. This is the function verified against
// the full 0/90/180/270 case table in tools/verify_orientation.js.
function makeUprightCanvas(source, sw, sh, correctionDeg) {
  const deg = ((correctionDeg % 360) + 360) % 360;
  const rad = deg * Math.PI / 180;
  const swap = deg === 90 || deg === 270;
  const outW = swap ? sh : sw;
  const outH = swap ? sw : sh;
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
  return canvas;
}

function cropUprightCanvas(canvas, aspectWH, zoom) {
  const W = canvas.width, H = canvas.height;
  let cw, ch;
  if (W / H > aspectWH) { ch = H; cw = H * aspectWH; }
  else { cw = W; ch = W / aspectWH; }
  // zoom > 1 shrinks the crop (zoom in); zoom < 1 enlarges it (zoom out,
  // matching the live preview's zoom-out behavior — see §7), so clamp back
  // to the upright canvas's own bounds since there's no buffer data beyond it.
  cw = Math.min(W, cw / zoom);
  ch = Math.min(H, ch / zoom);
  const cx = W / 2, cy = H / 2;
  let sx = cx - cw / 2, sy = cy - ch / 2;
  sx = Math.max(0, Math.min(W - cw, sx));
  sy = Math.max(0, Math.min(H - ch, sy));
  return { sx, sy, sw: cw, sh: ch };
}

async function capturePhoto() {
  if (state.restarting) { toast('Camera is restarting — try again in a moment'); return; }
  if (state.capturing) return;
  const video = $('#video');
  if (!video || !video.videoWidth) { toast('Camera not ready yet'); return; }
  state.capturing = true;
  const btn = $('#btnShutter');
  if (btn) btn.disabled = true;

  try {
    const rotation = effectiveRotation();
    const landscape = wantLandscapePhoto();

    const upright = makeUprightCanvas(video, video.videoWidth, video.videoHeight, rotation);
    const aspect = landscape ? ASPECT_LONG_SHORT_LANDSCAPE : 1 / ASPECT_LONG_SHORT_PORTRAIT;
    const crop = cropUprightCanvas(upright, aspect, state.zoom);

    const MAX_EDGE = 2000;
    let outW, outH;
    if (crop.sw >= crop.sh) { outW = Math.min(MAX_EDGE, crop.sw); outH = outW * crop.sh / crop.sw; }
    else { outH = Math.min(MAX_EDGE, crop.sh); outW = outH * crop.sw / crop.sh; }
    outW = Math.max(1, Math.round(outW));
    outH = Math.max(1, Math.round(outH));

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = outW; finalCanvas.height = outH;
    const fctx = finalCanvas.getContext('2d');
    fctx.drawImage(upright, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);

    const settings = state.settings;
    const pos = state.position;
    const place = state.place;
    const now = new Date();
    const mapBoxPx = Math.round(Math.max(60, Math.min(outW, outH) * 0.20));

    let mapCanvas = null;
    if (settings.showMap && settings.mapStyle !== 'none' && pos) {
      try { mapCanvas = await renderMapThumbnail(mapBoxPx, pos.lat, pos.lon, settings.mapStyle); }
      catch (e) { mapCanvas = null; }
    }

    const data = {
      title: place ? place.title : (pos ? 'Unknown location' : 'No GPS fix'),
      addrLine: settings.showAddress ? (place ? place.addrLine : (pos ? 'Address unavailable' : '')) : '',
      flag: place ? flagEmoji(place.countryCode) : '',
      coordsText: pos ? formatCoords(pos.lat, pos.lon, settings.coordFormat) : '',
      extraText: pos ? formatExtra(pos) : '',
      datetimeText: formatDatetime(now, settings.datetimeFormat),
      plusCode: pos ? shortPlusCode(pos.lat, pos.lon) : '',
      watermark: settings.watermark || '',
      mapCanvas,
    };

    drawStampBar(fctx, outW, outH, data, settings);

    const quality = parseFloat(settings.quality) || 0.9;
    let dataUrl;
    try {
      dataUrl = finalCanvas.toDataURL('image/jpeg', quality);
    } catch (e) {
      // Tainted canvas — most likely a map tile without permissive CORS.
      // Redraw without the map image rather than failing the capture.
      data.mapCanvas = null;
      fctx.clearRect(0, 0, outW, outH);
      fctx.drawImage(upright, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
      drawStampBar(fctx, outW, outH, data, settings);
      dataUrl = finalCanvas.toDataURL('image/jpeg', quality);
      toast('Map thumbnail unavailable — saved without it');
    }

    state.lastCapture = { dataUrl, timestamp: Date.now(), lat: pos ? pos.lat : null, lon: pos ? pos.lon : null };
    $('#previewImg').src = dataUrl;
    showScreen('preview');
  } finally {
    state.capturing = false;
    if (btn) btn.disabled = false;
  }
}

/* ---------------------------------------------------------------------
   11. Local storage (IndexedDB) + share/save helpers
   --------------------------------------------------------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('geocam-db', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function savePhotoToGallery(dataUrl, meta) {
  const db = state.db || (state.db = await openDb());
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').add(Object.assign({ dataUrl, timestamp: Date.now() }, meta));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllPhotos() {
  const db = state.db || (state.db = await openDb());
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readonly');
    const req = tx.objectStore('photos').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp - a.timestamp));
    req.onerror = () => reject(req.error);
  });
}

async function deletePhoto(id) {
  const db = state.db || (state.db = await openDb());
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/data:(.*);base64/)[1];
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
  try {
    const blob = dataUrlToBlob(dataUrl);
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'GeoCam photo' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.warn('Share failed, falling back to download', e);
  }
  downloadDataUrl(dataUrl, filename);
}

/* ---------------------------------------------------------------------
   12. Gallery UI
   --------------------------------------------------------------------- */

async function refreshGallery() {
  const photos = await getAllPhotos();
  const grid = $('#galleryGrid');
  grid.innerHTML = '';
  $('#galleryEmpty').classList.toggle('hidden', photos.length > 0);
  for (const p of photos) {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    const img = document.createElement('img');
    img.src = p.dataUrl;
    img.loading = 'lazy';
    img.alt = 'Saved photo';
    div.appendChild(img);
    div.addEventListener('click', () => openViewer(p));
    grid.appendChild(div);
  }
}

function openViewer(photo) {
  state.currentViewerId = photo.id;
  state.currentViewerDataUrl = photo.dataUrl;
  $('#viewerImg').src = photo.dataUrl;
  showScreen('viewer');
}

/* ---------------------------------------------------------------------
   13. Wiring
   --------------------------------------------------------------------- */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW registration failed', err));
  }
}

function bindEvents() {
  $('#btnSettings').addEventListener('click', () => showScreen('settings'));
  $('#btnSettingsBack').addEventListener('click', () => showScreen('camera'));
  $('#btnGallery').addEventListener('click', () => showScreen('gallery'));
  $('#btnGalleryBack').addEventListener('click', () => showScreen('camera'));
  $('#btnShutter').addEventListener('click', capturePhoto);

  $('#btnFlip').addEventListener('click', async () => {
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    applyZoom(1); // different FOV per camera — a chosen zoom has no meaning across the flip
    await startCamera();
  });

  $('#btnGrid').addEventListener('click', () => {
    const canvas = $('#gridOverlay');
    canvas.classList.toggle('show');
    if (canvas.classList.contains('show')) drawGridOverlay();
  });

  $all('.zoom-chip').forEach(btn => btn.addEventListener('click', () => applyZoom(parseFloat(btn.dataset.zoom))));
  $('#zoomSlider').addEventListener('input', (e) => applyZoom(parseFloat(e.target.value)));

  $('#btnDiscard').addEventListener('click', () => { state.lastCapture = null; showScreen('camera'); });
  $('#btnShare').addEventListener('click', () => {
    if (state.lastCapture) shareDataUrl(state.lastCapture.dataUrl, `geocam_${state.lastCapture.timestamp}.jpg`);
  });
  $('#btnSave').addEventListener('click', async () => {
    if (!state.lastCapture) return;
    await savePhotoToGallery(state.lastCapture.dataUrl, { lat: state.lastCapture.lat, lon: state.lastCapture.lon });
    downloadDataUrl(state.lastCapture.dataUrl, `geocam_${state.lastCapture.timestamp}.jpg`);
    toast('Saved to gallery and downloads');
    showScreen('camera');
  });

  $('#btnViewerBack').addEventListener('click', () => showScreen('gallery'));
  $('#btnViewerShare').addEventListener('click', () => {
    if (state.currentViewerDataUrl) shareDataUrl(state.currentViewerDataUrl, `geocam_${state.currentViewerId}.jpg`);
  });
  $('#btnViewerSave').addEventListener('click', () => {
    if (state.currentViewerDataUrl) downloadDataUrl(state.currentViewerDataUrl, `geocam_${state.currentViewerId}.jpg`);
  });
  $('#btnViewerDelete').addEventListener('click', async () => {
    if (state.currentViewerId == null) return;
    await deletePhoto(state.currentViewerId);
    toast('Photo deleted');
    showScreen('gallery');
  });

  $('#btnResetSettings').addEventListener('click', () => {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveSettings();
    applySettingsToForm();
    updateLiveStamp();
    toast('Settings reset to defaults');
  });

  window.addEventListener('resize', () => {
    if ($('#gridOverlay').classList.contains('show')) drawGridOverlay();
  });
  // Cheap immediate recalculation so the preview's cover/zoom math stays
  // correct right away, ahead of the heavier debounced camera restart
  // below (which only matters once the orientation bucket actually flips).
  window.addEventListener('resize', updateCoverScale);
  window.addEventListener('resize', handleOrientationChange);
  window.addEventListener('orientationchange', handleOrientationChange);
}

async function init() {
  loadSettings();
  applySettingsToForm();
  bindSettingsForm();
  bindEvents();
  registerServiceWorker();
  startTiltSensing();
  startGeolocation();
  applyZoom(1);
  updateLiveStamp();
  if (state.settings.showGrid) { $('#gridOverlay').classList.add('show'); drawGridOverlay(); }

  await startCamera();

  setInterval(() => {
    updateOrientationBadge();
    updateLiveStamp();
    if (state.currentScreen === 'settings') updateDiagnostics();
    const a = physicalAngle();
    if (state.lastRestartAngle === undefined) state.lastRestartAngle = a;
    else if (a !== state.lastRestartAngle) {
      state.lastRestartAngle = a;
      handleOrientationChange();
    }
  }, 400);

  setInterval(updateLiveMapThumbThrottled, 4000);
}

document.addEventListener('DOMContentLoaded', init);
