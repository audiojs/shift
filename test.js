import pitchShift, {
  ola, vocoder, phaseLock, transient, psola, wsola, formant, granular, paulstretch, sms, hpss, sample, hybrid,
  delay, lpc,
} from './index.js'
import { modulationDepth } from '@audio/quality'
import { resampleTo, sincRead } from '@audio/resample-sinc'
import { findPeaks } from '@audio/spectral-pvoc'
import { resolveRatio, sincRead as sincSample } from './packages/shift-sample/host.js'
import { sincRead as sincGranular } from './packages/shift-granular/host.js'
import { sincRead as sincDelay } from './packages/shift-delay/host.js'
import { vowel, amSine, rockBeat, karplusStrong } from './scripts/fixtures.js'
import lenaRaw from 'audio-lena/raw'
import { attackEnvelopeCorr, formantDistance, phaseCoherence, aliasRatio, estimateF0 } from './scripts/metrics.js'
import { fft } from 'fourier-transform'
import test, { ok, is, throws, run } from 'tst'
import { vocoder as vocoderAtom } from '@audio/shift-pvoc/audio'
import { formantShift as formantAtom } from '@audio/shift-formant/audio'
import { pitchOla } from './packages/shift-ola/audio.js'
import { pitchTransient } from './packages/shift-transient/audio.js'
import { pitchPsola } from './packages/shift-psola/audio.js'
import { pitchWsola } from './packages/shift-wsola/audio.js'
import { pitchGranular } from './packages/shift-granular/audio.js'
import { pitchSms } from './packages/shift-sms/audio.js'
import { pitchHpss } from './packages/shift-hpss/audio.js'
import { pitchSample } from './packages/shift-sample/audio.js'
import { pitchHybrid } from './packages/shift-hybrid/audio.js'
import { pitchDelay } from './packages/shift-delay/audio.js'
import { pitchLpc } from './packages/shift-lpc/audio.js'
import { paulstretch as paulstretchAtom } from './packages/shift-paulstretch/audio.js'
import { pitchShift as pitchShiftAtom } from './audio.js'

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

// ─── absorbed primitives (regression guards) ────────────────────────────────

test('resample-sinc: resampleTo(_, 1) degrades to data[0], no hang', () => {
  let t0 = Date.now()
  let out = resampleTo(new Float32Array([1, 2, 3, 4, 5]), 1)
  let ms = Date.now() - t0
  console.log(`  ${ms} ms`)
  // the bound by the clock where the clock is the machine's own: a shared runner's is not
  if (!process.env.CI) ok(ms < 500, 'completes without hanging')
  is(out.length, 1, 'output length 1')
  is(out[0], 1, 'output is data[0]')
})

test('resample-sinc: sincRead edge DC gain ≈ 1', () => {
  let buf = new Float32Array(64).fill(1)
  let g = sincRead(buf, 0, 8, 0.5)
  ok(Math.abs(g - 1) < 1e-9, `edge DC gain ${g} ≈ 1`)
})

test('spectral-pvoc: findPeaks reports an exact-magnitude plateau exactly once', () => {
  let peaks = findPeaks(new Float64Array([0, 5, 5, 5, 0, 0, 0, 0]), 6)
  is(peaks.length, 1, 'plateau reported once, not zero or twice')
  is(peaks[0], 3, 'plateau trailing edge reported at bin 3')
})

