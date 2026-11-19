import { bufferedStream, hannWindow, makePitchShift, resolveRatio } from './host.js'
import delay from '@audio/shift-delay'

// Canonical LPC source-filter pitch shift (residual-excited linear prediction, RELP
// lineage): per frame, estimate the vocal-tract all-pole filter A(z) by the
// autocorrelation method (Levinson-Durbin), inverse-filter the signal to its
// spectrally-flat excitation residual, repitch the residual with the delay-line
// splicer (@audio/shift-delay — duration-preserving, and its correlation splicing
// lands on the residual's pitch pulses), and resynthesize through the UNMODIFIED
// 1/A(z) run continuously with block-switched coefficients — the formant envelope
// never moves, by construction. The classical speech-processing complement to
// cepstral envelope preservation (@audio/shift-formant): exact on voiced monophonic
// material, graceful-but-averaged on polyphony. Degenerate on narrowband/pure tones —
// there the AR envelope IS the partial, so the fit notches the tone out of the residual:
// what is left of it shifts, at the tone's level only where the tone is low or the shift small,
// and its onset rings the fit's pole at the original pitch; that is the family's defining
// tradeoff, not a bug. `order` defaults to the classical 2 + sr/1000, capped so pole pairs
// model the envelope, not individual harmonics.

// Levinson-Durbin: the fit of autocorrelation r, until its prediction error is no longer positive
function levinson(r, p, a, tmp) {
  a.fill(0)
  a[0] = 1
  let err = r[0]
  for (let i = 1; i <= p; i++) {
    let acc = r[i]
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
    let k = -acc / err
    for (let j = 0; j <= i; j++) tmp[j] = a[j] + k * a[i - j]
    for (let j = 0; j <= i; j++) a[j] = tmp[j]
    err *= 1 - k * k
    if (!(err > 0)) break
  }
}

// 1/A(z)'s gain on white noise in nepers, −½·ln Π(1 − k_i²), its reflection coefficients k_i by the step-down recursion
function logGain(c, base, p, t) {
  for (let j = 1; j <= p; j++) t[j] = c[base + j]
  let s = 0
  for (let i = p; i >= 1; i--) {
    let k = t[i], d = 1 - k * k
    s -= 0.5 * Math.log(d)
    for (let j = 1, h = i >> 1; j <= h; j++) { let a = t[j], b = t[i - j]; t[j] = (a - k * b) / d; t[i - j] = (b - k * a) / d }
  }
  return s
}

// Bandwidth expansion of every fit, a_k·γ^k: each pole's radius times γ, so 1/A(z) has a
// bound where a pure tone, perfectly predictable, would put its pole on the unit circle.
// γ = 0.994, the weighting factor of FED-STD-1016 § 3.7.2 (15 Hz at its 8 kHz), as a
// factor a sample at every rate
const GAMMA = 0.994
// The widening, Hz a frame, of the synthesis filter's poles where nothing is left to fit (below)
const BW = 60
// Frames a take renders past the delay line's span: over them γ alone takes its ring
// down 850 dB, so it ends on the take's own frames
const RING = 1 << 14
// How fast the residual's scale returns after a fall of the filters' gain: 1 dB in W + L frames, the most the delay line
// reads early, so while it returns what is read early plays at most 1 dB over the scale where it plays, about the least
// change of level a listener tells apart (Zwicker and Fastl, Psychoacoustics, ch. 7)
const RELEASE = 1
// How much better another window must whiten a frame than its forward window, the one that starts with it, for the
// frame to take that window's fit: 0.5 dB, as an energy ratio. Where the sound holds still, the window that whitens best
// changes place in the grid from frame to frame, and fits that step between windows modulate a held tone at the frame
// rate. A held sine's frames gain at most 0.31 dB from any other window (250 Hz to 4 kHz, 22.05 to 96 kHz) and a held
// reed-like note's nothing, so over 0.5 dB they keep their forward windows; a held vowel's frames gain up to 2.01 dB,
// and 30 % of them take another window; the voice's frames gain 0.65 dB at the median, so 60 % of them, and the frames
// before a cut (13.5 dB at the median), still take the window that whitens them best (scripts/ends.js margin)
const MARGIN = 10 ** (0.5 / 10)
// The most a channel's level match raises its render: 20 dB, a factor of 10. A render over 20 dB under its input has
// lost most of its sound, a pure tone the fit notches out of the residual or the shift moves past half the rate, and
// raising it raises with it the onset's ring at the tone's own pitch, a click (scripts/ends.js lpc and match). A render
// over its input is brought down to its level however far: lowering it makes nothing louder
const GAIN = 10

