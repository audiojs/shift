# @audio/shift-hpss [![npm](https://img.shields.io/npm/v/@audio/shift-hpss)](https://www.npmjs.com/package/@audio/shift-hpss) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Harmonic/Percussive Source Separation pitch shift — shifts harmonics, preserves transients

```
npm install @audio/shift-hpss
```

```js
import hpss from '@audio/shift-hpss'
```

Fitzgerald median-filter harmonic/percussive separation. Time-axis and frequency-axis medians produce soft Wiener masks splitting the spectrogram. Harmonic component is vocoder-shifted; percussive component passes through with original phase.

```js
hpss(audio, { ratio: 1.5 })
hpss(audio, { ratio: 1.5, hpssTimeWidth: 31, hpssFreqWidth: 31 })
```

| Param | Default | |
|---|---|---|
| `hpssTimeWidth` | `17` | Median window width (frames) |
| `hpssFreqWidth` | `17` | Median window width (bins) |
| `hpssPower` | `2` | Soft-mask exponent |

**Preserves** percussive onset locations (unshifted) and harmonic pitch (shifted).<br>
**Destroys** signal quality at ambiguous mask boundaries (leakage in both directions).

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.052 | **0.998** | 1.207 | 0.928 | **1.487** |

Best overall shift score — keeping percussion unshifted sidesteps most artifacts. It also has the best attack correlation in the whole collection (0.998): the percussive component's phase is never touched, so a plucked-string attack survives more faithfully than even the time-domain similarity-search methods. Alias 0.052 is residual harmonic energy leaking through the percussive mask.

**Use when:** Mixed music where drums should stay stationary while melody shifts.<br>
**Not for:** Solo tonal material (unnecessary separation overhead).

## Stream

```js
let write = hpss({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`hpss` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
