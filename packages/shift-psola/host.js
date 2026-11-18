import { sincRead } from '@audio/resample-sinc'

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
      if (mode !== 'channels') return writers[0]()
      // The channels of a stream are one take: a whole-signal shift takes its length over all
      let take = writers[0].take ? Math.max(...writers.map((w) => w.take())) : undefined
      return writers.map((w) => w(undefined, take))
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
  // `take`: the take's length, where the caller shifts one channel of a take with more
  return function shift(data, opts, take) {
    if (data instanceof Float32Array) {
      if (isIdentity(opts)) return new Float32Array(data)
      return batch(data, opts, take)
    }
    if (isChannelArray(data)) {
      if (isIdentity(opts)) return data.map((c) => new Float32Array(c))
      // The channels are one take: its length is the longest of theirs, the same for every one
      let m = Math.max(...data.map(takeLength))
      return data.map((c) => batch(c, opts, m))
    }
    opts = normalizeOptionsInput(data)
    if (isIdentity(opts)) return createChannelWriter(() => passThroughWriter())
    return createChannelWriter(() => stream(opts))
  }
}

// Streaming adapter for whole-signal-look-ahead algorithms: buffer, emit on flush. `take()`
// is the buffered take's length, for the channels of a stream to shift over one.
export function bufferedStream(batch, opts) {
  let parts = []
  let flushed = false
  let write = (chunk, take) => {
    if (chunk === undefined) {
      if (flushed) return new Float32Array(0)
      flushed = true
      let total = 0
      for (let p of parts) total += p.length
      let all = new Float32Array(total)
      let o = 0
      for (let p of parts) { all.set(p, o); o += p.length }
      return batch(all, opts, take)
    }
    if (flushed) throw new Error('pitchShift: stream already flushed')
    parts.push(new Float32Array(chunk))
    return new Float32Array(0)
  }
  write.take = () => {
    let m = 0
    for (let p of parts) m += p.length
    for (let k = parts.length - 1; k >= 0; k--) {
      let i = takeLength(parts[k])
      if (i) return m - parts[k].length + i
      m -= parts[k].length
    }
    return 0
  }
  return write
}

// The take's length: its frames up to the last that is not 0. What follows is silence, a
// host's (one that renders a tail appends it) or the take's own: a whole-signal shift
// renders on through it, and no level, fit or statistic it takes counts it.
export function takeLength(data) {
  let m = data.length
  while (m > 0 && data[m - 1] === 0) m--
  return m
}

// The silence a WSOLA stretch (grains of N frames, a search of δ either side) needs after
// the take to stretch it as the take followed by silence ever after: every grain that
// reads the take, its search and its correlation lie within N + 2δ of it; and the stretch
// runs on past the frames the output reads for the tail, (N + 16)/ratio shifted down.
export const grainSilence = ({ frameSize: N, delta }, ratio) => N + 2 * delta + Math.ceil((N + 16) / Math.min(1, ratio))

// Stretch-then-resample pitch shifter: stretch the take to ratio x its length, sinc-
// resample back. The stretch gets the take followed by `silence(o, ratio)` frames of its
// own silence, never the call's: the silence a host appends would move the resampler's
// step, which follows the length, and every statistic the stretch takes. The step is the
// take's, (round(m·ratio) − 1) / (m − 1), as resampling the take's own stretch to its
// length gives it, and the output frames past the take read on into what the stretch
// sounds past it, as far as the call has frames.
export function makeStretchShift(stretch, deriveOpts, silence = () => 0) {
  function batch(data, opts, take = takeLength(data)) {
    let { ratio } = resolvePitchParams(opts)
    let n = data.length, m = Math.min(take, n), o = deriveOpts(opts, ratio)
    let src = new Float32Array(m + silence(o, ratio))
    src.set(data.subarray(0, m))
    let stretched = stretch(src, { factor: ratio, ...o })
    let out = new Float32Array(n), K = Math.round(m * ratio), len = stretched.length
    if (!m || !K) return out
    if (K === m) { out.set(stretched.subarray(0, Math.min(n, len))); return out }
    let step = m > 1 ? (K - 1) / (m - 1) : ratio, cutoff = step > 1 ? 1 / step : 1
    out[0] = stretched[0]
    for (let i = m > 1 ? 0 : 1; i < n; i++) {
      let pos = i * step
      if (i >= m && pos > len - 1) break
      out[i] = sincRead(stretched, pos, 8, cutoff)
    }
    return out
  }
  let stream = (opts) => bufferedStream(batch, opts)
  return makePitchShift(batch, stream)
}
