/**
 * Recording a match on this phone: gapless 1-minute segments, each uploaded
 * while the match is still being played.
 *
 * THE PIECES
 *   - `modules/riseup-recorder`: one encoder for the whole match; the file
 *     rolls at a keyframe every `chunkTargetSeconds` (the SERVER's number).
 *     Every segment arrives closed and hashed, with PTS on the session clock.
 *   - `chunkedSession.ts`: register → PUT → confirm, for one chunk.
 *   - this file: the persisted queue in between, so a kill, a reboot or a lost
 *     signal costs nothing but time. Every segment is on disk until the server
 *     says `mayDelete`, and the queue is in AsyncStorage.
 *
 * WHAT "FAST" MEANS HERE (mobile ingest design, 8 Nov 2026). Segments go up
 * during the match, so at the final whistle only the last minute is left to
 * send, and the pipeline can have been working on the rest already.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths, UploadTask, UploadType } from 'expo-file-system';

import {
  getRiseupRecorder,
  type RecorderSegment,
} from '../../../modules/riseup-recorder';
import type { ApiClient } from '../../api/client';
import type { ChunkManifest } from '../upload/chunkManifest';
import {
  completeSession,
  openSession,
  sendChunk,
  type ChunkUploadTarget,
} from '../upload/chunkedSession';
import { backoffMs, nextChunkToSend, type QueuedChunk } from './recordingQueue';

const STATE_KEY = 'riseup.matchRecording.v1';
const DEVICE_KEY = 'riseup.deviceId';

/** 1080p25 at 16 Mbit/s: ~120 MB a minute; the pipeline's broadcast rate. */
export const RECORD_SETTINGS = { width: 1920, height: 1080, fps: 25, bitRate: 16_000_000 };

export type RecordingPhase = 'idle' | 'recording' | 'finishing' | 'completed' | 'failed';

export interface RecordingState {
  phase: RecordingPhase;
  sessionId: string | null;
  deviceId: string | null;
  chunkTargetSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
  chunks: QueuedChunk[];
  /** The server's job, once `complete` accepted the set. */
  jobId: string | null;
  error: string | null;
}

const EMPTY: RecordingState = {
  phase: 'idle',
  sessionId: null,
  deviceId: null,
  chunkTargetSeconds: 60,
  startedAt: null,
  endedAt: null,
  chunks: [],
  jobId: null,
  error: null,
};

type Listener = () => void;

class MatchRecording {
  private state: RecordingState = EMPTY;
  private listeners = new Set<Listener>();
  private api: ApiClient | null = null;
  private pumping = false;
  private hydrated = false;
  private subscriptions: { remove(): void }[] = [];

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = (): RecordingState => this.state;

