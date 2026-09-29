/* MerchantGate brag — the whole soundtrack as one piece: bed, pulse, arp,
 * drums, and SFX mixed *under* the music rather than laid on top.
 * Key: D minor, 96 BPM, 4/4, 8 bars of 2.5s = 20.0s exactly.
 *
 * Each layer is rendered into its own buffer pair, RMS-measured, and balanced
 * to a target loudness numerically (we cannot listen, so we do not guess).
 * Synthesis is additive/band-limited; the only filtering is a master chain.
 */
import { writeFileSync } from "node:fs";

const SR = 44100;
const DUR = 20.0;
const TAIL = 1.2;
const N = Math.ceil((DUR + TAIL) * SR);

const BPM = 96;
const BEAT = 60 / BPM; // 0.625
const BAR = BEAT * 4; // 2.5

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* ---------- note helpers (equal temperament, A4 = 440) ---------- */
const NOTE = {
  C: 0,
  "C#": 1,
  D: 2,
  "D#": 3,
  E: 4,
  F: 5,
  "F#": 6,
  G: 7,
  "G#": 8,
  A: 9,
  "A#": 10,
  B: 11,
};
const NOTE_FALLBACK = { Bb: "A#", Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#" };
function hz(nameIn) {
  let name = nameIn;
  const two = /^([A-Ga-g])([b#]?)(-?\d)$/.exec(nameIn);
  if (two) {
    const letter = two[1].toUpperCase();
    const acc = two[2] === "b" ? NOTE_FALLBACK[letter + "b"] : letter + two[2];
    name = acc + two[3];
  }
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note name: ${nameIn}`);
  return 440 * 2 ** ((NOTE[m[1]] + (Number(m[2]) + 1) * 12 - 69) / 12);
}
const cents = (f, c) => f * 2 ** (c / 1200);

/* ---------- layers ---------- */
function newLayer() {
  return { L: new Float32Array(N), R: new Float32Array(N) };
}

// Band-limited additive tone. harmonics: [{mult, amp}] → nothing aliases.
function tone(
  layer,
  t0,
  dur,
  freq,
  harmonics,
  { gain = 0.1, attack = 0.01, release = 0.2, pan = 0, curve = 2.2 } = {},
) {
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const i1 = Math.min(N, Math.ceil((t0 + dur) * SR));
  const n = i1 - i0;
  if (n <= 0) return;
  const atk = Math.max(1, Math.floor(attack * SR));
  const rel = Math.max(1, Math.floor(release * SR));
  const gl = Math.sqrt(0.5 * (1 - pan));
  const gr = Math.sqrt(0.5 * (1 + pan));
  const phases = harmonics.map((h) => [(h.mult * 2 * Math.PI) / SR, h.amp]);
  for (let i = 0; i < n; i++) {
    const s = i;
    let env;
    if (s < atk) env = (s / atk) ** 1.4;
    else env = Math.max(0, 1 - (s - atk) / Math.max(1, n - atk)) ** curve;
    if (n - s < rel) env *= (n - s) / rel;
    if (env <= 0) continue;
    let v = 0;
    for (const [inc, amp] of phases) v += amp * Math.sin(inc * s);
    v *= env * gain;
    layer.L[i0 + i] += v * gl;
    layer.R[i0 + i] += v * gr;
  }
}

// Band-passed noise burst, normalised so `gain` means the same thing for any
// cutoff/q — otherwise resonance swings the SFX level by 10 dB or more.
function noise(
  layer,
  t0,
  dur,
  {
    gain = 0.05,
    pan = 0,
    toneHz = 4000,
    q = 0.4,
    attack = 0.002,
    curve = 3,
  } = {},
) {
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const i1 = Math.min(N, Math.ceil((t0 + dur) * SR));
  const n = i1 - i0;
  if (n <= 0) return;
  const gl = Math.sqrt(0.5 * (1 - pan));
  const gr = Math.sqrt(0.5 * (1 + pan));
  let seed = (0x2f6e2b1 ^ (i0 * 2654435761)) >>> 0;
  const rnd = () => {
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const f = 2 * Math.sin((Math.PI * clamp(toneHz, 20, SR * 0.45)) / SR);
  const damp = 1.15; // stable, gentle resonance
  let lo = 0,
    band = 0,
    maxAbs = 0;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i;
    const env =
      s < attack * SR ? s / (attack * SR) : Math.max(0, 1 - s / n) ** curve;
    const x = rnd();
    const hi = x - lo - damp * band;
    band += f * hi;
    lo += f * band;
    const v = band * clamp(env);
    buf[i] = v;
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  if (maxAbs <= 0) return;
  const k = gain / maxAbs;
  for (let i = 0; i < n; i++) {
    layer.L[i0 + i] += buf[i] * k * gl;
    layer.R[i0 + i] += buf[i] * k * gr;
  }
}

// Kick: pitched sine drop.
function kick(layer, t0, gain = 0.42) {
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const dur = 0.34;
  const i1 = Math.min(N, Math.ceil((t0 + dur) * SR));
  const n = i1 - i0;
  if (n <= 0) return;
  let ph = 0;
  for (let i = i0; i < i1; i++) {
    const d = (i - i0) / n;
    const f = 118 * Math.exp(-d * 7) + 44;
    ph += (2 * Math.PI * f) / SR;
    const env = (1 - d) ** 2.6 * (i - i0 < 40 ? (i - i0) / 40 : 1);
    const v = Math.sin(ph) * env * gain;
    layer.L[i] += v;
    layer.R[i] += v;
  }
  noise(layer, t0, 0.02, { gain: 0.05, toneHz: 2600, q: 0.5 });
}

/* ---------- harmony: i - VI - III - VII, twice ---------- */
const CHORDS = [
  { root: "D2", tones: ["D3", "F3", "A3", "D4"] },
  { root: "A#1", tones: ["A#2", "D3", "F3", "A#3"] },
  { root: "F2", tones: ["F3", "A3", "C4", "F4"] },
  { root: "C2", tones: ["C3", "E3", "G3", "C4"] },
  { root: "D2", tones: ["D3", "F3", "A3", "D4"] },
  { root: "A#1", tones: ["A#2", "D3", "F3", "A#3"] },
  { root: "F2", tones: ["F3", "A3", "C4", "F4"] },
  { root: "C2", tones: ["C3", "E3", "G3", "C4"] },
];
const TRI = (k) =>
  Array.from({ length: k }, (_, i) => ({
    mult: i + 1,
    amp: i % 2 ? 1 / (i + 1) ** 2 : 1 / (i + 1) ** 1.6,
  }));

const CUT = 3.6,
  S3 = 7.1,
  S4 = 12.3,
  S5 = 16.7;
const LAYERS = {};

/* ---- 1. pad bed: the whole 20s, always under everything ---- */
LAYERS.pad = newLayer();
CHORDS.forEach((c, b) => {
  const t0 = b * BAR;
  c.tones.forEach((tn, i) => {
    const f = hz(tn);
    for (const det of [-7, 0, 7]) {
      tone(LAYERS.pad, t0, BAR * 1.02, cents(f, det), TRI(6), {
        gain: 0.052 - i * 0.006,
        attack: 0.55 + i * 0.06,
        release: 0.6,
        pan: (i - 1.5) * 0.22 + det * 0.004,
      });
    }
  });
  tone(LAYERS.pad, t0, BAR * 0.9, hz(c.tones[3]) * 2, TRI(4), {
    gain: 0.016,
    attack: 0.7,
    release: 0.7,
    pan: 0.2,
  });
});

/* ---- 2. sub pulse: roots, eighth-driven, ducked by the kick ---- */
LAYERS.bass = newLayer();
for (let b = 0; b < 8; b++) {
  const root = hz(CHORDS[b].root);
  const t0 = b * BAR;
  for (const bt of [0, 1.5, 2.5, 3.5]) {
    tone(
      LAYERS.bass,
      t0 + bt * BEAT,
      bt === 0 ? BEAT * 1.3 : BEAT * 0.7,
      root,
      [
        { mult: 1, amp: 1 },
        { mult: 2, amp: 0.16 },
      ],
      { gain: 0.3, attack: 0.012, release: 0.16, curve: 2.4 },
    );
  }
}

/* ---- 3. arp: enters with scene 3, carries the punchline ---- */
LAYERS.arp = newLayer();
{
  const ARP_FROM = S3 - 0.1;
  const ARP = [0, 7, 12, 19, 24, 19, 12, 7];
  for (let t = ARP_FROM, i = 0; t < DUR; t += BEAT / 4, i++) {
    const b = Math.floor(t / BAR) % 8;
    const step = i % ARP.length;
    const f = hz(CHORDS[b].tones[0]) * 2 * 2 ** (ARP[step] / 12);
    const accent = step % 4 === 0 ? 1 : 0.62;
    const fade =
      clamp((t - ARP_FROM) / 0.5) * (1 - clamp((t - (DUR - 1.4)) / 1.0));
    tone(LAYERS.arp, t, 0.2, f, TRI(5), {
      gain: 0.05 * accent * fade,
      attack: 0.004,
      release: 0.13,
      pan: step % 2 ? 0.35 : -0.35,
    });
  }
}

/* ---- 4. drums: enter with the reveal ---- */
LAYERS.drums = newLayer();
for (let b = 0; b < 8; b++) {
  const t0 = b * BAR;
  for (let beat = 0; beat < 4; beat++) {
    const t = t0 + beat * BEAT;
    if (t > DUR) continue;
    if (beat === 0 || beat === 2) kick(LAYERS.drums, t, beat === 0 ? 0.4 : 0.3);
    if (beat === 3 && b % 2 === 1) kick(LAYERS.drums, t + BEAT * 0.5, 0.22);
    for (const h of [0, 0.5]) {
      noise(LAYERS.drums, t + h * BEAT, 0.075, {
        gain: (h === 0 ? 0.05 : 0.03) * (beat === 0 ? 1 : 0.8),
        toneHz: 7200,
        q: 0.25,
        pan: h ? 0.3 : -0.2,
      });
    }
    if (beat === 1)
      noise(LAYERS.drums, t + BEAT * 0.75, 0.05, {
        gain: 0.022,
        toneHz: 5200,
        q: 0.3,
        pan: -0.35,
      });
  }
}

/* ---- 5. SFX: all in D minor, sitting under the music ---- */
LAYERS.sfx = newLayer();
{
  // 5a. typing ticks during the injection (scene 1)
  const T0 = 0.52,
    RATE = 42,
    text = 78;
  for (let i = 0; i < text; i++) {
    const t = T0 + i / RATE;
    const isSpace = i % 9 === 4;
    noise(LAYERS.sfx, t, isSpace ? 0.012 : 0.02, {
      gain: isSpace ? 0.008 : 0.016,
      toneHz: isSpace ? 2200 : 3400 + (i % 3) * 500,
      q: 0.5,
      pan: ((i % 5) - 2) * 0.12,
    });
  }
  // 5b. the DENY stamp: a low felted thunk with a short metallic edge
  const t = 2.34;
  tone(
    LAYERS.sfx,
    t,
    0.5,
    hz("D2"),
    [
      { mult: 1, amp: 1 },
      { mult: 1.5, amp: 0.2 },
      { mult: 2, amp: 0.1 },
    ],
    { gain: 0.5, attack: 0.003, release: 0.3, curve: 3 },
  );
  noise(LAYERS.sfx, t, 0.09, { gain: 0.05, toneHz: 900, q: 0.5 });
  tone(LAYERS.sfx, t + 0.01, 0.16, hz("A4"), TRI(6), {
    gain: 0.05,
    attack: 0.002,
    release: 0.12,
  });

  // 5c. transition whooshes
  for (const w of [CUT, S3, S4, S5]) {
    noise(LAYERS.sfx, w - 0.22, 0.5, {
      gain: 0.11,
      toneHz: 1500,
      q: 0.12,
      attack: 0.14,
      curve: 2.2,
    });
    tone(LAYERS.sfx, w - 0.02, 0.42, hz("D3"), TRI(4), {
      gain: 0.035,
      attack: 0.02,
      release: 0.3,
      pan: -0.2,
    });
  }
  // 5d. the ALLOW resolve: two notes up as the grand total lands
  {
    const a = S3 + 2.06;
    tone(LAYERS.sfx, a, 0.5, hz("D5"), TRI(6), {
      gain: 0.075,
      attack: 0.004,
      release: 0.34,
      pan: -0.22,
    });
    tone(LAYERS.sfx, a + 0.09, 0.62, hz("A5"), TRI(6), {
      gain: 0.062,
      attack: 0.004,
      release: 0.42,
      pan: 0.24,
    });
    noise(LAYERS.sfx, a, 0.05, { gain: 0.02, toneHz: 6000, q: 0.4 });
    noise(LAYERS.sfx, S3 + 2.6, 0.03, { gain: 0.03, toneHz: 4200, q: 0.55 });
  }
  // 5e. the deny: a dull detuned low figure, not a harsh buzzer
  {
    const d = S4 + 1.3;
    for (const det of [-9, 9]) {
      tone(
        LAYERS.sfx,
        d,
        0.62,
        cents(hz("Bb2"), det),
        [
          { mult: 1, amp: 1 },
          { mult: 2, amp: 0.14 },
          { mult: 3, amp: 0.06 },
        ],
        { gain: 0.24, attack: 0.006, release: 0.34, curve: 2.6 },
      );
    }
    noise(LAYERS.sfx, d, 0.1, { gain: 0.03, toneHz: 520, q: 0.5 });
    tone(LAYERS.sfx, d + 0.02, 0.3, hz("F3"), TRI(4), {
      gain: 0.04,
      attack: 0.01,
      release: 0.24,
      pan: 0.3,
    });
  }
  // 5f. riser into the punchline, downbeat hit, and a bright shimmer
  {
    const r = S5 - 0.75;
    noise(LAYERS.sfx, r, 0.8, {
      gain: 0.075,
      toneHz: 1200,
      q: 0.1,
      attack: 0.5,
      curve: 1.6,
    });
    tone(
      LAYERS.sfx,
      r,
      0.8,
      hz("A2"),
      [
        { mult: 1, amp: 1 },
        { mult: 2, amp: 0.3 },
      ],
      { gain: 0.1, attack: 0.55, release: 0.2 },
    );
    kick(LAYERS.sfx, S5 + 0.1, 0.5);
    kick(LAYERS.sfx, S5 + BEAT, 0.26);
    noise(LAYERS.sfx, S5 + 0.1, 0.1, { gain: 0.05, toneHz: 2400, q: 0.5 });
    ["D5", "F5", "A5"].forEach((tn, i) => {
      tone(LAYERS.sfx, S5 + 0.34 + i * 0.13, 1.5, hz(tn), TRI(6), {
        gain: 0.05,
        attack: 0.01,
        release: 1.2,
        pan: (i - 1) * 0.3,
      });
    });
  }
}

/* ---------- balance each layer to a target RMS (dBFS) ---------- */
const TARGETS = { pad: -24, bass: -21, arp: -26, drums: -18, sfx: -24 };
const mixL = new Float32Array(N);
const mixR = new Float32Array(N);
const rows = [];
for (const [name, layer] of Object.entries(LAYERS)) {
  let sum = 0,
    peak = 0;
  for (let i = 0; i < N; i++) {
    const m = (layer.L[i] + layer.R[i]) * 0.5;
    if (!Number.isFinite(m))
      throw new Error(
        `non-finite sample in layer ${name} at ${(i / SR).toFixed(3)}s`,
      );
    sum += m * m;
    peak = Math.max(peak, Math.abs(layer.L[i]), Math.abs(layer.R[i]));
  }
  const rms = Math.sqrt(sum / N);
  const target = TARGETS[name];
  const g = 10 ** ((target - 20 * Math.log10(rms)) / 20);
  rows.push({
    name,
    pre: 20 * Math.log10(rms),
    prePeak: 20 * Math.log10(peak),
    gain: g,
    target,
  });
  for (let i = 0; i < N; i++) {
    mixL[i] += layer.L[i] * g;
    mixR[i] += layer.R[i] * g;
  }
}
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(6)} pre-RMS ${r.pre.toFixed(1).padStart(6)} dB  pre-peak ${r.prePeak.toFixed(1).padStart(6)} dB  -> target ${r.target} dB  (x${r.gain.toFixed(3)})`,
  );
}

/* ---------- sidechain duck from the drum layer ---------- */
const ducks = [];
for (let b = 0; b < 8; b++) {
  const t0 = b * BAR;
  for (let beat = 0; beat < 4; beat++) {
    const t = t0 + beat * BEAT;
    if (t > DUR) continue;
    if (beat === 0 || beat === 2) ducks.push([t, 0.34]);
    if (beat === 3 && b % 2 === 1) ducks.push([t + BEAT * 0.5, 0.22]);
  }
}
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let duck = 0;
  for (const [dt, amt] of ducks) {
    const d = t - dt;
    if (d < 0) break;
    if (d < 0.26) duck = Math.max(duck, amt * (1 - d / 0.26));
  }
  const g = 1 - duck * 0.5;
  mixL[i] *= g;
  mixR[i] *= g;
}

/* ---------- master chain: HPF 30Hz, gentle glue LPF, soft clip, normalise ---------- */
function biquadHP(buf, fc) {
  const w = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w) / (2 * 0.707);
  const b0 = (1 + Math.cos(w)) / 2,
    b1 = -(1 + Math.cos(w)),
    b2 = (1 + Math.cos(w)) / 2;
  const a0 = 1 + alpha,
    a1 = -2 * Math.cos(w),
    a2 = 1 - alpha;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < N; i++) {
    const x = buf[i];
    const y =
      (b0 / a0) * x +
      (b1 / a0) * x1 +
      (b2 / a0) * x2 -
      (a1 / a0) * y1 -
      (a2 / a0) * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
}
function biquadLP(buf, fc, q = 0.707) {
  const w = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = (1 - Math.cos(w)) / 2,
    b1 = 1 - Math.cos(w),
    b2 = (1 - Math.cos(w)) / 2;
  const a0 = 1 + alpha,
    a1 = -2 * Math.cos(w),
    a2 = 1 - alpha;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < N; i++) {
    const x = buf[i];
    const y =
      (b0 / a0) * x +
      (b1 / a0) * x1 +
      (b2 / a0) * x2 -
      (a1 / a0) * y1 -
      (a2 / a0) * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
}
biquadHP(mixL, 30);
biquadHP(mixR, 30);
biquadLP(mixL, 15500);
biquadLP(mixR, 15500);

let prePeak = 0;
for (let i = 0; i < N; i++)
  prePeak = Math.max(prePeak, Math.abs(mixL[i]), Math.abs(mixR[i]));
const norm = 0.891 / prePeak; // -1 dBFS
const data = Buffer.alloc(N * 4);
let clipCount = 0;
for (let i = 0; i < N; i++) {
  const l = Math.tanh(mixL[i] * norm * 1.08);
  const r = Math.tanh(mixR[i] * norm * 1.08);
  if (Math.abs(l) > 0.999 || Math.abs(r) > 0.999) clipCount++;
  data.writeInt16LE(Math.round(clamp(l, -1, 1) * 32767), i * 4);
  data.writeInt16LE(Math.round(clamp(r, -1, 1) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
const out = new URL("./audio.wav", import.meta.url).pathname;
writeFileSync(out, Buffer.concat([header, data]));
console.log(
  `\nwrote ${out}  ${(DUR + TAIL).toFixed(1)}s  pre-master peak ${(20 * Math.log10(prePeak)).toFixed(1)} dB  clipped samples ${clipCount}`,
);
