// audio manifest — this one pitch shift per @audio/compile CONTRACT (plain overlap-add: the cheapest, for speech previews), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchOla = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchOla.channels = 'any'
pitchOla.streaming = false
// Shifted down, the last grain wholly in the take (N = 2048 frames, the kernel's grain at every rate) is heard at
// 1/ratio its speed and ends N(1/ratio − 1) frames past the take, the resampler's 8 taps a side and a frame's rounding
// beside; shifted up nothing passes the end, and a ring of 128 frames or less needs no tail. The kernel stretches the
// take and silence of its own, never the call's, so a host's padding moves nothing over the take
const N = 2048
pitchOla.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1, f = (N + 8) / r - N + 4
	return f > 128 ? f / sampleRate : 0
}
pitchOla.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
