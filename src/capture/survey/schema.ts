/**
 * The rig survey record.
 *
 * One document, written once per session at the ground, describing everything
 * about the rig that processing cannot recover from the footage itself. It is
 * the input to the framing check (`camera/rig.py` in riseup-ml), the prior for
 * the homography solve at ingest, and the only account of what the cameras
 * were actually doing that will exist after the match.
 *
 * THREE KINDS OF FACT, AND THE DIFFERENCE MATTERS
 * -----------------------------------------------
 * Every value here is tagged with where it came from, because a consumer that
 * cannot tell a measured quantity from a guessed one will eventually average
 * them.
 *
 *   `measured` — a human with a tape. Carries the operator's own uncertainty.
 *   `device`   — read from Camera2 / AVFoundation / the IMU. Trustworthy to
 *                the extent the vendor is, which varies enormously; see
 *                `IntrinsicsSource`.
 *   `derived`  — computed from the other two. Never stored without recording
 *                what it was computed from, so a bad input can be traced
 *                rather than inferred.
 *
 * WRITTEN AT CAPTURE TIME, NOT LATER
 * ----------------------------------
 * Every field is captured at the ground, offline (PRD §3). A survey completed
 * from memory in the car park is worse than none: it looks identical to a real
 * one and there is no way to tell them apart afterwards.
 *
 * VERSIONED, BECAUSE IT OUTLIVES THE APP
 * --------------------------------------
 * Sessions filmed this season are re-processed next season by a pipeline that
 * has moved on. `schemaVersion` is what lets that pipeline know which fields it
 * can trust; bump it whenever a field changes meaning, never reuse a name.
 */

export const SURVEY_SCHEMA_VERSION = 1;

/* ── Provenance ───────────────────────────────────────────────────────────── */

export type Provenance = 'measured' | 'device' | 'derived';

/**
 * A number that knows where it came from and how wrong it might be.
 *
 * `sigmaM`/`sigma` is a one-standard-deviation estimate in the value's own
 * unit. For a measured length it is the operator's stated confidence; for a
 * device reading it is what the platform documents, or null where the platform
 * documents nothing — which is itself worth recording, because "unknown
 * uncertainty" and "small uncertainty" are not the same claim.
 */
export interface Quantity {
  value: number;
  sigma: number | null;
  provenance: Provenance;
  /** For `derived`: the field paths this was computed from. */
  from?: string[];
}

export function measured(value: number, sigma: number): Quantity {
  return { value, sigma, provenance: 'measured' };
}

export function fromDevice(value: number, sigma: number | null = null): Quantity {
  return { value, sigma, provenance: 'device' };
}

export function derived(value: number, from: string[], sigma: number | null = null): Quantity {
  return { value, sigma, provenance: 'derived', from };
}

/* ── Camera intrinsics ────────────────────────────────────────────────────── */

/**
 * Where the intrinsic matrix came from, worst to best.
 *
 * `reported` is the only one that is actually calibrated per unit. Android
 * exposes it as `LENS_INTRINSIC_CALIBRATION` and coverage is inconsistent —
 * plenty of shipping devices advertise the capability and return values that
 * are obviously a copy of the datasheet. It is preferred and never assumed.
 *
 * `geometric` is the fallback and is usually good to a percent or so: focal
 * length in millimetres, physical sensor size in millimetres, and the active
 * array in pixels give fx and fy directly. It cannot capture decentring, so
 * the principal point is assumed at the array centre — which is an assumption,
 * recorded as one.
 */
export type IntrinsicsSource = 'reported' | 'geometric' | 'unknown';

export interface Intrinsics {
  source: IntrinsicsSource;
  /** Focal length in PIXELS, in the coordinate frame of `activeArray`. */
  fxPx: Quantity;
  fyPx: Quantity;
  /** Principal point in pixels. Assumed at array centre when `geometric`. */
  cxPx: Quantity;
  cyPx: Quantity;
  /** Axis skew. Zero on every sensor anyone ships; recorded because Camera2 reports it. */
  skew: Quantity | null;

  /** The inputs behind a `geometric` solve, kept so it can be recomputed. */
  focalLengthMm: number | null;
  sensorPhysicalWidthMm: number | null;
  sensorPhysicalHeightMm: number | null;

  /**
   * The pixel array the intrinsics are expressed in — NOT the recorded video
   * size. Camera2 reports intrinsics against the active array; a 4K stream is
   * a crop or a scale of that, and applying one to the other is a silent
   * several-percent error in every distance the pipeline computes.
   */
  activeArrayWidthPx: number;
  activeArrayHeightPx: number;
}

/**
 * Lens distortion.
 *
 * Android's `LENS_DISTORTION` is the 5-coefficient Brown-Conrady set
 * `[k1, k2, k3, p1, p2]`. iOS exposes a lookup table instead of coefficients,
 * so `model` says which is present and consumers must not assume.
 */
