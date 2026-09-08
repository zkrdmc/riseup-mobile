/**
 * Signing and ordering recorded chunks.
 *
 * A match is recorded as a run of short segments uploaded during play, so the
 * phone never holds more than a couple of minutes of video. They arrive out of
 * order — a lossy connection, a retry, a route change mid-match — and the
 * server has to put them back together with certainty rather than hope.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NOT A VISUAL WATERMARK, AND THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════════
 * The instinct is to burn a marker into the picture. Do not: these frames ARE
 * the measurement. Every pixel is input to detection and tracking, a burned-in
 * marker occludes whatever is behind it, and if it lands anywhere near the far
 * touchline it occludes players at the exact scale — around 40 px tall — where
 * detection is already marginal. It also does not survive a re-encode
 * faithfully, and it cannot be verified without decoding video.
 *
 * A manifest does the same job better. It travels with the upload, it is exact
 * rather than approximate, it costs nothing to verify, and it does not touch a
 * single pixel of the thing being measured.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ORDERING IS THE EASY HALF. CONTINUITY IS THE HALF THAT BITES.
 * ══════════════════════════════════════════════════════════════════════════
 * Out-of-order ARRIVAL is not really the problem: every chunk carries its
 * index, so the server sorts them. What a sequence number cannot tell you is
 * whether the chunks actually join up.
 *
 * A chunk can carry the right index and still be short — the recorder dropped
 * frames at a boundary, the encoder flushed late, the device throttled. Sort
 * by index and you get 0,1,2,3 with a hole between 1 and 2 that nothing in the
 * indices reveals. Concatenated, that is a match with four seconds missing
 * from the middle, no error anywhere, and a possession sequence that appears
 * to teleport.
 *
 * So every chunk carries the presentation timestamp it starts and ends at, on
 * a clock that runs for the whole session, and the check is that consecutive
 * chunks ABUT. Contiguity in time, not just in index.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ALSO WRITE IT INTO THE CONTAINER
 * ══════════════════════════════════════════════════════════════════════════
 * The manifest travels with the upload, but the file on the phone should carry
 * the same identifiers in its own metadata — the MP4 `udta` atom, or whatever
 * the recorder exposes. A chunk recovered from a device's storage after a
 * crash, separated from any request that described it, is then still
 * identifiable rather than an anonymous fragment nobody can place.
 */

export type ChunkRole = 'A' | 'B' | 'solo';

export interface ChunkManifest {
  sessionId: string;
  deviceId: string;
  /** Which camera in the rig. `solo` for a single-camera setup. */
  role: ChunkRole;

  /** 0-based, monotonic, no gaps. What the server sorts on. */
  sequence: number;

  /**
   * Presentation timestamps, in nanoseconds, on a clock that runs for the
   * WHOLE session rather than restarting per chunk.
   *
   * This is what makes a gap detectable. A per-chunk clock starting at zero
   * would make every chunk look like it begins where the last one did, and the
   * continuity check would pass on footage with holes in it.
   */
  startPtsNs: number;
  endPtsNs: number;

  /** Frames actually written. Cross-checks the duration against the frame rate. */
  frameCount: number;

  /** Of the chunk's bytes. The backend already does this for whole uploads. */
  sha256: string;
  byteLength: number;

  recordedAt: string;
  appVersion: string;

  /**
   * Set on the last chunk of the session.
   *
   * Without it the server cannot distinguish "the match ended" from "the phone
   * went into a tunnel", and would either reassemble a truncated match or wait
   * forever for a chunk that is never coming.
   */
  final: boolean;
}

/** How far consecutive chunks may miss each other and still be called contiguous. */
const MAX_JOIN_GAP_NS = 2_000_000; // 2 ms — well under one frame at 30 fps.

export interface ChunkSetProblem {
  code:
    | 'EMPTY'
    | 'DUPLICATE_SEQUENCE'
    | 'MISSING_SEQUENCE'
    | 'TIME_GAP'
    | 'TIME_OVERLAP'
    | 'NOT_FINALISED'
    | 'MIXED_SESSION';
  message: string;
  /** The sequence numbers involved, for a support answer that names the chunk. */
  sequences: number[];
}

export interface ChunkSetReport {
  ordered: ChunkManifest[];
  problems: ChunkSetProblem[];
  /** True when this set can be concatenated into one continuous recording. */
  reassemblable: boolean;
  totalDurationNs: number;
  totalBytes: number;
}

