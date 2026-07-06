import pitchShift, {
  ola, vocoder, phaseLock, transient, psola, wsola, formant, granular, paulstretch, sms, hpss, sample, hybrid,
  delay, lpc,
} from './index.js'
import { modulationDepth } from 'time-stretch'
import { resampleTo, sincRead, findPeaks, resolveRatio } from '@audio/shift-core'
import { vowel, amSine, rockBeat } from './scripts/fixtures.js'
import { attackEnvelopeCorr, formantDistance, phaseCoherence, aliasRatio, estimateF0 } from './scripts/metrics.js'
import test, { ok, is, throws, run } from 'tst'

// The additions below reuse scripts/metrics.js's proven analyses (attackEnvelopeCorr, formantDistance,
// phaseCoherence, aliasRatio, estimateF0) instead of duplicating that math. They deliberately do NOT
// switch this file's own f0/silence helpers (below) over to metrics.js's zeroCrossingFreq/activeRegion:
// its peak-relative floor (max(1e-4, peak·1e-3)) differs from this file's fixed 1e-6 threshold, and
// unifying them would perturb every already-tuned tolerance above for no benefit — both stand
// deliberately. goertzelMag/goertzelPeakFreq further below are a small local copy of metrics.js's
// private (unexported) Goertzel primitive — exporting it wouldn't be a metric *signature* fix, so
// scripts/metrics.js itself is left untouched.

const sampleRate = 44100

function sine(freq, duration) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * i / sampleRate)
  return out
}

function concat(chunks) {
  let len = chunks.reduce((s, c) => s + c.length, 0)
  let out = new Float32Array(len), offset = 0
  for (let c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

function concatChannels(chunks) {
  let ch = chunks[0].length
  return Array.from({ length: ch }, (_, i) => concat(chunks.map(c => c[i])))
}

function rms(data) {
  let s = 0
  for (let v of data) s += v * v
  return Math.sqrt(s / Math.max(1, data.length))
}

function zeroCrossFreq(data) {
  let a = 0, b = data.length
  for (let i = data.length - 1; i >= 0; i--) if (Math.abs(data[i]) > 1e-6) { b = i + 1; break }
  for (let i = 0; i < b; i++) if (Math.abs(data[i]) > 1e-6) { a = i; break }
  let len = b - a
  let start = a + Math.floor(len * 0.2), end = a + Math.floor(len * 0.8)
  let crossings = 0, prev = data[start]
  for (let i = start + 1; i < end; i++) {
    let curr = data[i]
    if ((prev <= 0 && curr > 0) || (prev >= 0 && curr < 0)) crossings++
    prev = curr
  }
  return crossings / (2 * (end - start) / sampleRate)
}

// Goertzel single-bin magnitude — same primitive scripts/metrics.js uses internally (unexported
// there), duplicated here rather than adding a new export for a one-off test need.
function goertzelMag(data, freq, sampleRate) {
  if (freq <= 0 || freq >= sampleRate / 2) return 0
  let w = 2 * Math.PI * freq / sampleRate
  let c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = 0; i < data.length; i++) {
    let s = data[i] + c * s1 - s2
    s2 = s1
    s1 = s
  }
  let re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w)
  return Math.sqrt(re * re + im * im) / data.length
}

// Narrow Goertzel sweep around an expected peak — sub-Hz f0 read for algorithms too precise for
// zero-crossing counting to usefully bound (±2 Hz tolerances).
function goertzelPeakFreq(data, target, sampleRate, span = 20, step = 0.5) {
  let bestF = target, bestMag = 0
  for (let f = target - span; f <= target + span; f += step) {
    let m = goertzelMag(data, f, sampleRate)
    if (m > bestMag) { bestMag = m; bestF = f }
  }
  return bestF
}

function runChunked(writer, data, boundaries) {
  let parts = [], start = 0
  for (let b of boundaries) { parts.push(writer(data.subarray(start, b))); start = b }
  if (start < data.length) parts.push(writer(data.subarray(start)))
  parts.push(writer())
  return parts
}

