/**
 * The prominent disclosure Google Play requires before asking for location.
 *
 * Play's Location Permissions policy requires an in-app disclosure that appears
 * BEFORE the system permission dialog, names the data, says what it is used
 * for, and gets an affirmative action from the user. A runtime permission
 * prompt on its own is not sufficient, and "we ask, the OS explains" is the
 * most common way an otherwise-fine app is rejected for this.
 *
 * Apple has no equivalent pre-prompt requirement — `NSLocationWhenInUse`-
 * `UsageDescription` in the Info.plist covers it — but showing the same sheet
 * on both platforms is better anyway: a coach asked for their location by a
 * football app deserves to know it is being used to recognise the ground and
 * nothing else.
 *
 * THE DISCLOSURE HAS TO BE TRUE, which is the part worth guarding. This app
 * takes ONE foreground fix, uses it to match the session to a saved venue, and
 * never tracks. If that ever stops being accurate, this text and the policy
 * declaration both have to change with it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'riseup.locationDisclosureAcceptedAt';

export const LOCATION_DISCLOSURE = {
  title: 'Use your location to recognise this ground?',
  /**
   * Names the data, the purpose, and the limits. Written to be read, because a
   * disclosure nobody reads has satisfied the letter of the policy and none of
   * its point.
   */
  body:
    'RiseUp takes a single GPS reading, now, to work out which ground you are at — so the pitch ' +
    'measurements you take here can be reused next time instead of being re-entered.\n\n' +
    'It is accurate to a few metres, which is far too rough to place a camera, and it is never ' +
    'used for that. Nothing runs in the background and your location is not tracked.\n\n' +
    'You can skip this and pick the ground from a list instead.',
  accept: 'Use my location',
  decline: 'Not now',
} as const;

/**
 * Has the user already agreed?
 *
 * Persisted so the sheet appears once rather than before every fix. The system
 * permission is separate and the OS owns it; this records only that the
 * disclosure was shown and accepted, which is the thing Play asks to be able
 * to demonstrate.
 */
export async function hasAcceptedLocationDisclosure(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY)) !== null;
  } catch {
    // Unreadable storage means show it again. Showing a disclosure twice is a
    // minor annoyance; skipping it is a policy violation.
    return false;
  }
}

export async function recordLocationDisclosureAccepted(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // The permission still applies for this session; the sheet just reappears
    // next time, which is the safe direction to fail in.
  }
}
