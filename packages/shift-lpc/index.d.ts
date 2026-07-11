/** LPC source-filter pitch shift (RELP lineage) — fits the vocal-tract all-pole filter per frame (Levinson-Durbin), repitches the flat excitation residual with the delay-line splicer, resynthesizes through the unmoved synthesis filter. */
export interface LpcOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); accepts a fixed number, a function `t => ratio` (seconds), or a `Float32Array` breakpoint envelope paired with `ratioDuration` */
  ratio?: number | ((t: number) => number) | Float32Array
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** duration in seconds spanned by a `Float32Array` ratio envelope, default the input length at `sampleRate` */
  ratioDuration?: number
  /** sample rate in Hz, default 44100 */
  sampleRate?: number
  /** AR filter order (pole count), default min(frameSize/16, round(2 + sampleRate/1000)) */
  order?: number
  /** analysis/synthesis frame, default 1024 */
  frameSize?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function lpc(data: Float32Array, options?: LpcOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function lpc(data: Float32Array[], options?: LpcOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function lpc(options?: LpcOptions): ShiftWriter
