# @audio/shift-sms [![npm](https://img.shields.io/npm/v/@audio/shift-sms)](https://www.npmjs.com/package/@audio/shift-sms) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Spectral Modeling Synthesis (Serra/Smith) sinusoidal+residual pitch shift

```
npm install @audio/shift-sms
```

```js
import sms from '@audio/shift-sms'
```

Spectral Modeling Synthesis. Parabolic-interpolated peak picking builds sinusoidal tracks `(freq, mag, phase)`; each peak's lobe is copied intact to `round(f·ratio)`. Stochastic residual shifts to ratio-scaled bins with analysis phase.

```js
sms(audio, { ratio: 2 })
sms(audio, { ratio: 1.5, maxTracks: 40 })
```

| Param | Default | |
|---|---|---|
| `maxTracks` | `Infinity` | Max simultaneous sinusoidal tracks |
| `minMag` | `1e-4` | Peak detection threshold (linear) |

**Preserves** formant envelope (lobes scale freely with peaks), harmonic structure, tonal clarity.<br>
**Destroys** transients, noise-like textures (absorbed into residual), polyphony beyond `maxTracks`.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.002 | 0.963 | 1.845 | 0.929 | 1.701 |

Lower attack corr (0.963) because sinusoidal modeling smooths onset transients into the residual.

**Use when:** Sustained tonal / harmonic instruments, vowels.<br>
**Not for:** Percussion, noise-heavy material.

## Stream

```js
let write = sms({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`sms` streams per-frame: each `write(chunk)` call renormalizes and emits audio as soon as a frame completes, and re-chunking the same input differently reproduces the batch output byte for byte.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
