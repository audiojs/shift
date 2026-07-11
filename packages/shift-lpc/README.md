# @audio/shift-lpc [![npm](https://img.shields.io/npm/v/@audio/shift-lpc)](https://www.npmjs.com/package/@audio/shift-lpc) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

LPC source-filter pitch shift — repitched excitation residual through the unmodified all-pole vocal-tract filter

```
npm install @audio/shift-lpc
```

```js
import lpc from '@audio/shift-lpc'
```

Canonical LPC source-filter pitch shift (residual-excited linear prediction, RELP lineage). Per frame: fit the vocal-tract all-pole filter A(z) by the autocorrelation method (Levinson-Durbin), inverse-filter the signal down to its spectrally-flat excitation residual, repitch that residual with the `delay` line splicer, then resynthesize through the **unmodified** 1/A(z) run continuously with block-switched coefficients. The synthesis filter's poles never move — the classical speech-processing complement to `formant`'s cepstral envelope preservation, built on a different mechanism (an explicit source-filter model instead of a magnitude-envelope correction).

```js
lpc(audio, { ratio: 1.5 })
lpc(audio, { ratio: 1.5, order: 24, frameSize: 512 })
```

| Param | Default | |
|---|---|---|
| `order` | `min(frameSize/16, round(2 + sr/1000))` | AR filter order (pole count) |
| `frameSize` | `1024` | Analysis/synthesis frame length |

**Preserves** formant frequencies by construction — the filter that carries them is never touched, only its excitation is repitched.<br>
**Destroys** pure tones by design: on a single sinusoid the AR envelope IS the partial, so the filter locks onto it and pitch barely moves — the family's defining tradeoff, not a bug.

| f0 err | THD% | alias | attack corr | formant dist | phase coh | shift |
|-------:|-----:|------:|------------:|-------------:|----------:|------:|
| 228.33 | 0.8 | 2.274 | 0.987 | 1.382 | 0.975 | 1.811 |

f0 err 228.33 Hz and alias 2.274 — both worst in the collection, and both the same degeneracy: on the alias test's 14 kHz tone (pushed toward Nyquist), the AR fit locks onto that single partial and the high-order synthesis filter rings into sharp amplitude spikes rather than shifting cleanly. Formant dist 1.382 is higher (worse) than `formant`'s 0.765 on this synthetic vowel too, across every `order` from 8 to 64 — the fitted envelope follows the fixture's individual harmonics as well as its three formants, where `formant`'s deliberately-smoothed cepstral envelope doesn't. None of this is the intended material: real, less strictly periodic speech is what an unmodified synthesis filter is for.

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
