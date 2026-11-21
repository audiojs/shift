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
import { pitchOla } from '@audio/shift-ola/audio'
import { pitchTransient } from '@audio/shift-transient/audio'
import { pitchPsola } from '@audio/shift-psola/audio'
import { pitchWsola } from '@audio/shift-wsola/audio'
import { pitchGranular } from '@audio/shift-granular/audio'
import { pitchSms } from '@audio/shift-sms/audio'
import { pitchHpss } from '@audio/shift-hpss/audio'
import { pitchSample } from '@audio/shift-sample/audio'
import { pitchHybrid } from '@audio/shift-hybrid/audio'
import { pitchDelay } from '@audio/shift-delay/audio'
import { pitchLpc } from '@audio/shift-lpc/audio'

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
		const y = pitchShiftFn(inp, opts)
		for (let c = 0; c < inp.length; c++) out[c].set(y[c])
	}
}
pitchShift.channels = 'any'
pitchShift.streaming = false
// The tail of the method in force: its own manifest's, read as a host reads one (a number, or a function of the
// setting), the kernel being called as there; for the STFT kernels with no manifest of that form, the frame that holds
// the take's last frame, ending N − 1 past it (vocoder, phase-lock and formant N = 2048, paulstretch 16384); none at a
// ratio of 1. Padding by it moves nothing over the take but with paulstretch, whose level match takes the peak of the
// whole call, the ring the padding renders with it, which on a take shorter than about its frame can be the louder
const frame = N => ({ sampleRate, params }) => {
	let st = params.semitones[0], r = st ? Math.pow(2, st / 12) : 1
	return r === 1 ? 0 : (N - 1) / sampleRate
}
const TAILS = {
	ola: pitchOla.tail, transient: pitchTransient.tail, psola: pitchPsola.tail, wsola: pitchWsola.tail,
	granular: pitchGranular.tail, sms: pitchSms.tail, hpss: pitchHpss.tail, sample: pitchSample.tail,
	hybrid: pitchHybrid.tail, delay: pitchDelay.tail, lpc: pitchLpc.tail,
	vocoder: frame(2048), 'phase-lock': frame(2048), formant: frame(2048), paulstretch: frame(16384),
}
// the method pitch-shift.js runs: formant's where `formant` is set, the named one, else by content (voice: psola,
// tonal: sms, any: transient)
const methodOf = p => p.formant ? 'formant' : p.method !== 'auto' ? p.method : p.content === 'voice' ? 'psola' : p.content === 'tonal' ? 'sms' : 'transient'
pitchShift.tail = s => { let t = TAILS[methodOf(s.params)]; return typeof t === 'function' ? t(s) : t }
pitchShift.params = {
	semitones: { type: 'number', min: -24, max: 24, default: 0, unit: 'st' },
	method:    { type: 'enum', values: METHODS, default: 'auto' },
	content:   { type: 'enum', values: ['any', 'voice', 'tonal'], default: 'any' },
	formant:   { type: 'bool', default: false },
}

// The family's other manifests, each member's own /audio entry under its names: a member is a package of packages/
// the umbrella depends on that has an audio.js (test.js holds this list to them)
export * from '@audio/shift-delay/audio'
export * from '@audio/shift-formant/audio'
export * from '@audio/shift-granular/audio'
export * from '@audio/shift-hpss/audio'
export * from '@audio/shift-hybrid/audio'
export * from '@audio/shift-lpc/audio'
export * from '@audio/shift-ola/audio'
export * from '@audio/shift-paulstretch/audio'
export * from '@audio/shift-psola/audio'
export * from '@audio/shift-pvoc/audio'
export * from '@audio/shift-sample/audio'
export * from '@audio/shift-sms/audio'
export * from '@audio/shift-transient/audio'
export * from '@audio/shift-wsola/audio'
