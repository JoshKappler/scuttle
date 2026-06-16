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
const save = (rel, samples) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, wav(samples));
  console.log("wrote", p, (samples.length / SR).toFixed(2) + "s");
};

// ---- SFX ----
function cannon() {
  const n = N(0.6), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const thump = Math.sin(2 * Math.PI * (90 - 50 * t) * t) * Math.exp(-6 * t);
    const crack = noise() * Math.exp(-25 * t);
    out[i] = (thump * 0.8 + crack * 0.5) * env(i, n, 0.001, 0.25);
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
function loopNoise(sec, lp, amp) {
  const n = N(sec), out = new Array(n); let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += (noise() - prev) * lp;
    const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * (1 / sec) * (i / SR));
    out[i] = prev * amp * swell;
  }
  // crossfade ends for a seamless loop
  const f = N(0.2);
  for (let i = 0; i < f; i++) { const a = i / f; out[i] = out[i] * a + out[n - f + i] * (1 - a); }
  return out;
}
function pad(chord, sec) {
  const n = N(sec), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.2 * t);
    for (const f of chord) out[i] += Math.sin(2 * Math.PI * f * t);
    out[i] = (out[i] / chord.length) * 0.5 * lfo;
  }
  const f = N(0.3);
  for (let i = 0; i < f; i++) { const a = i / f; out[i] = out[i] * a + out[n - f + i] * (1 - a); }
  return out;
}

save("sfx/cannon.wav", cannon());
save("sfx/impact_wood.wav", band(N(0.25), 18, 0.5));
save("sfx/impact_thud.wav", band(N(0.2), 30, 0.15));
save("sfx/crunch.wav", band(N(0.35), 10, 0.6));
save("sfx/sink.wav", sink());
save("sfx/coins.wav", blips([880, 1175, 1568, 1319], 0.5));
save("sfx/splash.wav", band(N(0.3), 12, 0.7));
save("sfx/ui_click.wav", chime([1200], 0.05, 60));
save("sfx/ui_confirm.wav", chime([784, 1175], 0.18, 14));
save("sfx/ui_buy.wav", blips([1047, 1319, 1568], 0.35));
save("sfx/port_open.wav", chime([523, 659, 784], 0.6, 4));
save("sfx/ship_ready.wav", chime([392, 523, 659, 784], 0.8, 3));
save("ambient/ocean_loop.wav", loopNoise(3, 0.04, 0.5));
save("ambient/wind_loop.wav", loopNoise(3, 0.02, 0.4));
save("music/menu_theme.wav", pad([196, 233, 294], 6));
save("music/sea_ambient.wav", pad([147, 220, 247], 6));
save("music/harbor.wav", pad([262, 330, 392], 6));
console.log("done");
