/**
 * Deriving the match summary (§7) from what the API actually returns.
 *
 * PRD §8.2 asks for `GET /matches/{id}/summary` — one compact payload sized
 * for a phone. It does not exist yet, so this module composes the same thing
 * from `/matches/{id}` and `/matches/{id}/players`. That is two round trips
 * and several hundred kilobytes where the summary screen renders a few dozen
 * numbers, which is exactly the cost §8.2 exists to remove. When the endpoint
 * lands, this file is where it plugs in and the screen does not change.
 *
 * WHAT IS AGGREGATED HERE AND WHAT IS NOT
 * ---------------------------------------
 * Sums and counts are computed here: total distance, total sprints, the top
 * five. These are additions over rows already fetched and cannot disagree with
 * the server.
 *
 * RATIOS ARE NOT. `possession_pct`, `distance_per90` and
 * `pass_completion_pct` are recomputed server-side on every read from raw
 * counts, deliberately (storage/db.py). Recomputing them here would be a
 * second implementation of the same formula, and the failure mode is the phone
 * and the dashboard showing a coach two different possession figures for one
 * match. Team possession share below is a sum of server-computed percentages,
 * not a recomputation from frames.
 */

import type { Match, PlayerMetrics } from '../api/types';

export interface TeamTotals {
  label: string;
  playerCount: number;
  /** Metres. Sum over outfield players; referees excluded. */
  distanceM: number;
  sprints: number;
  /** 0–100, or null when the pipeline produced no possession data. */
  possessionPct: number | null;
}

export interface MatchSummary {
  title: string;
  /** Upload time. NOT kick-off — the schema has no kick-off column. */
  uploadedAt: string;
  status: Match['status'];
  durationSec: number | null;
  trackedPlayers: number;
  teams: TeamTotals[];
  topByDistance: PlayerMetrics[];
  topBySprints: PlayerMetrics[];
  quality: QualityNote[];
}

export interface QualityNote {
  level: 'green' | 'amber' | 'red';
  text: string;
}

const TOP_N = 5;

/**
 * Referees are excluded from every team total.
 *
 * They are tracked, they cover more ground than most midfielders, and folding
 * them into a team's distance inflates it by roughly one player's worth in a
 * way nobody would notice and everybody would eventually act on.
 */
function isCounted(p: PlayerMetrics): boolean {
  return !p.is_referee;
}

export function buildSummary(match: Match, players: PlayerMetrics[]): MatchSummary {
  const counted = players.filter(isCounted);

  const byTeam = new Map<string, PlayerMetrics[]>();
  for (const p of counted) {
    // A track the pipeline could not assign to a side. Grouped under its own
    // heading rather than silently added to one team or dropped.
    const key = p.team ?? 'Unassigned';
    const bucket = byTeam.get(key);
    if (bucket === undefined) {
      byTeam.set(key, [p]);
    } else {
      bucket.push(p);
    }
  }

  const teams: TeamTotals[] = [];
  for (const [label, squad] of byTeam) {
    let distanceM = 0;
    let sprints = 0;
    let possession = 0;
    let possessionKnown = false;

    for (const p of squad) {
      distanceM += p.distance_m ?? 0;
      sprints += p.sprint_count ?? 0;
      if (p.possession_pct !== null) {
        possession += p.possession_pct;
        possessionKnown = true;
      }
    }

    teams.push({
      label,
      playerCount: squad.length,
      distanceM,
      sprints,
      possessionPct: possessionKnown ? possession : null,
    });
  }

  teams.sort((a, b) => a.label.localeCompare(b.label));

  return {
    title: match.label !== null && match.label.length > 0 ? match.label : stripExt(match.filename),
    uploadedAt: match.created_at,
    status: match.status,
    durationSec: match.duration_sec,
    trackedPlayers: counted.length,
    teams,
    topByDistance: topN(counted, (p) => p.distance_m),
    topBySprints: topN(counted, (p) => p.sprint_count),
    quality: assessQuality(match, counted),
  };
}

function topN(players: PlayerMetrics[], by: (p: PlayerMetrics) => number | null): PlayerMetrics[] {
  return players
    .filter((p) => by(p) !== null)
    .sort((a, b) => (by(b) ?? 0) - (by(a) ?? 0))
    .slice(0, TOP_N);
}

/**
 * The data-quality banner (§7).
 *
 * WHAT IS MISSING. §7 asks this banner to name "intervals where only one
 * camera contributed (PRD §3.0.4)" and "sync residual if abnormal". Neither
 * crosses the API today — they are properties of a dual-camera fusion that
 * v0.1 does not produce and that no field on `matches` records. When the
 * capture sessions of §8.2 land, those become the first two checks here.
 *
 * WHAT CAN BE SAID HONESTLY TODAY comes from the track count and the run
 * itself. A match that tracked eleven players did not see a full pitch, and a
 * coach comparing that distance total against last week's needs to know before
 * they draw a conclusion — not after.
 */
function assessQuality(match: Match, counted: PlayerMetrics[]): QualityNote[] {
  const notes: QualityNote[] = [];

  if (match.status === 'processing') {
    notes.push({
      level: 'amber',
      text: 'Still processing. These numbers will change.',
    });
    return notes;
  }

  // Twenty-two on the pitch plus substitutes. Materially fewer means tracks
  // were lost or the framing missed part of the pitch.
  if (counted.length > 0 && counted.length < 18) {
    notes.push({
      level: 'amber',
      text: `Only ${counted.length} players were tracked. Totals will read low against a full match.`,
    });
  }

  const unassigned = counted.filter((p) => p.team === null).length;
  if (unassigned > 0) {
    notes.push({
      level: 'amber',
      text: `${unassigned} ${unassigned === 1 ? 'track was' : 'tracks were'} not assigned to a team, so team totals are incomplete.`,
    });
  }

  const named = counted.filter((p) => p.name !== null).length;
  if (counted.length > 0 && named === 0) {
    notes.push({
      level: 'amber',
      text: 'No players have been named yet. Assign the lineup to see names instead of track numbers.',
    });
  }

  if (notes.length === 0) {
    notes.push({ level: 'green', text: 'Full coverage. No quality issues found.' });
  }

  return notes;
}

/** What to call a player before anybody has named them. */
export function playerName(p: PlayerMetrics): string {
  if (p.name !== null && p.name.length > 0) {
    return p.name;
  }
  if (p.jersey_number !== null) {
    return `#${p.jersey_number}`;
  }
  // A track id is not a name, and the screen should not pretend it is. It is
  // shown as what it is: the pipeline's handle for somebody nobody has
  // identified yet.
  return `Track ${p.track_id}`;
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '');
}