export interface Distortion {
  model: 'brown_conrady' | 'lookup_table' | 'none';
  /** [k1, k2, k3] radial. */
  radial: number[] | null;
  /** [p1, p2] tangential. */
  tangential: number[] | null;
  /** iOS: normalised radial magnitudes, evenly spaced from centre to corner. */
  lookupTable: number[] | null;
}

/* ── Controlled settings ──────────────────────────────────────────────────────
   These are the three the app must SET, not merely observe, and the record
   states both what was asked for and what the device actually did. A device
   that refuses to disable stabilisation must produce a survey saying so, not a
   survey that omits the field.
   ─────────────────────────────────────────────────────────────────────────── */

export type ControlOutcome =
  /** Asked for, and the device confirmed it. */
  | 'applied'
  /** The device does not expose the control. Fixed-camera assumption is at risk. */
  | 'unsupported'
  /** Asked for and the device reported it stayed on. Worse than unsupported: it is refusing. */
  | 'refused'
  /** The app did not attempt it. A bug, if it ever appears in a real session. */
  | 'not_attempted';

export interface ControlledSettings {
  /**
   * Electronic stabilisation. MUST be off.
   *
   * EIS warps and crops per frame, so the effective intrinsics change frame to
   * frame while the survey says they are fixed. Nothing downstream detects
   * this — the homography just drifts, and every measured distance drifts with
   * it. This is the single most damaging setting on the list.
   */
  videoStabilisation: ControlOutcome;
  /** Optical stabilisation. Same failure, smaller magnitude, harder to disable. */
  opticalStabilisation: ControlOutcome;
  /**
   * Autofocus, locked after setup.
   *
   * Focus breathing changes focal length by a fraction of a percent across the
   * focus range — small, but it is a systematic error in every distance, not a
   * random one.
   */
  autofocusLock: ControlOutcome;
  autoExposureLock: ControlOutcome;
  whiteBalanceLock: ControlOutcome;

  /**
   * Zoom, locked at a fixed position and recorded.
   *
   * Digital zoom is a crop: it changes the effective intrinsics by exactly its
   * ratio, and the intrinsics reported by the device may or may not account
   * for it. 1.0 means no zoom. Anything else and `cropRegion` says what the
   * sensor actually read out.
   */
  zoomRatio: number;
  /** Camera2 SCALER_CROP_REGION as [x, y, width, height] in active-array pixels. */
  cropRegion: [number, number, number, number] | null;

  /** The physical lens. Ultra-wide and tele have different intrinsics entirely. */
  lensId: string | null;
  lensFacing: 'back' | 'front' | 'external' | 'unknown';
}

/* ── Timing ───────────────────────────────────────────────────────────────────
   Nominal frame rate is a request. What the sensor did is a measurement, and
   for anything derived from displacement over time it is the one that counts.
   ─────────────────────────────────────────────────────────────────────────── */

export interface TimingProfile {
  /** What was asked for. */
  nominalFps: number;
  /**
   * What was delivered, from real frame timestamps. Null until a probe has
   * run — a survey taken before recording cannot know this, and guessing it
   * from `nominalFps` would defeat the point of recording it.
   */
  measuredFps: Quantity | null;
  /** Standard deviation of the inter-frame interval, in milliseconds. */
  frameIntervalJitterMs: Quantity | null;
  /**
   * Rolling shutter skew: time between the first and last row of one frame.
   *
   * Android reports it as `SENSOR_ROLLING_SHUTTER_SKEW` in nanoseconds. A
   * sprinting player at 30 ms of skew is displaced by several centimetres
   * between the top and bottom of their own bounding box, which is a bias in
   * every speed measurement, not noise. iOS exposes no equivalent.
   */
  rollingShutterSkewNs: number | null;
  /**
   * Which clock the frame timestamps are on. Camera2's
   * SENSOR_INFO_TIMESTAMP_SOURCE is either UNKNOWN (monotonic since boot) or
   * REALTIME (comparable to other sensors and, crucially, across devices).
   * The two-camera sync depends on knowing which.
   */
  timestampSource: 'realtime' | 'monotonic' | 'unknown';
  /** Sampled frame timestamps in nanoseconds, for the fps and jitter estimate. */
  sampleTimestampsNs: number[] | null;
}

/* ── Orientation from the IMU ─────────────────────────────────────────────── */

/**
 * Tilt and roll from gravity.
 *
 * The accelerometer at rest measures gravity, which fixes two of the three
 * rotation parameters to about a degree — a genuine prior for the solve and,
 * more usefully, an independent cross-check on it. A homography that solves to
 * a tilt eight degrees away from what the phone felt is wrong, and that is
 * detectable at the ground while it can still be fixed.
 *
 * HEADING IS RECORDED AND NOT TRUSTED. The magnetometer sits metres from steel
 * stands, floodlight masts and a metal tripod. Its error near those is tens of
 * degrees, not degrees, and it is not detectable from the reading itself.
 * Stored for forensics; never a prior.
 */
