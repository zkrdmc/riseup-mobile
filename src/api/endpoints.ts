/**
 * Every path this app calls, in one file.
 *
 * The point of centralising them is the four in §8.1 that the PRD gets wrong.
 * A screen that writes its own path string will write the PRD's version, and
 * discover the mistake as a 404 in a coach's hands rather than in review.
 *
 * Paths marked NOT YET BUILT do not exist on the backend. They are listed
 * because the client already knows their shape, and because a reader deserves
 * to see the whole surface in one place rather than infer the gaps.
 * `docs/BACKEND-GAPS.md` is the actionable version of the same list.
 */

const V1 = '/api/v1';

export const paths = {
  /* ── Account ── */
  me: `${V1}/me`,
  /**
   * GDPR erasure request. Records the request and anonymises the audit trail;
   * it does NOT delete the Clerk account, which the app does client-side. Both
   * halves are needed for App Review 5.1.1(v) and Google Play's equivalent.
   */
  meDelete: `${V1}/me/delete`,
  meExport: `${V1}/me/export`,

  /* ── Matches ── */
  matches: `${V1}/matches`,
  match: (matchId: string) => `${V1}/matches/${matchId}`,
  matchPlayers: (matchId: string) => `${V1}/matches/${matchId}/players`,
  matchPlayer: (matchId: string, trackId: number) =>
    `${V1}/matches/${matchId}/players/${trackId}`,
  matchTeams: (matchId: string) => `${V1}/matches/${matchId}/teams`,

  /**
   * Keyed by JOB id, not match id — and it lives on the matches router.
   * PRD §8.1 lists this as `POST /videos/.../lineup`, which 404s.
   */
  lineup: (jobId: string) => `${V1}/matches/${jobId}/lineup`,

  /* ── Upload ── */
  uploadMode: `${V1}/videos/upload-mode`,
  /** Multipart to the API. Small clips only, and never on a serverless deploy. */
  uploadDirect: `${V1}/videos/upload`,
  /** Mint a presigned PUT. The only viable path for a full match. */
  uploadUrl: `${V1}/videos/upload-url`,
  /**
   * Confirm a presigned PUT finished and start extraction.
   * PRD §8.1 calls this `POST /videos/confirm`. It is not.
   */
  uploadConfirm: (jobId: string) => `${V1}/videos/${jobId}/uploaded`,
  /** PRD §8.1 calls this `GET /videos/jobs`. It is not. */
  jobs: `${V1}/videos`,
  /** PRD §8.1 calls this `GET /videos/jobs/{id}`. It is not. */
  job: (jobId: string) => `${V1}/videos/${jobId}/status`,

  /* ── Players (cross-match) ──
     `playerId` is the ByteTrack track_id, which is per-match. See the caveat
     on `usePlayerHistory` before using this for a season comparison. */
  playerHistory: (trackId: number) => `${V1}/players/${trackId}/history`,

  /* ── Venues — needed by the framing check in v0.3 ── */
  pitches: `${V1}/venues/pitches`,

  /* ── Cameras and their lenses — BUILT, migration 015 ──
     The club's own cameras, distinct from `venues/cameras`, which administers
     installed cameras with stream credentials. A lens model survives being
     carried to another ground; a homography does not. */
  cameras: `${V1}/cameras`,
  camera: (cameraId: string) => `${V1}/cameras/${cameraId}`,
  cameraUsed: (cameraId: string) => `${V1}/cameras/${cameraId}/used`,
  /** Query: widthPx, heightPx, zoomRatio. 404 when not calibrated at that setting. */
  cameraLens: (cameraId: string) => `${V1}/cameras/${cameraId}/lens`,
  cameraLenses: (cameraId: string) => `${V1}/cameras/${cameraId}/lenses`,
  cameraLensDelete: (cameraId: string, lensId: string) =>
    `${V1}/cameras/${cameraId}/lenses/${lensId}`,

  /* ── NOT YET BUILT — see docs/BACKEND-GAPS.md ─────────────────────────────
     Calling any of these today returns 404. They are the v0.1 and v0.2
     backend work, written down at the shape the client expects.
     ───────────────────────────────────────────────────────────────────── */

  /** Register a push token. Blocks all of §6. */
  devices: `${V1}/me/devices`,
  device: (deviceId: string) => `${V1}/me/devices/${deviceId}`,
  /** Per-category preferences and quiet hours. */
  notificationPreferences: `${V1}/me/notification-preferences`,
  /** One compact payload for the summary screen, instead of three round trips. */
  matchSummary: (matchId: string) => `${V1}/matches/${matchId}/summary`,
  /** Playback URL for the auto-directed feed. v0.4. */
  matchVideo: (matchId: string) => `${V1}/matches/${matchId}/video`,
  /** Clip upload with a distinct processing profile. */
  clips: `${V1}/clips`,
} as const;
