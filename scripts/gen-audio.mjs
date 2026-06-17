// scripts/gen-audio.mjs
// Generates original, license-clean STARTER audio (22.05kHz mono WAV) for SCUTTLE.
// These are placeholders authored procedurally here (project-owned, effectively CC0)
// so the audio engine works out of the box. Swap in premium SFX/music later — see
// public/assets/audio/README.md for the drop-in convention.
//
// Run: node scripts/gen-audio.mjs   (re-runnable; overwrites)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SR = 22050;
const root = "public/assets/audio";

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}
const N = (sec) => Math.floor(sec * SR);
const env = (i, n, a = 0.01, r = 0.2) => {
  const t = i / SR, T = n / SR;
  const atk = Math.min(1, t / a);
  const rel = Math.min(1, (T - t) / r);
  return Math.max(0, Math.min(atk, rel));
};
const noise = () => Math.random() * 2 - 1;
// one-pole high-pass to strip DC/sub-bass rumble (the "hum") out of looping noise beds.
function highpass(buf, k) {
  let pin = 0, pout = 0;
  for (let i = 0; i < buf.length; i++) {
    const out = k * (pout + buf[i] - pin);
    pin = buf[i]; pout = out; buf[i] = out;
  }
  return buf;
}
// crossfade the tail into the head so a looped bed has no seam click.
function loopFade(out) {
  const n = out.length, f = N(0.25);
  for (let i = 0; i < f; i++) { const a = i / f; out[i] = out[i] * a + out[n - f + i] * (1 - a); }
  return out;
}
const save = (rel, samples) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, wav(samples));
  console.log("wrote", p, (samples.length / SR).toFixed(2) + "s");
};

