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

/**
 * How late the first chunk may begin before the recording is judged to have
 * started with the match already under way.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE HOLE THIS CLOSES, WHICH THE CONTINUITY CHECK CANNOT SEE
 * ══════════════════════════════════════════════════════════════════════════
 * `verifyChunkSet` proves the chunks join up TO EACH OTHER. It says nothing
 * about whether they join up to the START OF THE MATCH. A recording begun
 * twenty minutes after kick-off is perfectly contiguous, correctly numbered
 * from zero, hashes cleanly, and is missing the first goal — and every check
 * above this one passes it.
 *
 * The session clock is what exposes it. It starts when the session is opened,
 * which is the moment the operator arms the rig and the sync marker is
 * emitted; a first chunk whose `startPtsNs` is far from zero means recording
 * began well after that, so the opening is not in the file.
 *
 * Five seconds of tolerance: arming a rig and starting the recorders is a
 * couple of taps and a camera warm-up, and a second or two either way is
 * normal. Twenty minutes is not.
 */
const MAX_START_DELAY_NS = 5_000_000_000; // 5 s

export interface ChunkSetProblem {
  code:
    | 'EMPTY'
    | 'DUPLICATE_SEQUENCE'
    | 'MISSING_SEQUENCE'
    | 'TIME_GAP'
    | 'TIME_OVERLAP'
    | 'NOT_FINALISED'
    | 'STARTED_IN_PLAY'
    | 'MIXED_SESSION';
  message: string;
  /** The sequence numbers involved, for a support answer that names the chunk. */
  sequences: number[];
}

export interface ChunkSetReport {
  ordered: ChunkManifest[];
  /** Blocking. Any one of these means the set must not be concatenated. */
  problems: ChunkSetProblem[];
  /**
   * Findings that do NOT block reassembly, and must travel with the match.
   *
   * A recording that starts late is still worth analysing — refusing to process
   * a club's only footage because it began after kick-off is the wrong trade.
   * What must not happen is analysing it while believing it covers the whole
   * match, and then reporting possession for a period the file does not
   * contain. Missing, not zero.
   *
   * So the finding is carried rather than acted on, and it is the reader's
   * screen that has to show it — see `docs/CHUNKED-UPLOAD-API.md`.
   */
  caveats: ChunkSetProblem[];
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
  const caveats: ChunkSetProblem[] = [];

