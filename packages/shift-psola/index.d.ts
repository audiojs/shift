/** PSOLA time-stretch + sinc resample — autocorrelation pitch-mark detection places two-period Hann grains at pitch-synchronous intervals; falls back to plain WSOLA when no reliable pitch period is found. */
export interface PsolaOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); fixed only — a function or Float32Array throws */
  ratio?: number
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** sample rate in Hz, default 44100 */
  sampleRate?: number
  /** lowest expected pitch in Hz, default 80 */
  minFreq?: number
  /** highest expected pitch in Hz, default 500 */
  maxFreq?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function psola(data: Float32Array, options?: PsolaOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function psola(data: Float32Array[], options?: PsolaOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function psola(options?: PsolaOptions): ShiftWriter
