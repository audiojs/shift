// audio manifest — this one pitch shift per @audio/compile CONTRACT (linear prediction: a voice's formants kept), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchLpc = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		for (let c = 0; c < inp.length; c++) out[c].set(shift(inp[c], { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate }))
	}
}
pitchLpc.channels = 'any'
pitchLpc.streaming = false
pitchLpc.tail = 0
pitchLpc.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0 },
}
