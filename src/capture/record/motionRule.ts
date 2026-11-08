/**
 * The motion rule itself, with no native imports, so it runs under node in
 * `npm run smoke`. See motion.ts for why it is sustained motion, not peaks.
 */

export interface MotionSample {
  /** Epoch ms. */
  t: number;
  /** |user acceleration| in m/s^2, gravity removed. */
  magnitude: number;
}

/** First guesses; set them from the first real casing session. */
export const MOVED_MS2 = 1.5;
export const MOVED_FOR_MS = 1500;
export const STILL_MS2 = 0.3;
export const STILL_FOR_MS = 5000;

/**
 * 'moving' once every sample in the last MOVED_FOR_MS is above MOVED_MS2;
 * back to 'still' once every sample in the last STILL_FOR_MS is below
 * STILL_MS2. Anything in between keeps the current state (hysteresis), so a
 * jolt never pauses and a pause never flickers.
 */
export function motionVerdict(
  samples: MotionSample[],
  now: number,
  current: 'still' | 'moving',
): 'still' | 'moving' {
  const window = (ms: number) => samples.filter((s) => now - s.t <= ms);
  const covers = (w: MotionSample[], ms: number) =>
    w.length >= 3 && now - w[0]!.t >= ms * 0.9;
  if (current === 'still') {
    const w = window(MOVED_FOR_MS);
    return covers(w, MOVED_FOR_MS) && w.every((s) => s.magnitude > MOVED_MS2) ? 'moving' : 'still';
  }
  const w = window(STILL_FOR_MS);
  return covers(w, STILL_FOR_MS) && w.every((s) => s.magnitude < STILL_MS2) ? 'still' : 'moving';
}
