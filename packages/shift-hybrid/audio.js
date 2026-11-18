// audio manifest — this one pitch shift per @audio/compile CONTRACT (tonal and transient parts each their own way: full mixes), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchHybrid = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchHybrid.channels = 'any'
pitchHybrid.streaming = false
// The longer of its engines' rings: the peak-locked vocoder's frame of N = 2048, which writes over the N frames it read,
// N − 1 past the take; WSOLA's (@audio/shift-wsola at its defaults: DELTA + N(1/ratio − 1) shifted down, DELTA = N/4
// shifted up, the resampler's 8 taps and a frame's rounding beside), moved up to LAG = 1.5·DELTA later by the blend's
// alignment; none at a ratio of 1. Lag and trust are measured over the take, so a host's padding moves nothing over it
const N = 2048, DELTA = N >> 2, LAG = Math.round(1.5 * DELTA)
pitchHybrid.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	return r === 1 ? 0 : Math.max(N - 1, DELTA + Math.max(8, (N + 8) / r - N) + 4 + LAG) / sampleRate
}
pitchHybrid.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
