/**
 * Turning what the device reports into what the geometry needs.
 *
 * Pure functions, no I/O, no platform calls — so every one of them is testable
 * without a phone, which matters because the alternative to testing this is
 * discovering a factor-of-two in a focal length after a season of matches.
 */

import {
  derived,
  fromDevice,
  type Intrinsics,
  type OrientationSample,
  type Quantity,
  type RigSurvey,
} from './schema';

/* ── Intrinsics ───────────────────────────────────────────────────────────── */

/**
 * fx and fy in pixels, from focal length and physical sensor size.
 *
 * The fallback for every device that does not report a calibrated intrinsic
 * matrix, which is most of them. The identity is just similar triangles:
 *
 *     fx_px = focal_mm * (active_array_width_px / sensor_width_mm)
 *
 * The bracketed term is pixels per millimetre on the sensor. fy uses the
 * vertical pair, and the two differ only if the pixels are not square — which
 * they are on every phone sensor, so a large fx/fy divergence here means one
 * of the inputs is wrong rather than that the sensor is exotic.
 *
 * ACCURATE TO ABOUT A PERCENT, and systematically so: `LENS_FOCAL_LENGTH` is
 * the design value, not the built one, and it does not move with focus. That
 * is fine — a percent on the focal length is a percent on every distance, and
 * the ingest solver refines it against pitch geometry anyway. What it cannot
 * do is capture decentring, so the principal point is assumed at the array
 * centre and the assumption is recorded rather than hidden.
 */
export function intrinsicsFromGeometry(input: {
  focalLengthMm: number;
  sensorPhysicalWidthMm: number;
  sensorPhysicalHeightMm: number;
  activeArrayWidthPx: number;
  activeArrayHeightPx: number;
}): Intrinsics {
  const {
    focalLengthMm,
    sensorPhysicalWidthMm,
    sensorPhysicalHeightMm,
    activeArrayWidthPx,
    activeArrayHeightPx,
  } = input;

  const fx = focalLengthMm * (activeArrayWidthPx / sensorPhysicalWidthMm);
  const fy = focalLengthMm * (activeArrayHeightPx / sensorPhysicalHeightMm);

  // A percent of the value, which is the honest scale of the error in a
  // datasheet focal length. Not zero, and not a guess dressed up as precision.
  const relativeSigma = 0.01;

  return {
    source: 'geometric',
    fxPx: derived(fx, ['focalLengthMm', 'sensorPhysicalWidthMm'], fx * relativeSigma),
    fyPx: derived(fy, ['focalLengthMm', 'sensorPhysicalHeightMm'], fy * relativeSigma),
    // Assumed, not measured. The sigma says how much of the array that is.
    cxPx: derived(activeArrayWidthPx / 2, ['activeArrayWidthPx'], activeArrayWidthPx * 0.02),
    cyPx: derived(activeArrayHeightPx / 2, ['activeArrayHeightPx'], activeArrayHeightPx * 0.02),
    skew: null,
    focalLengthMm,
    sensorPhysicalWidthMm,
    sensorPhysicalHeightMm,
    activeArrayWidthPx,
    activeArrayHeightPx,
  };
}

/**
 * Horizontal field of view in degrees, from the intrinsics.
 *
 * Useful on iOS, where `AVCaptureDeviceFormat.videoFieldOfView` is the only
 * intrinsic-ish number available on a single-camera capture, so the derivation
 * runs the other way — see `intrinsicsFromFieldOfView`.
 */
export function horizontalFovDeg(intrinsics: Intrinsics): number {
  return 2 * Math.atan(intrinsics.activeArrayWidthPx / (2 * intrinsics.fxPx.value)) * (180 / Math.PI);
}

/**
 * The iOS fallback: intrinsics from a stated field of view.
 *
 * AVFoundation gives `videoFieldOfView` — the horizontal angle, in degrees,
 * for the active format — and exposes neither focal length in millimetres nor
 * physical sensor size. So the geometric route above is unavailable and this
 * is what is left:
 *
 *     fx = (width_px / 2) / tan(fov / 2)
 *
 * fy follows from square pixels. Weaker than the Android path because the
 * quoted FOV is a rounded nominal figure, so the sigma is correspondingly
 * larger.
 */
