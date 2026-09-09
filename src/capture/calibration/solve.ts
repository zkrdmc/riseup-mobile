/**
 * Can this view be calibrated? — the pure half.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT "CALIBRATING THE PITCH" MEANS HERE
 * ══════════════════════════════════════════════════════════════════════════
 * Not the chessboard. That is the LENS calibration — intrinsics and
 * distortion, per camera per resolution, in `devices/types.ts`. This is the
 * other one: the homography that maps image pixels onto the ground, which is
 * what turns a player at (1840, 962) into a player at 41.2 m by 33.8 m.
 *
 * It is solved from one still frame of the actual pitch, taken through the
 * actual camera, and it is valid only for that viewpoint. Move the camera and
 * it is dead — which is why `venue_cameras` holds it and the lens does not.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE OPERATOR TAPS. NOTHING HERE DETECTS.
 * ══════════════════════════════════════════════════════════════════════════
 * PRD §4.2 chose manual point-tapping over automatic landmark detection,
 * because "a viewfinder overlay that silently mis-solves is worse than one
 * that asks". `framing/detector.ts` keeps that line: a detector may answer
 * "could this view be solved from", and the operator's taps remain the
 * calibration. This module consumes taps.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  TWO INDEPENDENT WAYS TO FAIL, AND BOTH ARE CHECKED
 * ══════════════════════════════════════════════════════════════════════════
 * A solve can fail because the VIEW is wrong — too few landmarks, all bunched
 * in one corner, strung along a line — which `framing/visibility.ts` already
 * measures and is what a camera operator can act on by moving the camera.
 *
 * It can also fail because the TAPS are wrong: the right landmarks, well
 * spread, but one of them put on the wrong corner. That produces a homography
 * that converges happily and is wrong by metres, and no amount of geometry
 * assessment sees it. Only reprojection error does.
 *
 * So both run, and they are reported separately, because the fixes are
 * different: one means move the camera, the other means re-tap that point.
 */

import type { Landmark } from '../framing/landmarks';
import {
  assessVisibility,
  type CameraMode,
  type RegionOfInterest,
  type VisibilityReport,
} from '../framing/visibility';

/** One landmark, and where the operator put it in the image. */
export interface Correspondence {
  landmarkId: string;
  /** Pixels in the calibration image, not in the on-screen preview. */
  imageX: number;
  imageY: number;
}

/* ── Homography, in plain TypeScript ──────────────────────────────────────────
   `modules/riseup-vision` wraps `cv::findHomography`, which is the one to use
   when it is there: it runs RANSAC, and RANSAC is what tolerates one badly
   tapped point out of eight. This is the fallback for when it is not — Expo
   Go, or a dev client built before the module landed — and for the smoke test,
   which runs under plain Node with no native anything.

   Least squares, no outlier rejection. That difference is not cosmetic and
   `solvedBy` on the result carries it through to the UI, because a solve with
   no RANSAC behind it should be trusted less.
   ─────────────────────────────────────────────────────────────────────────── */

export interface Point2 {
  x: number;
  y: number;
}

/**
 * Hartley normalisation: centre the points and scale so the mean distance from
 * the origin is √2.
 *
 * Not optional. Image coordinates run to thousands and pitch coordinates to
 * about a hundred, so the unnormalised system has entries spanning six orders
 * of magnitude and the solution is dominated by rounding. This is the standard
 * fix and it is the difference between a homography that is right and one that
 * looks plausible.
 */
