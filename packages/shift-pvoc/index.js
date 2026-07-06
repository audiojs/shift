import { makeStftShift } from '@audio/shift-core/stft'
import { makeFrameRatio, wrapPhase, scatterGated } from '@audio/shift-core'

// Canonical phase vocoder pitch shift (Bernsee / SMB method), peak-gated bin scatter.
// Per frame: compute true instantaneous frequency at each analysis bin eligible under the
// peak ±1 gate, shift it to the destination bin `ratio` implies, and accumulate synthesis
// phase there at the shifted frequency (below). Colliding destination bins accumulate in
// the energy domain and are per-frame renormalized (see scatterGated) — the frequency
// written to a bin is its loudest contributor's. No time-stretch, no resample.
function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half, hop } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newFreq = new Float64Array(half + 1)
    state.peakMag = new Float64Array(half + 1)
    state.first = true
  }

  let { prev, syn, newMag, newFreq, peakMag } = state
  newMag.fill(0)
  newFreq.fill(0)
  peakMag.fill(0)

  scatterGated(mag, phase, state.first ? null : prev, ratio, ctx, newMag, newFreq, peakMag)
  prev.set(phase)

  for (let k = 0; k <= half; k++) syn[k] = wrapPhase(syn[k] + newFreq[k] * hop)

  state.first = false
  return { mag: newMag, phase: syn }
}

// Batch and stream share scatterGated's per-frame energy renormalization, so both
// reconstruct at identical loudness with no whole-signal gain correction needed.
export default makeStftShift(process, { post: (out) => out })
