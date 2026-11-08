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
}

export interface RecorderStarted {
  /** Wall clock at the first frame, ms since the epoch. */
  startedAtMs: number;
  /** What the camera actually gave, which may differ from what was asked. */
  width: number;
  height: number;
  fps: number;
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
}

export interface RecorderError {
  code: string;
  message: string;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

export type RecorderEvents = {
  onSegment: (segment: RecorderSegment) => void;
  onError: (error: RecorderError) => void;
  onState: (event: { state: RecorderState }) => void;
};
