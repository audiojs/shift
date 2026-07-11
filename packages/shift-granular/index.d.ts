/** Granular pitch shift — fixed-size Hann grains at a constant output hop, each read from the source stepped by `ratio` through an anti-aliased sinc read; no stretch+resample stage. */
export interface GranularOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); fixed only — a function or Float32Array throws */
  ratio?: number
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** grain length in samples, default 398 */
  grainSize?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function granular(data: Float32Array, options?: GranularOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function granular(data: Float32Array[], options?: GranularOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function granular(options?: GranularOptions): ShiftWriter
