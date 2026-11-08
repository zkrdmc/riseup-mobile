/**
 * The arithmetic of a multipart upload, with no native imports, so it runs
 * under node in `npm run smoke` (src/upload/__tests__/multipartPlan.test.js).
 * The transfer itself is `multipart.ts`.
 */

/** Every part that landed: part number -> ETag (quotes kept, as R2 sent it). */
export type PartLedger = Record<number, string>;

export interface MultipartState {
  uploadId: string;
  partBytes: number;
  partCount: number;
  /** Persisted after every part. */
  parts: PartLedger;
  /** Sent to `upload-url` and `uploads/unfinished`. */
  fingerprint: string;
}

/** Bytes per read when copying a part to its temporary file. */
export const COPY_CHUNK_BYTES = 8 * 1024 * 1024;
/** Parts in flight at once. Two keeps a phone's uplink full without
 * doubling the cache space a third would cost. */
export const PART_CONCURRENCY = 2;
/** Attempts per part before the upload pauses (and can be resumed). */
export const PART_ATTEMPTS = 6;
/** The heartbeat (`upload-progress`): the server's hold is 2 h, so one a
 * minute is generous and cheap. */
export const HEARTBEAT_MS = 60_000;

/** The byte range of part `n` (1-based) of a file. */
export function partRange(n: number, partBytes: number, totalBytes: number): {
  start: number;
  length: number;
} {
  const start = (n - 1) * partBytes;
  return { start, length: Math.max(0, Math.min(partBytes, totalBytes - start)) };
}

/** Part numbers not in the ledger, ascending. */
export function missingParts(partCount: number, ledger: PartLedger): number[] {
  const out: number[] = [];
  for (let n = 1; n <= partCount; n += 1) {
    if (!ledger[n]) {
      out.push(n);
    }
  }
  return out;
}

/** Bytes the ledger accounts for. */
export function ledgerBytes(state: MultipartState, totalBytes: number): number {
  let sum = 0;
  for (const key of Object.keys(state.parts)) {
    sum += partRange(Number(key), state.partBytes, totalBytes).length;
  }
  return sum;
}

/** The ETag of a PUT response, whatever case the platform gave the header. */
export function etagOf(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'etag' && value) {
      return value;
    }
  }
  return null;
}

/** Wait before attempt `attempt` (1-based): 1, 2, 4, 8, 16 s, capped at 30. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}
