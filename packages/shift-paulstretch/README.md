# @audio/shift-paulstretch [![npm](https://img.shields.io/npm/v/@audio/shift-paulstretch)](https://www.npmjs.com/package/@audio/shift-paulstretch) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Paulstretch-style randomized-phase pitch shift for textural blur

```
npm install @audio/shift-paulstretch
```

```js
import paulstretch from '@audio/shift-paulstretch'
```

Large-frame (16k) phase randomization. Magnitudes pulled from source bins at `k/ratio`; phases drawn from a seeded PRNG every frame. Destroys temporal structure by design.

```js
paulstretch(audio, { ratio: 1.5 })
paulstretch(audio, { ratio: 1.5, seed: 42 })
```

| Param | Default | |
|---|---|---|
| `seed` | fixed (`0x1f123bb5`) | 32-bit PRNG seed for the per-frame phase draw |

Deterministic: the same `seed` (the shipped default, or one you pass) always reproduces the same phase sequence and therefore byte-identical output. Pass `seed` to get a different, still-reproducible draw.

**Preserves** long-term magnitude-spectrum statistics.<br>
**Destroys** phase, transients, rhythm — by design.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.2 | 0.230 | 0.935 | 7.371 | 0.518 | 2.221 |

Worst formant dist by a wide margin (7.371 — the next-worst is `granular` at 3.486) because random phases smear spectral energy across the frame; the smear is the aesthetic. Alias 0.230 is the same smear leaking past Nyquist.

**Use when:** Ambient/drone textures, extreme shift ratios.<br>
**Not for:** Anything requiring temporal precision.

## Stream

```js
let write = paulstretch({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`paulstretch` streams per-frame: each `write(chunk)` call renormalizes and emits audio as soon as a frame completes, and re-chunking the same input differently reproduces the batch output byte for byte.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
