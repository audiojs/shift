export const PI2 = Math.PI * 2

export function wrapPhase(p) {
  return p - Math.round(p / PI2) * PI2
}

// Periodic Hann (denominator N, endpoints not both zero) — the DFT-correct form for
// OLA/STFT analysis-synthesis, matching fourier-transform/stft.js's own window. Cached
// by frame size, same as every other per-N derived table in this dependency graph.
let _hannCache = new Map()
export function hannWindow(N) {
  let w = _hannCache.get(N)
  if (w) return w
  w = new Float64Array(N)
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(PI2 * i / N)
  _hannCache.set(N, w)
  return w
}

export function isChannelArray(data) {
  return Array.isArray(data) && data.every((c) => c instanceof Float32Array)
}

export function normalizeOptionsInput(data) {
  if (data === undefined || data === null || typeof data === 'object') return data
  throw new TypeError('pitchShift: options must be an object')
}

export function validateInput(data) {
  if (data instanceof Float32Array || isChannelArray(data)) return
  throw new TypeError('pitchShift: input must be Float32Array or array of Float32Array channels')
}

export function resolvePitchParams(opts) {
  let semitones = opts?.semitones ?? 0
  if (!Number.isFinite(semitones)) throw new TypeError('pitchShift: `semitones` must be a finite number')
  let raw = opts?.ratio
  if (typeof raw === 'function' || raw instanceof Float32Array) {
    throw new TypeError('pitchShift: variable `ratio` (function or Float32Array) is supported by vocoder, phaseLock, transient, formant, paulstretch, sms, hpss, and sample')
  }
  let ratio = raw ?? (semitones ? Math.pow(2, semitones / 12) : 1)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new TypeError('pitchShift: `ratio` must be a finite number > 0')
  return { ratio, semitones }
}

// Variable-ratio resolver. Returns `{ ratio, ratioFn }` where `ratio` is the scalar value
// at t=0 (for identity checks and fallbacks) and `ratioFn` is a `(timeSeconds) => ratio`
// function, or `null` when the caller passed a plain scalar. Algorithms that support
// time-varying pitch use `ratioFn`; algorithms that don't should use `resolvePitchParams`
// (which throws on function/array input).
export function resolveRatio(opts) {
  let raw = opts?.ratio
  if (typeof raw === 'function') {
    let r0 = raw(0)
    if (!Number.isFinite(r0) || r0 <= 0) throw new TypeError('pitchShift: `ratio(0)` must be a finite number > 0')
    return { ratio: r0, ratioFn: raw }
  }
  if (raw instanceof Float32Array) {
    if (raw.length === 0) throw new TypeError('pitchShift: `ratio` Float32Array must be non-empty')
    let arr = raw
    let last = arr.length - 1
    // Sampled curve on [0, durationSeconds]; caller supplies `ratioDuration` in seconds.
    // Fallback: treat as a per-sample curve at `sampleRate`.
    let sr = opts?.sampleRate || 44100
    let durOpt = opts?.ratioDuration
    if (durOpt !== undefined && durOpt !== null && (!Number.isFinite(durOpt) || durOpt <= 0)) {
      throw new TypeError('pitchShift: `ratioDuration` must be a finite number > 0')
    }
    let dur = durOpt ?? (arr.length / sr)
    let fn = (t) => {
      let pos = (t / dur) * last
      if (pos <= 0) return arr[0]
      if (pos >= last) return arr[last]
      let i0 = Math.floor(pos)
      let frac = pos - i0
      return (1 - frac) * arr[i0] + frac * arr[i0 + 1]
    }
    return { ratio: arr[0], ratioFn: fn }
  }
  let { ratio } = resolvePitchParams(opts)
  return { ratio, ratioFn: null }
}

