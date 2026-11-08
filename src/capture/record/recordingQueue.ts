/**
 * The decisions of a recording's send queue, with no native imports, so they
 * run under node in `npm run smoke`.
 */

import type { ChunkManifest } from '../upload/chunkManifest';

export interface QueuedChunk {
  manifest: ChunkManifest;
  /** file:// URI of the segment on this phone. */
  uri: string;
  /**
   * `pending`: not yet registered, or its upload must be redone.
   * `handed`: registered and given to the OS uploader (it runs in the background).
   * `confirmed`: the server verified it (`mayDelete`); the file is gone.
   */
  status: 'pending' | 'handed' | 'confirmed';
  attempts: number;
  /** Epoch ms before which this chunk is not retried. */
  nextAttemptAt: number;
  error: string | null;
  /** Epoch ms the OS uploader got it, for the ladder's send-speed reading. */
  handedAt?: number;
}

/**
 * The lowest-sequence `pending` chunk that is due; 'wait' when some are
 * pending but none is due yet; null when nothing is pending.
 *
 * Oldest first: the pipeline reads the match in order, so the chunk it needs
 * next is the earliest one it does not have.
 */
export function nextChunkToSend(chunks: QueuedChunk[], now: number): QueuedChunk | 'wait' | null {
  const open = chunks
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.manifest.sequence - b.manifest.sequence);
  if (open.length === 0) {
    return null;
  }
  return open.find((c) => c.nextAttemptAt <= now) ?? 'wait';
}

/** Before retry `attempt` (1-based): 2, 4, 8, 16, 32 s, then 60 s for good. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(1, attempt));
}

/* ── The bitrate ladder (Zak, 9 Nov 2026) ─────────────────────────────────
   Start high and step down only when the upload falls behind; step back up
   when it has been keeping up. HEVC first; H.264 (no HEVC encoder) is the same
   ladder x1.6, which buys roughly the same picture. The floor is provisional
   until S's detector test on real pitch footage settles it. */

export const HEVC_LADDER = [12_000_000, 10_000_000, 8_000_000, 6_000_000, 4_000_000];
export const H264_LADDER = HEVC_LADDER.map((b) => Math.round((b * 1.6) / 100_000) * 100_000);

/** Segments in a row sent faster than they were recorded before stepping up. */
export const FAST_TO_STEP_UP = 3;

export function ladderFor(codec: 'hevc' | 'h264'): number[] {
  return codec === 'hevc' ? HEVC_LADDER : H264_LADDER;
}

/**
 * The next rung. Down one when more than a segment's worth of recorded video
 * is still unsent; up one after FAST_TO_STEP_UP segments in a row went faster
 * than real time and nothing is waiting. Otherwise unchanged.
 */
export function nextRung(input: {
  rung: number;
  rungs: number;
  backlogSeconds: number;
  segmentSeconds: number;
  fastInARow: number;
}): number {
  const { rung, rungs, backlogSeconds, segmentSeconds, fastInARow } = input;
  if (backlogSeconds > segmentSeconds) {
    return Math.min(rung + 1, rungs - 1);
  }
  if (fastInARow >= FAST_TO_STEP_UP && backlogSeconds === 0) {
    return Math.max(rung - 1, 0);
  }
  return rung;
}

/** Seconds of recorded video not yet confirmed by the server. */
export function backlogSeconds(chunks: QueuedChunk[]): number {
  return chunks
    .filter((c) => c.status !== 'confirmed')
    .reduce((s, c) => s + (c.manifest.endPtsNs - c.manifest.startPtsNs) / 1e9, 0);
}

/* ── Declared gaps (a phone pulled from its casing) ──────────────────────── */

/** Anything up to this is a join, not a gap (the chunk contract's 2 ms). */
export const JOIN_TOLERANCE_NS = 2_000_000;

/**
 * The gap to declare before a chunk: the session-clock time between the end of
 * the previous chunk and the start of this one, in ms, or 0 for a join. The
 * server excuses exactly this much from coverage (migration 041).
 */
export function gapBeforeMs(previousEndNs: number | null, startNs: number): number {
  if (previousEndNs === null) {
    return 0;
  }
  const delta = startNs - previousEndNs;
  return delta > JOIN_TOLERANCE_NS ? Math.ceil(delta / 1e6) : 0;
}
