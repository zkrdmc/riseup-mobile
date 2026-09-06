/**
 * Push registration and delivery (§6).
 *
 * THE BACKEND ENDPOINT DOES NOT EXIST YET. `POST /me/devices` is listed in PRD
 * §8.2 and is not built, so registration will 404 against today's API. That is
 * handled as a first-class state rather than an error: the token is obtained,
 * cached locally, and re-sent on every launch until the server accepts it. The
 * day the endpoint ships, every installed app registers itself on next open
 * with no release and no user action.
 *
 * The consequence to be honest about: until then, no notification is ever
 * delivered. The inbox exists and is wired, and it will be empty. The settings
 * screen says so in words rather than showing a preferences list that does
 * nothing.
 *
 * WHY EXPO'S PUSH SERVICE. It is one token format across APNs and FCM, and it
 * lets the backend hold one credential instead of two certificate chains with
 * different rotation schedules. The alternative — native device tokens — is
 * the right long-term answer for a product that will eventually want APNs
 * priority and collapse ids, and it is not the right thing to build first.
 */

import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type { ApiClient } from '../api/client';
import { paths } from '../api/endpoints';
import { inbox } from './inbox';
import type { InboxItem } from './types';

const TOKEN_KEY = 'riseup.pushToken';

export type PushState =
  | { status: 'unsupported'; reason: string }
  | { status: 'denied' }
  | { status: 'registered'; token: string }
  /** We have a token; the server has not accepted it. Usually the missing endpoint. */
  | { status: 'pending'; token: string; reason: string };

/**
 * How a notification behaves while the app is open.
 *
 * Banners are shown in-foreground deliberately. The alternative — silently
 * routing them to the inbox — means a coach staring at the match list does not
 * see "analysis complete" for the match they are waiting on.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(api: ApiClient): Promise<PushState> {
  // A simulator has no push token. Returning a clear reason keeps this out of
  // the "permissions denied" bucket, which is what a developer would otherwise
  // spend twenty minutes checking.
  if (!Device.isDevice) {
    return { status: 'unsupported', reason: 'Push notifications need a physical device.' };
  }

  if (Platform.OS === 'android') {
    // Android 8+ requires a channel before anything can be delivered. Created
    // before permission is requested, because a permission granted with no
    // channel produces notifications that arrive and are never shown.
    await Notifications.setNotificationChannelAsync('default', {
      name: 'RiseUp',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#35c98d',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;

  if (!granted && existing.canAskAgain) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }

  if (!granted) {
    return { status: 'denied' };
  }

  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync();
    token = result.data;
  } catch (error) {
    return {
      status: 'unsupported',
      reason: 'Could not get a push token from the operating system.',
    };
  }

  await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => {
    // Losing the cached token only means re-fetching it next launch.
  });

  try {
    await api.post(paths.devices, {
      token,
      platform: Platform.OS,
      app_version: '0.1.0',
    });
    return { status: 'registered', token };
  } catch {
    // Expected today: the endpoint is not built. The token is kept and this
    // runs again on the next launch, so the endpoint shipping is enough.
    return {
      status: 'pending',
      token,
      reason: 'The server does not accept device registrations yet, so nothing will be delivered.',
    };
  }
}

/**
 * Listen for arrivals and taps.
 *
 * Returns an unsubscribe. Both listeners write to the inbox: §6's requirement
 * that nothing is only ever a notification means the record is made on
 * arrival, not on tap.
 */
export function listen(onOpen: (item: InboxItem) => void): () => void {
  const received = Notifications.addNotificationReceivedListener((notification) => {
    inbox.add(toInboxItem(notification));
  });

  const responded = Notifications.addNotificationResponseReceivedListener((response) => {
    const item = toInboxItem(response.notification);
    inbox.add(item);
    inbox.markRead(item.id);
    onOpen(item);
  });

  return () => {
    received.remove();
    responded.remove();
  };
}

/**
 * A notification the app was launched by.
 *
 * A cold start from a tap does not fire the response listener — the app did
 * not exist when the tap happened. Without this call, tapping "analysis
 * complete" on a killed app opens the match list and the coach has to find the
 * match themselves, which is exactly the "notification without a resolvable
 * action" §6 forbids.
 */
export async function consumeLaunchNotification(): Promise<InboxItem | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (response === null) {
    return null;
  }
  const item = toInboxItem(response.notification);
  inbox.add(item);
  inbox.markRead(item.id);
  return item;
}

function toInboxItem(notification: Notifications.Notification): InboxItem {
  const content = notification.request.content;
  const data = (content.data ?? {}) as Record<string, unknown>;

  return {
    id: notification.request.identifier,
    category: typeof data.category === 'string' ? data.category : 'unknown',
    title: content.title ?? 'RiseUp',
    body: content.body ?? '',
    // `notification.date` is delivery time in ms. The server's own timestamp,
    // when it sends one, is more accurate for something queued while offline.
    at:
      typeof data.sent_at === 'string'
        ? data.sent_at
        : new Date(notification.date ?? Date.now()).toISOString(),
    read: false,
    data,
  };
}

export async function clearBadge(): Promise<void> {
  await Notifications.setBadgeCountAsync(0).catch(() => {
    // Not supported everywhere, and never worth surfacing.
  });
}
