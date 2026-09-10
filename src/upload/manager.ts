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
 * WHAT IS NOT TRUE YET, AND MUST BE SAID PLAINLY
 * ----------------------------------------------
 * RESUME RESTARTS THE FILE. A presigned PUT to R2 is a single request; there
 * is no byte range to resume from. An upload interrupted at 90% of an 18 GB
 * match restarts at zero.
 *
 * That is acceptable for a 200 MB clip on club Wi-Fi, which is all v0.1
 * uploads. It is NOT acceptable for a match, and §5's "a 36 GB pair over club
 * Wi-Fi is an overnight job" is precisely the case where it fails: an
 * overnight transfer that has to complete in one unbroken run will not.
 *
 * The fix is multipart upload — `POST /videos/upload-url` returning an upload
 * id and per-part URLs, and a completion call that assembles them. It is
 * listed in `docs/BACKEND-GAPS.md` as the blocking item for v0.2, and this
 * module's shape (a queue of entries, each with a `uploadedBytes` cursor) is
 * built so that lands as a change to `runTransfer` and nothing else.
 *
 * ALSO NOT TRUE YET: a JS task is not restored after app termination, so a
 * transfer that the OS continues in the background while the app is dead
 * finishes without this module seeing its result. On the next launch the entry
 * is still `uploading`; it is re-driven from the start rather than assumed
 * complete, because assuming would mean confirming an upload that may not have
 * landed — and §5 is unambiguous that deletion may only follow verification.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, UploadTask, UploadType } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { paths } from '../api/endpoints';
import type { UploadUrlResponse } from '../api/types';

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
}

type Listener = () => void;

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
      // Anything caught mid-transfer by a kill is re-queued, not resumed and
      // not assumed done. See the note at the top of this file.
      this.entries = stored.map((entry) =>
        entry.status === 'uploading' || entry.status === 'confirming'
          ? { ...entry, status: 'queued', uploadedBytes: 0 }
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
    this.update(id, { status: 'queued', error: null, uploadedBytes: 0 });
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

    try {
      const presigned = await api.post<UploadUrlResponse>(
        paths.uploadUrl,
        {
          filename: entry.filename,
          content_type: entry.mimeType,
          // Travels with the job at MINT time, not at confirm: the flag has to
          // be on the record before extraction is enqueued, or the pipeline
          // reads a job that does not yet know what it is missing.
          covers_opening: entry.coversOpening,
        },
        { idempotencyKey: entry.idempotencyKey },
      );

      this.update(id, { jobId: presigned.job_id });

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
            : 'The upload stopped. It will retry when you tap retry.',
      });
    }
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