export function intrinsicsFromFieldOfView(input: {
  horizontalFovDeg: number;
  activeArrayWidthPx: number;
  activeArrayHeightPx: number;
}): Intrinsics {
  const { horizontalFovDeg: fov, activeArrayWidthPx, activeArrayHeightPx } = input;
  const fx = activeArrayWidthPx / 2 / Math.tan((fov * Math.PI) / 180 / 2);
  // Square pixels. True on phone sensors, and the assumption is the reason fy
  // is marked as derived from fx rather than measured independently.
  const fy = fx;

  const relativeSigma = 0.03;

  return {
    source: 'geometric',
    fxPx: derived(fx, ['horizontalFovDeg', 'activeArrayWidthPx'], fx * relativeSigma),
    fyPx: derived(fy, ['fxPx'], fy * relativeSigma),
    cxPx: derived(activeArrayWidthPx / 2, ['activeArrayWidthPx'], activeArrayWidthPx * 0.02),
    cyPx: derived(activeArrayHeightPx / 2, ['activeArrayHeightPx'], activeArrayHeightPx * 0.02),
    skew: null,
    focalLengthMm: null,
    sensorPhysicalWidthMm: null,
    sensorPhysicalHeightMm: null,
    activeArrayWidthPx,
    activeArrayHeightPx,
  };
}

/**
 * Rescale intrinsics from the active array to the recorded video size.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT. Camera2 reports intrinsics against the
 * sensor's active array. The recorded stream is a different size, and often a
 * different aspect ratio. Feeding active-array intrinsics to a solver working
 * on 4K frames is a scale error of whatever the ratio happens to be — commonly
 * 1.5 to 2× — applied uniformly to every distance and speed the pipeline
 * produces. It looks like a plausible match, just with everyone running too
 * fast.
 *
 * Returns null when the aspect ratios differ by more than a rounding error,
 * because that is a CROP, not a scale, and recovering it needs the crop
 * rectangle rather than a ratio. Guessing would reintroduce exactly the error
 * this function exists to catch.
 */
export function scaleIntrinsicsToStream(
  intrinsics: Intrinsics,
  streamWidthPx: number,
  streamHeightPx: number,
): Intrinsics | null {
  const arrayAspect = intrinsics.activeArrayWidthPx / intrinsics.activeArrayHeightPx;
  const streamAspect = streamWidthPx / streamHeightPx;
  if (Math.abs(arrayAspect - streamAspect) > 0.01) {
    return null;
  }

  const s = streamWidthPx / intrinsics.activeArrayWidthPx;
  const scale = (q: Quantity): Quantity => ({
    ...q,
    value: q.value * s,
    sigma: q.sigma === null ? null : q.sigma * s,
  });

  return {
    ...intrinsics,
    fxPx: scale(intrinsics.fxPx),
    fyPx: scale(intrinsics.fyPx),
    cxPx: scale(intrinsics.cxPx),
    cyPx: scale(intrinsics.cyPx),
    activeArrayWidthPx: streamWidthPx,
    activeArrayHeightPx: streamHeightPx,
  };
}

/* ── Orientation from gravity ─────────────────────────────────────────────── */

export interface AccelSample {
  x: number;
  y: number;
  z: number;
}

/**
 * Tilt and roll from a burst of accelerometer samples taken while still.
 *
 * At rest the accelerometer measures the reaction to gravity, so the
 * normalised reading is a unit vector pointing UP in the device frame. The
 * camera looks along −z (out of the back), which gives:
 *
 *     sin(tilt below horizontal) = (−ẑ) · up = −a_z ... negated to
 *     tilt = asin(a_z)
 *
 * so a phone lying flat on its back, camera pointing at the ground, is +90°,
 * and one standing upright with the camera level is 0°. That is the sign a rig
 * mounted above a pitch produces: positive, and typically 5–15°.
 *
 * `rollDeg` is the angle of the up-vector within the image plane, measured
 * from the device +y axis: 0 upright portrait, ±90 landscape. Deviation from
 * level for a given mounting is `rollDeviationDeg`.
 *
 * WHY THIS IS WORTH THE TROUBLE. It fixes two of the three rotation parameters
 * to about a degree, independently of the image. So it is both a prior for the
 * homography solve and — more valuable — a check on it: a solve that disagrees
 * with the phone's own sense of down by several degrees is wrong, and saying so
 * at the ground is the difference between a fixable rig and a lost match.
 */