const sine440 = sine(440, 0.5)
const sine660 = sine(660, 0.5)

// ─── Each algorithm: batch output is a Float32Array of the same length ────────

for (let [name, fn] of [
  ['ola', ola], ['vocoder', vocoder], ['phaseLock', phaseLock], ['transient', transient],
  ['psola', psola], ['wsola', wsola], ['formant', formant], ['granular', granular],
  ['paulstretch', paulstretch], ['sms', sms], ['hpss', hpss],
  ['sample', sample], ['hybrid', hybrid], ['pitchShift', pitchShift],
]) {
  test(name, () => {
    let out = fn(sine440, { ratio: 1.5, sampleRate })
    ok(out instanceof Float32Array, 'returns Float32Array')
    is(out.length, sine440.length, 'preserves length')
    ok(rms(out) > 0, 'output is non-silent')
  })
}

// ─── Streaming API ────────────────────────────────────────────────────────────

test('streaming produces Float32Arrays and preserves total length', () => {
  let write = phaseLock({ ratio: 1.5 })
  let chunk1 = sine440.subarray(0, 11025)
  let chunk2 = sine440.subarray(11025)
  let out1 = write(chunk1), out2 = write(chunk2), tail = write()
  ok(out1 instanceof Float32Array, 'chunk output is Float32Array')
  ok(out2 instanceof Float32Array, 'chunk output is Float32Array')
  ok(tail instanceof Float32Array, 'flush output is Float32Array')
  is(concat([out1, out2, tail]).length, sine440.length, 'total length preserved')
})

test('default pitchShift streaming', () => {
  let write = pitchShift({ ratio: 1.5 })
  is(typeof write, 'function', 'writer is a function')
  let chunk1 = sine440.subarray(0, 11025), chunk2 = sine440.subarray(11025)
  is(concat([write(chunk1), write(chunk2), write()]).length, sine440.length, 'total length preserved')
})

test('chunk boundary stability', () => {
  let batch = phaseLock(sine440, { ratio: 1.5 })
  for (let boundaries of [[257, 1031, 4097], [512, 2048, 8192], [11025]]) {
    let stream = concat(runChunked(phaseLock({ ratio: 1.5 }), sine440, boundaries))
    is(stream.length, sine440.length, 'length preserved for boundary set ' + boundaries)
    let dot = 0, aa = 0, bb = 0
    for (let i = 0; i < batch.length; i++) { dot += batch[i]*stream[i]; aa += batch[i]*batch[i]; bb += stream[i]*stream[i] }
    let corr = dot / Math.sqrt(Math.max(1e-12, aa*bb))
    ok(corr > 0.85, `streaming matches batch (corr=${corr.toFixed(3)}) for boundaries ${boundaries}`)
  }
})

// ─── Pitch accuracy ───────────────────────────────────────────────────────────

test('pitch accuracy', () => {
  for (let [name, fn, tol] of [
    ['phaseLock', phaseLock, 12], ['vocoder', vocoder, 12], ['transient', transient, 12],
    ['sms', sms, 12], ['hpss', hpss, 12], ['hybrid', hybrid, 15],
    ['paulstretch', paulstretch, 12], ['psola', psola, 3], ['wsola', wsola, 5],
    ['sample', sample, 5], ['granular', granular, 5], ['ola', ola, 50],
  ]) {
    let out = fn(sine440, { ratio: 1.5, sampleRate })
    let f = zeroCrossFreq(out)
    ok(Math.abs(f - 660) < tol, `${name}: 440 Hz → ${f.toFixed(1)} Hz (expected 660 ± ${tol})`)
  }
})

// ─── Variable ratio ───────────────────────────────────────────────────────────

