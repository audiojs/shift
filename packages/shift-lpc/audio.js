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
// Past the take the input is silence and the residual stops with the take (A(z) = 1, a fit of silence); the delay line
// (@audio/shift-delay at its defaults, W 2048 and L W/4) plays it up to W + L frames late shifted down, L shifted up,
// the sinc read's ceil(8·max(1, ratio)) taps beside; and 1/A(z) runs on with its state, its poles widened B = 60 Hz
// more each frame of HOP = 256 (the kernel's frameSize/4 at every rate): frame q past the take scales a pole's radius
// by γ^q, γ = exp(−π·B/sampleRate), frame 0 keeping it, so J frames past the take the ring of a pole on the unit circle
// has fallen (π·B·HOP/sampleRate)·J(J − 1)/2 nepers. The tail adds J·HOP frames to the delay line's span, L = 2·HOP at
// the least, so over them, the delay line silent, that ring falls (π·B·HOP/sampleRate)·J(J + 1)/2 nepers at the least;
// J is the first to reach 120 dB, ln 10^6: from a pole on the unit circle and a ring 60 dB over the input (a pure tone
// through the unregularised fit renders up to 276 times its peak, +49 dB: scripts/ends.js lpc). None at a ratio of 1.
// Fit and level match stop at the take's last sound, so a host's padding moves nothing over the take
const W = 2048, L = W >> 2, HOP = 256, B = 60
pitchLpc.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	if (r === 1) return 0
	let k = Math.PI * B * HOP / sampleRate, J = 0
	while (k * J * (J + 1) / 2 < Math.log(1e6)) J++
	return ((r < 1 ? W + L : L) + Math.ceil(8 * Math.max(1, r)) + 1 + J * HOP) / sampleRate
}
pitchLpc.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
