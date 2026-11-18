// What the whole-signal shifters render where a take ends: the figures the READMEs of ola, wsola and lpc quote, each
// over the sample named beside it. `node scripts/ends.js [fade] [lead] [lpc]`, all three by default.
//   fade  ola and wsola shifted up: the last 1024 frames of the output against its central half, net of the input's own
//   lead  ola and wsola: how far the output's envelope runs ahead of the input's (negative) or behind it
//   lpc   the ring after a stop at the end of the call, at a stop mid-take and in a channel that ends early; pure tones
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

// lpc fits silence as A(z) = 1, and past the call's last sound draws its poles in instead. Each take 0.5 s, the voice cut
// where it is loud (at 3 s on) or a 220 Hz tone at 0.4, at -12/-5/+5/+12 st: the output over the 1024 frames after the
// stop re the 1024 before it, where the stop ends the call, where 0.3 s of exact zeros and more sound follow it, and in
// the right channel of two stopped 0.2 s before the left. Then pure tones at 0.5, 0.25 s, 250 Hz to 4 kHz, ±5 st: the
// output's peak over the input's, over the middle half and over the first 4096 frames, and the level over the take,
// which the level match corrects only within 0.1 to 10 times the input's
if (parts.includes('lpc')) {
  let pad = (x, n) => { let y = new Float32Array(n); y.set(x); return y }
  let after = (y, s) => { let v = rms(y, s, s + 1024) / rms(y, s - 1024, s); return v ? db(v) : -Infinity }
  let cases = { end: [Infinity, -Infinity], mid: [Infinity, -Infinity], channel: [Infinity, -Infinity] }, under = { mid: 0, channel: 0 }, count = 0
  for (let sig of ['voice', 'tone']) for (let sr of RATES) for (let st of [-12, -5, 5, 12]) {
    let s = Math.round(0.5 * sr), g = Math.round(0.3 * sr), c = Math.round(0.2 * sr), v = voice(sr), e = 3 * sr
    while (rms(v, e - 256, e) < 0.05) e += 97
    let take = sig === 'tone' ? tone(s + c, sr, 220, 0.4) : v.slice(e - s, e + c), next = sig === 'tone' ? tone(s, sr, 330, 0.4) : v.slice(8 * sr, 8 * sr + s)
    let N = s + g + s + sr, opts = { semitones: st, sampleRate: sr }
    let alone = pad(take.subarray(0, s), N), mid = alone.slice(); mid.set(next, s + g)
    let rows = { end: lpc(alone, opts), mid: lpc(mid, opts), channel: lpc([pad(take, N), alone], opts)[1] }, at = {}
    for (let k in rows) { at[k] = after(rows[k], s); widen(cases[k], at[k]) }
    for (let k in under) if (at[k] <= at.end - 40) under[k]++
    count++
  }
  let say = (k) => `${cases[k][0] === -Infinity ? 'exact zeros' : cases[k][0].toFixed(1) + ' dB'} to ${cases[k][1].toFixed(1)} dB`
  console.log(`lpc: the 1024 frames after a stop re the 1024 before it (${count} renders a case, the voice and a tone, 22.05/44.1/96 kHz, -12/-5/+5/+12 st)`)
  console.log(`  at the end of the call ${say('end')}; at a stop mid-take ${say('mid')}, 40 dB or more under the end's in ${under.mid}; in a channel ending 0.2 s early ${say('channel')}, 40 dB or more under in ${under.channel}`)
  let body = [0, ''], start = 0, off = [Infinity, -Infinity], kept = 0, tones = 0
  for (let sr of RATES) for (let f of [250, 500, 1000, 2000, 3000, 4000]) for (let st of [5, -5]) {
    let n = Math.round(0.25 * sr), x = tone(n, sr, f, 0.5), y = lpc(x, { semitones: st, sampleRate: sr }), b = peak(y, n >> 2, n - (n >> 2)) / 0.5, l = db(rms(y) / rms(x))
    if (b > body[0]) body = [b, `${f} Hz, ${sr} Hz, ${st} st`]
    start = Math.max(start, peak(y, 0, 4096) / 0.5)
    widen(off, l)
    if (Math.abs(l) > 20) kept++
    tones++
  }
  console.log(`  pure tones (${tones}): the peak over the input's up to ${body[0].toFixed(1)}× over the middle half (${body[1]}), ${start.toFixed(1)}× over the first 4096 frames; the level over the take ${span(off)}, more than 20 dB off the input's in ${kept}`)
}
