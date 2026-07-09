// Measure the structural latency the atom manifests declare (shift-pvoc, shift-formant):
// feed a tone burst through the streaming writer at ratio () => 1 (function form defeats
// the identity shortcut), cross-correlate output vs input short-window RMS envelopes, and
// cross-check with input/output sample-count bookkeeping (steady-state deficit before
// flush). Expected: lag ≈ deficit = 2048 = 1× frameSize = 4× hopSize, block-size-invariant.
//
//   node scripts/atom-latency.js

import vocoder from '@audio/shift-pvoc'
import formant from '@audio/shift-formant'

const SR = 44100

function burst(n, sr = SR) {
  const d = new Float32Array(n)
  const from = Math.round(0.3 * sr), to = Math.round(0.6 * sr)
  for (let i = from; i < to; i++) d[i] = 0.8 * Math.sin(2 * Math.PI * 1000 * i / sr)
  return d
}

function envelope(d, win = 64) {
  const n = Math.floor(d.length / win), e = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i * win; j < (i + 1) * win; j++) s += d[j] * d[j]
    e[i] = Math.sqrt(s / win)
  }
  return e
}

function envLag(out, inp, win = 64, maxLag = 8192) {
  const eo = envelope(out, win), ei = envelope(inp, win)
  let best = -Infinity, bestLag = 0
  for (let lag = 0; lag * win <= maxLag; lag++) {
    let s = 0
    const n = Math.min(eo.length - lag, ei.length)
    for (let i = 0; i < n; i++) s += eo[i + lag] * ei[i]
    if (s > best) { best = s; bestLag = lag }
  }
  return bestLag * win
}

function measure(name, kernel) {
  for (const block of [128, 512, 1024, 4096]) {
    const inp = burst(SR)
    const writer = kernel({ ratio: () => 1, fs: SR, sampleRate: SR })
    const chunks = []
    let emitted = 0, consumed = 0
    for (let off = 0; off < inp.length; off += block) {
      const chunk = inp.subarray(off, Math.min(off + block, inp.length))
      const out = writer(chunk)
      consumed += chunk.length
      if (out?.length) { chunks.push(out); emitted += out.length }
    }
    const deficit = consumed - emitted
    const flushed = writer()
    if (flushed?.length) { chunks.push(flushed); emitted += flushed.length }
    const out = new Float32Array(emitted)
    let o = 0
    for (const c of chunks) { out.set(c, o); o += c.length }
    console.log(`${name} block=${block}: envLag≈${envLag(out, inp)} deficit=${deficit} totalOut=${emitted}/${consumed}`)
  }
}

measure('pvoc', vocoder)
measure('formant', formant)