function normalise(points: Point2[]): { matrix: number[]; out: Point2[] } | null {
  const n = points.length;
  if (n === 0) {
    return null;
  }
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  const meanDist =
    points.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / n;
  if (!(meanDist > 1e-12)) {
    // Every point in the same place. Not a degenerate scale to guard against
    // later — there is no configuration this recovers from.
    return null;
  }
  const s = Math.SQRT2 / meanDist;
  return {
    matrix: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    out: points.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}

/** Solve `A x = b` by Gauss-Jordan with partial pivoting. `a` is n×n, row-major. */
function solveLinear(a: number[], b: number[], n: number): number[] | null {
  const m = a.slice();
  const v = b.slice();
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r * n + col] as number) > Math.abs(m[pivot * n + col] as number)) {
        pivot = r;
      }
    }
    const pv = m[pivot * n + col] as number;
    if (Math.abs(pv) < 1e-12) {
      // Singular: the correspondences do not constrain all eight parameters.
      // Collinear points land here, which `visibility.conditioning` also
      // catches — reported from there, in metres, rather than as "singular".
      return null;
    }
    if (pivot !== col) {
      for (let c = 0; c < n; c += 1) {
        const t = m[pivot * n + c] as number;
        m[pivot * n + c] = m[col * n + c] as number;
        m[col * n + c] = t;
      }
      const t = v[pivot] as number;
      v[pivot] = v[col] as number;
      v[col] = t;
    }
    const d = m[col * n + col] as number;
    for (let c = col; c < n; c += 1) {
      m[col * n + c] = (m[col * n + c] as number) / d;
    }
    v[col] = (v[col] as number) / d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) {
        continue;
      }
      const f = m[r * n + col] as number;
      if (f === 0) {
        continue;
      }
      for (let c = col; c < n; c += 1) {
        m[r * n + c] = (m[r * n + c] as number) - f * (m[col * n + c] as number);
      }
      v[r] = (v[r] as number) - f * (v[col] as number);
    }
  }
  return v;
}

function multiply3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += (a[r * 3 + k] as number) * (b[k * 3 + c] as number);
      }
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-14) {
    return null;
  }
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

/**
 * Least-squares homography mapping `src` onto `dst`. Row-major 3×3, h33 = 1.
 *
 * Needs four points to be determined and more to be over-determined. Four
 * exactly is accepted and is a bad idea — with zero redundancy a mis-tap is
 * mathematically invisible, which is why `visibility.ts` blocks below six.
 */
export function solveHomography(src: Point2[], dst: Point2[]): number[] | null {
  if (src.length !== dst.length || src.length < 4) {
    return null;
  }
  const ns = normalise(src);
  const nd = normalise(dst);
  if (ns === null || nd === null) {
    return null;
  }

  const n = src.length;
  const rows = 2 * n;
  // Normal equations: (Aᵀ A) x = Aᵀ b, eight unknowns.
  const ata = new Array<number>(64).fill(0);
  const atb = new Array<number>(8).fill(0);

  for (let i = 0; i < n; i += 1) {
    const p = ns.out[i] as Point2;
    const q = nd.out[i] as Point2;
    const r1 = [p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y];
    const r2 = [0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y];
    for (const [row, rhs] of [[r1, q.x], [r2, q.y]] as Array<[number[], number]>) {
      for (let a = 0; a < 8; a += 1) {
        atb[a] = (atb[a] as number) + (row[a] as number) * rhs;
        for (let b = 0; b < 8; b += 1) {
          ata[a * 8 + b] = (ata[a * 8 + b] as number) + (row[a] as number) * (row[b] as number);
        }
      }
    }
  }
  void rows;

  const h = solveLinear(ata, atb, 8);
  if (h === null) {
    return null;
  }
  const hNorm = [...h, 1];

  // Undo the normalisation: H = T_dst⁻¹ · Ĥ · T_src
  const invDst = invert3(nd.matrix);
  if (invDst === null) {
    return null;
  }
  const full = multiply3(invDst, multiply3(hNorm, ns.matrix));
  const scale = full[8] as number;
  if (!Number.isFinite(scale) || Math.abs(scale) < 1e-14) {
    return null;
  }
  return full.map((v) => v / scale);
}

/** Apply a row-major 3×3 to a point. Null when the point maps to infinity. */
export function applyHomography(h: number[], p: Point2): Point2 | null {
  const w = (h[6] as number) * p.x + (h[7] as number) * p.y + (h[8] as number);
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) {
    return null;
  }
  return {
    x: ((h[0] as number) * p.x + (h[1] as number) * p.y + (h[2] as number)) / w,
    y: ((h[3] as number) * p.x + (h[4] as number) * p.y + (h[5] as number)) / w,
  };
}

/* ── The verdict ──────────────────────────────────────────────────────────── */

