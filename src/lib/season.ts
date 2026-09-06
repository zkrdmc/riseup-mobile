/**
 * "Against their own season median" — and why it is usually not available.
 *
 * PRD §7 is specific and it is right: a player quick view compares a number
 * against that player's own season median, NOT against the squad. Comparing a
 * centre-back's distance to a box-to-box midfielder's on a phone screen, with
 * no context and no way to drill in, invites exactly the wrong conversation.
 *
 * THE PROBLEM IS IDENTITY, NOT MATHS
 * ----------------------------------
 * The only cross-match endpoint is `GET /players/{track_id}/history`, and
 * `track_id` is assigned by ByteTrack per match, numbered 1–22 within it.
 * Track 7 on Saturday and track 7 last week are two different people roughly
 * twenty-one times out of twenty-two. The backend's own docstring names the
 * mapping to a persistent player id as future work.
 *
 * A median computed over those rows would be a real number, rendered
 * confidently, describing nobody. That is worse than no comparison at all: a
 * coach cannot tell it is wrong, and it is precisely the kind of number that
 * gets repeated in a team meeting.
 *
 * SO THE COMPARISON IS GATED ON THE ONE STABLE IDENTITY THERE IS: the name a
 * human assigned through the lineup screen. Rows whose `name` matches the
 * current player's name are the same person by assertion, and rows without a
 * name are excluded. That makes the comparison appear only for squads who have
 * done their lineup assignments — which is the honest condition, and also a
 * concrete reason for a club to do them.
 *
 * When a persistent player id lands, this module keeps its shape and the
 * filter changes from name-equality to id-equality.
 */

import type { PlayerMetrics } from '../api/types';

export interface SeasonComparison {
  /** How many matches the median is over. Shown, because 2 is not a season. */
  sampleSize: number;
  median: number;
  /** This match's value. */
  current: number;
  /** Signed percentage difference from the median. Negative is below. */
  deltaPct: number;
}

/** Why there is no comparison, in words a coach can act on. */
export type ComparisonBlocker =
  | 'unnamed'
  | 'insufficient-history'
  | 'no-value';

export type SeasonResult =
  | { available: true; comparison: SeasonComparison }
  | { available: false; reason: ComparisonBlocker };

/**
 * Fewer than three prior matches is not a season median, it is an average of
 * two numbers. Rendering it as "12% below their season median" would overstate
 * what the data supports.
 */
const MIN_SAMPLE = 3;

export function compareToSeason(
  current: PlayerMetrics,
  history: PlayerMetrics[],
  metric: (p: PlayerMetrics) => number | null,
): SeasonResult {
  const currentValue = metric(current);
  if (currentValue === null) {
    return { available: false, reason: 'no-value' };
  }

  // The gate. Without a human-assigned name there is no identity to compare
  // across, and the track number is not one.
  if (current.name === null || current.name.length === 0) {
    return { available: false, reason: 'unnamed' };
  }

  const values: number[] = [];
  for (const row of history) {
    if (row.match_id === current.match_id) {
      continue; // Do not compare a value against a median containing itself.
    }
    if (row.name !== current.name) {
      continue; // A different person who happened to be given this track id.
    }
    const value = metric(row);
    if (value !== null) {
      values.push(value);
    }
  }

  if (values.length < MIN_SAMPLE) {
    return { available: false, reason: 'insufficient-history' };
  }

  const med = median(values);
  if (med === 0) {
    // A zero median makes the percentage undefined. Rare, but a division by
    // zero rendered as "Infinity% above" is a memorable bug to ship.
    return { available: false, reason: 'no-value' };
  }

  return {
    available: true,
    comparison: {
      sampleSize: values.length,
      median: med,
      current: currentValue,
      deltaPct: ((currentValue - med) / med) * 100,
    },
  };
}

/** Median, not mean: one match where a player was subbed at 20' should not drag it. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] as number;
  }
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** The sentence shown in place of a comparison. Always says what would fix it. */
export function blockerText(reason: ComparisonBlocker): string {
  switch (reason) {
    case 'unnamed':
      return 'Assign this track to a player to compare against their own season.';
    case 'insufficient-history':
      return `Needs ${MIN_SAMPLE} earlier matches for this player before a season median means anything.`;
    case 'no-value':
      return 'Not measured in this match.';
  }
}
