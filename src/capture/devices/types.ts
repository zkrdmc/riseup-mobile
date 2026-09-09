/**
 * The club's cameras, saved.
 *
 * The same idea as picking a pair of shoes on Strava: you register the thing
 * once, and from then on you pick it from a list instead of describing it
 * again. Here it earns considerably more than convenience — PRD §4.3 is titled
 * "once per camera, not once per match", and this is what makes that true.
 * Select "Club camcorder" and its lens model comes with it, so the calibration
 * is done once by whoever sets it up and never again by a volunteer on a
 * Saturday.
 */

import type { OpenCvDistortion } from '../survey/opencv';
import { cameraClassById, type CameraClass } from './catalogue';

/**
 * A solved lens, valid for ONE resolution and zoom.
 *
 * §4.3 requires the calibration be stored "against that camera, with its
 * resolution and zoom setting", and that qualifier is not bookkeeping. A 4K
 * mode is frequently a crop of the sensor while 1080p is a scale of it, so the
 * intrinsics differ by the crop factor; digital zoom changes them by exactly
 * its ratio. One camera therefore has several lens models, and using the wrong
 * one is a silent scale error in every distance the pipeline reports.
 */
export interface LensCalibration {
  id: string;
  /** The frame size this was solved at. Must match the footage to be usable. */
  widthPx: number;
  heightPx: number;
  /** 1 means no zoom. */
  zoomRatio: number;

  /**
   * How it was obtained, worst to best:
   *   `device_reported` — the platform's own calibration (a phone)
   *   `plumb_line`      — fitted from straight pitch lines
   *   `chessboard`      — the full solve of §4.3, and the only one that also
   *                       recovers focal length
   */
  method: 'device_reported' | 'plumb_line' | 'chessboard';

  /** Row-major 3×3. Null when only distortion was recovered (plumb line). */
  cameraMatrix: number[] | null;
  distortion: OpenCvDistortion;

  /** Chessboard only: RMS reprojection error in pixels. Under ~0.5 is good. */
  rmsReprojectionError: number | null;
  /**
   * How far a straight line bows at the frame edge, in pixels.
   *
   * The number §4.3 asks be shown to the operator, and the one that decides
   * whether this camera needed correcting at all. Legible in a list row in a
   * way a coefficient never is.
   */
  edgeBowPx: number | null;

  solvedAt: string;
  /** App version that solved it, so a bad release can be traced. */
  appVersion: string;
}

export interface SavedCamera {
  /** This device's id for the camera. Stable across syncs. */
  id: string;
  /**
   * The server's id, once this camera has been pushed.
   *
   * Separate from `id` because a camera created with no signal gets a local
   * UUID and the server mints its own on first push — the two never match.
   * Reconciling on label instead would turn a rename into a delete and lose
   * every calibration attached to it. Null means "never pushed", which is a
   * state a camera can legitimately sit in for a whole match.
   */
  serverId: string | null;
  /**
   * Which supported class this is — the key into `catalogue.ts`.
   *
   * Stored rather than inferred from make and model, because support is a
   * decision about capability, not about a model number: the same GoPro is
   * supported in Linear mode and not in Wide, and only the operator knows
   * which one it is set to.
   */
  classId: string;
  /**
   * What the club calls it — "Club camcorder", "Youssef's phone".
   *
   * A name, not a model number. Two identical handsets need to be tellable
   * apart by the person holding one of them, and "SM-S928B" tells nobody
   * anything.
   */
  label: string;
  kind: 'phone' | 'external';

  make: string | null;
  model: string | null;
  lensModel: string | null;

  /** One per resolution/zoom this camera has been calibrated at. */
  calibrations: LensCalibration[];

  createdAt: string;
  /** Drives the ordering, so the camera you always use is the one on top. */
  lastUsedAt: string | null;
  useCount: number;
}