// Rescale `out` in place so its RMS matches `ref`'s RMS. Pitch shift preserves loudness
// by definition, so any STFT bin-shift path that loses or inflates energy through round()
// quantisation / scatter collisions can be corrected with a single global scalar at the
// tail. Bounded correction: only applied when output is in the 0.1..10× ballpark of the
// reference — outside that range the output is either legitimately silent (pitch-up past
// Nyquist, where only aliasing energy remains) or the algorithm is catastrophically broken
// and a blind rescale would hide the problem instead of fixing it.
export function matchGain(out, ref) {
  let no = out.length, nr = ref.length
  let so = 0, sr = 0
  for (let i = 0; i < no; i++) so += out[i] * out[i]
  for (let i = 0; i < nr; i++) sr += ref[i] * ref[i]
  if (so <= 1e-12 || sr <= 1e-12) return out
  let rmsO = Math.sqrt(so / no)
  let rmsR = Math.sqrt(sr / nr)
  let ratio = rmsO / rmsR
  if (ratio < 0.1 || ratio > 10) return out
  let g = rmsR / rmsO
  for (let i = 0; i < no; i++) out[i] *= g
  return out
}

// A windowed-sinc kernel's per-position-invariant state: the sinc argument and Hann-taper
// argument both advance by a fixed step per tap (`dTheta`, `dPhi`), so `sincAccumulate` can
// rotate two unit vectors by angle-addition instead of calling sin/cos per tap. Depends only
// on `hw`/`cutoff`, so callers looping over many positions at the same `hw`/`cutoff` (e.g.
// `resampleTo`) build this once and reuse it, while `sincRead` (one read per call, and
// `cutoff` may vary call to call) builds it fresh each time.
function sincKernel(hw, cutoff) {
  let dTheta = Math.PI * cutoff, dPhi = Math.PI / hw
  return { hw, cutoff, dTheta, dPhi, cosDT: Math.cos(dTheta), sinDT: Math.sin(dTheta), cosDP: Math.cos(dPhi), sinDP: Math.sin(dPhi) }
}

// Accumulate a Hann-windowed sinc read of `buf` at fractional position `i0+frac` under
// kernel `k` (from `sincKernel`). Taps that fall outside `buf` are dropped (equivalent to
// zero-padding — the standard finite-support boundary convention), then the sum is divided
// by the actual accumulated tap weight rather than the full kernel's, so truncation at a
// buffer edge droops the tap count, not the gain: DC response stays ≈1 at edges and interior.
function sincAccumulate(buf, bufLen, i0, frac, k) {
  let { hw, cutoff, dTheta, dPhi, cosDT, sinDT, cosDP, sinDP } = k
  let x = -hw + 1 - frac
  let sinT = Math.sin(x * dTheta), cosT = Math.cos(x * dTheta)
  let sinP = Math.sin(x * dPhi), cosP = Math.cos(x * dPhi)
  let sum = 0, weight = 0
  for (let n = -hw + 1; n <= hw; n++) {
    if (Math.abs(x) < hw) {
      let idx = i0 + n
      if (idx >= 0 && idx < bufLen) {
        let theta = x * dTheta
        let si = Math.abs(x * cutoff) < 1e-9 ? 1 : sinT / theta
        let wt = si * cutoff * (0.5 + 0.5 * cosP)
        sum += buf[idx] * wt
        weight += wt
      }
    }
    let sinT1 = sinT * cosDT + cosT * sinDT
    cosT = cosT * cosDT - sinT * sinDT
    sinT = sinT1
    let sinP1 = sinP * cosDP + cosP * sinDP
    cosP = cosP * cosDP - sinP * sinDP
    sinP = sinP1
    x += 1
  }
  return weight > 1e-9 ? sum / weight : 0
}

