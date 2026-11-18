import stretch from '@audio/stretch-psola'
import { grainSilence, makeStretchShift } from './host.js'

// Pitch-Synchronous Overlap-Add pitch shift (Moulines-Charpentier 1990). PSOLA
// time-stretch at `factor = ratio` — autocorrelation period contour → pitch marks →
// two-period Hann grains placed at pitch-synchronous intervals — followed by
// anti-aliased sinc resample back to original length. The final resample rescales the
// whole spectrum by `ratio`, so formants move with f0 same as `wsola`; the win here is
// fewer grain-boundary artifacts on voiced monophonic material, not formant preservation.
// Falls back to plain WSOLA internally when the input has no reliable pitch period
// (unvoiced/polyphonic/noisy) — designed for monophonic voiced material.
// The take is stretched followed by silence of its own (psolaSilence), so its grains, the
// stretch's WSOLA and their blend run on into silence and what the take rings is rendered.
// The stretch's choice among the three counts no silence after the take where
// @audio/stretch-psola takes its voicing shares over the input up to its last sample that is
// not 0, as it does from 1.2.4 on; an earlier one counts this silence in them too.
let deriveOpts = (opts) => ({
  sampleRate: opts?.sampleRate || 44100,
  minFreq: opts?.minFreq,
  maxFreq: opts?.maxFreq,
})

// The silence after the take the stretch needs to stretch it as followed by silence ever
// after: its WSOLA's (grains of 2048 frames, a search of 512: grainSilence); or its
// pitch-synchronous grains', two periods of the lowest pitch (P frames) either side of a
// mark, the search for the marks, and the grains the output reads past the take shifted
// down, P·|1/ratio − 1| frames on each period of a grain's reach
let psolaSilence = (o, ratio) => {
  let P = Math.ceil(o.sampleRate / (o.minFreq || 80))
  let grains = Math.ceil(P * (2 * Math.abs(1 / ratio - 1) + 6))
  return Math.max(grainSilence({ frameSize: 2048, delta: 512 }, ratio), grains)
}

export default makeStretchShift(stretch, deriveOpts, psolaSilence)
