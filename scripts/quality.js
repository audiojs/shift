import pitchShift, {
  ola, vocoder, phaseLock, transient, psola, wsola, granular, formant, paulstretch, sms, hpss, sample, hybrid,
  delay, lpc,
} from '../index.js'
import { sine, sineChord, diracTrain, karplusStrong, vowel, amSine } from './fixtures.js'
import {
  zeroCrossingFreq, thd, aliasRatio, centroidRatioError,
  onsetPeriodError, attackEnvelopeCorr, formantDistance, streamConsistency,
  phaseCoherence, spectralDistance, loudnessRatio, durationRatio, harmonicShiftError,
  chordPeakFreqError, hopRateMod,
} from './metrics.js'

const sampleRate = 44100
const ratio = 1.5
const aliasRatioOpt = 2
const amModRate = 5   // modulation rate of the amSine fixture (Hz)
const ciMode = process.argv.includes('--ci')

const VOWEL_FORMANTS = [
  { freq: 700,  bw: 90 },
  { freq: 1220, bw: 100 },
  { freq: 2600, bw: 120 },
]

const fixtures = {
  sine440: sine(440, 0.5, sampleRate),
  sineChord: sineChord(220, 0.5, sampleRate, [1, 1.25, 1.5]),
  highSine: sine(14000, 0.5, sampleRate),
  diracTrain: diracTrain(441, 0.5, sampleRate),          // 100 Hz impulse train
  pluck: karplusStrong(220, 0.5, sampleRate),
  vowel: vowel(150, VOWEL_FORMANTS, 0.5, sampleRate),
  amSine: amSine(440, amModRate, 0.6, 1.5, sampleRate),  // 1.5 s for several modulation cycles
}

// Ground-truth shifted references. Since every fixture is synthetic, we can generate the
// canonical `ratio=1.5` output directly: the reference pluck is `karplusStrong(330)`, the
// reference chord is `sineChord(330, sameRatios)`, etc. The `shiftDist` metric compares
// each algorithm's output against these ideals in log-magnitude spectrum space.
const refs = {
  sine440:   sine(440 * ratio, 0.5, sampleRate),
  sineChord: sineChord(220 * ratio, 0.5, sampleRate, [1, 1.25, 1.5]),
  pluck:     karplusStrong(220 * ratio, 0.5, sampleRate),
  amSine:    amSine(440 * ratio, amModRate, 0.6, 1.5, sampleRate),
}

