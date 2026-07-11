/** Overlap-Add pitch shift — plain OLA time-stretch at factor=ratio (no similarity search) followed by anti-aliased sinc resample back to the original length. The baseline the others improve on. */
export interface OlaOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); fixed only — a function or Float32Array throws */
  ratio?: number
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** analysis/synthesis frame, default 2048 */
  frameSize?: number
  /** analysis hop, default frameSize/4 */
  hopSize?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function ola(data: Float32Array, options?: OlaOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function ola(data: Float32Array[], options?: OlaOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function ola(options?: OlaOptions): ShiftWriter
