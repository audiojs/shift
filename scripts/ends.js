// What the whole-signal shifters render where a take ends: the figures the READMEs of ola, wsola and lpc quote, each
// over the sample named beside it. `node scripts/ends.js [fade] [lead] [lpc] [scale] [dither]`, all five by default.
//   fade   ola and wsola shifted up: the last 1024 frames of the output against its central half, net of the input's own
//   lead   ola and wsola: how far the output's envelope runs ahead of the input's (negative) or behind it
//   lpc    a stop at the end of the call against a stop mid-take, a channel that ends early, noise at the silence level
//          and a click after it; the ring where the delay line stops exciting the filter; pure tones, and their bodies
//   scale  lpc: a call times a factor against its render times that factor
//   dither lpc: a take into a 16-bit file's dither, its peak from full scale down; two notes with that dither between
//          them; a level hovering at the silence level
// The voice is audio-lena (a sung voice, 44.1 kHz) resampled to each rate.

import { ola, wsola, lpc } from '../index.js'
import { resampleTo } from '@audio/resample-sinc'
import lenaRaw from 'audio-lena/raw'

const RATES = [22050, 44100, 96000]
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['fade', 'lead', 'lpc', 'scale', 'dither']
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

// lpc renders each sound between runs of silence as a take followed by silence. Each take 0.5 s, the voice cut where it
// is loud (at 3 s on) or a 220 Hz tone at 0.4, at -12/-5/+5/+12 st and 22.05/44.1/48/96 kHz: the output over the 1024
// frames after the stop re the 1024 before it, the stop ending the call; and the renders where the same take writes
// otherwise, the take and its ring, where 0.3 s of exact zeros and more sound follow the stop (short of the 4096 frames
// before that sound, which the delay line reads ahead), in the right channel of two stopped 0.2 s before the left (as
// alone at the call's peak, `peak`), into TPDF dither of ±1 step of its silence level (2^-15 of its peak) in place of
// zeros, and with a click of 0.5 2000 frames after the take (over the take)
if (parts.includes('lpc')) {
  const RATES4 = [22050, 44100, 48000, 96000]
  let pad = (x, n) => { let y = new Float32Array(n); y.set(x); return y }
  let differ = (a, b, to) => { for (let i = 0; i < to; i++) if (a[i] !== b[i]) return 1; return 0 }
  let end = [Infinity, -Infinity], other = { mid: 0, channel: 0, dither: 0, click: 0 }, count = 0
  for (let sig of ['voice', 'tone']) for (let sr of RATES4) for (let st of [-12, -5, 5, 12]) {
    let s = Math.round(0.5 * sr), g = Math.round(0.3 * sr), c = Math.round(0.2 * sr), v = voice(sr), e = 3 * sr
    while (rms(v, e - 256, e) < 0.05) e += 97
    let take = sig === 'tone' ? tone(s, sr, 220, 0.4) : v.slice(e - s, e), next = sig === 'tone' ? tone(s, sr, 330, 0.4) : v.slice(8 * sr, 8 * sr + s)
    let N = s + g + s + sr, opts = { semitones: st, sampleRate: sr }, alone = pad(take, N), u = lcg(5), q = 2 ** -15 * peak(alone)
    let mid = alone.slice(); mid.set(next, s + g)
    let dith = alone.slice(); for (let i = s; i < N; i++) dith[i] = (u() - u()) * q
    let click = alone.slice(); click[s + 2000] = 0.5
    let left = pad(sig === 'tone' ? tone(s + c, sr, 220, 0.4) : v.slice(e - s, e + c), N)
    let y = lpc(alone, opts), after = rms(y, s, s + 1024) / rms(y, s - 1024, s)
    widen(end, after ? db(after) : -Infinity)
    other.mid += differ(y, lpc(mid, opts), s + g - 4096)
    other.channel += differ(lpc(alone, { ...opts, peak: Math.max(peak(left), peak(alone)) }), lpc([left, alone], opts)[1], N)
    other.dither += differ(y, lpc(dith, opts), N)
    other.click += differ(y, lpc(click, opts), s)
    count++
  }
  console.log(`lpc: a stop (${count} renders a case: the voice and a tone, 22.05/44.1/48/96 kHz, -12/-5/+5/+12 st)`)
  console.log(`  the 1024 frames after the stop at the call's end re the 1024 before it: ${end[0] === -Infinity ? 'exact zeros' : end[0].toFixed(1) + ' dB'} to ${end[1].toFixed(1)} dB`)
  console.log(`  the take and its ring written otherwise: at a stop mid-take ${other.mid}, in a channel ending 0.2 s early ${other.channel}, into noise at its silence level ${other.dither}; the take, with a click 2000 frames after it ${other.click}`)
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
  // first 4096 frames, where the onset rings the fit's pole; and the level over the take, which the level match
  // corrects only within 0.1 to 10 times the input's
  for (let sts of [[5, -5], [12, -12]]) {
    let body = [0, ''], start = [0, ''], off = [Infinity, -Infinity], kept = 0, tones = 0
    for (let sr of RATES4) for (let f of [250, 500, 1000, 2000, 3000, 4000]) for (let st of sts) {
      let n = Math.round(0.25 * sr), x = tone(n, sr, f, 0.5), y = lpc(x, { semitones: st, sampleRate: sr }), l = db(rms(y) / rms(x))
      let b = peak(y, n >> 2, n - (n >> 2)) / 0.5, o = peak(y, 0, 4096) / 0.5, at = `${f} Hz, ${sr} Hz, ${st > 0 ? '+' : ''}${st} st`
      if (b > body[0]) body = [b, at]
      if (o > start[0]) start = [o, at]
      widen(off, l)
      if (Math.abs(l) > 0.01) kept++
      tones++
    }
    console.log(`  pure tones at ±${sts[0]} st (${tones}): the peak over the input's up to ${body[0].toFixed(2)}x over the middle half (${body[1]}), ${start[0].toFixed(2)}x over the first 4096 frames (${start[1]}); the level over the take ${span(off)}, left off the input's by the level match in ${kept}`)
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

// lpc's silence is a run at or under 2^-15 of the call's peak, one 16-bit step at a peak of 1. A take (the voice cut
// loud, 0.5 s, at 44.1 kHz, and the same faded over its last 0.15 s) scaled to a peak of 1, of 32767/32768 (full scale
// as 16 bits hold it), and of -1, -6, -20 and -40 dBFS, then 1 s of a 16-bit file's dither, TPDF of ±1 step rounded to
// its steps, -12/-5/+5/+12 st: whether that dither is silence (the take into it written as into exact zeros, bit for
// bit), else the largest difference over the take re its RMS; and the output's level re the input's over the take's
// first 0.4 s and over its last 0.1 s. Two notes, the voice (0.5 s at 2 s) and the voice 12 dB down (0.5 s at 5 s), 0.2 s of the dither
// between them and 1 s after, the first's peak as above: each note's output level re its input. A 220 Hz tone whose
// amplitude swings from 0.655 to 1.47 times the silence level at 4 Hz (2 s), after the voice at a peak of 1 and 0.3 s
// of zeros: the sounds it parts into and its level re its input; alone, at its own peak, the same
if (parts.includes('dither')) {
  let sr = 44100, v = voice(sr), s = Math.round(0.5 * sr), e = 3 * sr, u = lcg(5), dith = new Float32Array(sr)
  while (rms(v, e - 256, e) < 0.05) e += 97
  for (let i = 0; i < sr; i++) dith[i] = Math.round(u() - u()) / 32768
  let at = (x, P) => x.map(w => w * P / peak(x)), first = (a, b, to) => { for (let i = 0; i < to; i++) if (a[i] !== b[i]) return i; return -1 }
  let sounds = (x, q) => { let n = 0, run = Infinity; for (let i = 0; i < x.length; i++) { if (Math.abs(x[i]) <= q) { run++; continue } if (run > 1024) n++; run = 0 } return n }
  let PEAKS = [['1', 1], ['32767/32768', 32767 / 32768], ['-1 dBFS', 10 ** (-1 / 20)], ['-6 dBFS', 10 ** (-6 / 20)], ['-20 dBFS', 0.1], ['-40 dBFS', 0.01]]
  console.log('dither: lpc, a take into a 16-bit file\'s dither in its steps (44.1 kHz, -12/-5/+5/+12 st)')
  // the take cut loud, and the same faded over its last 0.15 s (τ 25 ms)
  let cut = v.slice(e - s, e), faded = cut.map((w, i) => i < s - 6615 ? w : w * Math.exp(-(i - s + 6615) / (0.025 * sr)))
  for (let [lab, P] of PEAKS) for (let [how, t] of [['cut', cut], ['faded', faded]]) {
    let zeros = new Float32Array(s + sr); zeros.set(at(t, P))
    let x = zeros.slice(); x.set(dith, s)
    let head = [Infinity, -Infinity], tail = [Infinity, -Infinity], B = s - 4410
    let res = [-12, -5, 5, 12].map(st => {
      let o = { semitones: st, sampleRate: sr }, y = lpc(x, o), z = lpc(zeros, o), d = 0
      widen(head, db(rms(y, 0, B) / rms(x, 0, B))); widen(tail, db(rms(y, B, s) / rms(x, B, s)))
      if (first(y, z, y.length) < 0) return null
      for (let i = 0; i < s; i++) d = Math.max(d, Math.abs(y[i] - z[i]))
      return db(d / rms(z, 0, s))
    })
    console.log(`  peak ${lab}, ${how}: ${res.every(r => r === null) ? 'the dither is silence, the take as into zeros' : `the dither is sound; over the take ${span([Math.min(...res), Math.max(...res)])} re its RMS from into zeros`}; re the input, the take's first 0.4 s ${span(head)}, its last 0.1 s ${span(tail)}`)
  }
  let a0 = v.slice(2 * sr, 2 * sr + s), b0 = v.slice(5 * sr, 5 * sr + s).map(w => w / 4), gp = Math.round(0.2 * sr)
  console.log('  two notes, the second 12 dB down, the dither between and after them: each note\'s level re its input')
  for (let [lab, P] of PEAKS) {
    let g = P / peak(a0), a = a0.map(w => w * g), b = b0.map(w => w * g), x = new Float32Array(2 * s + gp + sr), la = [Infinity, -Infinity], lb = [Infinity, -Infinity]
    x.set(dith.subarray(0, gp), s); x.set(dith.subarray(0, sr), 2 * s + gp); x.set(a); x.set(b, s + gp)
    for (let st of [-12, -5, 5, 12]) { let y = lpc(x, { semitones: st, sampleRate: sr }); widen(la, db(rms(y, 0, s) / rms(a))); widen(lb, db(rms(y, s + gp, 2 * s + gp) / rms(b))) }
    console.log(`    first note's peak ${lab}, ${sounds(x, 2 ** -15 * peak(x))} sound${sounds(x, 2 ** -15 * peak(x)) > 1 ? 's' : ''}: the first ${span(la)}, the second ${span(lb)}`)
  }
  let n = 2 * sr, g = Math.round(0.3 * sr), lead = at(v.slice(e - s, e), 1), hover = new Float32Array(s + g + n)
  hover.set(lead)
  for (let i = 0; i < n; i++) hover[s + g + i] = (3.25e-5 + 1.25e-5 * Math.sin(2 * Math.PI * 4 * i / sr)) * Math.sin(2 * Math.PI * 220 * i / sr)
  for (let [lab, x, from] of [['after the voice at a peak of 1', hover, s + g], ['alone, at its own peak', hover.slice(s + g), 0]]) {
    let lv = [Infinity, -Infinity]
    for (let st of [-5, 5]) { let y = lpc(x, { semitones: st, sampleRate: sr }); widen(lv, db(rms(y, from, x.length) / rms(x, from, x.length))) }
    let k = sounds(x.subarray(from), 2 ** -15 * peak(x))
    console.log(`  a 220 Hz tone hovering at 0.655 to 1.47 times 2^-15 of the call's peak, ${lab}: ${k} sound${k > 1 ? 's' : ''}, its level ${span(lv)} re its input (±5 st)`)
  }
}
