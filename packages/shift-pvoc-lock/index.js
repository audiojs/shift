import { makeStftShift } from './host.js'
import { findPeaks, scatterLocked, makeFrameRatio } from '@audio/spectral-pvoc'

// Peak-locked phase vocoder (Laroche-Dolson style, adapted to direct bin-shift pitch shifting).
// Phase coherence across a region of influence is preserved by locking non-peak bins' phase
// relative to the nearest magnitude peak, rather than advancing every bin independently.
// Batch and stream share this exact per-frame kernel (see spectral-pvoc's scatterLocked energy
// policy) so no post-hoc gain correction is needed.

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.peakMag = new Float64Array(half + 1)
    state.peakDest = new Int32Array(half)
    state.peakSynPhase = new Float64Array(half)
    state.first = true
  }

  let { prev, syn, newMag, newPhase, peakMag, peakDest, peakSynPhase } = state
  newMag.fill(0)
  newPhase.fill(0)
  peakMag.fill(0)

  let peaks = findPeaks(mag, half)
  scatterLocked(mag, phase, prev, state.first, peaks, ratio, ctx, syn, newMag, newPhase, peakDest, peakSynPhase, peakMag)

  for (let k = 0; k <= half; k++) prev[k] = phase[k]
  state.first = false

  return { mag: newMag, phase: newPhase }
}

export default makeStftShift(process, { post: (out) => out })
