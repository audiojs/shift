# @audio/shift-formant [![npm](https://img.shields.io/npm/v/@audio/shift-formant)](https://www.npmjs.com/package/@audio/shift-formant) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Formant-preserving pitch shift via cepstral envelope re-imposition

```
npm install @audio/shift-formant
```

```js
import formant from '@audio/shift-formant'
```

Cepstral envelope preservation wrapping a peak-locked vocoder. Extracts spectral envelope via cepstral liftering from temporally-smoothed magnitude, flattens the spectrum, applies peak-locked pitch shift on the flat residual, re-imposes the original envelope.

```js
formant(audio, { semitones: 5 })
formant(audio, { ratio: 0.75, envelopeWidth: 16 })
```

| Param | Default | |
|---|---|---|
| `envelopeWidth` | `max(8, round(sr/1378))`, ≤ N/4 | Cepstrum lifter cutoff (quefrency bins) |

**Preserves** formant envelope (absolute Hz), vocal-tract character.<br>
**Destroys** transients (same as vocoder); risks cepstral ringing on sparse spectra.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.987 | **0.765** | **1.000** | 1.573 |

Best formant dist in the collection by construction — the envelope is explicitly separated and re-applied. Also the best phase coherence (1.000): the correction reshapes magnitude only, so it inherits the peak-locked vocoder's phase tracking untouched, and gains a hair over `phaseLock` itself.

**Use when:** Voice shifting without chipmunk / giant artifact.<br>
**Not for:** Percussion-heavy material (transients smear).

## Stream

```js
let write = formant({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`formant` streams per-frame: each `write(chunk)` call renormalizes and emits audio as soon as a frame completes, and re-chunking the same input differently reproduces the batch output byte for byte.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