test('variable ratio: frequency-domain + sample accept time-function', () => {
  let curve = t => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)
  for (let [name, fn] of [['phaseLock', phaseLock], ['vocoder', vocoder], ['transient', transient], ['formant', formant], ['sms', sms], ['sample', sample]]) {
    let out = fn(sine440, { ratio: curve, sampleRate })
    ok(out instanceof Float32Array, `${name} returns Float32Array`)
    is(out.length, sine440.length, `${name} preserves length`)
    ok(rms(out) > 0.1, `${name} output is non-silent`)
  }
})

test('variable ratio: time-domain algorithms reject function ratio', () => {
  let curve = t => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)
  for (let [name, fn] of [['psola', psola], ['wsola', wsola], ['ola', ola], ['granular', granular]]) {
    throws(() => fn(sine440, { ratio: curve, sampleRate }), /variable|supported/, `${name} rejects function ratio`)
  }
})

// ─── Auto-selection ───────────────────────────────────────────────────────────

test('pitchShift selects sms for content=tonal', () => {
  let decision = null
  let out = pitchShift(sine440, { ratio: 1.5, content: 'tonal', onDecision: d => { decision = d } })
  ok(out instanceof Float32Array, 'returns Float32Array')
  is(decision?.method, 'sms', 'tonal content selects sms')
})

// ─── Multi-channel ────────────────────────────────────────────────────────────

test('multi-channel batch', () => {
  let stereo = [sine440, sine660]
  let out = phaseLock(stereo, { ratio: 1.5 })
  ok(Array.isArray(out), 'returns array')
  is(out.length, 2, 'channel count preserved')
  ok(out.every((ch, i) => ch instanceof Float32Array && ch.length === stereo[i].length), 'channels are correct length')
})

test('multi-channel streaming', () => {
  let write = phaseLock({ ratio: 1.5 })
  let parts = [
    write([sine440.subarray(0, 11025), sine660.subarray(0, 11025)]),
    write([sine440.subarray(11025),    sine660.subarray(11025)]),
    write(),
  ]
  ok(parts.every(Array.isArray), 'each flush is an array of channels')
  let stereoOut = concatChannels(parts)
  is(stereoOut.length, 2, 'channel count preserved')
  is(stereoOut[0].length, sine440.length, 'left channel length preserved')
  is(stereoOut[1].length, sine660.length, 'right channel length preserved')
})

// ─── Identity and edge cases ──────────────────────────────────────────────────

test('identity ratio=1 passes audio through unchanged', () => {
  let write = phaseLock({ ratio: 1 })
  let out = concat([write(sine440.subarray(0, 11025)), write(sine440.subarray(11025)), write()])
  is(out.length, sine440.length, 'length preserved')
  ok(out.every((v, i) => v === sine440[i]), 'every sample identical')
})

test('output stays bounded', () => {
  let out = phaseLock(sine440, { ratio: 1.5 })
  ok(rms(out) < 1.2, `rms ${rms(out).toFixed(3)} should be < 1.2`)
})

test('invalid ratios throw', () => {
  for (let ratio of [0, -1, NaN, Infinity]) {
    throws(() => phaseLock(sine440, { ratio }), /ratio/, `batch rejects ratio=${ratio}`)
    throws(() => phaseLock({ ratio }),           /ratio/, `stream rejects ratio=${ratio}`)
    throws(() => pitchShift(sine440, { ratio }), /ratio/, `pitchShift batch rejects ratio=${ratio}`)
    throws(() => pitchShift({ ratio }),          /ratio/, `pitchShift stream rejects ratio=${ratio}`)
  }
})

// ─── Chord quality: PSOLA / granular degrade by design ───────────────────────

function chord(freqs, duration) {
  let n = Math.floor(duration * sampleRate)
  let out = new Float32Array(n)
  for (let f of freqs) for (let i = 0; i < n; i++) out[i] += Math.sin(2 * Math.PI * f * i / sampleRate) / freqs.length
  return out
}

const cMajor = chord([261.63, 329.63, 392.00], 0.5)

