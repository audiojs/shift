import { makeStftShift } from './host.js'
import { findPeaks, scatterLocked, makeFrameRatio } from '@audio/spectral-pvoc'

// Transient-aware phase vocoder pitch shift: shift-pvoc-lock's peak-locked scatter kernel
// (findPeaks + scatterLocked), with `reset` decided per frame by an onset detector instead
// of only on the first frame. On a detected onset, phase resets to the analysis phase
// (vertical coherence over horizontal), keeping attacks sharp; between onsets it behaves
// exactly like phaseLock.

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  let threshold = ctx.opts.transientThreshold ?? 1.5
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.prevMag = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.peakMag = new Float64Array(half + 1)
    state.peakDest = new Int32Array(half)
    state.peakSynPhase = new Float64Array(half)
    state.fluxMean = 0
    state.fluxVar = 0
    state.energyMean = 0
    state.postFrames = 0
    state.first = true
  }

  let { prev, prevMag, syn, newMag, newPhase, peakMag, peakDest, peakSynPhase } = state
  newMag.fill(0)
  newPhase.fill(0)
  peakMag.fill(0)

  // The analysis window still overlaps the zero-padded head while frameStart < 0 (partial-
  // window truncation, not real spectral content): flux is neither computed nor folded into
  // the running mean/variance there, so the boundary can't fire a false onset or desensitize
  // detection of the genuine attack that follows. `state.first` (the literal first frame)
  // still resets unconditionally, exactly like phaseLock, so a t=0 attack is never blinded.
  let boundary = ctx.frameStart < 0
  let isTransient = state.first

  if (!state.first && !boundary) {
    // Energy-domain (mag^2) half-wave-rectified spectral flux, normalized by frame energy.
    // Quadratic energy (Parseval) tracks the true windowed-signal energy, so a decaying or
    // ending signal reads as a genuine decrease here — unlike a magnitude- or log-domain
    // sum, which the spectral broadening a hard signal edge causes can inflate with no real
    // energy behind it (the same failure mode the zero-padded tail on the last real frames
    // would otherwise trigger).
    let flux = 0, energy = 0
    for (let k = 0; k <= half; k++) {
      let m2 = mag[k] * mag[k], p2 = prevMag[k] * prevMag[k]
      if (m2 > p2) flux += m2 - p2
      energy += m2
    }
    let nFlux = energy > 1e-12 ? flux / energy : 0
    let std = Math.sqrt(state.fluxVar)
    // An onset is an energy increase: require the frame not be measurably below its own
    // recent baseline — what a decay/release (or a signal's tail) looks like — so those
    // can't be mistaken for the rise this flux term is built to catch. The 0.3 floor (up
    // from a naive 0, in this energy-domain scale) is calibrated against amplitude-
    // modulated tonal material: a 5 Hz/60%-depth tremolo peaks at nFlux ≈ 0.28, while
    // isolated kick/snare/hi-hat onsets peak at 0.3–1.0, so 0.3 separates them without
    // needing per-material tuning.
    let rising = energy >= state.energyMean * 0.7
    let fired = state.postFrames > 3 && rising && nFlux > state.fluxMean + threshold * Math.max(0.3, std)
    isTransient = fired

    let alpha = fired ? 0.25 : 0.1
    let delta = nFlux - state.fluxMean
    state.fluxMean += alpha * delta
    state.fluxVar = (1 - alpha) * (state.fluxVar + alpha * delta * delta)
    state.energyMean += alpha * (energy - state.energyMean)
    state.postFrames++
  }

  let peaks = findPeaks(mag, half)
  scatterLocked(mag, phase, prev, isTransient, peaks, ratio, ctx, syn, newMag, newPhase, peakDest, peakSynPhase, peakMag)

  for (let k = 0; k <= half; k++) { prev[k] = phase[k]; prevMag[k] = mag[k] }
  state.first = false

  return { mag: newMag, phase: newPhase }
}

export default makeStftShift(process, { post: (out) => out })
