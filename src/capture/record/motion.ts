/**
 * "Pulled from the casing" by motion (Zak, 9 Nov 2026: motion is a good tell).
 *
 * A phone in a casing on a tripod is nearly still: wind and a ball hitting
 * the pole move it in short jolts. A phone taken out and carried moves
 * continuously. So the signal is SUSTAINED user acceleration (gravity
 * removed) over a window, not a peak: see motionRule.ts.
 *
 * THE THRESHOLDS ARE A FIRST GUESS (revised once, motionRule.ts), not yet
 * measured on a casing. Dev builds log the RMS so a casing session can set them.
 */

import { DeviceMotion } from 'expo-sensors';

import { motionVerdict, rms, type MotionSample } from './motionRule';

export interface MotionWatch {
  stop(): void;
}

export function startMotionWatch(handlers: {
  onMoved: () => void;
  onStill: () => void;
}): MotionWatch {
  const recent: MotionSample[] = [];
  let state: 'still' | 'moving' = 'still';
  let lastLog = 0;
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
    // Dev builds log the 2 s RMS once a second, so a session in a real casing
    // (wind, a ball on the pole, a carried phone) can set the thresholds.
    if (__DEV__ && now - lastLog >= 1000) {
      lastLog = now;
      console.log(`[motion] rms2s=${rms(recent.filter((x) => now - x.t <= 2000)).toFixed(2)} state=${state}`);
    }
    const verdict = motionVerdict(recent, now, state);
    if (verdict !== state) {
      state = verdict;
      (verdict === 'moving' ? handlers.onMoved : handlers.onStill)();
    }
  });
  return { stop: () => sub.remove() };
}
