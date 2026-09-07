/**
 * Lens distortion for a camera that will not tell us anything.
 *
 * THE PROBLEM. Everything in `native/CameraMetadata.ts` assumes the footage
 * comes from the phone running the app, which can be interrogated. A club
 * filming on a camcorder, an action camera or a fixed camera on a stand can be
 * interrogated about nothing: there is no Camera2, no AVFoundation, no
 * `LENS_DISTORTION`. And an action camera is exactly the case where it matters
 * most — a GoPro at its default wide setting bends a touchline into a visible
 * arc, and a solver that assumes a pinhole will place players metres away from
 * where they stood.
 *
 * THE METHOD: STRAIGHT LINES HAVE TO BE STRAIGHT. Distortion is, by
 * definition, the thing that makes straight lines curve. A pitch is covered in
 * long straight lines that are straight by the laws of the game — touchlines,
 * goal lines, the edges of both penalty areas. So the operator taps a handful
 * of points along a line they know is straight, and the distortion is whatever
 * value makes it straight again. It needs no calibration target, no printed
 * chessboard, no second visit, and it works on one frame, offline, at the
 * ground.
 *
 * (This is Devernay and Faugeras' plumb-line method, which predates every
 * checkerboard toolbox and remains the only one you can run on a football
 * pitch at nine at night.)
 *
 * THE MODEL. Fitzgibbon's division model rather than Brown-Conrady:
 *
 *     p_undistorted = p_distorted / (1 + λ‖p_distorted‖²)
 *
 * One parameter, and — the reason it is the right choice here — it inverts in
 * closed form. Brown-Conrady's polynomial has to be inverted numerically for
 * every point, which is a solver inside a solver on a phone. One parameter is
 * also all that four tapped lines can honestly support; fitting k1, k2 and k3
 * to twenty points produces three confident numbers and one overfitted curve.
 *
 * λ < 0 corrects barrel distortion, which is what wide lenses have and what an
 * action camera has a great deal of.
 *
 * WHAT THIS DOES NOT GIVE YOU. Focal length. Straight lines constrain
 * distortion and nothing else — a line is equally straight through any focal
 * length. That comes from EXIF (`exif.ts`) or from the pitch solve at ingest,
 * and conflating the two is how a plausible calibration ends up with the wrong
 * scale.
 */

export interface Point {
  x: number;
  y: number;
}

/** Points tapped along one line that is straight in the real world. */
export interface StraightLineObservation {
  /** Which line, so the UI can label it and the operator can redo one. */
  id: string;
  label: string;
  points: Point[];
}

export interface DistortionFit {
  model: 'division';
  /** The single coefficient. Negative for barrel. */
  lambda: number;
  /**
   * How the pixel coordinates were normalised before fitting, so the
   * coefficient can be applied to the same image later. Radius is divided by
   * this, measured from the principal point.
   */
  normalisationPx: number;
  /** Principal point used. Assumed at image centre — see the note below. */
  principalPointPx: Point;
  imageWidthPx: number;
  imageHeightPx: number;

  /** Mean perpendicular deviation from straight, after correction, in pixels. */
  rmsResidualPx: number;
  /** The same before correction — the improvement is what makes the fit credible. */
  rmsResidualBeforePx: number;

  lineCount: number;
  pointCount: number;
}

/** Not enough evidence, and what would fix it. */
export interface DistortionFitFailure {
  reason: 'too_few_lines' | 'too_few_points' | 'no_improvement' | 'degenerate';
  message: string;
}

/**
 * Two lines minimum.
 *
 * One line can be straightened by a λ that is simply wrong: any single arc has
 * a coefficient that flattens it, including an arc that was never distortion in
 * the first place. Two lines at different distances from the centre have to be
 * straightened by the SAME coefficient, and that is what makes the answer mean
 * something.
 */
const MIN_LINES = 2;
/** Three points define a curve; two define a line and can never be bent. */
const MIN_POINTS_PER_LINE = 3;

/** Barrel beyond this is not a football camera, it is a fisheye. */
const LAMBDA_RANGE = 0.8;