test('host: resolveRatio rejects ratioDuration: 0', () => {
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

test('transient/phaseLock: rockBeat attack envelope correlation stays above 0.95', () => {
  let ratio = Math.pow(2, 3 / 12)
  let ta = attackEnvelopeCorr(rockBeatSig, transient(rockBeatSig, { ratio, sampleRate }), sampleRate)
  let pa = attackEnvelopeCorr(rockBeatSig, phaseLock(rockBeatSig, { ratio, sampleRate }), sampleRate)
  // A better phase-lock baseline must not make unchanged transient quality fail.
  ok(ta > .95 && pa > .95, `transient ${ta.toFixed(4)}, phaseLock ${pa.toFixed(4)}: attack correlation > .95`)
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

// Shifted up an octave, an output frame mixes grains reading the take up to N/2 = 1024 frames ahead of it, so over the
// last 1024 frames the take's end and the silence after it: they keep more than half the level of the output's own
// middle (plain OLA cancels this tone to 0.04 there, and it is the level a stretch is held to), and a stretch that
// stops a grain (2048 frames) short of the end falls under it
test('ola/wsola: tail is never truncated to silence at ratio 2', () => {
  for (let [name, fn] of [['ola', ola], ['wsola', wsola]]) {
    let out = fn(sine440, { ratio: 2, sampleRate })
    let tail = out.subarray(out.length - 1024), mid = out.subarray(out.length >> 2, out.length - (out.length >> 2))
    ok(rms(tail) > 0.5 * rms(mid), `${name}: final 1024 samples non-silent (rms=${rms(tail).toFixed(3)})`)
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

test('pvoc/formant manifests: output is the kernel stream delayed by exactly the declared latency, under any block size', () => {
  // The kernel stream emits a sample up to FRAME samples late; an unprimed FIFO ran dry
  // during warm-up and zero-filled, so where the signal landed depended on the block size
  let x = new Float32Array(sampleRate)
  for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * 330 * i / sampleRate) * Math.min(1, i / 2000)
  let ratio = () => 2 ** (7 / 12)
  for (let [atom, kernel] of [[vocoderAtom, vocoder], [formantAtom, formant]]) {
    let write = kernel({ ratio, frameSize: 2048, hopSize: 512, sampleRate, fs: sampleRate }), ref = new Float32Array(x.length), o = 0, L = atom.latency
    for (let i = 0; i < x.length; i += 333) { let p = write(x.subarray(i, i + 333)); ref.set(p.subarray(0, x.length - o), o); o += p.length }
    let params = { semitones: Float32Array.of(7) }
    for (let block of [2048, 997, 64, 1]) {
      let process = atom({ sampleRate, maxBlockSize: block, maxChannels: 1, params }), out = new Float32Array(x.length), err = 0
      for (let i = 0; i < x.length; i += block) {
        let n = Math.min(block, x.length - i), b = new Float32Array(n)
        process([[x.subarray(i, i + n)]], [[b]], params); out.set(b, i)
      }
      for (let i = 0; i < L; i++) err = Math.max(err, Math.abs(out[i]))
      for (let i = L; i < x.length; i++) err = Math.max(err, Math.abs(out[i] - ref[i - L]))
      is(err, 0, `${atom.name}: block ${block}, latency ${L}`)
    }
  }
})

// Each method's own manifest, loaded alone (a host's pitch({ method }) loads that one): whole-render, as the umbrella
// hosts it, and the same samples as the umbrella with that method named, channel by channel
test('method manifests: each alone gives the umbrella\'s samples for its method', () => {
  let x = [0, 1].map(c => { let v = new Float32Array(sampleRate / 2); for (let i = 0; i < v.length; i++) v[i] = 0.4 * Math.sin(2 * Math.PI * (220 + 110 * c) * i / sampleRate); return v })
  let atoms = { ola: pitchOla, transient: pitchTransient, psola: pitchPsola, wsola: pitchWsola, granular: pitchGranular, sms: pitchSms, hpss: pitchHpss, sample: pitchSample, hybrid: pitchHybrid, delay: pitchDelay, lpc: pitchLpc }
  for (let [method, atom] of Object.entries(atoms)) {
    is(atom.streaming, false, `${method}: whole-render`)
    let params = { semitones: Float32Array.of(5) }, out = x.map(c => new Float32Array(c.length))
    atom({ sampleRate, maxBlockSize: x[0].length, maxChannels: 2, params })([x], [out], params)
    let err = 0
    let refs = pitchShift(x, { semitones: 5, method, sampleRate })
    for (let c = 0; c < 2; c++) { let ref = refs[c]; for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(out[c][i] - ref[i])) }
    is(err, 0, `${method}: as pitchShift({ method: '${method}' })`)
  }
})

// A semitone is a twelfth of an octave (equal temperament): 2^(1/12) in frequency, 12 of them 2:1. Hosts read a value
// written '7st' as 7 and print the unit beside the number (contract 1.0 § Parameters, `unit`)
test('manifests: every `semitones` declares its unit, st, and the host resolver reads 12 of them as an octave', () => {
  let atoms = { pitchShift: pitchShiftAtom, vocoder: vocoderAtom, formant: formantAtom, paulstretch: paulstretchAtom, ola: pitchOla, transient: pitchTransient, psola: pitchPsola, wsola: pitchWsola, granular: pitchGranular, sms: pitchSms, hpss: pitchHpss, sample: pitchSample, hybrid: pitchHybrid, delay: pitchDelay, lpc: pitchLpc }
  for (let [name, atom] of Object.entries(atoms)) is(atom.params.semitones.unit, 'st', `${name}: semitones in st`)
  is(resolveRatio({ semitones: 12 }).ratio, 2, '12 st: 2:1')
})

// CONTRACT 1.0, tail: what the output does once the input stops. A frame that read the input's last sample spreads it
// over all its samples and the frames after read silence: past latency + tail the output is 0, exactly; within the tail
// it is not (each declared 0 before)
test('vocoder, formant, paulstretch manifests: the output is silent from latency + tail on, and not before it', () => {
  for (let [atom, params] of [[vocoderAtom, { semitones: Float32Array.of(7) }], [formantAtom, { semitones: Float32Array.of(-5) }], [paulstretchAtom, { semitones: Float32Array.of(3), frame: Float32Array.of(0.1) }]])
    for (let sr of [44100, 48000]) {
      let S = Math.round(0.4 * sr) + 77, n = S + 3 * 8192, x = new Float32Array(n), r = 9
      for (let i = 0; i < S; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; x[i] = 0.2 * Math.sin(2 * Math.PI * 330 * i / sr) + 0.1 * (r / 4294967296 - 0.5) }
      let L = typeof atom.latency === 'number' ? atom.latency : 0, T = Math.round(atom.tail({ sampleRate: sr, params }) * sr), out = new Float32Array(n)
      let block = atom.streaming === false ? n : 512, process = atom({ sampleRate: sr, maxBlockSize: block, maxChannels: 1, params })
      for (let i = 0; i < n; i += block) { let o = new Float32Array(Math.min(block, n - i)); process([[x.subarray(i, i + o.length)]], [[o]], params); out.set(o, i) }
      let last = 0
      for (let i = 0; i < n; i++) if (out[i]) last = i
      ok(last < S + L + T && last > S + L + 128, `${atom.name} at ${sr} Hz: last sound ${last - S - L} samples past the latency, tail ${T}`)
    }
})

// CONTRACT 1.0, whole signals: a host that renders a tail ends the take with that much silence, which the processor
// takes as silence, no level or other measure of it counting it. So each whole-signal method writes the same over the
// take with no silence after it, with its tail's and with 4096 frames more, and the same over the tail with those 4096
// or without; a take loud to its last frame, where a read past the take's end, a fit window, a median, a level match
// or hybrid's blend would see the silence: a 330 Hz tone under noise, a hit every 3000 frames (5 ms decay) for onsets
test('whole-signal methods: the take writes the same whatever silence follows it, and so does its tail', () => {
  let sr = sampleRate, n = Math.round(0.3 * sr) + 77, x = new Float32Array(n), r = 3
  for (let i = 0; i < n; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; x[i] = 0.25 * Math.sin(2 * Math.PI * 330 * i / sr) + (0.05 + 0.5 * Math.exp(-(i % 3000) / (0.005 * sr))) * (r / 4294967296 - 0.5) }
  let call = (atom, params, pad) => { let a = new Float32Array(n + pad), y = new Float32Array(n + pad); a.set(x); atom({ sampleRate: sr, maxBlockSize: a.length, maxChannels: 1, params })([[a]], [[y]], params); return y }
  let first = (a, b, to) => { for (let i = 0; i < to; i++) if (a[i] !== b[i]) return i; return -1 }
  let methods = [['ola', pitchOla], ['wsola', pitchWsola], ['psola', pitchPsola], ['granular', pitchGranular], ['delay', pitchDelay], ['lpc', pitchLpc],
    ['hybrid', pitchHybrid], ['transient', pitchTransient], ['sms', pitchSms], ['hpss', pitchHpss], ['sample', pitchSample],
    ['pitchShift auto', pitchShiftAtom, { method: 'auto', content: 'any', formant: false }]]
  for (let [name, atom, more = {}] of methods) for (let st of [-7, 7]) {
    let params = { semitones: Float32Array.of(st), ...more }, t = typeof atom.tail === 'function' ? atom.tail({ sampleRate: sr, params }) : atom.tail ?? 0
    let T = Number.isFinite(t) ? Math.round(t * sr) : 0, bare = call(atom, params, 0), tailed = call(atom, params, T), more4096 = call(atom, params, T + 4096)
    is(first(bare, tailed, n), -1, `${name} at ${st} st: the take, padded by its tail (${T} frames), as alone`)
    is(first(tailed, more4096, n + T), -1, `${name} at ${st} st: the take and its tail, 4096 frames more silence after, as before them`)
  }
})

// The eleven whole-signal methods' manifests, and the umbrella with each of its sixteen methods named, as hosts load them
const WHOLE = [['ola', pitchOla], ['wsola', pitchWsola], ['psola', pitchPsola], ['granular', pitchGranular], ['delay', pitchDelay], ['lpc', pitchLpc],
  ['hybrid', pitchHybrid], ['transient', pitchTransient], ['sms', pitchSms], ['hpss', pitchHpss], ['sample', pitchSample]]
const UMBRELLA = ['auto', 'ola', 'vocoder', 'phase-lock', 'transient', 'formant', 'psola', 'wsola', 'granular', 'paulstretch', 'sms', 'hpss', 'sample', 'hybrid', 'delay', 'lpc']
  .map(method => [`pitchShift ${method}`, pitchShiftAtom, { method, content: 'any', formant: false }])
// the processor's own call: one block of the whole signal, the channels given
const render = (atom, sr, chans, params) => { let outs = chans.map(c => new Float32Array(c.length)); atom({ sampleRate: sr, maxBlockSize: chans[0].length, maxChannels: chans.length, params })([chans], [outs], params); return outs }
const peakOf = (a, from = 0, to = a.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p }
// a singing voice (audio-lena: 44.1 kHz, float32)
const lena = new Float32Array(lenaRaw)
// How far before a change in its input lpc's render can change, in frames, at its defaults (packages/shift-lpc/index.js:
// frameSize 1024, a hop of 256, the delay line's W 2048 and L 512): a frame's fit is one of the windows that hold it or
// the one after, which reach K + 2 = 6 hops past its start; across a cleared memory the residual's scale reads the
// filters W + L either side; the delay line reads the residual W + L early, its splice 256 frames on and its sinc taps
// ceil(8·max(1, ratio)) + 1 beside. Each channel's level is matched once a call, one gain a channel, so past this reach
// a channel's render differs from another only by that one factor
const lpcReach =(sr, st) => 6 * 256 + 2 * 2560 + 256 + Math.ceil(8 * Math.max(1, 2 ** (st / 12))) + 1
// how far a's render departs from b's times one factor over [0, to), re b's peak there: the factor that fits b to a
// best, then the largest difference left
const apartUpToGain = (a, b, to = Math.min(a.length, b.length)) => {
  let ab = 0, bb = 0, d = 0
  for (let i = 0; i < to; i++) { ab += a[i] * b[i]; bb += b[i] * b[i] }
  let k = bb ? ab / bb : 1
  for (let i = 0; i < to; i++) d = Math.max(d, Math.abs(a[i] - k * b[i]))
  return d / Math.max(1e-30, peakOf(b, 0, to))
}
const SINC_COPIES = [sincGranular, sincDelay, sincSample]

// CONTRACT 1.0, whole signals: a take's own digital silence (a fade to zero, a clip's end) is silence as a host's padding
// is, so a method renders on through it as through the padding. A take fading over its last 0.15 s (τ 25 ms, to −52 dB)
// into exact zeros, in one call: past its last sound m the output is not exactly 0 where, just before m, it stood 20 dB
// over the input's own fade (each re its peak), and no step lands at m: the largest first difference over the 8 frames
// about m stays under twice the largest over the 256 before them
test('whole-signal methods: a take that fades into its own digital silence rings on past its last sound, with no step there', () => {
  let sr = sampleRate, s = Math.round(0.4 * sr), d0 = s - Math.round(0.15 * sr)
  let take = noisy => {
    let x = new Float32Array(s + Math.round(0.3 * sr)), r = 11, m = 0
    for (let i = 0; i < s; i++) {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0
      let v = noisy ? 0.4 * (r / 4294967296 - 0.5) : 0.4 * Math.sin(2 * Math.PI * 220 * i / sr) + 0.02 * (r / 4294967296 - 0.5)
      x[i] = v * (i < d0 ? 1 : Math.exp(-(i - d0) / (0.025 * sr)))
      if (x[i] !== 0) m = i + 1
    }
    return { x, m }
  }
  for (let [name, atom, more = {}] of [...WHOLE, ...UMBRELLA]) for (let [noisy, sts] of [[false, [-12, 5, 12]], [true, [12]]]) for (let st of sts) {
    let { x, m } = take(noisy), y = render(atom, sr, [x], { semitones: Float32Array.of(st), ...more })[0], at = `${name} at ${st} st, ${noisy ? 'noise' : 'a 220 Hz tone'}`
    let level = (a, P) => rms(a.subarray(m - 64, m)) / P, Py = peakOf(y), dAt = 0, dBefore = 0
    let dead = y.subarray(m, m + 64).every(v => v === 0) && level(y, Py) > 10 * level(x, peakOf(x))
    for (let i = m - 4; i < m + 4; i++) dAt = Math.max(dAt, Math.abs(y[i] - y[i - 1]))
    for (let i = m - 260; i < m - 4; i++) dBefore = Math.max(dBefore, Math.abs(y[i] - y[i - 1]))
    ok(!dead, `${at}: rings on past the take's last sound`)
    ok(dAt <= 2 * dBefore + 1e-6 * Py, `${at}: no step at the take's last sound (${(dAt / Math.max(1e-30, dBefore)).toFixed(2)}× the largest difference before)`)
  }
})

// One take, one time base: the channels of a call are one take, so what a method takes from the take's length (a
// stretch's step, a fit's end, a measure's span) is one number for all of them. The same voice in two channels, the
// right's last k frames zero: short of the 8192 frames before the right's end, which read the difference (hpss's time
// median spans 8 frames of 512 either side of a 2048-frame frame), the two write the same. lpc renders each channel as
// a take of its own, unmatched, and matches each channel's level with a gain of its own over the call's one span: short
// of lpc's reach (lpcReach) the two renders are one, so the right writes as the left times one factor, the two gains'
// ratio, every sample within 2^-22 of itself (float32's rounding of the two moves it 2^-23 at most; 2^-23.03 measured)
// and the factor within 1e-4 of 1 (4.9e-5 at most measured, both tests): what parts them is the right's last k frames
const timeBase = (name, yl, yr, to) => {
  if (name !== 'lpc') { let d = 0; for (let i = 0; i < to; i++) d = Math.max(d, Math.abs(yr[i] - yl[i])); return { ok: d === 0, said: d ? d.toExponential(1) : 0 } }
  let ab = 0, bb = 0, d = 0
  for (let i = 0; i < to; i++) { ab += yr[i] * yl[i]; bb += yl[i] * yl[i] }
  let k = ab / bb
  for (let i = 0; i < to; i++) d = Math.max(d, Math.abs(yr[i] - k * yl[i]) - 2 ** -22 * Math.abs(yr[i]))
  return { ok: d <= 0 && Math.abs(k - 1) <= 1e-4, said: `times ${k.toFixed(6)}${d > 0 ? `, ${d.toExponential(1)} past rounding` : ', within rounding'}` }
}
test('whole-signal methods: the channels of a take share one time base, a channel ending in zeros writing as the other over the frames they share', () => {
  let sr = sampleRate, n = Math.round(0.5 * sr), x = lena.slice(3 * sr, 3 * sr + n)
  for (let [name, atom, more = {}] of [...WHOLE, UMBRELLA[0], UMBRELLA[6]]) for (let k of [1, 300]) for (let st of [-12, 7]) {
    let R = x.slice(); R.fill(0, n - k)
    let [yl, yr] = render(atom, sr, [x, R], { semitones: Float32Array.of(st), ...more }), to = n - k - (name === 'lpc' ? lpcReach(sr, st) : 8192), d = timeBase(name, yl, yr, to)
    ok(d.ok, `${name} at ${st} st: the right ending ${k} frames early writes as the left over the ${to} frames they share (${d.said})`)
  }
})

// The channels a stream is written in are one take too: at the flush a whole-signal method takes its length over all
// of them, as the batch of the channel array does. The voice and the two channels of the test above, written in blocks
// of 1024 frames (3000 trailing zeros fill the right's last blocks): the right writes as the left over the frames they
// share (lpc: short of its reach, times one factor, as above), and each channel is the batch's, bit for bit. The
// umbrella writes a stream's channels through one writer of its method
test('whole-signal methods: a stream of channels is one take, a channel ending in zeros writing as the other over the frames they share, as in the batch', () => {
  let sr = sampleRate, n = Math.round(0.5 * sr), x = lena.slice(3 * sr, 3 * sr + n), B = 1024
  let same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
  let methods = [['ola', ola], ['wsola', wsola], ['psola', psola], ['lpc', lpc], ['hybrid', hybrid], ['hpss', hpss], ['pitchShift psola', pitchShift, { method: 'psola' }]]
  for (let [name, fn, more = {}] of methods) for (let k of [1, 3000]) for (let st of [-12, 7]) {
    let R = x.slice(); R.fill(0, n - k)
    let opts = { semitones: st, sampleRate: sr, ...more }, write = fn(opts), parts = [[], []]
    for (let i = 0; i < n; i += B) write([x.subarray(i, i + B), R.subarray(i, i + B)]).forEach((c, j) => parts[j].push(c))
    write().forEach((c, j) => parts[j].push(c))
    let [yl, yr] = parts.map(p => concat(p)), [bl, br] = fn([x, R], opts), to = n - k - (name === 'lpc' ? lpcReach(sr, st) : 8192), d = timeBase(name, yl, yr, to)
    ok(d.ok, `${name} at ${st} st, a stream in blocks of ${B}: the right ending ${k} frames early writes as the left over the ${to} frames they share (${d.said})`)
    ok(same(yl, bl) && same(yr, br), `${name} at ${st} st, the right ending ${k} frames early: the stream's channels are the batch's, bit for bit`)
  }
})

// The local sinc reads (granular, delay, sample: one text) are @audio/resample-sinc's sincRead wherever every tap is in
// the buffer, bit for bit. Past the end a tap is a zero that keeps its weight, so a read there is the library's read of
// the buffer followed by silence; a read at a position before 0 is the library's read of the silence before it; from 0
// on, taps before 0 are left out as the library leaves them. Positions in 1024ths, which a shift by whole frames keeps
// exact; buffers of 1 to 4096 frames, 4 to 16 zero crossings a side, cutoffs 0.2 to 1
test('granular, delay, sample: the local sinc read is resample-sinc\'s inside the buffer, and reads silence past either end', () => {
  let r = 5, rnd = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296, bad = [0, 0, 0], reads = 0
  for (let b = 0; b < 24; b++) {
    let len = 1 + Math.floor(4095 * rnd() ** 2), buf = Float32Array.from({ length: len }, () => rnd() - 0.5), Z = 200
    let after = new Float32Array(len + Z), around = new Float32Array(Z + len + Z)
    after.set(buf); around.set(buf, Z)
    for (let k = 0; k < 200; k++) {
      let rr = 4 + Math.floor(13 * rnd()), cutoff = 0.2 + 0.8 * rnd(), hw = Math.ceil(rr / cutoff)
      if (hw > 80) continue
      let pos = Math.floor((-hw - 4 + (len + 2 * hw + 8) * rnd()) * 1024) / 1024, i0 = Math.floor(pos)
      let want = pos < 0 ? sincRead(around, pos + Z, rr, cutoff) : i0 - hw + 1 >= 0 && i0 + hw < len ? sincRead(buf, pos, rr, cutoff) : sincRead(after, pos, rr, cutoff)
      SINC_COPIES.forEach((read, c) => { if (!Object.is(read(buf, pos, rr, cutoff), want)) bad[c]++ })
      reads++
    }
  }
  for (let [c, name] of ['granular', 'delay', 'sample'].entries()) is(bad[c], 0, `${name}: ${reads} reads, each resample-sinc's sincRead of the buffer, or of it with silence after or before`)
})

// CONTRACT 1.0, whole signals, where hybrid's blend is in force (its trust over 0: a cut of a voice, at 3 s): its lag and
// trust are measures of the take, so the take writes the same padded by its tail, and by 4096 frames more
test('hybrid: where its blend is trusted, the take writes the same whatever silence follows it', () => {
  let sr = sampleRate, x = lena.slice(3 * sr, Math.round(3.5 * sr)), n = x.length
  for (let st of [-7, 7]) {
    let params = { semitones: Float32Array.of(st) }, T = Math.round(pitchHybrid.tail({ sampleRate: sr, params }) * sr), outs = []
    for (let pad of [0, T, T + 4096]) { let a = new Float32Array(n + pad); a.set(x); outs.push(render(pitchHybrid, sr, [a], params)[0]) }
    let first = (a, b) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return -1 }
    is(first(outs[0], outs[1]), -1, `hybrid at ${st} st: padded by its tail (${T} frames), as alone`)
    is(first(outs[1], outs[2]), -1, `hybrid at ${st} st: 4096 frames more silence, as before`)
  }
})

// hybrid's lag and trust are measures of the take short of its last N + 2δ + maxLag frames, where WSOLA's last grains,
// their search and the correlation read the silence after the take; what they read of the take ends δ = 512 frames,
// less the resampler's taps, before its end. So a hit in the voice's last 480 frames (a burst decaying over 10 ms, as
// at a clip's cut) moves neither: the take with it writes as without it short of the 4096 frames before the hit, which
// each engine's own look-ahead (WSOLA's grain and search, N + δ, the longest) stays within, and there the blend is in
// force, the output not phaseLock's. Measured into the ending, the hit's frames would move the lag or the trust, and
// all the blend with them
test('hybrid: its lag and trust are measures of the take short of its ending, so a hit in the take\'s last frames moves no blend before it', () => {
  let sr = sampleRate, x = lena.slice(3 * sr, Math.round(3.5 * sr)), n = x.length, D = 480, to = n - D - 4096, h = x.slice(), r = 9
  for (let i = n - D; i < n; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; h[i] += 1.5 * Math.exp(-(i - n + D) / (0.01 * sr)) * (r / 4294967296 - 0.5) }
  let first = (a, b) => { for (let i = 0; i < to; i++) if (a[i] !== b[i]) return i; return -1 }
  for (let st of [-7, 7]) {
    let opts = { semitones: st, sampleRate: sr }, y = hybrid(x, opts)
    ok(first(y, phaseLock(x, opts)) >= 0, `hybrid at ${st} st: the blend is in force over the take, the output not phaseLock's`)
    is(first(y, hybrid(h, opts)), -1, `hybrid at ${st} st: a hit in the take's last ${D} frames, as without it, over the ${to} frames before its reach`)
  }
})

// Where the take blends WSOLA in only within that ending, nothing measured trusts it, and the blend is phaseLock's alone
// (trust 0), however little evidence the rest holds: a held tone with one hit (a burst decaying over 5 ms) 2000 frames
// before its end writes phaseLock's samples; the same hit with 0.3 s more of the tone after it, out of the ending, is
// blended, so the detector finds the hit
test('hybrid: where the take\'s only evidence lies in its ending, the blend trusts none of it: phaseLock\'s samples', () => {
  let sr = sampleRate, tone = n => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / sr))
  let hit = (x, at) => { let r = 9; for (let i = at; i < x.length; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; x[i] += Math.exp(-(i - at) / (0.005 * sr)) * (r / 4294967296 - 0.5) } return x }
  let n = Math.round(0.4 * sr), at = n - 2000, short = hit(tone(n), at), long = hit(tone(n + Math.round(0.3 * sr)), at)
  let first = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1 }
  for (let st of [-12, 12]) {
    let opts = { semitones: st, sampleRate: sr }
    is(first(hybrid(short, opts), phaseLock(short, opts)), -1, `hybrid at ${st} st: the hit 2000 frames before the take's end, phaseLock's samples`)
    ok(first(hybrid(long, opts), phaseLock(long, opts)) >= 0, `hybrid at ${st} st: the same hit 0.3 s further from the end, blended`)
  }
})

// lpc on a pure tone: its fit puts a pole at the tone, of radius γ = 0.994 at the most, where 1/A(z) left as it is
// rings long; past the take's last sound its poles are drawn in, 60 Hz a frame, so the ring is 60 dB under the tone
// (1e-3 of its RMS over 64-frame windows) from the declared tail on, at every rate (the break: the filter run on past
// the take as it is)
test('lpc: a pure tone\'s ring past the take ends within its tail', () => {
  for (let sr of [22050, 44100, 96000]) for (let f of [440, 2000, 5000]) for (let st of [-24, -12, 5, 12]) {
    let params = { semitones: Float32Array.of(st) }, T = Math.ceil(pitchLpc.tail({ sampleRate: sr, params }) * sr), stop = sr >> 2, x = new Float32Array(stop + T + sr)
    for (let i = 0; i < stop; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr)
    let y = render(pitchLpc, sr, [x], params)[0], floor = 1e-3 * rms(x.subarray(0, stop)), late = 0
    for (let i = stop + T; i + 64 <= y.length; i += 64) late = Math.max(late, rms(y.subarray(i, i + 64)))
    ok(late <= floor, `lpc, ${f} Hz at ${st} st, ${sr} Hz: from ${T} frames past the take, ${late ? (20 * Math.log10(late / floor)).toFixed(1) + ' dB re 60 dB down' : 'silent'}`)
  }
})

// lpc on a pure tone, perfectly predictable: the fit's bandwidth expansion (every pole's radius times γ = 0.994) bounds
// 1/A(z) where the tone's pole would sit on the unit circle. The tones of scripts/ends.js lpc (0.5, 0.25 s, 250 Hz to
// 4 kHz, ±5 st) at three rates: over the middle half the output's peak stays within twice the input's, over the first
// 4096 frames, where the onset rings the pole, within 16 times (ends.js prints at most 1.06 and 9.82 times)
test('lpc: a pure tone renders bounded, its middle within twice the input\'s peak and its onset within 16 times', () => {
  for (let sr of [22050, 44100, 96000]) for (let f of [250, 500, 1000, 2000, 3000, 4000]) for (let st of [-5, 5]) {
    let n = Math.round(0.25 * sr), x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr)
    let y = lpc(x, { semitones: st, sampleRate: sr }), mid = peakOf(y, n >> 2, n - (n >> 2)) / 0.5, onset = peakOf(y, 0, 4096) / 0.5
    ok(mid <= 2 && onset <= 16, `lpc, ${f} Hz at ${st} st, ${sr} Hz: the middle ${mid.toFixed(2)}, the onset ${onset.toFixed(2)} times the input's peak`)
  }
})

