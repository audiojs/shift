import { makeStftShift } from '@audio/shift-core/stft'
import { WIN_GAIN, findPeaks, makeFrameRatio, wrapPhase } from '@audio/shift-core'

// Spectral Modeling Synthesis (Serra/Smith) pitch shift.
// Decomposes each frame into sinusoidal peaks (partials) + stochastic residual.
// Partial frequencies are scaled by `ratio`; residual carries the leftover spectrum.
//
// Peaks: `findPeaks` (shared ±1 local-max scan, floor = max(1e-8, maxM·0.005)) locates
// candidates; each is parabolically refined for sub-bin frequency/magnitude (<2 cents on a
// well-separated sinusoid), then deposited at a single destination bin — the shifted
// instantaneous frequency's nearest bin. Colliding partials keep the louder one (a quieter
// contributor's frequency estimate would be masked anyway — same policy as shift-core's
// scatter kernels, just resolved by direct magnitude comparison instead of a pre-sort).
//
// Residual: every destination bin NOT claimed by a partial GATHERS its value from the
// residual spectrum at the inverse-mapped source position `k/ratio`, linearly interpolated
// between the two neighbouring residual bins (paulstretch's resample direction). A gather
// gives one write per destination bin by construction — bijective, hole-free — unlike a
// forward scatter at `Math.round(k·ratio)`, which is not a bijection for any ratio != 1
// (produces periodic comb holes when up-shifting, pileups when down-shifting).
//
// Loudness: per-frame energy renormalization (Σmag² in → Σmag² out) replaces whole-signal
// matchGain, so batch and stream reconstruct identically with no post-hoc correction.

// Parabolic (Jacobsen) sub-bin refinement — writes the refined peak magnitude into
// `refMag[k]` and the fractional bin position into `refFrac[k]` for each `peaks[i]`.
// Bin-indexed, caller-owned scratch (sized half+1); only entries at peak bins are touched.
function refinePeaks(mag, peaks, refMag, refFrac) {
  for (let i = 0; i < peaks.length; i++) {
    let k = peaks[i]
    let ym1 = mag[k - 1], y0 = mag[k], yp1 = mag[k + 1]
    let denom = ym1 - 2 * y0 + yp1
    let delta = Math.abs(denom) < 1e-12 ? 0 : 0.5 * (ym1 - yp1) / denom
    refFrac[k] = k + delta
    refMag[k] = y0 - 0.25 * (ym1 - yp1) * delta
  }
}

