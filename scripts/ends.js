// What the whole-signal shifters render where a take ends: the figures the READMEs of ola, wsola and lpc quote, each
// over the sample named beside it. `node scripts/ends.js [fade] [lead] [lpc] [scale] [drop] [match] [long] [held] [margin] [head]`, all ten by default.
//   fade   ola and wsola shifted up: the last 1024 frames of the output against its central half, net of the input's own
//   lead   ola and wsola: how far the output's envelope runs ahead of the input's (negative) or behind it
//   lpc    a stop at the end of the call against a stop mid-take, a channel that ends early, dither and a click after
//          it; the ring where the delay line stops exciting the filter; pure tones, from the call's start and after
//          silence, their level and their bodies
//   scale  lpc: a call times a factor against its render times that factor
//   drop   lpc: a take cut loud into zeros, noise under it and a 16-bit file's dither, its level and its loudest 64
//          frames before the cut; a faded take; two notes with zeros, dither or noise between them; a level hovering low
//   match  lpc: what its level match, one gain a channel a call, leaves between a steady vowel's harmonics, room tone
//          in pauses, a tone moved past half the rate (from the call's start and after silence), and two channels
//          holding different sounds
//   long   lpc: a phrase cut loud written over and over with room noise between, each copy's level
//   held   lpc: a held note with steep edges, what clicks over its middle and what lies between its harmonics
//   margin lpc: how much better than its forward window another window whitens a frame, over held sound, cuts and voice
//   head   lpc: a take that starts mid-sound, what sounds over its first 10 ms
// The voice is audio-lena (a sung voice, 44.1 kHz) resampled to each rate.

import { ola, wsola, lpc } from '../index.js'
import { resampleTo } from '@audio/resample-sinc'
import { fft } from 'fourier-transform'
import lenaRaw from 'audio-lena/raw'
import { vowel, karplusStrong, rockBeat } from './fixtures.js'

const RATES = [22050, 44100, 96000]
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['fade', 'lead', 'lpc', 'scale', 'drop', 'match', 'long', 'held', 'margin', 'head']
const lena44 = new Float32Array(lenaRaw), voices = {}
const voice = (sr) => voices[sr] ??= sr === 44100 ? lena44 : resampleTo(lena44, Math.round(lena44.length * sr / 44100))

const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)) }
const peak = (a, from = 0, to = a.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p }
const db = (v) => 20 * Math.log10(v)
const tone = (n, sr, f, a) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / sr))
const span = ([lo, hi]) => `${lo.toFixed(1)} to ${hi.toFixed(1)} dB`
const widen = (s, v) => { s[0] = Math.min(s[0], v); s[1] = Math.max(s[1], v) }
const lcg = (s) => () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
const gauss = (u) => Math.sqrt(-2 * Math.log(1 - u() + 1e-300)) * Math.cos(2 * Math.PI * u())
// How far before a change in its input lpc's render can change (test.js lpcReach): its fits, 6 hops; across a cleared
// memory the residual's scale, W + L; the delay line's reads, W + L, its splice, 256, and taps. A channel's level is
// matched once a call, so past this reach a render differs from another only by that channel's one gain
const reach = (sr, st) => 6 * 256 + 2 * 2560 + 256 + Math.ceil(8 * Math.max(1, 2 ** (st / 12))) + 1
// a's render against b's times the one factor that fits b to a best over [0, to): the largest RMS over 64 frames of what
// is left, re T (dB); and whether anything is left there over float32's rounding, 2^-22 of b's peak
const fit = (a, b, to) => { let ab = 0, bb = 0; for (let i = 0; i < to; i++) { ab += a[i] * b[i]; bb += b[i] * b[i] } return bb ? ab / bb : 1 }
const apartK = (a, b, to, T, k = fit(a, b, to)) => { let d = 0; for (let i = 0; i + 64 <= to; i += 64) { let q = 0; for (let j = i; j < i + 64; j++) q += (a[j] - k * b[j]) ** 2; d = Math.max(d, Math.sqrt(q / 64)) } return d ? db(d / T) : -Infinity }
const differK = (a, b, to) => { let k = fit(a, b, to), d = 0, P = peak(b, 0, to); for (let i = 0; i < to; i++) d = Math.max(d, Math.abs(a[i] - k * b[i])); return d > 2 ** -22 * P ? 1 : 0 }

// Shifted up, the last grains read the silence after the take: what that does to the last 1024 frames, against the
// output's central half, net of the input's own (0 for a held tone). Beside it each of the two re the input's over the
// same frames, since a grain overlap can cancel a held tone in the middle that the end, with fewer grains, cancels
// less. Takes of 1 s plus 0 to 2047 frames (32 lengths: where the last grain falls), held tones at 0.5 of 110 to
// 1000 Hz, and the voice cut at 2, 5 and 8 s
if (parts.includes('fade')) {
  let lengths = Array.from({ length: 32 }, (_, i) => Math.round(i * 2047 / 31))
  let last = (a, n) => rms(a, n - 1024, n), middle = (a, n) => rms(a, n >> 2, n - (n >> 2))
  console.log('fade: the last 1024 frames re the central half, output minus input; the central half and the last 1024 frames each re the input\'s; 32 take lengths (1 s + 0..2047 frames), 22.05/44.1/96 kHz')
  for (let [name, fn] of [['ola', ola], ['wsola', wsola]]) for (let sig of ['tone', 'voice']) for (let st of [1, 12, 24]) {
    let s = [Infinity, -Infinity], mid = [Infinity, -Infinity], end = [Infinity, -Infinity]
    for (let sr of RATES) for (let k of sig === 'tone' ? [110, 220, 330, 440, 660, 1000] : [2, 5, 8]) for (let off of lengths) {
      let n = sr + off, x = sig === 'tone' ? tone(n, sr, k, 0.5) : voice(sr).slice(k * sr, k * sr + n), y = fn(x, { semitones: st, sampleRate: sr })
      widen(s, db(last(y, n) / middle(y, n)) - db(last(x, n) / middle(x, n)))
      widen(mid, db(middle(y, n) / middle(x, n)))
      widen(end, db(last(y, n) / last(x, n)))
    }
    console.log(`  ${name}, ${sig === 'tone' ? 'held tones 110..1000 Hz' : 'the voice at 2, 5, 8 s'}, +${st} st: ${span(s)}; the middle re the input's ${span(mid)}, the end ${span(end)}`)
  }
}

