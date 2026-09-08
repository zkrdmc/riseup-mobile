/**
 * Can this view be solved from?
 *
 * The live gate that runs behind the setup walkthrough: a detector reports
 * which pitch landmarks it can currently see, and this decides whether that is
 * enough — while the tripod is still in someone's hands and the answer can
 * still change.
 *
 * Same shape as `FramingIssue` in `camera/rig.py` and `SurveyIssue`: a code, a
 * blocking flag, and a sentence. The operator does not care which check found
 * the problem.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  COUNTING IS THE OBVIOUS METRIC AND THE WRONG ONE
 * ══════════════════════════════════════════════════════════════════════════
 * A homography needs four points, so counting to four feels like the check.
 * It is not, for three reasons.
 *
 * SPREAD DOMINATES COUNT. Ten landmarks clustered inside one penalty area
 * constrain a homography far worse than five spread corner to corner. The
 * clustered solve is beautifully conditioned where the points are and diverges
 * rapidly everywhere else — which is the far half of the pitch, where the
 * players are.
 *
 * COLLINEARITY IS FATAL AND LOOKS FINE. Four points along a single touchline
 * are four points. They also define no homography at all: the solve is
 * singular, and the failure is not a warning but a matrix that will not invert
 * — or worse, one that barely inverts and produces enormous numbers.
 *
 * EXTENT IS NOT COVERAGE, and this is the subtle one. A convex hull can be
 * large while leaving its own middle empty: landmarks bunched at both ends of
 * the pitch and nothing in between score beautifully on hull area and badly
 * exactly where play happens. Fitting error is smallest at the points and
 * grows away from them in every direction — while the RESIDUAL stays flat,
 * because a residual only ever measures fit AT the points. So a solve over
 * clustered landmarks reports a small residual and is wrong across the centre
 * circle, and nothing inside the fit says so.
 *
 * The measure that catches that is the largest distance, anywhere in the
 * region being measured, to the nearest landmark: a direct proxy for
 * worst-case extrapolation, and the number that separates "spread out" from
 * "actually covering the pitch".
 *
 * So this measures four things — how many, how far apart, how well
 * conditioned, and how far the worst-covered spot is from any anchor — and the
 * last three carry more weight than the first.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. Solve anything. PRD §4.2 chose manual
 * point-tapping over automatic detection because "a viewfinder overlay that
 * silently mis-solves is worse than one that asks", and that reasoning still
 * holds. This reports coverage and refuses; the operator's taps remain the
 * calibration. A check that cannot solve cannot mis-solve.
 */

import type { Landmark } from './landmarks';

export interface VisibilityIssue {
  code: string;
  blocking: boolean;
  message: string;
}

/**
 * The stretch of pitch a camera is answerable for.
 *
 * A camera covering the west half is not expected to anchor the east one, so
 * judging its coverage against the whole pitch would fail every correctly
 * aimed rig. Metres, in the same frame as the landmarks.
 */