export interface OrientationSample {
  /** Rotation about the horizontal axis. 0 = optical axis level. Degrees. */
  tiltDeg: Quantity;
  /** Rotation about the optical axis. 0 = horizon level in frame. Degrees. */
  rollDeg: Quantity;
  /** Magnetic heading, degrees from north. NOT a prior — see above. */
  headingDeg: Quantity | null;
  /** True when the device was still enough for gravity to be gravity. */
  stable: boolean;
  /** Samples behind the estimate, and how long they were collected over. */
  sampleCount: number;
  durationMs: number;
  capturedAt: string;
}

/* ── Venue ────────────────────────────────────────────────────────────────────
   Surveyed once per venue, not once per session. Pitches do not move.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Pitch dimensions, all four sides.
 *
 * Four, not two, because a municipal pitch is not a rectangle. Measuring both
 * touchlines and both goal lines is what reveals that — and a pitch out of
 * square by a metre and a half, assumed rectangular, puts a systematic error
 * into every position the pipeline reports.
 */
export interface PitchSurvey {
  northTouchlineM: Quantity;
  southTouchlineM: Quantity;
  westGoalLineM: Quantity;
  eastGoalLineM: Quantity;
  /**
   * A diagonal, if the operator measured one. This is what actually proves
   * squareness: two touchlines and two goal lines of equal length still admit
   * a parallelogram.
   */
  diagonalM: Quantity | null;

  /**
   * How legible the markings are, because the ingest solver reads them.
   *
   * `fresh`  — recently painted, unambiguous
   * `worn`   — visible, patchy in places
   * `faint`  — findable by eye, will not survive an automatic line detector
   * `absent` — sections unmarked. The manual point-tapping is the only option.
   */
  markingCondition: 'fresh' | 'worn' | 'faint' | 'absent';
  surface: 'grass' | 'artificial' | 'hybrid' | 'dirt' | 'unknown';
  notes: string | null;
}

/**
 * Where the venue is, to identify it and nothing else.
 *
 * GPS is 3–5 m on a phone under an open sky, and worse beside a stand. That is
 * an order of magnitude outside what the position survey needs, so it is used
 * to recognise which ground this is and to attach a session to a saved venue.
 * It is never a camera position, and `accuracyM` is stored so nobody is
 * tempted.
 */
export interface VenueFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
}

/* ── Per-camera survey ────────────────────────────────────────────────────────
   The three lengths that place a camera, measured with a tape, in a frame the
   operator can actually work in: along the touchline, out from it, and up.
   ─────────────────────────────────────────────────────────────────────────── */

export type RigRole = 'A' | 'B';

export interface CameraSurvey {
  role: RigRole;
  deviceId: string;
  deviceModel: string;

  /**
   * Height from the ground to the OPTICAL AXIS — the lens, not the top of the
   * tripod and not the operator's eye. The distinction is 10–15 cm, which at
   * 30 m back is a quarter-degree of tilt, which is roughly the precision the
   * gravity cross-check offers. Measuring the wrong thing throws that away.
   */
  heightM: Quantity;
  /**
   * Perpendicular distance from the touchline to the camera. PRD §3.0.1 wants
   * about 30 m back; below roughly 20 m the overlap band collapses and
   * identity handover fails, which the framing check enforces separately.
   */
  perpendicularDistanceM: Quantity;
  /**
   * Signed distance along the touchline from the halfway line. Positive toward
   * the east goal, negative toward the west, so the two cameras of a rig
   * carry opposite signs and a pair that does not is a transcription error the
   * validator can catch.
   */
  alongTouchlineM: Quantity;

  /** Which half this camera is responsible for. */
  coversHalf: 'west' | 'east';
  /**
   * Which touchline the rig stands behind, so the sign convention on
   * `alongTouchlineM` resolves to a real direction rather than a diagram
   * nobody kept.
   */
  touchlineSide: 'north' | 'south';

  orientation: OrientationSample;
  intrinsics: Intrinsics;
  distortion: Distortion;
  settings: ControlledSettings;
  timing: TimingProfile;
}

/* ── The record ───────────────────────────────────────────────────────────── */

export interface RigSurvey {
  schemaVersion: number;
  surveyId: string;
  /** Set once the session exists on the server. Null while offline. */
  sessionId: string | null;
  venueId: string | null;

  startedAt: string;
  completedAt: string | null;

  pitch: PitchSurvey;
  venueFix: VenueFix | null;
  cameras: CameraSurvey[];

  /**
   * Distance between the two cameras, measured directly with a tape.
   *
   * Derivable from the two positions — and measured anyway, because that is
   * the entire point. Two independent position surveys and one independent
   * baseline over-determine the geometry, so a disagreement localises a
   * mistake instead of silently biasing the result. Nothing else in this
   * record has that property.
   *
   * It also happens to be the quantity that governs handover quality: what
   * decides whether a player crossing the seam is the same player to both
   * cameras is the RELATIVE accuracy of the pair, not the absolute accuracy of
   * either.
   */
  baselineM: Quantity | null;

  /** Free text from the operator. Wind, light, anything odd about the ground. */
  notes: string | null;
  appVersion: string;
}
