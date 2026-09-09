/**
 * Talking to the server about the club's cameras.
 *
 * The merge rule lives in `merge.ts` and is pure; this file is the requests and
 * the store writes around it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  LOCAL IS THE SOURCE OF TRUTH FOR RENDERING. THE SERVER IS THE SYNC.
 * ══════════════════════════════════════════════════════════════════════════
 * PRD §3: the app is used where there is no signal. So the picker never waits
 * on a request, a camera added at a ground works immediately, and a
 * calibration solved in a car park is usable before it has been pushed
 * anywhere. The server is how that reaches the rest of the club, not how the
 * screen gets drawn — the same shape as `src/i18n/store.tsx`.
 *
 * A push that fails is not an error the operator has to see. It is a retry on
 * the next foreground.
 */

import type { ApiClient } from '../../api/client';
import { paths } from '../../api/endpoints';
import { cameraFromWire, nest, reconcile, type WireCamera } from './merge';
import { cameraStore } from './store';
import type { LensCalibration, SavedCamera } from './types';

export interface SyncOutcome {
  ok: boolean;
  pulled: number;
  pushed: number;
  /** Present when the sync could not complete. Not shown to the operator. */
  reason?: string;
}

/**
 * Pull the club's list, merge it, and push anything the server has not seen.
 *
 * Safe to call on every foreground. Failure is a return value rather than a
 * throw: every caller is a background refresh with nothing useful to do about
 * a dead connection, and a rejected promise at a ground with no signal is an
 * unhandled rejection waiting to be logged as a crash.
 */
export async function syncCameras(api: ApiClient): Promise<SyncOutcome> {
  let remote: SavedCamera[];
  try {
    const response = await api.get<{ cameras: WireCamera[] }>(paths.cameras);
    remote = response.cameras.map(cameraFromWire);
  } catch (error) {
    return { ok: false, pulled: 0, pushed: 0, reason: describe(error) };
  }

  const { cameras, toPush } = reconcile(cameraStore.getSnapshot(), remote);
  cameraStore.replaceAll(cameras);

  let pushed = 0;
  for (const camera of toPush) {
    try {
      const created = await api.post<{ camera: WireCamera }>(paths.cameras, {
        label: camera.label,
        classId: camera.classId,
        kind: camera.kind,
        make: camera.make ?? undefined,
        model: camera.model ?? undefined,
        lensModel: camera.lensModel ?? undefined,
      });
      const serverId = created.camera.id;
      cameraStore.linkToServer(camera.id, serverId);

      // Calibrations follow the camera, not the other way round: the lens rows
      // reference a camera that has to exist first.
      for (const lens of camera.calibrations) {
        await pushCalibration(api, serverId, lens);
      }
      pushed += 1;
    } catch {
      // Left unpushed and retried next time. The camera still works locally,
      // which is the property that matters on a Saturday.
    }
  }

  return { ok: true, pulled: remote.length, pushed };
}

/**
 * Send one solved lens.
 *
 * Separate and exported because the calibration flow calls it the moment a
 * solve completes — waiting for the next background sync would mean a
 * twenty-minute calibration sitting on one handset while somebody else at the
 * same club is about to redo it.
 */
export async function pushCalibration(
  api: ApiClient,
  serverCameraId: string,
  lens: LensCalibration,
): Promise<boolean> {
  try {
    await api.post(paths.cameraLenses(serverCameraId), {
      widthPx: lens.widthPx,
      heightPx: lens.heightPx,
      zoomRatio: lens.zoomRatio,
      method: lens.method,
      distortion: lens.distortion,
      cameraMatrix: nest(lens.cameraMatrix),
      rmsReprojectionError: lens.rmsReprojectionError,
      edgeBowPx: lens.edgeBowPx,
      appVersion: lens.appVersion,
    });
    return true;
  } catch {
    return false;
  }
}

/** Report that a camera filmed. Fire-and-forget; the tally is not critical. */
export function reportCameraUsed(api: ApiClient, serverCameraId: string): void {
  void api.post(paths.cameraUsed(serverCameraId)).catch(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
