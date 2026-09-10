/**
 * Driving a chunked capture session against the API.
 *
 * The manifest and its verification live in `chunkManifest.ts` and are pure.
 * This is the half that talks: open a session at kick-off, register and upload
 * each chunk as it is written, confirm it, and complete when the match ends.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE PHONE VERIFIES BEFORE THE SERVER DOES, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════════
 * `verifyChunkSet` runs here before `complete` is called, and again on the
 * server before anything is concatenated. That duplication is the point: the
 * phone is the only side that can still FIX a problem. It holds the chunks
 * until deletion is confirmed, so a gap found here is a re-upload, and the
 * same gap found only at the server is a match nobody can repair.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  DELETION IS GATED ON `mayDelete`, NEVER ON A 200
 * ══════════════════════════════════════════════════════════════════════════
 * A presigned PUT returning 200 means the bytes left the phone. It does not
 * mean they arrived whole — a truncated object, a multipart that silently
 * failed, a proxy that ate the tail. `confirmChunk` asks the server to re-hash
 * what it actually holds, and only its `mayDelete` frees the file. Deleting a
 * club's only copy of a match on the strength of a status code is the
 * unrecoverable failure this whole design exists to avoid.
 */

import type { ApiClient } from '../../api/client';
import { paths } from '../../api/endpoints';
import {
  verifyChunkSet,
  type ChunkManifest,
  type ChunkRole,
  type ChunkSetReport,
} from './chunkManifest';

/* ── Wire shapes ──────────────────────────────────────────────────────────
   The API takes camelCase (Pydantic `alias_generator=to_camel`) and returns
   camelCase, so both directions match the client's own naming and there is no
   translation layer to get wrong. */

export interface SessionLens {
  lensId: string | null;
  /** OpenCV order — [k1, k2, p1, p2, k3], tangential in the MIDDLE. */
  coefficients: number[];
  origin: string;
  approximate: boolean;
  /** Row-major 3×3, or null when only distortion was recovered. */
  cameraMatrix: number[][] | null;
}

export interface SessionCamera {
  role: ChunkRole;
  deviceId: string;
  clubCameraId: string | null;
  widthPx: number;
  heightPx: number;
  fps: number;
  /**
   * The lens as VALUES, not as a reference.
   *
   * A session that named a lens row would change meaning when somebody
   * re-calibrates that camera later, silently rewriting how an old match was
   * analysed. `venue_cameras.calibrated_length_m` sets the same precedent.
   */
  lens: SessionLens | null;
}

export interface OpenSessionResult {
  sessionId: string;
  /** How long a chunk should be. The SERVER decides, so the two cannot drift. */
  chunkTargetSeconds: number;
  maxChunkBytes: number;
  expiresAt: string;
}