// Noise bursts (15 ms, a Hann envelope) at drawn spacings of 0.12 to 0.37 s over 2 s; the envelope a 64-frame RMS every
// 4 frames; the lead or lag the shift of the output's envelope that best correlates with the input's within ±4096
// frames (positive: the output late). "?" where that correlation is under 0.5
if (parts.includes('lead')) {
  let env = (x) => { let H = 4, W = 64, e = new Float64Array(Math.floor((x.length - W) / H)); for (let k = 0; k < e.length; k++) e[k] = rms(x, k * H, k * H + W); return e }
  let lag = (x, y) => {
    let a = env(x), b = env(y), M = 1024, ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length, best = -Infinity, at = 0
    for (let L = -M; L <= M; L++) {
      let s = 0, sa = 0, sb = 0
      for (let k = M; k < a.length - M; k++) { let p = a[k] - ma, q = b[k + L] - mb; s += p * q; sa += p * p; sb += q * q }
      let c = s / Math.sqrt(sa * sb)
      if (c > best) { best = c; at = L }
    }
    return `${at * 4}${best < 0.5 ? '?' : ''}`
  }
  let bursts = (sr) => {
    let x = new Float32Array(2 * sr), B = Math.round(0.015 * sr), noise = lcg(5), gap = lcg(77)
    for (let s = Math.round(0.1 * sr); s + B < x.length; s += Math.round((0.12 + 0.25 * gap()) * sr))
      for (let i = 0; i < B; i++) x[s + i] = 0.3 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / B)) * gauss(noise)
    return x
  }
  console.log('lead: frames the output runs late (negative: early), at 22.05/44.1/96 kHz')
  for (let [name, fn] of [['ola', ola], ['wsola', wsola]]) {
    let row = [-24, -12, -5, 5, 12, 24].map(st => `${st > 0 ? '+' : ''}${st}: ${RATES.map(sr => { let x = bursts(sr); return lag(x, fn(x, { semitones: st, sampleRate: sr })) }).join('/')}`)
    console.log(`  ${name}: ${row.join(' | ')}`)
  }
}

