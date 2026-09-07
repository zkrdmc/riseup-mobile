/**
 * The pitch-landmark detector contract.
 *
 * NOT IMPLEMENTED, AND NOT MINE TO IMPLEMENT. No such detector exists in
 * riseup-ml today — the only `keypoints` there are ORB-style image features in
 * `camera/stitch.py`, used for panorama alignment, which are a different thing
 * entirely. A pitch-landmark model, its weights and an on-device inference
 * runtime are ML work and belong in that repository.
 *
 * This file is the seam. Everything above it — the landmark taxonomy, the
 * visibility assessment, the thresholds, the operator guidance — is shared
 * TypeScript that runs and is tested without a model. Everything below is the
 * model, and writing the interface first is what stops the two being designed
 * against each other.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT THE MODEL HAS TO DO, AND WHAT IT MUST NOT
 * ══════════════════════════════════════════════════════════════════════════
 * MUST: report which of the landmarks in `landmarks.ts` it can see, where they
 * are in the image, and how sure it is.
 *
 * MUST NOT: solve a homography. PRD §4.2 chose manual point-tapping over
 * automatic detection because "a viewfinder overlay that silently mis-solves
 * is worse than one that asks", and that argument is untouched by this. The
 * detector answers "can this view be solved from"; the operator's taps remain
 * the calibration. A detector that cannot solve cannot mis-solve, and keeping
 * it that way is the whole reason this is compatible with §4.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  CONFIDENCE IS NOT OPTIONAL
 * ══════════════════════════════════════════════════════════════════════════
 * A landmark detector on a worn municipal pitch will hallucinate. It will find
 * a penalty box corner in a puddle, a goal line in a shadow, and a centre mark
 * in a bare patch. If the gate counts those, it passes a view it should have
 * refused — which is worse than having no gate, because the operator now
 * believes the framing was checked.
 *
 * So every detection carries a confidence, `MIN_CONFIDENCE` is applied before
 * anything is counted, and the threshold lives here rather than inside the
 * model where it cannot be seen or tuned.
 */

import type { Landmark } from './landmarks';

export interface DetectedLandmark {
  /** Must match an `id` from `pitchLandmarks`. Unknown ids are discarded. */
  id: string;
  /** Where it is in the preview frame, in pixels. */
  x: number;
  y: number;
  /** 0 to 1. Anything below `MIN_CONFIDENCE` is not counted. */
  confidence: number;
}

export interface DetectionResult {
  landmarks: DetectedLandmark[];
  /** Frame the detection ran on, for drawing an overlay in the right place. */
  frameWidth: number;
  frameHeight: number;
  /** How long inference took. Drives the sampling rate; see below. */
  durationMs: number;
}

/**
 * The bar a detection must clear to be counted.
 *
 * Deliberately high. A false landmark is far more damaging than a missed one:
 * a miss makes the gate stricter than it needs to be and the operator adjusts
 * the camera, which is a small cost paid at the right moment. A false positive
 * makes the gate pass a view that cannot be solved, and that cost is paid
 * after the match by somebody who cannot do anything about it.
 */
export const MIN_CONFIDENCE = 0.6;

export interface PitchLandmarkDetector {
  /**
   * Run on one preview frame.
   *
   * Called on a timer rather than per frame. A landmark model is tens of
   * milliseconds at best, the tripod is not moving quickly, and running it at
   * 30 fps would heat the phone before kick-off — which the preflight thermal
   * gate would then refuse (§4.4). Two or three times a second is ample for a
   * readout that a human is adjusting a tripod against.
   */
  detect(): Promise<DetectionResult>;
  /** Model identifier and version, for the survey record and for support. */
  modelInfo(): { name: string; version: string };
}

let detector: PitchLandmarkDetector | null = null;

export function registerPitchLandmarkDetector(d: PitchLandmarkDetector): void {
  detector = d;
}

export function isDetectorAvailable(): boolean {
  return detector !== null;
}

export function getDetector(): PitchLandmarkDetector | null {
  return detector;
}

/**
 * Turn raw detections into the landmarks the gate will judge.
 *
 * Filters by confidence, drops ids the taxonomy does not know, and
 * de-duplicates — a detector that reports the same landmark twice would
 * otherwise inflate the count, which is the one number an operator is
 * watching.
 */
export function resolveDetections(
  detections: DetectedLandmark[],
  known: Landmark[],
  minConfidence = MIN_CONFIDENCE,
): Landmark[] {
  const byId = new Map(known.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const resolved: Landmark[] = [];

  for (const d of detections) {
    if (d.confidence < minConfidence || seen.has(d.id)) {
      continue;
    }
    const landmark = byId.get(d.id);
    if (landmark === undefined) {
      // An id this build does not know — a newer model reporting a landmark
      // added since. Ignored rather than guessed at, and not counted, because
      // a point whose pitch position is unknown cannot contribute to spread.
      continue;
    }
    seen.add(d.id);
    resolved.push(landmark);
  }

  return resolved;
}

/**
 * What the gate reports when there is no detector in this build.
 *
 * `available: false` rather than a pass. The distinction matters: "we checked
 * and it is fine" and "we could not check" must not look the same to an
 * operator, and the second must never unlock a record button on the strength
 * of the first.
 */
export interface UnavailableCheck {
  available: false;
  reason: string;
}

export function detectorUnavailable(): UnavailableCheck {
  return {
    available: false,
    reason:
      'This build cannot check the view automatically. Tap the pitch points yourself and the ' +
      'framing check will run on those instead.',
  };
}
