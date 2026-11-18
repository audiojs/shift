// audio manifest — this one pitch shift per @audio/compile CONTRACT (harmonic and percussive parts apart: mixed material), so a host loads it
// alone: @audio/shift's pitch-shift chooses among every method and loads them all. Whole-render (streaming: false), as
// that umbrella hosts every method: the host buffers the input and calls process once.

import shift from './index.js'

export const pitchHpss = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const y = shift(inp, { semitones: params.semitones[0], sampleRate: ctx.sampleRate, fs: ctx.sampleRate })
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchHpss.channels = 'any'
pitchHpss.streaming = false
// A frame of N = 2048 (the kernel's frameSize at every rate) moves the harmonic part's bins and passes the percussive
// part, not time: the frame that holds the take's last frame writes back over the N frames it read, N − 1 past the
// take, and a frame of silence writes silence; none at a ratio of 1. Its time median counts frames of silence of its
// own past the call's, as a host's padding frames them, so the padding moves nothing over the take
const N = 2048
pitchHpss.tail = ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	return r === 1 ? 0 : (N - 1) / sampleRate
}
pitchHpss.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
}