// lpc renders a call as one take; where it stops into exact zeros nothing is left to fit, as past the call's end. Each
// take 0.5 s, the voice cut where it is loud (at 3 s on) or a 220 Hz tone at 0.4, at -12/-5/+5/+12 st and
// 22.05/44.1/48/96 kHz: the output over the 1024 frames after the stop re the 1024 before it, the stop ending the call;
// and the renders where the same take writes otherwise, the take and its ring, short of lpc's reach (`reach`) before
// what follows it: 0.5 s of exact zeros and more sound, TPDF dither 100 dB under the take, a click of 0.5 2000 frames
// after it; and in the right channel of two stopped 0.2 s before the left (as alone, all of it). The click and the
// dither: how far they move the take, the largest difference over its 64-frame windows re its RMS
if (parts.includes('lpc')) {
  const RATES4 = [22050, 44100, 48000, 96000]
  let pad = (x, n) => { let y = new Float32Array(n); y.set(x); return y }
  let end = [Infinity, -Infinity], other = { mid: 0, channel: 0, dither: 0, click: 0 }, moved = { dither: -Infinity, click: -Infinity }, count = 0
  for (let sig of ['voice', 'tone']) for (let sr of RATES4) for (let st of [-12, -5, 5, 12]) {
    let s = Math.round(0.5 * sr), g = Math.round(0.5 * sr), c = Math.round(0.2 * sr), v = voice(sr), e = 3 * sr, R = reach(sr, st)
    while (rms(v, e - 256, e) < 0.05) e += 97
    let take = sig === 'tone' ? tone(s, sr, 220, 0.4) : v.slice(e - s, e), next = sig === 'tone' ? tone(s, sr, 330, 0.4) : v.slice(8 * sr, 8 * sr + s)
    let N = s + g + s + sr, opts = { semitones: st, sampleRate: sr }, alone = pad(take, N), u = lcg(5), T = rms(take)
    let mid = alone.slice(); mid.set(next, s + g)
    let dith = alone.slice(); for (let i = s; i < N; i++) dith[i] = T * 1e-5 * Math.sqrt(6) * (u() - u())
    let click = alone.slice(); click[s + 2000] = 0.5
    let left = pad(sig === 'tone' ? tone(s + c, sr, 220, 0.4) : v.slice(e - s, e + c), N)
    let y = lpc(alone, opts), after = rms(y, s, s + 1024) / rms(y, s - 1024, s), yd = lpc(dith, opts), yc = lpc(click, opts)
    widen(end, after ? db(after) : -Infinity)
    other.mid += differK(lpc(mid, opts), y, s + g - R)
    other.channel += differK(lpc([left, alone], opts)[1], lpc(alone, opts), N)
    other.dither += differK(yd, y, s - R)
    other.click += differK(yc, y, s + 2000 - R)
    moved.dither = Math.max(moved.dither, apartK(yd, y, s, T)); moved.click = Math.max(moved.click, apartK(yc, y, s, T))
    count++
  }
  console.log(`lpc: a stop (${count} renders a case: the voice and a tone, 22.05/44.1/48/96 kHz, -12/-5/+5/+12 st)`)
  console.log(`  the 1024 frames after the stop at the call's end re the 1024 before it: ${end[0] === -Infinity ? 'exact zeros' : end[0].toFixed(1) + ' dB'} to ${end[1].toFixed(1)} dB`)
  console.log(`  the take and its ring written otherwise, beyond the channel's one gain, short of lpc's reach (${reach(22050, -12)} to ${reach(96000, 12)} frames): at a stop mid-call 0.5 s before more sound ${other.mid}, in a channel ending 0.2 s early ${other.channel} (all of it), into dither 100 dB under it ${other.dither}, with a click 2000 frames after it ${other.click}`)
  console.log(`  over the take, the dither moves it by ${moved.dither.toFixed(1)} dB re its RMS at most, the click by ${moved.click.toFixed(1)} dB`)
  // Where the delay line stops exciting the filter, (W + W/4 shifted down, W/4 up) + the sinc read's ceil(8·max(1,
  // ratio)) taps + 1 frames past the take's last sound, the ring's level from there on, its largest 64-frame RMS re the
  // input's over the take: tones at 0.5 (250 Hz, 1 kHz, 4 kHz), noise at 0.2, an impulse at the take's last frame, a DC
  // of 0.5 and the voice cut loud, takes of 300 and 3000 frames and 0.25 s, at ±12 and ±24 st, 22.05/44.1/48/96 kHz
  let ring = [-Infinity, ''], rings = 0
  for (let sr of RATES4) for (let st of [-24, -12, 12, 24]) for (let len of [300, 3000, Math.round(0.25 * sr)]) {
    let r = 2 ** (st / 12), D = (r < 1 ? 2560 : 512) + Math.ceil(8 * Math.max(1, r)) + 1, v = voice(sr), e = 3 * sr, u = lcg(len)
    while (rms(v, e - 256, e) < 0.05) e += 97
    let takes = [250, 1000, 4000].map(f => [`${f} Hz`, tone(len, sr, f, 0.5)])
    let noise = new Float32Array(len), imp = new Float32Array(len)
    for (let i = 0; i < len; i++) noise[i] = 0.2 * gauss(u)
    imp[len - 1] = 1
    takes.push(['noise', noise], ['an impulse', imp], ['DC', new Float32Array(len).fill(0.5)], ['the voice', v.slice(e - len, e)])
    for (let [what, x] of takes) {
      let y = lpc(pad(x, len + D + 8192), { semitones: st, sampleRate: sr }), top = 0
      for (let i = len + D; i + 64 <= y.length; i += 64) top = Math.max(top, rms(y, i, i + 64))
      let d = db(top / rms(x))
      if (d > ring[0]) ring = [d, `${what}, ${len} frames, ${st > 0 ? '+' : ''}${st} st, ${sr} Hz`]
      rings++
    }
  }
  console.log(`  where the delay line stops exciting the filter (${rings} takes), the ring at most ${ring[0].toFixed(1)} dB re the input's level (${ring[1]})`)
  // Pure tones at 0.5, 0.25 s, 250 Hz to 4 kHz: the output's peak over the input's, over the middle half and over the
  // first 4096 frames, where the onset rings the fit's pole; and the level over the take, which the channel's one gain
  // brings to the input's but where its match asks to raise it by more than 20 dB: such a tone takes 20 dB and comes
  // out under its input by the rest
  for (let sts of [[5, -5], [12, -12]]) {
    let body = [0, ''], start = [0, ''], off = [Infinity, -Infinity], under = [0, 0, ''], tones = 0
    for (let sr of RATES4) for (let f of [250, 500, 1000, 2000, 3000, 4000]) for (let st of sts) {
      let n = Math.round(0.25 * sr), x = tone(n, sr, f, 0.5), y = lpc(x, { semitones: st, sampleRate: sr }), l = db(rms(y) / rms(x))
      let b = peak(y, n >> 2, n - (n >> 2)) / 0.5, o = peak(y, 0, 4096) / 0.5, at = `${f} Hz, ${sr} Hz, ${st > 0 ? '+' : ''}${st} st`
      if (b > body[0]) body = [b, at]
      if (o > start[0]) start = [o, at]
      widen(off, l)
      if (l < -1e-4) { under[0]++; if (-l > under[1]) under = [under[0], -l, at] }
      tones++
    }
    console.log(`  pure tones at ±${sts[0]} st (${tones}): the peak over the input's up to ${body[0].toFixed(2)}x over the middle half (${body[1]}), ${start[0].toFixed(2)}x over the first 4096 frames (${start[1]}); the level over the take ${span(off)} re the input's, under it in ${under[0]}${under[0] ? `, by ${under[1].toFixed(1)} dB at most (${under[2]}), its match asking ${(20 + under[1]).toFixed(1)}` : ''}`)
  }
  // The same tones after 0.25 s of exact zeros, 0.25 s of zeros after them: the click, the output's peak anywhere re
  // the input's (shifted up the delay line reads the onset early, so it can land before the tone) and where it lies re
  // the tone's start; and the level over the take re the input's, under it where the match asks to raise it by more
  // than 20 dB, which a tone after silence asks more often than one that starts the call
  for (let sts of [[5, -5], [12, -12]]) {
    let click = [0, ''], under = [0, 0, ''], first = Infinity, tones = 0
    for (let sr of RATES4) for (let f of [250, 500, 1000, 2000, 3000, 4000]) for (let st of sts) {
      let n = Math.round(0.25 * sr), x = new Float32Array(3 * n), at = `${f} Hz, ${sr} Hz, ${st > 0 ? '+' : ''}${st} st`
      x.set(tone(n, sr, f, 0.5), n)
      let y = lpc(x, { semitones: st, sampleRate: sr }), l = db(rms(y, 0, 2 * n) / rms(x, 0, 2 * n)), p = 0, t = 0
      for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > p) { p = Math.abs(y[i]); t = i }
      if (p / 0.5 > click[0]) click = [p / 0.5, at]
      first = Math.min(first, (t - n) / sr)
      if (l < -1e-4) { under[0]++; if (-l > under[1]) under = [under[0], -l, at] }
      tones++
    }
    console.log(`  the same tones after 0.25 s of silence, ±${sts[0]} st (${tones}): the click at most ${click[0].toFixed(2)}x the input's peak (${click[1]}), from ${(1000 * first).toFixed(0)} ms re the tone's start; the level under the input's in ${under[0]}${under[0] ? `, by ${under[1].toFixed(1)} dB at most (${under[2]})` : ''}`)
  }
  // What is left of a pure tone's body: a 0.5 sine, 0.5 s, 44.1 kHz; the middle half's RMS re the input's, and the
  // strongest frequency there (a Hann-windowed scan in 2 Hz steps over 8192 frames, 0.8 to 1.2 times the tone and the
  // shifted tone): the body shifts, its level kept or lost by the tone and the shift
  let sr = 44100, n = sr / 2, mid = (a) => rms(a, n >> 2, n - (n >> 2))
  let hz = (a, from, to, lo, hi) => {
    let best = 0, at = 0
    for (let f = lo; f <= hi; f += 2) {
      let re = 0, im = 0
      for (let i = from; i < to; i++) { let w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - from) / (to - from)), p = 2 * Math.PI * f * i / sr; re += a[i] * w * Math.cos(p); im += a[i] * w * Math.sin(p) }
      if (re * re + im * im > best) { best = re * re + im * im; at = f }
    }
    return at
  }
  console.log('  a pure tone\'s body, 44.1 kHz: its level re the input\'s and its strongest frequency')
  for (let f of [110, 220, 440, 880, 1760, 3520]) {
    let row = [-12, -5, -1, 1, 5, 12].map(st => {
      let x = tone(n, sr, f, 0.5), y = lpc(x, { semitones: st, sampleRate: sr }), fr = f * 2 ** (st / 12)
      return `${st > 0 ? '+' : ''}${st}: ${db(mid(y) / mid(x)).toFixed(0)} dB at ${hz(y, n >> 2, (n >> 2) + 8192, Math.round(Math.min(f, fr) * 0.8), Math.round(Math.max(f, fr) * 1.2))} Hz`
    })
    console.log(`    ${f} Hz: ${row.join(' | ')}`)
  }
}