export interface RegionOfInterest {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The whole pitch — right for a single-camera rig, and for a pair combined. */
export function wholePitch(lengthM: number, widthM: number): RegionOfInterest {
  return { minX: 0, maxX: lengthM, minY: 0, maxY: widthM };
}

/**
 * One camera's half, plus the overlap band it has to share.
 *
 * The band is where identity handover happens (rig.py wants 12 m of it), so a
 * camera is answerable for its own half AND for reaching far enough into the
 * middle to meet the other one.
 */
export function halfWithOverlap(
  lengthM: number,
  widthM: number,
  half: 'west' | 'east',
  overlapM = 12,
): RegionOfInterest {
  const mid = lengthM / 2;
  return half === 'west'
    ? { minX: 0, maxX: Math.min(lengthM, mid + overlapM / 2), minY: 0, maxY: widthM }
    : { minX: Math.max(0, mid - overlapM / 2), maxX: lengthM, minY: 0, maxY: widthM };
}

export interface VisibilityReport {
  /** How many distinct landmarks the detector currently sees. */
  count: number;
  /** Area of their convex hull in pitch square metres. The EXTENT measure. */
  spreadM2: number;
  /**
   * Largest distance, in metres, from anywhere in the region of interest to
   * the nearest visible landmark.
   *
   * The COVERAGE measure, and the one that catches a wide hull with a hole in
   * the middle. Null when no region was supplied.
   */
  worstGapM: number | null;
  /** Fraction of the region of interest enclosed by the landmark hull. */
  hullCoverage: number | null;
  /**
   * How far from a straight line the points are, 0 to 1.
   *
   * The ratio of the smaller to the larger principal spread. Near 0 means
   * collinear and unsolvable; near 1 means well distributed in both axes.
   */
  conditioning: number;
  /** Which thirds of the pitch are represented. Distribution, not just spread. */
  regions: Array<'west' | 'centre' | 'east'>;
  issues: VisibilityIssue[];
  /** True when nothing blocking was found. The record button reads this. */
  ok: boolean;
}

/* ── Thresholds ───────────────────────────────────────────────────────────────
   Product decisions. Named, so a drift between this and the server's re-check
   at ingest is a visible diff rather than a subtle one. Every one of them
   wants field validation, exactly as RigRequirements says of its own.
   ─────────────────────────────────────────────────────────────────────────── */

/** Four solves a homography with zero redundancy — one bad point is undetectable. */
const MIN_LANDMARKS_BLOCKING = 6;
/** Below this it will solve, but with little margin for a mis-detection. */
const MIN_LANDMARKS_ADVISORY = 10;

/**
 * Convex hull area below which the points are effectively one cluster.
 *
 * A penalty area is 16.5 × 40.32, about 665 m². Requiring more than that means
 * the points cannot all have come from inside one box.
 */
const MIN_SPREAD_M2_BLOCKING = 700;
const MIN_SPREAD_M2_ADVISORY = 2500;

/** Below this the points are close enough to a straight line to be unsolvable. */
const MIN_CONDITIONING_BLOCKING = 0.06;
const MIN_CONDITIONING_ADVISORY = 0.18;

/**
 * How far the worst-covered spot may sit from the nearest landmark.
 *
 * The extrapolation budget. Error grows with distance from the anchors, so
 * this is the lever saying how much of that growth is tolerable before the
 * numbers stop meaning anything.
 *
 * Chosen to be defensible rather than measured: 40 m is roughly where a
 * landmark set at both ends leaves the centre circle unanchored, and 25 m is
 * about a penalty area's diagonal. The fit-set experiment showing error
 * growing away from the clicked points is the right data to set these from
 * properly.
 */
const MAX_GAP_M_BLOCKING = 40;
const MAX_GAP_M_ADVISORY = 25;

/** Fraction of the region of interest that must fall inside the landmark hull. */
const MIN_HULL_COVERAGE_BLOCKING = 0.35;
const MIN_HULL_COVERAGE_ADVISORY = 0.6;

/**
 * How the camera is being used, because it changes what "enough" means.
 *
 * `fixed`  — bolted down for the whole match. It has to cover its region in
 *            one view, so the coverage checks apply.
 * `panned` — an operator turning it to follow play. It never sees the whole
 *            region at once and is not expected to: what matters is that at
 *            EVERY instant enough of the pitch is in shot to place the frame.
 *            Judging a panned camera against whole-region coverage fails a
 *            correctly operated rig on every frame.
 */
export type CameraMode = 'fixed' | 'panned';

export function assessVisibility(
  visible: Landmark[],
  roi: RegionOfInterest | null = null,
  mode: CameraMode = 'fixed',
): VisibilityReport {
  const count = visible.length;
  const points = visible.map((l) => ({ x: l.x, y: l.y }));
  const spreadM2 = convexHullArea(points);
  const conditioning = conditioningOf(points);
  const coverage = roi === null || count === 0 ? null : measureCoverage(points, roi);
  const worstGapM = coverage?.worstGapM ?? null;
  const hullCoverage = coverage?.hullCoverage ?? null;

  const regions = Array.from(new Set(visible.map((l) => l.region))).sort();
  const issues: VisibilityIssue[] = [];

  if (count === 0) {
    issues.push({
      code: 'NO_LANDMARKS',
      blocking: true,
      message:
        'No pitch markings can be found in this view. Check the camera is pointing at the field, ' +
        'and that the lines are visible in the light you have.',
    });
    return {
      count,
      spreadM2,
      worstGapM,
      hullCoverage,
      conditioning,
      regions,
      issues,
      ok: false,
    };
  }

  if (count < MIN_LANDMARKS_BLOCKING) {
    issues.push({
      code: 'TOO_FEW_LANDMARKS',
      blocking: true,
      message:
        `Only ${count} pitch ${count === 1 ? 'marking is' : 'markings are'} visible, and at least ` +
        `${MIN_LANDMARKS_BLOCKING} are needed to work out where the camera is. Move it back or ` +
        `swing it so more of the pitch is in frame — corners and penalty boxes are what count.`,
    });
  } else if (count < MIN_LANDMARKS_ADVISORY) {
    issues.push({
      code: 'FEW_LANDMARKS',
      blocking: false,
      message:
        `${count} pitch markings visible. Enough to work with, but a few more would make the ` +
        `calibration steadier — try to get a penalty box fully in frame.`,
    });
  }

  if (count >= 3) {
    if (spreadM2 < MIN_SPREAD_M2_BLOCKING) {
      issues.push({
        code: 'LANDMARKS_CLUSTERED',
        blocking: true,
        message:
          'The markings that are visible are all bunched in one part of the pitch. That fixes the ' +
          'camera accurately just there and badly everywhere else, which is where the players ' +
          'will be. Widen the view so markings from further apart are in frame.',
      });
    } else if (spreadM2 < MIN_SPREAD_M2_ADVISORY) {
      issues.push({
        code: 'LANDMARKS_NARROW',
        blocking: false,
        message:
          'The visible markings do not spread very far across the pitch. It will work, but the ' +
          'far end will be less accurate than the near end.',
      });
    }

    if (conditioning < MIN_CONDITIONING_BLOCKING) {
      issues.push({
        code: 'LANDMARKS_COLLINEAR',
        blocking: true,
        message:
          'The visible markings all lie along one line — a goal line or a touchline, most likely. ' +
          'Points in a straight line cannot fix a camera position at all, however many there are. ' +
          'Tilt or swing so markings from across the pitch come into frame.',
      });
    } else if (conditioning < MIN_CONDITIONING_ADVISORY) {
      issues.push({
        code: 'LANDMARKS_NEARLY_COLLINEAR',
        blocking: false,
        message:
          'The visible markings are nearly in a straight line, which makes the calibration ' +
          'sensitive to small errors. Getting a goal area or a penalty box in frame would help.',
      });
    }
  }

  // Coverage of the region actually being measured. After the extent checks,
  // because a view can pass every one of them and still leave a hole where the
  // play is — the failure hull area cannot see.
  // Coverage of the region is a FIXED-camera question. A panned camera is
  // judged on whether the current view can be placed at all, which is the
  // count, spread and conditioning above — it is supposed to be looking at a
  // fraction of its region, and failing it for that would fail every frame.
  if (mode === 'fixed' && coverage !== null && count >= 3) {
    if (coverage.worstGapM > MAX_GAP_M_BLOCKING) {
      issues.push({
        code: 'COVERAGE_GAP',
        blocking: true,
        message:
          `Part of the pitch is ${coverage.worstGapM.toFixed(0)} m from the nearest visible ` +
          `marking. Positions there would be stretched from markings far away — and it would not ` +
          `look wrong, because the calibration reports a good fit either way. Get a marking ` +
          `nearer the middle into frame: the centre circle, or a penalty box.`,
      });
    } else if (coverage.worstGapM > MAX_GAP_M_ADVISORY) {
      issues.push({
        code: 'COVERAGE_THIN',
        blocking: false,
        message:
          `The emptiest part of the pitch is ${coverage.worstGapM.toFixed(0)} m from any visible ` +
          `marking. It will work, but positions will be least accurate there.`,
      });
    }

    if (coverage.hullCoverage < MIN_HULL_COVERAGE_BLOCKING) {
      issues.push({
        code: 'ROI_NOT_ENCLOSED',
        blocking: true,
        message:
          `The visible markings enclose only ${Math.round(coverage.hullCoverage * 100)}% of the ` +
          `area this camera is responsible for. Everything outside them is extrapolated rather ` +
          `than measured. Widen the view, or move the camera back.`,
      });
    } else if (coverage.hullCoverage < MIN_HULL_COVERAGE_ADVISORY) {
      issues.push({
        code: 'ROI_PARTLY_ENCLOSED',
        blocking: false,
        message:
          `The markings enclose ${Math.round(coverage.hullCoverage * 100)}% of this camera's ` +
          `area. The rest is extrapolated, and less accurate.`,
      });
    }
  }

  // The live risk while panning: swinging onto open grass with no marking in
  // shot. The frame then cannot be placed at all, and the gap is invisible on
  // the footage — it looks like perfectly good video of a passage of play.
  if (mode === 'panned' && count >= MIN_LANDMARKS_BLOCKING && count < MIN_LANDMARKS_ADVISORY) {
    issues.push({
      code: 'PANNED_THIN_ANCHORS',
      blocking: false,
      message:
        `Only ${count} markings are in shot. That is enough right now, but swing much further ` +
        `and there will be nothing to place the picture against. Keep a touchline or a penalty ` +
        `box in view as you follow the play.`,
    });
  }

  return {
    count,
    spreadM2,
    worstGapM,
    hullCoverage,
    conditioning,
    regions,
    issues,
    ok: !issues.some((i) => i.blocking),
  };
}

/* ── Geometry ─────────────────────────────────────────────────────────────── */

export interface P {
  x: number;
  y: number;
}

/**
 * How well a set of landmarks COVERS a region, as opposed to spanning it.
 *
 * Two numbers from one pass over a grid:
 *
 *   `worstGapM`    the largest distance from any point in the region to the
 *                  nearest landmark. Catches a hole in the middle of a wide
 *                  hull — the arrangement that scores well on extent and
 *                  produces a confident, wrong solve across the centre.
 *
 *   `hullCoverage` the fraction of the region enclosed by the landmarks.
 *                  Inside the hull a solve interpolates; outside it
 *                  extrapolates, and extrapolation is where a homography goes
 *                  wrong fastest.
 *
 * A 2 m grid is about 1,800 samples on a full pitch — microseconds, and finer
 * than any threshold here can distinguish.
 */
export function measureCoverage(
  points: P[],
  roi: RegionOfInterest,
  stepM = 2,
): { worstGapM: number; hullCoverage: number } {
  if (points.length === 0) {
    return { worstGapM: Number.POSITIVE_INFINITY, hullCoverage: 0 };
  }

  const hull = convexHull(points);
  let worstGapM = 0;
  let inside = 0;
  let total = 0;

  for (let x = roi.minX; x <= roi.maxX; x += stepM) {
    for (let y = roi.minY; y <= roi.maxY; y += stepM) {
      total += 1;

      let nearest = Number.POSITIVE_INFINITY;
      for (const p of points) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < nearest) {
          nearest = d;
        }
      }
      if (nearest > worstGapM) {
        worstGapM = nearest;
      }

      if (hull.length >= 3 && pointInConvexPolygon({ x, y }, hull)) {
        inside += 1;
      }
    }
  }

  return { worstGapM, hullCoverage: total === 0 ? 0 : inside / total };
}

