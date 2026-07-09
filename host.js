// Pitch-shift host plumbing (inlined family convention): input normalization,
// ratio semantics, identity fast-path, channel/stream writers.

export function isChannelArray(data) {
  return Array.isArray(data) && data.every((c) => c instanceof Float32Array)
}

export function normalizeOptionsInput(data) {
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

export function passThroughWriter() {
  let flushed = false
  return (chunk) => {
    if (chunk === undefined) { flushed = true; return new Float32Array(0) }
    if (flushed) throw new Error('pitchShift: stream already flushed')
    return new Float32Array(chunk)
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


export function validateInput(data) {
  if (data instanceof Float32Array || isChannelArray(data)) return
  throw new TypeError('pitchShift: input must be Float32Array or array of Float32Array channels')
}

export function mapInput(data, fn, opts) {
  validateInput(data)
  if (data instanceof Float32Array) return fn(data, opts)
  return data.map((c) => fn(c, opts))
}