test('psola on chord degrades to wsola (by design)', () => {
  // PSOLA uses autocorrelation pitch detection — chords violate the single-pitch assumption.
  // The implementation detects low voicing and falls through to WSOLA.
  let out = psola(cMajor, { ratio: 1.5, sampleRate })
  ok(out instanceof Float32Array, 'returns Float32Array')
  is(out.length, cMajor.length, 'length preserved')
  let r = rms(out) / rms(cMajor)
  ok(r > 0.85, `rms preserved (${r.toFixed(3)}, chord input causes mild attenuation)`)
  ok(r < 1.1, `rms bounded (${r.toFixed(3)})`)
})

test('granular on chord: small grains cause audible texture', () => {
  // Granular uses 1024-sample WSOLA — the grain rate is audible by design.
  let out = granular(cMajor, { ratio: 1.5, sampleRate })
  ok(out instanceof Float32Array, 'returns Float32Array')
  is(out.length, cMajor.length, 'length preserved')
  let r = rms(out) / rms(cMajor)
  ok(r > 0.85, `rms preserved (${r.toFixed(3)})`)
})

test('frequency-domain methods handle chords better than time-domain', () => {
  // Phase vocoder methods (phaseLock, vocoder) preserve RMS perfectly on chords.
  // Time-domain methods (psola, granular, ola) lose energy due to phase cancellation.
  let plOut = phaseLock(cMajor, { ratio: 1.5, sampleRate })
  let psolaOut = psola(cMajor, { ratio: 1.5, sampleRate })
  let granOut = granular(cMajor, { ratio: 1.5, sampleRate })

  let plRms = rms(plOut) / rms(cMajor)
  let psolaRms = rms(psolaOut) / rms(cMajor)
  let granRms = rms(granOut) / rms(cMajor)

  ok(plRms > psolaRms, `phaseLock rms (${plRms.toFixed(3)}) > psola rms (${psolaRms.toFixed(3)}) on chord`)
  ok(plRms > granRms, `phaseLock rms (${plRms.toFixed(3)}) > granular rms (${granRms.toFixed(3)}) on chord`)
})

test('psola mono quality exceeds psola chord quality', () => {
  // On monophonic input, PSOLA finds a clean pitch contour and does proper pitch-synchronous
  // overlap-add. On chords, it falls through to WSOLA — demonstrably different quality.
  let monoOut = psola(sine440, { ratio: 1.5, sampleRate })
  let chordOut = psola(cMajor, { ratio: 1.5, sampleRate })

  let monoRms = rms(monoOut) / rms(sine440)
  let chordRms = rms(chordOut) / rms(cMajor)

  ok(monoRms > chordRms, `mono rms ratio (${monoRms.toFixed(3)}) > chord rms ratio (${chordRms.toFixed(3)})`)
})

test('chord modulation depth: granular crumbles, others clean', () => {
  // modulationDepth measures per-partial amplitude wobble — the "crumble" artifact.
  // With time-stretch 1.2.1's input-target WSOLA, all methods are clean on chords
  // except granular, whose small grains (1024) cause audible AM by design.
  let ratio = 1.5
  let shifted = [261.63, 329.63, 392.00].map(f => f * ratio)
  let plMod = modulationDepth(phaseLock(cMajor, { ratio, sampleRate }), shifted, sampleRate)
  let wsMod = modulationDepth(wsola(cMajor, { ratio, sampleRate }), shifted, sampleRate)
  let psMod = modulationDepth(psola(cMajor, { ratio, sampleRate }), shifted, sampleRate)
  let grMod = modulationDepth(granular(cMajor, { ratio, sampleRate }), shifted, sampleRate)

  ok(plMod < 0.05, `phaseLock modDepth=${plMod.toFixed(3)} (clean)`)
  ok(wsMod < 0.05, `wsola modDepth=${wsMod.toFixed(3)} (clean)`)
  ok(psMod < 0.05, `psola modDepth=${psMod.toFixed(3)} (clean, falls through to wsola)`)
  ok(grMod > 0.10, `granular modDepth=${grMod.toFixed(3)} (small grains → audible AM)`)
})

// ─── shift-core primitives (regression guards) ────────────────────────────────

