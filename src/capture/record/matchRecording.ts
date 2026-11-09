/**
 * Recording a match on this phone: gapless 1-minute segments, each uploaded
 * while the match is still being played.
 *
 * THE PIECES
 *   - `modules/riseup-recorder`: one encoder for the whole match; the file
 *     rolls at a keyframe every `chunkTargetSeconds` (the SERVER's number).
 *     Every segment arrives closed and hashed, with PTS on the session clock.
 *     It also uploads: `enqueueUpload` hands a file to the OS (Android
 *     WorkManager, iOS background URLSession), which keeps going with the app
 *     in the background or killed.
 *   - `chunkedSession.ts`: register / confirm / complete against the API.
 *   - this file: the persisted queue in between. Every segment is on disk
 *     until the server says `mayDelete`; the queue is in AsyncStorage.
 *
 * THE RULES (Zak, 9 Nov 2026; memory phone-pair-pause-halftime)
 *   - Leaving the foreground, or being moved like a hand-held phone, PAUSES
 *     this phone: the open segment closes, the server is told, and the next
 *     segment declares the gap (`gapBeforeMs`) so coverage drops by exactly
 *     the paused time. Back in the foreground (or still again) resumes.
 *   - The server runs the halftime window and completes a match nobody came
 *     back to; on the next open this phone shows "Match finished?".
 *   - Video starts at the top of the bitrate ladder and steps down when the
 *     upload falls behind, up when it keeps up (`recordingQueue.ts`).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState, type AppStateStatus } from 'react-native';

import {
  getRiseupRecorder,
  type PauseReason,
  type RecorderSegment,
} from '../../../modules/riseup-recorder';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { paths } from '../../api/endpoints';
import type { ChunkManifest } from '../upload/chunkManifest';
import {
  abandonSession,
  completeSession,
  confirmChunk,
  joinSession,
  openSession,
  registerChunk,
} from '../upload/chunkedSession';
import { joinOffsetNs, type JoinCode } from './pairing';
import { startMotionWatch, type MotionWatch } from './motion';
import { prepareRecordingNotices, recordingNotices } from './recordingNotices';
import {
  backlogSeconds,
  backoffMs,
  gapBeforeMs,
  ladderFor,
  nextChunkToSend,
  nextRung,
  type QueuedChunk,
} from './recordingQueue';

const STATE_KEY = 'riseup.matchRecording.v2';
/** Unsent video, in seconds, past which the coach is told the upload is behind. */
const BEHIND_WARN_S = 180;
const DEVICE_KEY = 'riseup.deviceId';

/**
 * 1080p30 HEVC on the widest lens the phone has, starting at the top of the
 * ladder. 30, not 25: phones offer fixed 30 fps modes, and a Pixel 8a has no
 * 25 fps one (measured 8 Nov 2026). The pipeline reads the rate from the file.
 */
export const RECORD_SETTINGS = { width: 1920, height: 1080, fps: 30, widest: true,
                                 codec: 'hevc' as const };

export type RecordingPhase =
  | 'idle'
  | 'recording'
  /** Pulled from the casing; the server holds the session open. */
  | 'paused'
  /** The app came back to a recording it was not running (killed, or the
   *  server's halftime window passed): the operator says whether it is over. */
  | 'confirm_end'
  | 'finishing'
  | 'completed'
  | 'failed';

export interface RecordingState {
  phase: RecordingPhase;
  sessionId: string | null;
  deviceId: string | null;
  role: 'A' | 'B' | 'solo';
  chunkTargetSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
  chunks: QueuedChunk[];
  /** Ladder position, its rungs' codec, and segments in a row sent faster
   *  than real time. */
  rung: number;
  codec: 'hevc' | 'h264';
  fastInARow: number;
  pauseReason: PauseReason | null;
  /** The server's job, once the set is complete. */
  jobId: string | null;
  error: string | null;
}

const EMPTY: RecordingState = {
  phase: 'idle',
  sessionId: null,
  deviceId: null,
  role: 'solo',
  chunkTargetSeconds: 60,
  startedAt: null,
  endedAt: null,
  chunks: [],
  rung: 0,
  codec: 'hevc',
  fastInARow: 0,
  pauseReason: null,
  jobId: null,
  error: null,
};

type Listener = () => void;

