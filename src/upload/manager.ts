/**
 * The upload queue.
 *
 * §5 asks for uploads that are "resumable and background", surviving process
 * death, network loss and the app being closed. This module delivers as much
 * of that as the current backend allows, and is explicit about the part it
 * cannot.
 *
 * WHAT IS TRUE HERE
 * -----------------
 *   - The queue is persisted. A queued or interrupted upload is still queued
 *     after a force-quit, a reboot, or an app update, and is picked up on the
 *     next launch.
 *   - The transfer runs on a native background session (iOS `URLSession`
 *     background, Android's foreground service), so it continues while the app
 *     is suspended.
 *   - One upload at a time. Not a throttle — `videos.py::_refuse_if_busy`
 *     rejects a second concurrent job per club with a 409, so parallel
 *     uploads would produce failures that look like network errors.
 *
 *   - A MATCH RESUMES WHERE IT STOPPED. Anything over one part (64 MiB) goes
 *     up in parts (`multipart.ts`); every part that lands is in the entry's
 *     ledger, persisted. A dropped connection costs one part; a kill, a
 *     reboot or a tap on retry carries on from the ledger, checked against
 *     what the store actually holds (`uploads/unfinished`). There is no
 *     5 GiB ceiling. The server keeps a paused upload's parts for 23 h.
 *   - A heartbeat (`upload-progress`) every minute while bytes move keeps the
 *     GPU pod booked and the upload open on the server.
 *
 * WHAT IS STILL NOT TRUE
 * ----------------------
 * A JS task is not restored after app termination, so a part the OS finishes
 * in the background while the app is dead is not seen here. On the next
 * launch the store is asked which parts it holds, so nothing is confirmed
 * that did not land and nothing that did land is sent twice. A file under one
 * part still goes as a single PUT and restarts on a kill, which costs at most
 * 64 MiB.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, UploadTask, UploadType } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { paths } from '../api/endpoints';
import type {
  MultipartUploadUrlResponse,
  PartUrl,
  SingleUploadUrlResponse,
  UnfinishedUpload,
  UploadPartsResponse,
  UploadUrlResponse,
} from '../api/types';
import {
  HEARTBEAT_MS,
  PART_ATTEMPTS,
  PART_CONCURRENCY,
  PartRejected,
  backoffMs,
  copyPart,
  fingerprintOf,
  ledgerBytes,
  missingParts,
  putPart,
  type MultipartState,
} from './multipart';

export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'confirming'
  /** Bytes are on the server and extraction has started. */
  | 'uploaded'
  | 'failed'
  | 'cancelled';

export interface UploadEntry {
  /** Ours, not the server's. Survives before a job_id exists. */
  id: string;
  /** Local file URI. May be invalid after an OS cache eviction — checked on resume. */
  uri: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  uploadedBytes: number;
  status: UploadStatus;
  /** Set once `POST /videos/upload-url` has minted one. */
  jobId: string | null;
  /**
   * Reused across every retry of this entry, so a retried mint cannot create
   * a second job once the backend honours the header.
   */
  idempotencyKey: string;
  /** Human sentence, already mapped through ApiError. */
  error: string | null;
  createdAt: string;
  /** Wall-clock ms of transfer so far — the basis of the time estimate. */
  elapsedMs: number;
  /**
   * Does this footage start at or before kick-off? ASKED, NOT INFERRED.
   *
   * A file's creation time is the only automatic clue, and it is worthless on
   * a camcorder whose clock was never set, which is most of them. The operator
   * was standing there and knows.
   *
   * It is a WARNING, NOT A REFUSAL. Footage that begins after play started is
   * still analysed — the flag travels with the job so nothing downstream
   * reports a first-fifteen figure for minutes that were never filmed. Missing
   * is not zero.
   *
   * `false` on entries queued before this field existed, which is the safe
   * reading: it means "not asserted to cover the opening", not "asserted not
   * to".
   */
  coversOpening: boolean;
  /**
   * May RiseUp keep this footage and learn from it?
   *
   * THREE STATES, and `undefined` is load-bearing: it means nobody was asked,
   * which is NOT the same as a refusal. A refusal is never re-asked, so
   * recording one the club never made would permanently deny them the choice.
   * The field is omitted from the request entirely when it is undefined.
   *
   * SEPARATE FROM THE UPLOAD AND MUST STAY SEPARATE. Consent that is a
   * condition of a service which does not need it is not freely given (GDPR
   * Art. 7(4)) — so nothing on this path may ever read this value to decide
   * whether to transfer, retry, or confirm.
   */
  trainingConsent: boolean | undefined;
  /**
   * Set once the server chose parts. Persisted with every landed part, so a
   * kill or a retry carries on instead of starting over.
   */
  multipart?: MultipartState;
  /** The file's modification time, part of its fingerprint. */
  modifiedMs?: number | null;
}

