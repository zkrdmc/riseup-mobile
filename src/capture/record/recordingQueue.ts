/**
 * Which recorded chunk to send next. No native imports, so it runs under
 * node in `npm run smoke`.
 */

import type { ChunkManifest } from '../upload/chunkManifest';

export interface QueuedChunk {
  manifest: ChunkManifest;
  /** file:// URI of the segment on this phone. */
  uri: string;
  /** `confirmed` only on the server's `mayDelete`; the file is gone then. */
  status: 'pending' | 'confirmed';
  attempts: number;
  /** Epoch ms before which this chunk is not retried. */
  nextAttemptAt: number;
  error: string | null;
}

/**
 * The lowest-sequence unconfirmed chunk that is due; 'wait' when some are
 * unconfirmed but none is due yet; null when every chunk is confirmed.
 *
 * Oldest first: the pipeline reads the match in order, so the chunk it needs
 * next is the earliest one it does not have.
 */
export function nextChunkToSend(chunks: QueuedChunk[], now: number): QueuedChunk | 'wait' | null {
  const open = chunks
    .filter((c) => c.status !== 'confirmed')
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
