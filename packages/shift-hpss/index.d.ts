/** Fitzgerald median-filter harmonic/percussive separation — harmonic component is vocoder-shifted, percussive component passes through with original phase. */
export interface HpssOptions {
  /** target ratio (1.5 = +7 semitones, 2 = octave); accepts a fixed number, a function `t => ratio` (seconds), or a `Float32Array` breakpoint envelope paired with `ratioDuration` */
  ratio?: number | ((t: number) => number) | Float32Array
  /** semitones, applied when `ratio` is omitted (1.5 ratio = +7 semitones), default 0 */
  semitones?: number
  /** duration in seconds spanned by a `Float32Array` ratio envelope, default the input length at `sampleRate` */
  ratioDuration?: number
  /** sample rate in Hz, default 44100 */
  sampleRate?: number
  /** median filter window width in frames, default 17 */
  hpssTimeWidth?: number
  /** median filter window width in bins, default 17 */
  hpssFreqWidth?: number
  /** soft-mask exponent, default 2 */
  hpssPower?: number
}

/** Streaming writer: feed chunks matching the first call's shape (mono or channel array); call with no argument to flush the tail. */
export interface ShiftWriter {
  (chunk: Float32Array): Float32Array
  (chunk: Float32Array[]): Float32Array[]
  (chunk?: undefined): Float32Array | Float32Array[]
}

/** Process a whole buffer. Returns a new Float32Array of the same length. */
export default function hpss(data: Float32Array, options?: HpssOptions): Float32Array
/** Process channels independently — [left, right, ...]. Returns matching channels. */
export default function hpss(data: Float32Array[], options?: HpssOptions): Float32Array[]
/** Streaming form: returns a writer — call with chunks, call with no argument to flush. */
export default function hpss(options?: HpssOptions): ShiftWriter