test('shift-core: resampleTo(_, 1) degrades to data[0], no hang', () => {
  let t0 = Date.now()
  let out = resampleTo(new Float32Array([1, 2, 3, 4, 5]), 1)
  ok(Date.now() - t0 < 500, 'completes without hanging')
  is(out.length, 1, 'output length 1')
  is(out[0], 1, 'output is data[0]')
})

test('shift-core: sincRead edge DC gain ≈ 1', () => {
  let buf = new Float32Array(64).fill(1)
  let g = sincRead(buf, 0, 8, 0.5)
  ok(Math.abs(g - 1) < 1e-9, `edge DC gain ${g} ≈ 1`)
})

test('shift-core: findPeaks reports an exact-magnitude plateau exactly once', () => {
  let peaks = findPeaks(new Float64Array([0, 5, 5, 5, 0, 0, 0, 0]), 6)
  is(peaks.length, 1, 'plateau reported once, not zero or twice')
  is(peaks[0], 3, 'plateau trailing edge reported at bin 3')
})

test('shift-core: resolveRatio rejects ratioDuration: 0', () => {
  throws(() => resolveRatio({ ratio: new Float32Array([1, 1.5, 2]), ratioDuration: 0 }), /ratioDuration/, 'ratioDuration: 0 throws TypeError instead of silently collapsing the curve')
})

// ─── STFT batch/stream numeric identity (matchGain dropped) ──────────────────

test('vocoder/phaseLock/transient/formant/sms: batch equals stream exactly', () => {
  let ratio = Math.pow(2, 3 / 12)
  for (let [name, fn] of [['vocoder', vocoder], ['phaseLock', phaseLock], ['transient', transient], ['formant', formant], ['sms', sms]]) {
    let batch = fn(sine440, { ratio, sampleRate })
    let stream = concat(runChunked(fn({ ratio, sampleRate }), sine440, [1000, 1513, 1520]))
    is(stream.length, batch.length, `${name}: stream length matches batch`)
    let maxRel = 0
    for (let i = 0; i < batch.length; i++) {
      let d = Math.abs(batch[i] - stream[i]) / Math.max(Math.abs(batch[i]), Math.abs(stream[i]), 1e-9)
      if (d > maxRel) maxRel = d
    }
    ok(maxRel < 1e-6, `${name}: batch/stream max relative diff ${maxRel.toExponential(2)} < 1e-6`)
  }
})

test('vocoder: pitch-down chord has no spectral holes', () => {
  let freqs = [220, 275, 330], ratio = 0.5
  let sig = chord(freqs, 1.0)
  let out = vocoder(sig, { ratio, sampleRate })
  let seg = out.subarray(Math.floor(out.length * 0.2), Math.floor(out.length * 0.8))
  for (let f of freqs) {
    let mag = goertzelMag(seg, f * ratio, sampleRate)
    ok(mag > 0.02, `partial ${f} Hz → ${f * ratio} Hz retains energy (mag=${mag.toFixed(4)})`)
  }
})

// ─── transient: reset-gating regression ───────────────────────────────────────

test('transient: zero spurious resets on steady tone and tremolo (identical to phaseLock)', () => {
  let ratio = Math.pow(2, 3 / 12)
  let amS = amSine(440, 5, 0.6, 1.5, sampleRate)
  for (let [label, sig] of [['sine', sine440], ['amSine tremolo', amS]]) {
    let t = transient(sig, { ratio, sampleRate })
    let p = phaseLock(sig, { ratio, sampleRate })
    ok(t.every((v, i) => v === p[i]), `${label}: transient bit-identical to phaseLock (no false resets)`)
  }
})

const rockBeatSig = rockBeat(4, sampleRate)

test('transient: attack correlation on rockBeat >= phaseLock', () => {
  let ratio = Math.pow(2, 3 / 12)
  let ta = attackEnvelopeCorr(rockBeatSig, transient(rockBeatSig, { ratio, sampleRate }), sampleRate)
  let pa = attackEnvelopeCorr(rockBeatSig, phaseLock(rockBeatSig, { ratio, sampleRate }), sampleRate)
  ok(ta >= pa, `transient (${ta.toFixed(4)}) >= phaseLock (${pa.toFixed(4)}) on rockBeat`)
})