// One take a channel, whatever it holds: no level is silence, nothing parts it. Its frames of frameSize/4 each take the
// fit of their forward window unless another of the grid's windows that hold them whitens their own samples better by
// MARGIN, so a held tone keeps its forward window from frame to frame, and a fit window that straddles a drop fits
// neither side only where no other does. Where the past predicts what is no longer there (a drop: clearing the
// inverse filter's memory there whitens the next p samples better), the memory is cleared and the frame's samples
// on either side take fits of their own; the filter rings on over the drop, as at a stop. A frame of exact zeros has
// nothing to fit: the last fit goes on, its poles drawn inward, and its residual is silence. The render is unmatched:
// each channel's level is matched once a call, over the call's one span (lpcCall)
function lpcRender(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let n = data.length
  let out = new Float32Array(n)
  let m = n
  while (m > 0 && data[m - 1] === 0) m--
  if (!m) return out
  let N = opts?.frameSize ?? 1024
  let hop = N >> 2, K = N / hop
  let sr = opts?.sampleRate || 44100
  let p = opts?.order ?? Math.min(N >> 4, Math.round(2 + sr / 1000)), P = p + 1
  let frames = Math.ceil(m / hop), M = frames * hop
  let x = new Float32Array(M)
  x.set(data.subarray(0, m))
  // @audio/shift-delay plays the residual up to W + L frames late shifted down, as far early shifted up, its sinc taps
  // beside; past them it plays silence, and the filter rings on its own
  let W = opts?.window ?? 2048, L = opts?.tolerance ?? (W >> 2)
  let span = M + W + L + Math.ceil(8 * Math.max(1, ratio)) + 1
  let len = span + RING

  // The grid's windows, one a hop: window w spans [(w − K + 1)·hop, (w + 1)·hop), so frame f is held by windows
  // f .. f + K − 1, and window f + K is the first after it
  let win = hannWindow(N)
  let wins = frames + K
  let fits = new Float64Array(wins * P), has = new Uint8Array(wins)
  let xw = new Float64Array(N), r = new Float64Array(P), a = new Float64Array(P), tmp = new Float64Array(P)
  for (let w = 0; w < wins; w++) {
    let s = (w - K + 1) * hop
    for (let u = 0; u < N; u++) {
      let t = s + u
      xw[u] = t >= 0 && t < M ? x[t] * win[u] : 0
    }
    for (let k = 0; k <= p; k++) {
      let q = 0
      for (let u = k; u < N; u++) q += xw[u] * xw[u - k]
      r[k] = q
    }
    if (!(r[0] > 0)) continue
    r[0] *= 1.000001
    levinson(r, p, a, tmp)
    for (let j = 1, g = GAMMA; j <= p; j++, g *= GAMMA) a[j] *= g
    fits.set(a, w * P)
    has[w] = 1
  }

  // The take in parts: a frame, or the two sides of a cleared memory in it. Each part's coefficients (C, P a part),
  // whether it holds sound, whether its inverse filter's memory starts with it; a part without sound, the fit it draws
  // in and the end of the last sound before it; and the residual
  let S = 0, from = new Int32Array(2 * frames), to = new Int32Array(2 * frames), sound = new Uint8Array(2 * frames), reset = new Uint8Array(2 * frames)
  let drawFit = new Int32Array(2 * frames), drawFrom = new Int32Array(2 * frames)
  let C = new Float64Array(2 * frames * P)
  let res = new Float32Array(ratioFn ? len : span)
  let mem = 0, lastFit = -1, lastSound = 0
  let part = (a0, b0, isReset, base) => {
    from[S] = a0; to[S] = b0; sound[S] = 1; reset[S] = isReset
    for (let j = 0; j < P; j++) C[S * P + j] = fits[base + j]
    return S++
  }
  let quiet = (a0, b0) => { from[S] = a0; to[S] = b0; sound[S] = 0; reset[S] = 1; drawFit[S] = lastFit; drawFrom[S] = lastSound; S++ }
  // Where nothing is left to fit: the last fit, from the last sound on its poles drawn inward a frame at a time, frame q
  // after it its coefficients a_k·γ^(q·k), γ = exp(−π·B/sr), every pole q·B Hz wider (B = 60 Hz, the bandwidth
  // expansion of 3GPP TS 26.190 § 5.2.1, a frame) than the fit's own. The first frame keeps the coefficients as they
  // are, so nothing steps at the last sound. Before any sound, A(z) = 1
  let drawn = (into, fit, q) => {
    into[0] = 1
    if (fit < 0) { for (let j = 1; j < P; j++) into[j] = 0; return into }
    let g = Math.exp(-Math.PI * BW * q / sr)
    for (let j = 1, gj = g; j <= p; j++, gj *= g) into[j] = C[fit * P + j] * gj
    return into
  }
  let dc = new Float64Array(P)
  let em = new Float64Array(K * hop), pre = new Float64Array(K * (hop + 1)), D = new Float64Array(hop)
  let soundIn = (a0, b0) => { for (let t = a0; t < b0; t++) if (x[t] !== 0) return true; return false }
  // the residual of x over [a0, b0) by window w's fit, from the memory at mem on, into e (from e0); its energy
  let whiten = (w, a0, b0, mem, e, e0) => {
    let E = 0, b = w * P
    for (let t = a0; t < b0; t++) {
      let v = x[t]
      for (let j = 1; j <= p && t - j >= mem; j++) v += fits[b + j] * x[t - j]
      e[e0 + t - a0] = v
      E += v * v
    }
    return E
  }
  for (let f = 0; f < frames; f++) {
    let t0 = f * hop, t1 = t0 + hop
    if (!soundIn(t0, t1)) {
      quiet(t0, t1)
      mem = t0
      continue
    }
    for (let t = t1 - 1; t >= t0; t--) if (x[t] !== 0) { lastSound = t + 1; break }
    // Each window that holds the frame: its residual over the frame, and where clearing the memory whitens the frame's
    // samples better, the candidate where their own energy falls furthest under the residual's over the next p, its
    // exact gain. A cleared memory changes the residual of the p samples from it on, and it is a drop only where it
    // saves at least their share of the frame's residual, p/hop of it: there the past predicts what is no longer there
    // and its ring is most of the frame's residual. Where the signal crosses zero at a frame's last samples, clearing
    // gains the residual of those few, a share near 1/hop, and leaves the next frame's first samples unwhitened, the
    // signal itself where its residual belongs: through 1/A(z), a click
    let best = -1, bestE = Infinity, fwdE = Infinity, cut = -1, cutE = Infinity
    for (let k = 0; k < K; k++) {
      let w = f + k, o = k * (hop + 1)
      pre[o] = 0
      if (!has[w]) { for (let i = 1; i <= hop; i++) pre[o + i] = Infinity; continue }
      let E = 0, b = w * P, e0 = k * hop
      for (let t = t0; t < t1; t++) {
        let v = x[t]
        if (t - p >= mem) for (let j = 1; j <= p; j++) v += fits[b + j] * x[t - j]
        else for (let j = 1; j <= p && t - j >= mem; j++) v += fits[b + j] * x[t - j]
        em[e0 + t - t0] = v
        E += v * v
        pre[o + t - t0 + 1] = E
      }
      if (E < bestE) { bestE = E; best = k }
      if (k === K - 1) fwdE = E
      let at = -1, lo = 0, acc = 0
      for (let i = hop - 1; i >= 0; i--) {
        let y = x[t0 + i], v = em[e0 + i]
        acc += y * y - v * v
        if (i + p < hop) { y = x[t0 + i + p]; v = em[e0 + i + p]; acc -= y * y - v * v }
        D[i] = acc
      }
      for (let i = 0; i < hop; i++) if (t0 + i > mem && D[i] < lo) { lo = D[i]; at = i }
      if (at < 0) continue
      let u = t0 + at, d = 0
      for (let t = u; t < Math.min(t1, u + p); t++) {
        let v = x[t]
        for (let j = 1; j <= t - u; j++) v += fits[b + j] * x[t - j]
        let old = em[e0 + t - t0]
        d += v * v - old * old
      }
      if (d < 0 && -d >= p / hop * E && E + d < cutE) { cutE = E + d; cut = u }
    }
    // A drop is one where a cleared memory whitens the frame better than every window does
    if (cut < 0 || cutE >= bestE) {
      let k = fwdE <= bestE * MARGIN ? K - 1 : best
      lastFit = part(t0, t1, 0, (f + k) * P)
      for (let t = t0; t < t1; t++) res[t] = em[k * hop + t - t0]
      continue
    }
    // The memory cleared at the drop: the samples before it take the window that whitens them best; from it on, of
    // the windows that hold the frame and the one after it, the same; where they hold nothing, the fit before goes on
    if (cut > t0) {
      let k0 = 0
      for (let k = 1; k < K; k++) if (pre[k * (hop + 1) + cut - t0] < pre[k0 * (hop + 1) + cut - t0]) k0 = k
      lastFit = part(t0, cut, 0, (f + k0) * P)
      for (let t = t0; t < cut; t++) res[t] = em[k0 * hop + t - t0]
    }
    mem = cut
    if (!soundIn(cut, t1)) { quiet(cut, t1); continue }
    let bw = -1, bE = Infinity
    for (let w = f; w <= f + K && w < wins; w++) {
      if (!has[w]) continue
      let E = whiten(w, cut, t1, cut, D, 0)
      if (E < bE) { bE = E; bw = w }
    }
    whiten(bw, cut, t1, cut, D, 0)
    for (let t = cut; t < t1; t++) res[t] = D[t - cut]
    lastFit = part(cut, t1, 1, bw * P)
  }

  // Shifted up the delay line reads the residual up to W + L frames early and plays it through the filters where it
  // plays, which lift white excitation by their prediction gain: where those lift more than the residual's own (a
  // vowel's over what follows its end, 40 dB and more), what is read early comes out over its level. The residual's
  // scale is the filters' gain under its peak: each part's log gain, its mean over the parts with sound within W + L of
  // it that no cleared memory parts from it, less the most that mean has reached, the peak falling back RELEASE dB in
  // W + L frames. What is read early across a fall of the filters' gain then plays at its own level; once the peak has
  // fallen to a quiet stretch's gain, what is read early from a rise after it plays through the quiet's filters, under
  // its own. Wherever the frame stands its scale lies between the gain's least and its peak, so it never sinks however
  // long the call. Shifted down the delay line reads late, the excitation before a fall through the filters after it
  // lying under them: the scale holds and its peak follows the gain, so nothing steps where a glide turns. Frames
  // without sound carry the scale on
  let scale = new Float64Array(S).fill(1)
  {
    let lg = new Float64Array(S), gm = new Float64Array(S), half = W + L, fall = RELEASE * Math.LN10 / 20 / (W + L)
    for (let i = 0; i < S; i++) if (sound[i]) lg[i] = logGain(C, i * P, p, tmp)
    for (let i = 0; i < S; i++) {
      if (!sound[i]) continue
      let m = (from[i] + to[i]) / 2, d = to[i] - from[i], sum = lg[i] * d, w = d
      for (let j = i - 1; j >= 0 && sound[j] && !reset[j + 1] && m - (from[j] + to[j]) / 2 < half; j--) { d = to[j] - from[j]; sum += lg[j] * d; w += d }
      for (let j = i + 1; j < S && sound[j] && !reset[j] && (from[j] + to[j]) / 2 - m < half; j++) { d = to[j] - from[j]; sum += lg[j] * d; w += d }
      gm[i] = sum / w
      // The last part before a cut, a cleared memory or a frame without sound: every window that holds it holds the
      // cut's step, so it whitens worse than the parts before it and its filters lift less; read early through those
      // parts' filters, its residual would come out over its level. It takes its own gain
      // where that lies under the mean
      if (i + 1 >= S || reset[i + 1] || !sound[i + 1]) gm[i] = Math.min(gm[i], lg[i])
    }
    for (let i = 0, top = -Infinity, c = 0; i < S; i++) {
      top -= fall * (to[i] - from[i])
      if (sound[i]) {
        if ((ratioFn ? ratioFn(from[i] / sr) : ratio) > 1) { top = Math.max(top, gm[i]); c = gm[i] - top }
        else top = gm[i] - c
      }
      scale[i] = Math.exp(c)
      if (c) for (let t = from[i]; t < to[i]; t++) res[t] *= scale[i]
    }
  }

  // Repitch the residual, then run 1/A(z) continuously over it: no grains, no synthesis transients; each sample uses
  // its own part's coefficients. Past the take it runs on with its state, over what the delay line still plays, the
  // last fit drawn in a frame at a time as over a frame without sound
  let shifted = delay(res, { ...opts, ratio: ratioFn ?? ratio })
  let y = new Float32Array(len)
  let run = (a0, b0, c, b, k) => {
    for (let t = a0; t < b0; t++) {
      let v = t < shifted.length ? shifted[t] / k : 0
      if (t >= p) for (let j = 1; j <= p; j++) v -= c[b + j] * y[t - j]
      else for (let j = 1; j <= t; j++) v -= c[b + j] * y[t - j]
      y[t] = v
    }
  }
  // a stretch without sound, a frame at a time from the last sound on
  let fade = (a0, b0, fit, since, k) => {
    for (let t = a0; t < b0;) {
      let q = Math.floor((t - since) / hop), end = Math.min(b0, since + (q + 1) * hop)
      run(t, end, drawn(dc, fit, q), 0, k)
      t = end
    }
  }
  for (let i = 0; i < S; i++) sound[i] ? run(from[i], to[i], C, i * P, scale[i]) : fade(from[i], to[i], drawFit[i], drawFrom[i], scale[i])
  fade(M, len, lastFit, lastSound, scale[S - 1])

  // past the ring the output is silence
  out.set(y.subarray(0, Math.min(n, len)))
  return out
}