// A channel's match raises its render by 20 dB at most. A tone moved past half the rate (scripts/ends.js match's four,
// 0.5 s at 0.5), which the shift leaves silent but for its onset's ring, asks more: each takes 20 dB and comes out under
// its input by the rest, -6.83, -7.81, -5.90 and -2.53 dB re its input over the take, within 0.1 dB (the breaks: no
// bound, or one at 30 dB, which bring each to its input's level, the ring to its energy)
test('lpc: a tone whose match asks to raise it by more than 20 dB takes 20', () => {
  let cases = [[44100, 14000, { ratio: 2 }, -6.83], [44100, 16000, { semitones: 12 }, -7.81], [22050, 8000, { semitones: 12 }, -5.90], [22050, 10000, { semitones: 5 }, -2.53]]
  for (let [sr, f, o, want] of cases) {
    let n = sr >> 1, x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr)
    let l = 20 * Math.log10(rms(lpc(x, { ...o, sampleRate: sr })) / rms(x))
    ok(Math.abs(l - want) <= 0.1, `lpc, ${f} Hz at ${o.ratio ? '×' + o.ratio : o.semitones + ' st'}, ${sr} Hz: ${l.toFixed(2)} dB re its input over the take`)
  }
})

// A stop is not an event. lpc renders a call as one take, and where it stops into exact zeros its frames have nothing
// to fit: the last fit goes on, drawn in, and the residual is silence's, as past the call's end. The voice cut loud
// (audio-lena at 4 s, 1 s), then zeros, against the same followed by 0.5 s of zeros and more of the voice, by a click
// 2000 frames on, and by TPDF dither 100 dB under the take: each writes the take, and its ring up to what follows, as
// the end does short of lpc's reach before what follows (lpcReach), up to the call's one gain: times one factor, within
// 2^-22 of the take's peak (float32's rounding of the two renders); and the take rings on past its stop.
// A take cut loud, the voice and a 220 Hz tone at 0.4 at three rates: past the stop the residual is silence's, so
// nothing steps there (the largest first difference over the 64 frames past it within twice the largest over the 1024
// before), and the ring ends on its filter's bound, in exact zeros only where it has fallen 120 dB under the take's level
// (the breaks: the residual run on past the take; its ring cut at the delay line's span)
test('lpc: a stop in the middle of a take, or a click or dither after it, renders the take and its ring as its end does short of their reach', () => {
  let sr = sampleRate, s = sr, g = Math.round(0.5 * sr), e = 4 * sr, r = 5, u = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let end = new Float32Array(2 * s + g + sr); end.set(lena.subarray(e - s, e))
  let mid = end.slice(); mid.set(lena.subarray(8 * sr, 8 * sr + s), s + g)
  let click = end.slice(); click[s + 2000] = 0.5
  let dith = end.slice(), T = rms(end.subarray(0, s))
  for (let i = s; i < dith.length; i++) dith[i] = T * 1e-5 * Math.sqrt(6) * (u() - u())
  for (let st of [-12, -5, 5, 12]) {
    let opts = { semitones: st, sampleRate: sr }, ye = lpc(end, opts), R = lpcReach(sr, st)
    for (let [what, x, at] of [['a stop in the middle of the take, 0.5 s before more voice', mid, s + g], ['a click 2000 frames after the take', click, s + 2000], ['the take into dither 100 dB under it', dith, s]]) {
      let y = lpc(x, opts), to = at - R, d = apartUpToGain(y, ye, to)
      ok(d <= 2 ** -22, `lpc at ${st} st, ${what}: the ${to} frames short of its reach (${R}) as at the call's end up to one gain (${d ? (20 * Math.log10(d)).toFixed(0) + ' dB' : 'bit for bit'})`)
    }
    ok(ye.subarray(s, s + 256).some(v => v !== 0), `lpc at ${st} st: rings on past the stop`)
  }
  let s2 = Math.round(0.5 * sr), e2 = 3 * sr
  while (rms(lena.subarray(e2 - 256, e2)) < 0.05) e2 += 97
  for (let rate of [22050, 44100, 96000]) for (let sig of ['the voice', 'a 220 Hz tone']) for (let st of [-12, -5, 5, 12]) {
    let n = Math.round(0.5 * rate), x = new Float32Array(n + rate), at = `lpc, ${sig} at ${st} st, ${rate} Hz`
    if (sig === 'the voice') x.set(rate === sr ? lena.subarray(e2 - s2, e2) : resampleTo(lena.subarray(e2 - s2, e2), n))
    else for (let i = 0; i < n; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / rate)
    let y = lpc(x, { semitones: st, sampleRate: rate }), dAt = 0, dBefore = 0, z = -1
    for (let i = n; i < n + 64; i++) dAt = Math.max(dAt, Math.abs(y[i] - y[i - 1]))
    for (let i = n - 1024; i < n; i++) dBefore = Math.max(dBefore, Math.abs(y[i] - y[i - 1]))
    for (let i = n; i + 64 <= y.length && z < 0; i++) if (y.subarray(i, i + 64).every(v => v === 0)) z = i
    ok(dAt <= 2 * dBefore, `${at}: no step past the stop (${(dAt / dBefore).toFixed(2)}× the largest difference before)`)
    ok(z < 0 || rms(y.subarray(z - 64, z)) <= 1e-6 * rms(y.subarray(0, n)), `${at}: the ring ends in exact zeros ${z < 0 ? 'nowhere in the call' : (z - n) + ' frames past the stop, ' + (20 * Math.log10(rms(y.subarray(z - 64, z)) / rms(y.subarray(0, n)))).toFixed(0) + ' dB re the take'}`)
  }
})