// ─── hpss: percussive-passthrough regression guard ────────────────────────────

test('hpss: rockBeat attack correlation stays >= 0.98', () => {
  let ratio = Math.pow(2, 3 / 12)
  let out = hpss(rockBeatSig, { ratio, sampleRate })
  let a = attackEnvelopeCorr(rockBeatSig, out, sampleRate)
  ok(a >= 0.98, `hpss rockBeat attack correlation ${a.toFixed(4)} >= 0.98`)
})

// ─── granular: distinct native algorithm ──────────────────────────────────────

test('granular: distinct native algorithm, not a wsola clone', () => {
  let ratio = 1.5
  let g = granular(sine440, { ratio, sampleRate })
  let w = wsola(sine440, { ratio, sampleRate })
  ok(!g.every((v, i) => v === w[i]), 'output differs from wsola')

  let f = zeroCrossFreq(g)
  ok(Math.abs(f - 660) < 5, `f0 440 Hz → ${f.toFixed(1)} Hz (expected 660 ± 5)`)

  let highSine = sine(14000, 0.5)
  let aliased = granular(highSine, { ratio: 2, sampleRate })
  let a = aliasRatio(aliased, highSine)
  ok(a <= 0.05, `aliasRatio ${a.toFixed(4)} <= 0.05 at ratio 2 on 14 kHz sine`)
})

// ─── paulstretch: determinism ──────────────────────────────────────────────────

test('paulstretch: deterministic by seed', () => {
  let a = paulstretch(sine440, { ratio: 1.5, sampleRate })
  let b = paulstretch(sine440, { ratio: 1.5, sampleRate })
  ok(a.every((v, i) => v === b[i]), 'two runs with the default seed are byte-identical')

  let c = paulstretch(sine440, { ratio: 1.5, sampleRate, seed: 12345 })
  ok(!a.every((v, i) => v === c[i]), 'a different opts.seed gives different output')
})

// ─── sample: scalar fast path ≡ variable-ratio path ───────────────────────────

test('sample: scalar ratio bit-identical to variable-ratio path at a constant fn', () => {
  let ratio = 1.5
  let scalarOut = sample(sine440, { ratio, sampleRate })
  let fnOut = sample(sine440, { ratio: () => ratio, sampleRate })
  ok(scalarOut.every((v, i) => v === fnOut[i]), 'scalar fast path matches the variable-ratio path bit-for-bit')
})

// ─── dispatcher: variable ratio + formant conflict ────────────────────────────

test('pitchShift: time-varying ratio is never passthrough', () => {
  let curve = t => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)
  let write = pitchShift({ ratio: curve })
  let out = concat([write(sine440.subarray(0, 11025)), write(sine440.subarray(11025)), write()])
  is(out.length, sine440.length, 'length preserved')
  ok(!out.every((v, i) => v === sine440[i]), 'output differs from input (not passthrough)')
})

test('pitchShift: formant:true with an explicit conflicting method throws', () => {
  throws(() => pitchShift(sine440, { formant: true, method: 'wsola', sampleRate }), /formant/, 'throws TypeError naming the conflict')
})

// ─── delay: harmonizer ──────────────────────────────────────────────────────────