/** Counter-clockwise convex hull, monotone chain. */
export function convexHull(points: P[]): P[] {
  if (points.length < 3) {
    return [...points];
  }
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: P[] = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2] as P, lower[lower.length - 1] as P, p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: P[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i] as P;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2] as P, upper[upper.length - 1] as P, p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * Convex hull area, by monotone chain.
 *
 * The hull rather than a bounding box: a box around an L-shaped scatter
 * reports the area of a rectangle that is mostly empty, which is exactly the
 * arrangement — two touchline runs meeting at a corner — this must catch.
 */
export function convexHullArea(points: P[]): number {
  const hull = convexHull(points);
  if (hull.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i] as P;
    const b = hull[(i + 1) % hull.length] as P;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** Inside-or-on a counter-clockwise convex polygon. */
function pointInConvexPolygon(p: P, hull: P[]): boolean {
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i] as P;
    const b = hull[(i + 1) % hull.length] as P;
    // A negative cross product puts the point to the right of an edge, which
    // for a counter-clockwise hull means outside.
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -1e-9) {
      return false;
    }
  }
  return true;
}

/**
 * How far from collinear, 0 to 1.
 *
 * The ratio of the two principal spreads — square roots of the covariance
 * eigenvalues — so it is a ratio of lengths rather than of variances, and
 * reads linearly. A perfect line is 0; points filling a circle approach 1.
 *
 * Scale-free on purpose: a well-conditioned view of a small area and of a
 * large one should both score well, because the size question is `spreadM2`
 * and mixing the two into one number makes both unreadable.
 */
export function conditioningOf(points: P[]): number {
  if (points.length < 3) {
    return 0;
  }

  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;

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

  const trace = sxx + syy;
  const diff = sxx - syy;
  const root = Math.sqrt(diff * diff + 4 * sxy * sxy);
  const major = (trace + root) / 2;
  const minor = (trace - root) / 2;

  if (major <= 1e-9) {
    return 0;
  }
  // Square roots, so this is a ratio of extents rather than of variances.
  return Math.sqrt(Math.max(0, minor) / major);
}
