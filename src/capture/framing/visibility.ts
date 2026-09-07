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
 * It is not, for two reasons.
 *
 * SPREAD DOMINATES. Ten landmarks clustered inside one penalty area constrain
 * a homography far worse than five spread corner to corner. The clustered
 * solve is beautifully conditioned where the points are and diverges rapidly
 * everywhere else — which is the far half of the pitch, where the players are.
 *
 * COLLINEARITY IS FATAL AND LOOKS FINE. Four points along a single touchline
 * are four points. They also define no homography at all: the solve is
 * singular, and the failure is not a warning but a matrix that will not invert
 * — or worse, one that barely inverts and produces enormous numbers.
 *
 * So this measures three things — how many, how spread, how well conditioned —
 * and the last two carry more weight than the first.
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

export interface VisibilityReport {
  /** How many distinct landmarks the detector currently sees. */
  count: number;
  /** Area of their convex hull in pitch square metres. The spread measure. */
  spreadM2: number;
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
   at ingest is a visible diff rather than a subtle one.
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

export function assessVisibility(visible: Landmark[]): VisibilityReport {
  const count = visible.length;
  const points = visible.map((l) => ({ x: l.x, y: l.y }));
  const spreadM2 = convexHullArea(points);
  const conditioning = conditioningOf(points);

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
    return { count, spreadM2, conditioning, regions, issues, ok: false };
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

  // Only meaningful once there are enough points for a hull to mean something.
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
          'The visible markings all lie along one line — a touchline, most likely. Points in a ' +
          'straight line cannot fix a camera position at all, however many there are. Tilt down ' +
          'or swing across so markings from the width of the pitch come into frame.',
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

  return {
    count,
    spreadM2,
    conditioning,
    regions,
    issues,
    ok: !issues.some((i) => i.blocking),
  };
}

/* ── Geometry ─────────────────────────────────────────────────────────────── */

interface P {
  x: number;
  y: number;
}

/**
 * Convex hull area, by monotone chain.
 *
 * The hull rather than a bounding box: a bounding box around an L-shaped
 * scatter reports the area of a rectangle that is mostly empty, which is
 * exactly the arrangement — two touchline runs meeting at a corner — this is
 * meant to catch.
 */
export function convexHullArea(points: P[]): number {
  if (points.length < 3) {
    return 0;
  }
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: P[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as P, lower[lower.length - 1] as P, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: P[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i] as P;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as P, upper[upper.length - 1] as P, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
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

/**
 * How far from collinear, 0 to 1.
 *
 * The ratio of the two principal spreads — the square roots of the covariance
 * eigenvalues — so it is a ratio of lengths rather than of variances, and
 * therefore reads linearly. A perfect line is 0; points filling a circle
 * approach 1.
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
