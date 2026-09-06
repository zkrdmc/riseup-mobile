/**
 * React Query hooks.
 *
 * Query keys are arrays whose first element is the resource, so a mutation
 * can invalidate a whole family (`['match', id]`) without knowing every
 * variant of it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from './provider';
import { paths } from './endpoints';
import type {
  Job,
  Match,
  MatchPlayersResponse,
  Me,
  PlayerMetrics,
  UploadMode,
  UploadUrlResponse,
} from './types';

export const keys = {
  me: ['me'] as const,
  matches: ['matches'] as const,
  match: (id: string) => ['match', id] as const,
  matchPlayers: (id: string) => ['match', id, 'players'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['job', id] as const,
  uploadMode: ['upload-mode'] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<Me>(paths.me),
    // The club and role behind this rarely change, and every screen needs it.
    staleTime: 10 * 60_000,
  });
}

export function useMatches() {
  const api = useApi();
  return useQuery({
    queryKey: keys.matches,
    queryFn: () => api.get<{ matches: Match[] }>(paths.matches, { query: { limit: 50 } }),
    select: (data) => data.matches,
  });
}

export function useMatch(matchId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.match(matchId),
    queryFn: () => api.get<Match>(paths.match(matchId)),
    enabled: matchId.length > 0,
  });
}

/**
 * Per-player metrics for a match.
 *
 * `perspective` defaults to `team` server-side, which flips spatial metrics so
 * every team appears to attack rightward. That is what a coach expects from a
 * heatmap; `raw` exists for debugging and is not used here.
 */
export function useMatchPlayers(matchId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.matchPlayers(matchId),
    queryFn: () => api.get<MatchPlayersResponse>(paths.matchPlayers(matchId)),
    enabled: matchId.length > 0,
    select: (data) => data.players,
  });
}

/** A job the pipeline is still working on. */
function isInFlight(job: Job): boolean {
  return job.state !== 'complete' && job.state !== 'failed';
}

/**
 * Upload jobs, including work still in flight.
 *
 * `GET /matches` lists finished work only — a matches row is written when
 * riseup-ml posts a result back, minutes after the upload. A home screen
 * rendering only that shows nothing to somebody who uploaded ten seconds ago.
 *
 * POLLING DECIDES ITSELF, from the response it just received. `refetchInterval`
 * takes a function over the query, so the screen does not have to hold the
 * "is anything running" flag in state and feed it back in — which is circular
 * (the answer comes from the query the flag configures) and, worked around
 * with a ref or an effect, costs an extra render per poll.
 *
 * Ten seconds while something is running, off once everything has settled. A
 * phone polling a finished job list on cellular spends a coach's data to learn
 * nothing.
 */
export function useJobs() {
  const api = useApi();
  return useQuery({
    queryKey: keys.jobs,
    queryFn: () => api.get<{ jobs: Job[] }>(paths.jobs, { query: { limit: 50 }, noCache: true }),
    select: (data) => data.jobs,
    refetchInterval: (query) =>
      query.state.data?.jobs.some(isInFlight) === true ? 10_000 : false,
  });
}

/** One job, polled faster — this is the screen somebody is watching. */
export function useJob(jobId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.job(jobId),
    queryFn: () => api.get<Job>(paths.job(jobId), { noCache: true }),
    enabled: jobId.length > 0,
    refetchInterval: (query) =>
      query.state.data !== undefined && isInFlight(query.state.data) ? 5_000 : false,
  });
}

/**
 * Which upload path this deployment supports.
 *
 * Told, not guessed — a client that picks wrong finds out as a 413 or a 501
 * halfway through the file. Cached hard: it is a property of the deployment,
 * not of the session.
 */
export function useUploadMode() {
  const api = useApi();
  return useQuery({
    queryKey: keys.uploadMode,
    queryFn: () => api.get<UploadMode>(paths.uploadMode),
    staleTime: 60 * 60_000,
  });
}

/** Mint a presigned PUT and return the job it belongs to. */
export function useCreateUploadUrl() {
  const api = useApi();
  return useMutation({
    mutationFn: (input: { filename: string; contentType?: string }) =>
      api.post<UploadUrlResponse>(paths.uploadUrl, {
        filename: input.filename,
        content_type: input.contentType ?? 'video/mp4',
      }),
  });
}

/** Tell the API the PUT landed, which starts frame extraction. */
export function useConfirmUpload() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.post<{ message: string }>(paths.uploadConfirm(jobId)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.jobs });
    },
  });
}

/**
 * A track's metric rows across every match the club has processed.
 *
 * READ THE CAVEAT BEFORE USING THIS FOR A COMPARISON. `player_id` here is the
 * ByteTrack `track_id`, which is assigned per match and numbered 1–22 within
 * it. Track 7 in Saturday's match and track 7 in last week's are not the same
 * person, and nothing in this response says so — the backend's own docstring
 * flags the mapping to a persistent player id as future work.
 *
 * So this is safe for "every row that ever carried this track number" and
 * unsafe for "this player's season". `src/lib/season.ts` is where that
 * distinction is enforced; do not compare against these rows without it.
 */
export function usePlayerHistory(trackId: number, options: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ['player-history', trackId] as const,
    queryFn: () =>
      api.get<{ player_id: number; match_count: number; history: PlayerMetrics[] }>(
        paths.playerHistory(trackId),
      ),
    enabled: (options.enabled ?? true) && Number.isFinite(trackId),
    staleTime: 5 * 60_000,
  });
}