/** What GET /capture/sessions/{id} says, as far as this file reads it. */
interface ServerSession {
  status?: string;
  autoCompleted?: boolean;
  halftimeStartedAt?: string | null;
  jobId?: string | null;
  cameras?: Array<{
    role: string;
    chunks?: Array<{ sequence: number; verified?: boolean; mayDelete?: boolean }>;
  }>;
}

class MatchRecording {
  private state: RecordingState = EMPTY;
  private listeners = new Set<Listener>();
  private api: ApiClient | null = null;
  private pumping = false;
  private hydrated = false;
  private motion: MotionWatch | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private warnedBehind = false;

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

  /** Attach the API, restore the queue, and reconcile with the server. */
  async attach(api: ApiClient): Promise<void> {
    this.api = api;
    if (!this.hydrated) {
      this.hydrated = true;
      try {
        const raw = await AsyncStorage.getItem(STATE_KEY);
        if (raw !== null) {
          const saved = JSON.parse(raw) as RecordingState;
          // A recording cannot survive the process: the encoder died with it.
          // What it wrote is on disk and is sent; whether the match is over
          // is the operator's call (or the server's, after halftime).
          this.state = saved.phase === 'recording' || saved.phase === 'paused'
            ? { ...saved, phase: 'confirm_end' }
            : saved;
        }
      } catch {
        this.state = EMPTY;
      }
      this.listenToRecorder();
      AppState.addEventListener('change', (s) => this.onAppState(s));
    }
    await this.reconcile();
    this.startPolling();
    void this.pump();
  }

  /* ── recording ────────────────────────────────────────────────────────── */

