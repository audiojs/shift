// atom manifest — wraps the phase-vocoder pitch shift per @audio/atom CONTRACT.
// The kernel streams (stftStream writer), but write(chunk) returns variable-length
// bursts (frame/hop bookkeeping is not 1:1 with input chunking) — a per-channel FIFO
// absorbs that into the fixed equal-frames-in/out shape §process requires, at a fixed
// extra delay. Measured end-to-end through this manifest (tone-burst envelope
// cross-correlation at ratio 1, blocks 128–4096): 2048 samples = 1× frameSize =
// 4× hopSize, block-size-invariant, confirmed independently by input/output
// sample-count bookkeeping (steady-state deficit 2048).
//
// `semitones` is live: the writer is constructed with a function ratio (the kernel
// samples it per analysis frame via makeFrameRatio), reading a cell this manifest
// updates from the per-block params — no reconstruction on change. The function
// form also defeats the ratio-1 identity shortcut, keeping latency constant.

import vocoderFn from './index.js'

const FRAME = 2048, HOP = 512
const LATENCY = 2048

function makeFifo() { return { buf: new Float32Array(1 << 14), len: 0 } }
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