type Listener = () => void;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const STORAGE_KEY = 'riseup.uploadQueue.v1';

class UploadManager {
  private entries: UploadEntry[] = [];
  private listeners = new Set<Listener>();
  private api: ApiClient | null = null;
  private activeTask: UploadTask | null = null;
  private draining = false;
  private hydrated = false;

  /* ── Store interface (useSyncExternalStore) ───────────────────────────── */

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UploadEntry[] => this.entries;

  private emit(): void {
    // A new array identity every time, because useSyncExternalStore compares
    // by reference and mutating in place would render nothing.
    this.entries = [...this.entries];
    for (const listener of this.listeners) {
      listener();
    }
    void this.persist();
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  /**
   * Attach the API client and restore the queue.
   *
   * Called once from the upload screen. The client is not injected at
   * construction because it depends on Clerk's session, which does not exist
   * when this module is first imported.
   */
  async attach(api: ApiClient): Promise<void> {
    this.api = api;
    if (!this.hydrated) {
      await this.hydrate();
      this.hydrated = true;
    }
    void this.drain();
  }

  private async hydrate(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw === null) {
        return;
      }
      const stored = JSON.parse(raw) as UploadEntry[];
      // Anything caught mid-transfer by a kill is re-queued, never assumed
      // done. A multipart entry keeps its ledger and resumes from it; a
      // single PUT starts over. See the note at the top of this file.
      this.entries = stored.map((entry) =>
        entry.status === 'uploading' || entry.status === 'confirming'
          ? {
              ...entry,
              status: 'queued',
              uploadedBytes: entry.multipart ? entry.uploadedBytes : 0,
            }
          : entry,
      );
    } catch {
      // A corrupt queue is not worth blocking a launch over. The files are
      // still on disk and can be re-added.
      this.entries = [];
    }
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // Storage full. The in-memory queue still works for this session.
    }
  }

  /* ── Queue operations ─────────────────────────────────────────────────── */

  enqueue(input: {
    uri: string;
    filename: string;
    mimeType: string;
    totalBytes: number;
    coversOpening?: boolean;
    trainingConsent?: boolean;
    /** From the picker when it says; part of the resume fingerprint. */
    modifiedMs?: number | null;
  }): string {
    const entry: UploadEntry = {
      id: Crypto.randomUUID(),
      uri: input.uri,
      filename: input.filename,
      mimeType: input.mimeType,
      totalBytes: input.totalBytes,
      uploadedBytes: 0,
      status: 'queued',
      jobId: null,
      idempotencyKey: Crypto.randomUUID(),
      error: null,
      createdAt: new Date().toISOString(),
      elapsedMs: 0,
      coversOpening: input.coversOpening ?? false,
      // NOT defaulted. `?? false` here would turn "never asked" into a
      // recorded refusal for every entry queued by a client that does not ask.
      trainingConsent: input.trainingConsent,
      modifiedMs: input.modifiedMs ?? null,
    };
    this.entries = [entry, ...this.entries];
    this.emit();
    void this.drain();
    return entry.id;
  }

  cancel(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined) {
      return;
    }
    if (entry.status === 'uploading' && this.activeTask !== null) {
      this.activeTask.cancel();
    }
    this.update(id, { status: 'cancelled' });
  }

  retry(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    // A multipart entry keeps what landed; only a single PUT starts over.
    this.update(id, {
      status: 'queued',
      error: null,
      uploadedBytes: entry?.multipart ? entry.uploadedBytes : 0,
    });
    void this.drain();
  }

  /** Forget a finished or failed entry. Does not touch the file on disk. */
  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.emit();
  }

  clearFinished(): void {
    this.entries = this.entries.filter(
      (e) => e.status !== 'uploaded' && e.status !== 'cancelled',
    );
    this.emit();
  }

  private update(id: string, patch: Partial<UploadEntry>): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    this.emit();
  }

  /* ── The transfer ─────────────────────────────────────────────────────── */

  /** One at a time; the backend rejects a second concurrent job per club. */
  private async drain(): Promise<void> {
    if (this.draining || this.api === null) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        const next = this.entries.find((e) => e.status === 'queued');
        if (next === undefined) {
          return;
        }
        await this.run(next.id);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(id: string): Promise<void> {
    const api = this.api;
    if (api === null) {
      return;
    }

    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined || entry.status !== 'queued') {
      return;
    }

    // The picker's URI can go stale — iOS evicts items from the photo cache,
    // and a share-sheet URI is scoped to that invocation. Discovering that as
    // a native crash mid-transfer is worse than checking first.
    const file = new File(entry.uri);
    if (!file.exists) {
      this.update(id, {
        status: 'failed',
        error: 'That file is no longer on this device. Pick it again.',
      });
      return;
    }

    this.update(id, { status: 'uploading', error: null });
    const startedAt = Date.now();

    // A multipart upload this entry already started: carry on from it.
    if (entry.multipart && entry.jobId) {
      await this.runMultipart(id, file, entry.jobId, null);
      return;
    }

    try {
      const totalBytes = entry.totalBytes > 0 ? entry.totalBytes : (file.size ?? 0);
      const fingerprint = await fingerprintOf({
        filename: entry.filename,
        totalBytes,
        modifiedMs: entry.modifiedMs ?? file.modificationTime ?? null,
      });
      const presigned = await api.post<UploadUrlResponse>(
        paths.uploadUrl,
        {
          filename: entry.filename,
          content_type: entry.mimeType,
          // THE SIZE IS WHAT BUYS PARTS. Without it the server can only offer
          // one PUT, which is capped at ~5 GiB and restarts from zero.
          size_bytes: totalBytes,
          fingerprint,
          // Travels with the job at MINT time, not at confirm: the flag has to
          // be on the record before extraction is enqueued, or the pipeline
          // reads a job that does not yet know what it is missing.
          covers_opening: entry.coversOpening,
          // Omitted, not sent as null, when nobody was asked — the server
          // reads an absent field as "never asked" and a present one as an
          // answer. See core/jobs.py::_TRISTATE_FIELDS.
          ...(entry.trainingConsent === undefined
            ? {}
            : { training_consent: entry.trainingConsent }),
        },
        { idempotencyKey: entry.idempotencyKey },
      );

      this.update(id, { jobId: presigned.job_id });

      if (presigned.mode === 'multipart') {
        this.update(id, {
          totalBytes,
          multipart: {
            uploadId: presigned.upload_id,
            partBytes: presigned.part_bytes,
            partCount: presigned.part_count,
            parts: {},
            fingerprint,
          },
        });
        await this.runMultipart(id, file, presigned.job_id, presigned);
        return;
      }

      await this.runSingle(id, file, presigned, startedAt);
    } catch (error) {
      this.fail(id, error);
    }
  }

  /** One PUT of the whole file: small files only (under one part). */
  private async runSingle(
    id: string,
    file: File,
    presigned: SingleUploadUrlResponse,
    startedAt: number,
  ): Promise<void> {
    const api = this.api;
    const entry = this.entries.find((e) => e.id === id);
    if (api === null || entry === undefined) {
      return;
    }
    try {
      const task = new UploadTask(file, presigned.upload_url, {
        httpMethod: presigned.method === 'PUT' ? 'PUT' : 'POST',
        // BINARY_CONTENT, not MULTIPART: a presigned PUT signs the raw body,
        // and a multipart envelope would produce a signature mismatch that
        // R2 reports as an opaque 403.
        uploadType: UploadType.BINARY_CONTENT,
        headers: presigned.headers,
        mimeType: entry.mimeType,
        sessionType: 'background',
        onProgress: ({ bytesSent, totalBytes }) => {
          this.update(id, {
            uploadedBytes: bytesSent,
            totalBytes: totalBytes > 0 ? totalBytes : entry.totalBytes,
            elapsedMs: Date.now() - startedAt,
          });
        },
      });

      this.activeTask = task;
      const result = await task.uploadAsync();
      this.activeTask = null;

      if (result.status < 200 || result.status >= 300) {
        // The object store's own error, not the API's. Its body is XML and
        // written for a developer, so it goes to the log, not the screen.
        console.warn('[upload] storage rejected the PUT', result.status, result.body);
        this.update(id, {
          status: 'failed',
          error: 'The upload was rejected by storage. This usually means the link expired — retry.',
        });
        return;
      }

      this.update(id, { status: 'confirming', uploadedBytes: entry.totalBytes });

      // Separate call rather than a storage webhook: a webhook arrives with no
      // Clerk token and the API has no other way to know whose object it is.
      await api.post(paths.uploadConfirm(presigned.job_id), undefined, {
        idempotencyKey: `${entry.idempotencyKey}:confirm`,
      });

      this.update(id, { status: 'uploaded' });
    } catch (error) {
      this.activeTask = null;
      this.fail(id, error);
    }
  }

  /**
   * Every missing part, then the confirm. `fresh` is the mint's response
   * (part URLs included); null means a resume, which first asks the store
   * which parts it holds.
   */
  private async runMultipart(
    id: string,
    file: File,
    jobId: string,
    fresh: MultipartUploadUrlResponse | null,
  ): Promise<void> {
    const api = this.api;
    if (api === null) {
      return;
    }
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const now = this.entries.find((e) => e.id === id);
      void api
        .post(paths.uploadProgress(jobId), { bytes_sent: now?.uploadedBytes ?? 0 })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      const state = () => this.entries.find((e) => e.id === id)?.multipart;
      if (state() === undefined) {
        return;
      }

      const total = () => this.entries.find((e) => e.id === id)?.totalBytes ?? 0;

      // ── Resume: the store's list wins over the ledger ──────────────────
      const urls = new Map<number, string>();
      if (fresh !== null) {
        for (const part of fresh.parts) {
          urls.set(part.part_number, part.url);
        }
      } else {
        const s = state()!;
        const listed = await api.get<{ uploads: UnfinishedUpload[] }>(paths.uploadsUnfinished, {
          query: { fingerprint: s.fingerprint },
          // What the store holds NOW; a cached list could hide a part.
          noCache: true,
        });
        const mine = listed.uploads.find((u) => u.job_id === jobId);
        if (mine === undefined) {
          // Not open any more. Either an earlier run confirmed it and was
          // killed before recording that -- then the job is past
          // `awaiting_upload` and nothing must be sent again -- or the
          // server discarded it after a day, and it starts over cleanly.
          const status = await api
            .get<{ state?: string; stage?: string }>(paths.job(jobId), { noCache: true })
            .catch(() => null);
          if (status !== null && status.state !== 'failed'
              && status.stage !== 'awaiting_upload') {
            this.update(id, { status: 'uploaded', uploadedBytes: total() });
            return;
          }
          this.update(id, { multipart: undefined, jobId: null, uploadedBytes: 0,
                            idempotencyKey: Crypto.randomUUID() });
          this.update(id, { status: 'queued' });
          return;
        }
        const parts: Record<number, string> = {};
        for (const p of mine.parts_done) {
          parts[p.part_number] = p.etag;
        }
        this.setLedger(id, parts);
      }

      // ── Send what is missing, PART_CONCURRENCY at a time ───────────────
      let todo = missingParts(state()!.partCount, state()!.parts);
      if (todo.length > 0) {
        const needUrls = todo.filter((n) => !urls.has(n));
        if (needUrls.length > 0) {
          for (const part of await this.freshUrls(jobId, needUrls)) {
            urls.set(part.part_number, part.url);
          }
        }
      }
      const inFlight = new Map<number, number>();
      const progress = () => {
        let sent = ledgerBytes(state()!, total());
        for (const bytes of inFlight.values()) {
          sent += bytes;
        }
        this.update(id, { uploadedBytes: sent, elapsedMs: Date.now() - startedAt });
      };

      const sendOne = async (n: number): Promise<void> => {
        for (let attempt = 1; ; attempt += 1) {
          const current = this.entries.find((e) => e.id === id);
          if (current === undefined || current.status === 'cancelled') {
            return;
          }
          const s = state()!;
          let temp: File | null = null;
          try {
            temp = copyPart(file, n, s.partBytes, total());
            const etag = await putPart(temp, urls.get(n)!, n, (sent) => {
              inFlight.set(n, sent);
              progress();
            });
            inFlight.delete(n);
            this.setLedger(id, { ...state()!.parts, [n]: etag });
            progress();
            return;
          } catch (error) {
            inFlight.delete(n);
            if (attempt >= PART_ATTEMPTS) {
              throw error;
            }
            if (error instanceof PartRejected && error.status === 403) {
              // An expired URL: R2 says 403. Ask for a fresh one.
              const [part] = await this.freshUrls(jobId, [n]);
              if (part !== undefined) {
                urls.set(n, part.url);
              }
            }
            await sleep(backoffMs(attempt));
          } finally {
            temp?.delete();
          }
        }
      };

      const queue = [...todo];
      const workers = Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
          await sendOne(n);
        }
      });
      await Promise.all(workers);

      const after = this.entries.find((e) => e.id === id);
      if (after === undefined || after.status === 'cancelled') {
        return;
      }
      todo = missingParts(state()!.partCount, state()!.parts);
      if (todo.length > 0) {
        throw new Error(`${todo.length} part(s) did not land`);
      }

      // ── Confirm: the store assembles the parts named here ──────────────
      this.update(id, { status: 'confirming', uploadedBytes: total() });
      const parts = Object.entries(state()!.parts)
        .map(([n, etag]) => ({ part_number: Number(n), etag }))
        .sort((a, b) => a.part_number - b.part_number);
      await api.post(paths.uploadConfirm(jobId), { parts }, {
        idempotencyKey: `${this.entries.find((e) => e.id === id)?.idempotencyKey}:confirm`,
        // Assembly of a few hundred parts plus a HEAD: more than 15 s.
        timeoutMs: 120_000,
      });
      this.update(id, { status: 'uploaded' });
    } catch (error) {
      // PAUSED, NOT LOST. The server is told so it frees the club's slot and
      // the pod; it keeps the parts, and so does the ledger. Retry resumes.
      void api
        .post(paths.uploadFailed(jobId), {
          reason: error instanceof Error ? error.message.slice(0, 200) : 'stopped',
          stage: 'parts',
          progress: this.fraction(id),
        })
        .catch(() => undefined);
      this.fail(id, error, 'The upload paused. Tap retry to carry on where it stopped.');
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async freshUrls(jobId: string, numbers: number[]): Promise<PartUrl[]> {
    const api = this.api!;
    const out: PartUrl[] = [];
    // The server takes up to 10,000 at once; batches keep each reply small.
    for (let i = 0; i < numbers.length; i += 500) {
      const reply = await api.post<UploadPartsResponse>(paths.uploadParts(jobId), {
        part_numbers: numbers.slice(i, i + 500),
      });
      out.push(...reply.parts);
    }
    return out;
  }

  private setLedger(id: string, parts: Record<number, string>): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry?.multipart === undefined) {
      return;
    }
    this.update(id, { multipart: { ...entry.multipart, parts } });
  }

  private fraction(id: string): number {
    const entry = this.entries.find((e) => e.id === id);
    return entry && entry.totalBytes > 0 ? entry.uploadedBytes / entry.totalBytes : 0;
  }

  private fail(id: string, error: unknown, fallback?: string): void {
    if (error instanceof ApiError && error.code === 'conflict') {
      // Another job is already running for this club. Not a failure — put it
      // back in the queue and let the drain loop pick it up after the other
      // one finishes.
      this.update(id, { status: 'queued', error: null });
      return;
    }
    this.update(id, {
      status: 'failed',
      error:
        error instanceof ApiError
          ? error.message
          : (fallback ?? 'The upload stopped. It will retry when you tap retry.'),
    });
  }
}

export const uploadManager = new UploadManager();

/* ── Derived values ───────────────────────────────────────────────────────── */

/**
 * An honest time estimate (§5).
 *
 * Based on the throughput this transfer has actually achieved, not on a
 * nominal connection speed. Returns null until there is enough of a sample to
 * mean anything — a "3 seconds remaining" that becomes "40 minutes" is worse
 * than no estimate, because a coach makes a decision on the first one.
 */
export function estimateRemainingMs(entry: UploadEntry): number | null {
  if (entry.status !== 'uploading' || entry.elapsedMs < 3000 || entry.uploadedBytes <= 0) {
    return null;
  }
  const bytesPerMs = entry.uploadedBytes / entry.elapsedMs;
  if (bytesPerMs <= 0) {
    return null;
  }
  const remaining = entry.totalBytes - entry.uploadedBytes;
  return remaining <= 0 ? 0 : remaining / bytesPerMs;
}

export function progressFraction(entry: UploadEntry): number {
  if (entry.totalBytes <= 0) {
    return 0;
  }
  return Math.min(1, entry.uploadedBytes / entry.totalBytes);
}