/**
 * The calibration that matches a given capture setting, or null.
 *
 * Exact match on resolution, and on zoom to within a rounding tolerance.
 * NEAREST IS NOT GOOD ENOUGH and is not offered: a 1080p calibration applied
 * to 4K footage is wrong by the crop factor between the two modes, which is
 * both large and invisible. Returning null sends the operator to calibrate,
 * which is the correct outcome.
 */
export function calibrationFor(
  camera: SavedCamera,
  widthPx: number,
  heightPx: number,
  zoomRatio: number,
): LensCalibration | null {
  const matches = camera.calibrations.filter(
    (c) =>
      c.widthPx === widthPx &&
      c.heightPx === heightPx &&
      Math.abs(c.zoomRatio - zoomRatio) < 0.01,
  );
  if (matches.length === 0) {
    return null;
  }
  // Newest wins: a re-calibration is a correction of the one before it.
  return matches.reduce((best, c) => (c.solvedAt > best.solvedAt ? c : best));
}

/** A one-line description of this camera's lens state, for the picker row. */
export function calibrationSummary(camera: SavedCamera): string {
  if (camera.calibrations.length === 0) {
    return camera.kind === 'phone'
      ? 'Lens read automatically'
      : 'No lens model yet';
  }

  const newest = camera.calibrations.reduce((best, c) =>
    c.solvedAt > best.solvedAt ? c : best,
  );
  const resolutions = new Set(camera.calibrations.map((c) => `${c.widthPx}x${c.heightPx}`));
  const at = resolutions.size === 1 ? describeResolution(newest) : `${resolutions.size} settings`;

  if (newest.edgeBowPx !== null) {
    // The bow is the useful half. "Calibrated" alone does not tell an operator
    // whether the correction mattered; "34 px of bend" does.
    const bow = newest.edgeBowPx < 1 ? 'straight lens' : `${Math.round(newest.edgeBowPx)} px of bend`;
    return `${at} · ${bow}`;
  }
  return `Calibrated · ${at}`;
}

function describeResolution(c: LensCalibration): string {
  if (c.widthPx >= 3840) {
    return '4K';
  }
  if (c.widthPx >= 2560) {
    return '1440p';
  }
  if (c.widthPx >= 1920) {
    return '1080p';
  }
  return `${c.widthPx}x${c.heightPx}`;
}

/** The catalogue entry behind a saved camera, if the class still exists. */
export function classOf(camera: SavedCamera): CameraClass | null {
  return cameraClassById(camera.classId);
}

/**
 * Can this camera record right now, and if not, what is missing?
 *
 * The picker uses this to grey a row and the preflight gate uses it to block,
 * so the answer is in one place and the two cannot disagree.
 */
export function readiness(
  camera: SavedCamera,
  capture: { widthPx: number; heightPx: number; zoomRatio: number } | null,
): { ready: boolean; reason: string | null } {
  const cls = classOf(camera);

  if (cls === null) {
    return {
      ready: false,
      reason: 'This camera was saved by an older version of the app and its type is no longer ' +
        'recognised. Add it again.',
    };
  }

  if (cls.tier === 'unsupported') {
    return { ready: false, reason: cls.unsupportedReason ?? 'This camera cannot be processed.' };
  }

  // A phone is read directly at capture time, so it needs nothing stored.
  if (cls.tier === 'supported') {
    return { ready: true, reason: null };
  }

  if (camera.calibrations.length === 0) {
    return { ready: false, reason: 'This camera has no lens model yet. Calibrate it once and it ' +
      'is done for good.' };
  }

  if (capture === null) {
    return { ready: true, reason: null };
  }

  const match = calibrationFor(camera, capture.widthPx, capture.heightPx, capture.zoomRatio);
  if (match === null) {
    return {
      ready: false,
      reason: `This camera is calibrated, but not at ${capture.widthPx}x${capture.heightPx}` +
        `${capture.zoomRatio === 1 ? '' : ` at ${capture.zoomRatio}x zoom`}. A different ` +
        `resolution is a different lens as far as the maths is concerned. Calibrate it at the ` +
        `setting you will film at.`,
    };
  }

  return { ready: true, reason: null };
}
