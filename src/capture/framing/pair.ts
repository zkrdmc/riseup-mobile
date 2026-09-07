/**
 * Is the RIG adequate — not just each camera in it.
 *
 * A per-camera gate answers the wrong question twice over.
 *
 * IT FAILS VIEWS THAT ARE FINE. A camera seeing only its own goal area is
 * unsolvable alone, and perfectly usable when the other camera shares six
 * landmarks with it: the pair is over-determined even though neither half is.
 * Refusing that view sends an operator to move a camera that was correctly
 * placed.
 *
 * IT PASSES RIGS THAT ARE NOT. Two cameras can each see a beautiful, well
 * spread, well conditioned set of landmarks — one at each end of the pitch,
 * sharing nothing. Both pass. The rig is useless: there is no common
 * geometry to relate the two views, so a player crossing the halfway line is
 * two unrelated tracks and the stitch has nothing to align on.
 *
 * The second failure is the dangerous one, because every individual check
 * reports green.
 *
 * SO THE PAIR IS EVALUATED ONCE BOTH CAMERAS ARE PLACED, and it asks three
 * things the individual checks cannot:
 *
 *   1. Do they SHARE enough landmarks to be related to each other at all?
 *   2. Are the shared ones spread, or all bunched at one point?
 *   3. Does the union cover the whole pitch, including the middle?
 */

import type { Landmark } from './landmarks';
import {
  assessVisibility,
  conditioningOf,
  convexHullArea,
  measureCoverage,
  wholePitch,
  type RegionOfInterest,
  type VisibilityIssue,
  type VisibilityReport,
} from './visibility';

export interface PairReport {
  /** Each camera judged on its own, against its own half. */
  perCamera: { A: VisibilityReport; B: VisibilityReport };
  /** Landmarks both cameras can see. What relates the two views. */
  sharedCount: number;
  /**
   * Extent of the shared landmarks: the largest distance between any two of
   * them, in metres.
   *
   * A DIAMETER, not an extent along the pitch length. The overlap band is a
   * strip ACROSS the pitch at the halfway line, so the landmarks inside it
   * share an x and spread in y — measuring along the length reports zero for a
   * shared set spanning the full 68 m width.
   */
  sharedSpreadM: number;
  /** How well conditioned the shared set is, 0 to 1. */
  sharedConditioning: number;
  /** Union of both, judged against the whole pitch. */
  combined: VisibilityReport;
  issues: VisibilityIssue[];
  /**
   * Per-camera failures the pair makes survivable, by code and role.
   *
   * Reported rather than hidden: an operator should know their west camera is
   * weak on its own even when the rig as a whole is fine, because it becomes
   * the thing to fix if the other camera is ever moved.
   */
  compensated: Array<{ role: 'A' | 'B'; code: string }>;
  ok: boolean;
}

/* ── Thresholds ───────────────────────────────────────────────────────────── */

/**
 * Landmarks that must be visible to BOTH cameras.
 *
 * Four is the minimum that relates two views by a plane-to-plane transform,
 * and four with no redundancy means one mis-detection is undetectable — the
 * same argument as the per-camera count. Six gives the pair something to
 * disagree with.
 */
const MIN_SHARED_BLOCKING = 4;
const MIN_SHARED_ADVISORY = 6;

/**
 * How far apart the shared landmarks must reach.
 *
 * rig.py wants a 12 m overlap band for identity handover, and shared landmarks
 * are the surveyable proxy for it. Four shared points inside one goal area are
 * about five metres apart and relate the two views only in that spot — the
 * transform hinges there and swings everywhere else.
 */
const MIN_SHARED_SPREAD_M = 12;

/** Shared points closer to a line than this cannot fix a relative transform. */
const MIN_SHARED_CONDITIONING = 0.08;

/**
 * Per-camera failures the pair can carry.
 *
 * A camera short of landmarks, clustered, collinear or thinly covering its own
 * half can still be anchored through the shared set, because the pair solves
 * jointly. What cannot be carried is a camera seeing NOTHING: there is no
 * shared geometry to relate it by, and no amount of coverage from the other
 * camera invents one.
 */
const COMPENSABLE_CODES = new Set([
  'TOO_FEW_LANDMARKS',
  'LANDMARKS_CLUSTERED',
  'LANDMARKS_COLLINEAR',
  'COVERAGE_GAP',
  'ROI_NOT_ENCLOSED',
]);

