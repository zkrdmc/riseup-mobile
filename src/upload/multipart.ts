/**
 * Multipart upload of one file to object storage, resumable part by part.
 *
 * WHY. A single presigned PUT is one request: a match interrupted at 90%
 * restarted from zero, and anything over ~5 GiB was refused by R2 at the very
 * end of the transfer (25 Oct 2026). With parts, a dropped connection costs at
 * most one part, and a kill or a reboot resumes from the ledger: every part
 * that landed, with its ETag, persisted on the device.
 *
 * HOW A PART IS SENT. The native background session uploads FILES, not byte
 * ranges, so each part is copied to a temporary file first (in 8 MiB reads,
 * so the JS heap never holds a whole part), PUT with `sessionType:
 * 'background'`, and deleted. The copy costs a part's worth of cache space per
 * part in flight.
 *
 * THE SERVER IS THE TRUTH ON RESUME. After a kill the ledger may be behind
 * (a part landed while the app was dead): `uploads/unfinished` lists what the
 * store holds and that wins.
 *
 * Pure helpers are exported for the tests in `__tests__/multipart.test.ts`.
 */

import { File, FileMode, Paths, UploadTask, UploadType } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

export {
  COPY_CHUNK_BYTES,
  HEARTBEAT_MS,
  PART_ATTEMPTS,
  PART_CONCURRENCY,
  backoffMs,
  etagOf,
  ledgerBytes,
  missingParts,
  partRange,
} from './multipartPlan';
export type { MultipartState, PartLedger } from './multipartPlan';
import { COPY_CHUNK_BYTES, etagOf, partRange } from './multipartPlan';

/**
 * The same file gives the same fingerprint, so a resume finds its upload.
 * [A-Za-z0-9_-], 8..128 characters (the server's pattern).
 */
export async function fingerprintOf(input: {
  filename: string;
  totalBytes: number;
  modifiedMs: number | null;
}): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${input.filename}|${input.totalBytes}|${input.modifiedMs ?? ''}`,
  );
  return `${digest.slice(0, 24)}-${input.totalBytes}`;
}

/** Copy one part of `source` into a fresh temporary file. */
export function copyPart(source: File, n: number, partBytes: number, totalBytes: number): File {
  const { start, length } = partRange(n, partBytes, totalBytes);
  const out = new File(Paths.cache, `riseup-part-${Crypto.randomUUID()}.bin`);
  out.create();
  // Read-only on the source: a picker's content:// URI may refuse anything
  // more, and nothing here should ever write to the club's footage.
  const reader = source.open(FileMode.ReadOnly);
  const writer = out.open(FileMode.WriteOnly);
  try {
    reader.offset = start;
    let left = length;
    while (left > 0) {
      const bytes = reader.readBytes(Math.min(COPY_CHUNK_BYTES, left));
      if (bytes.length === 0) {
        throw new Error(`the file ended ${left} bytes early in part ${n}`);
      }
      writer.writeBytes(bytes);
      left -= bytes.length;
    }
  } finally {
    reader.close();
    writer.close();
  }
  return out;
}

export class PartRejected extends Error {
  constructor(
    readonly partNumber: number,
    readonly status: number,
  ) {
    super(`part ${partNumber} refused by storage (${status})`);
  }
}

/** PUT one part from its temporary file. Returns the ETag. */
export async function putPart(
  part: File,
  url: string,
  n: number,
  onBytes: (sent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const task = new UploadTask(part, url, {
    httpMethod: 'PUT',
    // BINARY_CONTENT: the URL signs the raw body; a multipart envelope would
    // be a signature mismatch R2 reports as an opaque 403.
    uploadType: UploadType.BINARY_CONTENT,
    sessionType: 'background',
    onProgress: ({ bytesSent }) => onBytes(bytesSent),
    signal,
  });
  const result = await task.uploadAsync();
  if (result.status < 200 || result.status >= 300) {
    throw new PartRejected(n, result.status);
  }
  const etag = etagOf(result.headers);
  if (etag === null) {
    // No ETag means CompleteMultipartUpload cannot name this part. Treat it
    // as not sent: re-sending is safe, completing without it is not.
    throw new PartRejected(n, result.status);
  }
  return etag;
}
