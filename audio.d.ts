// The umbrella's own processor, declared from its audio.js manifest as @audio/compile's tools/dts.js declares a
// member's (params metadata is the source of truth); then the family's manifests, a line each, as audio.js has them.

/** Automatable number — scalar, `t => value` fn, or breakpoint curve {t, v} */
type Auto = number | ((t: number) => number) | { t: number[], v: number[] }
/** Per-block param values as delivered by hosts (numbers arrive as 1-length Float32Array) */
type Live = Record<string, Float32Array | string | boolean>
type Ctx = { sampleRate: number, maxBlockSize: number, maxChannels: number, currentTime: number, duration?: number, events?: readonly any[], emit?: (name: string, ...args: any[]) => void, [k: string]: unknown }
type Process = (inputs: Float32Array[][], outputs: Float32Array[][], params: Live) => void

/** Chainable-host options for 'pitchShift' */
export interface PitchShiftOptions {
  /** -24..24 st (default 0) */
  "semitones"?: Auto
  /** default "auto" */
  "method"?: "auto" | "ola" | "vocoder" | "phase-lock" | "transient" | "formant" | "psola" | "wsola" | "granular" | "paulstretch" | "sms" | "hpss" | "sample" | "hybrid" | "delay" | "lpc"
  /** default "any" */
  "content"?: "any" | "voice" | "tonal"
  /** default false */
  "formant"?: boolean
  at?: number | string
  duration?: number | string
}

export declare const pitchShift: {
  (ctx: Ctx): Process
  channels: "any"
  streaming: false
  tail: (at: { sampleRate: number, params: Live, buffers: {} }) => number
  params: {
    /** -24..24 st (default 0) */
    "semitones": { type: "number", default: 0 }
    /** default "auto" */
    "method": { type: "enum", values: ["auto","ola","vocoder","phase-lock","transient","formant","psola","wsola","granular","paulstretch","sms","hpss","sample","hybrid","delay","lpc"], default: "auto" }
    /** default "any" */
    "content": { type: "enum", values: ["any","voice","tonal"], default: "any" }
    /** default false */
    "formant": { type: "bool", default: false }
  }
}

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
