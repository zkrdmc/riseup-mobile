/**
 * Pairing the second phone of a casing rig (Zak, 9 Nov 2026: "QR on phone A").
 *
 * Phone A starts the match and shows a code; phone B scans it with RiseUp and
 * joins the same capture session as camera B. The code carries only the
 * session id and the role: the server checks that the scanning phone belongs
 * to the same club, so a code photographed by a stranger opens nothing.
 *
 * A casing that pairs the two phones in hardware (and syncs them) is Ayman's
 * area; this is the software join until then, and `parseJoinCode` is the one
 * place that would change.
 *
 * No native imports: runs under node in `npm run smoke`.
 */

const SCHEME = 'riseup://join';
const VERSION = '1';

export interface JoinCode {
  sessionId: string;
  role: 'B';
}

export function joinCodeFor(sessionId: string): string {
  return `${SCHEME}?v=${VERSION}&session=${encodeURIComponent(sessionId)}&role=B`;
}

/** The scanned text, or null when it is not a RiseUp join code we understand. */
export function parseJoinCode(text: string): JoinCode | null {
  if (!text.startsWith(`${SCHEME}?`)) {
    return null;
  }
  const params = new Map<string, string>();
  for (const pair of text.slice(SCHEME.length + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k !== undefined && v !== undefined) {
      params.set(k, decodeURIComponent(v));
    }
  }
  const sessionId = params.get('session') ?? '';
  if (params.get('v') !== VERSION || params.get('role') !== 'B'
      || !/^ses_[0-9a-f]{32}$/.test(sessionId)) {
    return null;
  }
  return { sessionId, role: 'B' };
}

/**
 * Where phone B's recorder zero sits on the session clock: the time since the
 * session started, by wall clock. Approximate (phone clocks disagree by tens
 * of ms) -- the cameras are aligned precisely later (audio marker, or the
 * casing's hardware sync).
 */
export function joinOffsetNs(sessionStartedAt: string, now: number): number {
  const started = Date.parse(sessionStartedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) * 1e6 : 0;
}
