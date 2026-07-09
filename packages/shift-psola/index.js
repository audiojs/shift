import stretch from '@audio/stretch-psola'
import { makeStretchShift } from './host.js'

// Pitch-Synchronous Overlap-Add pitch shift (Moulines-Charpentier 1990). PSOLA
// time-stretch at `factor = ratio` — autocorrelation period contour → pitch marks →
// two-period Hann grains placed at pitch-synchronous intervals — followed by
// anti-aliased sinc resample back to original length. The final resample rescales the
// whole spectrum by `ratio`, so formants move with f0 same as `wsola`; the win here is
// fewer grain-boundary artifacts on voiced monophonic material, not formant preservation.
// Falls back to plain WSOLA internally when the input has no reliable pitch period
// (unvoiced/polyphonic/noisy) — designed for monophonic voiced material.
let deriveOpts = (opts) => ({
  sampleRate: opts?.sampleRate || 44100,
  minFreq: opts?.minFreq,
  maxFreq: opts?.maxFreq,
})

export default makeStretchShift(stretch, deriveOpts)