test('delay: f0 exact, duration preserved, loud bounded, batch==stream, variable ratio', () => {
  let ratio = 1.5
  let out = delay(sine440, { ratio, sampleRate })
  is(out.length, sine440.length, 'duration preserved')

  let f = goertzelPeakFreq(out, 660, sampleRate)
  ok(Math.abs(f - 660) < 2, `440 Hz → ${f.toFixed(1)} Hz (expected 660 ± 2)`)

  let loud = rms(out) / rms(sine440)
  ok(loud >= 0.9 && loud <= 1.1, `loudness ratio ${loud.toFixed(3)} within [0.9, 1.1]`)

  let batch = delay(sine440, { ratio, sampleRate })
  let stream = concat(runChunked(delay({ ratio, sampleRate }), sine440, [1000, 1513, 1520]))
  is(stream.length, batch.length, 'stream length matches batch')
  ok(batch.every((v, i) => v === stream[i]), 'batch === stream exactly (bufferedStream)')

  let curve = t => 1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)
  let varOut = delay(sine440, { ratio: curve, sampleRate })
  is(varOut.length, sine440.length, 'variable ratio preserves length')
  ok(rms(varOut) > 0.1, 'variable ratio output is non-silent')
})

// ─── lpc: source-filter ─────────────────────────────────────────────────────────

test('lpc: vowel fixture — f0 shifts, formants preserved, loud bounded', () => {
  let formants = [{ freq: 700, bw: 110 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 160 }]
  let f0 = 155, ratio = Math.pow(2, 5 / 12)
  let sig = vowel(f0, formants, 0.5, sampleRate)
  let out = lpc(sig, { ratio, sampleRate })

  let outF0 = estimateF0(out, sampleRate, 50, 800)
  ok(Math.abs(outF0 - f0 * ratio) < 2, `f0 ${outF0.toFixed(2)} Hz within 2 Hz of ${(f0 * ratio).toFixed(2)}`)

  let dist = formantDistance(sig, out, sampleRate)
  ok(dist < 1.0, `formantDistance ${dist.toFixed(3)} < 1.0`)

  let loud = rms(out) / rms(sig)
  ok(loud >= 0.95 && loud <= 1.05, `loudness ratio ${loud.toFixed(3)} within [0.95, 1.05]`)
})

// ─── time-stretch tail regression ───────────────────────────────────────────────

test('ola/wsola: tail is never truncated to silence at ratio 2', () => {
  for (let [name, fn] of [['ola', ola], ['wsola', wsola]]) {
    let out = fn(sine440, { ratio: 2, sampleRate })
    let tail = out.subarray(out.length - 1024)
    ok(rms(tail) > 0.3, `${name}: final 1024 samples non-silent (rms=${rms(tail).toFixed(3)})`)
  }
})

// ─── hybrid: reason-to-exist regression ─────────────────────────────────────────

test('hybrid: rockBeat attack correlation >= phaseLock alone', () => {
  let ratio = Math.pow(2, 3 / 12)
  let ha = attackEnvelopeCorr(rockBeatSig, hybrid(rockBeatSig, { ratio, sampleRate }), sampleRate)
  let pa = attackEnvelopeCorr(rockBeatSig, phaseLock(rockBeatSig, { ratio, sampleRate }), sampleRate)
  ok(ha >= pa, `hybrid (${ha.toFixed(4)}) >= phaseLock (${pa.toFixed(4)}) on rockBeat`)
})

test('hybrid: tremolo stays near phaseLock coherence (no false wsola trigger)', () => {
  let sig = amSine(440, 5, 0.6, 1.5, sampleRate)
  let ratio = Math.pow(2, 3 / 12)
  let coh = phaseCoherence(sig, hybrid(sig, { ratio, sampleRate }), 5, sampleRate)
  ok(coh > 0.95, `phaseCoherence on tremolo ${coh.toFixed(3)} > 0.95`)
})

// Explicit run() races tst's own autorun stabilization timer: on a fast-enough suite the
// module finishes before the timer's second poll, so `hasRun` is already true and autorun is
// a no-op — but once total runtime crosses that poll window (rockBeat-sized fixtures above
// pushed it there), autorun sees a stable non-empty `tests` queue mid-flight and fires a
// second, duplicate run(). `test.manual = true` is tst's documented switch for "the caller
// drives run() itself"; it also skips tst's own process.exit(), so that's reproduced here to
// keep npm test's pass/fail exit code intact for CI/prepublishOnly.
test.manual = true
let state = await run()
process.exit(state.failed.length ? 1 : 0)
