import { fft, ifft } from 'fourier-transform'
import { makeStftShift } from './host.js'
import { findPeaks, makeFrameRatio, scatterLocked } from '@audio/spectral-pvoc'

// Formant-preserving pitch shift. The spectral envelope is extracted via cepstral liftering
// (low-quefrency coefficients) from the original frame. A peak-locked phase vocoder then
// shifts pitch (reusing the phase-lock architecture so partials stay coherent). Finally the
// shifted magnitude is divided by its own envelope and multiplied by the original envelope,
// re-imposing vowel timbre on the shifted pitch.

// The envelope/excitation quefrency boundary sits at sampleRate/width Hz — F0 above that
// leaks into the "envelope". F_BOUNDARY is the highest F0 the default lifter tolerates;
// because width scales with sampleRate, the safety margin (F0/F_BOUNDARY) is sampleRate-
// invariant, not just correct at 44.1kHz. Value chosen so the 44.1kHz/N=2048 default
// reproduces the old FFT-size-only cutoff (N>>6 = 32) exactly: 44100/32 = 1378.125.
const F_BOUNDARY = 1378.125

// Cepstral envelope extraction: liftering the log-magnitude spectrum's low quefrencies
// isolates the smooth vocal-tract response from the fast pitch-periodic excitation. `logMag`
// is already log-magnitude (EMA-smoothed, see process()). `zeroIm`/`lifted`/`env` are
// caller-owned scratch: `zeroIm` is permanently zero (a real-valued log-spectrum has no
// imaginary part) and never written here; `lifted`'s high-quefrency region stays zero across
// frames since `cutoff` is frame-invariant, so only the kept low-quefrency indices need
// overwriting; `env` is fully overwritten every call. Writes the envelope into `env`.
function cepstralEnvelope(logMag, N, cutoff, zeroIm, lifted, env) {
  let half = N >> 1
  let cep = ifft(logMag, zeroIm)
  lifted[0] = cep[0]
  let c = Math.min(cutoff, half - 1)
  for (let n = 1; n < c; n++) {
    lifted[n] = cep[n]
    lifted[N - n] = cep[N - n]
  }
  let [envLogRe] = fft(lifted)
  for (let k = 0; k <= half; k++) env[k] = Math.exp(envLogRe[k])
}

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { N, half } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.logMagAvg = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.peakMag = new Float64Array(half + 1)
    state.peakDest = new Int32Array(half)
    state.peakSynPhase = new Float64Array(half)
    state.zeroIm = new Float64Array(half + 1)
    state.lifted = new Float64Array(N)
    state.env = new Float64Array(half + 1)
    state.envelopeWidth = ctx.opts.envelopeWidth ?? Math.min(N >> 2, Math.max(8, Math.round(ctx.sampleRate / F_BOUNDARY)))
    state.first = true
  }
  let { prev, syn, logMagAvg, newMag, newPhase, peakMag, peakDest, peakSynPhase, zeroIm, lifted, env, envelopeWidth } = state
  newMag.fill(0)
  newPhase.fill(0)
  peakMag.fill(0)

  // 1. Original spectral envelope extracted from a smoothed log-magnitude.
  // Computing the envelope per-frame directly causes inter-partial bins to fluctuate at
  // the chord beat frequency (e.g. 55 Hz for a 220/275 Hz pair). That 55 Hz beat aliases
  // against the 86 Hz frame rate into ~31 Hz flutter on the correction factor — audible
  // as a soft click on raised chord material. An EMA of log(mag) with α=0.6 (τ ≈ 22.7 ms
  // at hop=512 / 44.1 kHz) stabilises the envelope: it converges within 3τ ≈ 68 ms
  // (before the 20%-skip activeRegion window opens) and attenuates the 55 Hz oscillation
  // by ≈3.65×, bringing it below the flicker perception threshold.
  let alpha = 0.6
  for (let k = 0; k <= half; k++) {
    let lm = Math.log(Math.max(1e-8, mag[k]))
    logMagAvg[k] = state.first ? lm : alpha * logMagAvg[k] + (1 - alpha) * lm
  }
  cepstralEnvelope(logMagAvg, N, envelopeWidth, zeroIm, lifted, env)

  // 2. Peak-locked phase vocoder shift (shared core scatter — see shift-pvoc-lock for the
  // undecorated version). Peaks scatter to shifted dest bins, their region of influence is
  // carried along, and per-peak phase is advanced at the shifted instantaneous frequency.
  let peaks = findPeaks(mag, half)
  scatterLocked(mag, phase, state.first ? null : prev, state.first, peaks, ratio, ctx, syn, newMag, newPhase, peakDest, peakSynPhase, peakMag)

  for (let k = 0; k <= half; k++) prev[k] = phase[k]
  state.first = false

  // 3. Re-impose the original vocal-tract envelope. The shift carried the envelope along
  // with the pitch — output bin k carries the original envelope at k/ratio. Divide that out,
  // multiply by env[k]. env was extracted from the log-magnitude average so the correction
  // is already temporally stable (see step 1 above). Per-bin correction reshapes the spectral
  // tilt, which is the whole point, but that reshaping is not itself energy-neutral — a sparse
  // spectrum (pure tone, few-partial chord) samples env far from its own peak and comes back
  // systematically quieter. Renormalize frame energy back to its pre-correction value (same
  // policy as scatterLocked's own collision renormalization) so timbre reshaping doesn't leak
  // into loudness: the shape of the correction survives, only its net gain is undone.
  let eIn = 0
  for (let k = 0; k <= half; k++) eIn += newMag[k] * newMag[k]
  let eOut = 0
  for (let k = 0; k <= half; k++) {
    let src = k / ratio
    let i = src | 0
    let f = src - i
    let a = env[Math.min(i, half)]
    let b = env[Math.min(i + 1, half)]
    let shiftedEnvK = a * (1 - f) + b * f
    let corr = env[k] / Math.max(1e-8, shiftedEnvK)
    if (corr > 8) corr = 8
    if (corr < 0.125) corr = 0.125
    newMag[k] *= corr
    eOut += newMag[k] * newMag[k]
  }
  let g = eOut > 1e-24 && eIn > 1e-24 ? Math.sqrt(eIn / eOut) : 1
  for (let k = 0; k <= half; k++) newMag[k] *= g

  return { mag: newMag, phase: newPhase }
}

export default makeStftShift(process, {
  deriveOpts: (opts) => ({ frameSize: opts?.frameSize ?? 2048 }),
  post: (out) => out,
})