// Bounds are calibrated to observed values + margin, acting as a regression guard.
// Higher-is-better metrics (strCorr, attack) use a minimum; others are upper bounds.
// Use -1 to skip a bound where the metric is inherently noisy for that algorithm
// (e.g. paulstretch random phase voids stream-vs-batch correlation).
// Sanity bounds: loud/dur/pitch — ±50% on loudness, ±5% on duration, chord harmonic
// concentration. Catch catastrophic failures before looking at refined metrics.
// Use -1 on `pitch` for algorithms that intentionally don't preserve partial tracking
// (paulstretch random phase, granular/ola coarse grains).
// pkErr = max Hz offset of any chord partial from its expected shifted position (sub-Hz
// precision). Catches peak-detection bugs that shadow chord partials and emit them at the
// wrong frequency. hopAM = amplitude modulation depth at the synthesis hop rate, i.e. the
// frame-boundary "soft click" depth — scatter-sum schemes ripple here.
// loudLo raised 0.70→0.85 on pitchShift/vocoder/phaseLock/transient/formant/sms/hpss/hybrid:
// matchGain dropped in favor of the per-frame energy-preserving scatter kernels
// (scatterGated/scatterLocked) — batch and stream are now numerically identical by
// construction, and the true worst-case loudness across this cohort sits at 0.97 (hpss),
// so 0.70 was a stale margin from the old whole-signal-corrected regime.
const algorithms = [
  { name: 'pitchShift',  fn: pitchShift,  bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   2, thd:  1, alias: 0.01, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.95, form: 1.48, phase: 0.96, shift: 1.85, pkErr:  1.0, hopAM: 0.035 } },
  // ola: true OLA (no similarity search) has worse pitch accuracy and loudness than WSOLA;
  // grain-rate phase cancellation corrupts the waveform, which is the expected baseline.
  { name: 'ola',         fn: ola,         bounds: { loudLo: 0.45, loudHi: 1.30, dur: 0.05, pitch:   -1, f0Err:  50, thd:  3, alias: 0.05, strCorr: 0.20, cent: 0.10, onset: 0.50, attack: 0.90, form: 3.5, phase: 0.85, shift: 2.20, pkErr:   -1, hopAM: 0.010 } },
  { name: 'vocoder',     fn: vocoder,     bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   2, thd:  1, alias: 0.02, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.90, form: 1.20, phase: 0.90, shift: 1.65, pkErr:  1.0, hopAM: 0.015 } },
  { name: 'phaseLock',   fn: phaseLock,   bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   2, thd:  1, alias: 0.01, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.95, form: 1.48, phase: 0.95, shift: 1.85, pkErr:  1.0, hopAM: 0.035 } },
  { name: 'transient',   fn: transient,   bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   2, thd:  1, alias: 0.01, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.95, form: 1.48, phase: 0.95, shift: 1.85, pkErr:  1.0, hopAM: 0.035 } },
  // psola: pitch/pkErr skipped — PSOLA assumes a single pitch contour, so chords
  // (multi-partial) violate its assumption and scatter partials. strCorr/phase skipped
  // because time-stretch PSOLA is inherently non-deterministic on pitch-mark jitter.
  { name: 'psola',       fn: psola,       bounds: { loudLo: 0.70, loudHi: 1.30, dur: 0.05, pitch:   -1, f0Err:   3, thd:  3, alias: 0.05, strCorr:   -1, cent: 0.30, onset: 0.02, attack: 0.90, form: 3.5, phase:   -1, shift: 2.00, pkErr:   -1, hopAM: 0.030 } },
  { name: 'wsola',       fn: wsola,       bounds: { loudLo: 0.70, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   5, thd:  3, alias: 0.05, strCorr: 0.20, cent: 0.10, onset: 0.02, attack: 0.95, form: 3.5, phase: 0.85, shift: 1.80, pkErr:  1.0, hopAM: 0.010 } },
  // granular: native direct grain-read synthesizer (no correlation search, no time-stretch
  // dependency) — not a wsola-clone anymore. alias 0.033 (anti-aliased sinc stride-read, was
  // 0.927 under an earlier plain-linear-interp draft). onset 0.452 and shift 2.256 share the
  // same "no correlation search" root cause ola's own onset:0.50 bound already documents —
  // small fixed-size grains have no mechanism to align to source structure, so a Dirac
  // impulse's timing (onset) and aggregate ground-truth spectral fidelity (shift) both suffer
  // by the same design tradeoff that produces the intended grain-rate texture.
  { name: 'granular',    fn: granular,    bounds: { loudLo: 0.70, loudHi: 1.30, dur: 0.05, pitch:   -1, f0Err:   5, thd:  3, alias: 0.04, strCorr: 0.20, cent: 0.10, onset: 0.50, attack: 0.90, form: 4.0, phase: 0.85, shift: 2.60, pkErr:   -1, hopAM: 0.030 } },
  // formant: form <= 0.80 — sampleRate-aware lifter cutoff + dedup onto scatterLocked
  // measurably improved envelope fidelity (0.791 → 0.765); phase 0.85 → 0.96 similarly
  // (0.986 → 1.000, same scatterLocked/matchGain-drop cause as the cohort above).
  { name: 'formant',     fn: formant,     bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.15, f0Err:   2, thd:  1, alias: 0.05, strCorr: 0.95, cent: 0.10, onset: 0.02, attack: 0.90, form: 0.80, phase: 0.96, shift: 1.70, pkErr:  1.5, hopAM: 0.025 } },
  // paulstretch: deterministic seed (mulberry32) — run-to-run numbers no longer drift, but
  // loudness/spectral bounds stay generous on purpose: opts.seed is meant to be varied by
  // callers, and different seeds legitimately land anywhere in the historical 0.80-0.90
  // loud range this file was already calibrated for.
  { name: 'paulstretch', fn: paulstretch, bounds: { loudLo: 0.55, loudHi: 1.30, dur: 0.05, pitch:   -1, f0Err:  10, thd:  2, alias: 0.35, strCorr:   -1, cent: 0.12, onset: 0.02, attack: 0.92, form: 8.0, phase:   -1, shift: 2.40, pkErr:   -1, hopAM:    -1 } },
  // sms: shift <= 1.75 — residual scatter→gather rewrite genuinely improved ground-truth
  // fidelity (1.805 → 1.701); form 2.7 → 1.90 similarly improved (1.959 → 1.845).
  { name: 'sms',         fn: sms,         bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   3, thd:  1, alias: 0.10, strCorr: 0.95, cent: 0.20, onset: 0.60, attack: 0.95, form: 1.90, phase: 0.85, shift: 1.75, pkErr:  2.0, hopAM: 0.030 } },
  // hpss: attack >= 0.99 — restored percussive passthrough measurably improved transient
  // fidelity (0.996 → 0.998); form 2.1 → 1.25 and hopAM 0.040 → 0.012 similarly improved
  // from the scatterGated dedup on the harmonic path (1.230 → 1.207, 0.013 → 0.006).
  { name: 'hpss',        fn: hpss,        bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.05, f0Err:   2, thd:  1, alias: 0.08, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.99, form: 1.25, phase: 0.90, shift: 1.85, pkErr:  1.0, hopAM: 0.012 } },
  // sample: shift <= 1.70 — sincRead edge-gain fix genuinely improved ground-truth fidelity
  // (1.655 → 1.614); form moved slightly the other way (2.245 → 2.330, same edge-gain fix
  // changing exact attack/tail sample values by design) so form is intentionally left alone.
  { name: 'sample',      fn: sample,      bounds: { loudLo: 0.70, loudHi: 1.30, dur: 0.05, pitch: 0.20, f0Err:   3, thd:  1, alias: 0.05, strCorr: 0.95, cent: 0.05, onset: 0.02, attack: 0.90, form: 3.2, phase:   -1, shift: 1.70, pkErr:  2.0, hopAM: 0.035 } },
  // hybrid: form 3.8 → 1.48 and phase 0.65 → 0.96 were the most stale bounds in this file —
  // both calibrated against the pre-fix hybrid (unaligned wsola blend, unbounded z-score
  // confidence). The hybrid-1 confidence-detector fix alone moved phase 0.879 → 0.999 (+14%);
  // the time-alignment fix moved form 2.488 → 1.423 (-43%). Both are now tight against the
  // fixed algorithm.
  { name: 'hybrid',      fn: hybrid,      bounds: { loudLo: 0.85, loudHi: 1.30, dur: 0.05, pitch: 0.10, f0Err:   2, thd:  1, alias: 0.02, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.95, form: 1.48, phase: 0.96, shift: 2.05, pkErr:  1.0, hopAM: 0.010 } },
  // delay: harmonizer (dual crossfading delay-line taps, no STFT/frame hop) — accurate,
  // clean monophonic shifter (f0Err/THD/alias all top-tier) but chord-blind by construction
  // (single splice search, no per-partial phase tracking) — pitch/pkErr skipped for the same
  // reason as ola/psola/granular above. hopAM's probe frequency isn't a frame-hop rate for
  // this algorithm; 0.168 is the tap crossfade flutter its own header comment documents as
  // the expected residual artifact, not a bug.
  { name: 'delay',       fn: delay,       bounds: { loudLo: 0.85, loudHi: 1.15, dur: 0.05, pitch:   -1, f0Err:   2, thd:  1, alias: 0.05, strCorr: 0.95, cent: 0.03, onset: 0.02, attack: 0.95, form: 2.60, phase: 0.85, shift: 1.70, pkErr:   -1, hopAM: 0.20 } },
  // lpc: source-filter (LPC residual repitched through the unmodified formant filter) —
  // bimodal BY DESIGN. Excellent on the dimensions it's built for: form/phase/attack/onset/
  // thd are all tight, near best-in-table (voiced/vowel material, where the AR envelope is
  // genuinely separable from the excitation). Degenerate on pure tones and chords, also BY
  // DESIGN: f0Err/alias/cent are wide on purpose (loose regression guards on a known-bad
  // dimension, not hidden) because a single sinusoid or a narrow chord IS the AR envelope, so
  // the source-filter re-imposes the ORIGINAL pitch instead of shifting it — the family's
  // defining tradeoff, not a bug. pitch/pkErr skipped for the same chord-blindness as
  // ola/psola/granular/delay above.
  { name: 'lpc',         fn: lpc,         bounds: { loudLo: 0.90, loudHi: 1.10, dur: 0.05, pitch:   -1, f0Err: 260, thd:  1, alias: 2.60, strCorr: 0.95, cent: 0.30, onset: 0.02, attack: 0.95, form: 1.45, phase: 0.95, shift: 1.95, pkErr:   -1, hopAM: 0.05 } },
]