// The channels of a call are each a take of their own, and a channel that ends before the others is a stop: two
// channels, the voice and the voice stopped 0.2 s earlier, the right writes as it does alone up to its one gain (times
// one factor, within 2^-22 of its peak), ringing on past its stop
test('lpc: a channel that ends before the others renders as it does alone, its ring and all', () => {
  let sr = sampleRate, n = sr, e = 3 * sr
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let x = lena.slice(e - n, e), stop = n - Math.round(0.2 * sr), R = x.slice()
  R.fill(0, stop)
  for (let st of [-12, -5, 5, 12]) {
    let params = { semitones: Float32Array.of(st) }, yr = render(pitchLpc, sr, [x, R], params)[1], ya = render(pitchLpc, sr, [R], params)[0]
    let d = apartUpToGain(yr, ya)
    ok(d <= 2 ** -22, `lpc at ${st} st: the right channel, stopped 0.2 s early, as alone up to one gain (${d ? (20 * Math.log10(d)).toFixed(0) + ' dB' : 'bit for bit'})`)
    ok(yr.subarray(stop, stop + 256).some(v => v !== 0), `lpc at ${st} st: the right rings on past its stop`)
  }
})

// Each channel is matched to its own input by one gain over the whole call: lpc renders each channel as a take of its
// own, unmatched, and scales each by its own energy in over its energy out over the call's one span, the frames to the
// last sound of any channel, so the level cannot follow the sound and pump, and each channel comes out at its own
// input's level. The voice cut loud on the left; on the right the voice 40 dB down, then 0.5 s of noise in steps of
// 2^-16 of the left's peak, so the call's last sound is the right's, 0.5 s past the left's: each channel writes as it
// does alone times one factor (within 2^-22 of its peak), from a channel array, from a stream of channels in blocks of
// 1024 and from the manifest, the stream and the manifest as the array, bit for bit; and each channel's output over the
// call's span holds its own input's energy within 1e-6 (float32's rounding of its samples moves it 2^-23 at most)
// (the breaks: one gain for the call's channels; two gains a channel, its halves'; each channel's span its own)
test('lpc: each channel is matched to its own input by one gain over the whole call, every frame', () => {
  let sr = sampleRate, s = Math.round(0.5 * sr), e = 3 * sr, r = 3, B = 1024
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let L = new Float32Array(2 * s + sr), R = new Float32Array(L.length); L.set(lena.subarray(e - s, e)); R.set(lena.subarray(8 * sr, 8 * sr + s).map(v => v / 100))
  let q = 2 ** -16 * peakOf(L)
  for (let i = s; i < 2 * s; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; R[i] = (r & 1 ? 1 : -1) * q }
  let same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]), m = 2 * s
  for (let st of [-12, 5]) {
    let opts = { semitones: st, sampleRate: sr }, call = lpc([L, R], opts), write = lpc(opts), parts = []
    for (let i = 0; i < L.length; i += B) parts.push(write([L.subarray(i, i + B), R.subarray(i, i + B)]))
    parts.push(write())
    let stream = [0, 1].map(c => concat(parts.map(p => p[c]))), viaManifest = render(pitchLpc, sr, [L, R], { semitones: Float32Array.of(st) })
    for (let [c, x] of [[0, L], [1, R]]) {
      let d = apartUpToGain(call[c], lpc(x, opts))
      ok(d <= 2 ** -22, `lpc at ${st} st: channel ${c} as alone times one factor (${d ? (20 * Math.log10(d)).toFixed(0) + ' dB' : 'bit for bit'})`)
      ok(same(stream[c], call[c]) && same(viaManifest[c], call[c]), `lpc at ${st} st: channel ${c} of a stream and through the manifest as of the array`)
    }
    for (let [c, x] of [[0, L], [1, R]]) {
      let ei = 0, eo = 0
      for (let i = 0; i < m; i++) { ei += x[i] * x[i]; eo += call[c][i] * call[c][i] }
      ok(Math.abs(eo / ei - 1) <= 1e-6, `lpc at ${st} st: channel ${c}'s output over the call's span holds its input's energy (${(eo / ei - 1).toExponential(1)})`)
    }
  }
})

