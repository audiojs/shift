import { bufferedStream, hannWindow, makePitchShift, matchGain, peakOf, resolveRatio } from './host.js'
import delay from '@audio/shift-delay'

// Canonical LPC source-filter pitch shift (residual-excited linear prediction, RELP
// lineage): per frame, estimate the vocal-tract all-pole filter A(z) by the
// autocorrelation method (Levinson-Durbin), inverse-filter the signal to its
// spectrally-flat excitation residual, repitch the residual with the delay-line
// splicer (@audio/shift-delay — duration-preserving, and its correlation splicing
// lands on the residual's pitch pulses), and resynthesize through the UNMODIFIED
// 1/A(z) run continuously with block-switched coefficients — the formant envelope
// never moves, by construction. The classical speech-processing complement to
// cepstral envelope preservation (@audio/shift-formant): exact on voiced monophonic
// material, graceful-but-averaged on polyphony. Degenerate on narrowband/pure tones —
// there the AR envelope IS the partial, so the fit notches the tone out of the residual:
// what is left of it shifts, at the tone's level only where the tone is low or the shift small,
// and its onset rings the fit's pole at the original pitch; that is the family's defining
// tradeoff, not a bug. `order` defaults to the classical 2 + sr/1000, capped so pole pairs
// model the envelope, not individual harmonics.

function levinson(r, p, a, tmp, floor) {
  a.fill(0)
  a[0] = 1
  let err = r[0]
  for (let i = 1; i <= p; i++) {
    let acc = r[i]
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
    let k = -acc / err
    for (let j = 0; j <= i; j++) tmp[j] = a[j] + k * a[i - j]
    for (let j = 0; j <= i; j++) a[j] = tmp[j]
    err *= 1 - k * k
    if (err < floor) break
  }
  return err
}

// Bandwidth expansion of every fit, a_k·γ^k: each pole's radius times γ, so 1/A(z) has a
// bound where a pure tone, perfectly predictable, would put its pole on the unit circle.
// γ = 0.994, the weighting factor of FED-STD-1016 § 3.7.2 (15 Hz at its 8 kHz), as a
// factor a sample at every rate
const GAMMA = 0.994
// The widening, Hz a frame, of the synthesis filter's poles past a take (below)
const BW = 60
// Every level lpc compares is a fraction of the call's peak, its loudest sample over all its
// channels, so a call times a factor renders as its render times that factor. Silence: a run
// of samples at or under QUIET of the peak, a fit window long or more, or one that runs to the
// call's end; at a peak of 1, one 16-bit step
const QUIET = 2 ** -15
// Levinson's floor, a fraction of the peak's square: a fit window whose energy, or a
// prediction error, falls under it holds nothing more to fit
const FLOOR = 1e-12
// Frames a take renders past the delay line's span: over them γ alone takes its ring
// down 850 dB, so it ends on the take's own frames
const RING = 1 << 14

// The call's sounds, each between runs of silence, render as takes of their own, and what
// they render adds: a sound is a take followed by silence wherever it stops, at the call's
// end, in the middle of the call or in a channel that ends early, into zeros or into noise
// at the silence level, and no sound moves another's level. The silence itself excites nothing.
function lpcBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let n = data.length
  let N = opts?.frameSize ?? 1024
  // the call's peak: given where this is one channel of several, else this channel's
  let peak = opts?.peak ?? peakOf(data), quiet = QUIET * peak
  let out = new Float32Array(n)
  // `last` the last sound sample; a take's frames start at `from`, its sound at `loud`
  for (let t = 0, from = 0, loud = 0, last = -1; t <= n; t++) {
    if (t < n && Math.abs(data[t]) <= quiet) continue
    if (t === n || t - last > N) {
      if (last >= loud) lpcTake(data, from, loud, last + 1, opts, ratio, ratioFn, FLOOR * peak * peak, out)
      from = last + 1, loud = t
    }
    last = t
  }
  return out
}

