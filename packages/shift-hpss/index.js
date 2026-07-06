import { fft, ifft } from 'fourier-transform'
import { winSqFloor } from '@audio/shift-core/stft'
import { PI2, hannWindow, makeFrameRatio, scatterGated, wrapPhase, makePitchShift, resolveRatio, bufferedStream } from '@audio/shift-core'

// Harmonic/Percussive Source Separation (Fitzgerald 2010) + per-component pitch shift.
//
// Canonical form:
//   1. STFT analysis → magnitude spectrogram |X|.
//   2. Time-axis median filter  (per-bin, across frames)   → Mh, a harmonic-friendly view.
//   3. Freq-axis median filter  (per-frame, across bins)  → Mp, a percussive-friendly view.
//   4. Soft Wiener-style mask at exponent `power`:
//        Hk = Mh^p / (Mh^p + Mp^p),   Pk = Mp^p / (Mh^p + Mp^p)
//   5. Harmonic component Xh = Hk · X is shifted with the peak-gated scatter (`scatterGated`,
//      same energy-domain kernel shift-pvoc uses — identical pattern by construction).
//   6. Percussive component Xp = Pk · X passes through with its original phase, preserving
//      attack localization exactly.
//   7. Output = iSTFT(Xh_shifted) + iSTFT(Xp).
//
// Transients survive unmoved; tonals shift in pitch. A purely harmonic signal behaves like
// the vocoder; a purely percussive signal passes through untouched. Loudness is preserved
// by construction (scatterGated's own energy conservation on Xh + untouched Xp), so no
// whole-signal matchGain correction is applied.

function medianSort(buf, len) {
  let arr = buf.subarray(0, len)
  // Insertion sort — small windows (~17), faster than generic sort on TypedArrays.
  for (let i = 1; i < len; i++) {
    let v = arr[i], j = i - 1
    while (j >= 0 && arr[j] > v) { arr[j + 1] = arr[j]; j-- }
    arr[j + 1] = v
  }
  let m = len >> 1
  return len & 1 ? arr[m] : 0.5 * (arr[m - 1] + arr[m])
}

function hpssBatch(data, opts) {
  let { ratio, ratioFn } = resolveRatio(opts)
  let N = opts?.frameSize ?? 2048
  let hop = opts?.hopSize ?? (N >> 2)
  let half = N >> 1
  let bins = half + 1
  let kTime = opts?.hpssTimeWidth ?? 17
  let kFreq = opts?.hpssFreqWidth ?? 17
  if ((kTime & 1) === 0) kTime += 1
  if ((kFreq & 1) === 0) kFreq += 1
  let power = opts?.hpssPower ?? 2
  let win = hannWindow(N)
  let freqPerBin = PI2 / N
  let sr = opts?.sampleRate || 44100
  let fr = makeFrameRatio(ratioFn || ratio)

  let pad = N
  let padded = new Float32Array(data.length + pad * 2)
  padded.set(data, pad)
  let nFrames = Math.max(1, Math.floor((padded.length - N) / hop) + 1)

  // Analyze all frames into flat mag/phase spectrogram buffers, frame-major (stride=bins).
  let magM = new Float64Array(nFrames * bins)
  let phM = new Float64Array(nFrames * bins)
  let scratch = new Float64Array(N)
  for (let f = 0; f < nFrames; f++) {
    let pos = f * hop
    for (let i = 0; i < N; i++) scratch[i] = (padded[pos + i] || 0) * win[i]
    let [re, im] = fft(scratch)
    let base = f * bins
    for (let k = 0; k < bins; k++) {
      magM[base + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      phM[base + k] = Math.atan2(im[k], re[k])
    }
  }

  // Time-axis median → harmonic estimate Mh.
  let Mh = new Float64Array(nFrames * bins)
  let rT = kTime >> 1
  let colBuf = new Float64Array(kTime)
  for (let k = 0; k < bins; k++) {
    for (let f = 0; f < nFrames; f++) {
      let c = 0
      let a = Math.max(0, f - rT)
      let b = Math.min(nFrames - 1, f + rT)
      for (let g = a; g <= b; g++) colBuf[c++] = magM[g * bins + k]
      Mh[f * bins + k] = medianSort(colBuf, c)
    }
  }

  // Freq-axis median → percussive estimate Mp.
  let Mp = new Float64Array(nFrames * bins)
  let rF = kFreq >> 1
  let rowBuf = new Float64Array(kFreq)
  for (let f = 0; f < nFrames; f++) {
    let base = f * bins
    for (let k = 0; k < bins; k++) {
      let c = 0
      let a = Math.max(0, k - rF)
      let b = Math.min(half, k + rF)
      for (let g = a; g <= b; g++) rowBuf[c++] = magM[base + g]
      Mp[base + k] = medianSort(rowBuf, c)
    }
  }

  // Per-frame: split via soft mask, scatter-shift H, pass-through P, resynth combined.
  let outPadded = new Float32Array(padded.length)
  let norm = new Float32Array(padded.length)
  let syn = new Float64Array(bins)
  let newMag = new Float64Array(bins)
  let newFreq = new Float64Array(bins)
  let peakMag = new Float64Array(bins)
  let hMag = new Float64Array(bins)
  let pMag = new Float64Array(bins)
  let re = new Float64Array(bins)
  let im = new Float64Array(bins)
  let ctx = { half, hop, freqPerBin, N }

  for (let f = 0; f < nFrames; f++) {
    let r = fr.at(f * hop - pad, sr)
    let base = f * bins

    for (let k = 0; k < bins; k++) {
      let mh = Mh[base + k], mp = Mp[base + k]
      let hp = power === 2 ? mh * mh : Math.pow(mh, power)
      let pp = power === 2 ? mp * mp : Math.pow(mp, power)
      let sum = hp + pp + 1e-12
      let maskH = hp / sum
      let m = magM[base + k]
      hMag[k] = m * maskH
      pMag[k] = m * (1 - maskH)
    }

    newMag.fill(0)
    newFreq.fill(0)
    peakMag.fill(0)

    let ph = phM.subarray(base, base + bins)
    let prevPh = f > 0 ? phM.subarray(base - bins, base) : null
    scatterGated(hMag, ph, prevPh, r, ctx, newMag, newFreq, peakMag)

    for (let k = 0; k < bins; k++) syn[k] = wrapPhase(syn[k] + newFreq[k] * hop)

    // Harmonic: scatter-shifted. Percussive: original phase, unshifted — attack
    // localization is exact because no bin ever leaves its analysis position.
    for (let k = 0; k < bins; k++) {
      re[k] = newMag[k] * Math.cos(syn[k]) + pMag[k] * Math.cos(ph[k])
      im[k] = newMag[k] * Math.sin(syn[k]) + pMag[k] * Math.sin(ph[k])
    }

    let sf = ifft(re, im)
    let pos = f * hop
    for (let i = 0; i < N; i++) {
      outPadded[pos + i] += sf[i] * win[i]
      norm[pos + i] += win[i] * win[i]
    }
  }

  let result = new Float32Array(data.length)
  let normFloor = winSqFloor(win, hop)
  for (let i = 0; i < data.length; i++) {
    let j = i + pad
    let n = norm[j] < normFloor ? normFloor : norm[j]
    result[i] = n > 1e-10 ? outPadded[j] / n : 0
  }
  return result
}

// Median filters need centered time windows — buffer input and run batch on flush.
let hpssStream = (opts) => bufferedStream(hpssBatch, opts)

export default makePitchShift(hpssBatch, hpssStream)