// Two channels holding different sounds keep their balance: each channel's gain is its own. The voice (2 s from 2 s) on
// the left and, 20 dB under it on the right, a pluck train (four Karplus-Strong plucks, 196 to 233 Hz, 0.5 s each),
// ±5 and ±12 st: each channel's level re its own input within 1e-6 dB, and so the balance within 2e-6 (float32's
// rounding of its samples moves a channel's level 5e-7 dB at most; 4.2e-8 dB measured, scripts/ends.js match) (the
// breaks: one gain for the call's channels, which brings the plucks 12.1 to 20.0 dB over their input and the voice 0.7
// to 16.7 dB under its own; the gain bounded downward too, at -20 dB, where the plucks shifted up, whose render comes
// out 28 dB over them, ask more and are let through 8.0 dB over their input)
test('lpc: two channels holding different sounds, one 20 dB under the other, keep their balance', () => {
  let sr = sampleRate, L = lena.slice(2 * sr, 4 * sr), P = new Float32Array(L.length), h = sr >> 1
  for (let k = 0; k < 4; k++) P.set(karplusStrong(196 * 2 ** (k / 12), 0.5, sr, 0.996, k + 1).subarray(0, h), k * h)
  let k = rms(L) / rms(P) / 10, R = P.map(v => v * k), db = v => 20 * Math.log10(v)
  for (let st of [-12, -5, 5, 12]) {
    let [yl, yr] = lpc([L, R], { semitones: st, sampleRate: sr }), l = db(rms(yl) / rms(L)), r = db(rms(yr) / rms(R))
    ok(Math.abs(l) <= 1e-6 && Math.abs(r) <= 1e-6 && Math.abs(l - r) <= 2e-6, `lpc at ${st} st: the voice ${l.toExponential(1)} dB, the plucks 20 dB under it ${r.toExponential(1)} dB re their input, the balance moved ${(l - r).toExponential(1)} dB`)
  }
})

// A take cut loud keeps its level whatever follows the cut. The voice cut loud (the suite's cut, 0.5 s), then 1 s of
// exact zeros, of Gaussian noise 20, 60 and 100 dB under the take's RMS, and of a 16-bit file's TPDF dither in its
// steps: at 44.1 kHz at a peak of 0 and of -40 dBFS, ±5 and ±12 st, at 96 kHz at 0 dBFS, ±12 st. The take's first 0.4 s
// within 1.5 dB of its input's level and its last 0.1 s within 3 dB (1.16 and 1.58 dB at most measured, with the take's
// one gain the call's); and into the noise 60 and 100 dB under, short of the cut's reach (lpcReach), apart from the take
// into zeros times one factor by 60 dB under its level at most, as RMS over 64 frames, the validator's line for a take's
// silence (the break: the fit window from the frame's start)
test('lpc: a take cut loud keeps its level whatever follows the cut, zeros, noise under it or a 16-bit file\'s dither', () => {
  let r = 9, u = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296, g = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u())
  for (let [rate, peaks, sts] of [[44100, [0, -40], [-12, -5, 5, 12]], [96000, [0], [-12, 12]]]) {
    let e = 3 * sampleRate
    while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
    let s = Math.round(0.5 * rate), cut = rate === sampleRate ? lena.slice(e - s, e) : resampleTo(lena.subarray(e - Math.round(0.5 * sampleRate), e), s), A = Math.round(0.4 * rate)
    for (let dBFS of peaks) {
      let t = cut.map(v => v * 10 ** (dBFS / 20) / peakOf(cut)), T = rms(t), zeros = new Float32Array(s + rate); zeros.set(t)
      let ends = [['zeros', zeros]]
      for (let L of [20, 60, 100]) { let x = zeros.slice(); for (let i = s; i < x.length; i++) x[i] = T * 10 ** (-L / 20) * g(); ends.push([`noise ${L} dB under`, x, L]) }
      { let x = zeros.slice(); for (let i = s; i < x.length; i++) x[i] = Math.round(u() - u()) / 32768; ends.push(['a 16-bit file\'s dither', x]) }
      for (let st of sts) {
        let opts = { semitones: st, sampleRate: rate }, yz = lpc(zeros, opts), R = lpcReach(rate, st)
        for (let [what, x, L] of ends) {
          let y = what === 'zeros' ? yz : lpc(x, opts), at = `lpc at ${st} st, ${rate} Hz, the take at ${dBFS} dBFS into ${what}`
          let head = 20 * Math.log10(rms(y.subarray(0, A)) / rms(x.subarray(0, A))), tail = 20 * Math.log10(rms(y.subarray(A, s)) / rms(x.subarray(A, s)))
          ok(Math.abs(head) <= 1.5 && Math.abs(tail) <= 3, `${at}: its first 0.4 s ${head.toFixed(2)} dB, its last 0.1 s ${tail.toFixed(2)} dB re its input`)
          if (!(L >= 60)) continue
          let d = 0, ab = 0, bb = 0
          for (let i = 0; i < s - R; i++) { ab += y[i] * yz[i]; bb += yz[i] * yz[i] }
          for (let i = 0, k = ab / bb; i + 64 <= s - R; i += 64) d = Math.max(d, rms(y.subarray(i, i + 64).map((v, j) => v - k * yz[i + j])))
          ok(d <= 1e-3 * T, `${at}: short of the cut's reach (${R}), ${d ? (20 * Math.log10(d / T)).toFixed(1) + ' dB' : 'nothing'} re the take apart from into zeros times one factor`)
        }
      }
    }
  }
})

