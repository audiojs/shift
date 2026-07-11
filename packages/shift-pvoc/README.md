# @audio/shift-pvoc [![npm](https://img.shields.io/npm/v/@audio/shift-pvoc)](https://www.npmjs.com/package/@audio/shift-pvoc) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Canonical phase vocoder (Bernsee/SMB) pitch shift

```
npm install @audio/shift-pvoc
```

```js
import vocoder from '@audio/shift-pvoc'
```

SMB/Bernsee bin-shift. Computes true instantaneous frequency per bin from consecutive-frame phase advance, scatters peaks to shifted bins, accumulates synthesis phase at the shifted frequency.

```js
vocoder(audio, { ratio: 1.5 })
```

**Preserves** dominant-partial pitch, long-horizon phase per bin.<br>
**Destroys** transients, vertical phase coherence ("phasiness"), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.981 | 1.158 | 0.928 | 1.553 |

Phase coh 0.928 from independent per-bin phase accumulation — no inter-bin locking. Best shift score among the general phase vocoders — the simpler scatter avoids the peak-locked family's own assignment overhead on these fixtures.

**Use when:** Simple tonal material, educational baseline.<br>
**Not for:** Music with percussion, voice.

## Stream

```js
let write = vocoder({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`vocoder` streams per-frame: each `write(chunk)` call renormalizes and emits audio as soon as a frame completes, and re-chunking the same input differently reproduces the batch output byte for byte.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