export function orientationFromGravity(
  samples: AccelSample[],
  capturedAt: string,
  durationMs: number,
): OrientationSample | null {
  if (samples.length === 0) {
    return null;
  }

  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const s of samples) {
    sx += s.x;
    sy += s.y;
    sz += s.z;
  }
  const n = samples.length;
  const mean = { x: sx / n, y: sy / n, z: sz / n };
  const norm = Math.hypot(mean.x, mean.y, mean.z);
  if (norm < 1e-6) {
    return null;
  }

  const a = { x: mean.x / norm, y: mean.y / norm, z: mean.z / norm };

  const tiltDeg = Math.asin(clamp(a.z, -1, 1)) * (180 / Math.PI);
  const rollDeg = Math.atan2(a.x, a.y) * (180 / Math.PI);

  // Per-sample tilt spread is the honest uncertainty: a tripod on soft ground
  // in wind is genuinely less certain than one on concrete, and this is the
  // only thing that knows the difference.
  const tilts = samples.map((s) => {
    const m = Math.hypot(s.x, s.y, s.z);
    return m < 1e-6 ? tiltDeg : Math.asin(clamp(s.z / m, -1, 1)) * (180 / Math.PI);
  });
  const tiltSigma = standardDeviation(tilts);

  const rolls = samples.map((s) => Math.atan2(s.x, s.y) * (180 / Math.PI));
  const rollSigma = standardDeviation(unwrapDegrees(rolls));

  // Magnitude away from 1 g means the device was accelerating, so the reading
  // is not purely gravity and the angles derived from it are not trustworthy.
  const stable = Math.abs(norm - 1) < 0.05 && tiltSigma < 1.5;

  return {
    tiltDeg: fromDevice(tiltDeg, tiltSigma),
    rollDeg: fromDevice(rollDeg, rollSigma),
    headingDeg: null,
    stable,
    sampleCount: n,
    durationMs,
    capturedAt,
  };
}

/** How far from level the frame is, for a stated mounting orientation. */
export function rollDeviationDeg(
  rollDeg: number,
  mounting: 'portrait' | 'landscape-left' | 'landscape-right',
): number {
  const expected = mounting === 'portrait' ? 0 : mounting === 'landscape-left' ? -90 : 90;
  return normaliseDegrees(rollDeg - expected);
}

/* ── Timing ───────────────────────────────────────────────────────────────── */

/**
 * Real frame rate and jitter from actual timestamps.
 *
 * The nominal rate is a request the sensor is free to miss — under thermal
 * load it routinely does, and PRD §4.4 wants variable frame rate detected and
 * recorded rather than assumed away. Anything computed from displacement over
 * time is wrong by exactly the ratio between requested and delivered.
 *
 * The MEDIAN interval, not the mean: a single dropped frame doubles one
 * interval, and a mean over 300 frames quietly absorbs it into a rate that
 * looks fine.
 */
export function timingFromTimestamps(timestampsNs: number[]): {
  fps: Quantity;
  jitterMs: Quantity;
} | null {
  if (timestampsNs.length < 3) {
    return null;
  }

  const intervals: number[] = [];
  for (let i = 1; i < timestampsNs.length; i += 1) {
    const dt = timestampsNs[i] - timestampsNs[i - 1];
    if (dt > 0) {
      intervals.push(dt / 1e6);
    }
  }
  if (intervals.length === 0) {
    return null;
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)] as number;
  const jitter = standardDeviation(intervals);

  return {
    fps: derived(1000 / medianMs, ['sampleTimestampsNs'], (jitter / medianMs) * (1000 / medianMs)),
    jitterMs: derived(jitter, ['sampleTimestampsNs']),
  };
}