// Hann-windowed sinc read at a fractional source position. `cutoff ∈ (0,1]` sets an
// anti-alias lowpass at `cutoff × Nyquist`; use `cutoff = min(1, 1/stride)` when the
// caller is stepping through the source faster than one sample per read to suppress
// content above the new Nyquist before it folds. `r` is the kernel half-width in
// zero-crossings (8 is standard: deep stopband (>60 dB) is reached only ~40% above the
// new Nyquist — the transition band right at cutoff is a much shallower 6-20 dB).
export function sincRead(buf, pos, r, cutoff) {
  let i0 = Math.floor(pos)
  let frac = pos - i0
  let hw = Math.ceil(r / cutoff)
  return sincAccumulate(buf, buf.length, i0, frac, sincKernel(hw, cutoff))
}

// Hann-windowed sinc resampler with anti-aliasing. When downsampling (inLen > outLen) the
// sinc cutoff scales to outLen/inLen so content above Nyquist/step is suppressed before it
// can fold (see `sincRead` for the actual stopband shape). Upsampling (inLen ≤ outLen) uses
// cutoff=1, identical to the standard reconstruction sinc.
export function resampleTo(data, outLen, r = 8) {
  let inLen = data.length
  let out = new Float32Array(outLen)
  if (outLen === 0 || inLen === 0) return out
  if (outLen === inLen) return new Float32Array(data)
  // outLen===1 has no defined step/ratio to anti-alias against; degrade to the pos=0
  // sample, matching every outLen>=2 case where the first output is always read at pos=0.
  if (outLen === 1) { out[0] = data[0]; return out }
  let step = (inLen - 1) / (outLen - 1)
  let cutoff = step > 1 ? 1 / step : 1
  let k = sincKernel(Math.ceil(r / cutoff), cutoff)
  for (let i = 0; i < outLen; i++) {
    let pos = i * step
    let i0 = Math.floor(pos)
    out[i] = sincAccumulate(data, inLen, i0, pos - i0, k)
  }
  return out
}

export function mapInput(data, fn, opts) {
  validateInput(data)
  if (data instanceof Float32Array) return fn(data, opts)
  return data.map((c) => fn(c, opts))
}

export function passThroughWriter() {
  let flushed = false
  return (chunk) => {
    if (chunk === undefined) { flushed = true; return new Float32Array(0) }
    if (flushed) throw new Error('pitchShift: stream already flushed')
    return new Float32Array(chunk)
  }
}

// Streaming adapter for algorithms that need whole-signal look-ahead (e.g. HPSS median
// windows, hybrid's parallel engines). Buffers input; emits empty on writes and the full
// batch result on flush. Canonical simplest form for inherently non-causal algorithms.
export function bufferedStream(batch, opts) {
  let parts = []
  let flushed = false
  return (chunk) => {
    if (chunk === undefined) {
      if (flushed) return new Float32Array(0)
      flushed = true
      let total = 0
      for (let p of parts) total += p.length
      let all = new Float32Array(total)
      let o = 0
      for (let p of parts) { all.set(p, o); o += p.length }
      return batch(all, opts)
    }
    if (flushed) throw new Error('pitchShift: stream already flushed')
    parts.push(new Float32Array(chunk))
    return new Float32Array(0)
  }
}

export function createChannelWriter(factory) {
  let mode = null
  let writers = null

  return (chunk) => {
    if (chunk === undefined) {
      if (!writers) return new Float32Array(0)
      return mode === 'channels' ? writers.map((w) => w()) : writers[0]()
    }

    if (isChannelArray(chunk)) {
      if (!writers) { mode = 'channels'; writers = chunk.map(() => factory()) }
      if (mode !== 'channels') throw new TypeError('pitchShift: cannot mix mono and multi-channel writes')
      if (writers.length !== chunk.length) throw new TypeError('pitchShift: streaming channel count must stay constant')
      return chunk.map((c, i) => writers[i](c))
    }

    if (!(chunk instanceof Float32Array)) {
      throw new TypeError('pitchShift: streaming input must be Float32Array or array of Float32Array channels')
    }

    if (!writers) { mode = 'mono'; writers = [factory()] }
    if (mode !== 'mono') throw new TypeError('pitchShift: cannot mix mono and multi-channel writes')
    return writers[0](chunk)
  }
}