  private set(patch: Partial<RecordingState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) {
      l();
    }
    void AsyncStorage.setItem(STATE_KEY, JSON.stringify(this.state)).catch(() => undefined);
  }

  /** Attach the API and resume whatever an earlier launch left unsent. */
  async attach(api: ApiClient): Promise<void> {
    this.api = api;
    if (!this.hydrated) {
      this.hydrated = true;
      try {
        const raw = await AsyncStorage.getItem(STATE_KEY);
        if (raw !== null) {
          const saved = JSON.parse(raw) as RecordingState;
          // A recording cannot survive the process: the encoder died with it.
          // What it wrote is on disk and is sent; the session is finished.
          this.state = saved.phase === 'recording' ? { ...saved, phase: 'finishing' } : saved;
        }
      } catch {
        this.state = EMPTY;
      }
      this.listenToRecorder();
    }
    void this.pump();
  }

  /* ── recording ────────────────────────────────────────────────────────── */

  async start(input: { coversOpening: boolean; venueId?: string | null }): Promise<void> {
    const api = this.api;
    const recorder = getRiseupRecorder();
    if (api === null || recorder === null) {
      throw new Error('Recording needs the RiseUp build of the app (not Expo Go).');
    }
    if (this.state.phase === 'recording' || this.state.phase === 'finishing') {
      throw new Error('A match is already being recorded or sent.');
    }
    const permission = await recorder.requestPermission();
    if (!permission.granted) {
      throw new Error('RiseUp needs the camera to record the match.');
    }
    const deviceId = await this.deviceId();
    const startedAt = new Date().toISOString();
    const session = await openSession(api, {
      cameras: [{
        role: 'solo',
        deviceId,
        clubCameraId: null,
        widthPx: RECORD_SETTINGS.width,
        heightPx: RECORD_SETTINGS.height,
        fps: RECORD_SETTINGS.fps,
        lens: null,
      }],
      startedAt,
      appVersion: appVersion(),
      coversOpening: input.coversOpening,
      venueId: input.venueId ?? null,
    });
    const dir = new Directory(Paths.document, 'recordings', session.sessionId);
    dir.create({ intermediates: true, idempotent: true });
    this.set({
      ...EMPTY,
      phase: 'recording',
      sessionId: session.sessionId,
      deviceId,
      chunkTargetSeconds: session.chunkTargetSeconds,
      startedAt,
    });
    try {
      await recorder.start({
        directory: dir.uri,
        segmentSeconds: session.chunkTargetSeconds,
        ...RECORD_SETTINGS,
      });
    } catch (e) {
      this.set({ phase: 'failed', error: e instanceof Error ? e.message : 'The camera did not start.' });
      throw e;
    }
  }

  /** Stop the camera. The final segment follows; then `complete` is sent. */
  async stop(): Promise<void> {
    const recorder = getRiseupRecorder();
    this.set({ phase: 'finishing', endedAt: new Date().toISOString() });
    await recorder?.stop();
    void this.pump();
  }

  private listenToRecorder(): void {
    const recorder = getRiseupRecorder();
    if (recorder === null) {
      return;
    }
    this.subscriptions.push(
      recorder.addListener('onSegment', (segment: RecorderSegment) => this.onSegment(segment)),
      recorder.addListener('onError', (error) => {
        this.set({ error: error.message });
      }),
    );
  }

  private onSegment(segment: RecorderSegment): void {
    const { sessionId, deviceId } = this.state;
    if (sessionId === null || deviceId === null) {
      return;
    }
    const manifest: ChunkManifest = {
      sessionId,
      deviceId,
      role: 'solo',
      sequence: segment.sequence,
      startPtsNs: segment.startPtsNs,
      endPtsNs: segment.endPtsNs,
      frameCount: segment.frameCount,
      sha256: segment.sha256,
      byteLength: segment.byteLength,
      recordedAt: new Date().toISOString(),
      appVersion: appVersion(),
      final: segment.final,
    };
    const uri = segment.path.startsWith('file://') ? segment.path : `file://${segment.path}`;
    this.set({
      chunks: [...this.state.chunks.filter((c) => c.manifest.sequence !== segment.sequence),
               { manifest, uri, status: 'pending', attempts: 0, nextAttemptAt: 0, error: null }],
    });
    void this.pump();
  }

  /* ── sending ──────────────────────────────────────────────────────────── */

  /** One chunk at a time, oldest first, until every chunk is confirmed. */
  private async pump(): Promise<void> {
    if (this.pumping || this.api === null) {
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const sessionId = this.state.sessionId;
        if (sessionId === null) {
          return;
        }
        const next = nextChunkToSend(this.state.chunks, Date.now());
        if (next === 'wait') {
          await sleep(1000);
          continue;
        }
        if (next === null) {
          break;
        }
        await this.sendOne(sessionId, next);
      }
      await this.maybeComplete();
    } finally {
      this.pumping = false;
    }
  }

  private async sendOne(sessionId: string, chunk: QueuedChunk): Promise<void> {
    const api = this.api!;
    const seq = chunk.manifest.sequence;
    const result = await sendChunk(api, sessionId, chunk.manifest, (target) => put(chunk.uri, target));
    if (result.mayDelete) {
      try {
        new File(chunk.uri).delete();
      } catch {
        // Already gone: nothing to free.
      }
      this.patchChunk(seq, { status: 'confirmed', error: null });
      return;
    }
    const attempts = chunk.attempts + 1;
    this.patchChunk(seq, {
      attempts,
      error: result.reason,
      nextAttemptAt: Date.now() + backoffMs(attempts),
    });
  }

  private patchChunk(sequence: number, patch: Partial<QueuedChunk>): void {
    this.set({
      chunks: this.state.chunks.map((c) =>
        c.manifest.sequence === sequence ? { ...c, ...patch } : c),
    });
  }

  /** After the final segment is confirmed: the server assembles the match. */
  private async maybeComplete(): Promise<void> {
    const { phase, sessionId, chunks, endedAt } = this.state;
    if (phase !== 'finishing' || sessionId === null) {
      return;
    }
    if (!chunks.some((c) => c.manifest.final) || chunks.some((c) => c.status !== 'confirmed')) {
      return;
    }
    try {
      const { local, remote } = await completeSession(
        this.api!, sessionId, chunks.map((c) => c.manifest),
        { endedAt: endedAt ?? new Date().toISOString() });
      if (remote?.reassemblable) {
        this.set({ phase: 'completed', jobId: remote.jobId, error: null });
      } else {
        const problems = remote?.problems.map((p) => p.message) ?? local.problems.map((p) => p.message);
        this.set({ phase: 'failed', error: problems.join(' ') || 'The match could not be assembled.' });
      }
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : 'Completing the match failed; retrying.' });
      setTimeout(() => void this.pump(), 30_000);
    }
  }

  /** Clear a finished or failed recording from the screen. Files stay until confirmed. */
  reset(): void {
    if (this.state.phase === 'completed' || this.state.phase === 'idle') {
      this.set(EMPTY);
    }
  }

  private async deviceId(): Promise<string> {
    const saved = await AsyncStorage.getItem(DEVICE_KEY);
    if (saved !== null) {
      return saved;
    }
    const id = `dev_${Crypto.randomUUID()}`;
    await AsyncStorage.setItem(DEVICE_KEY, id);
    return id;
  }
}

/** PUT one segment with exactly the headers the server signed (incl. the
 * SHA-256, which R2 enforces: a mismatch is refused, never stored). */
async function put(uri: string, target: ChunkUploadTarget): Promise<void> {
  const task = new UploadTask(new File(uri), target.uploadUrl, {
    httpMethod: target.method === 'POST' ? 'POST' : 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: target.headers,
    sessionType: 'background',
  });
  const result = await task.uploadAsync();
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`storage refused the chunk (${result.status})`);
  }
}

function appVersion(): string {
  return Application.nativeApplicationVersion ?? 'dev';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const matchRecording = new MatchRecording();