  async start(input: { coversOpening: boolean; venueId?: string | null }): Promise<void> {
    const api = this.api;
    const recorder = getRiseupRecorder();
    if (api === null || recorder === null) {
      throw new Error('Recording needs the RiseUp build of the app (not Expo Go).');
    }
    if (this.state.phase !== 'idle' && this.state.phase !== 'completed'
        && this.state.phase !== 'failed') {
      throw new Error('A match is already being recorded or sent.');
    }
    const permission = await recorder.requestPermission();
    if (!permission.granted) {
      throw new Error('RiseUp needs the camera to record the match.');
    }
    const deviceId = await this.deviceId();
    const startedAt = new Date().toISOString();
    // Phone recordings are PAIRS in casings (Zak, 9 Nov 2026): the phone that
    // starts the match is camera A; the second joins as B (pairing.ts).
    const session = await openSession(api, {
      cameras: [{
        role: 'A',
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
    this.set({
      ...EMPTY,
      phase: 'recording',
      sessionId: session.sessionId,
      deviceId,
      role: 'A',
      chunkTargetSeconds: session.chunkTargetSeconds,
      startedAt,
    });
    await this.startRecorder(0, 0);
  }

  /** Phone B: join phone A's match from its code, and start recording. */
  async join(code: JoinCode): Promise<void> {
    const api = this.api;
    const recorder = getRiseupRecorder();
    if (api === null || recorder === null) {
      throw new Error('Recording needs the RiseUp build of the app (not Expo Go).');
    }
    if (this.state.phase !== 'idle' && this.state.phase !== 'completed'
        && this.state.phase !== 'failed') {
      throw new Error('This phone is already recording or sending a match.');
    }
    const permission = await recorder.requestPermission();
    if (!permission.granted) {
      throw new Error('RiseUp needs the camera to record the match.');
    }
    const deviceId = await this.deviceId();
    const session = await joinSession(api, code.sessionId, {
      role: 'B',
      deviceId,
      widthPx: RECORD_SETTINGS.width,
      heightPx: RECORD_SETTINGS.height,
      fps: RECORD_SETTINGS.fps,
    });
    this.set({
      ...EMPTY,
      phase: 'recording',
      sessionId: session.sessionId,
      deviceId,
      role: 'B',
      chunkTargetSeconds: session.chunkTargetSeconds,
      startedAt: session.startedAt,
    });
    // B starts later than A: its zero sits that far into the session clock.
    await this.startRecorder(0, joinOffsetNs(session.startedAt, Date.now()));
  }

  /** The recorder, from `sequenceStart` at `ptsOffsetNs` on the session clock. */
  private async startRecorder(sequenceStart: number, ptsOffsetNs: number): Promise<void> {
    const recorder = getRiseupRecorder()!;
    const { sessionId, chunkTargetSeconds } = this.state;
    prepareRecordingNotices();
    const dir = new Directory(Paths.document, 'recordings', sessionId!);
    dir.create({ intermediates: true, idempotent: true });
    try {
      const started = await recorder.start({
        directory: dir.uri,
        segmentSeconds: chunkTargetSeconds,
        ...RECORD_SETTINGS,
        bitRate: ladderFor(this.state.codec)[this.state.rung]!,
        sequenceStart,
        ptsOffsetNs,
      });
      if (started.codec !== this.state.codec) {
        // No HEVC encoder on this phone: the H.264 ladder, same rung.
        this.set({ codec: started.codec });
        recorder.setBitRate(ladderFor(started.codec)[this.state.rung]!);
      }
      this.set({ phase: 'recording', error: null });
      this.motion?.stop();
      this.motion = startMotionWatch({
        onMoved: () => this.pause('motion'),
        onStill: () => {
          if (this.state.phase === 'paused' && this.state.pauseReason === 'motion') {
            this.resume();
          }
        },
      });
    } catch (e) {
      this.set({ phase: 'failed', error: e instanceof Error ? e.message : 'The camera did not start.' });
      throw e;
    }
  }

  /** Stop at the final whistle. The final segment follows; then `complete`. */
  async stop(): Promise<void> {
    this.motion?.stop();
    this.motion = null;
    this.set({ phase: 'finishing', endedAt: new Date().toISOString() });
    await getRiseupRecorder()?.stop();
    void recordingNotices.stopped(this.state.role);
    void this.pump();
  }

  /* ── pause / resume (pulled from the casing) ─────────────────────────── */

  private onAppState(next: AppStateStatus): void {
    if (next === 'background' && this.state.phase === 'recording') {
      this.pause('background');
    } else if (next === 'active') {
      // ASK THE SERVER FIRST. If it closed the match while this phone was in
      // a pocket (both cameras paused past the window), resuming would record
      // into a closed session: every register 409s and the disk fills.
      void this.reconcile().then((closed) => {
        if (!closed && this.state.phase === 'paused'
            && this.state.pauseReason === 'background') {
          this.resume();
        }
        void this.pump();
      });
    }
  }

  pause(reason: PauseReason): void {
    if (this.state.phase !== 'recording') {
      return;
    }
    getRiseupRecorder()?.pause(reason);
    this.set({ phase: 'paused', pauseReason: reason });
    void recordingNotices.paused(this.state.role, reason);
    void this.tellServer('pause', reason);
  }

  resume(): void {
    if (this.state.phase !== 'paused') {
      return;
    }
    getRiseupRecorder()?.resume();
    this.set({ phase: 'recording', pauseReason: null });
    void recordingNotices.resumed(this.state.role);
    void this.tellServer('resume');
  }

  /** The halftime rules live on the server; it needs to know. Best effort:
   *  the gap itself travels with the next chunk either way. */
  private async tellServer(what: 'pause' | 'resume', reason?: PauseReason): Promise<void> {
    const { sessionId, role } = this.state;
    if (this.api === null || sessionId === null) {
      return;
    }
    const at = new Date().toISOString();
    await this.api
      .post(`${paths.captureSession(sessionId)}/cameras/${role}/${what}`,
            what === 'pause' ? { at, reason } : { at })
      .catch(() => undefined);
  }

  /**
   * The operator's answer on reopen. `over`: the match is finished; whatever
   * is on the phone is sent and the server completes it (the last segment was
   * closed by a pause, which the server accepts as the end). `continue`: the
   * same match, recording again from the next segment number.
   */
  async confirmEnd(answer: 'over' | 'continue'): Promise<void> {
    if (this.state.phase !== 'confirm_end') {
      return;
    }
    if (answer === 'over') {
      // Say "paused" first. After a crash, or a background pause that never
      // reached the server, it still thinks this camera is recording, and a
      // complete without a final chunk is NOT_FINALISED forever. With every
      // camera paused, the last verified chunk is the end (server rule).
      await this.tellServer('pause', 'operator');
      this.set({ phase: 'finishing', endedAt: new Date().toISOString() });
      void this.pump();
      return;
    }
    const last = this.lastChunk();
    const startedMs = Date.parse(this.state.startedAt ?? new Date().toISOString());
    // Wall-clock offset: approximate, and the gap it leaves is declared.
    await this.startRecorder(last === null ? 0 : last.manifest.sequence + 1,
                             (Date.now() - startedMs) * 1e6);
    void this.tellServer('resume');
  }

  /* ── segments ─────────────────────────────────────────────────────────── */

  private listenToRecorder(): void {
    const recorder = getRiseupRecorder();
    if (recorder === null) {
      return;
    }
    recorder.addListener('onSegment', (segment: RecorderSegment) => this.onSegment(segment));
    recorder.addListener('onError', (error) => this.set({ error: error.message }));
    // THE RECORDER PAUSES ITSELF when the OS takes the camera (another app, a
    // call: `camera_lost`). Without these the screen kept saying "recording"
    // and the server was never told. A pause JS asked for arrives here too,
    // after `pause()` already moved the phase, and is then a no-op.
    recorder.addListener('onPaused', ({ reason }) => {
      if (this.state.phase !== 'recording') {
        return;
      }
      this.set({ phase: 'paused', pauseReason: reason });
      void recordingNotices.paused(this.state.role, reason);
      void this.tellServer('pause', reason);
    });
    recorder.addListener('onResumed', () => {
      if (this.state.phase !== 'paused') {
        return;
      }
      this.set({ phase: 'recording', pauseReason: null });
      void recordingNotices.resumed(this.state.role);
      void this.tellServer('resume');
    });
  }

  private lastChunk(): QueuedChunk | null {
    return this.state.chunks.reduce<QueuedChunk | null>(
      (best, c) => (best === null || c.manifest.sequence > best.manifest.sequence ? c : best), null);
  }

  private onSegment(segment: RecorderSegment): void {
    const { sessionId, deviceId, role } = this.state;
    if (sessionId === null || deviceId === null) {
      return;
    }
    const previous = this.lastChunk();
    const manifest: ChunkManifest = {
      sessionId,
      deviceId,
      role,
      sequence: segment.sequence,
      startPtsNs: segment.startPtsNs,
      endPtsNs: segment.endPtsNs,
      frameCount: segment.frameCount,
      sha256: segment.sha256,
      byteLength: segment.byteLength,
      recordedAt: new Date().toISOString(),
      appVersion: appVersion(),
      final: segment.final,
      gapBeforeMs: gapBeforeMs(previous?.manifest.endPtsNs ?? null, segment.startPtsNs),
    };
    const uri = segment.path.startsWith('file://') ? segment.path : `file://${segment.path}`;
    this.set({
      chunks: [...this.state.chunks.filter((c) => c.manifest.sequence !== segment.sequence),
               { manifest, uri, status: 'pending', attempts: 0, nextAttemptAt: 0, error: null }],
    });
    void this.pump();
  }

  /* ── sending: register here, upload in the OS ─────────────────────────── */

  /** Registers every pending chunk (oldest first) and hands it to the OS. */
  private async pump(): Promise<void> {
    if (this.pumping || this.api === null) {
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const sessionId = this.state.sessionId;
        // Closed: nothing more can be registered against it.
        if (sessionId === null || this.state.phase === 'completed') {
          return;
        }
        const next = nextChunkToSend(this.state.chunks, Date.now());
        if (next === null || next === 'wait') {
          break;
        }
        await this.handOver(sessionId, next);
      }
      await this.maybeComplete();
    } finally {
      this.pumping = false;
    }
  }

  private async handOver(sessionId: string, chunk: QueuedChunk): Promise<void> {
    const recorder = getRiseupRecorder();
    const seq = chunk.manifest.sequence;
    try {
      const target = await registerChunk(this.api!, sessionId, chunk.manifest);
      recorder!.enqueueUpload({
        id: uploadId(sessionId, chunk),
        file: chunk.uri,
        url: target.uploadUrl,
        method: target.method,
        headers: target.headers,
        label: `Sending minute ${seq + 1} of the match`,
      });
      this.patchChunk(seq, { status: 'handed', handedAt: Date.now(), error: null });
    } catch (e) {
      const attempts = chunk.attempts + 1;
      this.patchChunk(seq, {
        attempts,
        error: e instanceof Error ? e.message : 'registering the chunk failed',
        nextAttemptAt: Date.now() + backoffMs(attempts),
      });
      if (e instanceof ApiError && e.status === 409) {
        // The session may have been closed under us: find out, and stop.
        void this.reconcile();
      }
    }
  }

  /** While the app is in front: read the OS uploader's outcomes. */
  private startPolling(): void {
    if (this.poll !== null) {
      return;
    }
    this.poll = setInterval(() => void this.checkUploads(), 2000);
  }

  private async checkUploads(): Promise<void> {
    const recorder = getRiseupRecorder();
    const { sessionId } = this.state;
    if (recorder === null || sessionId === null) {
      return;
    }
    for (const chunk of this.state.chunks.filter((c) => c.status === 'handed')) {
      const id = uploadId(sessionId, chunk);
      const status = recorder.uploadStatus(id);
      if (status === 'done') {
        await this.confirm(sessionId, chunk);
      } else if (status !== null && status.startsWith('failed:')) {
        // 403: the URL expired (re-registering signs a fresh one). Network:
        // the OS gave up for now. Either way, hand it over again.
        recorder.forgetUpload(id);
        const attempts = chunk.attempts + 1;
        this.patchChunk(chunk.manifest.sequence, {
          status: 'pending',
          attempts,
          error: `upload ${status}`,
          nextAttemptAt: Date.now() + backoffMs(attempts),
        });
      }
    }
    void this.pump();
  }

  /** The fast path while in front; the server confirms by itself otherwise. */
  private async confirm(sessionId: string, chunk: QueuedChunk): Promise<void> {
    const seq = chunk.manifest.sequence;
    try {
      const result = await confirmChunk(this.api!, sessionId, chunk.manifest.role, seq, {
        sha256: chunk.manifest.sha256,
        byteLength: chunk.manifest.byteLength,
      });
      if (result.mayDelete) {
        this.confirmed(sessionId, chunk);
      }
    } catch {
      // The server's own sweep confirms it; reconcile() picks that up.
    }
  }

  private confirmed(sessionId: string, chunk: QueuedChunk): void {
    try {
      new File(chunk.uri).delete();
    } catch {
      // Already gone.
    }
    getRiseupRecorder()?.forgetUpload(uploadId(sessionId, chunk));
    const durationS = (chunk.manifest.endPtsNs - chunk.manifest.startPtsNs) / 1e9;
    const sentS = chunk.handedAt ? (Date.now() - chunk.handedAt) / 1000 : Infinity;
    this.patchChunk(chunk.manifest.sequence, { status: 'confirmed', error: null });
    this.adjustLadder(sentS < durationS);
  }

  private adjustLadder(fast: boolean): void {
    const fastInARow = fast ? this.state.fastInARow + 1 : 0;
    const rungs = ladderFor(this.state.codec);
    const rung = nextRung({
      rung: this.state.rung,
      rungs: rungs.length,
      backlogSeconds: backlogSeconds(this.state.chunks),
      segmentSeconds: this.state.chunkTargetSeconds,
      fastInARow,
    });
    if (rung !== this.state.rung) {
      getRiseupRecorder()?.setBitRate(rungs[rung]!);
    }
    // Told once each time the backlog crosses three minutes, not every chunk.
    const behind = backlogSeconds(this.state.chunks);
    if (behind > BEHIND_WARN_S && !this.warnedBehind) {
      this.warnedBehind = true;
      void recordingNotices.behind(Math.round(behind / 60));
    } else if (behind < BEHIND_WARN_S / 2) {
      this.warnedBehind = false;
    }
    this.set({ rung, fastInARow: rung < this.state.rung ? 0 : fastInARow });
  }

  /**
   * What the server knows: chunks it verified on its own (deletable here), a
   * match it completed after halftime. Run on attach and on every return to
   * the foreground.
   */
  private async reconcile(): Promise<boolean> {
    const { sessionId, role } = this.state;
    if (this.api === null || sessionId === null) {
      return false;
    }
    let server: ServerSession;
    try {
      server = await this.api.get<ServerSession>(paths.captureSession(sessionId), { noCache: true });
    } catch {
      return false;
    }
    const mine = server.cameras?.find((c) => c.role === role);
    for (const chunk of this.state.chunks) {
      const s = mine?.chunks?.find((c) => c.sequence === chunk.manifest.sequence);
      if (chunk.status !== 'confirmed' && (s?.mayDelete ?? false)) {
        this.confirmed(sessionId, chunk);
      }
    }
    // CLOSED, by whoever: the server (half-time window, final chunks) or the
    // other phone of the pair, whose complete came first. Not only
    // `autoCompleted` -- the pair's second phone otherwise retried its own
    // complete against "already completed" every 30 s, forever.
    if (server.status === 'complete' || server.autoCompleted) {
      if (this.state.phase !== 'completed') {
        this.motion?.stop();
        this.motion = null;
        if (this.state.phase === 'recording' || this.state.phase === 'paused') {
          await getRiseupRecorder()?.stop();
        }
        this.set({ phase: 'completed', jobId: server.jobId ?? null, error: null });
        void recordingNotices.sent();
      }
      return true;
    }
    return false;
  }

  private patchChunk(sequence: number, patch: Partial<QueuedChunk>): void {
    this.set({
      chunks: this.state.chunks.map((c) =>
        c.manifest.sequence === sequence ? { ...c, ...patch } : c),
    });
  }

  /** Once every chunk is confirmed and the match is over: assemble it. */
  private async maybeComplete(): Promise<void> {
    const { phase, sessionId, chunks, endedAt } = this.state;
    if (phase !== 'finishing' || sessionId === null) {
      return;
    }
    if (chunks.some((c) => c.status !== 'confirmed')) {
      return;
    }
    try {
      const { local, remote } = await completeSession(
        this.api!, sessionId, chunks.map((c) => c.manifest),
        { endedAt: endedAt ?? new Date().toISOString() });
      if (remote?.reassemblable) {
        this.set({ phase: 'completed', jobId: remote.jobId, error: null });
        void recordingNotices.sent(remote.queuedBehind ?? null);
      } else {
        const problems = remote?.problems.map((p) => p.message) ?? local.problems.map((p) => p.message);
        this.set({ phase: 'failed', error: problems.join(' ') || 'The match could not be assembled.' });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // "Already completed": the other phone or the server got there first.
        if (await this.reconcile()) {
          return;
        }
        // The server's named problems come back as a 409, so this is where
        // they are read. This phone's own footage is all confirmed by now, so
        // a problem with it is final; the OTHER camera's is still sending.
        const problems = completeProblems(e.detail);
        if (problems !== null) {
          const mine = problems.filter((p) => p.role === undefined || p.role === this.state.role);
          if (mine.length > 0) {
            this.set({ phase: 'failed',
                       error: mine.map((p) => p.message).join(' ') || 'The match could not be assembled.' });
            return;
          }
          const others = [...new Set(problems.map((p) => p.role))].join(', ');
          this.set({ error: `Waiting for camera ${others} to finish sending.` });
          setTimeout(() => void this.pump(), 60_000);
          return;
        }
      }
      this.set({ error: e instanceof Error ? e.message : 'Completing the match failed; retrying.' });
      setTimeout(() => void this.pump(), 30_000);
    }
  }

  /**
   * Give up on this recording: the server is told (`abandon`), and the
   * segments still on the phone are deleted. Only on an operator's explicit
   * choice -- this is the one path that deletes footage the server has not
   * confirmed.
   */
  async discard(): Promise<void> {
    const { sessionId, chunks } = this.state;
    this.motion?.stop();
    this.motion = null;
    if (this.state.phase === 'recording' || this.state.phase === 'paused') {
      await getRiseupRecorder()?.stop();
    }
    if (sessionId !== null && this.api !== null) {
      await abandonSession(this.api, sessionId, 'operator_cancelled').catch(() => undefined);
    }
    for (const chunk of chunks) {
      try {
        new File(chunk.uri).delete();
      } catch {
        // Already gone.
      }
      if (sessionId !== null) {
        getRiseupRecorder()?.forgetUpload(uploadId(sessionId, chunk));
      }
    }
    if (sessionId !== null) {
      try {
        new Directory(Paths.document, 'recordings', sessionId).delete();
      } catch {
        // Already gone.
      }
    }
    this.set(EMPTY);
  }

  /** Clear a finished recording from the screen. Files stay until confirmed. */
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

function uploadId(sessionId: string, chunk: QueuedChunk): string {
  return `${sessionId}:${chunk.manifest.role}:${chunk.manifest.sequence}`;
}

function appVersion(): string {
  return Application.nativeApplicationVersion ?? 'dev';
}

/** The problems a refused `complete` names (409 `{reassemblable, problems}`), or null. */
function completeProblems(
  detail: unknown,
): Array<{ code: string; role?: string; message: string }> | null {
  if (typeof detail !== 'object' || detail === null || !('problems' in detail)) {
    return null;
  }
  const problems = (detail as { problems: unknown }).problems;
  return Array.isArray(problems) ? problems : null;
}

export const matchRecording = new MatchRecording();
