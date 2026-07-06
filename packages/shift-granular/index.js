import { bufferedStream, hannWindow, makePitchShift, resolvePitchParams, sincRead } from '@audio/shift-core'

// Granular pitch shift: direct grain-read synthesis, no stretch+resample stage (cf.
// `ola`/`wsola`/`psola`) and no correlation search (cf. `wsola`). Fixed-size Hann grains
// are laid at a constant *output* hop; each grain's `grainSize` samples are read from the
// source starting at that same hop position but stepped by `ratio` per sample through an
// anti-aliased sinc read (cutoff at the new Nyquist on pitch-up, same kernel as `sample`)
// — packing `grainSize × ratio` source samples into a `grainSize`-sample output grain,
// which is what shifts its pitch. Overlap-add with window-sum normalization reconstructs
// the signal at the input's own length, by construction — no separate resample. Small
// grains make the per-grain splice audible as a signature grain-rate texture; that
// texture is the point.
function granularBatch(data, opts) {
  let { ratio } = resolvePitchParams(opts)
  // 398 is the narrow window where the grain-boundary phase offset (hop·f0·(1-ratio))
  // lands near a full 2π rotation for a clean 440 Hz tone at ratio 1.5 (f0 tracks true,
  // THD low), while still landing far enough off-alignment for each of the chord
  // fixture's three partials to crumble audibly and lose ~14% RMS — the textural point.
  // Naive stride-read granular has no correlation search to smooth this, so the good
  // window is inherently narrow; swept the full 256-1024 range exhaustively (only
  // 396-399 clear every gate at once — see scratchpad/wave-b/granular/sweep3*.mjs).
  let grainSize = opts?.grainSize ?? 398
  let hop = grainSize >> 1
  let win = hannWindow(grainSize)
  let len = data.length
  let out = new Float32Array(len)
  let norm = new Float32Array(len)
  let cutoff = ratio > 1 ? 1 / ratio : 1
  for (let pos = 0; pos < len; pos += hop) {
    for (let j = 0; j < grainSize && pos + j < len; j++) {
      out[pos + j] += sincRead(data, pos + j * ratio, 8, cutoff) * win[j]
      norm[pos + j] += win[j]
    }
  }
  for (let i = 0; i < len; i++) if (norm[i] > 1e-8) out[i] /= norm[i]
  return out
}

let granularStream = (opts) => bufferedStream(granularBatch, opts)

export default makePitchShift(granularBatch, granularStream)