// lpc compares every level as a fraction of the call's peak. Takes at 22.05/44.1/96 kHz: the voice cut loud (0.5 s),
// 0.3 s of zeros, 0.5 s more, then noise from 40 dB under it falling 60 dB a second for 1 s (through 2^-15 of the peak)
// and 0.5 s of zeros; a 220 Hz tone at 0.4 (0.5 s) and a 1 kHz tone at 0.5 (0.25 s), each then 1 s of zeros; alone and
// with a second channel, another cut of the voice 30 dB down stopping at 60 % of the call; -12/-5/+5/+12 st and a glide
// (0.8 + 0.5t). Times 2^-20, 2^-14, 2^-10, 2^-4 and 2^4, each channel's render against the render times the factor (in
// doubles, where both are exact): the renders bit for bit, and where a sample differs, the largest of it at the smaller
// scale (float32 is subnormal under 2^-126) and re the render's peak. Then times 0.001, 0.1, 0.3, 0.7 and 3: the largest
// difference re the render's peak, the voice and the tones apart
if (parts.includes('scale')) {
  let take = (what, sr, off = 0) => {
    let v = voice(sr), s = Math.round(0.5 * sr)
    if (what === 'voice') {
      let e = (3 + off) * sr
      while (rms(v, e - 256, e) < 0.05) e += 97
      let b = v.slice((8 + off) * sr, (8 + off) * sr + s), g = Math.round(0.3 * sr), lv = 0.01 * rms(b), u = lcg(7 + off), x = new Float32Array(2 * s + g + sr + s)
      x.set(v.slice(e - s, e)); x.set(b, s + g)
      for (let i = 0; i < sr; i++) x[2 * s + g + i] = lv * 10 ** (-3 * i / sr) * gauss(u)
      return x
    }
    let n = what === 220 ? s : Math.round(0.25 * sr), x = new Float32Array(n + sr)
    x.set(tone(n, sr, what, what === 220 ? 0.4 : 0.5))
    return x
  }
  let times = (x, f) => Array.isArray(x) ? x.map(c => times(c, f)) : x.map(v => v * f)
  let two = { renders: 0, exact: 0, small: 0, top: 0 }, any = { voice: -Infinity, tones: -Infinity, renders: 0 }
  for (let sr of RATES) for (let what of ['voice', 220, 1000]) for (let pair of [false, true]) {
    let L = take(what, sr), R = take('voice', sr, 1).subarray(0, L.length).map(v => v * 10 ** (-30 / 20))
    R.fill(0, Math.round(0.6 * L.length))
    let X = pair ? [L, R] : L
    for (let st of [-12, -5, 5, 12, 'glide']) {
      let opts = st === 'glide' ? { ratio: t => 0.8 + 0.5 * t, sampleRate: sr } : { semitones: st, sampleRate: sr }, y = [lpc(X, opts)].flat()
      for (let k of [-20, -14, -10, -4, 4, Math.log2(0.001), Math.log2(0.1), Math.log2(0.3), Math.log2(0.7), Math.log2(3)]) {
        let f = 2 ** k, yk = [lpc(times(X, f), opts)].flat(), power = Number.isInteger(k)
        y.forEach((a, c) => {
          let b = yk[c], P = peak(a), d = 0, small = 0, top = 0
          for (let i = 0; i < a.length; i++) { let w = b[i] / f; if (w !== a[i]) { d = Math.max(d, Math.abs(w - a[i])); small = Math.max(small, Math.min(Math.abs(w), Math.abs(a[i])) * Math.min(1, f)); top = Math.max(top, Math.abs(a[i]) / P) } }
          if (power) { two.renders++; if (!d) two.exact++; two.small = Math.max(two.small, small); two.top = Math.max(two.top, top) }
          else { any.renders++; let key = what === 'voice' ? 'voice' : 'tones'; any[key] = Math.max(any[key], d ? db(d / P) : -Infinity) }
        })
      }
    }
  }
  console.log(`scale: lpc, a call times a power of two (${two.renders} channel renders: the voice and two tones, 22.05/44.1/96 kHz, alone and with a channel 30 dB down, -12/-5/+5/+12 st and a glide, 2^-20 to 2^4)`)
  console.log(`  bit for bit but at samples of at most 2^${Math.log2(two.small).toFixed(1)} at the smaller scale, at most ${db(two.top).toFixed(1)} dB re the render's peak; bit for bit throughout ${two.exact}`)
  console.log(`  times 0.001, 0.1, 0.3, 0.7 and 3 (${any.renders} channel renders): the largest difference re the render's peak, the voice ${any.voice.toFixed(1)} dB, the tones ${any.tones.toFixed(1)} dB`)
}