export function fitDistortion(
  lines: StraightLineObservation[],
  imageWidthPx: number,
  imageHeightPx: number,
): { ok: true; fit: DistortionFit } | { ok: false; failure: DistortionFitFailure } {
  const usable = lines.filter((l) => l.points.length >= MIN_POINTS_PER_LINE);

  if (usable.length < MIN_LINES) {
    return {
      ok: false,
      failure: {
        reason: usable.length === 0 ? 'too_few_points' : 'too_few_lines',
        message:
          `Mark at least ${MIN_LINES} lines with ${MIN_POINTS_PER_LINE} points each. Two lines ` +
          `at different distances from the middle of the frame have to be straightened by the ` +
          `same amount — that is what makes the answer trustworthy rather than just tidy.`,
      },
    };
  }

  // Principal point at the image centre. An assumption, and recorded as one:
  // decentring on a consumer lens is a fraction of a percent of the frame,
  // which is well inside what tapped points can resolve. Solving for it here
  // would trade a small known error for a large unstable one.
  const principal: Point = { x: imageWidthPx / 2, y: imageHeightPx / 2 };
  // Half-diagonal, so λ is dimensionless and comparable between a 1080p frame
  // and a 4K one from the same lens.
  const normalisation = 0.5 * Math.hypot(imageWidthPx, imageHeightPx);

  const normalised = usable.map((line) =>
    line.points.map((p) => ({
      x: (p.x - principal.x) / normalisation,
      y: (p.y - principal.y) / normalisation,
    })),
  );

  const objective = (lambda: number): number => {
    let total = 0;
    for (const pts of normalised) {
      total += straightnessResidual(pts.map((p) => undistortPoint(p, lambda)));
    }
    return total;
  };

  // Coarse scan then golden-section refine. A scan alone is not precise enough
  // and a search alone can settle into a local minimum: the objective is not
  // guaranteed unimodal across the full range, and a fisheye frame has a second
  // basin where the correction over-shoots and re-bends the lines the other way.
  let best = 0;
  let bestValue = Number.POSITIVE_INFINITY;
  const STEPS = 160;
  for (let i = 0; i <= STEPS; i += 1) {
    const lambda = -LAMBDA_RANGE + (2 * LAMBDA_RANGE * i) / STEPS;
    const v = objective(lambda);
    if (v < bestValue) {
      bestValue = v;
      best = lambda;
    }
  }

  const width = (2 * LAMBDA_RANGE) / STEPS;
  const refined = goldenSection(objective, best - width, best + width);

  const pointCount = normalised.reduce((n, pts) => n + pts.length, 0);
  const residualBefore = Math.sqrt(objective(0) / pointCount) * normalisation;
  const residualAfter = Math.sqrt(objective(refined) / pointCount) * normalisation;

  if (!Number.isFinite(residualAfter)) {
    return {
      ok: false,
      failure: {
        reason: 'degenerate',
        message:
          'Those points could not be fitted. Check that each line really is a straight line on ' +
          'the pitch and that the points are spread along it rather than bunched together.',
      },
    };
  }

  return {
    ok: true,
    fit: {
      model: 'division',
      lambda: refined,
      normalisationPx: normalisation,
      principalPointPx: principal,
      imageWidthPx,
      imageHeightPx,
      rmsResidualPx: residualAfter,
      rmsResidualBeforePx: residualBefore,
      lineCount: usable.length,
      pointCount,
    },
  };
}

/**
 * Was the fit worth doing?
 *
 * A lens with no distortion produces λ near zero and no improvement, and that
 * is a perfectly good result — it should be reported as "this lens is
 * straight", not as a failure. What is NOT good is a large λ that barely
 * improves the residual: that means the points were tapped badly, and the
 * coefficient is describing the operator's aim rather than the lens.
 */
export function fitIsCredible(fit: DistortionFit): boolean {
  const negligible = Math.abs(fit.lambda) < 0.005;
  if (negligible) {
    return true;
  }
  // A real correction should remove most of the bend it claims to explain.
  return fit.rmsResidualPx < fit.rmsResidualBeforePx * 0.5;
}

