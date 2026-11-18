// audio manifest — this one pitch shift per @audio/compile CONTRACT (modulated delay lines: small shifts, low latency), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchDelay = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchDelay.channels = 'any'
pitchDelay.streaming = false
// Two taps read the take at a lag from the write head, each lag sweeping the window W (2048 at every rate) at 1 − ratio
// a frame from where its splice put it, up to L = W/4 either side: up to W + L frames late shifted down, L shifted up
// (the tap reading ahead), the sinc read's ceil(8·max(1, ratio)) taps beside; none at a ratio of 1. A read past the
// take reads silence, so a host's padding moves nothing over the take
const W = 2048, L = W >> 2
pitchDelay.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	return r === 1 ? 0 : ((r < 1 ? W + L : L) + Math.ceil(8 * Math.max(1, r)) + 1) / sampleRate
}
pitchDelay.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
