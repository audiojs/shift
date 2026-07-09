import { wsola as stretch } from 'time-stretch'
import { makeStretchShift } from './host.js'

// Overlap-Add pitch shift. Plain OLA time-stretch at `factor = ratio` — no similarity
// search (delta=0), so grains are placed at nominal analysis positions — followed by
// anti-aliased sinc resample back to original length. The simplest stretch+resample
// pitch shift — the baseline the others improve on. For the same form with per-grain
// similarity search, use `wsola`.
let deriveOpts = (opts) => {
  let frameSize = opts?.frameSize ?? 2048
  return { frameSize, hopSize: opts?.hopSize ?? (frameSize >> 2), delta: 0 }
}

export default makeStretchShift(stretch, deriveOpts)
