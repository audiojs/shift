# @audio/shift-transient [![npm](https://img.shields.io/npm/v/@audio/shift-transient)](https://www.npmjs.com/package/@audio/shift-transient) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Transient-aware phase vocoder pitch shift with attack preservation

```
npm install @audio/shift-transient
```

```js
import transient from '@audio/shift-transient'
```

Peak-locked phase vocoder with spectral-flux transient detection. On transient frames, synthesis phase resets to analysis phase, preserving attacks. Between transients, behaves like `phaseLock`.

```js
transient(audio, { ratio: 1.5 })
transient(audio, { semitones: 5, transientThreshold: 2.0 })
```

| Param | Default | |
|---|---|---|
| `transientThreshold` | `1.5` | z-score over log-flux EMA (higher = fewer resets) |

**Preserves** phase coherence, partial structure, attack localization on detected transients.<br>
**Destroys** formants; misses quiet transients at too-high threshold.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 0.00 | 0.0 | 0.000 | 0.984 | 1.423 | 0.999 | 1.755 |

Byte-identical to `phaseLock` on every fixture in the quality suite — the onset detector's z-score gate never fires on them, not even the plucked string's attack. It's built for real percussive onsets (see the demo's rock-beat fixture, which `npm run quality` doesn't score); on this synthetic suite it's a phaseLock with unused wiring.

**Use when:** Music with drums — the default choice.<br>
**Not for:** Voice where formant preservation matters.

## Stream

```js
let write = transient({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`transient` streams per-frame: each `write(chunk)` call renormalizes and emits audio as soon as a frame completes, and re-chunking the same input differently reproduces the batch output byte for byte.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
