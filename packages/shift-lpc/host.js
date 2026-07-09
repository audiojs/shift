// Pitch-shift host plumbing (inlined family convention): input normalization,
// ratio semantics, identity fast-path, channel/stream writers.

function isChannelArray(data) {
  return Array.isArray(data) && data.every((c) => c instanceof Float32Array)
}

function normalizeOptionsInput(data) {
  if (data === undefined || data === null || typeof data === 'object') return data
  throw new TypeError('pitchShift: options must be an object')
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

function passThroughWriter() {
  let flushed = false
  return (chunk) => {
    if (chunk === undefined) { flushed = true; return new Float32Array(0) }
    if (flushed) throw new Error('pitchShift: stream already flushed')
    return new Float32Array(chunk)
  }
}

function createChannelWriter(factory) {
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

// Variable-ratio resolver: scalar at t=0 + ratioFn(t) for time-varying pitch.
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

// Streaming adapter for whole-signal-look-ahead algorithms: buffer, emit on flush.
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

// Rescale out in place so its RMS matches ref's — bounded to the 0.1..10x ballpark
// (outside it the output is legitimately silent or the algorithm is broken).
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

// Periodic Hann (denominator N) — the DFT-correct OLA analysis window; cached per N.
let _hannCache = new Map()
export function hannWindow(N) {
  let w = _hannCache.get(N)
  if (w) return w
  w = new Float64Array(N)
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)
  _hannCache.set(N, w)
  return w
}
