/**
 * The gapless segmented recorder's wire types.
 *
 * WHY A RECORDER OF OUR OWN. The chunk contract (`src/capture/upload/
 * chunkManifest.ts`) needs consecutive segments to ABUT within 2 ms, with
 * presentation timestamps on one clock for the whole session. A camera
 * library that stops and restarts a recording every minute drops a fraction
 * of a second at each boundary and reports no timestamps (Zak, 8 Nov 2026:
 * own gapless recorder). Here ONE encoder runs for the whole match, and the
 * output rolls to a new file at the first keyframe past each boundary: every
 * frame lands in exactly one segment, and a segment ends where the next
 * begins.
 */

export interface RecorderStartOptions {
  /** Absolute directory (filesystem path, not file://) for the segments. */
  directory: string;
  /** Roll to a new file at the first keyframe this many seconds after the last roll. */
  segmentSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** Bits per second. */
  bitRate: number;
  /** The widest lens the phone has (ultra-wide). Default true. */
  widest?: boolean;
  /** HEVC (default) falls back to H.264 on a phone without an HEVC encoder. */
  codec?: RecorderCodec;
  /** Continuing a session after the app was killed: the next segment number,
   * and this recorder's zero on the session clock (approximate). */
  sequenceStart?: number;
  ptsOffsetNs?: number;
}

export type RecorderCodec = 'hevc' | 'h264';

export interface RecorderStarted {
  /** Wall clock at the first frame, ms since the epoch. */
  startedAtMs: number;
  /** What the camera actually gave, which may differ from what was asked. */
  width: number;
  height: number;
  fps: number;
  /** The camera module that is recording. */
  lens: 'ultrawide' | 'wide';
  /** Android: the zoom ratio that selected it (below 1 = ultra-wide). */
  zoomRatio?: number;
  /** What the encoder actually is (after any fallback). */
  codec: RecorderCodec;
}

/**
 * One finished segment, closed and hashed. Every field maps onto
 * `ChunkManifest`; times are on the session clock, whose zero is the first
 * frame.
 */
export interface RecorderSegment {
  /** Absolute filesystem path of the closed .mp4. */
  path: string;
  /** 0-based, no gaps. */
  sequence: number;
  /** PTS of the segment's first frame. */
  startPtsNs: number;
  /**
   * PTS where the NEXT segment starts (its first frame), so consecutive
   * segments abut exactly. For the final segment: last frame + one frame.
   */
  endPtsNs: number;
  frameCount: number;
  byteLength: number;
  /** Lowercase hex SHA-256 of the file, computed natively after close. */
  sha256: string;
  final: boolean;
  /** Frames the camera delivered that the encoder could not take. */
  droppedFrames: number;
  /** What this segment was encoded with. */
  codec: RecorderCodec;
  bitRate: number;
}

export interface RecorderError {
  code: string;
  message: string;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

/** Why a phone paused: it left the foreground, moved like a hand-held phone,
 * the camera was taken away, or the operator asked. */
export type PauseReason = 'background' | 'motion' | 'camera_lost' | 'operator';

export type RecorderEvents = {
  onSegment: (segment: RecorderSegment) => void;
  onError: (error: RecorderError) => void;
  onState: (event: { state: RecorderState }) => void;
  /** The last segment closed (not final) at `atNs` on the session clock. */
  onPaused: (event: { atNs: number; reason: PauseReason }) => void;
  onResumed: () => void;
};
