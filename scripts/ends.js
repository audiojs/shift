// What the whole-signal shifters render where a take ends: the figures the READMEs of ola, wsola and lpc quote, each
// over the sample named beside it. `node scripts/ends.js [fade] [lead] [lpc]`, all three by default.
//   fade  ola and wsola shifted up: the last 1024 frames of the output against its central half, net of the input's own
//   lead  ola and wsola: how far the output's envelope runs ahead of the input's (negative) or behind it
//   lpc   a stop at the end of the call against a stop mid-take, a channel that ends early, dither and a click after it;
//         the ring where the delay line stops exciting the filter; pure tones
// The voice is audio-lena (a sung voice, 44.1 kHz) resampled to each rate.

import { ola, wsola, lpc } from '../index.js'
import { resampleTo } from '@audio/resample-sinc'
import lenaRaw from 'audio-lena/raw'

const RATES = [22050, 44100, 96000]
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['fade', 'lead', 'lpc']
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
// before that sound, which the delay line reads ahead), in the right channel of two stopped 0.2 s before the left,
// into 16-bit TPDF dither in place of zeros, and with a click of 0.5 2000 frames after the take (over the take)
if (parts.includes('lpc')) {
  const RATES4 = [22050, 44100, 48000, 96000]
  let pad = (x, n) => { let y = new Float32Array(n); y.set(x); return y }
  let differ = (a, b, to) => { for (let i = 0; i < to; i++) if (a[i] !== b[i]) return 1; return 0 }
  let end = [Infinity, -Infinity], other = { mid: 0, channel: 0, dither: 0, click: 0 }, count = 0
  for (let sig of ['voice', 'tone']) for (let sr of RATES4) for (let st of [-12, -5, 5, 12]) {
    let s = Math.round(0.5 * sr), g = Math.round(0.3 * sr), c = Math.round(0.2 * sr), v = voice(sr), e = 3 * sr
    while (rms(v, e - 256, e) < 0.05) e += 97
    let take = sig === 'tone' ? tone(s, sr, 220, 0.4) : v.slice(e - s, e), next = sig === 'tone' ? tone(s, sr, 330, 0.4) : v.slice(8 * sr, 8 * sr + s)
    let N = s + g + s + sr, opts = { semitones: st, sampleRate: sr }, alone = pad(take, N), u = lcg(5)
    let mid = alone.slice(); mid.set(next, s + g)
    let dith = alone.slice(); for (let i = s; i < N; i++) dith[i] = (u() - u()) / 32768
    let click = alone.slice(); click[s + 2000] = 0.5
    let left = pad(sig === 'tone' ? tone(s + c, sr, 220, 0.4) : v.slice(e - s, e + c), N)
    let y = lpc(alone, opts), after = rms(y, s, s + 1024) / rms(y, s - 1024, s)
    widen(end, after ? db(after) : -Infinity)
    other.mid += differ(y, lpc(mid, opts), s + g - 4096)
    other.channel += differ(y, lpc([left, alone], opts)[1], N)
    other.dither += differ(y, lpc(dith, opts), N)
    other.click += differ(y, lpc(click, opts), s)
    count++
  }
  console.log(`lpc: a stop (${count} renders a case: the voice and a tone, 22.05/44.1/48/96 kHz, -12/-5/+5/+12 st)`)
  console.log(`  the 1024 frames after the stop at the call's end re the 1024 before it: ${end[0] === -Infinity ? 'exact zeros' : end[0].toFixed(1) + ' dB'} to ${end[1].toFixed(1)} dB`)
  console.log(`  the take and its ring written otherwise: at a stop mid-take ${other.mid}, in a channel ending 0.2 s early ${other.channel}, into 16-bit dither ${other.dither}; the take, with a click 2000 frames after it ${other.click}`)
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
}