  if (chunks.length === 0) {
    return {
      ordered: [],
      problems: [{ code: 'EMPTY', message: 'No chunks were recorded.', sequences: [] }],
      caveats: [],
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

  // Did this recording start before the match, or during it?
  const first = ordered[0] as ChunkManifest;
  if (first.sequence === 0 && first.startPtsNs > MAX_START_DELAY_NS) {
    const lateSeconds = first.startPtsNs / 1e9;
    caveats.push({
      code: 'STARTED_IN_PLAY',
      message:
        `Recording began ${formatDelay(lateSeconds)} after the session was armed, so the ` +
        `opening of the match is not in this footage. The chunks themselves are continuous — ` +
        `what is missing is everything before the first one.`,
      sequences: [first.sequence],
    });
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

  return {
    ordered,
    problems,
    caveats,
    // Caveats deliberately do not count. They are carried, not enforced.
    reassemblable: problems.length === 0,
    totalDurationNs: last.endPtsNs - first.startPtsNs,
    totalBytes: ordered.reduce((n, c) => n + c.byteLength, 0),
  };
}

/** Minutes and seconds, because "1247 s late" is not a sentence anyone reads. */
function formatDelay(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * The object key a chunk uploads to.
 *
 * Sequence is zero-padded so a plain lexicographic listing of the bucket is
 * already in order — which is what somebody debugging at 1 a.m. will do before
 * they find this file.
 *
 * `prefix` IS THE TENANT AND THE SERVER SUPPLIES IT. `POST /api/v1/capture/
 * sessions` returns `objectKeyPrefix` (today `clubs/<club id>/`), and it is
 * passed through here rather than built in the app for two reasons: the app
 * does not otherwise know the club's id, and how tenancy is laid out in the
 * bucket is a backend decision that should stay one — a per-club lifecycle
 * rule and a listing that cannot span two clubs both depend on that prefix.
 *
 * Defaults to '' so an existing caller keeps its old behaviour, but note that
 * a key computed without the prefix WILL NOT MATCH the one the server signs.
 * The authoritative key is the `objectKey` in the register-chunk response;
 * this function is for computing it ahead of time and for logging.
 */
export function chunkObjectKey(
  m: Pick<ChunkManifest, 'sessionId' | 'role' | 'sequence'>,
  prefix = '',
): string {
  return `${prefix}sessions/${m.sessionId}/${m.role}/${String(m.sequence).padStart(5, '0')}.mp4`;
}

/** Chunks still to be re-sent, for the in-match health display. */
export function outstandingSequences(report: ChunkSetReport): number[] {
  return report.problems
    .filter((p) => p.code === 'MISSING_SEQUENCE')
    .flatMap((p) => p.sequences);
}

/* ══════════════════════════════════════════════════════════════════════════
   THE SAME QUESTION FOR AN UPLOAD, WHICH HAS NO CHUNKS TO REASON ABOUT
   ══════════════════════════════════════════════════════════════════════════
   A file filmed on the club's own camcorder arrives as one object. There is no
   session clock, no sequence, nothing internal that could reveal it starts
   twenty minutes into the match — the file is simply shorter than expected and
   begins with play already under way.

   What IS available is wall-clock: when the fixture kicked off, and when the
   recording started. Both are approximate — a camera clock that was never set
   is worthless, which is why `recordingStartedAt` is allowed to be null and
   the answer is then honestly "unknown" rather than a guess.

   This is a WARNING, never a refusal. Footage that starts late is still worth
   analysing; what must not happen is analysing it while believing it covers
   the whole match, and then reporting "possession in the first fifteen
   minutes" from a file that does not contain them. */

export type CoverageVerdict =
  /** Starts at or before kick-off. */
  | 'covers_opening'
  /** Starts after kick-off by more than the tolerance. */
  | 'starts_in_play'
  /** Not enough trustworthy timing to say. */
  | 'unknown';

export interface CoverageCheck {
  verdict: CoverageVerdict;
  /** Seconds after kick-off that the recording begins. Null when unknown. */
  lateBySeconds: number | null;
  /** For the operator, naming what is missing rather than the arithmetic. */
  message: string;
}

/**
 * How late a recording may start before it is worth saying so.
 *
 * Two minutes. A camera armed at the whistle rather than before it is normal
 * and costs nothing; a clock that disagrees by a minute or two is also normal.
 * Beyond that, something is genuinely absent from the file.
 */
const LATE_START_TOLERANCE_S = 120;

/**
 * Does this recording contain the start of the match?
 *
 * `durationSeconds` is used only to sharpen the message — a file that starts
 * late AND ends early is a different conversation from one that merely starts
 * late — and never to change the verdict, because a short file may simply be
 * a first half.
 */
export function checkRecordingCoverage(input: {
  kickoffAt: string | null;
  recordingStartedAt: string | null;
  durationSeconds?: number | null;
  /**
   * Whether the camera's clock is believed. A camcorder that has never been
   * set can be wrong by hours, and a confident "starts 4 hours into the match"
   * is worse than saying nothing.
   */
  clockTrusted?: boolean;
}): CoverageCheck {
  const { kickoffAt, recordingStartedAt } = input;
  const trusted = input.clockTrusted ?? true;

  if (kickoffAt === null || recordingStartedAt === null || !trusted) {
    return {
      verdict: 'unknown',
      lateBySeconds: null,
      message:
        kickoffAt === null
          ? 'No kick-off time recorded for this match, so whether the footage covers the start ' +
            'cannot be checked.'
          : !trusted
            ? 'This camera\u2019s clock is not trusted, so whether the footage covers the start ' +
              'cannot be checked from timestamps.'
            : 'This recording carries no start time, so whether it covers the opening cannot be ' +
              'checked.',
    };
  }

  const kickoff = Date.parse(kickoffAt);
  const started = Date.parse(recordingStartedAt);
  if (!Number.isFinite(kickoff) || !Number.isFinite(started)) {
    return {
      verdict: 'unknown',
      lateBySeconds: null,
      message: 'One of the timestamps could not be read, so coverage cannot be checked.',
    };
  }

  const lateBySeconds = (started - kickoff) / 1000;

  if (lateBySeconds <= LATE_START_TOLERANCE_S) {
    return {
      verdict: 'covers_opening',
      lateBySeconds,
      message: 'This recording starts at or before kick-off.',
    };
  }

  const missing = formatDelay(lateBySeconds);
  const duration = input.durationSeconds ?? null;
  const tail =
    duration !== null && duration < 45 * 60
      ? ` It is also only ${formatDelay(duration)} long, so it may be part of a half rather ` +
        `than a whole one.`
      : '';

  return {
    verdict: 'starts_in_play',
    lateBySeconds,
    message:
      `This recording starts ${missing} after kick-off, so the opening of the match is not in ` +
      `it. Anything reported about that period would be missing, not zero.${tail}`,
  };
}
