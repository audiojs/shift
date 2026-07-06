import { stftBatch as ftStftBatch, stftStream as ftStftStream, winSqFloor } from 'fourier-transform/stft'
import { matchGain, resolveRatio, makePitchShift } from './index.js'

// Thin wrapper over `fourier-transform/stft` that exposes `ratio` and `ratioFn`
// at the top of `ctx` (pitch-shift convention) in addition to FT's default
// `ctx.opts.*` surface. Atoms' process callbacks can continue to read
// `ctx.ratio` / `ctx.ratioFn` directly.

function wrapProcess(process) {
  return function (mag, phase, state, ctx) {
    if (ctx.ratio === undefined) ctx.ratio = ctx.opts?.ratio
    if (ctx.ratioFn === undefined) ctx.ratioFn = ctx.opts?.ratioFn ?? null
    return process(mag, phase, state, ctx)
  }
}

export function stftBatch(data, process, opts) {
  return ftStftBatch(data, wrapProcess(process), opts)
}

export function stftStream(process, opts) {
  let s = ftStftStream(wrapProcess(process), opts)
  return { write: (chunk) => s.write(chunk), flush: () => s.flush() }
}

export { winSqFloor }

// Wraps a per-frame STFT `process` callback into batch+stream pitch-shift entry points:
// resolves `ratio`/`ratioFn`, threads them through `opts`, and (by default) matchGain-
// corrects the batch output. `deriveOpts(opts)` computes any extra STFT options the
// process fn needs (frameSize, hopSize, ...) — called once per batch/stream construction,
// not per frame. `post(out, data)` overrides the default loudness correction (e.g.
// paulstretch's peak-match — its randomized-phase reconstruction is noise-like, so
// RMS-matching would push peaks toward clipping).
export function makeStftShift(process, { deriveOpts = () => ({}), post = matchGain } = {}) {
  function batch(data, opts) {
    let { ratio, ratioFn } = resolveRatio(opts)
    let out = stftBatch(data, process, { ...opts, ratio, ratioFn, ...deriveOpts(opts) })
    return post(out, data)
  }
  function stream(opts) {
    let { ratio, ratioFn } = resolveRatio(opts)
    let s = stftStream(process, { ...opts, ratio, ratioFn, ...deriveOpts(opts) })
    return (chunk) => chunk === undefined ? s.flush() : s.write(chunk)
  }
  return makePitchShift(batch, stream)
}
