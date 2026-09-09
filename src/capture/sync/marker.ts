/**
 * The audible sync marker — how several cameras end up on one timeline.
 *
 * PRD §4.5 requires it and §3.0.3 is referenced everywhere without ever being
 * written down. This is it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY A SWEPT CHIRP AND NOT A BEEP
 * ══════════════════════════════════════════════════════════════════════════
 * The obvious marker is a click or a beep, and it is the wrong one. Timing
 * accuracy from a short transient is set by how sharply you can localise its
 * edge, and outdoors — wind, crowd, reverb off a stand — that edge is mush.
 * Lossy audio compression makes it worse: AAC smears transients badly, which
 * is exactly the part a click depends on.
 *
 * A LINEAR CHIRP inverts the problem. Cross-correlated against a copy of
 * itself, a one-second sweep collapses to a peak whose width is set by its
 * BANDWIDTH, not its duration — the same pulse-compression trick radar uses.
 * So the marker can be long enough to carry real energy through the noise
 * while still being locatable to a fraction of a millisecond, and narrowband
 * noise (an engine, a whistle) only wipes out the part of the sweep it
 * overlaps.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY 1–8 kHz
 * ══════════════════════════════════════════════════════════════════════════
 * Bounded at both ends by hardware rather than taste.
 *
 * BELOW ~500 Hz a phone speaker radiates almost nothing — the driver is a few
 * millimetres across — so energy put there never reaches the other device.
 *
 * ABOVE ~15 kHz phone microphones roll off and AAC starts discarding the band
 * entirely at ordinary bitrates. An ultrasonic marker around 19 kHz is
 * tempting because it is inaudible to a crowd, and it is a trap: it is the
 * first thing the codec throws away, and it survives neither distance nor a
 * cheap mic.
 *
 * 1–8 kHz sits inside every phone's usable range, survives compression, and
 * carries three octaves of bandwidth. It is audible, which is a feature: an
 * operator hears the rig arm itself.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE MISTAKE THAT WOULD MAKE ALL OF THIS WRONG
 * ══════════════════════════════════════════════════════════════════════════
 * Sound travels at about 343 m/s. Two cameras 30 m apart hear the same chirp
 * **87 milliseconds apart** — two and a half frames at 30 fps — with perfectly
 * synchronised clocks and no error anywhere.
 *
 * So the correlation peak does NOT give the clock offset. It gives
 *
 *     clock offset  +  (distance from the speaker ÷ speed of sound)
 *
 * and treating the two as one thing puts a constant, plausible, invisible
 * error into every fused position. The survey already records where each
 * camera stands (§4.3), which is exactly what is needed to subtract the
 * propagation term — so the fix costs nothing but has to be deliberate.
 *
 * `correctForPropagation` is that subtraction, and it is the reason this
 * module knows about metres at all.
 */

/* ── The signal ───────────────────────────────────────────────────────────── */

export interface ChirpSpec {
  startHz: number;
  endHz: number;
  durationMs: number;
  sampleRate: number;
}

/**
 * The marker every device emits and looks for.
 *
 * Fixed, not configurable per session. A device that emitted a different sweep
 * than the one the analyser correlates against would produce no peak at all,
 * and the failure would look like "the marker was not heard" rather than "the
 * two ends disagree about what the marker is".
 */
export const SYNC_CHIRP: ChirpSpec = {
  startHz: 1000,
  endHz: 8000,
  durationMs: 1000,
  sampleRate: 48000,
};

/** Metres per second. Dry air at 20 °C. See `speedOfSound` for why it varies. */
export const SPEED_OF_SOUND_MS = 343;

/**
 * Speed of sound at a given air temperature.
 *
 * About 0.6 m/s per °C, which is 0.17% — over 30 m that is 5 cm, or 0.15 ms.
 * Below the noise floor of everything else here, so the constant is used in
 * practice; this exists so the assumption is visible rather than buried.
 */
export function speedOfSound(celsius: number): number {
  return 331.3 + 0.606 * celsius;
}

