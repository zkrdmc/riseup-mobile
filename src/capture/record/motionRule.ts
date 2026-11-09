/**
 * The motion rule itself, with no native imports, so it runs under node in
 * `npm run smoke`. See motion.ts for why it is sustained motion, not peaks.
 *
 * REVISED 9 Nov 2026 after the first casing test on a Pixel 8a: the first rule
 * demanded EVERY sample over the window be above the threshold, and a phone
 * carried by someone walking never qualified -- walking swings the user
 * acceleration up and down with each step, and one low sample reset it. The
 * rule is now on the window's RMS, which a gait keeps high and a single jolt
 * cannot lift for a whole window.
 */

export interface MotionSample {
  /** Epoch ms. */
  t: number;
  /** |user acceleration| in m/s^2, gravity removed. */
  magnitude: number;
}

/** First guesses; the dev build logs the RMS so a casing session can set them. */
export const MOVED_RMS = 0.8;
export const MOVED_FOR_MS = 2000;
/** Share of the window's samples that must be moving (above MOVED_RMS / 2). */
export const MOVING_SHARE = 0.6;
export const STILL_RMS = 0.25;
export const STILL_FOR_MS = 5000;

export function rms(samples: MotionSample[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return Math.sqrt(samples.reduce((s, x) => s + x.magnitude * x.magnitude, 0) / samples.length);
}

/**
 * 'moving' once the RMS over the last MOVED_FOR_MS is above MOVED_RMS; back to
 * 'still' once the RMS over the last STILL_FOR_MS is below STILL_RMS. Anything
 * in between keeps the current state (hysteresis), so a pause never flickers.
 * A window must be (nearly) full before it can decide anything.
 */
export function motionVerdict(
  samples: MotionSample[],
  now: number,
  current: 'still' | 'moving',
): 'still' | 'moving' {
  const window = (ms: number) => samples.filter((s) => now - s.t <= ms);
  const full = (w: MotionSample[], ms: number) => w.length >= 3 && now - w[0]!.t >= ms * 0.9;
  if (current === 'still') {
    const w = window(MOVED_FOR_MS);
    // RMS high AND most of the window moving: a ball hitting the pole lifts
    // the RMS for a moment from a few samples; a gait moves nearly all of them.
    const moving = w.filter((x) => x.magnitude > MOVED_RMS / 2).length;
    return full(w, MOVED_FOR_MS) && rms(w) > MOVED_RMS && moving >= w.length * MOVING_SHARE
      ? 'moving' : 'still';
  }
  const w = window(STILL_FOR_MS);
  return full(w, STILL_FOR_MS) && rms(w) < STILL_RMS ? 'still' : 'moving';
}
