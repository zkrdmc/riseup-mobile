/**
 * "Pulled from the casing" by motion (Zak, 9 Nov 2026: motion is a good tell).
 *
 * A phone in a casing on a tripod is nearly still: wind and a ball hitting
 * the pole move it in short jolts. A phone taken out and carried moves
 * continuously. So the signal is SUSTAINED user acceleration (gravity
 * removed), not a peak: above MOVED_MS2 for MOVED_FOR_MS pauses, below
 * STILL_MS2 for STILL_FOR_MS resumes a motion pause.
 *
 * THE THRESHOLDS ARE A FIRST GUESS, not measured on a casing. They are
 * constants here so the first real casing session can set them.
 */

import { DeviceMotion } from 'expo-sensors';

import { motionVerdict, type MotionSample } from './motionRule';

export interface MotionWatch {
  stop(): void;
}

export function startMotionWatch(handlers: {
  onMoved: () => void;
  onStill: () => void;
}): MotionWatch {
  const recent: MotionSample[] = [];
  let state: 'still' | 'moving' = 'still';
  DeviceMotion.setUpdateInterval(100);
  const sub = DeviceMotion.addListener((m) => {
    const a = m.acceleration;
    if (a === null || a === undefined) {
      return;
    }
    const now = Date.now();
    recent.push({ t: now, magnitude: Math.hypot(a.x, a.y, a.z) });
    while (recent.length > 0 && now - recent[0]!.t > 6000) {
      recent.shift();
    }
    const verdict = motionVerdict(recent, now, state);
    if (verdict !== state) {
      state = verdict;
      (verdict === 'moving' ? handlers.onMoved : handlers.onStill)();
    }
  });
  return { stop: () => sub.remove() };
}