// A take cut loud sounds nothing over itself before the cut: the part before a cut whitens worse than the parts before
// it, and the delay line, shifted up, reads it early through their filters. The voice cut loud (the suite's cut, 0.5 s,
// 0 dBFS) into 1 s of exact zeros, of noise 60 dB under it and of a 16-bit file's dither, at 22.05, 44.1, 48 and 96 kHz,
// ±5 and ±12 st: over the take's last 0.1 s the loudest 64 frames of the output (in steps of 32) within 3 dB of the
// input's loudest there (2.3 dB at most measured; the break, that part's scale the mean of the parts' about it: 11.2 dB
// at 96 kHz, +5 st, into zeros)
test('lpc: a take cut loud sounds nothing over itself before the cut', () => {
  let r = 5, u = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296, g = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u())
  let e = 3 * sampleRate
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  for (let rate of [22050, 44100, 48000, 96000]) {
    let s = Math.round(0.5 * rate), cut = rate === sampleRate ? lena.slice(e - s, e) : resampleTo(lena.subarray(e - Math.round(0.5 * sampleRate), e), s)
    let t = cut.map(v => v / peakOf(cut)), T = rms(t), A = s - Math.round(0.1 * rate), zeros = new Float32Array(s + rate); zeros.set(t)
    let noise = zeros.slice(), dither = zeros.slice()
    for (let i = s; i < noise.length; i++) { noise[i] = T * 1e-3 * g(); dither[i] = Math.round(u() - u()) / 32768 }
    let loud = a => { let m = 0; for (let i = A; i + 64 <= s; i += 32) m = Math.max(m, rms(a.subarray(i, i + 64))); return m }, L = loud(zeros)
    for (let [what, x] of [['zeros', zeros], ['noise 60 dB under', noise], ['a 16-bit file\'s dither', dither]]) for (let st of [-12, -5, 5, 12]) {
      let d = 20 * Math.log10(loud(lpc(x, { semitones: st, sampleRate: rate })) / L)
      ok(d <= 3, `lpc at ${st} st, ${rate} Hz, the take into ${what}: the loudest 64 frames of its last 0.1 s ${d.toFixed(1)} dB re the input's`)
    }
  }
})

// Two notes keep their own levels whatever lies between them: the voice (0.5 s at 2 s) and the voice 12 dB down (0.5 s
// at 5 s) with between them nothing, 300, 1023 and 1025 frames and 0.2 s of zeros, of a 16-bit file's dither and of noise
// 60 dB under the first note, ±5 and ±12 st: the call's one gain is the louder first note's, which comes out within 1
// dB of its input's level (0.08 dB at most measured), and the second within 4 dB past the 2560 frames over which the
// delay line plays the first late (W + L shifted down; 3.79 dB at most measured: the gain is not its own), and the
// second's level as much after a gap of 1025 frames as after one of 1023, within 0.25 dB (0.11); and a take that fades
// over its last 0.15 s into zeros within 1 dB. The notes resampled to 96 kHz at -12 st, where the second lies furthest
// from its input: the first within 1 dB (0.11), the second within 7.5 dB (7.30 at most measured, scripts/ends.js drop;
// the break, the delay line's window 2048 frames at 44.1 kHz and as long a time at 96 kHz: -8.1 dB there)
test('lpc: two notes keep their own levels whatever lies between them, and a faded take its own', () => {
  let sr = sampleRate, s = Math.round(0.5 * sr), a0 = lena.slice(2 * sr, 2 * sr + s), b0 = lena.slice(5 * sr, 5 * sr + s).map(v => v / 4), r = 11
  let u = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296, T = rms(a0)
  let fills = { zeros: () => 0, dither: () => Math.round(u() - u()) / 32768, noise: () => T * 1e-3 * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) }
  let db = v => 20 * Math.log10(v)
  for (let st of [-12, -5, 5, 12]) {
    let opts = { semitones: st, sampleRate: sr }, second = {}
    for (let [kind, fill] of Object.entries(fills)) for (let gap of [0, 300, 1023, 1025, Math.round(0.2 * sr)]) {
      if (gap === 0 && kind !== 'zeros') continue
      let x = new Float32Array(2 * s + gap + sr)
      for (let i = 0; i < x.length; i++) x[i] = fill()
      x.set(a0); x.set(b0, s + gap)
      let y = lpc(x, opts), la = db(rms(y.subarray(0, s)) / rms(a0)), lb = db(rms(y.subarray(s + gap + 2560, 2 * s + gap)) / rms(b0.subarray(2560)))
      second[kind + gap] = lb
      ok(Math.abs(la) <= 1 && Math.abs(lb) <= 4, `lpc at ${st} st, ${gap} frames of ${kind} between: the first note ${la.toFixed(2)} dB, the second ${lb.toFixed(2)} dB re its input`)
    }
    for (let kind of Object.keys(fills)) ok(Math.abs(second[kind + 1025] - second[kind + 1023]) <= 0.25, `lpc at ${st} st, ${kind} between: the second note ${(second[kind + 1025] - second[kind + 1023]).toFixed(2)} dB after a gap of 1025 frames re 1023`)
    let e = 3 * sr
    while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
    let f = new Float32Array(s + sr), d0 = s - Math.round(0.15 * sr)
    for (let i = 0; i < s; i++) f[i] = lena[e - s + i] * (i < d0 ? 1 : Math.exp(-(i - d0) / (0.025 * sr)))
    let lf = db(rms(lpc(f, opts).subarray(0, s)) / rms(f.subarray(0, s)))
    ok(Math.abs(lf) <= 1, `lpc at ${st} st: a take faded into zeros ${lf.toFixed(2)} dB re its input`)
  }
  let S =Math.round(0.5 * 96000), a1 = resampleTo(a0, S), b1 = resampleTo(b0, S), T1 = rms(a1), opts = { semitones: -12, sampleRate: 96000 }
  for (let [kind, fill] of Object.entries({ ...fills, noise: () => T1 * 1e-3 * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) })) for (let gap of [0, 300, 1023, 1025, Math.round(0.2 * 96000)]) {
    if (gap === 0 && kind !== 'zeros') continue
    let x = new Float32Array(2 * S + gap + 96000)
    for (let i = 0; i < x.length; i++) x[i] = fill()
    x.set(a1); x.set(b1, S + gap)
    let y = lpc(x, opts), la = db(rms(y.subarray(0, S)) / rms(a1)), lb = db(rms(y.subarray(S + gap + 2560, 2 * S + gap)) / rms(b1.subarray(2560)))
    ok(Math.abs(la) <= 1 && Math.abs(lb) <= 7.5, `lpc at -12 st, 96 kHz, ${gap} frames of ${kind} between: the first note ${la.toFixed(2)} dB, the second ${lb.toFixed(2)} dB re its input`)
  }
})

// A level hovering low is one sound at its own level: a 220 Hz tone whose amplitude swings from 2.0e-5 to 4.5e-5 at 4
// Hz (2 s), ±5 st: its level within 1 dB of its input's, which the call's one gain holds whatever the render, and its
// quietest 20 ms over 0.25 to 1.75 s within 1 dB of the input's quietest there (0.29 dB at most measured; the break, a
// level of one 16-bit step under which sound is silence, which parts it into sounds and silences it there). After a
// loud voice it takes the call's one gain, the voice's (scripts/ends.js drop)
test('lpc: a level hovering low is one sound at its own level', () => {
  let sr = sampleRate, n = 2 * sr, x = new Float32Array(n), w = Math.round(0.02 * sr)
  for (let i = 0; i < n; i++) x[i] = (3.25e-5 + 1.25e-5 * Math.sin(2 * Math.PI * 4 * i / sr)) * Math.sin(2 * Math.PI * 220 * i / sr)
  let low = a => { let m = Infinity; for (let t = Math.round(0.25 * sr); t + w <= Math.round(1.75 * sr); t += w >> 1) m = Math.min(m, rms(a.subarray(t, t + w))); return m }
  for (let st of [-5, 5]) {
    let y = lpc(x, { semitones: st, sampleRate: sr }), l = 20 * Math.log10(rms(y) / rms(x)), q = 20 * Math.log10(low(y) / low(x))
    ok(Math.abs(l) <= 1 && Math.abs(q) <= 1, `lpc at ${st} st, the hovering tone: ${l.toFixed(2)} dB re its input, its quietest 20 ms ${q.toFixed(2)} dB re the input's`)
  }
})

// Every level lpc compares is the call's own: a ratio of two (a fit's energies, a frame's residuals, the gains of two
// filters, input to output), none a constant. So a call times a power of two, exact in floats, renders as its render
// times that factor. The voice cut loud, 0.3 s of exact zeros, more of it, then a reverb's tail (noise from 40 dB under
// it, falling 60 dB a second); alone and in two channels, the right another cut 30 dB down that stops early; times
// 2^-20, 2^-10 and 2^4; at -12 and +5 st and on a glide. Bit for bit at every sample over 2^-100 at the smaller of the
// two scales (602 dB under full scale): float32 is subnormal under 2^-126, where a ring's far tail rounds otherwise, and
// the rounding reaches through the filter to 2^-118.7 at most (scripts/ends.js scale; the break: a level compared with
// a constant)
test('lpc: a call times a power of two renders as its render times that factor', () => {
  let sr = sampleRate, s = Math.round(0.5 * sr), g = Math.round(0.3 * sr), e = 3 * sr, r = 7
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let voice = off => {
    let x = new Float32Array(2 * s + g + 2 * sr), b = lena.subarray((8 + off) * sr, (8 + off) * sr + s), lv = 0.01 * rms(b)
    x.set(lena.subarray(e + off * sr - s, e + off * sr)); x.set(b, s + g)
    for (let i = 0; i < sr; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; x[2 * s + g + i] = lv * 10 ** (-3 * i / sr) * 3.4 * (r / 4294967296 - 0.5) }
    return x
  }
  let x = voice(0), right = voice(1).map(v => v * 0.0316); right.fill(0, Math.round(0.6 * right.length))
  let times = (c, f) => c.map(v => v * f), MIN = 2 ** -100
  for (let [layout, X] of [['alone', x], ['in two channels', [x, right]]]) for (let ratio of [-12, 5, 'a glide']) {
    let opts = ratio === 'a glide' ? { ratio: t => 0.8 + 0.5 * t, sampleRate: sr } : { semitones: ratio, sampleRate: sr }
    let y = [lpc(X, opts)].flat()
    for (let k of [-20, -10, 4]) {
      let f = 2 ** k, yk = [lpc(Array.isArray(X) ? X.map(c => times(c, f)) : times(X, f), opts)].flat(), bad = 0, top = 0
      y.forEach((c, j) => c.forEach((v, i) => { let w = yk[j][i] / f; if (v !== w && Math.min(Math.abs(v), Math.abs(w)) * Math.min(1, f) >= MIN) bad++; if (v !== w) top = Math.max(top, Math.abs(v)) }))
      is(bad, 0, `lpc ${layout} at ${ratio}${typeof ratio === 'number' ? ' st' : ''}, times 2^${k}: bit for bit over 2^-100 (where it differs, at most ${top ? (20 * Math.log10(top)).toFixed(0) + ' dBFS' : 'nowhere'})`)
    }
  }
})

