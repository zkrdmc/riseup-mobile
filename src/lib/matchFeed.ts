/**
 * The match list is two lists.
 *
 * `GET /matches` returns finished work — a row is written when riseup-ml posts
 * a result back, minutes after the upload. `GET /videos` returns jobs,
 * including everything still in flight. A screen that renders only the first
 * shows an empty list to somebody who uploaded ten seconds ago; a screen that
 * renders both without joining them shows the same match twice, once as a
 * finished result and once as a job that produced it.
 *
 * The join key is `job.match_id`, which the pipeline sets once it mints a
 * match. This module does the merge in one place so both the list screen and
 * any later home screen agree about what "my matches" means.
 */

import type { Job, Match } from '../api/types';

/** What the list renders. One shape for both sources. */
export interface FeedItem {
  /** Stable across the job → match transition, so the row does not remount. */
  key: string;
  title: string;
  /** ISO. Sorting key, and what the row's timestamp shows. */
  at: string;
  state: FeedState;
  /** Present once there is something to open. Null while still processing. */
  matchId: string | null;
  jobId: string | null;
  /** 0–100 while extracting, null otherwise. */
  progress: number | null;
  /** The human sentence for a failure. Empty string is not an error. */
  error: string | null;
  playerCount: number | null;
  durationSec: number | null;
}

export type FeedState = 'processing' | 'ready' | 'failed';

function jobState(job: Job): FeedState {
  if (job.state === 'failed') {
    return 'failed';
  }
  if (job.state === 'complete') {
    return 'ready';
  }
  return 'processing';
}

/**
 * Merge finished matches with in-flight jobs, newest first.
 *
 * A job that has produced a match is dropped: the match row carries more, and
 * it is the thing the coach wants to open. A match with no corresponding job
 * is kept — jobs are pruned server-side and old matches outlive them.
 */
export function buildFeed(matches: Match[], jobs: Job[]): FeedItem[] {
  // Built once rather than scanning `matches` per job: both lists are capped
  // at 50 today, but a linear scan inside a loop over the other list is the
  // kind of thing that stops being free the moment pagination lands.
  const renderedMatchIds = new Set<string>();
  for (const match of matches) {
    renderedMatchIds.add(match.id);
  }

  const items: FeedItem[] = [];

  for (const match of matches) {
    items.push({
      // Keyed by match id even when a job produced it, so the row keeps its
      // identity — and its scroll position — across the transition.
      key: `match:${match.id}`,
      title: titleOf(match),
      at: match.created_at,
      state: match.status === 'failed' ? 'failed' : match.status === 'complete' ? 'ready' : 'processing',
      matchId: match.id,
      jobId: match.job_id,
      progress: null,
      error: null,
      playerCount: match.player_count,
      durationSec: match.duration_sec,
    });
  }

  for (const job of jobs) {
    const producedMatchId =
      job.match_id !== null && job.match_id !== undefined && job.match_id.length > 0
        ? job.match_id
        : null;

    // Already on screen as its match row, which carries more. A job whose
    // match is NOT in this page is still rendered — the two lists are fetched
    // with the same limit but are not guaranteed to align, and dropping the
    // job would leave a coach with neither row.
    if (producedMatchId !== null && renderedMatchIds.has(producedMatchId)) {
      continue;
    }

    items.push({
      key: `job:${job.job_id}`,
      title: job.filename.replace(/\.[^./\\]+$/, ''),
      at: job.created_at,
      state: jobState(job),
      matchId: producedMatchId,
      jobId: job.job_id,
      progress: job.state === 'complete' ? null : job.progress_pct,
      // The API sends "" for no error, not null. Rendering that verbatim gives
      // a row an empty error line that pushes its height around.
      error: job.error.length > 0 ? job.error : null,
      playerCount: null,
      durationSec: null,
    });
  }

  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function titleOf(match: Match): string {
  if (match.label !== null && match.label.length > 0) {
    return match.label;
  }
  return match.filename.replace(/\.[^./\\]+$/, '');
}
