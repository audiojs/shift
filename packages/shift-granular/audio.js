// audio manifest — this one pitch shift per @audio/compile CONTRACT (grains: textures, a shimmer), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchGranular = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchGranular.channels = 'any'
pitchGranular.streaming = false
// A grain of G = 398 output frames (the kernel's grainSize at every rate) reads G·ratio input frames from its own place:
// shifted down the take's last frame is heard up to (G − 1)(1 − ratio) frames after it, the sinc read's 8 taps and a
// frame's rounding beside; shifted up, sooner, and a ring of 128 frames or less needs no tail. A read past the take
// reads silence, so a host's padding moves nothing over the take
const G = 398
pitchGranular.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1, f = (G - 1) * Math.max(0, 1 - r) + 9
	return f > 128 ? f / sampleRate : 0
}
pitchGranular.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
