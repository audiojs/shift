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

function makeFifo() { return { buf: new Float32Array(1 << 14), len: LATENCY } }   // primed with zeros
function fifoPush(f, chunk) {
	if (!chunk.length) return
	let need = f.len + chunk.length
	if (need > f.buf.length) {
		let nb = new Float32Array(Math.max(need * 2, f.buf.length * 2))
		nb.set(f.buf.subarray(0, f.len)); f.buf = nb
	}
	f.buf.set(chunk, f.len); f.len += chunk.length
}
function fifoPull(f, out) {
	let n = out.length
	if (f.len >= n) { out.set(f.buf.subarray(0, n)); f.buf.copyWithin(0, n, f.len); f.len -= n }
	else { out.set(f.buf.subarray(0, f.len)); out.fill(0, f.len); f.len = 0 }
}

export const vocoder = (ctx) => {
	const cell = { r: 2 ** (ctx.params.semitones[0] / 12) }
	const ratio = () => cell.r
	const chans = []
	for (let c = 0, N = ctx.maxChannels ?? 8; c < N; c++) {
		chans.push({
			write: vocoderFn({ ratio, frameSize: FRAME, hopSize: HOP, sampleRate: ctx.sampleRate, fs: ctx.sampleRate }),
			fifo: makeFifo()
		})
	}
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		cell.r = 2 ** (params.semitones[0] / 12)
		for (let c = 0; c < inp.length; c++) {
			const ch = chans[c]
			fifoPush(ch.fifo, ch.write(inp[c]))
			fifoPull(ch.fifo, out[c])
		}
	}
}
vocoder.channels = 'any'
vocoder.latency = LATENCY
vocoder.tail = 0
vocoder.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, smoothing: 0.01 },
}