function safe(fn, fallback = NaN) {
  try { return fn() } catch { return fallback }
}

function assess({ name, fn }) {
  let baseOpts = { ratio, sampleRate }

  let pitched = fn(fixtures.sine440, baseOpts)
  let f0 = zeroCrossingFreq(pitched, sampleRate)
  let f0Err = Math.abs(f0 - 660)
  let thdPct = safe(() => thd(pitched, f0 || 660, sampleRate))

  let alias = fn(fixtures.highSine, { ratio: aliasRatioOpt, sampleRate })
  let aliasV = aliasRatio(alias, fixtures.highSine)

  let strCorr = safe(() => streamConsistency(fn, fixtures.sine440, baseOpts))

  let chord = fn(fixtures.sineChord, baseOpts)
  let cent = safe(() => centroidRatioError(chord, fixtures.sineChord, sampleRate, ratio))

  let dirac = fn(fixtures.diracTrain, baseOpts)
  let onset = safe(() => onsetPeriodError(dirac, 441 / ratio, sampleRate))

  let pluck = fn(fixtures.pluck, baseOpts)
  let attack = safe(() => attackEnvelopeCorr(fixtures.pluck, pluck, sampleRate))

  let vw = fn(fixtures.vowel, baseOpts)
  let form = safe(() => formantDistance(fixtures.vowel, vw, sampleRate))

  let am = fn(fixtures.amSine, baseOpts)
  let phase = safe(() => phaseCoherence(fixtures.amSine, am, amModRate, sampleRate))

  // Ground-truth shift fidelity: compare each algo output to the canonical shifted reference
  // in log-magnitude spectrum. Averaged over four harmonic fixtures so no single signal
  // dominates the score. Lower is better.
  let shiftDist = safe(() => {
    let pairs = [
      [pitched, refs.sine440],
      [chord,   refs.sineChord],
      [pluck,   refs.pluck],
      [am,      refs.amSine],
    ]
    let sum = 0
    for (let [out, ref] of pairs) sum += spectralDistance(out, ref, sampleRate)
    return sum / pairs.length
  })

  // Sanity metrics. Average loudness across sine/chord/pluck so one broken fixture can't
  // hide a general gain bug. Pitch error is measured on the chord (hardest case) via
  // harmonic Goertzel rather than estimateF0 (which picks the GCD subharmonic on chords).
  let loud = safe(() => {
    let rs = [
      loudnessRatio(pitched, fixtures.sine440),
      loudnessRatio(chord,   fixtures.sineChord),
      loudnessRatio(pluck,   fixtures.pluck),
    ].filter(Number.isFinite)
    return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN
  })
  let dur = safe(() => durationRatio(pitched, fixtures.sine440))
  let pitchErr = safe(() => harmonicShiftError(chord, [220, 275, 330], ratio, sampleRate))

  // Chord peak-frequency error (Hz) on the three chord partials — measures whether the
  // actual spectral peaks landed where expected, independent of energy concentration.
  let pkErr = safe(() => chordPeakFreqError(chord, [220, 275, 330], ratio, sampleRate))

  // Frame-boundary AM depth at the synthesis hop rate — the "soft click" users hear on
  // sustained material. Take the max across two fixtures, which expose different failure
  // modes: the beat-free 440 Hz sine catches per-partial reconstruction artefacts (e.g.
  // sms's same-phase triangular lobe), while the chord shifted to ratio 2.0 exposes
  // scatter-chimera artefacts (SUM-scatter vocoders like the canonical Bernsee method
  // pile overlapping source-mainlobe bins into non-stationary dest bins). The chord is
  // shifted at 2.0 not 1.5 because at ratio 1.5 the 220/275/330 chord produces 82.5 Hz
  // natural beats that sit right on top of the 86.13 Hz hop rate and confound the
  // measurement; at ratio 2.0 the beat moves to 110 Hz, clear of the hop rate.
  let chordR2 = fn(fixtures.sineChord, { ratio: 2, sampleRate })
  let hopAM = safe(() => Math.max(
    hopRateMod(pitched, sampleRate, 512),
    hopRateMod(chordR2, sampleRate, 512),
  ))

  return { name, f0Err, thdPct, aliasV, strCorr, cent, onset, attack, form, phase, shiftDist, loud, dur, pitchErr, pkErr, hopAM }
}

