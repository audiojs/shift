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

// A Hann-windowed sinc read of the input at a fractional position: @audio/resample-sinc's sincRead, tap for tap and
// in the same arithmetic, but for the taps past the input's end. What follows a whole-signal shifter's input is
// silence (a host that renders a tail appends exactly that), so a tap past the end is a zero that keeps its weight,
// and a read there is what it is with the silence in the buffer. sincRead leaves such taps out and divides by the
// weight of those left: past the end only the kernel's far lobes are left, and their small sum makes a read there
// many times the signal. Before the start the same holds for a read at a position before 0, which reads the silence
// there; from 0 on the taps before 0 are left out as there, so a read at frame 0 keeps the level. With a cutoff under
// 1 the two rules part at 0: on a held level a read just before 0 gives (1 + cutoff)/2 of it, a read at 0 all of it.
// Of the three only delay reads there: shifted up by a ratio over 3 (over 19 st), a tap's first wrap falls within the
// splice's search of frame 0 and can land before it, where the tap's crossfade weight is near 0.
function sincKernel(hw, cutoff) {
  let dTheta = Math.PI * cutoff, dPhi = Math.PI / hw
  return { hw, cutoff, dTheta, dPhi, cosDT: Math.cos(dTheta), sinDT: Math.sin(dTheta), cosDP: Math.cos(dPhi), sinDP: Math.sin(dPhi) }
}

export function sincRead(buf, pos, r = 8, cutoff = 1) {
  let i0 = Math.floor(pos)
  let frac = pos - i0
  let { hw, dTheta, dPhi, cosDT, sinDT, cosDP, sinDP } = sincKernel(Math.ceil(r / cutoff), cutoff)
  let len = buf.length
  let x = -hw + 1 - frac
  let sinT = Math.sin(x * dTheta), cosT = Math.cos(x * dTheta)
  let sinP = Math.sin(x * dPhi), cosP = Math.cos(x * dPhi)
  let sum = 0, weight = 0
  for (let n = -hw + 1; n <= hw; n++) {
    let idx = i0 + n
    if (Math.abs(x) < hw && (idx >= 0 || pos < 0)) {
      let theta = x * dTheta
      let si = Math.abs(x * cutoff) < 1e-9 ? 1 : sinT / theta
      let wt = si * cutoff * (0.5 + 0.5 * cosP)
      if (idx >= 0 && idx < len) sum += buf[idx] * wt
      weight += wt
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
