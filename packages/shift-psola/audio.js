// audio manifest — this one pitch shift per @audio/compile CONTRACT (pitch-synchronous grains: one voice), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchPsola = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchPsola.channels = 'any'
pitchPsola.streaming = false
// The kernel stretches the take followed by silence of its own, never the call's, so a host's padding moves nothing
// over the take, and the take's ring past it is rendered. Where the stretch finds no pitch it is WSOLA, which sounds
// longest past the take: @audio/stretch-wsola 1 (grains of N = 2048 frames heard at 1/ratio their speed, read up to N/4
// early: N/4 + N(1/ratio − 1) frames past the take shifted down, N/4 shifted up, the resampler's 8 taps a side beside)
// or 2 (segments of 1764 frames, its geometry at 44.1 kHz as stretch-psola calls it at every rate, read up to 353
// early, each half-segment heard 882·|1 − 1/ratio| frames off), whichever @audio/stretch-psola has; the longer, a
// frame's rounding beside. The pitch-synchronous grains end sooner: the frames of their last period ring under these.
// None at a ratio of 1, which passes the input
const N = 2048, DELTA = N >> 2
pitchPsola.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	if (r === 1) return 0
	let wsola1 = DELTA + Math.max(8, (N + 8) / r - N), wsola2 = 353 + 882 * Math.abs(1 - 1 / r) + 8
	return (Math.max(wsola1, wsola2) + 4) / sampleRate
}
pitchPsola.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
