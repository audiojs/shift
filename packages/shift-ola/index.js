import stretch from '@audio/stretch-wsola'
import { grainSilence, makeStretchShift } from './host.js'

// Overlap-Add pitch shift. Plain OLA time-stretch at `factor = ratio` — no similarity
// search (delta=0), so grains are placed at nominal analysis positions — followed by
// anti-aliased sinc resample back to original length. The simplest stretch+resample
// pitch shift — the baseline the others improve on. For the same form with per-grain
// similarity search, use `wsola`.
// The take is stretched followed by silence of its own (grainSilence), so its last grains
// read on into silence: at the end of what it is given the stretch re-reads its last full
// grain instead, which drops what sounds in the take's last N frames.
let deriveOpts = (opts) => {
  let frameSize = opts?.frameSize ?? 2048
  return { frameSize, hopSize: opts?.hopSize ?? (frameSize >> 2), delta: 0 }
}

export default makeStretchShift(stretch, deriveOpts, grainSilence)