export type SolveFailure =
  | 'NO_POINTS'
  | 'TOO_FEW_FOR_HOMOGRAPHY'
  | 'DEGENERATE'
  | 'VIEW_INADEQUATE'
  | 'TAPS_INCONSISTENT';

export interface PerPointError {
  landmarkId: string;
  label: string;
  /** How far the solved homography puts this landmark from where it was tapped. */
  errorPx: number;
}

export interface SolveVerdict {
  solvable: boolean;
  /** Present when `solvable` is false. */
  failure: SolveFailure | null;
  /** One sentence for the operator, naming the fix rather than the maths. */
  message: string;

  /** The geometry assessment. Null when there were no usable taps at all. */
  visibility: VisibilityReport | null;
  /** Row-major 3×3 mapping PITCH METRES onto IMAGE PIXELS, or null. */
  homography: number[] | null;
  /** Which implementation produced it, because they are not equally strong. */
  solvedBy: 'opencv_ransac' | 'least_squares' | null;

  /** Root-mean-square reprojection error over all points, in pixels. */
  rmsErrorPx: number | null;
  /** Sorted worst first, so the UI can point at the tap to redo. */
  perPoint: PerPointError[];
  /** The single worst point, when it is bad enough to be worth naming. */
  worstPoint: PerPointError | null;
}

/**
 * How far a reprojected landmark may sit from where it was tapped.
 *
 * A finger on a phone screen is roughly 8–10 px of honest imprecision at
 * preview scale, and a 4K frame shown on a 400 px-wide view multiplies that by
 * about ten before it reaches image coordinates. So a well-tapped point can
 * legitimately land 50-odd pixels out in a 4K image, and the threshold has to
 * sit above that or every good calibration fails.
 *
 * Expressed as a fraction of the image diagonal rather than in pixels, because
 * a fixed pixel count means something different on a 1080p frame and a 4K one,
 * and the tap error scales with the image, not with the screen.
 */
const RMS_BLOCKING_FRACTION = 0.02;
const WORST_POINT_ADVISORY_FRACTION = 0.03;

export interface SolveRequest {
  correspondences: Correspondence[];
  /** The pitch, at its measured dimensions. */
  landmarks: Landmark[];
  imageWidth: number;
  imageHeight: number;
  roi?: RegionOfInterest | null;
  mode?: CameraMode;
  /**
   * A homography solved elsewhere — by `riseup-vision`'s RANSAC, when it is
   * available. Omitted, this falls back to the least-squares solve above.
   */
  homography?: { h: number[]; solvedBy: 'opencv_ransac' } | null;
}

/**
 * Is this view calibratable, and if not, what does the operator do about it?
 *
 * Order matters. The geometry is checked BEFORE the reprojection error,
 * because a view with four landmarks along the halfway line produces a
 * beautiful reprojection error — it fits them perfectly — and is completely
 * unsolvable. Reporting "taps look good" for that view would send somebody
 * away happy with a calibration that cannot place a player.
 */
