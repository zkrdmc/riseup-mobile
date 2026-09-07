/**
 * The pitch landmarks a camera can be checked against.
 *
 * Every point here is defined by the Laws of the Game, so its position is
 * known from the pitch dimensions alone — which is what makes them usable as
 * a yardstick: if a detector says it can see the west penalty spot, we know
 * exactly where that is in metres, with no calibration and no model of the
 * camera.
 *
 * COORDINATE FRAME matches `camera/rig.py` in riseup-ml: pitch metres, origin
 * at a corner, x along the 105 m axis, y along the 68 m axis. Sharing the
 * frame is deliberate — a landmark set in one convention and a coverage check
 * in another is a class of bug that produces plausible numbers.
 *
 * DIMENSIONS THAT ARE FIXED vs SCALED. Pitch length and width vary between
 * grounds and are surveyed (§4.3). Everything inside the pitch does not vary:
 * a penalty area is 16.5 m deep and 40.32 m wide on a school field and at the
 * Bernabéu. So the boundary landmarks scale with the survey and the interior
 * ones are absolute, which is why this takes real dimensions rather than
 * assuming 105 × 68.
 */

/** Where a landmark sits, for judging spread rather than just counting. */
export type LandmarkRegion = 'west' | 'centre' | 'east';

export interface Landmark {
  id: string;
  /** Shown to the operator when guidance names a specific point. */
  label: string;
  /** Metres along the length axis. */
  x: number;
  /** Metres across the width axis. */
  y: number;
  region: LandmarkRegion;
}

/* ── Fixed dimensions, in metres. Laws of the Game. ───────────────────────── */

const PENALTY_AREA_DEPTH = 16.5;
/** Half-width of the penalty area: 40.32 m total. */
const PENALTY_AREA_HALF_WIDTH = 20.16;
const GOAL_AREA_DEPTH = 5.5;
/** Half-width of the goal area: 18.32 m total. */
const GOAL_AREA_HALF_WIDTH = 9.16;
const PENALTY_SPOT_DISTANCE = 11;
const CENTRE_CIRCLE_RADIUS = 9.15;
/** Half-width of the goal itself: 7.32 m total. */
const GOAL_HALF_WIDTH = 3.66;

/**
 * Every landmark on a pitch of the given size.
 *
 * Thirty-two points, and the count matters less than the spread: a homography
 * needs four, but four bunched inside one penalty area constrains it terribly.
 * `visibility.ts` is where that distinction is enforced.
 */
export function pitchLandmarks(lengthM: number, widthM: number): Landmark[] {
  const L = lengthM;
  const W = widthM;
  const midY = W / 2;
  const marks: Landmark[] = [];

  const add = (id: string, label: string, x: number, y: number) => {
    // Region from position along the length, so "spread" can be judged against
    // the thirds a camera is supposed to cover rather than against raw metres.
    const region: LandmarkRegion = x < L / 3 ? 'west' : x > (2 * L) / 3 ? 'east' : 'centre';
    marks.push({ id, label, x, y, region });
  };

  /* Corners — the four most useful points on the pitch, and the four most
     often just outside the frame. */
  add('corner_nw', 'North-west corner', 0, 0);
  add('corner_ne', 'North-east corner', L, 0);
  add('corner_se', 'South-east corner', L, W);
  add('corner_sw', 'South-west corner', 0, W);

  /* Halfway line and centre circle. */
  add('halfway_north', 'Halfway line, north touchline', L / 2, 0);
  add('halfway_south', 'Halfway line, south touchline', L / 2, W);
  add('centre_mark', 'Centre mark', L / 2, midY);
  add('circle_north', 'Centre circle, north', L / 2, midY - CENTRE_CIRCLE_RADIUS);
  add('circle_south', 'Centre circle, south', L / 2, midY + CENTRE_CIRCLE_RADIUS);

  /* Both ends, mirrored. `end` is the goal line x; `into` walks onto the pitch. */
  const ends: Array<{ key: string; name: string; goalLineX: number; sign: 1 | -1 }> = [
    { key: 'west', name: 'West', goalLineX: 0, sign: 1 },
    { key: 'east', name: 'East', goalLineX: L, sign: -1 },
  ];

  for (const end of ends) {
    const gx = end.goalLineX;
    const into = (d: number) => gx + end.sign * d;

    add(`${end.key}_pen_gl_north`, `${end.name} penalty area, north on goal line`, gx, midY - PENALTY_AREA_HALF_WIDTH);
    add(`${end.key}_pen_gl_south`, `${end.name} penalty area, south on goal line`, gx, midY + PENALTY_AREA_HALF_WIDTH);
    add(`${end.key}_pen_north`, `${end.name} penalty area, north corner`, into(PENALTY_AREA_DEPTH), midY - PENALTY_AREA_HALF_WIDTH);
    add(`${end.key}_pen_south`, `${end.name} penalty area, south corner`, into(PENALTY_AREA_DEPTH), midY + PENALTY_AREA_HALF_WIDTH);

    add(`${end.key}_goal_gl_north`, `${end.name} goal area, north on goal line`, gx, midY - GOAL_AREA_HALF_WIDTH);
    add(`${end.key}_goal_gl_south`, `${end.name} goal area, south on goal line`, gx, midY + GOAL_AREA_HALF_WIDTH);
    add(`${end.key}_goal_north`, `${end.name} goal area, north corner`, into(GOAL_AREA_DEPTH), midY - GOAL_AREA_HALF_WIDTH);
    add(`${end.key}_goal_south`, `${end.name} goal area, south corner`, into(GOAL_AREA_DEPTH), midY + GOAL_AREA_HALF_WIDTH);

    add(`${end.key}_penalty_spot`, `${end.name} penalty spot`, into(PENALTY_SPOT_DISTANCE), midY);

    // Goalposts sit ON the goal line and are the highest-contrast features at
    // either end, so a detector finds them when the painted lines have worn.
    add(`${end.key}_post_north`, `${end.name} goalpost, north`, gx, midY - GOAL_HALF_WIDTH);
    add(`${end.key}_post_south`, `${end.name} goalpost, south`, gx, midY + GOAL_HALF_WIDTH);
  }

  return marks;
}

export function landmarkById(landmarks: Landmark[], id: string): Landmark | null {
  return landmarks.find((l) => l.id === id) ?? null;
}
