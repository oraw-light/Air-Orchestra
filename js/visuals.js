// Everything drawn on the canvas, plus the big note label
import { ctx, view } from "./view.js";
import { dist } from "./util.js";
import { NOTES, MODES, midiToName, readLevel } from "./audio.js";
import { CONNECTIONS, tracking } from "./tracking.js";
import { music } from "./controls.js";

const labelEl = document.getElementById("label");
const noteEl = document.getElementById("noteName");
const instEl = document.getElementById("instName");

const MAX_PARTICLES = 1000;
const particles = Array.from({ length: MAX_PARTICLES }, () => ({ life: 0 })); // ring buffer
let particlePtr = 0;
const trails = { left: [], right: [] }; // recent index fingertip positions
const ripples = [];     // drum hit markers: { x, y, t, kind, hue }
let hue = 200;          // smoothed colour that follows the pitch
let level = 0;          // smoothed loudness for the background pulse
let flash = 0, flashHue = 200, shake = 0;

// Pre-rendered glow sprites, one per 10° of hue, so particles are cheap to draw
const spriteCache = new Map();
function glowSprite(h) {
  const b = ((Math.round(h / 10) % 36) + 36) % 36;
  let s = spriteCache.get(b);
  if (!s) {
    s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `hsla(${b * 10}, 100%, 92%, 1)`);
    grd.addColorStop(0.2, `hsla(${b * 10}, 100%, 68%, 0.85)`);
    grd.addColorStop(0.5, `hsla(${b * 10}, 100%, 55%, 0.25)`);
    grd.addColorStop(1, `hsla(${b * 10}, 100%, 50%, 0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    spriteCache.set(b, s);
  }
  return s;
}

// Low notes are violet, high notes are amber
const pitchHue = (idx) => 265 - (idx / (NOTES.length - 1)) * 235;

function spawn(x, y, vx, vy, life, size, h) {
  const p = particles[particlePtr];
  particlePtr = (particlePtr + 1) % MAX_PARTICLES;
  p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = p.max = life; p.size = size; p.hue = h;
}

export function burst(x, y, kind) {
  const isKick = kind === "kick";
  const h = isKick ? hue : 30;
  const n = isKick ? 40 : 56;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = isKick ? 120 + Math.random() * 360 : 260 + Math.random() * 640;
    spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
      isKick ? 0.5 + Math.random() * 0.5 : 0.25 + Math.random() * 0.35,
      isKick ? 22 + Math.random() * 20 : 10 + Math.random() * 10,
      h + (Math.random() - 0.5) * 30);
  }
  ripples.push({ x, y, t: performance.now(), kind, hue: h });
  flash = Math.max(flash, isKick ? 0.32 : 0.2);
  flashHue = h;
  if (isKick) shake = 9;
}

function updateTrail(side, hand, h) {
  const tr = trails[side];
  if (!hand) { tr.length = 0; return; }
  const tip = hand.pts[8];
  const prev = tr.length ? tr[tr.length - 1] : tip;
  // Fill the gap between frames so fast moves leave a continuous trail
  const n = Math.min(14, 2 + Math.floor(dist(prev, tip) / 6));
  const loud = 0.6 + music.vol * 0.8;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    spawn(prev.x + (tip.x - prev.x) * f + (Math.random() - 0.5) * 6,
          prev.y + (tip.y - prev.y) * f + (Math.random() - 0.5) * 6,
          (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50 - 25,
          0.5 + Math.random() * 0.6, (14 + Math.random() * 18) * loud,
          h + (Math.random() - 0.5) * 24);
  }
  tr.push({ x: tip.x, y: tip.y });
  if (tr.length > 18) tr.shift();
}

// Advance colour, loudness, flashes and trails by one frame
export function updateVisuals(dt) {
  const rms = readLevel();
  const tau = rms > level ? 0.03 : 0.25; // fast attack, slow release
  level += (rms - level) * (1 - Math.exp(-dt / tau));
  hue += (pitchHue(music.noteIdx) - hue) * (1 - Math.exp(-dt / 0.15));
  flash *= Math.exp(-dt / 0.12);
  shake *= Math.exp(-dt / 0.08);
  updateTrail("left", tracking.hands.find(h => h.side === "left"), hue);
  updateTrail("right", tracking.hands.find(h => h.side === "right"), hue + 40);
}

// ---------- Rendering ----------
// The camera image is never drawn: hands appear only as glowing skeleton lines
function drawBackground() {
  const { W, H } = view;
  ctx.fillStyle = "#04050a";
  ctx.fillRect(0, 0, W, H);

  // Glow that breathes with the volume, tinted by the current pitch
  const g = ctx.createRadialGradient(W / 2, H * 0.6, 0, W / 2, H * 0.6, Math.max(W, H) * 0.7);
  const a = Math.min(0.55, 0.05 + level * 0.45);
  g.addColorStop(0, `hsla(${hue}, 90%, 50%, ${a})`);
  g.addColorStop(1, `hsla(${hue}, 90%, 30%, 0)`);
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (flash > 0.01) {
    ctx.fillStyle = `hsla(${flashHue}, 100%, 60%, ${flash * 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = view.vignette;
  ctx.fillRect(0, 0, W, H);
}

// Pitch ladder on the left, volume and tone meters for the right hand
const noteY = (i) => (0.88 - (i / (NOTES.length - 1)) * 0.76) * view.H;
function drawGuides() {
  const { W, H } = view;
  ctx.font = "600 11px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let i = 0; i < NOTES.length; i++) {
    const y = noteY(i);
    const cur = music.playing && i === music.noteIdx;
    ctx.globalAlpha = cur ? 0.9 : i % 5 === 0 ? 0.18 : 0.08;
    ctx.strokeStyle = cur ? `hsl(${hue}, 100%, 70%)` : "#ffffff";
    ctx.lineWidth = cur ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(44, y);
    ctx.lineTo(W * 0.4, y);
    ctx.stroke();
    ctx.globalAlpha = cur ? 1 : 0.35;
    ctx.fillStyle = cur ? `hsl(${hue}, 100%, 75%)` : "#ffffff";
    ctx.fillText(midiToName(NOTES[i]), 12, y);
  }

  const meter = `hsl(${hue + 40}, 100%, 70%)`;
  const vx = W - 22, top = H * 0.15, bot = H * 0.85;
  // Volume meter widens and shows the percentage while the V-sign gesture is held
  const vw = music.volAdjusting ? 10 : 4;
  ctx.globalAlpha = 0.15; ctx.fillStyle = "#ffffff";
  ctx.fillRect(vx - vw / 2, top, vw, bot - top);
  ctx.globalAlpha = music.volAdjusting ? 1 : 0.9; ctx.fillStyle = meter;
  const vy = bot - (bot - top) * music.vol;
  ctx.fillRect(vx - vw / 2, vy, vw, bot - vy);
  if (music.volAdjusting) {
    ctx.font = "700 18px 'Space Grotesk', system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(music.vol * 100)}%`, vx - 14, vy);
  }

  const tl = W * 0.3, tr = W * 0.95, ty = H - 18;
  ctx.globalAlpha = 0.15; ctx.fillStyle = "#ffffff";
  ctx.fillRect(tl, ty - 2, tr - tl, 4);
  ctx.globalAlpha = 0.9; ctx.fillStyle = meter;
  ctx.fillRect(tl, ty - 2, (tr - tl) * music.bright, 4);

  ctx.globalAlpha = 0.5; ctx.fillStyle = "#ffffff";
  ctx.font = "600 10px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "right"; ctx.fillText(music.volAdjusting ? "VOL" : "VOL ✌", vx + 8, top - 14);
  ctx.textAlign = "left"; ctx.fillText("TONE", tl, ty - 14);
  ctx.globalAlpha = 1;
}

function drawHand(hand) {
  const p = hand.pts;
  const h = hand.side === "left" ? hue : hue + 40;
  const bones = new Path2D();
  for (const [a, b] of CONNECTIONS) {
    bones.moveTo(p[a].x, p[a].y);
    bones.lineTo(p[b].x, p[b].y);
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Wide soft glow under a crisp bright line
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = `hsla(${h}, 100%, 60%, 0.25)`;
  ctx.lineWidth = 10;
  ctx.stroke(bones);
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = `hsla(${h}, 100%, 82%, 0.95)`;
  ctx.lineWidth = 2.5;
  ctx.stroke(bones);

  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < p.length; i++) {
    const tip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
    ctx.beginPath();
    ctx.arc(p[i].x, p[i].y, tip ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.font = "600 11px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(hand.side.toUpperCase(), p[0].x, p[0].y + 28);
}

function drawParticles(dt) {
  const drag = Math.pow(0.04, dt); // fraction of velocity left after dt
  ctx.globalCompositeOperation = "lighter";
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vx *= drag; p.vy *= drag;
    p.x += p.vx * dt; p.y += p.vy * dt;
    const a = p.life / p.max;
    const s = p.size * (0.3 + 0.7 * a);
    ctx.globalAlpha = a;
    ctx.drawImage(glowSprite(p.hue), p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// Bright tapered streak behind each index fingertip
function drawRibbon(side, h) {
  const tr = trails[side];
  if (tr.length < 2) return;
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (let i = 1; i < tr.length; i++) {
    const f = i / tr.length;
    ctx.strokeStyle = `hsla(${h}, 100%, ${60 + f * 25}%, ${f * 0.7})`;
    ctx.lineWidth = 2 + f * 8;
    ctx.beginPath();
    ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
    ctx.lineTo(tr[i].x, tr[i].y);
    ctx.stroke();
  }
  const tip = tr[tr.length - 1];
  const s = 70 + level * 120;
  ctx.drawImage(glowSprite(h), tip.x - s / 2, tip.y - s / 2, s, s);
  ctx.globalCompositeOperation = "source-over";
}

function drawRipples(now) {
  ctx.globalCompositeOperation = "lighter";
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    const isKick = r.kind === "kick";
    // Hits are stamped after this frame started, so clamp to avoid a negative radius
    const age = Math.max(0, (now - r.t) / (isKick ? 700 : 450));
    if (age >= 1) { ripples.splice(i, 1); continue; }
    const e = 1 - Math.pow(1 - age, 3); // ease-out
    for (const k of isKick ? [1, 0.6] : [1]) {
      ctx.globalAlpha = (1 - age) * k;
      ctx.strokeStyle = `hsl(${r.hue}, 100%, 70%)`;
      ctx.lineWidth = (isKick ? 10 : 4) * (1 - age) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, (isKick ? 30 + e * 300 : 12 + e * 190) * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (age < 0.3) { // bright core flash
      const s = (isKick ? 220 : 140) * (1 - age / 0.3);
      ctx.globalAlpha = 1 - age / 0.3;
      ctx.drawImage(glowSprite(r.hue), r.x - s / 2, r.y - s / 2, s, s);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

export function render(now, dt) {
  drawBackground();
  ctx.save();
  if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawGuides();
  for (const h of tracking.hands) drawHand(h);
  drawParticles(dt);
  drawRibbon("left", hue);
  drawRibbon("right", hue + 40);
  drawRipples(now);
  ctx.restore();
  updateLabel();
}

// ---------- On-screen label ----------
let shownNote = "", shownMode = -1, shownHue = -1;
function pop(el) { el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }

export function showLabel() { labelEl.classList.remove("hidden"); }

function updateLabel() {
  const name = midiToName(NOTES[music.noteIdx]);
  if (name !== shownNote) { noteEl.textContent = name; if (music.playing) pop(noteEl); shownNote = name; }
  noteEl.classList.toggle("idle", !music.playing);
  if (music.mode !== shownMode) {
    instEl.textContent = MODES[music.mode].name;
    if (shownMode !== -1) pop(instEl);
    shownMode = music.mode;
  }
  const hb = Math.round(hue);
  if (hb !== shownHue) { labelEl.style.setProperty("--hue", hb); shownHue = hb; }
}
