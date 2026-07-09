// atom manifest — wraps the paulstretch-style pitch shift per @audio/atom CONTRACT.
// The kernel is genuinely whole-signal: matchPeak needs the entire output's peak
// before it can scale one sample (batch/stream gains would otherwise diverge — see
// index.js), so the kernel's own stream form is bufferedStream. Declared
// streaming: false: the host buffers the full input and calls process once — exactly
// the batch shape the kernel expects. No latency bookkeeping exists in this mode.
//
// The ratio is passed in function form even when constant — defeating the ratio-1
// identity shortcut so `semitones: 0` still applies the signature randomized-phase
// texture smear (the reason to reach for paulstretch) instead of passing through.
// `frame` (seconds) is rounded to the nearest power-of-2 FFT size; larger frames push
// the frame-rate envelope modulation lower (see index.js) and smear transients more.

import paulFn from './index.js'

export const paulstretch = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const r = 2 ** (params.semitones[0] / 12)
		const frameSize = 2 ** Math.round(Math.log2(params.frame[0] * ctx.sampleRate))
		for (let c = 0; c < inp.length; c++) {
			out[c].set(paulFn(inp[c], {
				ratio: () => r,
				frameSize,
				sampleRate: ctx.sampleRate, fs: ctx.sampleRate,
			}))
		}
	}
}
paulstretch.channels = 'any'
paulstretch.streaming = false
paulstretch.tail = 0
paulstretch.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0 },
	frame:     { type: 'number', min: 0.05, max: 2, default: 0.37, unit: 's' },
}
