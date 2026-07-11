# @audio/shift-hybrid [![npm](https://img.shields.io/npm/v/@audio/shift-hybrid)](https://www.npmjs.com/package/@audio/shift-hybrid) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Hybrid pitch shift — runs phase-lock + WSOLA in parallel, crossfades by transient confidence

```
npm install @audio/shift-hybrid
```

```js
import hybrid from '@audio/shift-hybrid'
```

Runs `phaseLock` and `wsola` in parallel, crossfades sample-by-sample by spectral-flux transient confidence. Tonal regions resolve via the phase vocoder; attacks resolve via WSOLA similarity search, time-aligned against phaseLock before blending so the two engines' attacks land together.

```js
hybrid(audio, { ratio: 1.5 })
hybrid(audio, { ratio: 1.5, hybridThreshold: 0.6 })
```

| Param | Default | |
|---|---|---|
| `hybridThreshold` | `0.8` | Spectral-flux z-score for full WSOLA blend |

**Preserves** tonal phase coherence + attack shape — simultaneously.<br>
**Destroys** CPU budget (≈2×), formants.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.984 | 1.423 | 0.999 | 1.824 |

Same phaseLock-derived numbers as `phaseLock`/`transient` on this non-percussive suite — the WSOLA blend never activates because nothing here crosses `hybridThreshold`. Worst shift score among the frequency-adjacent methods for the same reason: it's carrying `wsola`'s parallel computation for a blend that stays at zero.

**Use when:** Mixed dynamic material where a single domain compromises the other.<br>
**Not for:** Pure tonal (just use `phaseLock`) or pure percussive (just use `transient`).

## Stream

```js
let write = hybrid({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`hybrid` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` here is a fixed number for the whole call — a function or `Float32Array` throws.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