/**
 * Generate the chirp, as mono float samples in [-1, 1].
 *
 * Linear sweep: instantaneous frequency rises linearly, so the phase is the
 * integral of that — quadratic in t. Getting this wrong by using the
 * instantaneous frequency directly as the phase argument produces a signal
 * that sounds like a sweep and correlates like noise, which is a memorable
 * afternoon.
 *
 * A raised-cosine fade over the first and last 5 ms stops the discontinuity at
 * each end from spraying broadband energy across the spectrum — that click
 * would be a second, competing marker.
 */
export function generateChirp(spec: ChirpSpec = SYNC_CHIRP): Float32Array {
  const n = Math.round((spec.durationMs / 1000) * spec.sampleRate);
  const out = new Float32Array(n);
  const duration = spec.durationMs / 1000;
  const rate = (spec.endHz - spec.startHz) / duration;
  const fadeSamples = Math.min(Math.round(0.005 * spec.sampleRate), Math.floor(n / 2));

  for (let i = 0; i < n; i += 1) {
    const t = i / spec.sampleRate;
    // Phase = 2π ∫ f(t) dt = 2π (f₀t + ½kt²)
    const phase = 2 * Math.PI * (spec.startHz * t + 0.5 * rate * t * t);
    let amplitude = 1;
    if (i < fadeSamples) {
      amplitude = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
    } else if (i >= n - fadeSamples) {
      amplitude = 0.5 * (1 - Math.cos((Math.PI * (n - 1 - i)) / fadeSamples));
    }
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

/* ── FFT, because the naive correlation is unusable ───────────────────────────
   A one-second chirp at 48 kHz against a ten-second search window is 48 000 ×
   480 000 multiply-adds — 2.3 × 10¹⁰, minutes of work. Through the frequency
   domain it is a few hundred thousand. Iterative radix-2, in place.
   ─────────────────────────────────────────────────────────────────────────── */

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) {
    p *= 2;
  }
  return p;
}

/** In-place complex FFT. `inverse` performs the unscaled inverse transform. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number; re[i] = re[j] as number; re[j] = tr;
      const ti = im[i] as number; im[i] = im[j] as number; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ar = re[i + k] as number;
        const ai = im[i + k] as number;
        const br = re[i + k + len / 2] as number;
        const bi = im[i + k + len / 2] as number;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/* ── Finding the marker ───────────────────────────────────────────────────── */

export interface MarkerDetection {
  /** Where the chirp starts in the recording, in seconds from its first sample. */
  atSeconds: number;
  /**
   * Peak height over the background of the correlation, as a ratio.
   *
   * The honest confidence measure. A correlation always has a maximum
   * somewhere — pure noise produces one — so the height of the peak means
   * nothing on its own. What matters is how far it stands above everything
   * else in the same correlation.
   */
  peakRatio: number;
  /** True when the peak clears `MIN_PEAK_RATIO`. */
  found: boolean;
}

/**
 * How far the peak must stand above the rest of the correlation.
 *
 * Deliberately high. A marker reported where there is none produces a
 * confident, precise, wrong offset — and every position in the match inherits
 * it. A marker missed produces "the devices could not be aligned", which sends
 * somebody to check the volume. The second failure is recoverable and the
 * first is not.
 */
export const MIN_PEAK_RATIO = 6;

/**
 * Locate the chirp inside a recording by matched filtering.
 *
 * `recording` is mono float samples at `sampleRate`. Both are mean-removed
 * before correlating, because a DC offset — common on cheap mic preamps —
 * otherwise dominates the correlation and puts the peak at lag zero every
 * time.
 *
 * The peak is refined by parabolic interpolation across its two neighbours,
 * which recovers sub-sample timing: at 48 kHz one sample is 21 µs, and the
 * interpolation typically gets within a fraction of that. That precision is
 * far finer than anything else in the chain and is not the point — the point
 * is that it costs three lines and removes one source of quantisation from a
 * budget that has little room.
 */
