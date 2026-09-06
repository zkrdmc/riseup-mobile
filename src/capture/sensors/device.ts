/**
 * What the phone can tell us about itself without a custom native module.
 *
 * Orientation and a venue fix, both working today through expo-sensors and
 * expo-location. The lens and sensor metadata needs native code and lives
 * behind `src/capture/native/CameraMetadata.ts`; this file is deliberately the
 * part that does not, so the survey flow is testable on a real device before
 * any of the camera work exists.
 *
 * Both functions work fully offline (PRD §3). Location uses the GNSS receiver,
 * not a network lookup, which matters at a municipal ground with no signal —
 * and is also why the accuracy is what it is.
 */

import { Accelerometer } from 'expo-sensors';
import * as Location from 'expo-location';

import { orientationFromGravity, type AccelSample } from '../survey/derive';
import type { OrientationSample, VenueFix } from '../survey/schema';

/** 50 Hz. Fast enough to see whether the tripod is settling, cheap enough to ignore. */
const SAMPLE_INTERVAL_MS = 20;

/** Long enough to average out a hand leaving the phone, short enough to not annoy. */
export const DEFAULT_ORIENTATION_WINDOW_MS = 2000;

/**
 * Measure tilt and roll from a burst of accelerometer samples.
 *
 * The phone must be still and already mounted — this is measuring the rig, not
 * the operator's hand. `stable` on the returned sample says whether it managed
 * to be, and the survey screen re-takes rather than recording a reading taken
 * mid-adjustment.
 *
 * Returns null when the device has no accelerometer, which is a simulator.
 */
export async function captureOrientation(
  windowMs: number = DEFAULT_ORIENTATION_WINDOW_MS,
): Promise<OrientationSample | null> {
  const available = await Accelerometer.isAvailableAsync();
  if (!available) {
    return null;
  }

  Accelerometer.setUpdateInterval(SAMPLE_INTERVAL_MS);

  const samples: AccelSample[] = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const subscription = Accelerometer.addListener((reading) => {
    samples.push({ x: reading.x, y: reading.y, z: reading.z });
  });

  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, windowMs);
    });
  } finally {
    // In a finally, because leaving a 50 Hz listener attached after the screen
    // is gone is a battery drain nobody would ever attribute to this function.
    subscription.remove();
  }

  return orientationFromGravity(samples, startedAt, Date.now() - t0);
}

/**
 * A GNSS fix, for identifying the venue and nothing else.
 *
 * PHONE GPS IS 3–5 m UNDER OPEN SKY and worse beside a stand. The camera
 * positions in this survey are measured to centimetres with a tape, so a fix
 * is one to two orders of magnitude too coarse to contribute to them — using
 * it would replace a good measurement with a bad one.
 *
 * What it is good for is recognising the ground: matching this session to a
 * venue already surveyed, so the pitch dimensions and marking condition do not
 * have to be re-entered every match. `accuracyM` travels with it so no later
 * consumer can mistake it for a position.
 *
 * Returns null if permission is refused, which is not an error — the operator
 * picks the venue from a list instead.
 */
export async function captureVenueFix(): Promise<VenueFix | null> {
  const { granted } = await Location.requestForegroundPermissionsAsync();
  if (!granted) {
    return null;
  }

  try {
    const position = await Location.getCurrentPositionAsync({
      // Highest available: this is a one-shot fix taken while standing still,
      // so there is no battery argument for a coarse one, and a better fix
      // makes venue matching more reliable.
      accuracy: Location.Accuracy.Highest,
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      // Null accuracy is reported as a large number rather than zero. Zero
      // would read as a perfect fix, which is the opposite of what it means.
      accuracyM: position.coords.accuracy ?? 9999,
      capturedAt: new Date(position.timestamp).toISOString(),
    };
  } catch {
    // No fix under a stand roof, or the receiver timed out. Not an error worth
    // interrupting a setup for.
    return null;
  }
}

/**
 * Metres between two fixes, for matching a session to a known venue.
 *
 * Equirectangular rather than haversine: over the hundreds of metres this is
 * ever asked about, the two agree far inside the GPS error, and this one is
 * obvious enough to check by eye.
 */
export function distanceBetweenFixesM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * toRad * Math.cos(((a.latitude + b.latitude) / 2) * toRad);
  const y = (b.latitude - a.latitude) * toRad;
  return Math.hypot(x, y) * R;
}

/**
 * Is this fix plausibly the same ground as that one?
 *
 * Generous on purpose. A pitch is ~110 m long, two fixes can each be 5 m out,
 * and the operator may stand anywhere along the touchline — so the honest
 * question is "same ground", not "same spot". A wrong match costs a re-entered
 * pitch dimension; a missed match costs a re-survey.
 */
export function isSameVenue(a: VenueFix, b: VenueFix, radiusM = 200): boolean {
  return distanceBetweenFixesM(a, b) <= radiusM;
}
