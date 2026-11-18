import { bufferedStream, hannWindow, makePitchShift, matchGain, resolveRatio, takeLength } from './host.js'
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

// The widening, Hz a frame, of the synthesis filter's poles past the take (below)
const BW = 60

function lpcBatch(data, opts, take = takeLength(data)) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let n = data.length
  let N = opts?.frameSize ?? 1024
  let hop = N >> 2
  let sr = opts?.sampleRate || 44100
  let p = opts?.order ?? Math.min(N >> 4, Math.round(2 + sr / 1000))
  let out = new Float32Array(n)
  // The take ends at its last sound; what follows is silence, which a host that renders the
  // tail appends. Fit, residual and level stop there, so what lpc writes over the take is
  // the same whatever silence follows it.
  let m = Math.min(take, n)
  if (!m) return out

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
  // Past the take the residual is silence's: there A(z) = 1, what a fit of silence gives.
  let res = new Float32Array(n)
  for (let t = 0; t < m; t++) {
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
  for (let t = 0; t < Math.min(m, n); t++) {
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
  // (B = 60 Hz, the bandwidth expansion of 3GPP TS 26.190 § 5.2.1, a frame). The fit is not
  // regularised, so a pole can sit on the unit circle (a pure tone's), and left as it is its
  // ring would never end; drawn in, it ends within the tail the manifest declares. The first
  // frame past the take keeps the coefficients as they are, so nothing steps at the take's end.
  let last = (frames - 1) * (p + 1), drawn = new Float64Array(p + 1), q = -1
  for (let t = m; t < n; t++) {
    let qt = ((t - m) / hop) | 0
    if (qt !== q) {
      q = qt
      let g = Math.exp(-Math.PI * BW * q / sr)
      for (let j = 1, gj = g; j <= p; j++, gj *= g) drawn[j] = coefs[last + j] * gj
    }
    let y = shifted[t]
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
  return matchGain(out, data, m)
}

let lpcStream = (opts) => bufferedStream(lpcBatch, opts)

export default makePitchShift(lpcBatch, lpcStream)