// A gliding ratio is the call's, read at each moment's own time, a pause in the call or not. Two vowels (the vowel
// fixture, f0 155 Hz, 0.5 s) 0.5 s apart, a glide 0.8 + 0.5t, at three rates: over each vowel's middle 0.2 s the output's
// f0 within 0.3 % of 155 Hz times the glide at its centre (0.16 % at most measured; the break, the glide read from each
// sound's start: 35 % under over the second)
test('lpc: a gliding ratio across a pause is read at each sound\'s own time', () => {
  for (let sr of [22050, 44100, 96000]) {
    let s = Math.round(0.5 * sr), v = vowel(155, [{ freq: 700, bw: 110 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 160 }], 0.5, sr), x = new Float32Array(3 * s + sr)
    x.set(v); x.set(v, 2 * s)
    let glide = t => 0.8 + 0.5 * t, y = lpc(x, { ratio: glide, sampleRate: sr })
    for (let at of [0, 2 * s]) {
      let f = estimateF0(y.subarray(at + Math.round(0.15 * sr), at + Math.round(0.35 * sr)), sr, 50, 800), want = 155 * glide((at + Math.round(0.25 * sr)) / sr)
      ok(Math.abs(f / want - 1) <= 0.003, `lpc, ${sr} Hz: the vowel at ${(at / sr).toFixed(1)} s at ${f.toFixed(1)} Hz, the glide's ${want.toFixed(1)} Hz (${(100 * Math.abs(f / want - 1)).toFixed(2)} % apart)`)
    }
  }
})

// A sound after silence comes through the delay line that has run through the silence, at the line's lag and crossfade,
// as in the middle of a take: no step. The voice cut loud, 0.3 s of zeros, more of it, at three rates: the largest
// first difference over the second sound's first 256 frames within twice the largest over the 1024 after them (the
// break: the delay line started at the sound, where its taps start on it at full weight)
test('lpc: a sound after silence starts on the delay line run through that silence, its onset with no step', () => {
  let sr = sampleRate, s = Math.round(0.5 * sr), e = 3 * sr
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let step = (y, a, b) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(y[i] - y[i - 1])); return m }
  for (let rate of [22050, 44100, 96000]) for (let st of [-12, -5, 5, 12]) {
    let n = Math.round(0.5 * rate), at = n + Math.round(0.3 * rate), x = new Float32Array(2 * n + Math.round(0.3 * rate) + rate)
    let cut = c => rate === sr ? c : resampleTo(c, n)
    x.set(cut(lena.subarray(e - s, e))); x.set(cut(lena.subarray(8 * sr, 8 * sr + s)), at)
    let y = lpc(x, { semitones: st, sampleRate: rate }), d0 = step(y, at, at + 256), d1 = step(y, at + 256, at + 1280)
    ok(d0 <= 2 * d1, `lpc at ${st} st, ${rate} Hz: the second sound's first 256 frames ${d0 ? 'step ' + (20 * Math.log10(d0 / d1)).toFixed(1) + ' dB re the 1024 after them' : 'silent'}`)
  }
})

// A steady vowel keeps nothing between its harmonics: its level is matched by one gain a call, which cannot modulate
// them. The steady vowel fixture (f0 155 Hz, 1 s) at -5 st, over the output's middle 2^15 frames (Hann): the energy more
// than 8 Hz from every harmonic of the shifted f0 between 50 Hz and 5 kHz stays 45 dB under the energy on them
// (-48.2 dB measured, scripts/ends.js match; the break, each channel's gain its own over every 4096 frames, -44.2 dB)
test('lpc: a steady vowel keeps nothing between its harmonics', () => {
  let sr = sampleRate, f0 = 155 * 2 ** (-5 / 12), x = vowel(155, [{ freq: 700, bw: 110 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 160 }], 1, sr)
  let y = lpc(x, { semitones: -5, sampleRate: sr }), N = 1 << 15, a = (y.length - N) >> 1, w = new Float64Array(N)
  for (let i = 0; i < N; i++) w[i] = y[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
  let [re, im] = fft(w), on = 0, off = 0
  for (let k = 1; k < re.length; k++) {
    let hz = k * sr / N
    if (hz < 50 || hz > 5000) continue
    let h = Math.round(hz / f0), e = re[k] * re[k] + im[k] * im[k]
    if (h >= 1 && Math.abs(hz - h * f0) <= 8) on += e; else off += e
  }
  let d = 10 * Math.log10(off / on)
  ok(d <= -45, `lpc at -5 st: the energy between the vowel's harmonics ${d.toFixed(1)} dB re on them`)
})

// A long call keeps its level: the residual's scale is the filters' gain under its peak where the frame stands, so it
// lies between their least gain and their peak however many falls the call holds. The voice cut loud (the suite's cut,
// 0.5 s) and 0.3 s of white noise 60 dB under it (seeded), written 26 times over (21 s), +5 and +12 st: each copy's
// level re its input within 1 dB of the first copy's, the one that starts the call with nothing before it (0.60 dB at
// most measured, Node 20 to 25; the breaks: the scale a running product of the falls across cleared memories, which the
// fall at each copy's end takes into subnormals and then zeros, silences the last copies; the last part before a cut
// without its own gain, 1.06 dB at +5 st)
test('lpc: a long call keeps its level, a phrase cut loud written over and over with room noise between', () => {
  let sr = sampleRate, s = Math.round(0.5 * sr), gap = Math.round(0.3 * sr), e = 3 * sr, r = 5, COPIES = 26
  let u = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let take = lena.subarray(e - s, e), T = rms(take), x = new Float32Array(COPIES * (s + gap))
  for (let i = 0; i < x.length; i++) x[i] = T * 1e-3 * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u())
  for (let j = 0; j < COPIES; j++) x.set(take, j * (s + gap))
  for (let st of [5, 12]) {
    let y = lpc(x, { semitones: st, sampleRate: sr }), level = j => 20 * Math.log10(rms(y.subarray(j * (s + gap), j * (s + gap) + s)) / T), first = level(0), worst = 0, at = 0
    for (let j = 1; j < COPIES; j++) { let d = Math.abs(level(j) - first); if (!(d <= worst)) { worst = d; at = j } }
    ok(worst <= 1, `lpc at +${st} st: of ${COPIES} copies, copy ${at + 1} the furthest from the first, ${worst.toFixed(2)} dB`)
  }
})

