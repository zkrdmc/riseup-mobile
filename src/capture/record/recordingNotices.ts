/**
 * What the recording is doing, as notifications on this phone (Zak, 9 Nov
 * 2026: "make it a notification as well for when we stopped the recordings").
 *
 * Local, not push: this phone knows the moment it pauses, resumes or stops,
 * and a notification is how that reaches a coach whose phone is in a pocket
 * or on a tripod with the screen off. Telling the OTHER phone of the pair, or
 * the club's staff, is the server's job (push), not this file's.
 *
 * Its own Android channel, so a club can silence match chatter without
 * silencing "analysis complete". Never throws: a refused permission or an OS
 * that drops the notification must not touch the recording.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PauseReason } from '../../../modules/riseup-recorder';

const CHANNEL = 'recording';
let ready: Promise<boolean> | null = null;

function prepare(): Promise<boolean> {
  if (ready === null) {
    ready = (async () => {
      try {
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync(CHANNEL, {
            name: 'Match recording',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }
        const existing = await Notifications.getPermissionsAsync();
        if (existing.granted) {
          return true;
        }
        return existing.canAskAgain ? (await Notifications.requestPermissionsAsync()).granted : false;
      } catch {
        return false;
      }
    })();
  }
  return ready;
}

/** Ask for permission up front (at the start of a recording, not mid-match). */
export function prepareRecordingNotices(): void {
  void prepare();
}

async function notify(title: string, body: string, key: string): Promise<void> {
  try {
    if (!(await prepare())) {
      return;
    }
    await Notifications.scheduleNotificationAsync({
      // One per key: a second "paused" replaces the first rather than piling up.
      identifier: `recording:${key}`,
      content: { title, body, data: { category: 'recording', key } },
      trigger: Platform.OS === 'android' ? ({ channelId: CHANNEL } as never) : null,
    });
  } catch {
    // Never let a notification touch the recording.
  }
}

const WHY: Record<PauseReason, string> = {
  background: 'RiseUp left the screen',
  motion: 'the phone is moving (out of its casing?)',
  camera_lost: 'another app took the camera',
  operator: 'paused by hand',
};

export const recordingNotices = {
  paused: (camera: string, reason: PauseReason) =>
    notify(`Camera ${camera} paused`,
           `Recording paused: ${WHY[reason]}. Put the phone back in its casing to carry on; the match stays open.`,
           'state'),
  resumed: (camera: string) =>
    notify(`Camera ${camera} recording`, 'Recording again. The paused minutes are marked as missing.', 'state'),
  stopped: (camera: string) =>
    notify(`Camera ${camera} stopped`, 'Recording stopped. The last minutes are being sent.', 'state'),
  /** `queuedBehind`: the server's place in the club's queue (null = started). */
  sent: (queuedBehind: number | null = null) =>
    notify('Match sent',
           !queuedBehind
             ? 'Every minute is in. The analysis has started.'
             : queuedBehind === 1
               ? 'Every minute is in. It starts when the match being analysed now finishes.'
               : `Every minute is in. It is number ${queuedBehind} in line behind the match being analysed now.`,
           'state'),
  behind: (minutes: number) =>
    notify('Upload falling behind',
           `${minutes} min of video still to send. Quality steps down to keep up; it keeps sending in the background.`,
           'behind'),
};
