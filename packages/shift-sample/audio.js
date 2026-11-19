// audio manifest — this one pitch shift per @audio/compile CONTRACT (played back faster or slower and stretched back: a sampler's shift), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchSample = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchSample.channels = 'any'
pitchSample.streaming = false
// Shifted down, frame t of the take is heard at t/ratio: past its end sounds the take itself, slowed, (1/ratio − 1)
// times as long as the take, which no tail of the setting bounds: Infinity. A host that keeps a shift's length cuts the
// slowed take at the take's length; one that renders an endless tail renders more of it. Shifted up the take is heard
// sooner and nothing passes its end. A read past the take reads silence, so silence after it moves nothing over the take
pitchSample.tail = ({ params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	return r < 1 ? Infinity : 0
}
pitchSample.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
