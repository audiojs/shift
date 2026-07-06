import { wsola as stretch } from 'time-stretch'
import { makeStretchShift } from '@audio/shift-core'

// Canonical Waveform-Similarity Overlap-Add pitch shift (Verhelst-Roelands). WSOLA
// time-stretch at `factor = ratio` — each grain's analysis base is nudged by up to
// ±`delta` samples to maximally correlate with the previous grain's tail, eliminating the
// grain-rate phase cancellation of plain OLA — followed by anti-aliased sinc resample
// back to original length. The search makes this a clean time-domain pitch shifter
// without FFT, at the cost of one cross-correlation per grain.
let deriveOpts = (opts) => {
  let frameSize = opts?.frameSize ?? 2048
  return { frameSize, hopSize: opts?.hopSize ?? (frameSize >> 2), delta: opts?.tolerance ?? (frameSize >> 2) }
}

export default makeStretchShift(stretch, deriveOpts)