// ---- SFX ----
// A real broadside report: a sharp powder CRACK + a punchy low BOOM + a rumble tail,
// soft-clipped (tanh) so it's loud and explosive, not a soft potato-gun thud.
function cannon() {
  const n = N(0.7), out = new Array(n).fill(0);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const crack = noise() * Math.exp(-30 * t);            // the blast transient
    const boom = Math.sin(2 * Math.PI * 68 * t) * Math.exp(-8 * t); // chest punch
    tail += (noise() - tail) * 0.08;                       // lowpassed rumble
    const rumble = tail * Math.exp(-5.5 * t);
    out[i] = Math.tanh((crack * 1.0 + boom * 0.9 + rumble * 0.7) * 1.7) * env(i, n, 0.0004, 0.35);
  }
  return out;
}
function band(n, decay, lp) {
  const out = new Array(n); let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += (noise() - prev) * lp;
    out[i] = prev * Math.exp(-decay * (i / SR)) * env(i, n, 0.001, 0.05);
  }
  return out;
}
function sink() {
  const n = N(1.3), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const groan = Math.sin(2 * Math.PI * (120 - 60 * t) * t) * 0.5;
    const bub = noise() * 0.25 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * t));
    out[i] = (groan + bub) * env(i, n, 0.02, 0.4);
  }
  return out;
}
function blips(freqs, sec) {
  const n = N(sec), out = new Array(n).fill(0), step = n / freqs.length;
  freqs.forEach((f, k) => {
    for (let j = 0; j < step; j++) {
      const i = Math.floor(k * step + j);
      out[i] += Math.sin(2 * Math.PI * f * (j / SR)) * Math.exp(-12 * (j / SR)) * 0.6;
    }
  });
  return out;
}
function chime(freqs, sec, decay) {
  const n = N(sec), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    for (const f of freqs) out[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-decay * t);
    out[i] = (out[i] / freqs.length) * env(i, n, 0.005, sec * 0.5);
  }
  return out;
}
// Seagull cry: 2-3 reedy caws, each a quick pitch arc around ~1.5-2.2 kHz.
function gull() {
  const n = N(1.15), out = new Array(n).fill(0);
  for (const start of [0.0, 0.42, 0.82]) {
    const s0 = Math.floor(start * SR), dur = N(0.2 + Math.random() * 0.06);
    for (let j = 0; j < dur && s0 + j < n; j++) {
      const tt = j / dur;
      const f = 1450 + 720 * Math.sin(Math.PI * tt);   // rise then fall
      const amp = Math.sin(Math.PI * tt) * 0.5;
      out[s0 + j] += (Math.sin(2 * Math.PI * f * (j / SR)) + 0.35 * Math.sin(4 * Math.PI * f * (j / SR))) * amp;
    }
  }
  return out;
}
// Hull creak: a low stick-slip wood groan, pitch wobbling, swelling in and out.
function creak() {
  const n = N(0.75), out = new Array(n); let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const wob = 1 + 0.22 * Math.sin(2 * Math.PI * 6 * t + Math.sin(2 * Math.PI * 2.3 * t));
    const tone = Math.sin(2 * Math.PI * 175 * wob * t);
    lp += (noise() - lp) * 0.05;
    out[i] = (tone * 0.5 + lp * 0.5) * Math.sin(Math.PI * Math.min(1, t / (n / SR))) * 0.7;
  }
  return out;
}
// Rigging rope: a short creak that slides UP in pitch as the line tightens.
function rope() {
  const n = N(0.45), out = new Array(n); let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, tt = t / (n / SR);
    lp += (noise() - lp) * 0.12;
    const tone = Math.sin(2 * Math.PI * (220 + 180 * tt) * t) * 0.3;
    out[i] = (lp * 0.6 + tone) * Math.exp(-3 * t) * 0.7;
  }
  return out;
}
// Airy wind bed: band-limited noise (lowpassed then high-passed → "shhh", no rumble), gusting.
function windBed() {
  const sec = 3, n = N(sec), out = new Array(n); let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lp += (noise() - lp) * 0.25;
    const gust = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.3 * t)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.13 * t));
    out[i] = lp * gust;
  }
  highpass(out, 0.97);
  return loopFade(out);
}
// Soft ocean wash: lower, gentler noise with a slow swell; high-passed to lose the hum.
function oceanBed() {
  const sec = 4, n = N(sec), out = new Array(n); let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lp += (noise() - lp) * 0.13;
    const swell = 0.55 + 0.45 * Math.sin(2 * Math.PI * (1 / sec) * t);
    out[i] = lp * swell * 0.9;
  }
  highpass(out, 0.92);
  return loopFade(out);
}
// Ambient pad (kept for music; auto-play is currently OFF — placeholder until real tracks).
function pad(chord, sec) {
  const n = N(sec), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.2 * t);
    for (const f of chord) out[i] += Math.sin(2 * Math.PI * f * t);
    out[i] = (out[i] / chord.length) * 0.5 * lfo;
  }
  return loopFade(out);
}

// Only the ids STILL on a procedural placeholder are generated here. The rest (cannon, the
// wood-crack damage pool, creak, rope, coins, port_open, ui_click/ui_buy, ocean/wind beds, and
// the menu/harbor music) now have real recordings under public/assets/audio/ — see that README's
// manifest. Re-running this script must NOT recreate those, so their save() calls are gone.
// (The cannon()/band()/windBed()/etc generators above are kept as a reference for the next round.)
save("sfx/sink.wav", sink());
save("sfx/splash.wav", band(N(0.3), 12, 0.7));
save("sfx/gull.wav", gull()); // MUTED in audio.ts (PLACEHOLDER_MUTED) until a real gull lands
save("sfx/ui_confirm.wav", chime([784, 1175], 0.18, 14));
save("sfx/ship_ready.wav", chime([392, 523, 659, 784], 0.8, 3));
save("music/sea_ambient.wav", pad([147, 220, 247], 6)); // unused — at sea is ambience-only
console.log("done — placeholders only; real audio lives beside these and is not regenerated");