export function assessPair(input: {
  a: Landmark[];
  b: Landmark[];
  roiA: RegionOfInterest;
  roiB: RegionOfInterest;
  pitchLengthM: number;
  pitchWidthM: number;
}): PairReport {
  const { a, b, roiA, roiB, pitchLengthM, pitchWidthM } = input;

  const perA = assessVisibility(a, roiA);
  const perB = assessVisibility(b, roiB);

  const bIds = new Set(b.map((l) => l.id));
  const shared = a.filter((l) => bIds.has(l.id));
  const sharedPoints = shared.map((l) => ({ x: l.x, y: l.y }));

  const sharedSpreadM = maxPairwiseDistance(sharedPoints);
  const sharedConditioning = conditioningOf(sharedPoints);

  // Union by id — a landmark seen by both is one landmark, not two.
  const unionById = new Map<string, Landmark>();
  for (const l of [...a, ...b]) {
    unionById.set(l.id, l);
  }
  const combined = assessVisibility(
    [...unionById.values()],
    wholePitch(pitchLengthM, pitchWidthM),
  );

  const issues: VisibilityIssue[] = [];

  /* 1. Can the two views be related at all? */

  if (shared.length < MIN_SHARED_BLOCKING) {
    issues.push({
      code: 'PAIR_NO_COMMON_GROUND',
      blocking: true,
      message:
        `The two cameras only share ${shared.length} pitch ${shared.length === 1 ? 'marking' : 'markings'}, ` +
        `and at least ${MIN_SHARED_BLOCKING} are needed to link their views. Each camera may look ` +
        `fine on its own and the rig still will not work: a player crossing the halfway line ` +
        `becomes two different players. Angle them further toward each other so they overlap in ` +
        `the middle.`,
    });
  } else if (shared.length < MIN_SHARED_ADVISORY) {
    issues.push({
      code: 'PAIR_THIN_COMMON_GROUND',
      blocking: false,
      message:
        `The cameras share ${shared.length} markings. Enough to link them, with no margin — if ` +
        `one is mis-detected during the match the link weakens. A little more overlap would be ` +
        `steadier.`,
    });
  }

  /* 2. Are the shared landmarks spread, or all in one spot? */

  if (shared.length >= MIN_SHARED_BLOCKING) {
    if (sharedSpreadM < MIN_SHARED_SPREAD_M) {
      issues.push({
        code: 'PAIR_OVERLAP_TOO_NARROW',
        blocking: true,
        message:
          `The markings both cameras can see are only ${sharedSpreadM.toFixed(0)} m apart, and ` +
          `about ${MIN_SHARED_SPREAD_M} m is needed to hand a player from one camera to the ` +
          `other. Widen the band where the two views meet.`,
      });
    }

    if (sharedConditioning < MIN_SHARED_CONDITIONING) {
      issues.push({
        code: 'PAIR_OVERLAP_COLLINEAR',
        blocking: true,
        message:
          'Everything the two cameras share lies along one line — the halfway line, most likely. ' +
          'Points in a line cannot fix how two views relate, however many there are, so the ' +
          'halfway markings alone are not enough. Widen the overlap until both cameras can also ' +
          'see something off that line: a penalty box corner, or the centre circle edge.',
      });
    }
  }

  /* 3. Does the pair, together, cover the pitch? */

  const unionCoverage = measureCoverage(
    [...unionById.values()].map((l) => ({ x: l.x, y: l.y })),
    wholePitch(pitchLengthM, pitchWidthM),
  );
  if (unionCoverage.worstGapM > 40) {
    issues.push({
      code: 'PAIR_COVERAGE_GAP',
      blocking: true,
      message:
        `Even with both cameras, part of the pitch is ${unionCoverage.worstGapM.toFixed(0)} m ` +
        `from the nearest marking either of them can see. Positions there are guesswork. Move ` +
        `the rig back so more of the field is in frame.`,
    });
  }

  /* Per-camera failures the pair carries. */

  const compensated: PairReport['compensated'] = [];
  const relatable =
    shared.length >= MIN_SHARED_BLOCKING &&
    sharedSpreadM >= MIN_SHARED_SPREAD_M &&
    sharedConditioning >= MIN_SHARED_CONDITIONING;

  for (const [role, report] of [
    ['A', perA],
    ['B', perB],
  ] as Array<['A' | 'B', VisibilityReport]>) {
    for (const issue of report.issues) {
      if (!issue.blocking) {
        continue;
      }
      if (relatable && COMPENSABLE_CODES.has(issue.code)) {
        // Solved jointly through the shared landmarks, so it does not block —
        // but it is reported, because it becomes the thing to fix the moment
        // the other camera moves.
        compensated.push({ role, code: issue.code });
        continue;
      }
      issues.push({
        ...issue,
        code: `${role}_${issue.code}`,
        message: `Camera ${role}: ${issue.message}`,
      });
    }
  }

  return {
    perCamera: { A: perA, B: perB },
    sharedCount: shared.length,
    sharedSpreadM,
    sharedConditioning,
    combined,
    issues,
    compensated,
    ok: !issues.some((i) => i.blocking),
  };
}

/** Extent of the shared landmarks in square metres, for a readout. */
export function sharedSpreadM2(a: Landmark[], b: Landmark[]): number {
  const bIds = new Set(b.map((l) => l.id));
  return convexHullArea(a.filter((l) => bIds.has(l.id)).map((l) => ({ x: l.x, y: l.y })));
}

/** Largest distance between any two points. The honest extent of a scatter. */
function maxPairwiseDistance(points: Array<{ x: number; y: number }>): number {
  let worst = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i] as { x: number; y: number };
      const b = points[j] as { x: number; y: number };
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > worst) {
        worst = d;
      }
    }
  }
  return worst;
}