function process(mag, phase, state, ctx) {
  if (!state.fr) state.fr = makeFrameRatio(ctx.ratioFn || ctx.ratio || 1)
  let { half, hop, freqPerBin } = ctx
  let ratio = state.fr.at(ctx.frameStart, ctx.sampleRate)
  if (!state.prev) {
    state.prev = new Float64Array(half + 1)
    state.syn = new Float64Array(half + 1)
    state.newMag = new Float64Array(half + 1)
    state.newPhase = new Float64Array(half + 1)
    state.residual = new Float64Array(half + 1)
    state.owned = new Uint8Array(half + 1)
    state.peakMag = new Float64Array(half + 1)
    state.refMag = new Float64Array(half + 1)
    state.refFrac = new Float64Array(half + 1)
    state.sel = new Int32Array(half + 1)
    // Tunables resolved once (makeStftShift's deriveOpts) — read here, not from the opts
    // bag on every frame.
    state.maxTracks = ctx.opts.maxTracks
    state.minMag = ctx.opts.minMag
    state.first = true
  }
  let { prev, syn, newMag, newPhase, residual, owned, peakMag, refMag, refFrac, sel, maxTracks, minMag } = state

  let peaks = findPeaks(mag, half)
  // `minMag`: caller-configurable absolute floor on top of findPeaks' relative gate
  // (in-place filter — peaks is a fresh per-call array, not aliased).
  let n = 0
  for (let i = 0; i < peaks.length; i++) if (mag[peaks[i]] >= minMag) peaks[n++] = peaks[i]
  peaks.length = n

  refinePeaks(mag, peaks, refMag, refFrac)

  // Cap to the `maxTracks` loudest peaks (typed-array partial selection — no per-frame
  // heap objects, no closure comparator). `sel[0..take)` indexes into `peaks`.
  for (let i = 0; i < n; i++) sel[i] = i
  let take = n
  if (maxTracks < n) {
    take = maxTracks
    for (let i = 0; i < take; i++) {
      let best = i
      for (let j = i + 1; j < n; j++) if (refMag[peaks[sel[j]]] > refMag[peaks[sel[best]]]) best = j
      if (best !== i) { let t = sel[i]; sel[i] = sel[best]; sel[best] = t }
    }
  }

  // Residual = original magnitude with the selected peaks' lobes zeroed, so the remaining
  // stochastic energy carries no partial content.
  for (let k = 0; k <= half; k++) residual[k] = mag[k]
  let lobeW = 3
  for (let s = 0; s < take; s++) {
    let k0 = peaks[sel[s]]
    for (let d = -lobeW; d <= lobeW; d++) {
      let k = k0 + d
      if (k >= 0 && k <= half) residual[k] = 0
    }
  }

  newMag.fill(0)
  newPhase.fill(0)
  owned.fill(0)
  peakMag.fill(0)

  // `eIn` accumulates only energy that has a valid (in-range) destination — a partial or
  // residual bin that shifts past Nyquist legitimately vanishes and must not inflate the
  // renormalization target (see shift-core's scatterGated, which subtracts the same case
  // back out of its own `eIn`).
  let eIn = 0
  for (let s = 0; s < take; s++) {
    let k0 = peaks[sel[s]]
    let trueFreq
    if (state.first) trueFreq = refFrac[k0] * freqPerBin
    else {
      let dp = wrapPhase(phase[k0] - prev[k0] - k0 * freqPerBin * hop)
      trueFreq = k0 * freqPerBin + dp / hop
    }
    let shifted = trueFreq * ratio
    let center = Math.round(shifted / freqPerBin)
    // Phase accumulator is keyed on the SOURCE bin — stable across frames — so integer-
    // bin jitter at the destination can't reset a partial's phase mid-note. Left un-advanced
    // when out of range (matches re-entry behaviour: a partial that briefly exceeds Nyquist
    // resumes from where it froze rather than jumping).
    if (center < 0 || center > half) continue
    // Full pre-zeroing lobe energy (the same k0±lobeW span excised from `residual` above)
    // is what's being concentrated into one bin — not just the parabolic peak value — so
    // that's `eIn`'s contribution (may double-count a shared bin between two close peaks'
    // overlapping lobes, e.g. a tight chord; accepted as the same approximation shift-core's
    // own ±1 `eligible` gate makes).
    for (let d = -lobeW; d <= lobeW; d++) {
      let k = k0 + d
      if (k >= 0 && k <= half) eIn += mag[k] * mag[k]
    }
    let newSyn = wrapPhase(syn[k0] + shifted * hop)
    syn[k0] = newSyn
    owned[center] = 1
    // Single-bin deposit at the nearest dest bin (see module doc): a same-phase triangular
    // spread is mathematically incorrect for a Hann-windowed single sinusoid, so overlap-add
    // reconstructs correctly only when the whole partial's magnitude lands on one bin.
    if (refMag[k0] > peakMag[center]) {
      peakMag[center] = refMag[k0]
      newMag[center] = refMag[k0]
      newPhase[center] = newSyn
    }
  }

  // Residual (stochastic) bins: GATHER each unclaimed destination bin's value from the
  // ratio-scaled source position, linearly interpolated — bijective by construction (every
  // k in [0, half] is visited exactly once), with the source analysis phase (no synthesis
  // accumulator — the residual has no cross-frame phase coherence to preserve). A source
  // position past Nyquist (down-shift) has no counterpart and legitimately contributes zero.
  for (let k = 0; k <= half; k++) {
    if (owned[k]) continue
    let src = k / ratio
    if (src < 0 || src > half) continue
    let i0 = src | 0
    let frac = src - i0
    let r0 = residual[i0]
    let r1 = i0 + 1 <= half ? residual[i0 + 1] : r0
    let r = r0 + (r1 - r0) * frac
    eIn += r * r
    if (r <= 0) continue
    newMag[k] = r
    newPhase[k] = phase[Math.min(half, Math.round(src))]
  }

  // Per-frame energy renormalization (Σmag² reachable-in → Σmag² out), the same policy
  // shift-core's scatter kernels use, so batch and stream reconstruct at identical loudness
  // with no whole-signal matchGain tail correction. `WIN_GAIN` (rms(w)/mean(w) of the
  // engine's periodic Hann, = √1.5) compensates for the peaks' single-bin deposit: a
  // windowed mainlobe's energy concentrated onto one unwindowed synthesis bin reconstructs
  // quieter through the engine's w·(·)/Σw² overlap-add than the windowed analysis frame it
  // came from (see shift-core's scatterGated/scatterLocked, which apply the identical factor).
  let eOut = 0
  for (let k = 0; k <= half; k++) eOut += newMag[k] * newMag[k]
  if (eOut > 1e-24 && eIn > 1e-24) {
    let g = Math.sqrt(eIn / eOut) * WIN_GAIN
    for (let k = 0; k <= half; k++) newMag[k] *= g
  }

  for (let k = 0; k <= half; k++) prev[k] = phase[k]
  state.first = false
  return { mag: newMag, phase: newPhase }
}

export default makeStftShift(process, {
  deriveOpts: (opts) => ({ maxTracks: opts?.maxTracks ?? Infinity, minMag: opts?.minMag ?? 1e-4 }),
  post: (out) => out,
})