export function findMarker(
  recording: Float32Array,
  template: Float32Array = generateChirp(),
  sampleRate: number = SYNC_CHIRP.sampleRate,
): MarkerDetection {
  if (recording.length < template.length || template.length === 0) {
    return { atSeconds: 0, peakRatio: 0, found: false };
  }

  const size = nextPowerOfTwo(recording.length + template.length);
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);

  const meanOf = (x: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < x.length; i += 1) {
      s += x[i] as number;
    }
    return s / x.length;
  };
  const recMean = meanOf(recording);
  const tplMean = meanOf(template);

  for (let i = 0; i < recording.length; i += 1) {
    ar[i] = (recording[i] as number) - recMean;
  }
  // Time-reversed template: correlation is convolution with the reverse.
  for (let i = 0; i < template.length; i += 1) {
    br[template.length - 1 - i] = (template[i] as number) - tplMean;
  }

  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < size; i += 1) {
    const r = (ar[i] as number) * (br[i] as number) - (ai[i] as number) * (bi[i] as number);
    const m = (ar[i] as number) * (bi[i] as number) + (ai[i] as number) * (br[i] as number);
    ar[i] = r;
    ai[i] = m;
  }
  fft(ar, ai, true);

  // Valid lags: the template fully overlaps the recording.
  const first = template.length - 1;
  const last = recording.length - 1;
  let peakIndex = first;
  let peak = -Infinity;
  let sumAbs = 0;
  let count = 0;
  for (let i = first; i <= last; i += 1) {
    const v = Math.abs((ar[i] as number) / size);
    sumAbs += v;
    count += 1;
    if (v > peak) {
      peak = v;
      peakIndex = i;
    }
  }
  const background = count > 0 ? sumAbs / count : 0;
  const peakRatio = background > 1e-12 ? peak / background : 0;

  // Parabolic refinement across the peak and its neighbours.
  let refined = peakIndex;
  if (peakIndex > first && peakIndex < last) {
    const y0 = Math.abs((ar[peakIndex - 1] as number) / size);
    const y1 = peak;
    const y2 = Math.abs((ar[peakIndex + 1] as number) / size);
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-15) {
      refined = peakIndex + (0.5 * (y0 - y2)) / denom;
    }
  }

  return {
    atSeconds: (refined - (template.length - 1)) / sampleRate,
    peakRatio,
    found: peakRatio >= MIN_PEAK_RATIO,
  };
}

/* ── Turning detections into a shared timeline ────────────────────────────── */

export interface DeviceHearing {
  deviceId: string;
  /** Where that device heard the chirp, in its own recording's time. */
  atSeconds: number;
  /**
   * Straight-line distance from the emitting speaker, in metres.
   *
   * From the survey's camera positions (§4.3). Null when unknown, which is
   * honest rather than convenient — see `correctForPropagation`.
   */
  distanceM: number | null;
  peakRatio: number;
}

export interface SyncOffset {
  deviceId: string;
  /**
   * Seconds to ADD to this device's timestamps to put them on the master
   * timeline. Zero for the master itself.
   */
  offsetSeconds: number;
  /** Propagation delay removed, in seconds. Zero when the distance was unknown. */
  propagationRemovedSeconds: number;
  /** How far this can be trusted. Null when it could not be estimated. */
  uncertaintySeconds: number | null;
  warnings: string[];
}

/**
 * Remove the flight time of the sound, so what is left is clock offset.
 *
 * A device whose distance is unknown is NOT quietly assumed to be at the
 * speaker. That assumption is invisible and, at any realistic rig spacing,
 * wrong by more than a frame — so the offset comes back uncorrected and
 * carrying a warning, and the caller decides whether that is good enough.
 */
