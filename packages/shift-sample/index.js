import { bufferedStream, makePitchShift, resolveRatio, sincRead } from '@audio/shift-core'

// Canonical sampler pitch shift. A Hann-windowed sinc interpolator reads the source at
// a fractional stride of `ratio` per output sample — the same intuition as a hardware
// sampler playing a one-shot at a different rate, or a tracker module running the same
// waveform faster. There is no time preservation: output duration is `input_length /
// ratio`. The tail is zero-padded so the unified batch API (`output.length === input
// .length`) still holds, but the active region is genuinely shorter on pitch-up.
//
// Pitch preservation is exact (fractional-stride sinc over a clean buffer is an ideal
// resampler), at the cost of losing time — the one thing every other algorithm in this
// package keeps. Use it when that is the intended effect: instrument one-shots, sampler
// voices, tracker playback, anything where "higher pitch = shorter clip" is the point.
// Anti-aliasing is inherited from the shared `sincRead`: `cutoff = min(1, 1/ratio)`
// suppresses content above the new Nyquist before it folds.
function sampleBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let r = opts?.sincRadius ?? 8
  let n = data.length
  let out = new Float32Array(n)
  let readPos = 0
  // Scalar ratio (the common case) hoists cutoff out of the loop and never calls a host
  // closure — the repo's one per-output-sample dynamic call otherwise sits in this loop.
  if (!ratioFn) {
    let cutoff = ratio > 1 ? 1 / ratio : 1
    for (let i = 0; i < n; i++) {
      if (readPos >= n) break
      out[i] = sincRead(data, readPos, r, cutoff)
      readPos += ratio
    }
    return out
  }
  let sr = opts?.sampleRate || 44100
  for (let i = 0; i < n; i++) {
    if (readPos >= n) break
    let rNow = ratioFn(i / sr)
    let cutoff = rNow > 1 ? 1 / rNow : 1
    out[i] = sincRead(data, readPos, r, cutoff)
    readPos += rNow
  }
  return out
}

let sampleStream = (opts) => bufferedStream(sampleBatch, opts)

export default makePitchShift(sampleBatch, sampleStream)