// First-order local magnitude peaks above a fraction of the frame's peak.
// ±1 comparison keeps closely-spaced chord partials whose mainlobes overlap. `>=` on the
// left / `>` on the right reports the trailing edge of an exact-magnitude plateau exactly
// once, instead of a strict `>` on both sides missing the whole plateau.
export function findPeaks(mag, half) {
  let maxM = 0
  for (let k = 0; k <= half; k++) if (mag[k] > maxM) maxM = mag[k]
  let floor = Math.max(1e-8, maxM * 0.005)
  let peaks = []
  for (let k = 1; k < half; k++) {
    let v = mag[k]
    if (v < floor) continue
    if (v >= mag[k - 1] && v > mag[k + 1]) peaks.push(k)
  }
  return peaks
}

// Binary-search nearest peak index for bin k.
export function nearestPeak(peaks, k) {
  if (!peaks.length) return -1
  let lo = 0, hi = peaks.length - 1
  while (lo < hi) {
    let mid = (lo + hi) >> 1
    if (peaks[mid] < k) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(peaks[lo - 1] - k) <= Math.abs(peaks[lo] - k)) return lo - 1
  return lo
}

// Peak-gated bin scatter (Bernsee/SMB scheme): every analysis bin at or adjacent (±1) to a
// local magnitude peak advances phase at its own instantaneous frequency, scales it by
// `ratio`, and deposits into the destination bin that frequency implies. Colliding bins
// accumulate in the energy domain (Σmag², √ at the end) — synthesis treats each bin as an
// independent oscillator, so energies add where magnitude-summing overshoots (+4.3 dB for
// a Hann mainlobe's own ±1 bins landing together) and last-writer-wins discards every
// other contributor. The frequency written to a bin is its loudest contributor's (a
// quieter contributor's frequency estimate is masked anyway).
// The gate keeps only mainlobe cores; skirt bins it drops carry real energy belonging to
// the same partials. The frame is renormalized so kept-bin energy matches the input
// frame's — minus content whose destination fell outside Nyquist, which is legitimately
// lost — times WIN_GAIN: concentrating a windowed mainlobe into one bin makes the ISTFT
// frame a pure sinusoid where the analysis frame was a windowed one, and through the
// engine's w·(·)/Σw² overlap-add that costs exactly mean(w)/rms(w). Per-frame and causal,
// so batch and stream reconstruct at identical loudness with no whole-signal correction.
// `newMag`/`newFreq`/`peakMag` are caller-owned scratch sized `half+1`, zero-filled by the
// caller before the call. `prevPhase` is the previous frame's unwrapped phase, or `null`
// on the first frame.
export function scatterGated(mag, phase, prevPhase, ratio, ctx, newMag, newFreq, peakMag) {
  let { half, hop, freqPerBin } = ctx
  let maxM = 0
  for (let k = 0; k <= half; k++) if (mag[k] > maxM) maxM = mag[k]
  let floor = Math.max(1e-8, maxM * 0.005)
  let eIn = 0, eOut = 0
  for (let k = 0; k <= half; k++) {
    let e = mag[k] * mag[k]
    eIn += e
    let eligible = false
    for (let d = -1; d <= 1; d++) {
      let j = k + d
      if (j <= 0 || j >= half) continue
      if (mag[j] >= floor && mag[j] >= mag[j - 1] && mag[j] > mag[j + 1]) { eligible = true; break }
    }
    if (!eligible) continue
    let trueFreq
    if (!prevPhase) trueFreq = k * freqPerBin
    else {
      let dp = wrapPhase(phase[k] - prevPhase[k] - k * freqPerBin * hop)
      trueFreq = k * freqPerBin + dp / hop
    }
    let shifted = trueFreq * ratio
    let destBin = Math.round(shifted / freqPerBin)
    if (destBin < 0 || destBin > half) { eIn -= e; continue }
    eOut += e
    let r = lobeGain(shifted - destBin * freqPerBin, ctx.N)
    newMag[destBin] += e / (r * r)
    if (mag[k] > peakMag[destBin]) { peakMag[destBin] = mag[k]; newFreq[destBin] = shifted }
  }
  let g = (eOut > 1e-24 && eIn > 1e-24 ? Math.sqrt(eIn / eOut) : 1) * WIN_GAIN
  for (let k = 0; k <= half; k++) if (newMag[k]) newMag[k] = Math.sqrt(newMag[k]) * g
}

