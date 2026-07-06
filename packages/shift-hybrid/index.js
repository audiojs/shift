import { stft } from 'fourier-transform/stft'
import phaseLock from '@audio/shift-pvoc-lock'
import wsola from '@audio/shift-wsola'
import { makePitchShift, resolvePitchParams, bufferedStream } from '@audio/shift-core'

// Hybrid pitch shifter. Runs two canonical engines in parallel and crossfades between them
// sample-by-sample, driven by a per-sample transient confidence signal:
//
//   out[i] = (1 - τ[i]) · phaseLock(input)[i]  +  τ[i] · wsola(input, aligned)[i]
//
// Where τ[i] is derived from spectral-flux transient detection on the input. On sustained
// tonal material τ→0 and the output is purely phase-vocoded. On attacks τ→1 and the output
// is purely WSOLA, whose time-domain similarity search preserves transient shape.
//
// Canonical motivation: no single domain wins everywhere. Frequency-domain methods smear
// transients; time-domain methods mistrack tonal phase. Running both and letting the input
// decide where each is trusted is the simplest principled combination — provided the two
// engines' notion of "now" actually agrees (`estimateLag`/`alignTd`) and actually resembles
// each other once aligned (`alignmentTrust`) before either is allowed to outweigh phaseLock.

// Spectral flux, energy-domain half-wave-rectified and normalized by frame energy — the same
// shape shift-transient's onset detector uses (see packages/shift-transient/index.js), copied
// locally rather than imported since transient exposes no reusable export for it (consolidate
// later if one appears). `nFlux` is a bounded ratio (energy that appeared / total energy), not
// a raw magnitude sum, so a fixed floor on it is physically meaningful across signals — this
// is what makes the detector robust where a bare EMA z-score on an unbounded flux magnitude is
// not: a smooth tremolo/vibrato swell tops out at a low, predictable nFlux (measured ≈0.17 at
// this frameSize/hop for a full-scale 5 Hz/60%-depth AM sine) while genuine onsets reach
// several times that, so `threshold × max(0.3, std)` separates them without per-material tuning.
function transientConfidence(data, opts) {
  let N = 1024, hop = N >> 2, half = N >> 1
  if (data.length < 64) return new Float32Array(data.length)
  let frames = stft(data, { frameSize: N, hopSize: hop })
  if (frames.length < 2) return new Float32Array(data.length)

  let threshold = opts?.hybridThreshold ?? 0.8
  let raw = new Float32Array(frames.length)
  let fluxMean = 0, fluxVar = 0, energyMean = 0, postFrames = 0

  for (let i = 1; i < frames.length; i++) {
    // `stft` zero-pads a full frame on each side, so early frames' windows still overlap
    // that padding: the resulting zero→signal edge is itself a spectral discontinuity,
    // indistinguishable from a real onset — skip flux/statistics there, exactly like
    // shift-transient's own `frameStart < 0` boundary guard.
    if (frames[i].time - half < 0) continue
    let mag = frames[i].mag, prevMag = frames[i - 1].mag
    let flux = 0, energy = 0
    for (let k = 0; k < mag.length; k++) {
      let m2 = mag[k] * mag[k], p2 = prevMag[k] * prevMag[k]
      if (m2 > p2) flux += m2 - p2
      energy += m2
    }
    let nFlux = energy > 1e-12 ? flux / energy : 0
    let floor = threshold * Math.max(0.3, Math.sqrt(fluxVar))
    // A decay/release looks like falling energy, never rising flux above baseline — gating
    // on `rising` keeps a tail from ever being mistaken for an onset.
    if (postFrames > 3 && energy >= energyMean * 0.7) {
      let excess = nFlux - fluxMean - floor
      if (excess > 0) raw[i] = Math.min(1, excess / (floor + 1e-6))
    }
    let alpha = raw[i] > 0 ? 0.25 : 0.1
    let delta = nFlux - fluxMean
    fluxMean += alpha * delta
    fluxVar = (1 - alpha) * (fluxVar + alpha * delta * delta)
    energyMean += alpha * (energy - energyMean)
    postFrames++
  }

  // Sample-and-hold, not interpolation: a single-frame flux spike must reach its full frame
  // value for the whole hop it covers, not get averaged down toward the next (lower) frame's
  // value halfway through — that averaging was clipping a genuine onset's peak confidence
  // before the attack/release follower below ever saw it.
  let perSample = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) perSample[i] = raw[Math.min(raw.length - 1, (i / hop) | 0)]

  // Attack/release envelope follower smooths the frame-rate steps into a click-free crossfade
  // and widens transients so the WSOLA grain covers the whole attack.
  let sr = opts?.sampleRate || 44100
  let ca = 1 - Math.exp(-1 / (0.002 * sr))
  let cr = 1 - Math.exp(-1 / (0.040 * sr))
  let env = 0
  for (let i = 0; i < perSample.length; i++) {
    let x = perSample[i]
    env += (x > env ? ca : cr) * (x - env)
    perSample[i] = env
  }
  return perSample
}

