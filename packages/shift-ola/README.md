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
