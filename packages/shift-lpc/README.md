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
| `peak` | the input's loudest sample | The call's loudest sample, over all its channels, where one channel of several is shifted alone |

**Preserves** formant frequencies by construction — the filter that carries them is never touched, only its excitation is repitched.<br>
**Destroys** pure tones by design: on a single sinusoid the AR envelope IS the partial, so the fit notches it out of the residual: what is left of it shifts, at the tone's level only where the tone is low or the shift small, and its onset rings at the original pitch — the family's defining tradeoff, not a bug. At 44.1 kHz a 110 Hz tone keeps its level at every shift to 12 semitones either way, 220 Hz to five semitones, 440 and 880 Hz at one; at five semitones 880 Hz lies 17 dB under and 1760 Hz 57 dB, at twelve 1760 Hz 73 dB (`node scripts/ends.js lpc`).

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 1.32 | 0.1 | 4.483 | 0.985 | 1.393 | 0.937 | 1.702 |

Alias 4.483 is the worst in the collection: the alias test's 14 kHz tone, shifted ×2, lands past Nyquist and is rightly gone from the residual, and what is left is its onset ringing the fit's pole at 14 kHz, which the level match brings to the input's level. Formant dist 1.393 is higher (worse) than `formant`'s 0.765 on this synthetic vowel too, across every `order` from 8 to 64 — the fitted envelope follows the fixture's individual harmonics as well as its three formants, where `formant`'s deliberately-smoothed cepstral envelope doesn't. None of this is the intended material: real, less strictly periodic speech is what an unmodified synthesis filter is for.

Each sound of a call, a stretch between runs of silence, renders as a take followed by silence, and what the takes render adds. Silence is a run of samples at or under 2^-15 of the call's peak, its loudest sample over all its channels, `frameSize` long or more, or one that runs to the call's end: exact zeros and noise at that level alike, and it excites nothing, so a quiet passage at that level renders as silence. Past a take's last sound 1/A(z) runs on with its state over what the delay line still plays, its poles drawn inward 60 Hz a frame, and its ring ends inside the audio manifest's declared `tail`, with no cut and no step at the last sound. So a stop renders the same wherever it falls: at the call's end, in the middle of the call, in a channel that ends before the others, into zeros or into noise at the silence level; a sound after it, a click as much as a note, moves nothing of the take, whose level is matched over the take. Over the 1024 frames after a stop that ends the call, re the 1024 before it, the ring holds −97.1 to +5.9 dB, and the take and its ring are written otherwise in none of 32 renders at a stop mid-take, in a channel ending 0.2 s early, into noise at its silence level, or with a click 2000 frames on (`node scripts/ends.js lpc`: a sung voice, audio-lena, and a 220 Hz tone at 22.05 to 96 kHz, ±5 and ±12 semitones).

Every fit is bandwidth-expanded, a_k·0.994^k (the weighting factor of FED-STD-1016 § 3.7.2), so no pole sits on the unit circle and a pure tone renders bounded: over the take's middle at most 1.07 times its peak at ±5 semitones and 1.11 times at ±12, over its first 4096 frames, where the onset rings the fit's pole, at most 9.35 and 9.70 times (the same script: 250 Hz to 4 kHz, 22.05 to 96 kHz). The level match corrects a level only within 0.1 to 10 times the input's and leaves the rest as it is: at ±12 semitones 4 of the 48 tones render under the input, by up to 25.9 dB.

Every level lpc compares (its silence, the floors of its fit, the bounds of its level match) is a fraction of the call's peak, so a call times a factor renders as its render times that factor. A power of two does so bit for bit but where a ring's far tail falls into float32's subnormals, under 2^-126, and rounds otherwise: no sample over 2^-117.3 differs, none within 563.9 dB of the render's peak. Any other factor does so within its rounding, on the voice to −94.9 dB re the peak; on a pure tone a rounding can move one of the delay line's splices, to −14.8 dB (`node scripts/ends.js scale`: 675 channel renders, the voice and two tones at 22.05 to 96 kHz, alone and beside a channel 30 dB down, 2^-20 to 2^4). One channel of a call with more, shifted alone, takes the call's peak as `peak` (`lpc(left, { ratio: 1.5, peak })`); without it, its own.

At a peak of 1 the silence level is one 16-bit step, so a 16-bit file's dither is silence where the file holds −32768. At its positive full scale, 32767, or under, the dither's steps are over the level and are sound: a take does not part there but renders on through the dither as one take with it, as a sudden drop in the middle of a take does. Into that dither a take cut where it is loud comes out up to 17.0 dB under its input over its first 0.4 s (24.7 dB at a peak of −40 dBFS), its level carried by what its fit rings at the cut, where at a peak of 1 it lies within 1.0 dB of it; a take that fades keeps its level but over its last 0.1 s, 2.1 to 19.8 dB over the input's there (−3.8 to +9.0 dB at a peak of 1); and two notes with the dither between them are level matched as one, the second, 12 dB down, 1.7 to 9.0 dB under its input's level, where at a peak of 1 each is at its own (`node scripts/ends.js dither`: the voice at 44.1 kHz, its peak 32767/32768 to −40 dBFS, ±5 and ±12 semitones). A passage hovering about the silence level parts into sounds where it dips under it a `frameSize` at a time, each level matched alone: a 220 Hz tone swinging from 0.655 to 1.47 times the level at 4 Hz, after the voice at a peak of 1, parts into 9 and comes out 0.8 to 1.1 dB under its input's level at ±5 semitones (the same script).

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
