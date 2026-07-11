# @audio/shift-delay [![npm](https://img.shields.io/npm/v/@audio/shift-delay)](https://www.npmjs.com/package/@audio/shift-delay) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Delay-line (harmonizer) pitch shift — dual crossfading taps sweeping a modulated delay window

```
npm install @audio/shift-delay
```

```js
import delay from '@audio/shift-delay'
```

Canonical delay-line (harmonizer) pitch shift — the method behind hardware harmonizers (Eventide H910 lineage, Lexicon "rotating tape head"). Two read taps sweep a modulated delay window at rate `ratio`, alternating through a Hann crossfade a half-cycle apart. Each time a tap wraps, it splices at whichever lag offset in the search window best correlates with the still-live tap ("intelligent splicing"), which is what keeps the join from phase-slipping the carrier.

```js
delay(audio, { ratio: 1.5 })
delay(audio, { ratio: 1.5, window: 1024, tolerance: 128 })
```

| Param | Default | |
|---|---|---|
| `window` | `2048` | Delay-line length (samples); trades flutter rate against transient smear |
| `tolerance` | `window/4` | Splice search radius (±samples) |

**Preserves** duration, pitch accuracy — no grain or frame to quantize the shift against; state is bounded by `window` samples, the shape a real-time implementation needs.<br>
**Destroys** clean sustain on wideband or polyphonic material — the two taps share one delay line, so simultaneous partials all splice through the same wrap points and beat against each other; audible as mild flutter at the crossfade rate.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.10 | 0.1 | 0.028 | 0.995 | 2.445 | 0.940 | 1.610 |

f0 err 1.10 Hz sits at the measurement floor — nothing here to quantize pitch against. Formant dist 2.445 is unremarkable: the shared delay line resamples the envelope exactly like a time-domain stretch does, no better.

The streaming `write`/`flush` wrapper shipped here buffers the whole input like `hpss`/`hybrid` — the algorithm's own state is bounded by `window` samples, but nothing yet exposes that as incremental output.

**Use when:** Real-time-shaped, lowest-latency time-domain shifting, or the hardware-harmonizer flutter is the wanted character.<br>
**Not for:** Dense chords or polyphony (the splice artifacts stack per partial).

## Stream

```js
let write = delay({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`delay` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
