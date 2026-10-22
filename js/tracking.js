import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { video, view, coverRect } from "./view.js";
import { dist, withTimeout } from "./util.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Hand skeleton connections (MediaPipe 21-point layout)
export const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],        // thumb
  [0,5],[5,6],[6,7],[7,8],        // index
  [5,9],[9,10],[10,11],[11,12],   // middle
  [9,13],[13,14],[14,15],[15,16], // ring
  [13,17],[17,18],[18,19],[19,20],// pinky
  [0,17]
];

export const tracking = {
  hands: [],         // [{ side: "left"|"right", pts: [{x,y}] in screen px }]
  swapHands: false   // press H if left/right labels look reversed
};

let landmarker = null;
let modelLoad = null;
let lastVideoTime = -1;

export const isModelReady = () => landmarker !== null;

// Starts loading once; a failed load can be retried. onStage reports progress text.
export function loadHandModel(onStage) {
  if (!modelLoad) {
    modelLoad = createLandmarker(onStage);
    modelLoad.then((l) => { landmarker = l; }, () => { modelLoad = null; });
  }
  return modelLoad;
}

async function createLandmarker(onStage) {
  onStage("Loading hand tracking engine (1/2)…");
  const fileset = await withTimeout(FilesetResolver.forVisionTasks(WASM_URL), 30000,
    "Could not download the tracking engine (timeout). Check your connection.");
  onStage("Loading hand model (2/2)…");
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5
  });
  // GPU can hang on some drivers, so give it 12 s before falling back to CPU
  try {
    return await withTimeout(HandLandmarker.createFromOptions(fileset, opts("GPU")), 12000, "GPU init timeout");
  } catch (e) {
    console.warn("GPU delegate failed, falling back to CPU", e);
    onStage("GPU unavailable, using CPU hand tracking…");
    return await withTimeout(HandLandmarker.createFromOptions(fileset, opts("CPU")), 30000,
      "Hand model failed to start (timeout).");
  }
}

export async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error("Camera API unavailable. Serve the page over http://localhost (see instructions).");
    e.name = "SecurityError";
    throw e;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}

export function detect(now) {
  if (!landmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return; // only run on new camera frames
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, now);
  const { ox, oy, dw, dh } = coverRect();
  const hands = [];
  for (let i = 0; i < res.landmarks.length; i++) {
    // Tested on a real webcam: with the raw (unmirrored) camera frame,
    // MediaPipe's label matches the player's actual hand.
    const label = res.handednesses[i][0].categoryName;
    let side = label === "Left" ? "left" : "right";
    if (tracking.swapHands) side = side === "left" ? "right" : "left";
    const pts = res.landmarks[i].map(p => ({
      x: view.W - (ox + p.x * dw), // mirror to match the selfie view
      y: oy + p.y * dh
    }));
    hands.push({ side, pts });
  }
  // With both hands up, screen position is more reliable than the handedness label:
  // in the mirrored view the player's left hand is on the left side of the screen.
  if (hands.length === 2) {
    hands.sort((a, b) => palmCenter(a.pts).x - palmCenter(b.pts).x);
    hands[0].side = "left";
    hands[1].side = "right";
  }
  tracking.hands = hands;
}

// ---------- Hand geometry ----------
export function palmCenter(p) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += p[i].x; y += p[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

export function extended(p, tip, pip) { return dist(p[0], p[tip]) > dist(p[0], p[pip]) * 1.1; }

export function readPose(p) {
  let n = 0;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (extended(p, tip, pip)) n++;
  return n >= 3 ? "open" : n === 0 ? "fist" : "other";
}