/* ── The baseline cross-check ─────────────────────────────────────────────── */

export interface BaselineCheck {
  derivedM: number;
  measuredM: number | null;
  /** measured − derived. Null when there is no measurement to compare. */
  residualM: number | null;
  /** Combined 1σ of both estimates, for judging whether the residual matters. */
  combinedSigmaM: number;
  /** residual / combinedSigma. Above ~3 is a real disagreement, not noise. */
  zScore: number | null;
}

/**
 * Compare the measured baseline against the one implied by the two positions.
 *
 * This is the whole reason the tape measure comes out a third time. Two camera
 * positions already determine the separation, so measuring it directly adds no
 * new geometry — it adds REDUNDANCY. With three measurements constraining two
 * unknowns, a transcription error stops being invisible: the residual is
 * non-zero and somebody can go and re-measure before the match rather than
 * wonder afterwards.
 *
 * It is also the quantity handover actually depends on. Whether a player
 * crossing the seam is recognised as the same player is governed by the
 * RELATIVE accuracy of the pair, not by how well either camera is placed in
 * absolute terms — and this is the only number in the survey that measures
 * exactly that.
 */
export function checkBaseline(survey: RigSurvey): BaselineCheck | null {
  const [a, b] = survey.cameras;
  if (a === undefined || b === undefined) {
    return null;
  }

  const dAlong = a.alongTouchlineM.value - b.alongTouchlineM.value;
  const dPerp = a.perpendicularDistanceM.value - b.perpendicularDistanceM.value;
  const dHeight = a.heightM.value - b.heightM.value;
  const derivedM = Math.hypot(dAlong, dPerp, dHeight);

  // Propagate through the hypotenuse: each component contributes in proportion
  // to how much of the separation it accounts for.
  const componentSigma = (delta: number, s1: number | null, s2: number | null): number => {
    if (derivedM < 1e-6) {
      return 0;
    }
    const combined = Math.hypot(s1 ?? 0, s2 ?? 0);
    return Math.abs(delta / derivedM) * combined;
  };

  const derivedSigma = Math.hypot(
    componentSigma(dAlong, a.alongTouchlineM.sigma, b.alongTouchlineM.sigma),
    componentSigma(dPerp, a.perpendicularDistanceM.sigma, b.perpendicularDistanceM.sigma),
    componentSigma(dHeight, a.heightM.sigma, b.heightM.sigma),
  );

  const measured = survey.baselineM;
  if (measured === null) {
    return {
      derivedM,
      measuredM: null,
      residualM: null,
      combinedSigmaM: derivedSigma,
      zScore: null,
    };
  }

  const combinedSigmaM = Math.hypot(derivedSigma, measured.sigma ?? 0);
  const residualM = measured.value - derivedM;

  return {
    derivedM,
    measuredM: measured.value,
    residualM,
    combinedSigmaM,
    // A floor on the divisor so a survey claiming millimetre precision cannot
    // manufacture a huge z from a centimetre of honest disagreement.
    zScore: residualM / Math.max(combinedSigmaM, 0.05),
  };
}

/* ── Small helpers ────────────────────────────────────────────────────────── */

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Normalise to (−180, 180]. */
function normaliseDegrees(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) {
    x = 180;
  }
  return x;
}

/**
 * Remove 360° wraps before taking a spread.
 *
 * A camera mounted near roll = 180° produces samples at +179 and −179, whose
 * naive standard deviation is enormous and whose real spread is two degrees.
 */
function unwrapDegrees(values: number[]): number[] {
  if (values.length === 0) {
    return values;
  }
  const out = [values[0] as number];
  for (let i = 1; i < values.length; i += 1) {
    const prev = out[i - 1] as number;
    out.push(prev + normaliseDegrees((values[i] as number) - prev));
  }
  return out;
}