// rms(w)/mean(w) for the engine's periodic Hann: sqrt(3/8)/(1/2) = sqrt(3/2).
export const WIN_GAIN = Math.sqrt(1.5)

// Mean overlap-add amplitude of a partial whose intra-frame (bin-grid) and inter-frame
// (true) frequencies differ by `dw` rad/sample: |W(dw)|/W(0) for the engine's periodic
// Hann of length N. The synthesized bin oscillates on the bin grid inside each frame
// while its phase steps at the true frequency across frames, so overlapping frames sum
// slightly incoherently — the classic vocoder scalloping loss, deterministic per bin.
function lobeGain(dw, N) {
  if (!dw) return 1
  let d = (t) => {
    let s = Math.sin(t / 2)
    return Math.abs(s) < 1e-12 ? N : Math.sin(N * t / 2) / s
  }
  let b = PI2 / N
  return Math.abs(0.5 * d(dw) + 0.25 * d(dw - b) + 0.25 * d(dw + b)) / (0.5 * N)
}

// Peak-locked rigid-ROI bin scatter (Laroche-Dolson): each `findPeaks` peak advances its own
// phase at its instantaneous frequency × `ratio`; every other bin rides along rigidly at its
// nearest peak's integer bin-shift, carrying phase relative to that peak (phase coherence
// across the peak's region of influence). Colliding destination bins accumulate in the
// energy domain (Σmag², √ at the end); the phase written is the loudest contributor's —
// same RMS-preserving collision policy as `scatterGated`.
// `reset` skips phase-derivative estimation (first frame, or a caller-detected phase
// discontinuity such as a transient) and uses the analysis phase directly instead of
// integrating. `syn` is the caller-owned running per-bin phase accumulator (persists across
// frames). `newMag`/`newPhase`/`peakMag` are caller-owned scratch sized `half+1`, zero-filled
// by the caller; `peakDest`/`peakSynPhase` are caller-owned scratch sized `peaks.length`.
export function scatterLocked(mag, phase, prevPhase, reset, peaks, ratio, ctx, syn, newMag, newPhase, peakDest, peakSynPhase, peakMag) {
  let { half, hop, freqPerBin } = ctx
  if (_boost.length <= half) _boost = new Float64Array(half + 1)
  for (let i = 0; i < peaks.length; i++) {
    let k = peaks[i]
    let trueFreq
    if (reset) trueFreq = k * freqPerBin
    else {
      let dp = wrapPhase(phase[k] - prevPhase[k] - k * freqPerBin * hop)
      trueFreq = k * freqPerBin + dp / hop
    }
    let shifted = trueFreq * ratio
    // Shift the lobe by the integer bin count closest to the true frequency delta: the
    // lobe's own frac is preserved, so the intra-/inter-frame frequency mismatch stays
    // within ±half a bin — where the scalloping model below is accurate.
    let destBin = k + Math.round((shifted - trueFreq) / freqPerBin)
    if (destBin < 0 || destBin > half) { peakDest[i] = -1; continue }
    let newSyn = reset ? phase[k] : wrapPhase(syn[destBin] + shifted * hop)
    peakDest[i] = destBin
    peakSynPhase[i] = newSyn
    syn[destBin] = newSyn
    let r = lobeGain(shifted - (trueFreq + (destBin - k) * freqPerBin), ctx.N)
    _boost[i] = 1 / (r * r)
  }

  // No WIN_GAIN here: the rigid ROI shift carries the whole mainlobe shape to the
  // destination, so the ISTFT frame stays a windowed one — only collision and
  // past-Nyquist bookkeeping need correction. Bins riding a peak whose destination
  // fell outside Nyquist are legitimately lost and excluded from the energy target.
  let eIn = 0, eOut = 0
  for (let k = 0; k <= half; k++) {
    let pi = nearestPeak(peaks, k)
    if (pi < 0) continue
    let destBin = peakDest[pi]
    if (destBin < 0) continue
    let e = mag[k] * mag[k]
    eIn += e
    let pk = peaks[pi]
    let dest = destBin + (k - pk)
    if (dest < 0 || dest > half) continue
    eOut += e
    newMag[dest] += e * _boost[pi]
    if (mag[k] > peakMag[dest]) { peakMag[dest] = mag[k]; newPhase[dest] = peakSynPhase[pi] + (phase[k] - phase[pk]) }
  }
  let g = eOut > 1e-24 && eIn > 1e-24 ? Math.sqrt(eIn / eOut) : 1
  for (let k = 0; k <= half; k++) if (newMag[k]) newMag[k] = Math.sqrt(newMag[k]) * g
}

