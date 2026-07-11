# @audio/shift-psola [![npm](https://img.shields.io/npm/v/@audio/shift-psola)](https://www.npmjs.com/package/@audio/shift-psola) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

PSOLA (Pitch-Synchronous Overlap-Add) pitch shift — pitch-synchronous grains for monophonic voice

```
npm install @audio/shift-psola
```

```js
import psola from '@audio/shift-psola'
```

PSOLA time-stretch + sinc resample. Autocorrelation detects pitch periods; two-period Hann grains are placed at pitch-synchronous intervals, reducing the grain-boundary artifacts plain WSOLA gets on voiced monophonic material. The final resample rescales the whole spectrum by `ratio`, so formants move with f0 exactly as they do for `wsola` — this is a smoother stretch, not formant preservation.

```js
psola(audio, { ratio: 0.75, sampleRate: 48000 })
psola(audio, { ratio: 1.5, minFreq: 100, maxFreq: 400 })
```

| Param | Default | |
|---|---|---|
| `sampleRate` | `44100` | For pitch detection range |
| `minFreq` | `80` | Lowest expected pitch (Hz) |
| `maxFreq` | `500` | Highest expected pitch (Hz) |

**Preserves** waveform-per-period shape, voiced-speech naturalness.<br>
**Destroys** formants (same resample-driven shift as `wsola`), polyphony (assumes single pitch contour), unvoiced regions (pitch-mark jitter); falls back to plain WSOLA internally when no reliable pitch period is found.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.66 | 0.2 | 0.005 | 0.941 | 2.336 | 0.998 | 1.766 |

Phase coherence 0.998 — pitch-synchronous grains align with the waveform period almost perfectly, just short of `formant`'s 1.000. Lower attack corr (0.941) from pitch-mark jitter on non-periodic onsets.

**Use when:** Monophonic speech, solo voice, single melodic instrument.<br>
**Not for:** Polyphonic material, chords, or anywhere formants must stay put (use `lpc`).

## Stream

```js
let write = psola({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`psola` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` here is a fixed number for the whole call — a function or `Float32Array` throws.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
