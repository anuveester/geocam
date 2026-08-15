# GeoCam — GPS Map Camera

A zero-build, zero-backend Progressive Web App that stamps your photos with
GPS location, address, a small map thumbnail, and the date/time — burned
permanently into the image, the classic "geotag camera" look.

Everything runs client-side. Photos are stored only in the browser's own
IndexedDB and never uploaded anywhere. The only network calls are reverse
geocoding (OpenStreetMap Nominatim) and map tile images (OpenStreetMap /
Esri) — both free, no API key required.

## Files

```
index.html          all screens (camera / preview / settings / gallery / viewer)
style.css            all styling
app.js               all application logic
manifest.json        PWA manifest (orientation: "any")
service-worker.js    offline app-shell caching
icons/icon-192.png   home-screen icon
icons/icon-512.png   home-screen icon
```

No `npm install`, no bundler, no build step. Open a file in any text editor,
edit, save, reload the browser.

## Why HTTPS is required

The camera (`getUserMedia`) and precise Geolocation APIs only work in a
"secure context" — HTTPS or `localhost`. This is a browser/platform
requirement, not a bug in this app. Plain `http://` (other than localhost)
will not work on a phone.

## Quick local test (same Wi-Fi network)

1. From this folder, run a tiny local HTTPS-free dev server for **desktop
   browser testing only** (camera/GPS will still require HTTPS on a real
   phone — see deployment below):
   ```
   npx serve .
   ```
   or
   ```
   python3 -m http.server 8080
   ```
2. Open the printed `http://localhost:PORT` address in your desktop
   browser. `localhost` counts as a secure context, so camera/GPS will
   work there even over plain HTTP.
3. To test on an actual phone, you need real HTTPS — use the GitHub Pages
   deployment below (it's free and takes a couple of minutes), or a
   tunnifying tool such as `npx localtunnel` / `ngrok` pointed at your
   local server.

## Deploy to GitHub Pages (recommended — free, permanent HTTPS URL)

1. Create a new GitHub repository (public or private) and push these files
   to its default branch (e.g. `main`), at the repository root.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to "Deploy from a branch",
   pick the `main` branch and `/ (root)` folder, then **Save**.
4. Wait a minute or two, then open the URL GitHub gives you, typically:
   `https://<your-username>.github.io/<repo-name>/`
5. On your phone, open that URL in the browser, allow camera and location
   access when prompted, and (optional but recommended) use the browser's
   "Add to Home Screen" / "Install app" option so it behaves like a native
   app.

There is no separate deploy step beyond a normal `git push` — GitHub Pages
serves the repository's files directly.

## Deploy via Netlify Drop (alternative, no git required)

1. Go to Netlify's drag-and-drop deploy page.
2. Drag this whole project folder onto the page.
3. Netlify gives you an HTTPS URL immediately — open it on your phone.

## After every update

1. Bump `APP_BUILD` in `app.js` **and** `CACHE_NAME` in `service-worker.js`
   together, even for a small change. The Settings → Diagnostics panel
   prints the build number, so you can immediately tell whether a device
   is running stale cached code or a genuinely new bug — screenshot that
   panel first when something "isn't working".
2. Commit and push (for GitHub Pages) or re-drag the folder (for Netlify
   Drop).
3. On your phone, fully close (or remove and re-add) the home-screen
   shortcut so the new service worker is picked up immediately, rather
   than waiting for the next natural cache-refresh cycle.

## Settings overrides for orientation quirks

Some phones' sensors or camera pipelines behave unusually. If photos come
out rotated or the wrong shape, use **Settings → Orientation overrides**:

- **Saved photo orientation**: force every photo to always be portrait or
  always landscape, instead of following how the phone is held.
- **Scene rotation fix**: manually pick a fixed correction angle (0° / 90°
  / 180° / 270°) instead of trusting the motion sensor.

**Settings → Diagnostics** shows live build number, camera buffer size,
raw accelerometer readings, computed tilt angle, and what the current
orientation settings resolve to — useful for describing exactly what a
device is reporting without needing devtools.

## Privacy

Photos and their embedded location data never leave your device unless you
explicitly tap Share or Save. Reverse geocoding sends only your current
coordinates (not the photo) to OpenStreetMap's Nominatim service in order
to look up an address.