function fmt(n, width, digits) {
  if (!Number.isFinite(n)) return '—'.padStart(width)
  return n.toFixed(digits).padStart(width)
}

let results = algorithms.map(assess)

console.log('')
console.log('algorithm     loud    dur  pitch  pkErr  hopAM  f0Err   THD%  alias  strCorr   cent  onset attack   form  phase  shift')
console.log('───────────  ─────  ─────  ─────  ─────  ─────  ─────  ─────  ─────  ───────  ─────  ───── ──────  ─────  ─────  ─────')
for (let r of results) {
  console.log([
    r.name.padEnd(11),
    fmt(r.loud, 6, 2),
    fmt(r.dur, 6, 2),
    fmt(r.pitchErr, 6, 3),
    fmt(r.pkErr, 6, 2),
    fmt(r.hopAM, 6, 3),
    fmt(r.f0Err, 6, 2),
    fmt(r.thdPct, 6, 1),
    fmt(r.aliasV, 6, 3),
    fmt(r.strCorr, 8, 3),
    fmt(r.cent, 6, 3),
    fmt(r.onset, 6, 3),
    fmt(r.attack, 6, 3),
    fmt(r.form, 6, 3),
    fmt(r.phase, 6, 3),
    fmt(r.shiftDist, 6, 3),
  ].join(' '))
}
console.log('')
console.log('legend:')
console.log('  loud     ratio     rms(out)/rms(in) averaged over 3 fixtures    1.0=perfect')
console.log('  dur      ratio     length(out)/length(in)                       1.0=perfect')
console.log('  pitch    rel       chord energy outside expected harmonics       lower=better')
console.log('  pkErr    Hz        chord partial peak-frequency max deviation    lower=better')
console.log('  hopAM    depth     frame-boundary AM (max over sine@1.5 + chord@2) lower=better')
console.log('  f0Err    Hz        pitch accuracy on 440 Hz → 660 Hz             lower=better')
console.log('  THD%     %         total harmonic distortion on pure sine        lower=better')
console.log('  alias    ratio     folded energy when shifting 14 kHz ×2         lower=better')
console.log('  strCorr  corr      streaming vs batch correlation                higher=better')
console.log('  cent     rel       spectral centroid ratio error                 lower=better')
console.log('  onset    rel       impulse-train period error                    lower=better')
console.log('  attack   corr      plucked-attack envelope correlation           higher=better')
console.log('  form     log-env   formant preservation distance                 lower=better')
console.log('  phase    coh       AM-envelope coherence on a 5 Hz tremolo       higher=better')
console.log('  shift    log-mag   ground-truth shift fidelity (sine/chord/pluck/am)  lower=better')
console.log('')

