// audio manifest — wraps the auto-selecting pitch shift (umbrella entry) per
// @audio/compile CONTRACT. Method selection is the umbrella's whole point — explicit
// `method`, or `content` hints (voice → psola, tonal → sms), falling back to
// transient. Several selectable methods are themselves whole-signal (paulstretch,
// hpss, hybrid, sample; psola/wsola/ola/granular stream via buffered batch too), so
// the only shape that hosts every method uniformly is the batch call — declared
// streaming: false: the host buffers the full input and calls process once. For a
// streaming pitch shift with fixed latency, use @audio/shift-pvoc/audio (vocoder) or
// @audio/shift-formant/audio (formant-shift) directly.
//
// `formant: true` conflicts with an explicit method by kernel design (fail-loud,
// see pitch-shift.js) — the conflict surfaces as the render error it is.

import pitchShiftFn from './pitch-shift.js'

const METHODS = ['auto', 'ola', 'vocoder', 'phase-lock', 'transient', 'formant',
	'psola', 'wsola', 'granular', 'paulstretch', 'sms', 'hpss', 'sample', 'hybrid', 'delay', 'lpc']

export const pitchShift = (ctx) => {
	return (inputs, outputs, params) => {
		const inp = inputs[0], out = outputs[0]
		if (!inp || !inp.length) return
		const opts = {
			semitones: params.semitones[0],
			sampleRate: ctx.sampleRate, fs: ctx.sampleRate,
		}
		if (params.method !== 'auto') opts.method = params.method
		if (params.content !== 'any') opts.content = params.content
		if (params.formant) opts.formant = true
		for (let c = 0; c < inp.length; c++) out[c].set(pitchShiftFn(inp[c], opts))
	}
}
pitchShift.channels = 'any'
pitchShift.streaming = false
pitchShift.tail = 0
pitchShift.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0 },
	method:    { type: 'enum', values: METHODS, default: 'auto' },
	content:   { type: 'enum', values: ['any', 'voice', 'tonal'], default: 'any' },
	formant:   { type: 'bool', default: false },
}