export function correctForPropagation(
  hearings: DeviceHearing[],
  masterDeviceId: string,
  temperatureC: number | null = null,
): SyncOffset[] {
  const c = temperatureC === null ? SPEED_OF_SOUND_MS : speedOfSound(temperatureC);
  const master = hearings.find((h) => h.deviceId === masterDeviceId);

  return hearings.map((h) => {
    const warnings: string[] = [];
    if (h.peakRatio < MIN_PEAK_RATIO) {
      warnings.push(
        `The marker was not clearly heard on this device (peak ${h.peakRatio.toFixed(1)}× ` +
          `background, ${MIN_PEAK_RATIO}× needed). Its alignment cannot be trusted.`,
      );
    }

    const flight = h.distanceM === null ? 0 : h.distanceM / c;
    if (h.distanceM === null) {
      warnings.push(
        'This camera has no surveyed position, so the flight time of the sound could not be ' +
          'removed. At 30 m that is 87 ms — nearly three frames — of constant error.',
      );
    }

    if (master === undefined) {
      return {
        deviceId: h.deviceId,
        offsetSeconds: 0,
        propagationRemovedSeconds: flight,
        uncertaintySeconds: null,
        warnings: [...warnings, 'No master device among these recordings.'],
      };
    }

    const masterFlight =
      master.distanceM === null ? 0 : master.distanceM / c;
    // Both sides corrected back to the instant of emission, then differenced.
    const offsetSeconds =
      (master.atSeconds - masterFlight) - (h.atSeconds - flight);

    return {
      deviceId: h.deviceId,
      offsetSeconds: h.deviceId === masterDeviceId ? 0 : offsetSeconds,
      propagationRemovedSeconds: flight,
      // Dominated by how well the position is known: 0.5 m is about 1.5 ms.
      // The correlation itself is far finer and is not the limit.
      uncertaintySeconds:
        h.peakRatio < MIN_PEAK_RATIO ? null : h.distanceM === null ? null : 0.0015,
      warnings,
    };
  });
}

/** Frames of error an offset represents, which is the number that means something. */
export function offsetInFrames(offsetSeconds: number, fps: number): number {
  return offsetSeconds * fps;
}

/* ══════════════════════════════════════════════════════════════════════════
   ALIGNING ON WHAT THE GROUND ALREADY MAKES — the referee's whistle and
   everything around it.
   ══════════════════════════════════════════════════════════════════════════
   The chirp above needs us to own the speaker. A club's Wi-Fi camcorder on a
   mast does not take instructions from us; it hands over a file. For those, the
   only shared clock is the sound of the match itself.

   DO NOT DETECT THE WHISTLE. That is the obvious approach and it is the weak
   one: a whistle has no known template — pitch, length and envelope vary by
   referee and by whistle — so there is nothing to matched-filter against, and
   any detector would be guessing which of the afternoon's whistles it found.

   Correlate the two RECORDINGS against each other instead. It needs no model
   of anything: whatever loud event both microphones heard, the whistle
   included, drives the correlation to the lag that aligns them. The referee
   supplies the transient; we never have to know it was a whistle.

   PHASE TRANSFORM, not plain correlation. Two microphones at different
   positions hear different amounts of each frequency — one is behind a stand,
   one is next to a speaker, the phones apply their own automatic gain. Plain
   correlation is dominated by whichever band happens to be loudest in both.
   GCC-PHAT divides out the magnitude and keeps only the phase, so every
   frequency contributes its timing and none contributes its loudness. It is
   the standard estimator for exactly this problem and it is what makes the
   method survive two different cameras.

   ══════════════════════════════════════════════════════════════════════════
    WHY THIS CANNOT REPLACE THE CHIRP
   ══════════════════════════════════════════════════════════════════════════
   The chirp comes from a device we placed and surveyed, so its flight time to
   each camera is known and subtractable. The referee is somewhere on the pitch
   and moving, and nobody knows where.

   For two cameras a baseline B apart, the difference in flight time from an
   unknown source ranges over ±B/c. That is not noise to be averaged away — it
   is a bias set by where the referee happened to stand, and with two receivers
   it is not observable at all. `propagationAmbiguity` returns it, and at any
   realistic rig spacing it is worse than a frame.

   So: the chirp is the answer where we own the speaker, and ambient alignment
   is how a camera we do not control joins the timeline at all. Better than
   nothing by a wide margin, and not a substitute. */