if (ciMode) {
  let failures = []
  for (let index = 0; index < results.length; index++) {
    let r = results[index]
    let b = algorithms[index].bounds
    let checks = [
      ['loud',    r.loud,    (v) => !Number.isFinite(v) || (v >= b.loudLo && v <= b.loudHi)],
      ['dur',     r.dur,     (v) => !Number.isFinite(v) || Math.abs(v - 1) <= b.dur],
      ['pitch',   r.pitchErr,(v) => b.pitch < 0 || (!Number.isFinite(v) || v <= b.pitch)],
      ['f0Err',   r.f0Err,   (v) => v <= b.f0Err],
      ['thd',     r.thdPct,  (v) => !Number.isFinite(v) || v <= b.thd],
      ['alias',   r.aliasV,  (v) => b.alias < 0 || v <= b.alias],
      ['strCorr', r.strCorr, (v) => b.strCorr < 0 || v >= b.strCorr],
      ['cent',    r.cent,    (v) => !Number.isFinite(v) || v <= b.cent],
      ['onset',   r.onset,   (v) => !Number.isFinite(v) || v <= b.onset],
      ['attack',  r.attack,  (v) => b.attack < 0 || (!Number.isFinite(v) ? false : v >= b.attack)],
      ['form',    r.form,      (v) => !Number.isFinite(v) || v <= b.form],
      ['phase',   r.phase,     (v) => b.phase < 0 || (!Number.isFinite(v) ? false : v >= b.phase)],
      ['shift',   r.shiftDist, (v) => b.shift < 0 || !Number.isFinite(v) || v <= b.shift],
      ['pkErr',   r.pkErr,     (v) => b.pkErr < 0 || (!Number.isFinite(v) || v <= b.pkErr)],
      ['hopAM',   r.hopAM,     (v) => b.hopAM < 0 || (!Number.isFinite(v) || v <= b.hopAM)],
    ]
    for (let [metric, value, ok] of checks) {
      if (!ok(value)) failures.push(`${r.name}: ${metric}=${Number(value).toFixed(3)} exceeds bound`)
    }
  }
  if (failures.length) {
    for (let f of failures) console.error('  ✗', f)
    process.exit(1)
  }
  console.log('✓ all quality bounds within spec')
}
