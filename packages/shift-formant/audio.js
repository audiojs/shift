// audio manifest — wraps the formant-preserving pitch shift per @audio/compile CONTRACT.
// Same primed FIFO as @audio/shift-pvoc/audio (stftStream writer bursts → fixed
// equal-frames blocks): a constant FRAME delay under any block size.
//
// `semitones` is live via a function ratio the kernel samples per analysis frame; the
// cepstral envelope is re-extracted every frame, so vowel timbre stays put while pitch
// moves. The function form also defeats the ratio-1 identity shortcut.

import formantFn from './index.js'

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

export const formantShift = (ctx) => {
	const cell = { r: 2 ** (ctx.params.semitones[0] / 12) }
	const ratio = () => cell.r
	const chans = []
	for (let c = 0, N = ctx.maxChannels ?? 8; c < N; c++) {
		chans.push({
			write: formantFn({ ratio, frameSize: FRAME, hopSize: HOP, sampleRate: ctx.sampleRate, fs: ctx.sampleRate }),
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
formantShift.channels = 'any'
formantShift.latency = LATENCY
// a frame that read the input's last sample spreads what it carries over all its FRAME samples, and the frames after read
// silence and give silence: the output ends FRAME − 1 samples past the latency
formantShift.tail = ({ sampleRate }) => (FRAME - 1) / sampleRate
formantShift.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st', smoothing: 0.01 },
}