// lpc renders a take cut loud the same whatever follows the cut: the voice cut loud (0.5 s) at 22.05/44.1/96 kHz, its
// peak 0, -20, -40 and -60 dBFS, then 1 s of exact zeros, of Gaussian noise 20, 60 and 100 dB under the take's RMS, and
// of a 16-bit file's dither in its steps, -12/-5/+5/+12 st: the take's first 0.4 s and its last 0.1 s re its input's
// level; and, into the noise 60 and 100 dB under, the largest 64-frame RMS of its render's difference from it into zeros
// re its RMS, up to its one gain, short of the cut's reach (`reach`) and over the whole take, shifted down and up, with
// the frames before the cut from which that difference lies over 60 dB under the take. A take that fades over its last
// 0.15 s (τ 25 ms) into zeros: its level re the input's. Two notes, the voice (0.5 s at 2 s) and the voice 12 dB down
// (0.5 s at 5 s), at 44.1 kHz and resampled to 96 kHz (as in test.js), with between them nothing, 300, 1023, 1025 frames
// or 0.2 s of zeros, a 16-bit file's dither or noise 60 dB under the first: each note's level re its input's, the
// second past the 2560 frames over which the delay line plays the first late and over all of it, its lowest at each
// shift, and the second's step from a gap of 1023 frames to one of 1025. A 220 Hz tone swinging from 2.0e-5 to 4.5e-5
// at 4 Hz (2 s), alone and after the voice at a peak of 1 and 0.3 s of zeros: its level re its input (±5 st)
if (parts.includes('drop')) {
  console.log('drop: lpc, a take cut loud into what follows (-12/-5/+5/+12 st)')
  let r9 = lcg(9), lv = (y, x, a, b) => db(rms(y, a, b) / rms(x, a, b))
  for (let sr of [22050, 44100, 96000]) {
    let v = voice(sr), s = Math.round(0.5 * sr), e = 3 * sr, A = Math.round(0.4 * sr), head = [Infinity, -Infinity], tail = [Infinity, -Infinity]
    let near = { down: -Infinity, up: -Infinity }, whole = { down: -Infinity, up: -Infinity }, from = { down: 0, up: 0 }, over = [-Infinity, '']
    // the loudest 64 frames (in steps of 32) over the take's last 0.1 s
    let loud = (a) => { let m = 0; for (let i = A; i + 64 <= s; i += 32) m = Math.max(m, rms(a, i, i + 64)); return m }
    while (rms(v, e - 256, e) < 0.05) e += 97
    let cut = v.slice(e - s, e)
    for (let dBFS of [0, -20, -40, -60]) {
      let t = cut.map(w => w * 10 ** (dBFS / 20) / peak(cut)), T = rms(t), zeros = new Float32Array(s + sr); zeros.set(t)
      let ends = [[null, zeros]]
      for (let L of [20, 60, 100]) { let x = zeros.slice(); for (let i = s; i < x.length; i++) x[i] = T * 10 ** (-L / 20) * gauss(r9); ends.push([L, x]) }
      { let x = zeros.slice(); for (let i = s; i < x.length; i++) x[i] = Math.round(r9() - r9()) / 32768; ends.push([null, x]) }
      for (let st of [-12, -5, 5, 12]) {
        let o = { semitones: st, sampleRate: sr }, yz = lpc(zeros, o), R = reach(sr, st), k = st > 0 ? 'up' : 'down'
        for (let [L, x] of ends) {
          let y = x === zeros ? yz : lpc(x, o)
          widen(head, lv(y, x, 0, A)); widen(tail, lv(y, x, A, s))
          let b = db(loud(y) / loud(zeros)); if (b > over[0]) over = [b, `${dBFS} dBFS, ${st > 0 ? '+' : ''}${st} st`]
          if (!(L >= 60)) continue
          let kz = fit(y, yz, s - R)
          near[k] = Math.max(near[k], apartK(y, yz, s - R, T, kz)); whole[k] = Math.max(whole[k], apartK(y, yz, s, T, kz))
          for (let i = 0; i + 64 <= s; i += 64) { let q = 0; for (let j = i; j < i + 64; j++) q += (y[j] - kz * yz[j]) ** 2; if (Math.sqrt(q / 64) > 1e-3 * T) { from[k] = Math.max(from[k], s - i); break } }
        }
      }
    }
    console.log(`  ${sr} Hz, peaks 0 to -60 dBFS, into zeros, noise 20/60/100 dB under, 16-bit dither: the first 0.4 s ${span(head)}, the last 0.1 s ${span(tail)} re the input; over the last 0.1 s the loudest 64 frames at most ${over[0].toFixed(1)} dB re the input's (${over[1]})`)
    console.log(`    into noise 60 and 100 dB under, apart from into zeros: shifted down ${near.down.toFixed(1)} dB short of the cut's reach (${reach(sr, -12)}), ${whole.down.toFixed(1)} dB over the take, over 60 dB under from ${from.down} frames before the cut; shifted up ${near.up.toFixed(1)}, ${whole.up.toFixed(1)} dB, from ${from.up} frames`)
  }
  let sr = 44100, v = voice(sr), s = Math.round(0.5 * sr), e = 3 * sr, u = lcg(11)
  while (rms(v, e - 256, e) < 0.05) e += 97
  let faded = new Float32Array(s + sr), d0 = s - Math.round(0.15 * sr), fl = [Infinity, -Infinity]
  for (let i = 0; i < s; i++) faded[i] = v[e - s + i] * (i < d0 ? 1 : Math.exp(-(i - d0) / (0.025 * sr)))
  for (let st of [-12, -5, 5, 12]) widen(fl, lv(lpc(faded, { semitones: st, sampleRate: sr }), faded, 0, s))
  console.log(`  44100 Hz, a take faded into zeros: ${span(fl)} re its input`)
  let a44 = v.slice(2 * sr, 2 * sr + s), b44 = v.slice(5 * sr, 5 * sr + s).map(w => w / 4)
  for (let sr2 of [44100, 96000]) {
    let s2 = Math.round(0.5 * sr2), a0 = sr2 === sr ? a44 : resampleTo(a44, s2), b0 = sr2 === sr ? b44 : resampleTo(b44, s2), T = rms(a0)
    let la = [Infinity, -Infinity], lb = [Infinity, -Infinity], lw = [Infinity, -Infinity], step = 0, low = []
    let fills = { zeros: () => 0, dither: () => Math.round(u() - u()) / 32768, noise: () => T * 1e-3 * gauss(u) }
    for (let st of [-12, -5, 5, 12]) {
      let second = {}
      low.push([st, Infinity])
      for (let [kind, fill] of Object.entries(fills)) for (let gap of [0, 300, 1023, 1025, Math.round(0.2 * sr2)]) {
        if (gap === 0 && kind !== 'zeros') continue
        let x = new Float32Array(2 * s2 + gap + sr2)
        for (let i = 0; i < x.length; i++) x[i] = fill()
        x.set(a0); x.set(b0, s2 + gap)
        let y = lpc(x, { semitones: st, sampleRate: sr2 }), q = s2 + gap
        widen(la, lv(y, x, 0, s2)); widen(lw, lv(y, x, q, q + s2))
        let b = db(rms(y, q + 2560, q + s2) / rms(b0, 2560)); widen(lb, b); second[kind + gap] = b; low.at(-1)[1] = Math.min(low.at(-1)[1], b)
      }
      for (let kind of Object.keys(fills)) step = Math.max(step, Math.abs(second[kind + 1025] - second[kind + 1023]))
    }
    console.log(`  ${sr2} Hz, two notes, the second 12 dB down: the first ${span(la)}, the second ${span(lb)} past the delay line's 2560 frames (${span(lw)} over all of it; its lowest at ${low.map(([st, b]) => `${st > 0 ? '+' : ''}${st} st ${b.toFixed(2)}`).join(', ')} dB); from a gap of 1023 frames to 1025 the second moves ${step.toFixed(2)} dB at most`)
  }
  let n = 2 * sr, g = Math.round(0.3 * sr), hover = new Float32Array(n), lead = v.slice(e - s, e), P = peak(lead), after = new Float32Array(s + g + n)
  for (let i = 0; i < n; i++) hover[i] = (3.25e-5 + 1.25e-5 * Math.sin(2 * Math.PI * 4 * i / sr)) * Math.sin(2 * Math.PI * 220 * i / sr)
  after.set(lead.map(w => w / P)); after.set(hover, s + g)
  for (let [lab, x, from] of [['alone', hover, 0], ['after the voice at a peak of 1', after, s + g]]) {
    let l = [Infinity, -Infinity]
    for (let st of [-5, 5]) widen(l, lv(lpc(x, { semitones: st, sampleRate: sr }), x, from, x.length))
    console.log(`  44100 Hz, a 220 Hz tone hovering at 2.0e-5 to 4.5e-5, ${lab}: ${span(l)} re its input (±5 st)`)
  }
}

