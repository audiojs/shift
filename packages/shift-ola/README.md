# @audio/shift-ola [![npm](https://img.shields.io/npm/v/@audio/shift-ola)](https://www.npmjs.com/package/@audio/shift-ola) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

OLA (Overlap-Add) pitch shift — simplest stretch+resample baseline

```
npm install @audio/shift-ola
```

```js
import ola from '@audio/shift-ola'
```

Plain OLA time-stretch + sinc resample. Overlap-add without similarity search — the baseline the others improve on.

```js
ola(audio, { ratio: 1.5 })
```

**Preserves** amplitude envelope.<br>
**Destroys** pitch accuracy, formants, transients, phase coherence.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 38.33 | 0.2 | 0.004 | 0.980 | 2.342 | 0.995 | 2.025 |

f0 err 38.33 Hz — worst by far. Without similarity search, grains land at arbitrary phase offsets causing destructive interference that shifts the perceived pitch.

Shifted up, an output frame mixes grains read ahead of it (an octave up, output frame i reads input frames i to i + N/2), so the output runs early, by N/4 = 512 frames an octave up, and its last frames mix the take's last grains with grains that read the silence after it. Plain OLA's level is the interference of its grains, which can cancel a held tone deep where they all overlap and less where fewer do, so at the end of a take the level can rise as well as fall: over the last 1024 frames against the output's middle, a held tone moves −0.9 to +2.6 dB at +1 semitone, −3.9 to +10.7 dB at +12 and −8.8 to +31.3 dB at +24, where the middle falls as far as 44.8 dB under the input and the end stays 7.8 to 14.5 dB under it (`node scripts/ends.js`: tones of 110 to 1000 Hz at 32 take lengths, 22.05 to 96 kHz; the lead, 508 to 516 frames an octave up at the three rates). Shifted down the output runs late, and the take's last sound plays on past its end, inside the audio manifest's declared `tail`.

**Use when:** Reference baseline, or the simplest possible shift for comparison.<br>
**Not for:** Anything quality-sensitive.

## Stream

```js
let write = ola({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`ola` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` here is a fixed number for the whole call — a function or `Float32Array` throws.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
