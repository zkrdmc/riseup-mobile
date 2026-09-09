/**
 * Merging the club's camera list — the pure half.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════════
 * A calibration is twenty minutes with a chessboard and it is identical for
 * everybody at the club. Kept on one handset, the second volunteer to pick up
 * the same camcorder has to do it again — which is the per-match cost PRD §4.3
 * exists to remove, reintroduced by the storage layer. `store.ts` says this in
 * its own header and could not act on it until the endpoints existed.
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
 * A push that fails is not an error the operator has to see. It is a flag and
 * a retry on the next foreground.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  IDENTITY: WHY A LOCAL RECORD CARRIES A SEPARATE serverId
 * ══════════════════════════════════════════════════════════════════════════
 * A camera created offline gets a local `Crypto.randomUUID()`. The server
 * mints its own id on first push, so the two never match, and matching on
 * label instead would turn a rename into a delete-and-recreate — losing every
 * calibration attached to it.
 *
 * So `serverId` is recorded on first successful push and is what reconciliation
 * matches on from then on. Label is used only for the one case it has to be:
 * a camera this device has never pushed, meeting a server row somebody else
 * created for the same physical camera. `UNIQUE(club_id, label)` makes that
 * safe — two rows cannot claim one name.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE MERGE RULE, AND THE ONE PLACE IT REFUSES TO GUESS
 * ══════════════════════════════════════════════════════════════════════════
 * Calibrations merge per `(widthPx, heightPx, zoomRatio)` — the key the whole
 * design turns on — and the NEWER `solvedAt` wins, because a re-solve is a
 * correction of the one before it.
 *
 * What it will not do is merge two calibrations at the same setting by
 * averaging, blending or preferring the lower error. A calibration is one
 * measurement of one lens; two of them at the same setting are two attempts,
 * and the later attempt is the operator's answer. Picking by RMS would quietly
 * prefer a solve that fitted a board held badly close to the centre — low
 * error, and useless at the frame edges where the distortion actually is.
 */

/**
 * NO IO IN THIS FILE, AND THAT IS THE POINT.
 *
 * `sync.ts` holds the requests and the store writes; everything here is a pure
 * function of its arguments. The split is not tidiness: the merge rule decides
 * whether a twenty-minute calibration survives meeting another handset's copy,
 * and `npm run smoke` runs it under plain Node with no Metro, no device and no
 * React. A single `import` of the store would pull in expo-crypto and
 * AsyncStorage and put this logic back out of reach of that harness.
 */

import type { OpenCvDistortion } from '../survey/opencv';
import type { LensCalibration, SavedCamera } from './types';

/* ── Wire shapes ──────────────────────────────────────────────────────────
   The API speaks snake_case on the way out (it returns database rows) and
   accepts camelCase on the way in (Pydantic aliases). That asymmetry is real,
   so it is written down here once rather than guessed at each call site. */

export interface WireLens {
  id: string;
  camera_id: string;
  width_px: number;
  height_px: number;
  zoom_ratio: number;
  method: LensCalibration['method'];
  camera_matrix: number[][] | null;
  distortion: OpenCvDistortion;
  rms_reprojection_error: number | null;
  edge_bow_px: number | null;
  solved_at: string;
  app_version: string | null;
}

export interface WireCamera {
  id: string;
  class_id: string;
  label: string;
  kind: 'phone' | 'external';
  make: string | null;
  model: string | null;
  lens_model: string | null;
  last_used_at: string | null;
  use_count: number;
  calibrations: WireLens[];
}

/**
 * The server stores `camera_matrix` as a 3×3 nested array; the client's
 * `LensCalibration.cameraMatrix` is a flat row-major 9.
 *
 * Flat on the client because that is what `modules/riseup-vision` returns
 * straight out of `cv::calibrateCamera`, and re-shaping at the boundary is
 * better than two shapes drifting through the app.
 */
export function flatten(matrix: number[][] | null): number[] | null {
  return matrix === null ? null : matrix.flat();
}

export function nest(flat: number[] | null): number[][] | null {
  if (flat === null || flat.length !== 9) {
    return null;
  }
  return [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)];
}