/**
 * The band ambient alignment listens in.
 *
 * Below 300 Hz is wind and handling rumble, which two cameras share almost
 * none of. Above 5 kHz a distant transient has already lost its high end to
 * air absorption, and what reaches a far microphone is mostly its own hiss.
 * A referee's whistle sits around 3–4 kHz and is comfortably inside.
 */
const AMBIENT_BAND_LO_HZ = 300;
const AMBIENT_BAND_HI_HZ = 5000;

/**
 * The bar for an ambient alignment, and it is far higher than the marker's.
 *
 * Measured, not chosen: twelve pairs of genuinely unrelated recordings produced
 * peak ratios between 5.2 and 7.1 through this estimator. `MIN_PEAK_RATIO` of 6
 * — right for a matched filter against a known template — sits inside that
 * range and would call noise a match about half the time. A shared soundfield
 * clears 30× comfortably, so the gap is wide and the threshold belongs in it.
 */
export const MIN_AMBIENT_PEAK_RATIO = 15;

export interface AmbientAlignment {
  /**
   * How much LATER `other` heard the same sound than `reference`, in seconds.
   *
   * Positive means `other` is behind. Named for what it measures rather than
   * what a caller does with it: "the lag" invites a sign error at every call
   * site, and a sign error here inverts the offset between two cameras, which
   * is the exact failure PRD §4.1 warns about for a swapped A/B assignment.
   */
  otherDelaySeconds: number;
  /** Peak height over the background of the correlation. Same meaning as the marker's. */
  peakRatio: number;
  found: boolean;
}

/**
 * Estimate the lag between two recordings of the same soundfield.
 *
 * `maxLagSeconds` bounds the search. It matters more than it looks: an
 * unbounded search over two 90-minute recordings will eventually find a lag
 * where crowd noise happens to line up, and report it confidently. Bound it
 * with whatever coarse knowledge exists — a camera metadata timestamp good to
 * ±30 s turns this into a tractable, trustworthy search.
 */
