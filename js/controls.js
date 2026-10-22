// Turns hand positions and gestures into music
import { tracking, palmCenter, readPose, extended } from "./tracking.js";
import { view } from "./view.js";
import { clamp01, dist } from "./util.js";
import { NOTES, MODES, midiToFreq, kick, snare, setMelody } from "./audio.js";

// Musical state (also read by the visuals)
export const music = {
  mode: 0,
  inst: null,
  noteIdx: 7,        // index into NOTES
  playing: false,    // left hand present
  vol: 0.7,          // 0..1, changed only with the V-sign gesture
  volAdjusting: false,
  bright: 0.6,       // 0..1 from right hand X
  lastPluck: 0
};
const smooth = { pitchY: 0.5, volY: 0.7, brightX: 0.6 };
let volTarget = 0.7;
let lastRightSeen = 0;
export const handState = { left: newHandState(), right: newHandState() };

function newHandState() {
  return { present: false, pinched: false, pose: "none", cand: "none", candSince: 0, volAnchorY: null };
}

// V sign: index and middle up, ring and pinky folded
function isPeace(p) {
  return extended(p, 8, 6) && extended(p, 12, 10) && !extended(p, 16, 14) && !extended(p, 20, 18);
}

let drumListener = () => {};
// fn(x, y, kind) runs on every drum hit, kind is "kick" or "snare"
export function onDrum(fn) { drumListener = fn; }

export function setMode(i) {
  music.mode = i;
  if (music.inst) music.inst.dispose();
  music.inst = MODES[i].make(midiToFreq(NOTES[music.noteIdx]));
}

export function nextMode() { setMode((music.mode + 1) % MODES.length); }

// Pinch = thumb tip meets index tip while the other fingers stay up (so a fist doesn't count)
function updatePinch(st, p, side) {
  const size = dist(p[0], p[9]) || 1;
  const r = dist(p[4], p[8]) / size;
  let others = 0;
  for (const [tip, pip] of [[12, 10], [16, 14], [20, 18]]) if (extended(p, tip, pip)) others++;
  if (!st.pinched && r < 0.22 && others >= 2) {
    st.pinched = true;
    if (side === "left") kick(); else snare();
    drumListener((p[4].x + p[8].x) / 2, (p[4].y + p[8].y) / 2, side === "left" ? "kick" : "snare");
  } else if (st.pinched && r > 0.38) {
    st.pinched = false;
  }
}

// Fist "grab" cycles the instrument; pose must hold 200 ms to count
function updatePose(st, p, now) {
  const pose = readPose(p);
  if (pose !== st.cand) { st.cand = pose; st.candSince = now; return; }
  if (pose === st.pose || pose === "other" || now - st.candSince < 200) return;
  if (st.pose === "open" && pose === "fist") nextMode();
  st.pose = pose;
}

export function updateControls(now, dt) {
  const { W, H } = view;
  const k = (tau) => 1 - Math.exp(-dt / tau); // frame-rate independent smoothing
  const left = tracking.hands.find(h => h.side === "left");
  const right = tracking.hands.find(h => h.side === "right");

  for (const side of ["left", "right"]) {
    const h = side === "left" ? left : right;
    const st = handState[side];
    if (!h) { if (st.present) handState[side] = newHandState(); continue; }
    st.present = true;
    updatePinch(st, h.pts, side);
    if (side === "right") updatePose(st, h.pts, now);
  }

  if (left) {
    const c = palmCenter(left.pts);
    smooth.pitchY += (clamp01((0.88 - c.y / H) / 0.76) - smooth.pitchY) * k(0.07);
    // Hysteresis: only move to a new note once clearly past the boundary
    const f = smooth.pitchY * (NOTES.length - 1);
    if (Math.abs(f - music.noteIdx) > 0.65) {
      music.noteIdx = Math.round(f);
      music.inst.setFreq(midiToFreq(NOTES[music.noteIdx]));
      if (music.playing) { music.inst.pluck(); music.lastPluck = now; }
    }
  }
  music.volAdjusting = false;
  if (right) {
    const c = palmCenter(right.pts);
    const st = handState.right;
    // Volume clutch: only while the V sign is held does moving up/down change it.
    // Relative to where the gesture started, so it never jumps; release to lock.
    if (isPeace(right.pts)) {
      if (st.volAnchorY !== null) volTarget = clamp01(volTarget + (st.volAnchorY - c.y) / (H * 0.4));
      st.volAnchorY = c.y;
      music.volAdjusting = true;
    } else {
      st.volAnchorY = null;
    }
    smooth.brightX += (clamp01((c.x / W - 0.3) / 0.65) - smooth.brightX) * k(0.08);
    lastRightSeen = now;
  } else if (now - lastRightSeen > 600) {
    smooth.brightX += (0.6 - smooth.brightX) * k(0.5);
  }
  smooth.volY += (volTarget - smooth.volY) * k(0.08);
  music.vol = smooth.volY;
  music.bright = smooth.brightX;

  const wasPlaying = music.playing;
  music.playing = !!left;
  if (music.playing && (!wasPlaying || (music.inst.repeat && now - music.lastPluck > music.inst.repeat * 1000))) {
    music.inst.pluck(); music.lastPluck = now;
  }

  setMelody(music.playing, music.vol, music.bright);
}