// Samples where WSOLA will actually be blended in (expanded by ±margin) — restricting both
// the lag search and the trust check (below) to this region both bounds their cost on long
// buffers and keeps them numerically sound: normalized correlation over mostly-silent or
// steady stretches is dominated by whichever value happens to catch the least noise, not the
// signal that's actually there.
function activeRanges(conf, floor, margin, n) {
  let include = new Uint8Array(n)
  let any = false
  for (let i = 0; i < n; i++) {
    if (conf[i] <= floor) continue
    any = true
    let lo = Math.max(0, i - margin), hi = Math.min(n, i + margin + 1)
    for (let j = lo; j < hi; j++) include[j] = 1
  }
  if (!any) return []
  let ranges = []
  for (let i = 0; i < n;) {
    if (!include[i]) { i++; continue }
    let start = i
    while (i < n && include[i]) i++
    ranges.push([start, i])
  }
  return ranges
}

// WSOLA's correlation search displaces its grain read-position near non-stationary content,
// giving it a net reconstruction delay phaseLock (near-zero group delay by construction)
// doesn't share — left uncompensated, the crossfade blends phaseLock's on-time attack against
// WSOLA's late one, suppressing the true attack and injecting a phantom echo where WSOLA's
// delayed copy lands. Estimate that delay as a single global lag via cross-correlation over
// `ranges` and compensate before blending. Returns a sample count; positive means `td` lags `pv`.
function estimateLag(pv, td, ranges, maxLag) {
  if (!ranges.length) return 0
  let n = pv.length
  let bestLag = 0, bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0, na = 0, nb = 0
    for (let [s, e] of ranges) {
      let lo = Math.max(s, -lag), hi = Math.min(e, n - lag)
      for (let k = lo; k < hi; k++) {
        let a = pv[k], b = td[k + lag]
        dot += a * b; na += a * a; nb += b * b
      }
    }
    let score = dot / Math.sqrt(Math.max(1e-12, na * nb))
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }
  return bestLag
}

// Shift `td` earlier by `lag` samples (a single constant compensation, applied whole-signal)
// so its reconstruction of a transient lines up with phaseLock's before blending.
function alignTd(td, lag) {
  if (!lag) return td
  let n = td.length
  let out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let j = i + lag
    out[i] = j < 0 ? 0 : td[Math.min(n - 1, j)]
  }
  return out
}

// A single global lag can't correct every onset in a busy, multi-instrument passage equally
// well (a kick and a hi-hat rarely share WSOLA's exact correlation-search behavior) — measure
// how much of tdAligned's variance in the actually-blended samples is explained by pv (R²,
// restricted to `conf`-active samples themselves, not the wider ±maxLag search margin, whose
// silence/steady padding would understate genuine agreement). Below R=0.5 the two reconstructions
// no longer share a majority of their variation, so the alignment is disagreement, not delay —
// trust is 0 and the blend falls back to phaseLock exactly, never a worse-than-either compromise.
function alignmentTrust(pv, tdAligned, conf, floor) {
  let dot = 0, na = 0, nb = 0, count = 0
  for (let i = 0; i < pv.length; i++) {
    if (conf[i] <= floor) continue
    let a = pv[i], b = tdAligned[i]
    dot += a * b; na += a * a; nb += b * b; count++
  }
  if (count < 10 || na < 1e-9 || nb < 1e-9) return 1 // too little evidence to distrust
  let r = dot / Math.sqrt(na * nb)
  return r > 0.5 ? r * r : 0
}

function hybridBatch(data, opts) {
  resolvePitchParams(opts) // validate early — wsola rejects variable ratio, catch it here with a clear message
  let pv = phaseLock(data, opts)
  let td = wsola(data, opts)
  let conf = transientConfidence(data, opts)

  // Mirrors wsola's own deriveOpts so the search bound tracks whatever tolerance it's
  // actually configured with; ×1.5 covers the observed delay (which runs somewhat above
  // the nudge bound itself), capped so a caller-supplied extreme tolerance can't blow up
  // the search cost.
  let frameSize = opts?.frameSize ?? 2048
  let delta = opts?.tolerance ?? (frameSize >> 2)
  let maxLag = Math.min(4096, Math.max(64, Math.round(delta * 1.5)))
  let confFloor = 0.05
  let ranges = activeRanges(conf, confFloor, maxLag, data.length)
  let tdAligned = alignTd(td, estimateLag(pv, td, ranges, maxLag))
  let trust = alignmentTrust(pv, tdAligned, conf, confFloor)

  // Linear (equal-gain) crossfade, not constant-power: pv/tdAligned are two reconstructions
  // of the *same* source, not independent signals, so they're correlated rather than
  // decorrelated. Measured by RMS sweep on steady aligned content — linear stays flat (no dip)
  // while constant-power overshoots by up to +40% at the midpoint, exactly the artifact
  // constant-power is meant to prevent, in reverse, when the two inputs already agree in phase.
  let out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) {
    let t = conf[i] * trust
    out[i] = (1 - t) * pv[i] + t * tdAligned[i]
  }
  return out
}

// Two engines + crossfade are inherently non-causal — buffer input and batch on flush.
let hybridStream = (opts) => bufferedStream(hybridBatch, opts)

export default makePitchShift(hybridBatch, hybridStream)
