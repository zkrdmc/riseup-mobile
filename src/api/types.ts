/**
 * Wire types for riseup-backend.
 *
 * These are transcribed from the live API, not from the mobile PRD's §8.1
 * table. Where the two disagree, the API wins and the divergence is noted
 * here — the table in the PRD lists four endpoints under paths that do not
 * exist, and a client written from it would 404 on every upload.
 *
 * Source of truth:
 *   riseup-backend/api/routers/{matches,videos,me}.py
 *   riseup-backend/storage/db.py  (SCHEMA)
 */

/* ── Account ───────────────────────────────────────────────────────────────
   GET /api/v1/me

   NOTE: this returns four fields and no club NAME. The app therefore has an
   id to scope by and nothing to put in a header. Adding `club_name` and the
   user's full role list to this response is the smallest backend change that
   removes a placeholder from the settings screen.
   ───────────────────────────────────────────────────────────────────────── */

/** Clerk organisation roles, in ascending privilege. `club_id` is the org id. */
export type ClubRole = 'org:viewer' | 'org:analyst' | 'org:admin';

export interface Me {
  user_id: string;
  club_id: string;
  role: ClubRole;
  email: string | null;
}

/* ── Matches ───────────────────────────────────────────────────────────────
   GET /api/v1/matches            → { matches: Match[] }
   GET /api/v1/matches/{id}       → Match

   WHAT THE SUMMARY SCREEN CANNOT SHOW YET. PRD §7 asks the match summary to
   open with "result, date, opponent, pitch". The `matches` table has none of
   opponent, home_score or away_score, and `venue_id` is a foreign key with no
   join in the read path. So:
     - date     → `created_at`, which is the UPLOAD time, not kick-off. For a
                 match filmed on Saturday and uploaded on Sunday night that is
                 the wrong day, and the app labels it "Uploaded" rather than
                 quietly presenting it as the fixture date.
   - opponent  → `label`, if somebody named the match. Otherwise `filename`.
   - result    → not available. The screen omits the scoreline rather than
                 rendering a placeholder that looks like a real 0–0.
   - pitch     → `venue_id` only; needs a join or a `venue_name` on the read.
   ───────────────────────────────────────────────────────────────────────── */

export type MatchStatus = 'processing' | 'complete' | 'failed';

export interface Match {
  id: string;
  club_id: string;
  job_id: string;
  /** As uploaded. The tie back to the bytes; never overwritten by `label`. */
  filename: string;
  /** What the club calls this match. NULL until somebody names it. */
  label: string | null;
  sha256_digest: string | null;
  duration_sec: number | null;
  fps: number | null;
  frame_count: number | null;
  player_count: number | null;
  status: MatchStatus;
  venue_id: string | null;
  is_home: boolean;
  /** Upload time, not kick-off. See the note above. */
  created_at: string;
  updated_at: string;
}

/* ── Player metrics ────────────────────────────────────────────────────────
   GET /api/v1/matches/{id}/players?perspective=team|raw

   Derived ratios are recomputed server-side on every read, so the client must
   not recompute them from the raw counts — two implementations of
   `possession_pct` is how the phone and the dashboard end up disagreeing
   about the same match in front of the same coach.
   ───────────────────────────────────────────────────────────────────────── */

export interface PlayerMetrics {
  track_id: number;
  match_id: string;
  /** Decrypted server-side. NULL until a lineup assignment names this track. */
  name: string | null;
  jersey_number: number | null;
  position: string | null;
  team: string | null;
  is_referee: boolean;
  is_substitute: boolean;

  frames_seen: number;
  minutes_played: number | null;

  distance_m: number | null;
  top_speed_ms: number | null;
  top_speed_kmh: number | null;
  sprint_count: number | null;
  sprint_distance_m: number | null;
  hi_distance_m: number | null;
  avg_speed_ms: number | null;

  /** Pitch-normalised. Team-relative unless `perspective=raw` was requested. */
  centroid_x: number | null;
  centroid_y: number | null;
  width_coverage: number | null;
  depth_coverage: number | null;
  /** 2-D occupancy grid, already parsed from JSON by the API. */
  heatmap: number[][] | null;

  possession_frames: number | null;
  passes_attempted: number | null;
  passes_completed: number | null;
  passes_received: number | null;

  /** Recomputed on read. Do not derive these client-side. */
  distance_per90: number | null;
  possession_pct: number | null;
  pass_completion_pct: number | null;
}

export interface MatchPlayersResponse {
  match_id: string;
  player_count: number;
  perspective: 'team' | 'raw';
  players: PlayerMetrics[];
}

/* ── Upload jobs ───────────────────────────────────────────────────────────
   GET  /api/v1/videos                    → { jobs: Job[] }
   GET  /api/v1/videos/{job_id}/status    → Job

   `GET /matches` lists FINISHED work only — a matches row is written when
   riseup-ml posts a result back, minutes after the upload. A home screen that
   renders only that shows an empty list to someone who uploaded ten seconds
   ago. The two lists are joined on `match_id`, which a job carries once the
   pipeline mints one.
   ───────────────────────────────────────────────────────────────────────── */

export type JobState =
  | 'queued'
  | 'uploading'
  | 'extracting'
  | 'processing'
  | 'complete'
  | 'failed';

export interface Job {
  job_id: string;
  filename: string;
  state: JobState;
  stage: string;
  progress_pct: number;
  frames_total: number;
  frames_extracted: number;
  frames_queued: number;
  cuts_detected: number;
  file_size_bytes: number;
  /** Empty string when there is no error — not null. */
  error: string;
  created_at: string;
  updated_at: string;
  /** Present once the pipeline has minted a match. Joins to Match.id. */
  match_id?: string | null;
}

/* ── Upload path selection ─────────────────────────────────────────────────
   GET /api/v1/videos/upload-mode

   Told, not guessed. A client that picks the wrong path discovers it as a 413
   or a 501 halfway through a large file — which on a phone means halfway
   through an overnight upload on club Wi-Fi.
   ───────────────────────────────────────────────────────────────────────── */

export interface UploadMode {
  /** Presigned PUT straight to object storage. The only viable path for a match. */
  presigned: boolean;
  /** Multipart straight to the API. Small clips only, and not on serverless. */
  direct: boolean;
  preferred: 'presigned' | 'direct';
}

/** POST /api/v1/videos/upload-url */
export interface UploadUrlResponse {
  job_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
  expires_in: number;
  object_key: string;
  /** Relative path to call once the PUT returns 200. */
  next: string;
}

/** POST /api/v1/videos/upload — the direct multipart path. */
export interface DirectUploadResponse {
  job_id: string;
  filename: string;
  file_size_bytes: number;
  sha256_digest: string;
  state: string;
  message: string;
}

/* ── Lineup ────────────────────────────────────────────────────────────────
   POST /api/v1/matches/{job_id}/lineup

   NOTE THE PATH: it is keyed by JOB id, not match id, and it lives on the
   matches router. PRD §8.1 lists it as `POST /videos/.../lineup`.
   ───────────────────────────────────────────────────────────────────────── */

export interface LineupAssignment {
  track_id: number;
  player_name: string;
  jersey?: number;
  team?: string;
}

/* ── Venues ────────────────────────────────────────────────────────────────
   GET /api/v1/venues/pitches — pitch dimensions for the framing check (§4.2).
   Not used in v0.1; typed here because the capture module will need it and
   the shape should not be rediscovered then.
   ───────────────────────────────────────────────────────────────────────── */

export interface Pitch {
  pitch_id: string;
  name: string;
  length_m: number;
  width_m: number;
}
