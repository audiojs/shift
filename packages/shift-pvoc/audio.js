// audio manifest — wraps the phase-vocoder pitch shift per @audio/compile CONTRACT.
// The kernel streams (stftStream writer), but write(chunk) returns variable-length
// bursts: fourier-transform/stft holds a sample back at most FRAME samples, with output
// sample j aligned to input sample j. A per-channel FIFO primed with FRAME zeros turns
// the bursts into the fixed equal-frames-in/out shape §process requires: it never runs
// dry, so the delay is exactly FRAME under any block size (pinned in test.js).
//
// `semitones` is live: the writer is constructed with a function ratio (the kernel
// samples it per analysis frame via makeFrameRatio), reading a cell this manifest
// updates from the per-block params — no reconstruction on change. The function
// form also defeats the ratio-1 identity shortcut, keeping latency constant.

import vocoderFn from './index.js'

const FRAME = 2048, HOP = 512
const LATENCY = FRAME

// A FIFO on an array made for the most a call brings, primed with zeros; loops and copyWithin, as a subarray view is an
// allocation a call
function makeFifo(max) { return { buf: new Float32Array(LATENCY + max), len: LATENCY } }
function fifoPush(f, src, n) {
	for (let i = 0; i < n; i++) f.buf[f.len + i] = src[i]
	f.len += n
}
function fifoPull(f, out) {
	let n = Math.min(out.length, f.len), b = f.buf
	for (let i = 0; i < n; i++) out[i] = b[i]
	out.fill(0, n)
	b.copyWithin(0, n, f.len); f.len -= n
}

export const vocoder = (ctx) => {
	const cell = { r: 2 ** (ctx.params.semitones[0] / 12) }
	const ratio = () => cell.r
	const chans = []
	for (let c = 0, N = ctx.maxChannels ?? 8; c < N; c++) {
		chans.push({
			write: vocoderFn({ ratio, frameSize: FRAME, hopSize: HOP, sampleRate: ctx.sampleRate, fs: ctx.sampleRate }),
			fifo: makeFifo(ctx.maxBlockSize + 1)   // a write gives a block and a sample at most
		})
	}
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		cell.r = 2 ** (params.semitones[0] / 12)
		for (let c = 0; c < inp.length; c++) {
			const ch = chans[c]
			const y = ch.write(inp[c])
			fifoPush(ch.fifo, y, y.length)
			fifoPull(ch.fifo, out[c])
		}
	}
}
vocoder.channels = 'any'
vocoder.latency = LATENCY
// a frame that read the input's last sample spreads what it carries over all its FRAME samples, and the frames after read
// silence and give silence: the output ends FRAME − 1 samples past the latency
vocoder.tail = ({ sampleRate }) => (FRAME - 1) / sampleRate
vocoder.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st', smoothing: 0.01 },
}