/**
 * Can these chunks be put back together?
 *
 * Runs on the phone before `complete` is called, and again on the server
 * before anything is concatenated. Both, deliberately: the phone can still fix
 * a missing chunk by re-uploading it, because deletion is gated on
 * confirmation — a gap found only at the server is a gap nobody can fill.
 */
export function verifyChunkSet(chunks: ChunkManifest[]): ChunkSetReport {
  const problems: ChunkSetProblem[] = [];

  if (chunks.length === 0) {
    return {
      ordered: [],
      problems: [{ code: 'EMPTY', message: 'No chunks were recorded.', sequences: [] }],
      reassemblable: false,
      totalDurationNs: 0,
      totalBytes: 0,
    };
  }

  const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence);

  const sessions = new Set(ordered.map((c) => c.sessionId));
  if (sessions.size > 1) {
    problems.push({
      code: 'MIXED_SESSION',
      message:
        `These chunks come from ${sessions.size} different sessions. Concatenating them would ` +
        `splice two matches into one.`,
      sequences: [],
    });
  }

  const seen = new Map<number, number>();
  for (const c of ordered) {
    seen.set(c.sequence, (seen.get(c.sequence) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([seq]) => seq);
  if (duplicates.length > 0) {
    problems.push({
      code: 'DUPLICATE_SEQUENCE',
      message:
        `Chunk ${duplicates.join(', ')} arrived more than once. A retry that was not ` +
        `de-duplicated would double a few minutes of the match.`,
      sequences: duplicates,
    });
  }

  // Index contiguity. Cheap, and catches the common case of a chunk that never
  // uploaded at all.
  const missing: number[] = [];
  for (let i = 0; i <= (ordered[ordered.length - 1] as ChunkManifest).sequence; i += 1) {
    if (!seen.has(i)) {
      missing.push(i);
    }
  }
  if (missing.length > 0) {
    problems.push({
      code: 'MISSING_SEQUENCE',
      message:
        `Chunk ${missing.join(', ')} never arrived. The phone still holds it while deletion is ` +
        `pending, so it can be re-sent rather than lost.`,
      sequences: missing,
    });
  }

  // TIME contiguity. The check a sequence number cannot do — a complete,
  // correctly numbered run of chunks that does not actually join up.
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1] as ChunkManifest;
    const cur = ordered[i] as ChunkManifest;
    if (prev.sequence === cur.sequence) {
      continue;
    }
    const delta = cur.startPtsNs - prev.endPtsNs;
    if (delta > MAX_JOIN_GAP_NS) {
      problems.push({
        code: 'TIME_GAP',
        message:
          `${(delta / 1e6).toFixed(0)} ms of the match is missing between chunk ${prev.sequence} ` +
          `and ${cur.sequence}. Both chunks arrived intact — the recording itself has a hole, ` +
          `and joining them would silently shorten the match.`,
        sequences: [prev.sequence, cur.sequence],
      });
    } else if (delta < -MAX_JOIN_GAP_NS) {
      problems.push({
        code: 'TIME_OVERLAP',
        message:
          `Chunk ${cur.sequence} starts ${(-delta / 1e6).toFixed(0)} ms before chunk ` +
          `${prev.sequence} ends. Joining them would replay a moment twice.`,
        sequences: [prev.sequence, cur.sequence],
      });
    }
  }

  const last = ordered[ordered.length - 1] as ChunkManifest;
  if (!last.final) {
    problems.push({
      code: 'NOT_FINALISED',
      message:
        'No chunk is marked as the last one, so the recording may still be going or may have ' +
        'been cut off. Reassembling now risks a match that ends early with nothing saying so.',
      sequences: [last.sequence],
    });
  }

  const first = ordered[0] as ChunkManifest;
  return {
    ordered,
    problems,
    reassemblable: problems.length === 0,
    totalDurationNs: last.endPtsNs - first.startPtsNs,
    totalBytes: ordered.reduce((n, c) => n + c.byteLength, 0),
  };
}

/**
 * The object key a chunk uploads to.
 *
 * Sequence is zero-padded so a plain lexicographic listing of the bucket is
 * already in order — which is what somebody debugging at 1 a.m. will do before
 * they find this file.
 */
export function chunkObjectKey(m: Pick<ChunkManifest, 'sessionId' | 'role' | 'sequence'>): string {
  return `sessions/${m.sessionId}/${m.role}/${String(m.sequence).padStart(5, '0')}.mp4`;
}

/** Chunks still to be re-sent, for the in-match health display. */
export function outstandingSequences(report: ChunkSetReport): number[] {
  return report.problems
    .filter((p) => p.code === 'MISSING_SEQUENCE')
    .flatMap((p) => p.sequences);
}
