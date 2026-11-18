// audio manifest — this one pitch shift per @audio/compile CONTRACT (waveform-similarity overlap-add: speech), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchWsola = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchWsola.channels = 'any'
pitchWsola.streaming = false
// A grain (N = 2048 frames, at every rate) is heard at 1/ratio its speed and read up to DELTA = N/4 early, which plays
// it as much later: the last ends DELTA + N(1/ratio − 1) frames past the take shifted down, DELTA shifted up, the
// resampler's 8 taps a side and a frame's rounding beside; none at a ratio of 1. The kernel stretches the take and
// silence of its own, never the call's, so a host's padding moves nothing over the take
const N = 2048, DELTA = N >> 2
pitchWsola.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	return r === 1 ? 0 : (DELTA + Math.max(8, (N + 8) / r - N) + 4) / sampleRate
}
pitchWsola.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