// scatterLocked-internal per-peak scalloping boosts; grown once, reused across frames.
let _boost = new Float64Array(0)

// Variable-ratio resolver for STFT process callbacks. Returns `{ scalar, at }`
// where `scalar` is the ratio at t=0 and `at(frameStart, sampleRate)` resolves
// the ratio for a given frame position. Replaces the 4-line boilerplate that was
// duplicated in every makeProcess function.
export function makeFrameRatio(ratio) {
  if (typeof ratio !== 'function') return { scalar: ratio, at: () => ratio }
  let scalar = ratio(0)
  return {
    scalar,
    at(frameStart, sampleRate) {
      let r = ratio(Math.max(0, frameStart) / sampleRate)
      return (!Number.isFinite(r) || r <= 0) ? (scalar || 1) : r
    }
  }
}

export function makePitchShift(batch, stream) {
  let isVariable = (opts) => {
    let raw = opts?.ratio
    return typeof raw === 'function' || raw instanceof Float32Array
  }
  let isIdentity = (opts) => {
    if (isVariable(opts)) return false
    return resolvePitchParams(opts).ratio === 1
  }
  return function shift(data, opts) {
    if (data instanceof Float32Array) {
      if (isIdentity(opts)) return new Float32Array(data)
      return batch(data, opts)
    }
    if (isChannelArray(data)) {
      if (isIdentity(opts)) return data.map((c) => new Float32Array(c))
      return data.map((c) => batch(c, opts))
    }
    opts = normalizeOptionsInput(data)
    if (isIdentity(opts)) return createChannelWriter(() => passThroughWriter())
    return createChannelWriter(() => stream(opts))
  }
}

// Wraps a `time-stretch` algorithm into a stretch-then-resample batch+stream pitch shifter:
// stretch to `ratio × length` at the stretch fn's own frame parameters, then anti-aliased
// sinc-resample back to the original length. `stretch` is supplied by the caller (ola/wsola/
// psola/granular each plug in their own `time-stretch` export) so shift-core gains no new
// dependency; `deriveOpts(opts, ratio)` computes that fn's own options (frameSize, hopSize,
// delta, minFreq/maxFreq, ...).
export function makeStretchShift(stretch, deriveOpts) {
  function batch(data, opts) {
    let { ratio } = resolvePitchParams(opts)
    let stretched = stretch(data, { factor: ratio, ...deriveOpts(opts, ratio) })
    return resampleTo(stretched, data.length)
  }
  let stream = (opts) => bufferedStream(batch, opts)
  return makePitchShift(batch, stream)
}
