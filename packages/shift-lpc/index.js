import { bufferedStream, hannWindow, makePitchShift, matchGain, resolveRatio } from '@audio/shift-core'
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
// there the AR envelope IS the partial, so the filter re-imposes the original pitch;
// that is the family's defining tradeoff, not a bug. `order` defaults to the classical
// 2 + sr/1000, capped so pole pairs model the envelope, not individual harmonics.

function levinson(r, p, a, tmp) {
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
    if (err < 1e-12) { err = 1e-12; break }
  }
  return err
}

function lpcBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let n = data.length
  let N = opts?.frameSize ?? 1024
  let hop = N >> 2
  let sr = opts?.sampleRate || 44100
  let p = opts?.order ?? Math.min(N >> 4, Math.round(2 + sr / 1000))
  let out = new Float32Array(n)
  if (!n) return out

  let win = hannWindow(N)
  let frames = Math.ceil(n / hop)
  let coefs = new Float64Array(frames * (p + 1))
  let xw = new Float64Array(N)
  let r = new Float64Array(p + 1)
  let a = new Float64Array(p + 1)
  let tmp = new Float64Array(p + 1)

  for (let f = 0; f < frames; f++) {
    // Clamp the fit window inside the signal: a zero-padded tail window fits the fade,
    // whitens poorly, and the hot residual tail then rings the synthesis filter.
    let start = Math.max(0, Math.min(f * hop, n - N))
    for (let u = 0; u < N; u++) {
      let t = start + u
      xw[u] = t < n ? data[t] * win[u] : 0
    }
    for (let k = 0; k <= p; k++) {
      let s = 0
      for (let u = k; u < N; u++) s += xw[u] * xw[u - k]
      r[k] = s
    }
    r[0] *= 1.000001
    if (r[0] < 1e-12) { coefs[f * (p + 1)] = 1; continue }
    levinson(r, p, a, tmp)
    coefs.set(a, f * (p + 1))
  }

  // Inverse-filter with block-switched coefficients: e = A(z)·x, state continuous.
  let res = new Float32Array(n)
  for (let t = 0; t < n; t++) {
    let base = Math.min(frames - 1, (t / hop) | 0) * (p + 1)
    let e = data[t]
    for (let j = 1; j <= p; j++) {
      let tj = t - j
      if (tj >= 0) e += coefs[base + j] * data[tj]
    }
    res[t] = e
  }

  // Repitch the flat residual, then run 1/A(z) continuously over it — no grains, no
  // synthesis transients; each sample uses its own frame's coefficients.
  let shifted = delay(res, { ...opts, ratio: ratioFn || ratio })
  for (let t = 0; t < n; t++) {
    let base = Math.min(frames - 1, (t / hop) | 0) * (p + 1)
    let y = shifted[t]
    for (let j = 1; j <= p; j++) {
      let tj = t - j
      if (tj >= 0) y -= coefs[base + j] * out[tj]
    }
    out[t] = y
  }

  // Harmonics moving across the AR response change level with position; a single
  // whole-signal RMS match restores loudness without touching the envelope shape
  // (time-varying gain would ring AM sidebands through every harmonic). The stream
  // form is bufferedStream — whole-signal at flush — so batch and stream stay
  // identical even with a global correction.
  return matchGain(out, data)
}

let lpcStream = (opts) => bufferedStream(lpcBatch, opts)

export default makePitchShift(lpcBatch, lpcStream)