// lpc's one level match a call: on the steady vowel fixture (f0 155 Hz, formants 700/1220/2600 Hz, 1 s, 44.1 kHz), over
// the output's middle 2^15 frames (Hann), the energy more than 8 Hz from every harmonic of the shifted f0 between 50 Hz
// and 5 kHz re the energy on them, at -12/-5/+5/+12 st
if (parts.includes('match')) {
  let sr = 44100, x = vowel(155, [{ freq: 700, bw: 110 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 160 }], 1, sr), N = 1 << 15
  let row = [-12, -5, 5, 12].map(st => {
    let y = lpc(x, { semitones: st, sampleRate: sr }), f0 = 155 * 2 ** (st / 12), a = (y.length - N) >> 1, w = new Float64Array(N), on = 0, off = 0
    for (let i = 0; i < N; i++) w[i] = y[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
    let [re, im] = fft(w)
    for (let k = 1; k < re.length; k++) {
      let hz = k * sr / N
      if (hz < 50 || hz > 5000) continue
      let h = Math.round(hz / f0), q = re[k] * re[k] + im[k] * im[k]
      if (h >= 1 && Math.abs(hz - h * f0) <= 8) on += q; else off += q
    }
    return `${st > 0 ? '+' : ''}${st}: ${(10 * Math.log10(off / on)).toFixed(1)} dB`
  })
  console.log(`match: lpc, a steady vowel, the energy between its harmonics re on them: ${row.join(' | ')}`)
  // Room tone in pauses: four phrases of the vowel fixture (f0 140, 170, 200 and 155 Hz, 0.4 s, 10 ms ramps) 0.5 s
  // apart, room noise (white through a one-pole lowpass at 500 Hz) 60 dB under them throughout; over each pause less
  // 0.1 s at either end, the output's level re the input's and its loudest 20 ms re the input's level there, against
  // the input's own loudest 20 ms
  let lv = [Infinity, -Infinity], over = [-Infinity, ''], own = -Infinity
  for (let sr of RATES) {
    let VF = [{ freq: 700, bw: 110 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 160 }], ph = Math.round(0.4 * sr), gp = Math.round(0.5 * sr), ramp = Math.round(0.01 * sr)
    let f0s = [140, 170, 200, 155], x = new Float32Array(gp + f0s.length * (ph + gp)), spans = [], R = 0, u = lcg(23), al = Math.exp(-2 * Math.PI * 500 / sr), nz = new Float64Array(x.length), q = 0, Rn = 0
    for (let k = 0; k < f0s.length; k++) {
      let v = vowel(f0s[k], VF, 0.4, sr), a = gp + k * (ph + gp)
      for (let i = 0; i < ph; i++) { x[a + i] = v[i] * Math.min(1, i / ramp, (ph - 1 - i) / ramp) ** 2; R += x[a + i] ** 2 }
      if (k + 1 < f0s.length) spans.push([a + ph + Math.round(0.1 * sr), a + ph + gp - Math.round(0.1 * sr)])
    }
    R = Math.sqrt(R / (f0s.length * ph))
    for (let i = 0; i < x.length; i++) { q = al * q + (1 - al) * gauss(u); nz[i] = q; Rn += q * q }
    Rn = Math.sqrt(Rn / x.length)
    for (let i = 0; i < x.length; i++) x[i] += R * 1e-3 * nz[i] / Rn
    let w = Math.round(0.02 * sr), loud = (a, [p0, p1]) => { let m = 0; for (let t = p0; t + w <= p1; t += w >> 1) m = Math.max(m, rms(a, t, t + w)); return m }
    for (let st of [-12, -5, 5, 12]) {
      let y = lpc(x, { semitones: st, sampleRate: sr })
      for (let p of spans) { let L = rms(x, p[0], p[1]), o = db(loud(y, p) / L); widen(lv, db(rms(y, p[0], p[1]) / L)); if (o > over[0]) over = [o, `${sr} Hz, ${st > 0 ? '+' : ''}${st} st`]; own = Math.max(own, db(loud(x, p) / L)) }
    }
  }
  console.log(`  room tone 60 dB under four vowel phrases, in the pauses between them (22.05/44.1/96 kHz, -12/-5/+5/+12 st): ${span(lv)} re its input, its loudest 20 ms at most ${over[0].toFixed(1)} dB re its input's level there (${over[1]}; the input's own ${own.toFixed(1)} dB)`)
  // A tone moved past half the rate, which the shift leaves silent: 14 kHz at a ratio of 2 and 16 kHz at +12 st at
  // 44.1 kHz, 8 kHz at +12 and 10 kHz at +5 st at 22.05 kHz (0.5 s at 0.5): the output's level over the middle half,
  // and its peak over the first 4096 frames, where the onset rings at the tone's own pitch, re the input's peak; and its
  // level over the take re the input's, under it where its match asks to raise it by more than 20 dB, by the rest
  let past = [-Infinity, ''], ring = [-Infinity, ''], whole = [Infinity, -Infinity]
  for (let [sr, f, o] of [[44100, 14000, { ratio: 2 }], [44100, 16000, { semitones: 12 }], [22050, 8000, { semitones: 12 }], [22050, 10000, { semitones: 5 }]]) {
    let n = sr >> 1, x = tone(n, sr, f, 0.5), y = lpc(x, { ...o, sampleRate: sr }), d = db(rms(y, n >> 2, n - (n >> 2)) / rms(x, n >> 2, n - (n >> 2))), r = db(peak(y, 0, 4096) / 0.5)
    if (d > past[0]) past = [d, `${f} Hz, ${sr} Hz`]
    if (r > ring[0]) ring = [r, `${f} Hz, ${sr} Hz`]
    widen(whole, db(rms(y) / rms(x)))
  }
  console.log(`  a tone moved past half the rate (14 and 16 kHz at 44.1 kHz, 8 and 10 kHz at 22.05 kHz): over its middle at most ${past[0].toFixed(1)} dB re its input (${past[1]}), its onset's peak at most ${ring[0].toFixed(1)} dB re the input's (${ring[1]}), its level over the take ${span(whole)} re the input's`)
  // The same four after 0.25 s of exact zeros (0.25 s more after them): the output's peak anywhere re the input's, the
  // click the delay line reads early shifted up, and the level over the take re the input's
  let late = [-Infinity, ''], lw = [Infinity, -Infinity]
  for (let [sr, f, o] of [[44100, 14000, { ratio: 2 }], [44100, 16000, { semitones: 12 }], [22050, 8000, { semitones: 12 }], [22050, 10000, { semitones: 5 }]]) {
    let n = sr >> 1, L = sr >> 2, x = new Float32Array(L + n + L)
    x.set(tone(n, sr, f, 0.5), L)
    let y = lpc(x, { ...o, sampleRate: sr }), r = db(peak(y) / 0.5)
    if (r > late[0]) late = [r, `${f} Hz, ${sr} Hz`]
    widen(lw, db(rms(y, 0, L + n) / rms(x, 0, L + n)))
  }
  console.log(`  the same tones after 0.25 s of silence: the peak at most ${late[0].toFixed(1)} dB re the input's (${late[1]}), the level over the take ${span(lw)} re the input's`)
  // Two channels holding different sounds, one call: the voice (2 s from 2 s) on the left; on the right, 20 dB under it,
  // a pluck train (four Karplus-Strong plucks, 196 to 233 Hz, 0.5 s each) or a rock beat (2 s), at 22.05/44.1/96 kHz,
  // -12/-5/+5/+12 st: each channel's level re its own input over the call, and the balance moved, L re R against the
  // input's
  let chan = [0, ''], bal = 0, calls = 0
  for (let sr of RATES) {
    let L = voice(sr).slice(2 * sr, 4 * sr), n = L.length, pl = new Float32Array(n)
    for (let k = 0; k < 4; k++) pl.set(karplusStrong(196 * 2 ** (k / 12), 0.5, sr, 0.996, k + 1).subarray(0, Math.min(sr >> 1, n - k * (sr >> 1))), k * (sr >> 1))
    for (let [what, R0] of [['plucks', pl], ['beat', rockBeat(2, sr).subarray(0, n)]]) {
      let k = rms(L) / rms(R0) / 10, R = R0.map(q => q * k)
      for (let st of [-12, -5, 5, 12]) {
        let y = lpc([L, R], { semitones: st, sampleRate: sr }), l = [db(rms(y[0]) / rms(L)), db(rms(y[1]) / rms(R))]
        l.forEach((q, c) => { if (Math.abs(q) > chan[0]) chan = [Math.abs(q), `${c ? what : 'the voice'}, ${sr} Hz, ${st > 0 ? '+' : ''}${st} st`] })
        bal = Math.max(bal, Math.abs(l[0] - l[1])); calls++
      }
    }
  }
  console.log(`  two channels holding different sounds, the voice and a pluck train or a rock beat 20 dB under it (${calls} calls, 22.05/44.1/96 kHz, -12/-5/+5/+12 st): each channel at most ${chan[0].toExponential(1)} dB re its own input (${chan[1]}), the balance moved ${bal.toExponential(1)} dB at most`)
}

// lpc keeps a long call's level: the voice cut loud (0.5 s) and 0.3 s of white noise 60 dB under it, written 26 times
// over, +5 and +12 st: each copy's level re its input, the furthest from the first copy's, and the range over all
if (parts.includes('long')) {
  let row = []
  for (let sr of RATES) {
    let v = voice(sr), s = Math.round(0.5 * sr), gap = Math.round(0.3 * sr), e = 3 * sr, u = lcg(5), N = 26
    while (rms(v, e - 256, e) < 0.05) e += 97
    let take = v.slice(e - s, e), T = rms(take), x = new Float32Array(N * (s + gap))
    for (let i = 0; i < x.length; i++) x[i] = T * 1e-3 * gauss(u)
    for (let j = 0; j < N; j++) x.set(take, j * (s + gap))
    for (let st of [5, 12]) {
      let y = lpc(x, { semitones: st, sampleRate: sr }), l = Array.from({ length: N }, (_, j) => db(rms(y, j * (s + gap), j * (s + gap) + s) / T)), all = [Infinity, -Infinity]
      l.forEach(q => widen(all, q))
      row.push(`${sr} Hz +${st}: ${Math.max(...l.map(q => Math.abs(q - l[0]))).toFixed(2)} dB, ${span(all)}`)
    }
  }
  console.log(`long: lpc, the voice cut loud and 0.3 s of noise 60 dB under it, 26 times over: each copy's level re its input, the furthest from the first copy's and the range: ${row.join(' | ')}`)
  // A sound gated on and off faster than the delay line's reach lets the scale return: the vowel fixture (150 Hz) on for
  // half of each period of 0.1 and 0.25 s (2 ms ramps) over room noise 60 dB under it (white through a one-pole lowpass
  // at 500 Hz), 6 s at 44.1 kHz, +5 and +12 st: over the last 3 s, the on-halves' level re their input and the
  // off-halves' re theirs, the room noise between
  let sr = 44100, n = 6 * sr, VF = [{ freq: 700, bw: 90 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 120 }], src = vowel(150, VF, 6, sr), on = [Infinity, -Infinity], off = [Infinity, -Infinity]
  for (let per of [Math.round(0.1 * sr), Math.round(0.25 * sr)]) {
    let x = new Float32Array(n), half = per >> 1, ramp = Math.round(0.002 * sr), R = rms(src), u = lcg(3), lp = 0, a = Math.exp(-2 * Math.PI * 500 / sr)
    for (let i = 0; i < n; i++) { let k = i % per, w = k < half ? Math.min(1, k / ramp, (half - k) / ramp) : 0; lp = a * lp + (1 - a) * gauss(u); x[i] = src[i] * w + R * 4e-3 * lp }
    for (let st of [5, 12]) {
      let y = lpc(x, { semitones: st, sampleRate: sr }), e = [0, 0, 0, 0]
      for (let i = n - 3 * sr; i < n; i++) { let k = i % per; if (k > ramp && k < half - ramp) { e[0] += y[i] * y[i]; e[1] += x[i] * x[i] } else if (k > half + ramp && k < per - ramp) { e[2] += y[i] * y[i]; e[3] += x[i] * x[i] } }
      widen(on, 10 * Math.log10(e[0] / e[1])); widen(off, 10 * Math.log10(e[2] / e[3]))
    }
  }
  console.log(`  a vowel gated at 10 and 4 Hz over room noise 60 dB under it (44.1 kHz, +5/+12 st): on ${span(on)} re its input, the room noise between ${span(off)} re its own`)
}

// A held reed-like note (196 Hz, odd harmonics at 0.3/k to 5 kHz) from the call's first frame for 2 s, then 0.5 s of
// zeros: over its middle (0.1 to 1.9 s) the 2 ms second difference's RMS at its loudest re its median there (a click
// detector), and the energy more than 8 Hz from every harmonic of the shifted f0 (50 Hz..5 kHz, 2^k frames about 1 s)
// re that on them
if (parts.includes('held')) {
  let click = [-Infinity, ''], between = [-Infinity, '']
  for (let sr of [22050, 44100, 48000, 96000]) for (let st of [-12, -5, 5, 12]) {
    let n = 2 * sr, x = new Float32Array(n + (sr >> 1)), ph = 0, f0 = 196 * 2 ** (st / 12), at = `${sr} Hz, ${st > 0 ? '+' : ''}${st} st`
    for (let i = 0; i < n; i++) { ph += 2 * Math.PI * 196 / sr; for (let k = 1; k * 196 < 5000; k += 2) x[i] += 0.3 / k * Math.sin(k * ph) }
    let y = lpc(x, { semitones: st, sampleRate: sr }), w = Math.round(0.002 * sr), c = []
    for (let t = Math.round(0.1 * sr); t + w <= Math.round(1.9 * sr); t += w >> 1) { let q = 0; for (let i = t; i < t + w; i++) q += (y[i] - 2 * y[i - 1] + y[i - 2]) ** 2; c.push(Math.sqrt(q / w)) }
    let top = Math.max(...c); c.sort((a, b) => a - b)
    let d = db(top / c[c.length >> 1]), N = 1 << Math.round(Math.log2(0.74 * sr)), a = sr - (N >> 1), win = new Float64Array(N), on = 0, off = 0
    if (d > click[0]) click = [d, at]
    for (let i = 0; i < N; i++) win[i] = y[a + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
    let [re, im] = fft(win)
    for (let k = 1; k < re.length; k++) { let hz = k * sr / N; if (hz < 50 || hz > 5000) continue; let h = Math.round(hz / f0), q = re[k] * re[k] + im[k] * im[k]; if (h >= 1 && Math.abs(hz - h * f0) <= 8) on += q; else off += q }
    let b = 10 * Math.log10(off / on)
    if (b > between[0]) between = [b, at]
  }
  console.log(`held: lpc, a reed-like note with steep edges (22.05/44.1/48/96 kHz, -12/-5/+5/+12 st): the loudest 2 ms of its second difference at most ${click[0].toFixed(1)} dB over its median (${click[1]}), the energy between its harmonics at most ${between[0].toFixed(1)} dB re on them (${between[1]})`)
}

// Where lpc's frames take a window other than their forward one (packages/shift-lpc, MARGIN): of the grid's windows
// that hold a frame (frameSize 1024, a hop of 256, each window's fit bandwidth-expanded by γ = 0.994), the residual of
// the frame's samples by the one that whitens them best re by the forward window, the one that starts with the frame,
// in dB, the inverse filter's memory from the call's start. Over the middle half of held sines (250 Hz, 1 and 4 kHz),
// of a reed-like note and of the vowel fixture (1 s each); over the frame holding a cut and the three before it, whose
// forward windows cross it (the voice cut loud into zeros, noise 20, 60 and 100 dB under and a 16-bit file's dither,
// and the voice into itself 12 dB down); and over the voice's every frame with sound
if (parts.includes('margin')) {
  const N = 1024, hop = 256, K = 4, GAMMA = 0.994
  let lev = (r, p) => {
    let a = new Float64Array(p + 1), t = new Float64Array(p + 1), err = r[0]
    a[0] = 1
    for (let i = 1; i <= p; i++) {
      let acc = r[i]
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j]
      let k = -acc / err
      for (let j = 0; j <= i; j++) t[j] = a[j] + k * a[i - j]
      a.set(t.subarray(0, i + 1))
      err *= 1 - k * k
      if (!(err > 0)) break
    }
    for (let j = 1, g = GAMMA; j <= p; j++, g *= GAMMA) a[j] *= g
    return a
  }
  let fitAt = (x, s, p) => {
    let w = new Float64Array(N), r = new Float64Array(p + 1)
    for (let u = 0; u < N; u++) { let t = s + u; w[u] = t >= 0 && t < x.length ? x[t] * (0.5 - 0.5 * Math.cos(2 * Math.PI * u / N)) : 0 }
    for (let k = 0; k <= p; k++) for (let u = k; u < N; u++) r[k] += w[u] * w[u - k]
    if (!(r[0] > 0)) return null
    r[0] *= 1.000001
    return lev(r, p)
  }
  // the advantage at frame f of x, or NaN where the frame is silent or a window holds nothing to fit
  let adv = (x, sr, f) => {
    let p = Math.min(N >> 4, Math.round(2 + sr / 1000)), t0 = f * hop, E = []
    if (!x.subarray(t0, t0 + hop).some((v) => v !== 0)) return NaN
    for (let k = 0; k < K; k++) {
      let a = fitAt(x, (f + k - K + 1) * hop, p), e = 0
      if (!a) return NaN
      for (let t = t0; t < t0 + hop; t++) { let v = x[t]; for (let j = 1; j <= p && t - j >= 0; j++) v += a[j] * x[t - j]; e += v * v }
      E.push(e)
    }
    return 10 * Math.log10(E[K - 1] / Math.min(...E))
  }
  let q = (a) => { a = a.filter(Number.isFinite).sort((u, v) => u - v); let at = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return `median ${at(0.5).toFixed(2)}, 90 % ${at(0.9).toFixed(2)}, at most ${a[a.length - 1].toFixed(2)} dB (${a.length} frames)` }
  let reed = (n, sr) => { let y = new Float32Array(n), ph = 0; for (let i = 0; i < n; i++) { ph += 2 * Math.PI * 196 / sr; for (let k = 1; k * 196 < 5000; k += 2) y[i] += 0.3 / k * Math.sin(k * ph) } return y }
  let VF = [{ freq: 700, bw: 110 }, { freq: 1220, bw: 120 }, { freq: 2600, bw: 160 }], steady = { tones: [], reed: [], vowel: [] }, drops = [], speech = []
  let r7 = lcg(7)
  for (let sr of [22050, 44100, 48000, 96000]) {
    let n = sr, mid = (x, into) => { for (let f = Math.round(0.25 * n / hop); f < Math.round(0.75 * n / hop); f++) into.push(adv(x, sr, f)) }
    for (let hz of [250, 1000, 4000]) mid(tone(n, sr, hz, 0.5), steady.tones)
    mid(reed(n, sr), steady.reed)
    mid(vowel(155, VF, 1, sr), steady.vowel)
    let v = voice(sr), s = Math.round(0.5 * sr), e = 3 * sr, c = Math.floor(s / hop)
    while (rms(v, e - 256, e) < 0.05) e += 97
    let t = v.slice(e - s, e), T = rms(t), into = [new Float32Array(s + sr)]
    for (let L of [20, 60, 100]) { let x = new Float32Array(s + sr); for (let i = s; i < x.length; i++) x[i] = T * 10 ** (-L / 20) * gauss(r7); into.push(x) }
    { let x = new Float32Array(s + sr); for (let i = s; i < x.length; i++) x[i] = Math.round(r7() - r7()) / 32768; into.push(x) }
    { let x = new Float32Array(2 * s + sr); x.set(v.subarray(5 * sr, 5 * sr + s).map((w) => w / 4), s); into.push(x) }
    for (let x of into) { x.set(t); for (let f = c - 3; f <= c; f++) drops.push(adv(x, sr, f)) }
    for (let f = 0; f < Math.floor(v.length / hop); f++) speech.push(adv(v, sr, f))
  }
  console.log('margin: lpc, the best of the windows that hold a frame re its forward window, the residual of its samples (22.05/44.1/48/96 kHz)')
  let share = (a) => `${(100 * a.filter((v) => v > 0.5).length / a.filter(Number.isFinite).length).toFixed(0)} %`
  for (let [k, a] of Object.entries(steady)) console.log(`  held ${k}: ${q(a)}; over 0.5 dB, ${share(a)} of its frames`)
  console.log(`  at a cut, its frame and the three before it: ${q(drops)}`)
  console.log(`  the voice: ${q(speech)}; over 0.5 dB, ${share(speech)} of its frames`)
}

// A take that starts mid-sound: the voice from 2 s and the voice cut loud (as in drop), 0.5 s each, then 1 s of zeros,
// at 22.05/44.1/48/96 kHz, ±1, ±5 and ±12 st: the output's peak over its first 10 ms re the input's peak over its first
// 0.1 s, the most, the median, and in how many renders over +6 dB
if (parts.includes('head')) {
  let h = []
  for (let sr of [22050, 44100, 48000, 96000]) {
    let v = voice(sr), s = Math.round(0.5 * sr), e = 3 * sr
    while (rms(v, e - 256, e) < 0.05) e += 97
    for (let [what, t] of [['the voice from 2 s', v.slice(2 * sr, 2 * sr + s)], ['the voice cut loud', v.slice(e - s, e)]]) {
      let x = new Float32Array(s + sr); x.set(t)
      for (let st of [-12, -5, -1, 1, 5, 12]) h.push([db(peak(lpc(x, { semitones: st, sampleRate: sr }), 0, Math.round(0.01 * sr)) / peak(x, 0, Math.round(0.1 * sr))), `${what}, ${sr} Hz, ${st > 0 ? '+' : ''}${st} st`])
    }
  }
  h.sort((a, b) => b[0] - a[0])
  console.log(`head: lpc, a take that starts mid-sound (${h.length} renders): its first 10 ms peak at most ${h[0][0].toFixed(1)} dB over the input's (${h[0][1]}), at the median ${h[h.length >> 1][0].toFixed(1)} dB, over +6 dB in ${h.filter(a => a[0] > 6).length}`)
}
