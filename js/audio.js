// ---------- Music theory ----------
// A minor pentatonic, A2 to A5: always consonant
const SCALE = [0, 3, 5, 7, 10];
const ROOT_MIDI = 45; // A2
export const NOTES = [];
for (let i = 0; i <= 15; i++) NOTES.push(ROOT_MIDI + 12 * Math.floor(i / 5) + SCALE[i % 5]);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiToName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

// ---------- Audio engine ----------
let ac = null;
let gateGain, filter, volumeGain, drumBus, reverb, noiseBuffer, analyser, levelBuf;

function makeImpulse(seconds, decay) {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// Must be called from a click so the browser lets audio play
export function initAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();

  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
  comp.connect(ac.destination);
  analyser = ac.createAnalyser(); // drives the background pulse
  analyser.fftSize = 512;
  comp.connect(analyser);
  levelBuf = new Float32Array(analyser.fftSize);

  const master = ac.createGain();
  master.gain.value = 0.9;
  master.connect(comp);

  reverb = ac.createConvolver();
  reverb.buffer = makeImpulse(2.8, 2.6);
  const wet = ac.createGain();
  wet.gain.value = 0.3;
  reverb.connect(wet); wet.connect(master);

  // Melody chain: instrument -> gate (left hand present) -> filter (right X) -> volume (right Y)
  gateGain = ac.createGain(); gateGain.gain.value = 0;
  filter = ac.createBiquadFilter(); filter.type = "lowpass"; filter.Q.value = 3; filter.frequency.value = 2000;
  volumeGain = ac.createGain(); volumeGain.gain.value = 0;
  gateGain.connect(filter); filter.connect(volumeGain);
  volumeGain.connect(master); volumeGain.connect(reverb);

  drumBus = ac.createGain(); drumBus.gain.value = 0.9;
  drumBus.connect(master);
  const drumVerb = ac.createGain(); drumVerb.gain.value = 0.12;
  drumBus.connect(drumVerb); drumVerb.connect(reverb);

  noiseBuffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const nd = noiseBuffer.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
}

export const audioState = () => (ac ? ac.state : "off");

// Browsers can leave audio suspended; any click or key brings it back
export function resumeAudio() { if (ac && ac.state !== "running") ac.resume(); }

// gate: is the melody sounding; vol and bright: 0..1 from the right hand
export function setMelody(gate, vol, bright) {
  const t = ac.currentTime;
  gateGain.gain.setTargetAtTime(gate ? 1 : 0, t, gate ? 0.04 : 0.18);
  volumeGain.gain.setTargetAtTime(vol * vol, t, 0.05);
  filter.frequency.setTargetAtTime(180 * Math.pow(12000 / 180, bright), t, 0.05);
}

// Loudness of everything you hear, 0..1
export function readLevel() {
  analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  return Math.min(1, Math.sqrt(sum / levelBuf.length) * 3.5);
}

// ---------- Instruments ----------
// Soft synth pad: detuned saws + sub sine, slow swell, glides between notes
class Pad {
  constructor(freq) {
    const t = ac.currentTime;
    this.out = ac.createGain(); this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(0.16, t, 0.25);
    this.out.connect(gateGain);
    this.oscs = [
      { type: "sawtooth", ratio: 1, detune: -9, gain: 0.5 },
      { type: "sawtooth", ratio: 1, detune: 9, gain: 0.5 },
      { type: "sine", ratio: 0.5, detune: 0, gain: 0.7 }
    ].map(d => {
      const o = ac.createOscillator(); o.type = d.type; o.detune.value = d.detune;
      o.frequency.value = freq * d.ratio;
      const g = ac.createGain(); g.gain.value = d.gain;
      o.connect(g); g.connect(this.out); o.start();
      return { o, ratio: d.ratio };
    });
  }
  setFreq(f) { for (const { o, ratio } of this.oscs) o.frequency.setTargetAtTime(f * ratio, ac.currentTime, 0.06); }
  pluck() {}
  dispose() {
    const t = ac.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.12);
    for (const { o } of this.oscs) o.stop(t + 1);
  }
}

// Plucky lead: short re-triggered notes with a falling filter envelope
class Pluck {
  constructor(freq) { this.freq = freq; this.repeat = 0.24; }
  setFreq(f) { this.freq = f; }
  pluck() {
    const t = ac.currentTime;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.4, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 6;
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    lp.connect(env); env.connect(gateGain);
    for (const [type, ratio, gain] of [["sawtooth", 1, 0.6], ["triangle", 2, 0.4]]) {
      const o = ac.createOscillator(); o.type = type; o.frequency.value = this.freq * ratio;
      const g = ac.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + 0.5);
    }
  }
  dispose() {}
}

// Retro square wave: chiptune-style lead with vibrato and fast portamento
class Retro {
  constructor(freq) {
    const t = ac.currentTime;
    this.out = ac.createGain(); this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(0.11, t, 0.02);
    this.out.connect(gateGain);
    this.o = ac.createOscillator(); this.o.type = "square"; this.o.frequency.value = freq;
    this.lfo = ac.createOscillator(); this.lfo.frequency.value = 5.5;
    const depth = ac.createGain(); depth.gain.value = 14; // cents
    this.lfo.connect(depth); depth.connect(this.o.detune);
    this.o.connect(this.out);
    this.o.start(); this.lfo.start();
  }
  setFreq(f) { this.o.frequency.setTargetAtTime(f, ac.currentTime, 0.02); }
  pluck() {}
  dispose() {
    const t = ac.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.05);
    this.o.stop(t + 0.5); this.lfo.stop(t + 0.5);
  }
}

export const MODES = [
  { name: "Soft Pad", make: (f) => new Pad(f) },
  { name: "Pluck Lead", make: (f) => new Pluck(f) },
  { name: "Retro Square", make: (f) => new Retro(f) }
];

// ---------- Drums ----------
export function kick() {
  const t = ac.currentTime;
  const o = ac.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  const g = ac.createGain();
  g.gain.setValueAtTime(1.1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  o.connect(g); g.connect(drumBus);
  o.start(t); o.stop(t + 0.5);
}

export function snare() {
  const t = ac.currentTime;
  const n = ac.createBufferSource(); n.buffer = noiseBuffer;
  const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1200;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.7, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  n.connect(hp); hp.connect(ng); ng.connect(drumBus);
  n.start(t); n.stop(t + 0.25);

  const o = ac.createOscillator(); o.type = "triangle";
  o.frequency.setValueAtTime(200, t);
  o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
  const og = ac.createGain();
  og.gain.setValueAtTime(0.5, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  o.connect(og); og.connect(drumBus);
  o.start(t); o.stop(t + 0.15);
}

// Short rising chime on start so the player knows audio works
export function chime() {
  const t = ac.currentTime;
  [69, 76, 81].forEach((m, i) => {
    const o = ac.createOscillator(); o.type = "sine"; o.frequency.value = midiToFreq(m);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t + i * 0.09);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.09 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.6);
    o.connect(g); g.connect(drumBus);
    o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.7);
  });
}
