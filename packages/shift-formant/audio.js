// audio manifest — wraps the formant-preserving pitch shift per @audio/compile CONTRACT.
// Same FIFO adaptation as @audio/shift-pvoc/audio (stftStream writer bursts → fixed
// equal-frames blocks): measured end-to-end through this manifest (tone-burst envelope
// cross-correlation at ratio 1, blocks 128–4096): 2048 samples = 1× frameSize =
// 4× hopSize, block-size-invariant, confirmed by steady-state sample-count deficit.
//
// `semitones` is live via a function ratio the kernel samples per analysis frame; the
// cepstral envelope is re-extracted every frame, so vowel timbre stays put while pitch
// moves. The function form also defeats the ratio-1 identity shortcut.

import formantFn from './index.js'

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

export const formantShift = (ctx) => {
	const cell = { r: 2 ** (ctx.params.semitones[0] / 12) }
	const ratio = () => cell.r
	const chans = []
	for (let c = 0, N = ctx.maxChannels ?? 8; c < N; c++) {
		chans.push({
			write: formantFn({ ratio, frameSize: FRAME, hopSize: HOP, sampleRate: ctx.sampleRate, fs: ctx.sampleRate }),
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
formantShift.channels = 'any'
formantShift.latency = LATENCY
formantShift.tail = 0
formantShift.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, smoothing: 0.01 },
}
