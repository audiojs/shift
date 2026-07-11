# @audio/shift-granular [![npm](https://img.shields.io/npm/v/@audio/shift-granular)](https://www.npmjs.com/package/@audio/shift-granular) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Granular pitch shift — direct grain-read synthesis for signature textural sound

```
npm install @audio/shift-granular
```

```js
import granular from '@audio/shift-granular'
```

Native granular pitch shift: fixed-size Hann grains laid at a constant output hop, each read from the source through an anti-aliased sinc stride read (no separate stretch+resample stage). Small grains make the per-grain splice audible as a signature grain-rate texture — that texture is the point, not a defect.

```js
granular(audio, { ratio: 1.3 })
granular(audio, { ratio: 1.3, grainSize: 1024 })
```

| Param | Default | |
|---|---|---|
| `grainSize` | `398` | Grain length in samples |

**Preserves** grain-local timbre, characteristic textural quality.<br>
**Destroys** pitch accuracy on complex tones, smooth envelopes — the 398-sample default is tuned so a chord's partials crumble audibly (~14% RMS loss) while a clean 440 Hz tone still tracks true; that crumble on chords is documented character, not a bug.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.45 | 0.0 | 0.033 | 0.996 | 3.486 | 0.997 | 2.256 |

Worst shift score and worst formant dist among all 15 algorithms — small, uncorrelated grains smear the spectrum more than even `paulstretch`'s random phase does. Raise `grainSize` toward 1024+ for a cleaner, less textural shift; the default favors character over transparency.

**Use when:** Creative/textural effects where grain character is desired.<br>
**Not for:** Transparent pitch shifting.

## Stream

```js
let write = granular({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`granular` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` here is a fixed number for the whole call — a function or `Float32Array` throws.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