/**
 * How far a straight line at the frame edge actually bows, in pixels.
 *
 * PRD §4.3 requires this be shown to the operator, and it is the right number
 * to show: a coefficient of −0.09 means nothing to anybody, whereas "a straight
 * line bows 34 pixels at the edge of your frame" is immediately legible and
 * answers the only question they have — did this camera need correcting at all?
 *
 * Computed where it matters. A line across the top of the frame, near the edge,
 * is undistorted and the largest perpendicular deviation from its own best fit
 * is the sagitta. The centre of a lens is very nearly rectilinear; the corners
 * are the whole problem, so the measurement is taken there.
 */
export function edgeBowPx(fit: DistortionFit): number {
  const { imageWidthPx: w, imageHeightPx: h } = fit;
  // 5% in from the top edge: far enough out to show the distortion, not so far
  // that it sits in the extreme corner where a division model is least valid.
  const y = h * 0.05;
  const SAMPLES = 41;
  const points: Point[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    points.push(undistortPixel(fit, { x: (w * i) / (SAMPLES - 1), y }));
  }

  // Perpendicular deviation from the straight line through the two endpoints —
  // which is what "bow" means to a person looking at a touchline.
  const a = points[0] as Point;
  const b = points[points.length - 1] as Point;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    return 0;
  }

  let maxDeviation = 0;
  for (const p of points) {
    const deviation = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
    }
  }
  return maxDeviation;
}

/**
 * Approximate Brown-Conrady k1, for consumers that only speak that model.
 *
 * From the first-order expansion of the division model: 1/(1 + λr²) ≈ 1 − λr².
 * Valid while λr² is small, which it is over most of a frame and is not at the
 * extreme corners of a fisheye. The record stores the division coefficient as
 * the truth and this as a convenience, never the other way round.
 */
export function approximateBrownK1(fit: DistortionFit): number {
  return -fit.lambda;
}

/** Apply the correction. Exposed so an overlay can show the operator the result. */
export function undistortPixel(fit: DistortionFit, p: Point): Point {
  const n = {
    x: (p.x - fit.principalPointPx.x) / fit.normalisationPx,
    y: (p.y - fit.principalPointPx.y) / fit.normalisationPx,
  };
  const u = undistortPoint(n, fit.lambda);
  return {
    x: u.x * fit.normalisationPx + fit.principalPointPx.x,
    y: u.y * fit.normalisationPx + fit.principalPointPx.y,
  };
}

/* ── Internals ────────────────────────────────────────────────────────────── */

function undistortPoint(p: Point, lambda: number): Point {
  const r2 = p.x * p.x + p.y * p.y;
  const d = 1 + lambda * r2;
  // A divisor at or below zero means the correction has folded the image
  // through itself. Returning the point unchanged keeps the objective finite
  // so the search walks away from that region instead of returning NaN.
  if (d <= 1e-6) {
    return p;
  }
  return { x: p.x / d, y: p.y / d };
}

/**
 * Sum of squared perpendicular distances to the best-fit line.
 *
 * Total least squares, via the smaller eigenvalue of the 2×2 covariance —
 * which for a symmetric 2×2 is closed form, so there is no iteration and no
 * matrix library. Perpendicular distance rather than vertical: a touchline
 * tapped near-vertically in frame would have an unbounded vertical residual
 * and a perfectly small real one.
 */
function straightnessResidual(points: Point[]): number {
  const n = points.length;
  if (n < 3) {
    return 0;
  }

  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // Smaller eigenvalue of [[sxx, sxy], [sxy, syy]] — the summed squared
  // perpendicular deviation along the minor axis.
  const trace = sxx + syy;
  const diff = sxx - syy;
  const root = Math.sqrt(diff * diff + 4 * sxy * sxy);
  return Math.max(0, (trace - root) / 2);
}

/** Golden-section minimisation on a bracketed interval. */
function goldenSection(f: (x: number) => number, lo: number, hi: number): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = f(c);
  let fd = f(d);

  for (let i = 0; i < 60 && Math.abs(b - a) > 1e-7; i += 1) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}