export function alignByAmbient(
  reference: Float32Array,
  other: Float32Array,
  sampleRate: number = SYNC_CHIRP.sampleRate,
  maxLagSeconds: number | null = null,
): AmbientAlignment {
  const n = Math.max(reference.length, other.length);
  if (n === 0) {
    return { otherDelaySeconds: 0, peakRatio: 0, found: false };
  }
  const size = nextPowerOfTwo(2 * n);

  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);

  const mean = (x: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < x.length; i += 1) { s += x[i] as number; }
    return x.length > 0 ? s / x.length : 0;
  };
  const ma = mean(reference);
  const mb = mean(other);
  for (let i = 0; i < reference.length; i += 1) { ar[i] = (reference[i] as number) - ma; }
  for (let i = 0; i < other.length; i += 1) { br[i] = (other[i] as number) - mb; }

  fft(ar, ai, false);
  fft(br, bi, false);

  // Cross-spectrum A · conj(B), PARTIALLY whitened and band-limited.
  //
  // Full phase transform — dividing by |R| — is the textbook GCC-PHAT and it
  // is dangerous here. Whitening rescales every bin to unit magnitude,
  // including bins that contain nothing but numerical noise, and those bins
  // then vote on the answer with the same weight as the whistle. Measured on
  // synthetic material at low signal-to-noise it produced a peak 249× the
  // background at a lag wrong by 300 ms: maximum confidence, wrong answer,
  // which is the one failure this whole module exists to avoid.
  //
  // Two corrections, both standard:
  //
  //   BAND LIMIT. Only frequencies a pitch actually radiates and a phone mic
  //   actually captures. Outside that the cross-spectrum is noise being
  //   amplified to full weight.
  //
  //   PARTIAL WHITENING, |R|^β with β below 1. β = 1 is full PHAT and is
  //   maximally sharp and maximally brittle; β = 0 is plain correlation, which
  //   the loudest band dominates. 0.7 keeps most of PHAT's robustness to two
  //   microphones with different frequency responses without handing weight to
  //   empty bins.
  const beta = 0.7;
  const loBin = Math.max(1, Math.floor((AMBIENT_BAND_LO_HZ * size) / sampleRate));
  const hiBin = Math.min(Math.floor(size / 2), Math.ceil((AMBIENT_BAND_HI_HZ * size) / sampleRate));
  // The magnitudes are needed before anything is overwritten, to set a floor
  // relative to the strongest bin rather than to an absolute epsilon.
  const mags = new Float64Array(size);
  let maxMag = 0;
  for (let i = 0; i < size; i += 1) {
    const are = ar[i] as number, aim = ai[i] as number;
    const bre = br[i] as number, bim = bi[i] as number;
    const m = Math.hypot(are * bre + aim * bim, aim * bre - are * bim);
    mags[i] = m;
    if (m > maxMag) { maxMag = m; }
  }
  const floor = maxMag * 1e-3;

  for (let i = 0; i < size; i += 1) {
    // Mirror the band for the negative frequencies.
    const bin = i <= size / 2 ? i : size - i;
    const inBand = bin >= loBin && bin <= hiBin;
    const m = mags[i] as number;
    if (!inBand || m < floor) {
      ar[i] = 0;
      ai[i] = 0;
      continue;
    }
    const are = ar[i] as number, aim = ai[i] as number;
    const bre = br[i] as number, bim = bi[i] as number;
    const cr = are * bre + aim * bim;
    const ci = aim * bre - are * bim;
    const scale = Math.pow(m, beta);
    ar[i] = cr / scale;
    ai[i] = ci / scale;
  }
  fft(ar, ai, true);

  const maxLagSamples = maxLagSeconds === null
    ? Math.floor(size / 2)
    : Math.min(Math.floor(maxLagSeconds * sampleRate), Math.floor(size / 2));

  let peak = -Infinity;
  let peakLag = 0;
  let sumAbs = 0;
  let count = 0;
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
    const idx = lag >= 0 ? lag : size + lag;
    const v = Math.abs((ar[idx] as number) / size);
    sumAbs += v;
    count += 1;
    if (v > peak) { peak = v; peakLag = lag; }
  }
  const background = count > 0 ? sumAbs / count : 0;
  const peakRatio = background > 1e-12 ? peak / background : 0;

  return {
    otherDelaySeconds: -peakLag / sampleRate,
    peakRatio,
    found: peakRatio >= MIN_AMBIENT_PEAK_RATIO,
  };
}

export interface PropagationAmbiguity {
  /** Worst-case timing error, in seconds, from not knowing where the source was. */
  worstCaseSeconds: number;
  /** The same, in frames, which is the number that decides whether it matters. */
  worstCaseFrames: number;
  /** True when the ambiguity is under half a frame and can be ignored. */
  negligible: boolean;
}

/**
 * How wrong an ambient alignment can be, given that nobody knows where the
 * referee was standing.
 *
 * For two cameras a baseline `B` apart and a source anywhere, the difference in
 * flight time spans ±B/c. It is a bias, not noise: averaging more whistles does
 * not reduce it, because they all come from roughly the same place.
 *
 * With three or more cameras the source position becomes observable and this
 * collapses — that is ordinary TDOA multilateration, and it is the way to make
 * ambient alignment precise rather than merely useful.
 */
export function propagationAmbiguity(
  baselineM: number,
  fps: number,
  temperatureC: number | null = null,
): PropagationAmbiguity {
  const c = temperatureC === null ? SPEED_OF_SOUND_MS : speedOfSound(temperatureC);
  const worstCaseSeconds = Math.abs(baselineM) / c;
  const worstCaseFrames = worstCaseSeconds * fps;
  return {
    worstCaseSeconds,
    worstCaseFrames,
    negligible: worstCaseFrames < 0.5,
  };
}