// One sound, data[loud, to), as a take on frames of its own from `from` (the silence before
// it, as zeros), its render and its ring added into `into` from `from` on
function lpcTake(data, from, loud, to, opts, ratio, ratioFn, floor, into) {
  let N = opts?.frameSize ?? 1024
  let hop = N >> 2
  let sr = opts?.sampleRate || 44100
  let p = opts?.order ?? Math.min(N >> 4, Math.round(2 + sr / 1000))
  let m = to - from
  let x = new Float32Array(m)
  x.set(data.subarray(loud, to), loud - from)
  // @audio/shift-delay plays the residual up to W + W/4 frames late, its sinc taps beside;
  // past them it plays silence, and the filter rings on its own
  let W = opts?.window ?? 2048
  let span = m + W + (opts?.tolerance ?? (W >> 2)) + Math.ceil(8 * Math.max(1, ratio)) + 1
  let n = span + RING
  let out = new Float32Array(n)

  let win = hannWindow(N)
  let frames = Math.ceil(m / hop)
  let coefs = new Float64Array(frames * (p + 1))
  let xw = new Float64Array(N)
  let r = new Float64Array(p + 1)
  let a = new Float64Array(p + 1)
  let tmp = new Float64Array(p + 1)

  for (let f = 0; f < frames; f++) {
    // Clamp the fit window inside the take: a zero-padded tail window fits the fade,
    // whitens poorly, and the hot residual tail then rings the synthesis filter.
    let start = Math.max(0, Math.min(f * hop, m - N))
    for (let u = 0; u < N; u++) {
      let t = start + u
      xw[u] = t < m ? x[t] * win[u] : 0
    }
    for (let k = 0; k <= p; k++) {
      let s = 0
      for (let u = k; u < N; u++) s += xw[u] * xw[u - k]
      r[k] = s
    }
    r[0] *= 1.000001
    if (r[0] < floor) { coefs[f * (p + 1)] = 1; continue }
    levinson(r, p, a, tmp, floor)
    for (let j = 1, g = GAMMA; j <= p; j++, g *= GAMMA) a[j] *= g
    coefs.set(a, f * (p + 1))
  }

  // Inverse-filter with block-switched coefficients: e = A(z)·x, state continuous.
  // Past the take the residual is silence's: there A(z) = 1, what a fit of silence gives.
  let res = new Float32Array(ratioFn ? n : span)
  for (let t = 0; t < m; t++) {
    let base = Math.min(frames - 1, (t / hop) | 0) * (p + 1)
    let e = x[t]
    for (let j = 1; j <= p; j++) {
      let tj = t - j
      if (tj >= 0) e += coefs[base + j] * x[tj]
    }
    res[t] = e
  }

  // Repitch the flat residual, then run 1/A(z) continuously over it — no grains, no
  // synthesis transients; each sample uses its own frame's coefficients.
  let shifted = delay(res, { ...opts, ratio: ratioFn ? (t) => ratioFn(t + from / sr) : ratio })
  for (let t = 0; t < m; t++) {
    let base = Math.min(frames - 1, (t / hop) | 0) * (p + 1)
    let y = shifted[t]
    for (let j = 1; j <= p; j++) {
      let tj = t - j
      if (tj >= 0) y -= coefs[base + j] * out[tj]
    }
    out[t] = y
  }
  // Past the take 1/A(z) runs on with its state, over what the delay line still plays, its
  // poles drawn inward a frame at a time from the take's last sound: frame q after it has the
  // last frame's coefficients as a_k·γ^(q·k), γ = exp(−π·B/sr), every pole q·B Hz wider
  // (B = 60 Hz, the bandwidth expansion of 3GPP TS 26.190 § 5.2.1, a frame) than the fit's
  // own. The first frame past the take keeps the coefficients as they are, so nothing steps
  // at the take's end.
  let last = (frames - 1) * (p + 1), drawn = new Float64Array(p + 1), q = -1
  for (let t = m; t < n; t++) {
    let qt = ((t - m) / hop) | 0
    if (qt !== q) {
      q = qt
      let g = Math.exp(-Math.PI * BW * q / sr)
      for (let j = 1, gj = g; j <= p; j++, gj *= g) drawn[j] = coefs[last + j] * gj
    }
    let y = t < shifted.length ? shifted[t] : 0
    for (let j = 1; j <= p; j++) {
      let tj = t - j
      if (tj >= 0) y -= drawn[j] * out[tj]
    }
    out[t] = y
  }

  // Harmonics moving across the AR response change level with position; a single
  // whole-signal RMS match restores loudness without touching the envelope shape
  // (time-varying gain would ring AM sidebands through every harmonic). The stream
  // form is bufferedStream — whole-signal at flush — so batch and stream stay
  // identical even with a global correction.
  // Matched over the take; its ring past the take is scaled alike.
  matchGain(out, x, m)
  for (let t = 0, k = from; t < n && k < into.length; t++, k++) into[k] += out[t]
}

let lpcStream = (opts) => bufferedStream(lpcBatch, opts)

export default makePitchShift(lpcBatch, lpcStream)
