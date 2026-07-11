/** Runs phaseLock and wsola in parallel, crossfading sample-by-sample by spectral-flux transient confidence — tonal regions resolve via the phase vocoder, attacks via WSOLA, time-aligned before blending. */
export interface HybridOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); fixed only — a function or Float32Array throws */
  ratio?: number
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** sample rate in Hz, default 44100 */
  sampleRate?: number
  /** spectral-flux z-score for full WSOLA blend, default 0.8 */
  hybridThreshold?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function hybrid(data: Float32Array, options?: HybridOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function hybrid(data: Float32Array[], options?: HybridOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function hybrid(options?: HybridOptions): ShiftWriter
