# @audio/shift-sample [![npm](https://img.shields.io/npm/v/@audio/shift-sample)](https://www.npmjs.com/package/@audio/shift-sample) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Sampler-style pitch shift — sinc-interpolated fractional-stride resample (no time preservation)

```
npm install @audio/shift-sample
```

```js
import sample from '@audio/shift-sample'
```

Playback-rate pitch shift. Hann-windowed sinc interpolation at a fractional read-head stepped by `ratio` per output sample. No time preservation — higher pitch = shorter clip.

```js
sample(instrumentBuffer, { semitones: 7 })
sample(audio, { ratio: 2, sincRadius: 16 })
```

| Param | Default | |
|---|---|---|
| `sincRadius` | `8` | Windowed-sinc half-width (samples) |

**Preserves** waveform identity (literally the same audio, faster/slower), formants — everything scales together.<br>
**Destroys** time: output duration = `input_length / ratio`, zero-padded to match API.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 2.50 | 0.1 | 0.007 | 0.951 | 2.330 | 0.170 | 1.614 |

Phase coh 0.170 because the modulation rate itself shifts with the pitch (a 5 Hz tremolo becomes 7.5 Hz at ratio 1.5). This is correct behavior for a sampler — not an artifact.

**Use when:** Instrument one-shots, ROM-sample playback, tracker-style.<br>
**Not for:** Time-preserving pitch shift.

## Stream

```js
let write = sample({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`sample` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
