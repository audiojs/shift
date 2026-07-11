# @audio/shift-wsola [![npm](https://img.shields.io/npm/v/@audio/shift-wsola)](https://www.npmjs.com/package/@audio/shift-wsola) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

WSOLA (Waveform-Similarity Overlap-Add) pitch shift — similarity-search OLA variant

```
npm install @audio/shift-wsola
```

```js
import wsola from '@audio/shift-wsola'
```

WSOLA time-stretch + sinc resample. Searches each grain position ±`tolerance` samples for maximum cross-correlation with the previous grain's tail, eliminating phase cancellation before resampling to the target pitch.

```js
wsola(audio, { ratio: 0.85 })
wsola(audio, { ratio: 1.5, tolerance: 512 })
```

| Param | Default | |
|---|---|---|
| `tolerance` | `frameSize/4` | Similarity search radius (±samples) |

**Preserves** local waveform shape, attack envelopes.<br>
**Destroys** formants (shifted by resample), phase coherence across long spans.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.67 | 0.1 | 0.005 | 0.995 | 2.358 | 0.864 | 1.674 |

f0 err 1.67 Hz from sinc resample quantization (time-domain algorithms round the stretch ratio to grain boundaries). Attack corr 0.995 ties `delay` for second place — only `hpss`'s untouched percussive pass-through scores higher.

**Use when:** Speech, low-latency, anywhere the phase vocoder's frame latency is unacceptable.<br>
**Not for:** Polyphonic music with sustained tones.

## Stream

```js
let write = wsola({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`wsola` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` here is a fixed number for the whole call — a function or `Float32Array` throws.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
