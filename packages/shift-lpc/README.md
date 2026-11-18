# @audio/shift-lpc [![npm](https://img.shields.io/npm/v/@audio/shift-lpc)](https://www.npmjs.com/package/@audio/shift-lpc) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

LPC source-filter pitch shift — repitched excitation residual through the unmodified all-pole vocal-tract filter

```
npm install @audio/shift-lpc
```

```js
import lpc from '@audio/shift-lpc'
```

Canonical LPC source-filter pitch shift (residual-excited linear prediction, RELP lineage). Per frame: fit the vocal-tract all-pole filter A(z) by the autocorrelation method (Levinson-Durbin), inverse-filter the signal down to its spectrally-flat excitation residual, repitch that residual with the `delay` line splicer, then resynthesize through the **unmodified** 1/A(z) run continuously with block-switched coefficients. Over the take the synthesis filter's poles never move — the classical speech-processing complement to `formant`'s cepstral envelope preservation, built on a different mechanism (an explicit source-filter model instead of a magnitude-envelope correction).

```js
lpc(audio, { ratio: 1.5 })
lpc(audio, { ratio: 1.5, order: 24, frameSize: 512 })
```

| Param | Default | |
|---|---|---|
| `order` | `min(frameSize/16, round(2 + sr/1000))` | AR filter order (pole count) |
| `frameSize` | `1024` | Analysis/synthesis frame length |

**Preserves** formant frequencies by construction — the filter that carries them is never touched, only its excitation is repitched.<br>
**Destroys** pure tones by design: on a single sinusoid the AR envelope IS the partial, so the fit notches it out of the residual: what is left of it shifts, far under the tone, and its onset rings at the original pitch — the family's defining tradeoff, not a bug.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.32 | 0.1 | 4.483 | 0.985 | 1.393 | 0.937 | 1.702 |

Alias 4.483 is the worst in the collection: the alias test's 14 kHz tone, shifted ×2, lands past Nyquist and is rightly gone from the residual, and what is left is its onset ringing the fit's pole at 14 kHz, which the level match brings to the input's level. Formant dist 1.393 is higher (worse) than `formant`'s 0.765 on this synthetic vowel too, across every `order` from 8 to 64 — the fitted envelope follows the fixture's individual harmonics as well as its three formants, where `formant`'s deliberately-smoothed cepstral envelope doesn't. None of this is the intended material: real, less strictly periodic speech is what an unmodified synthesis filter is for.

Each sound of a call, a stretch between runs of silence, renders as a take followed by silence, and what the takes render adds. Silence is a run of samples at or under one 16-bit step (2^-15), `frameSize` long or more, or one that runs to the call's end: exact zeros and a 16-bit file's dither alike, and it excites nothing, so a quiet passage at that level renders as silence. Past a take's last sound 1/A(z) runs on with its state over what the delay line still plays, its poles drawn inward 60 Hz a frame, and its ring ends inside the audio manifest's declared `tail`, with no cut and no step at the last sound. So a stop renders the same wherever it falls: at the call's end, in the middle of the call, in a channel that ends before the others, into zeros or into dither; a sound after it, a click as much as a note, moves nothing of the take, whose level is matched over the take. Over the 1024 frames after a stop that ends the call, re the 1024 before it, the ring holds −97.1 to +5.9 dB, and the take and its ring are written otherwise in none of 32 renders at a stop mid-take, in a channel ending 0.2 s early, into 16-bit dither, or with a click 2000 frames on (`node scripts/ends.js lpc`: a sung voice, audio-lena, and a 220 Hz tone at 22.05 to 96 kHz, ±5 and ±12 semitones).

Every fit is bandwidth-expanded, a_k·0.994^k (the weighting factor of FED-STD-1016 § 3.7.2), so no pole sits on the unit circle and a pure tone renders bounded: over the take's middle at most 1.07 times its peak at ±5 semitones and 1.11 times at ±12, over its first 4096 frames, where the onset rings the fit's pole, at most 9.35 and 9.70 times (the same script: 250 Hz to 4 kHz, 22.05 to 96 kHz). The level match corrects a level only within 0.1 to 10 times the input's and leaves the rest as it is: at ±12 semitones 4 of the 48 tones render under the input, by up to 25.9 dB.

**Use when:** Speech/vocals where the formants must not move with pitch, and the material isn't a bare sustained tone.<br>
**Not for:** Pure tones, synth pads, or anything where the "partial" and the "envelope" are the same thing.

## Stream

```js
let write = lpc({ ratio: 1.5 })
let out = write(inputBlock)
let tail = write()  // flush
```

`lpc` buffers the whole input; `write(chunk)` accumulates and the batch algorithm runs once on `write()` (flush, no argument), returning everything at once.

## Data

Input is a `Float32Array` (mono) or an array of `Float32Array` channels (`[left, right, ...]`) — anything else throws `TypeError`. `ratio` also accepts a function `t => ratio` (seconds from stream start) or a `Float32Array` breakpoint envelope (resampled across the input via `ratioDuration`, default the input's own duration) for time-varying pitch.

---

Part of [@audio/shift](https://github.com/audiojs/shift) — the shift family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
