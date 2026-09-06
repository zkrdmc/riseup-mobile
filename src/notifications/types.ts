/**
 * The notification vocabulary (§6).
 *
 * Every event the backend may send, its priority, and — the part that matters
 * — where tapping it goes. §6 is unambiguous: "never notify without a
 * resolvable action". So a category with no route is not a category, and this
 * file is where that is enforced rather than a convention someone remembers.
 *
 * The `category` string is the contract with the backend. It rides in the
 * notification payload's `data.category`, and the app routes on it. A payload
 * with an unknown category is not dropped — it lands in the inbox with its own
 * text and no deep link, because a coach seeing something they cannot act on
 * is still better than the app silently discarding a message somebody sent.
 */

export type NotificationCategory =
  | 'analysis_complete'
  | 'analysis_failed'
  | 'lineup_needed'
  | 'upload_complete'
  | 'upload_stalled'
  | 'quota_warning';

export interface CategorySpec {
  category: NotificationCategory;
  /** Shown in the preferences list. */
  title: string;
  /** One line, in the preferences list, saying what this means. */
  description: string;
  /**
   * High-priority categories interrupt. §6 marks three of them so, and the
   * distinction is real: a failed analysis needs acting on before the next
   * match, a quota warning does not.
   */
  priority: 'high' | 'normal';
  /**
   * Whether the user may turn it off.
   *
   * `lineup_needed` blocks results — the analysis is done and unreadable until
   * somebody assigns the lineup. Letting that one be silenced produces a match
   * that never appears to finish, and a support ticket that takes an hour to
   * trace back to a toggle.
   */
  canDisable: boolean;
}

export const CATEGORIES: readonly CategorySpec[] = [
  {
    category: 'analysis_complete',
    title: 'Analysis complete',
    description: 'A match has finished processing and the summary is ready.',
    priority: 'high',
    canDisable: true,
  },
  {
    category: 'analysis_failed',
    title: 'Analysis failed',
    description: 'A match could not be processed, and what to do about it.',
    priority: 'high',
    canDisable: true,
  },
  {
    category: 'lineup_needed',
    title: 'Lineup needed',
    description: 'Results are waiting on somebody naming the players.',
    priority: 'high',
    canDisable: false,
  },
  {
    category: 'upload_complete',
    title: 'Upload complete',
    description: 'Footage is safely on the server and verified.',
    priority: 'normal',
    canDisable: true,
  },
  {
    category: 'upload_stalled',
    title: 'Upload stalled',
    description: 'An upload has not progressed for a day.',
    priority: 'normal',
    canDisable: true,
  },
  {
    category: 'quota_warning',
    title: 'Quota warning',
    description: 'Your club is close to its processing limit.',
    priority: 'normal',
    canDisable: true,
  },
];

/**
 * Where a notification goes when tapped.
 *
 * Returns null only for a category this build does not know, which is the one
 * case where there is nothing honest to route to.
 */
export function routeFor(
  category: string,
  data: Record<string, unknown>,
): { pathname: string; params?: Record<string, string> } | null {
  const matchId = typeof data.match_id === 'string' ? data.match_id : null;
  const jobId = typeof data.job_id === 'string' ? data.job_id : null;

  switch (category as NotificationCategory) {
    case 'analysis_complete':
      return matchId === null ? { pathname: '/' } : { pathname: '/match/[id]', params: { id: matchId } };

    case 'analysis_failed':
      // §6: this must name a cause the operator can act on. The reason travels
      // in the payload and is stored on the inbox item; the route is the match
      // if there is one, and the list if the job never produced one.
      return matchId === null ? { pathname: '/' } : { pathname: '/match/[id]', params: { id: matchId } };

    case 'lineup_needed':
      // The lineup screen is keyed by JOB id, not match id — see
      // `paths.lineup`. v0.4 builds it; until then this lands on the match.
      return matchId === null ? { pathname: '/' } : { pathname: '/match/[id]', params: { id: matchId } };

    case 'upload_complete':
    case 'upload_stalled':
      return { pathname: '/uploads' };

    case 'quota_warning':
      return { pathname: '/settings' };

    default:
      return jobId === null ? null : { pathname: '/uploads' };
  }
}

/** One message, as it appears in the in-app inbox. */
export interface InboxItem {
  id: string;
  category: string;
  title: string;
  body: string;
  /** ISO. When the server sent it, falling back to when we received it. */
  at: string;
  read: boolean;
  /** The raw payload, kept so a route can be rebuilt after an app update. */
  data: Record<string, unknown>;
}