// A held note clears no memory inside it: a clearing is a drop only where it saves at least the share of the frame's
// residual that the p samples it changes hold, so where the note crosses zero at a frame's last samples it does not
// clear, and nothing clicks there. A reed-like note (196 Hz, odd harmonics at 0.3/k to 5 kHz) from the call's first
// frame for 2 s, then 0.5 s of zeros, steep at both edges, at 44.1 and 96 kHz, ±5 and ±12 st: over its middle (0.1 to
// 1.9 s) the second difference's RMS over 2 ms at its loudest within 10 dB of its median there, and the energy more
// than 8 Hz from every harmonic of the shifted f0 (50 Hz to 5 kHz, 2^k frames about 1 s) 30 dB under that on them (6.3
// and -33.0 dB at most measured; the break, a clearing that gains anything: 18.5 dB at 44.1 kHz, -12 st)
test('lpc: a held note with steep edges clears no memory inside it, and nothing clicks there', () => {
  for (let sr of [44100, 96000]) for (let st of [-12, -5, 5, 12]) {
    let n = 2 * sr, x = new Float32Array(n + (sr >> 1)), ph = 0, f0 = 196 * 2 ** (st / 12)
    for (let i = 0; i < n; i++) { ph += 2 * Math.PI * 196 / sr; for (let k = 1; k * 196 < 5000; k += 2) x[i] += 0.3 / k * Math.sin(k * ph) }
    let y = lpc(x, { semitones: st, sampleRate: sr }), w = Math.round(0.002 * sr), c = []
    for (let t = Math.round(0.1 * sr); t + w <= Math.round(1.9 * sr); t += w >> 1) { let q = 0; for (let i = t; i < t + w; i++) q += (y[i] - 2 * y[i - 1] + y[i - 2]) ** 2; c.push(Math.sqrt(q / w)) }
    let top = Math.max(...c); c.sort((a, b) => a - b)
    let click = 20 * Math.log10(top / c[c.length >> 1]), N = 1 << Math.round(Math.log2(0.74 * sr)), a = sr - (N >> 1), win = new Float64Array(N), on = 0, off = 0
    for (let i = 0; i < N; i++) win[i] = y[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
    let [re, im] = fft(win)
    for (let k = 1; k < re.length; k++) { let hz = k * sr / N; if (hz < 50 || hz > 5000) continue; let h = Math.round(hz / f0), e = re[k] * re[k] + im[k] * im[k]; if (h >= 1 && Math.abs(hz - h * f0) <= 8) on += e; else off += e }
    let between = 10 * Math.log10(off / on)
    ok(click <= 10 && between <= -30, `lpc at ${st} st, ${sr} Hz: the loudest 2 ms of the second difference ${click.toFixed(1)} dB over its median, the energy between the harmonics ${between.toFixed(1)} dB re on them`)
  }
})


// hpss's time median spans 8 frames of 512 either side of a 2048-frame frame; past the call's frames it counts frames of
// silence of its own, so the call's end renders as a stop followed by silence. The voice cut loud, then zeros, against
// the same followed by 0.3 s of zeros and more of the voice: bit for bit short of the 8192 frames before the next sound
// (the median's reach and a frame), the take and its ring past the stop alike
test('hpss: the end of a take renders as a stop in the middle of one', () => {
  let sr = sampleRate, s = Math.round(0.5 * sr), g = Math.round(0.3 * sr), e = 3 * sr
  while (rms(lena.subarray(e - 256, e)) < 0.05) e += 97
  let end = new Float32Array(2 * s + g + sr); end.set(lena.subarray(e - s, e))
  let mid = end.slice(); mid.set(lena.subarray(8 * sr, 8 * sr + s), s + g)
  for (let st of [-12, -5, 5, 12]) {
    let opts = { semitones: st, sampleRate: sr }, ye = hpss(end, opts), ym = hpss(mid, opts), to = s + g - 8192, at = -1
    for (let i = 0; i < to; i++) if (ye[i] !== ym[i]) { at = i; break }
    is(at, -1, `hpss at ${st} st: a stop in the middle of the take writes the take and the ${to - s} frames past it as its end does`)
  }
})

// CONTRACT 1.0, tail, for the twelve whole-signal methods: a host renders the tail by ending the input with that much
// silence and calling once, as here. Past the tail (or 128 frames, the ring the contract lets pass without one) every
// 64-frame window is 60 dB under the input's level, 10^(-60/20) = 1e-3 of it as RMS: a noise burst's, an impulse's
// over its one window, a held tone's. A tail over 128 frames is earned: some take still sounds past half
// of it; a method that rings 128 frames or less declares none. sample, shifted down, plays the take slowed: what sounds
// past its end grows with the take, so no setting bounds it (Infinity). Every method at 22.05, 44.1 and 96 kHz, a tail
// being frames over the rate, whichever a kernel's frames are in; and the umbrella's four STFT methods, whose tails it
// writes out itself, once
test('whole-signal methods: 60 dB down past the tail, the tail within twice the longest ring, none where nothing rings past 128 frames', () => {
  let W = 64
  // a tail as a host reads it: a number of seconds, or a function of the setting (contract 1.0, Latency, tail)
  let tailOf = (atom, params, sr) => typeof atom.tail === 'function' ? atom.tail({ sampleRate: sr, params }) : atom.tail ?? 0
  let level = (x, n) => { let s = 0; for (let i = 0; i < n; i++) s += x[i] * x[i]; return Math.sqrt(s / n) }
  let noise = (n, stop) => { let x = new Float32Array(n), r = 7; for (let i = 0; i < stop; i++) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; x[i] = 0.3 * (r / 4294967296 - 0.5) } return x }
  // the takes: a burst cut at five places (two for the STFT methods) and an impulse at the take's end at the same places
  // (where a grain, a frame or a tap's sweep stands as the input stops), a 440 Hz tone held to its end; for lpc the tone
  // at the same places too, its ring on a tone, the fit's pole, 512 to 832 frames at +12 st and 96 kHz as its stop falls
  // on its frames
  let tone = (T, sr, off) => { let stop = Math.round(0.25 * sr) + off, n = stop + Math.max(Math.round(0.3 * sr), 2 * Math.ceil(T)), x = new Float32Array(n); for (let i = 0; i < stop; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr); return { x, stop, lvl: null } }
  let takes = (T, sr, offs, tones) => offs.flatMap(off => {
    let stop = Math.round(0.25 * sr) + off, n = stop + Math.max(Math.round(0.3 * sr), 2 * Math.ceil(T)), imp = new Float32Array(n)
    imp[stop - 1] = 1
    return [{ x: noise(n, stop), stop, lvl: null }, { x: imp, stop, lvl: 1 / Math.sqrt(W) }]
  }).concat(tones.map(off => tone(T, sr, off)))
  // the frames from the stop to the end of the last 64-frame window (aligned at it) above 1e-3 of the level, and whether
  // a window from stop + max(128, T) on is above it
  let ring = (y, stop, floor, T) => {
    let last = 0, late = false, rmsAt = i => { let s = 0; for (let j = i; j < i + W; j++) s += y[j] * y[j]; return Math.sqrt(s / W) }
    for (let i = stop; i + W <= y.length; i += W) if (rmsAt(i) > floor) last = i + W - stop
    for (let i = stop + Math.max(128, Math.ceil(T)); i + W <= y.length; i += W) late ||= rmsAt(i) > floor
    return { last, late }
  }
  let all = [0, 137, 341, 682, 1200], two = [0, 682]
  let methods = [['ola', pitchOla], ['wsola', pitchWsola], ['psola', pitchPsola], ['granular', pitchGranular], ['delay', pitchDelay], ['lpc', pitchLpc],
    ['hybrid', pitchHybrid], ['transient', pitchTransient], ['sms', pitchSms], ['hpss', pitchHpss], ['sample', pitchSample],
    ['pitchShift auto', pitchShiftAtom, { method: 'auto', content: 'any', formant: false }], ['pitchShift voice', pitchShiftAtom, { method: 'auto', content: 'voice', formant: false }],
    ...['vocoder', 'phase-lock', 'formant', 'paulstretch'].map(method => [`pitchShift ${method}`, pitchShiftAtom, { method, content: 'any', formant: false }, [sampleRate], two, [-12]])]
  for (let [name, atom, more = {}, rates = [22050, sampleRate, 96000], offs = all, sts = [-24, 12]] of methods) for (let sr of rates) for (let st of sts) {
    let params = { semitones: Float32Array.of(st), ...more }, T = tailOf(atom, params, sr) * sr, at = `${name} at ${st} st, ${sr} Hz`
    if (name === 'sample') { is(tailOf(atom, params, sr), st < 0 ? Infinity : 0, `${at}: tail ${st < 0 ? 'Infinity' : 0}`); if (st < 0) continue }
    ok(T >= 0, `${at}: tail ${T} frames`)
    let longest = 0
    for (let { x, stop, lvl } of takes(T, sr, offs, name === 'lpc' ? offs : [0])) {
      let y = new Float32Array(x.length)
      atom({ sampleRate: sr, maxBlockSize: x.length, maxChannels: 1, params })([[x]], [[y]], params)
      let r = ring(y, stop, 1e-3 * (lvl ?? level(x, stop)), T)
      ok(!r.late, `${at}: 60 dB down from ${Math.max(128, Math.ceil(T))} frames past the input (rang ${r.last})`)
      longest = Math.max(longest, r.last)
    }
    if (T > 128) ok(longest * 2 >= T, `${at}: tail ${T.toFixed(0)} frames, within twice the longest ring, ${longest}`)
    else ok(T === 0 && longest <= 128, `${at}: rings ${longest} frames, no tail`)
  }
  // sample shifted down: past the input's end sounds the take itself at the ratio, (1/ratio - 1) frames for each frame of
  // take before the end (a tenth of a second of take more rings 1/ratio - 1 tenths more): no tail of the setting covers it
  let sr = sampleRate, r = 2 ** (-12 / 12), params = { semitones: Float32Array.of(-12) }, rang = []
  for (let take of [0.1, 0.2]) {
    let stop = Math.round(take * sr), x = noise(stop + Math.ceil(stop / r), stop), y = new Float32Array(x.length)
    pitchSample({ sampleRate: sr, maxBlockSize: x.length, maxChannels: 1, params })([[x]], [[y]], params)
    rang.push(ring(y, stop, 1e-3 * level(x, stop), 0).last)
  }
  let more = Math.round(0.1 * sr) * (1 / r - 1)
  ok(rang[1] - rang[0] >= more - W, `sample at -12 st: a take 0.1 s longer rings ${rang[1] - rang[0]} frames longer, (1/ratio - 1)·0.1 s = ${more}`)
})

// The family's manifests: audio.js names every member that has a manifest (a package of packages/ the umbrella depends
// on, with an audio.js), and no other; each name a member's manifest exports is the entry's, the same binding
test('audio.js lists every member that has a manifest', async () => {
	const { readdirSync, existsSync, readFileSync } = await import('node:fs')
	const at = p => new URL(p, import.meta.url), { dependencies } = JSON.parse(readFileSync(at('package.json'), 'utf8'))
	const members = readdirSync(at('packages')).filter(d => existsSync(at(`packages/${d}/audio.js`)))
		.map(d => JSON.parse(readFileSync(at(`packages/${d}/package.json`), 'utf8')).name).filter(n => n in dependencies).sort()
	const listed = [...readFileSync(at('audio.js'), 'utf8').matchAll(/^export \* from '(@audio\/[^']+)\/audio'$/gm)].map(m => m[1]).sort()
	is(listed, members, 'one line per member, no other')
	const family = await import(at('audio.js')), missing = []
	for (const m of members) for (const [k, v] of Object.entries(await import(`${m}/audio`))) if (k !== 'default' && family[k] !== v) missing.push(`${m}: ${k}`)
	is(missing, [], 'every name a member\'s manifest exports, the same binding')
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
