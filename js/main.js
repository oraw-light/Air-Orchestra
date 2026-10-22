// Entry point: start screen, status messages, main loop and keyboard shortcuts
import { ctx, view } from "./view.js";
import { withTimeout } from "./util.js";
import { MODES, initAudio, chime, resumeAudio, audioState } from "./audio.js";
import { tracking, isModelReady, loadHandModel, startCamera, detect, readPose } from "./tracking.js";
import { music, handState, setMode, nextMode, updateControls, onDrum } from "./controls.js";
import { burst, updateVisuals, render, showLabel } from "./visuals.js";

const startEl = document.getElementById("start");
const startBtn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");
const hudEl = document.getElementById("hud");
const readoutEl = document.getElementById("readout");
let showDebug = false;
let noHandSince = performance.now();

// FPS tracking
let frames = 0, fpsTime = performance.now();

onDrum(burst);

// ---------- Status ----------
function setStatus(msg, isError = false) {
  if (!msg) { statusEl.classList.add("hidden"); return; }
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.remove("hidden");
}

// Current loading step, shown once the camera is up
let loadStage = "Loading hand tracking…";
function stage(msg) {
  loadStage = msg;
  const busy = statusEl.classList.contains("hidden") || statusEl.classList.contains("error")
    || statusEl.textContent.startsWith("Waiting for camera");
  if (!busy) setStatus(msg);
}

// ---------- Startup ----------
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Loading…";
  // Audio must be created inside the click so the browser lets it play
  if (!music.inst) { initAudio(); setMode(0); }
  resumeAudio();
  // Load the model while the camera starts
  const modelLoad = loadHandModel(stage);
  try {
    setStatus("Waiting for camera… allow access in the prompt near the address bar.");
    await withTimeout(startCamera(), 45000, "Camera did not start. Close other apps using the camera, then Try Again.");
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = "Try Again";
    const blocked = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    const missing = err && (err.name === "NotFoundError" || err.name === "OverconstrainedError");
    setStatus(
      blocked ? "Camera blocked. Click the camera icon in the address bar, allow access, then press Try Again."
      : missing ? "No camera found. Plug one in or close other apps using it, then Try Again."
      : "Could not start camera: " + (err && err.message ? err.message : err), true);
    return;
  }
  try {
    if (!isModelReady()) setStatus(loadStage);
    await modelLoad;
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = "Try Again";
    setStatus("Hand tracking failed to load: " + (err && err.message ? err.message : err), true);
    return;
  }
  startEl.classList.add("hidden");
  showLabel();
  document.body.classList.add("playing");
  setStatus("");
  noHandSince = performance.now();
  chime();
  requestAnimationFrame(loop);
});

window.addEventListener("pointerdown", resumeAudio);
window.addEventListener("keydown", resumeAudio);

// Surface unexpected errors instead of hanging silently
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));
window.addEventListener("error", (e) => setStatus("Error: " + e.message, true));

// ---------- Main loop ----------
let lastNow = performance.now();
// One bad frame must never freeze the app: log it, reset the canvas state, keep going
function loop(now) {
  try {
    frame(now);
  } catch (err) {
    console.error(err);
    ctx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(loop);
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  detect(now);
  updateControls(now, dt);
  updateVisuals(dt);
  render(now, dt);
  updateStatus(now);

  frames++;
  if (now - fpsTime >= 500) {
    const fps = Math.round(frames * 1000 / (now - fpsTime));
    frames = 0; fpsTime = now;
    hudEl.textContent = `${fps} fps${tracking.swapHands ? " · swapped" : ""}`;
  }

  if (showDebug) {
    readoutEl.textContent =
      `${MODES[music.mode].name}\n` +
      `vol ${Math.round(music.vol * 100)}% · tone ${Math.round(music.bright * 100)}%\n` +
      `audio: ${audioState()} · playing: ${music.playing}\n` +
      `left hand: ${handLabel("left")}\n` +
      `right hand: ${handLabel("right")}`;
  }
}

function updateStatus(now) {
  if (audioState() !== "running") {
    if (statusEl.dataset.kind !== "audio") {
      setStatus("Sound is paused by the browser. Click anywhere to turn it on.", true);
      statusEl.dataset.kind = "audio";
    }
    return; // audio warning takes priority
  }
  if (statusEl.dataset.kind === "audio") { setStatus(""); statusEl.dataset.kind = ""; }

  // No-hands message after a short grace period
  if (tracking.hands.length) {
    noHandSince = now;
    if (statusEl.dataset.kind === "nohands") { setStatus(""); statusEl.dataset.kind = ""; }
  } else if (now - noHandSince > 1500 && statusEl.dataset.kind !== "nohands") {
    setStatus("No hands detected. Raise your hands in front of the camera.");
    statusEl.dataset.kind = "nohands";
  }
}

function handLabel(side) {
  const h = tracking.hands.find(x => x.side === side);
  if (!h) return "not seen";
  return readPose(h.pts) + (handState[side].pinched ? " · pinch" : "");
}

// ---------- Keys ----------
window.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  } else if (e.key === "h" || e.key === "H") {
    tracking.swapHands = !tracking.swapHands;
  } else if (e.key === "d" || e.key === "D") {
    showDebug = !showDebug;
    readoutEl.classList.toggle("show", showDebug);
  } else if (e.key === "m" || e.key === "M") {
    if (music.inst) nextMode(); // keyboard fallback for testing
  }
});
