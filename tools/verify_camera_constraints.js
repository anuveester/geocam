'use strict';
/* Verifies idealCameraDims() (see spec §5d) by simulating the actual W3C
   MediaStream "fitness distance" constraint-selection algorithm against
   representative real-device supported-resolution lists, rather than
   reasoning about it in the abstract, per project spec §9.

   fitness(actual, ideal) = 0 if ideal is unspecified,
                             else |actual - ideal| / max(actual, ideal)
   Total fitness for a candidate = sum of fitness across width + height.
   The browser selects the candidate minimizing total fitness distance. */

const { loadApp } = require('./load_app');

function fitness(actual, ideal) {
  if (ideal == null) return 0;
  if (actual === 0 && ideal === 0) return 0;
  return Math.abs(actual - ideal) / Math.max(actual, ideal);
}

function selectBest(candidates, idealW, idealH) {
  let best = null, bestScore = Infinity;
  for (const [w, h] of candidates) {
    const score = fitness(w, idealW) + fitness(h, idealH);
    if (score < bestScore) { bestScore = score; best = [w, h]; }
  }
  return { pick: best, score: bestScore };
}

// Representative rear-camera list: dense, 4:3-native sensor (common on
// mid/high-end Android rear cameras) that also exposes cropped 16:9 modes.
const REAR_CAMERA_4_3_NATIVE = {
  label: 'rear camera, 4:3-native sensor',
  nativeAspect: 4 / 3,
  candidates: [
    [4000, 3000], [3264, 2448], [3072, 2304], [2592, 1944], [2048, 1536], [1600, 1200], [1280, 960], [640, 480],
    [3840, 2160], [3264, 1836], [2592, 1458], [1920, 1080], [1280, 720], [864, 480], [640, 360],
  ],
};

// Representative front/selfie-camera list: sparse, 16:9-native sensor with
// NO large native 4:3 mode — only small pre-cropped 4:3 subsets, matching
// the spec's specific callout that selfie sensors are the most exposed to
// this bug (limited resolution set, no true full-FOV mode outside 16:9).
const FRONT_CAMERA_16_9_NATIVE = {
  label: 'front/selfie camera, 16:9-native sensor',
  nativeAspect: 16 / 9,
  candidates: [
    [1920, 1080], [1280, 720], [640, 360],
    [1440, 1080], [960, 720], [640, 480], // pre-cropped 4:3 subsets — narrower FOV
  ],
};

function totalPixels([w, h]) { return w * h; }
function aspectOf([w, h]) { return w / h; }

function run() {
  const app = loadApp();
  let allOk = true;

  console.log('=== idealCameraDims() is orientation-independent ===');
  const d1 = app.idealCameraDims();
  const okShape = d1.width.ideal === d1.height.ideal && d1.width.ideal === 2560;
  console.log(`[${okShape ? 'PASS' : 'FAIL'}] idealCameraDims() = { width:{ideal:${d1.width.ideal}}, height:{ideal:${d1.height.ideal}} } — equal, orientation-neutral`);
  allOk = allOk && okShape;

  // A naive "ask for what I'm about to display" approach, matching a
  // modern tall phone screen (e.g. 1080x2400, far from any camera sensor's
  // native aspect ratio) — this is the pattern spec §5d says NOT to use.
  const NAIVE_PORTRAIT = [1080, 2400];
  const NAIVE_LANDSCAPE = [2400, 1080];
  const NEUTRAL = [d1.width.ideal, d1.height.ideal];

  for (const profile of [REAR_CAMERA_4_3_NATIVE, FRONT_CAMERA_16_9_NATIVE]) {
    console.log(`\n=== ${profile.label} ===`);
    const neutral = selectBest(profile.candidates, NEUTRAL[0], NEUTRAL[1]);
    const portrait = selectBest(profile.candidates, NAIVE_PORTRAIT[0], NAIVE_PORTRAIT[1]);
    const landscape = selectBest(profile.candidates, NAIVE_LANDSCAPE[0], NAIVE_LANDSCAPE[1]);

    const neutralAspect = aspectOf(neutral.pick);
    const neutralIsNativeAspect = Math.abs(neutralAspect - profile.nativeAspect) < 0.01;
    console.log(`  aspect-neutral ideal 2560x2560   -> picks ${neutral.pick[0]}x${neutral.pick[1]}  (fitness ${neutral.score.toFixed(3)}, aspect ${neutralAspect.toFixed(3)}, native-aspect=${neutralIsNativeAspect})`);
    console.log(`  naive portrait ideal 1080x2400   -> picks ${portrait.pick[0]}x${portrait.pick[1]}  (fitness ${portrait.score.toFixed(3)}, aspect ${aspectOf(portrait.pick).toFixed(3)})`);
    console.log(`  naive landscape ideal 2400x1080  -> picks ${landscape.pick[0]}x${landscape.pick[1]}  (fitness ${landscape.score.toFixed(3)}, aspect ${aspectOf(landscape.pick).toFixed(3)})`);

    // "Widest FOV" means native-aspect (uncropped sensor view), not
    // necessarily the single largest resolution entry — a 2592x1944 4:3
    // candidate has exactly the same field of view as a 4000x3000 one,
    // just a lower-resolution readout of it. The property that actually
    // matters is: did the fitness-distance algorithm land on the native
    // aspect family at all, rather than being pushed into a cropped one.
    const neutralOk = neutralIsNativeAspect;
    console.log(`  [${neutralOk ? 'PASS' : 'FAIL'}] aspect-neutral ideal selects a native-aspect (full sensor FOV) mode, not a cropped one`);
    allOk = allOk && neutralOk;

    if (profile === FRONT_CAMERA_16_9_NATIVE) {
      const portraitIsCropped = Math.abs(aspectOf(portrait.pick) - profile.nativeAspect) > 0.01;
      console.log(`  [${portraitIsCropped ? 'PASS (confirms the risk)' : 'INFO'}] naive portrait ideal selects a NON-native, pre-cropped narrower-FOV mode on the front camera — exactly the failure mode spec §5d warns against`);
      const neutralBeatsNaive = totalPixels(neutral.pick) >= totalPixels(portrait.pick);
      console.log(`  [${neutralBeatsNaive ? 'PASS' : 'FAIL'}] aspect-neutral pick has >= total pixels than the naive-portrait pick (${totalPixels(neutral.pick)} vs ${totalPixels(portrait.pick)})`);
      allOk = allOk && neutralBeatsNaive;
    }
  }

  console.log(allOk ? '\n>>> verify_camera_constraints.js: ALL PASS' : '\n>>> verify_camera_constraints.js: FAILURES DETECTED');
  process.exit(allOk ? 0 : 1);
}

run();