// Harmonics moving across the AR response change a render's level with the shift; each channel's is matched to its
// own input's once for the call: one gain a channel, its energy in over its energy out over the call's one span, the
// frames up to the last sound of any channel (what a host pads after it is no part of its level, and the ring past it
// takes the same gain). One number a channel for the whole call, so the gain cannot follow the sound and pump, and
// every channel comes out at its own input's level, so the channels keep their balance; a channel whose match asks to
// raise it by more than GAIN takes GAIN and comes out under its input. Where the input is silent, or the output, the
// render stays as it is
function lpcCall(channels, opts) {
  let ys = channels.map((c) => lpcRender(c, opts)), m = 0
  for (let c of channels) { let k = c.length; while (k > m && c[k - 1] === 0) k--; m = Math.max(m, k) }
  channels.forEach((c, k) => {
    let y = ys[k], ei = 0, eo = 0
    for (let t = 0; t < Math.min(m, c.length); t++) { ei += c[t] * c[t]; eo += y[t] * y[t] }
    if (!(ei > 0 && eo > 0)) return
    let g = Math.min(GAIN, Math.sqrt(ei / eo))
    for (let t = 0; t < y.length; t++) y[t] *= g
  })
  return ys
}

let lpcBatch = (data, opts) => lpcCall([data], opts)[0]
let lpcStream = (opts) => bufferedStream(lpcBatch, opts)

export default makePitchShift(lpcBatch, lpcStream, lpcCall)
