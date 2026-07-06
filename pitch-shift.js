import {
  createChannelWriter, isChannelArray, mapInput, normalizeOptionsInput,
  passThroughWriter, resolveRatio,
} from '@audio/shift-core'
import formant from '@audio/shift-formant'
import ola from '@audio/shift-ola'
import vocoder from '@audio/shift-pvoc'
import phaseLock from '@audio/shift-pvoc-lock'
import transient from '@audio/shift-transient'
import psola from '@audio/shift-psola'
import wsola from '@audio/shift-wsola'
import granular from '@audio/shift-granular'
import paulstretch from '@audio/shift-paulstretch'
import sms from '@audio/shift-sms'
import hpss from '@audio/shift-hpss'
import sample from '@audio/shift-sample'
import hybrid from '@audio/shift-hybrid'
import delay from '@audio/shift-delay'
import lpc from '@audio/shift-lpc'

function selectMethod(opts) {
  if (typeof opts?.method === 'function') {
    return { fn: opts.method, name: opts.method.name || 'custom', reason: 'explicit-method' }
  }
  switch (opts?.method) {
    case 'ola': return { fn: ola, name: 'ola', reason: 'explicit-method' }
    case 'vocoder': return { fn: vocoder, name: 'vocoder', reason: 'explicit-method' }
    case 'phase-lock':
    case 'phaseLock': return { fn: phaseLock, name: 'phaseLock', reason: 'explicit-method' }
    case 'transient': return { fn: transient, name: 'transient', reason: 'explicit-method' }
    case 'formant': return { fn: formant, name: 'formant', reason: 'explicit-method' }
    case 'psola': return { fn: psola, name: 'psola', reason: 'explicit-method' }
    case 'wsola': return { fn: wsola, name: 'wsola', reason: 'explicit-method' }
    case 'granular': return { fn: granular, name: 'granular', reason: 'explicit-method' }
    case 'paulstretch': return { fn: paulstretch, name: 'paulstretch', reason: 'explicit-method' }
    case 'sms': return { fn: sms, name: 'sms', reason: 'explicit-method' }
    case 'hpss': return { fn: hpss, name: 'hpss', reason: 'explicit-method' }
    case 'sample': return { fn: sample, name: 'sample', reason: 'explicit-method' }
    case 'hybrid': return { fn: hybrid, name: 'hybrid', reason: 'explicit-method' }
    case 'delay': return { fn: delay, name: 'delay', reason: 'explicit-method' }
    case 'lpc': return { fn: lpc, name: 'lpc', reason: 'explicit-method' }
  }
  switch (opts?.content) {
    case 'voice':
    case 'speech': return { fn: psola, name: 'psola', reason: `content:${opts.content}` }
    case 'tonal': return { fn: sms, name: 'sms', reason: 'content:tonal' }
    default: return { fn: transient, name: 'transient', reason: 'fallback:transient' }
  }
}

function notifyDecision(opts, params, decision) {
  if (typeof opts?.onDecision !== 'function') return
  opts.onDecision({
    method: decision.name,
    reason: decision.reason,
    ratio: params.ratio,
    semitones: params.semitones,
    content: opts?.content,
    formant: !!opts?.formant,
  })
}

// `ratio` is a function/Float32Array whenever pitch varies over time — never identity,
// regardless of its value at t=0 (matches shift-core's makePitchShift.isIdentity).
function isVariableRatio(opts) {
  let raw = opts?.ratio
  return typeof raw === 'function' || raw instanceof Float32Array
}

function isIdentity(opts) {
  if (isVariableRatio(opts)) return false
  return resolveRatio(opts).ratio === 1
}

// `formant: true` wraps whichever method runs (README: "Wrap in formant preservation") —
// but shift-formant is a single self-contained algorithm (its own peak-lock shift fused
// with envelope extraction/reimposition), not a post-processor any other method's output
// can be piped through. True wrap semantics would need a new cross-package pipeline (STFT-
// analyze an arbitrary algorithm's output, re-impose the original's envelope on it); absent
// that, silently discarding an explicit `method` is the wrong failure mode — fail loudly.
function decide(opts) {
  let { ratio } = resolveRatio(opts)
  let params = { ratio, semitones: opts?.semitones ?? 0 }
  if (opts?.formant) {
    let method = opts?.method
    if (method != null && method !== 'formant') {
      let name = typeof method === 'function' ? (method.name || 'custom') : method
      throw new TypeError(`pitchShift: \`formant: true\` conflicts with explicit \`method: '${name}'\` — choose one`)
    }
    let decision = { fn: formant, name: 'formant', reason: 'formant:true' }
    notifyDecision(opts, params, decision)
    return decision
  }
  let decision = selectMethod(opts)
  notifyDecision(opts, params, decision)
  return decision
}

function shiftAuto(data, opts) {
  return decide(opts).fn(data, opts)
}

function createWriter(opts) {
  let writer = decide(opts).fn(opts)
  if (typeof writer !== 'function') {
    throw new TypeError('pitchShift: selected streaming method must return a writer')
  }
  return writer
}

export default function pitchShift(data, opts) {
  if (data instanceof Float32Array || isChannelArray(data)) {
    return mapInput(data, shiftAuto, opts)
  }
  opts = normalizeOptionsInput(data)
  if (isIdentity(opts)) return createChannelWriter(() => passThroughWriter())
  return createChannelWriter(() => createWriter(opts))
}
