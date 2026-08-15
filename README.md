# GeoCam — GPS Map Camera (PWA)

A lightweight clone of the "GPS Map Camera" app: it stamps your photos with
your GPS coordinates, address, a small map thumbnail, and the date/time —
directly in your phone's browser, installable to your home screen like a
real app. No app store, no build tools, no account needed.

## What it does

- Live camera preview (front/back) with a live preview of the stamp that
  will be burned into your photo
- On capture, bakes into the photo, styled like the classic geotag-camera
  stamp layout: a bold place name (locality, state, country), country flag,
  a Plus Code + full address (reverse-geocoded), GPS coordinates, a small
  map thumbnail with a pin (standard street map or satellite), date & time
  with the day name and GMT offset, and an optional custom watermark/logo
  text
- Settings screen: coordinate format, map style, date format, stamp theme
  (dark/light/minimal), which fields to show, custom text, photo quality
- Gallery: photos are saved locally on your device (IndexedDB) with
  save-to-downloads and native Share options
- Installable as a Progressive Web App (Add to Home Screen) with offline
  app-shell caching via a service worker

## IMPORTANT — this needs HTTPS to access your camera & GPS

Phone browsers only allow camera (`getUserMedia`) and precise location
access on a **secure context**: an `https://` URL, or `localhost`. It will
**not** work if you just double-tap `index.html` and open it as a local
file on your phone. You need to serve these files over HTTPS. Easiest free
options, pick one:

### Option A — GitHub Pages (recommended, free, permanent link)
1. Create a free GitHub account if you don't have one, and a new repository
   (e.g. `geocam`).
2. Upload all files in this folder (`index.html`, `style.css`, `app.js`,
   `manifest.json`, `service-worker.js`, `icons/`) to the repository.
3. In the repo, go to **Settings → Pages**, set source to the `main`
   branch (root), save.
4. GitHub gives you a URL like `https://yourname.github.io/geocam/` —
   open that on your phone, allow camera & location, and optionally tap
   "Add to Home Screen" in your browser's share/menu.

### Option B — Netlify Drop (free, no account needed for a quick link)
1. Go to `https://app.netlify.com/drop` in a desktop browser.
2. Drag this whole folder onto the page.
3. Netlify gives you an `https://...netlify.app` link instantly — open it
   on your phone.

### Option C — Test locally over your Wi-Fi (quick, temporary)
On a computer on the **same Wi-Fi** as your phone:
```
cd gps-map-camera-pwa
python3 -m http.server 8000
```
Then use a free tunneling tool (e.g. `ngrok http 8000`, or VS Code's
"Go Live" + a tunnel extension) to get a temporary `https://` URL, since
plain `http://your-computer-ip:8000` will NOT have camera/GPS access on
most phones (only `localhost` is exempt from the HTTPS rule, and that's
not reachable from your phone).

## Installing to your home screen

Once you open the HTTPS link on your phone:
- **Android (Chrome):** tap the ⋮ menu → "Add to Home screen" / "Install app"
- **iPhone (Safari):** tap the Share icon → "Add to Home Screen"

It will then launch full-screen like a normal app.

## Notes & limitations (being upfront)

- **Map thumbnail source:** live preview always shows real map tiles
  (OpenStreetMap for "Standard", Esri World Imagery for "Satellite").
  When *baking* the map into the exported photo, the browser requires the
  tile server to allow cross-origin pixel reads (CORS). Esri's satellite
  tiles support this, so satellite photos usually get a real embedded map.
  OpenStreetMap's standard tile server does not reliably send CORS
  headers, so standard-style exported photos may fall back to a simple
  stylized map/pin graphic instead of the real street tile — the address,
  coordinates, and date/time are unaffected either way.
- **Reverse geocoding** uses the free OpenStreetMap Nominatim API (no key
  needed), which is rate-limited and intended for light personal use.
- **Plus Code** is computed on-device using Google's own open, published
  Open Location Code standard/algorithm (not a call to a Google API) — it's
  accurate for the real GPS fix, shortened to a local-style short code the
  same way Google Maps/Photos display one once you're inside a named
  locality.
- **Branding on the stamp:** the small pill badge says "GeoCam" (this app's
  own name) rather than a third-party app's name, and the map thumbnail's
  small provider watermark says "OSM" or "Esri" — the actual source of that
  map data — rather than "Google", since this app isn't using Google Maps
  tiles and mislabeling the source wouldn't be accurate. Everything else
  (layout, Plus Code, coordinates, date format) matches the reference style
  closely.
- **Weather, compass, QR scanner, cloud (Drive) sync** from the original
  app are not included in this version — this build focuses on the core
  geotagging camera. Let me know if you'd like any of those added next.
- All your photos stay on your device (IndexedDB); nothing is uploaded
  anywhere by this app.

## File structure

```
gps-map-camera-pwa/
├── index.html          # app screens (camera, preview, settings, gallery)
├── style.css            # styling
├── app.js               # camera, GPS, geocoding, map tiles, capture, storage
├── manifest.json         # PWA install metadata
├── service-worker.js     # offline app-shell caching
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md             # this file
```