export function lensFromWire(w: WireLens): LensCalibration {
  return {
    id: w.id,
    widthPx: w.width_px,
    heightPx: w.height_px,
    zoomRatio: w.zoom_ratio,
    method: w.method,
    cameraMatrix: flatten(w.camera_matrix),
    // Carried through unread. `opencv.ts` owns the coefficient ordering and
    // the server stores what it was given, so re-interpreting it here would be
    // a second opinion on a question that already has one.
    //
    // The server stores this shape verbatim and validates `coefficients` and
    // `origin` on the way in, which is why there is no discriminator to check:
    // by the time anything is stored, the model is OpenCV Brown-Conrady by
    // construction. That contract is pinned in the backend's own tests.
    distortion: w.distortion,
    rmsReprojectionError: w.rms_reprojection_error,
    edgeBowPx: w.edge_bow_px,
    solvedAt: w.solved_at,
    appVersion: w.app_version ?? 'unknown',
  };
}

/** The same key the server's UNIQUE constraint uses, to a hundredth. */
function settingKey(c: Pick<LensCalibration, 'widthPx' | 'heightPx' | 'zoomRatio'>): string {
  return `${c.widthPx}x${c.heightPx}@${Math.round(c.zoomRatio * 100)}`;
}

/**
 * Merge one camera's calibrations, newer solve winning per setting.
 *
 * Order of the result is not meaningful and is not relied on — `calibrationFor`
 * filters by setting and takes the newest, so a list that happens to be in a
 * different order on two devices behaves identically.
 */
export function mergeCalibrations(
  local: LensCalibration[],
  remote: LensCalibration[],
): LensCalibration[] {
  const bySetting = new Map<string, LensCalibration>();
  for (const c of [...local, ...remote]) {
    const key = settingKey(c);
    const existing = bySetting.get(key);
    if (existing === undefined || c.solvedAt > existing.solvedAt) {
      bySetting.set(key, c);
    }
  }
  return [...bySetting.values()];
}

export interface MergeResult {
  cameras: SavedCamera[];
  /** Local records that the server has never seen, in local order. */
  toPush: SavedCamera[];
}

/**
 * Reconcile the local list against what the server holds.
 *
 * Deliberately NOT a delete-what-the-server-lacks operation. A camera missing
 * from the response could mean somebody removed it, or it could mean this
 * device created it thirty seconds ago on a train — and the two are
 * indistinguishable from here. Deleting on that guess would throw away a
 * calibration nobody could get back, so an unknown local camera is queued for
 * push instead. A removal is only ever honoured when this device performs it.
 */
export function reconcile(local: SavedCamera[], remote: SavedCamera[]): MergeResult {
  const byServerId = new Map(remote.map((r) => [r.id, r]));
  const byLabel = new Map(remote.map((r) => [r.label.toLowerCase(), r]));

  const merged: SavedCamera[] = [];
  const claimed = new Set<string>();
  const toPush: SavedCamera[] = [];

  for (const l of local) {
    // A camera this device has pushed before is matched by id. One it has not
    // is matched by name, which is the server's own unique key — that is what
    // lets a volunteer's offline "Club camcorder" find the row somebody else
    // already calibrated instead of creating a duplicate.
    const match =
      (l.serverId !== null && l.serverId !== undefined ? byServerId.get(l.serverId) : undefined) ??
      byLabel.get(l.label.toLowerCase());

    if (match === undefined) {
      merged.push(l);
      toPush.push(l);
      continue;
    }

    claimed.add(match.id);
    merged.push({
      ...l,
      serverId: match.id,
      // Server metadata wins: another member may have corrected the make or
      // model, and this device has no better information about a shared object.
      make: match.make,
      model: match.model,
      lensModel: match.lensModel,
      // Usage is a club-wide tally, so the server's count is the real one.
      useCount: Math.max(l.useCount, match.useCount),
      lastUsedAt:
        l.lastUsedAt !== null && match.lastUsedAt !== null
          ? (l.lastUsedAt > match.lastUsedAt ? l.lastUsedAt : match.lastUsedAt)
          : (l.lastUsedAt ?? match.lastUsedAt),
      calibrations: mergeCalibrations(l.calibrations, match.calibrations),
    });
  }

  // Cameras somebody else registered. This is the payoff: pick "Club camcorder"
  // on a phone that has never seen it and its lens model comes with it.
  for (const r of remote) {
    if (!claimed.has(r.id)) {
      merged.push(r);
    }
  }

  return { cameras: merged, toPush };
}

export function cameraFromWire(w: WireCamera): SavedCamera {
  return {
    id: w.id,
    serverId: w.id,
    classId: w.class_id,
    label: w.label,
    kind: w.kind,
    make: w.make,
    model: w.model,
    lensModel: w.lens_model,
    calibrations: w.calibrations.map(lensFromWire),
    createdAt: w.last_used_at ?? new Date().toISOString(),
    lastUsedAt: w.last_used_at,
    useCount: w.use_count,
  };
}

