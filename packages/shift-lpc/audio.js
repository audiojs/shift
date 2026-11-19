// audio manifest — this one pitch shift per @audio/compile CONTRACT (linear prediction: a voice's formants kept), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchLpc = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchLpc.channels = 'any'
pitchLpc.streaming = false
// Past the take the input is silence and its residual is silence's; the delay line (@audio/shift-delay at its defaults,
// W 2048 and L W/4) plays the take's up to W + L frames late shifted down, L shifted up, the sinc read's
// ceil(8·max(1, ratio)) taps beside: past those D frames nothing excites the filter. 1/A(z) runs on with its state,
// every pole's radius at most γ = 0.994 (the fit's bandwidth expansion) and scaled by a further exp(−π·B·q/sampleRate)
// in the kernel's frame q of HOP = 256 past the last with sound (B = 60 Hz, HOP its frameSize/4 at every rate), the
// frame of the last sound keeping it: t frames past the take q is ⌊t/HOP⌋ at the least, and the ring falls
// −ln γ + π·B·⌊t/HOP⌋/sampleRate nepers a frame at the least. The tail is D and the frames after it over which that ring
// falls 60 dB: from the input's level, under which it lies at D (scripts/ends.js lpc), to 60 dB under it. None at a
// ratio of 1. A host's padding is exact zeros, frames with nothing to fit, so it moves nothing over the take
const W = 2048, L = W >> 2, HOP = 256, B = 60, GAMMA = 0.994
pitchLpc.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	if (r === 1) return 0
	let t = (r < 1 ? W + L : L) + Math.ceil(8 * Math.max(1, r)) + 1, k = Math.PI * B / sampleRate, fall = 0
	while (fall < Math.log(1e3)) fall += -Math.log(GAMMA) + k * Math.floor(t++ / HOP)
	return t / sampleRate
}
pitchLpc.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
