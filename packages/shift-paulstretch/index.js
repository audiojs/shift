import { stftBatch } from './host.js'
import { bufferedStream, makePitchShift, resolveRatio } from './host.js'
import { makeFrameRatio, PI2 } from '@audio/spectral-pvoc'

// Peak-match (not RMS-match) because the random-phase reconstruction is noise-like:
// its sample distribution is approximately Gaussian with peaks at ~3× RMS. Matching RMS
// to the input (which for a tone has RMS ≈ peak / √2) would push peaks to ~2× the input
// peak — audible clipping. Peak-match keeps the output within the input's dynamic range
// at the cost of a quieter RMS, which is the correct trade-off for a textural blurrer.
function matchPeak(out, ref) {
  let po = 0, pr = 0
  for (let i = 0; i < out.length; i++) { let v = out[i]; if (v < 0) v = -v; if (v > po) po = v }
  for (let i = 0; i < ref.length; i++) { let v = ref[i]; if (v < 0) v = -v; if (v > pr) pr = v }
  if (po < 1e-9 || pr < 1e-9) return out
  let g = pr / po
  for (let i = 0; i < out.length; i++) out[i] *= g
  return out
}

// mulberry32 — smallest standard PRNG with no known short-period/low-bit weaknesses (unlike
// a bare LCG). Deterministic per seed: same seed always reproduces the same phase sequence
// and therefore the same output, run to run. Default seed is fixed, so paulstretch(...) with
// no `opts.seed` is itself deterministic; pass `opts.seed` (any 32-bit int) to vary the draw.
const DEFAULT_SEED = 0x1f123bb5
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Paulstretch-style pitch shift: large frames, phases randomized uniformly in [0, 2π),
// magnitudes gathered from source-bin k/ratio. Destroys temporal transients by design,
// producing the signature smooth, textural timbre — now shifted in pitch.

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  if (!state.newMag) {
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.rand = mulberry32(ctx.opts?.seed ?? DEFAULT_SEED)
  }
  let { newMag, newPhase, rand } = state
  newMag.fill(0)
  newPhase.fill(0) // ratio<1 skips high bins below — don't leak last frame's phase there
  for (let k = 0; k <= half; k++) {
    let src = k / ratio
    if (src > half) continue
    let i = src | 0
    let f = src - i
    newMag[k] = mag[i] * (1 - f) + (i + 1 <= half ? mag[i + 1] : 0) * f
    newPhase[k] = rand() * PI2
  }
  return { mag: newMag, phase: newPhase }
}

// Paulstretch's defining randomized phase means adjacent frames recombine incoherently,
// producing envelope modulation at the frame rate (sr / synHop). Larger frames push that
// rate down out of the audible-roughness range into slow tremolo — at sr=44100 the 16k/4k
// default gives ~10.8 Hz — but this changes the artifact's character, not its size. Measured
// with `scripts/metrics.js`'s `hopRateMod` (Goertzel envelope probe) on the quality rig's own
// 0.5 s / 440 Hz sine fixture at ratio 1.5, default seed: ~8.5% modulation depth at the
// shipped default — reproducible exactly since the phase draw is now seeded (see below).
// Depth does not shrink monotonically as frameSize grows. "Inaudible" overstated this; the
// honest claim is "moved to a lower, less rough-sounding frequency, not eliminated."
function paulBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let frameSize = opts?.frameSize ?? 16384
  let hopSize = opts?.hopSize ?? (frameSize >> 2)
  let out = stftBatch(data, process, { ...opts, ratio, ratioFn, frameSize, hopSize })
  return matchPeak(out, data)
}

// matchPeak needs the whole signal's peak before it can scale a single sample, so it can't
// run incrementally per chunk without batch and stream landing on different gains (the
// bug: an earlier per-chunk stftStream path shipped raw, uncorrected output — batch/stream
// levels differed by >10%). bufferedStream buffers input and runs paulBatch once at flush,
// same as every other whole-signal-dependent algorithm in this repo (hpss, hybrid, sample).
let paulStream = (opts) => bufferedStream(paulBatch, opts)

// Deterministic per seed (default fixed) — same input/opts always produces byte-identical
// output. Pass `opts.seed` to get a different (but still reproducible) phase draw.
export default makePitchShift(paulBatch, paulStream)
