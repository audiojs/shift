# @audio/shift-pvoc-lock [![npm](https://img.shields.io/npm/v/@audio/shift-pvoc-lock)](https://www.npmjs.com/package/@audio/shift-pvoc-lock) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Peak-locked phase vocoder (Laroche-Dolson) pitch shift

```
npm install @audio/shift-pvoc-lock
```

```js
import phaseLock from '@audio/shift-pvoc-lock'
```

Laroche-Dolson peak-locked phase vocoder. Peaks scatter to shifted bins; non-peak bins lock their phase relative to the nearest peak, keeping the vertical phase relationship inside each sinusoidal lobe intact.

```js
phaseLock(audio, { ratio: 1.5 })
```

**Preserves** phase coherence around peaks, partial structure.<br>
**Destroys** transients (still smeared, less than `vocoder`), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |

**Use when:** General music — the "try this first" phase vocoder.<br>
**Not for:** Music with drums (use `transient`), voice (use `formant`).

## Stream

```js
let write = phaseLock({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`phaseLock` streams per-frame: each `write(chunk)` call renormalizes and emits audio as soon as a frame completes, and re-chunking the same input differently reproduces the batch output byte for byte.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