export interface ChunkUploadTarget {
  uploadUrl: string;
  objectKey: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ConfirmResult {
  verified: boolean;
  /** The ONLY thing that may free the local file. */
  mayDelete: boolean;
  reason: string;
}

export interface SessionState {
  sessionId: string;
  status: string;
  cameras: Array<{
    role: ChunkRole;
    received: number[];
    missing: number[];
    durationSeconds: number;
    bytes: number;
    final: boolean;
  }>;
}

export interface CompleteResult {
  reassemblable: boolean;
  jobId: string | null;
  problems: Array<{ code: string; role?: string; sequences?: number[]; message: string }>;
}

/* ── The session ──────────────────────────────────────────────────────────── */

export async function openSession(
  api: ApiClient,
  input: {
    cameras: SessionCamera[];
    startedAt: string;
    appVersion: string;
    rigId?: string | null;
    venueId?: string | null;
    pitchId?: string | null;
  },
): Promise<OpenSessionResult> {
  return api.post<OpenSessionResult>(paths.captureSessions, {
    cameras: input.cameras,
    startedAt: input.startedAt,
    appVersion: input.appVersion,
    rigId: input.rigId ?? null,
    venueId: input.venueId ?? null,
    pitchId: input.pitchId ?? null,
  });
}

/**
 * Register a chunk and get somewhere to put it.
 *
 * Idempotent on `(session, role, sequence)` server-side, which matters more
 * than it looks: a retry after a dropped response returns the SAME object key
 * rather than minting a second one, so a flaky connection cannot produce two
 * objects for one chunk that both look valid.
 */
export async function registerChunk(
  api: ApiClient,
  sessionId: string,
  manifest: ChunkManifest,
): Promise<ChunkUploadTarget> {
  return api.post<ChunkUploadTarget>(paths.captureChunks(sessionId), {
    role: manifest.role,
    sequence: manifest.sequence,
    startPtsNs: manifest.startPtsNs,
    endPtsNs: manifest.endPtsNs,
    frameCount: manifest.frameCount,
    byteLength: manifest.byteLength,
    sha256: manifest.sha256,
    deviceId: manifest.deviceId,
    recordedAt: manifest.recordedAt,
    final: manifest.final,
  });
}

export async function confirmChunk(
  api: ApiClient,
  sessionId: string,
  role: ChunkRole,
  sequence: number,
  body: { sha256: string; byteLength: number },
): Promise<ConfirmResult> {
  return api.post<ConfirmResult>(paths.captureChunkUploaded(sessionId, role, sequence), body);
}

export async function sessionState(api: ApiClient, sessionId: string): Promise<SessionState> {
  return api.get<SessionState>(paths.captureSession(sessionId));
}

/**
 * Finish the session — but check locally first.
 *
 * The pre-flight is not politeness. `complete` answers 409 with the problems
 * named, and by then the operator has usually put the phone away; catching a
 * missing chunk here, while the file is still on the device and the app is
 * still open, is the difference between a re-upload and a lost match.
 */
export async function completeSession(
  api: ApiClient,
  sessionId: string,
  manifests: ChunkManifest[],
  input: {
    endedAt: string;
    sync?: {
      method: 'audio_marker' | 'ambient' | 'none';
      masterDeviceId: string | null;
      offsets: Array<{
        deviceId: string;
        offsetSeconds: number;
        propagationRemovedSeconds: number;
        uncertaintySeconds: number | null;
        peakRatio: number | null;
        warnings: string[];
      }>;
    };
  },
): Promise<{ local: ChunkSetReport; remote: CompleteResult | null }> {
  const local = verifyChunkSet(manifests);
  if (!local.reassemblable) {
    // Deliberately not sent. A 409 would say the same thing less usefully, and
    // the phone can still act on it.
    return { local, remote: null };
  }

  const remote = await api.post<CompleteResult>(paths.captureComplete(sessionId), {
    endedAt: input.endedAt,
    sync: input.sync ?? { method: 'none', masterDeviceId: null, offsets: [] },
  });
  return { local, remote };
}

export async function abandonSession(
  api: ApiClient,
  sessionId: string,
  reason: 'operator_cancelled' | 'device_failed' | 'storage_full',
): Promise<void> {
  await api.post(paths.captureAbandon(sessionId), { reason });
}

/**
 * Register → upload → confirm, for one chunk.
 *
 * Returns whether the local file may be deleted. Every failure path returns
 * `false`, because the only safe default for "did the server definitely get
 * this" is no.
 */
export async function sendChunk(
  api: ApiClient,
  sessionId: string,
  manifest: ChunkManifest,
  putBytes: (target: ChunkUploadTarget) => Promise<void>,
): Promise<{ mayDelete: boolean; reason: string }> {
  let target: ChunkUploadTarget;
  try {
    target = await registerChunk(api, sessionId, manifest);
  } catch (e) {
    return { mayDelete: false, reason: describe(e) };
  }

  try {
    await putBytes(target);
  } catch (e) {
    // The upload itself failed. The chunk stays on the phone and the next
    // attempt gets the same object key, because registration is idempotent.
    return { mayDelete: false, reason: describe(e) };
  }

  try {
    const confirmed = await confirmChunk(api, sessionId, manifest.role, manifest.sequence, {
      sha256: manifest.sha256,
      byteLength: manifest.byteLength,
    });
    return { mayDelete: confirmed.mayDelete, reason: confirmed.reason };
  } catch (e) {
    // Uploaded but unconfirmed. NOT deletable: the bytes may be there and may
    // be truncated, and only the server can tell which.
    return { mayDelete: false, reason: describe(e) };
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}
