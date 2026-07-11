/** WSOLA time-stretch + sinc resample — searches each grain position within `tolerance` for maximum cross-correlation with the previous grain, then resamples to the target pitch. */
export interface WsolaOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); fixed only — a function or Float32Array throws */
  ratio?: number
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** STFT-style analysis frame, default 2048 */
  frameSize?: number
  /** analysis hop, default frameSize/4 */
  hopSize?: number
  /** similarity search radius in samples, default frameSize/4 */
  tolerance?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function wsola(data: Float32Array, options?: WsolaOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function wsola(data: Float32Array[], options?: WsolaOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function wsola(options?: WsolaOptions): ShiftWriter
