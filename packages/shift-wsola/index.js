import stretch from '@audio/stretch-wsola'
import { grainSilence, makeStretchShift } from './host.js'

// Canonical Waveform-Similarity Overlap-Add pitch shift (Verhelst-Roelands). WSOLA
// time-stretch at `factor = ratio` — each grain's analysis base is nudged by up to
// ±`delta` samples to maximally correlate with the previous grain's tail, eliminating the
// grain-rate phase cancellation of plain OLA — followed by anti-aliased sinc resample
// back to original length. The search makes this a clean time-domain pitch shifter
// without FFT, at the cost of one cross-correlation per grain.
// The take is stretched followed by silence of its own (grainSilence), so its last grains
// read on into silence: at the end of what it is given the stretch re-reads its last full
// grain instead, which drops what sounds in the take's last N + δ frames.
let deriveOpts = (opts) => {
  let frameSize = opts?.frameSize ?? 2048
  return { frameSize, hopSize: opts?.hopSize ?? (frameSize >> 2), delta: opts?.tolerance ?? (frameSize >> 2) }
}

export default makeStretchShift(stretch, deriveOpts, grainSilence)
