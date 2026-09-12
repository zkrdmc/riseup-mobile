/**
 * Applying the fixture reminder plan to the device.
 *
 * The decisions live in `fixtureSchedule.ts` and are pure. This is the half
 * that talks to expo-notifications and the API, split for the same reason
 * `src/capture/devices/merge.ts` is split from `sync.ts`: the smoke suite
 * compiles the pure half and cannot compile this one.
 *
 * EVERYTHING HERE IS BEST-EFFORT AND SAYS SO. A reminder that could not be
 * scheduled must not break launch, so every entry point resolves to a result
 * rather than throwing. The caller logs it; nothing retries in a loop.
 */

import type { ApiClient } from '../api/client';
import { paths } from '../api/endpoints';
import { optionalNative, rebuildHint } from '../lib/optionalNative';
import {
  planReminders,
  reconcile,
  type Fixture,
  type PlannedReminder,
} from './fixtureSchedule';

/**
 * NOT A STATIC IMPORT. expo-router imports every route, so a native module
 * that throws at module scope takes the whole app down — the lesson from
 * `ExpoLocalization` that `optionalNative` exists to hold. A build without
 * the notifications module must still open.
 */
const Notifications = optionalNative(
  'expo-notifications',
  () => require('expo-notifications') as typeof import('expo-notifications'),
);

export interface SyncResult {
  status: 'ok' | 'unsupported' | 'failed';
  scheduled: number;
  cancelled: number;
  /** Present when nothing could be done, in words worth logging. */
  reason?: string;
}

/** Where we stash the key on the notification, to recognise ours later. */
const KEY_FIELD = 'reminderKey';

/**
 * Read this club's fixtures.
 *
 * The team index is the club's own document and already holds fixtures with
 * `date`, `kickoffTime`, `opponent` and `home` — `core/access_windows.py`
 * reads the same shape server-side. There is no fixtures endpoint to add.
 */
async function readFixtures(api: ApiClient): Promise<Fixture[]> {
  const row = await api.get<{ document?: { fixtures?: unknown } }>(paths.teamIndex);
  const raw = row.document?.fixtures;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((f): f is Fixture => typeof f === 'object' && f !== null);
}

/**
 * Bring the device's pending reminders in line with the club's fixtures.
 *
 * Called on launch, after push registration. Launch is the right moment and
 * the only one needed: the horizon in `fixtureSchedule` is a fortnight, so the
 * window rolls forward on any launch inside two weeks, and a phone that has
 * not been opened in a fortnight was not going to film on Saturday either.
 */
export async function syncFixtureReminders(api: ApiClient): Promise<SyncResult> {
  const notifications = Notifications;
  if (notifications === null) {
    return {
      status: 'unsupported',
      scheduled: 0,
      cancelled: 0,
      reason: rebuildHint('fixture reminders'),
    };
  }

  let fixtures: Fixture[];
  try {
    fixtures = await readFixtures(api);
  } catch (error) {
    // Offline, or the club has no team index yet. Existing reminders are left
    // alone on purpose: a failed read is not evidence that a fixture was
    // cancelled, and cancelling on no information is how a club arrives at a
    // ground with no reminder having fired.
    return {
      status: 'failed',
      scheduled: 0,
      cancelled: 0,
      reason: error instanceof Error ? error.message : 'could not read fixtures',
    };
  }

  const planned = planReminders(fixtures, new Date());

  // `id` travels with each one: `reconcile` compares on key and fireAt, but
  // cancelling needs the OS identifier, and looking it up again would mean a
  // second read of the pending list.
  let pending: { key: string; fireAt: Date; id: string }[];
  try {
    pending = (await notifications.getAllScheduledNotificationsAsync())
      .map((request) => {
        const data = (request.content.data ?? {}) as Record<string, unknown>;
        const key = typeof data[KEY_FIELD] === 'string'
          ? (data[KEY_FIELD] as string)
          : null;
        const trigger = request.trigger as { date?: number | string } | null;
        const at = trigger?.date;
        if (key === null || at === undefined) {
          return null;
        }
        return { key, fireAt: new Date(at), id: request.identifier };
      })
      .filter((x): x is { key: string; fireAt: Date; id: string } => x !== null);
  } catch (error) {
    return {
      status: 'failed',
      scheduled: 0,
      cancelled: 0,
      reason: error instanceof Error ? error.message : 'could not read pending',
    };
  }

  const { cancel, add } = reconcile(planned, pending);

  let cancelled = 0;
  for (const key of cancel) {
    const match = pending.find((p) => p.key === key);
    if (match === undefined) {
      continue;
    }
    try {
      await notifications.cancelScheduledNotificationAsync(match.id);
      cancelled += 1;
    } catch {
      // A reminder we failed to cancel fires at the old time. Worth
      // continuing: the rest of the reconcile is still an improvement.
    }
  }

  let scheduled = 0;
  for (const reminder of add) {
    try {
      await schedule(notifications, reminder);
      scheduled += 1;
    } catch {
      // Permission revoked mid-loop, or the OS cap reached. Neither is worth
      // failing launch over.
    }
  }

  return { status: 'ok', scheduled, cancelled };
}

async function schedule(
  notifications: typeof import('expo-notifications'),
  reminder: PlannedReminder,
): Promise<void> {
  await notifications.scheduleNotificationAsync({
    content: {
      title: reminder.title,
      body: reminder.body,
      // The category is what the app routes on, and `reminderKey` is how this
      // module recognises its own pending notifications on the next launch.
      data: { ...reminder.data, [KEY_FIELD]: reminder.key },
      sound: true,
    },
    trigger: {
      type: 'date',
      date: reminder.fireAt,
    } as never,
  });
}

/**
 * Drop every fixture reminder this module scheduled.
 *
 * Called on sign-out. Leaving them would fire a previous club's fixtures at
 * whoever holds a shared handset next, which is both confusing and a small
 * leak of that club's schedule.
 *
 * Only OURS: it reads the key field rather than calling
 * `cancelAllScheduledNotificationsAsync`, so anything another part of the app
 * schedules later is not collateral.
 */
export async function clearFixtureReminders(): Promise<number> {
  const notifications = Notifications;
  if (notifications === null) {
    return 0;
  }
  try {
    const pending = await notifications.getAllScheduledNotificationsAsync();
    let cleared = 0;
    for (const request of pending) {
      const data = (request.content.data ?? {}) as Record<string, unknown>;
      if (typeof data[KEY_FIELD] !== 'string') {
        continue;
      }
      await notifications.cancelScheduledNotificationAsync(request.identifier);
      cleared += 1;
    }
    return cleared;
  } catch {
    return 0;
  }
}
