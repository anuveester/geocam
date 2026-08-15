/* ==========================================================================
   GeoCam — GPS Map Camera (PWA)
   A lightweight clone of the "GPS Map Camera" style geotagging camera app.
   Everything runs client-side in the browser: camera capture (getUserMedia),
   live location (Geolocation API), reverse geocoding + map tiles (OpenStreetMap
   / Esri, both free & keyless), and local photo storage (IndexedDB).
   ========================================================================== */

/* ---------------------------- small utilities ---------------------------- */
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

  // Grey out the shutter until we actually have a GPS fix, so you can't
  // accidentally bake a blank/"Locating…" stamp into a photo.
  $('btn-capture').classList.toggle('waiting', geoState.lat === null);
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

// The app used to be orientation-locked to portrait (manifest.json), which
// pinned the screen so it never rotated even when you physically turned the
// phone sideways — the camera sensor rotated with your hand, but the video
// stream we asked for (and the screen showing it) didn't, so a "landscape"
// shot came out portrait-shaped with the scene rotated inside it. The app
// is no longer orientation-locked, so we now ask for stream dimensions that
// match however the phone is currently held, matching what portrait capture
// already did correctly.
function idealCameraDims() {
  const landscape = window.innerWidth > window.innerHeight;
  return landscape
    ? { width: { ideal: 1920 }, height: { ideal: 1080 } }
    : { width: { ideal: 1080 }, height: { ideal: 1920 } };
}

async function startCamera(facing = currentFacing) {
  stopCamera();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, ...idealCameraDims() },
      audio: false,
    });
    $('video').srcObject = mediaStream;
    currentFacing = facing;
    $('start-hint').classList.add('hidden');
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
// So after a rotation, restart the stream (once things settle) so the new
// video.videoWidth/videoHeight — and therefore the captured photo — actually
// match the orientation you're holding the phone in when you tap capture.
let orientationRestartTimer = null;
function handleOrientationChange() {
  if (!mediaStream) return;
  clearTimeout(orientationRestartTimer);
  orientationRestartTimer = setTimeout(() => {
    const cam = $('camera-screen');
    if (cam && cam.classList.contains('active')) startCamera(currentFacing);
  }, 400);
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
    // pin
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(mx + mapW / 2, my + mapSize / 2 - 10 * scale, 13 * scale, 0, Math.PI * 2);
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

  // The box height is now a fixed 25% of the photo — vertically center the
  // text block inside it (rather than always hugging the top), so a short
  // address doesn't leave a slab of empty space at the bottom of the card.
  let estLines = 0;
  if (settings.showAddress) estLines += 1.4;
  if (settings.showAddress && settings.showFlag && geoState.flag) estLines += 0.75;
  if (settings.showAddress) estLines += 1;
  if (settings.showCoords) estLines += 1;
  if (settings.showExtra && formatExtra()) estLines += 0.85;
  if (settings.showDatetime) estLines += 1;
  if (settings.customText) estLines += 0.85;
  const estContentH = estLines * lineGap;
  const availH = boxH - boxPad * 2;
  let y = boxTop + boxPad + Math.max(0, (availH - estContentH) / 2);

  if (settings.showAddress) {
    ctx.font = `800 ${32 * scale}px sans-serif`;
    const wrapped = wrapText(ctx, resolvedTitle(), innerX, y, boxW - boxPad * 2, lineGap);
    y += lineGap * wrapped;
    if (settings.showFlag && geoState.flag) {
      ctx.font = `${24 * scale}px sans-serif`;
      ctx.fillText(geoState.flag, innerX, y);
      y += lineGap * 0.8;
    }
  }
  const innerMaxW = boxW - boxPad * 2;
  ctx.font = `500 ${23 * scale}px sans-serif`;
  if (settings.showAddress) {
    const plusPrefix = settings.showPlusCode && geoState.plusCode ? `${geoState.plusCode}, ` : '';
    fillTextEllipsis(ctx, plusPrefix + resolvedAddrLine(), innerX, y, innerMaxW);
    y += lineGap * 0.85;
  }
  if (settings.showCoords) { fillTextEllipsis(ctx, formatCoords(), innerX, y, innerMaxW); y += lineGap * 0.85; }
  if (settings.showExtra && formatExtra()) { ctx.font = `400 ${19 * scale}px sans-serif`; fillTextEllipsis(ctx, formatExtra(), innerX, y, innerMaxW); y += lineGap * 0.8; }
  ctx.font = `500 ${23 * scale}px sans-serif`;
  if (settings.showDatetime) { fillTextEllipsis(ctx, formatDatetime(new Date()), innerX, y, innerMaxW); y += lineGap * 0.85; }
  if (settings.customText) { ctx.font = `italic 400 ${19 * scale}px sans-serif`; fillTextEllipsis(ctx, settings.customText, innerX, y, innerMaxW); }
  ctx.restore();

  ctx.restore();
}
// Draws text on one line, shortening it with an ellipsis if it's wider than maxWidth
// (used for lines we deliberately keep single-line, unlike the wrapped title).
function fillTextEllipsis(ctx, text, x, y, maxWidth) {
  text = String(text || '');
  if (ctx.measureText(text).width <= maxWidth) { ctx.fillText(text, x, y); return; }
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  ctx.fillText(text.slice(0, lo).trimEnd() + '…', x, y);
}
// Wraps text to at most 2 lines, drawing it and returning how many lines were used.
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || '').split(' ');
  let line = '', lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + ' ';
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, y + lines * lineHeight);
      line = words[i] + ' ';
      lines++;
      if (lines >= 2) { ctx.fillText(line.trim() + '…', x, y + lines * lineHeight); return lines + 1; }
    } else {
      line = test;
    }
  }
  ctx.fillText(line.trim(), x, y + lines * lineHeight);
  return lines + 1;
}

async function capturePhoto() {
  const video = $('video');
  if (!video.videoWidth) { toast('Camera not ready yet'); return; }
  if (geoState.lat === null) {
    toast('Still finding your GPS location — move near a window or outdoors and try again', 3200);
    return;
  }
  const canvas = $('hidden-canvas');
  const W = video.videoWidth, H = video.videoHeight;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // mirror front camera for a natural-looking result
  if (currentFacing === 'user') {
    ctx.translate(W, 0); ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

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
    if (currentFacing === 'user') { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  });
  $('btn-flip').addEventListener('click', () => startCamera(currentFacing === 'environment' ? 'user' : 'environment'));
  $('btn-capture').addEventListener('click', capturePhoto);
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

  // Try to auto-start; browsers that need a user gesture will fall back to the button.
  try {
    await startCamera();
    startGeolocation();
  } catch (e) {
    $('start-hint').classList.remove('hidden');
  }
}
init();