export function assessSolvability(request: SolveRequest): SolveVerdict {
  const { correspondences, landmarks, imageWidth, imageHeight } = request;

  const empty = (failure: SolveFailure, message: string): SolveVerdict => ({
    solvable: false, failure, message,
    visibility: null, homography: null, solvedBy: null,
    rmsErrorPx: null, perPoint: [], worstPoint: null,
  });

  if (correspondences.length === 0) {
    return empty('NO_POINTS', 'Tap the pitch markings you can see in this frame.');
  }

  // Only taps naming a landmark we know about count. An unknown id is a stale
  // draft from an older build, not a point to guess at.
  const byId = new Map(landmarks.map((l) => [l.id, l]));
  const paired = correspondences
    .map((c) => ({ c, landmark: byId.get(c.landmarkId) }))
    .filter((p): p is { c: Correspondence; landmark: Landmark } => p.landmark !== undefined);

  const visibility = assessVisibility(
    paired.map((p) => p.landmark),
    request.roi ?? null,
    request.mode ?? 'fixed',
  );

  if (paired.length < 4) {
    return {
      ...empty('TOO_FEW_FOR_HOMOGRAPHY',
        `A homography needs at least four points and you have marked ${paired.length}. ` +
        `Six is the point at which a single mis-tap becomes detectable.`),
      visibility,
    };
  }

  // The view first. A perfect fit to a bad view is still a bad calibration.
  const blocking = visibility.issues.filter((i) => i.blocking);
  if (blocking.length > 0) {
    return {
      ...empty('VIEW_INADEQUATE', blocking[0]?.message ?? 'This view cannot be solved from.'),
      visibility,
    };
  }

  const src: Point2[] = paired.map((p) => ({ x: p.landmark.x, y: p.landmark.y }));
  const dst: Point2[] = paired.map((p) => ({ x: p.c.imageX, y: p.c.imageY }));

  const h = request.homography?.h ?? solveHomography(src, dst);
  const solvedBy = request.homography !== null && request.homography !== undefined
    ? 'opencv_ransac'
    : 'least_squares';

  if (h === null) {
    return {
      ...empty('DEGENERATE',
        'These points do not pin down a mapping — they are too close to a straight line, ' +
        'or two of them are on the same spot. Mark points from both ends of the pitch.'),
      visibility,
    };
  }

  const perPoint: PerPointError[] = [];
  let sumSq = 0;
  for (let i = 0; i < paired.length; i += 1) {
    const projected = applyHomography(h, src[i] as Point2);
    const target = dst[i] as Point2;
    const errorPx = projected === null
      ? Number.POSITIVE_INFINITY
      : Math.hypot(projected.x - target.x, projected.y - target.y);
    sumSq += Number.isFinite(errorPx) ? errorPx * errorPx : 0;
    perPoint.push({
      landmarkId: (paired[i] as { landmark: Landmark }).landmark.id,
      label: (paired[i] as { landmark: Landmark }).landmark.label,
      errorPx,
    });
  }
  perPoint.sort((a, b) => b.errorPx - a.errorPx);
  const rmsErrorPx = Math.sqrt(sumSq / paired.length);

  const diagonal = Math.hypot(imageWidth, imageHeight);
  const rmsLimit = diagonal * RMS_BLOCKING_FRACTION;
  const worstLimit = diagonal * WORST_POINT_ADVISORY_FRACTION;
  const worst = perPoint[0] ?? null;

  if (!Number.isFinite(rmsErrorPx) || rmsErrorPx > rmsLimit) {
    return {
      solvable: false,
      failure: 'TAPS_INCONSISTENT',
      message: worst === null
        ? 'These points do not agree with each other.'
        : `These points do not agree with each other — "${worst.label}" is the furthest out. ` +
          `That usually means one is on the wrong corner. Move or remove it and try again.`,
      visibility, homography: h, solvedBy,
      rmsErrorPx, perPoint, worstPoint: worst,
    };
  }

  const advisory = worst !== null && worst.errorPx > worstLimit ? worst : null;
  return {
    solvable: true,
    failure: null,
    message: advisory === null
      ? 'Solvable. This frame can be used to calibrate the pitch for this camera.'
      : `Solvable, but "${advisory.label}" sits further out than the rest. Worth re-tapping ` +
        `before you save.`,
    visibility, homography: h, solvedBy,
    rmsErrorPx, perPoint, worstPoint: worst,
  };
}

/**
 * Does this calibration frame match the setting the camera will film at?
 *
 * Pure, and separate from everything above, because it is the check that stops
 * the whole feature being quietly useless. A homography solved at one frame
 * size and applied at another is wrong by the ratio between them, and the
 * output looks entirely normal.
 *
 * Aspect ratio is compared rather than exact pixels: a 4K frame and a 1080p
 * frame of the same scene are the same view at different sampling, and the
 * homography rescales cleanly between them. A different SHAPE is a different
 * crop of the sensor, and does not.
 */
export function framesDisagree(
  frame: { width: number; height: number },
  capture: { widthPx: number; heightPx: number },
): { disagree: boolean; sameShape: boolean; scale: number } {
  const frameAspect = frame.width / frame.height;
  const captureAspect = capture.widthPx / capture.heightPx;
  const sameShape = Math.abs(frameAspect - captureAspect) < 0.02;
  const scale = capture.widthPx / frame.width;
  return {
    disagree: !sameShape || Math.abs(scale - 1) > 0.001,
    sameShape,
    scale,
  };
}
