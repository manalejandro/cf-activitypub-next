/**
 * Live frequency levels for the audio player's waveform.
 *
 * The bars used to be a purely decorative seek waveform; they now follow the
 * sound while it plays. Design constraints, in order of importance:
 *
 *  - **Never silence the player.** Routing a media element through a
 *    `MediaElementAudioSourceNode` silences it when the resource is cross-origin
 *    without CORS (Web Audio spec), so only same-origin sources are wired
 *    (`canAnalyseSource`). Everything else keeps the static seek waveform.
 *  - **One `AudioContext` per document.** Browsers cap the number of contexts
 *    and each one owns an audio thread; every player shares it, and one
 *    analyser is created per element (the API allows exactly one source per
 *    element). The source is routed `source → analyser → destination`: without
 *    the destination connection the element would go silent.
 *  - **Cheap while playing.** The caller runs the animation loop and writes bar
 *    styles directly (no React state per frame); this module only samples bytes.
 */

/** FFT size: 128 bins is plenty for ~44 bars and keeps the per-frame copy small. */
const FFT_SIZE = 256;
/** Time-domain smoothing (0..1): higher = calmer bars. */
const SMOOTHING = 0.8;

let sharedContext: AudioContext | null = null;
const analyserByElement = new WeakMap<HTMLMediaElement, AnalyserNode | null>();

function audioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Whether `src` can be analysed without risking Web Audio's CORS silencing. */
export function canAnalyseSource(src: string): boolean {
  if (typeof window === "undefined" || !src) return false;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Analyser for a same-origin media element, or null when the browser has no Web
 * Audio support or the element cannot be routed (already wired by another
 * context, blocked by policy…). The result is cached per element: creating a
 * second source for the same element throws.
 */
export function getMediaAnalyser(el: HTMLMediaElement): AnalyserNode | null {
  const cached = analyserByElement.get(el);
  if (cached !== undefined) return cached;
  const Ctor = audioContextCtor();
  if (!Ctor) {
    analyserByElement.set(el, null);
    return null;
  }
  try {
    if (!sharedContext) sharedContext = new Ctor();
    const source = sharedContext.createMediaElementSource(el);
    const analyser = sharedContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    source.connect(analyser);
    analyser.connect(sharedContext.destination);
    analyserByElement.set(el, analyser);
    return analyser;
  } catch {
    analyserByElement.set(el, null);
    return null;
  }
}

/**
 * Resume the shared context. Autoplay policies start it suspended until a user
 * gesture, so call this from play handlers (and ignore the rejection when the
 * browser still refuses).
 */
export function resumeSharedAudioContext(): void {
  if (!sharedContext || sharedContext.state !== "suspended") return;
  void sharedContext.resume().catch(() => {});
}

/**
 * Sample `out.length` logarithmically spaced levels (0..255) from the analyser
 * into `out`. Log grouping matches how the spectrum is perceived and gives the
 * low end — where music lives — several FFT bins per bar instead of a single
 * one. `bytes` must hold `analyser.frequencyBinCount` entries and is reused
 * between frames to avoid per-frame allocations.
 */
export function sampleFrequencyLevels(
  analyser: AnalyserNode,
  out: Uint8Array,
  bytes: Uint8Array
): void {
  analyser.getByteFrequencyData(bytes as Uint8Array<ArrayBuffer>);
  const bins = bytes.length;
  const minBin = 2; // skip DC / sub-bass rumble
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(minBin * Math.pow(bins / minBin, i / out.length));
    const end = Math.max(start + 1, Math.floor(minBin * Math.pow(bins / minBin, (i + 1) / out.length)));
    let sum = 0;
    let count = 0;
    for (let bin = start; bin < end && bin < bins; bin++) {
      sum += bytes[bin];
      count++;
    }
    out[i] = count > 0 ? Math.round(sum / count) : 0;
  }
}
