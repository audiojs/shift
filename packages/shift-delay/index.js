import { bufferedStream, makePitchShift, resolveRatio, sincRead } from '@audio/shift-core'

// Canonical delay-line (harmonizer) pitch shift — the method of hardware harmonizers
// (Eventide H910 lineage, Lexicon "rotating tape head"). Two read taps sweep a delay
// window at rate `ratio`; each tap's lag ramps sawtooth-wise across the window and the
// taps alternate through a Hann crossfade (half-cycle offset, amplitudes summing to
// unity) so a tap only wraps while silent. Each wrap splices at the lag offset that
// maximally correlates with the live tap ("intelligent splicing") — an unaligned splice
// phase-slips the carrier and smears the spectral peak; an aligned one keeps the taps
// coherent, which is also why the plain (not equal-power) crossfade is the right law.
// Real-time capable with `window` samples of latency by design; the residual artifact
// is mild flutter at the crossfade rate on wideband material. `window` (samples,
// default 2048) trades flutter rate against transient smear; `tolerance` (default
// window/4) bounds the splice search.
function delayBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let n = data.length
  let W = opts?.window ?? 2048
  let L = opts?.tolerance ?? (W >> 2)
  let sr = opts?.sampleRate || 44100
  let out = new Float32Array(n)
  if (!n) return out
  let cutoff = 1
  let pos = [0, 0]
  let phase = [0, 0.5]
  // Best-correlated splice offset: align the wrapping tap's future read with the live
  // tap's — plain dot product over K samples, once per wrap.
  let splice = (target, live) => {
    let K = Math.min(256, n)
    let best = 0, bestC = -Infinity
    for (let o = -L; o <= L; o += 2) {
      let c = 0
      for (let j = 0; j < K; j += 2) {
        let a = live + j, b = target + o + j
        if (b < 0 || b >= n || a >= n) continue
        c += data[a | 0] * data[b | 0]
      }
      if (c > bestC) { bestC = c; best = o }
    }
    return target + best
  }
  for (let i = 0; i < n; i++) {
    let r = ratioFn ? ratioFn(i / sr) : ratio
    if (!(r > 0) || !Number.isFinite(r)) r = ratio
    cutoff = r > 1 ? 1 / r : 1
    for (let t = 0; t < 2; t++) {
      // Tap wraps (re-centers on the write head) exactly at its crossfade null.
      if (phase[t] >= 1) { phase[t] -= 1; pos[t] = splice(i, pos[1 - t]) }
      // Plain Hann crossfade: splicing phase-aligns the taps, so amplitudes — not
      // powers — must sum to unity (equal-power would overshoot correlated content).
      let w = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase[t])
      if (w > 1e-6) out[i] += w * sincRead(data, pos[t], 8, cutoff)
      pos[t] += r
      // Lag drifts by (r - 1) per sample; a full window of drift is one saw cycle.
      phase[t] += Math.abs(r - 1) / W
    }
    // Identity-adjacent ratios never wrap; taps stay put and the Hann pair sums to 1.
  }
  return out
}

let delayStream = (opts) => bufferedStream(delayBatch, opts)

export default makePitchShift(delayBatch, delayStream)
