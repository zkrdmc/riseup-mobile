/**
 * Inbox (§6).
 *
 * The matching in-app record for every push, so nothing is only ever a
 * notification. Tapping a row goes where the notification would have gone.
 *
 * The empty state says which of two things is true — push is not delivering
 * yet, or push works and nothing has happened — because those need different
 * responses from the reader and an undifferentiated "No notifications" tells
 * them neither.
 */

import { useRouter } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useApi } from '../../../src/api/provider';
import { inbox } from '../../../src/notifications/inbox';
import { clearBadge, listen, registerForPush, type PushState } from '../../../src/notifications/push';
import { consumeLaunchNotification } from '../../../src/notifications/push';
import { routeFor, type InboxItem } from '../../../src/notifications/types';
import { when } from '../../../src/lib/format';
import { useState } from 'react';
import { line, minTouchTarget, signal, space, surface } from '../../../src/theme/tokens';
import { Row, Screen, Spacer } from '../../../src/ui/Layout';
import { EmptyState } from '../../../src/ui/State';
import { Body, BodyStrong, Display, Label } from '../../../src/ui/Text';

export default function InboxScreen() {
  const api = useApi();
  const router = useRouter();
  const items = useSyncExternalStore(inbox.subscribe, inbox.getSnapshot);
  const [push, setPush] = useState<PushState | null>(null);

  useEffect(() => {
    void inbox.hydrate();
    void clearBadge();
    void registerForPush(api).then(setPush);

    const open = (item: InboxItem) => {
      const route = routeFor(item.category, item.data);
      if (route !== null) {
        router.push(route as never);
      }
    };

    // A cold start from a tap does not fire the response listener, so the
    // launch notification is consumed explicitly.
    void consumeLaunchNotification().then((item) => {
      if (item !== null) {
        open(item);
      }
    });

    return listen(open);
  }, [api, router]);

  return (
    <Screen scroll>
      <Spacer size={space[4]} />
      <Row>
        <Display>Inbox</Display>
        <View style={styles.flex} />
        {items.some((i) => !i.read) ? (
          <Pressable
            onPress={() => inbox.markAllRead()}
            accessibilityRole="button"
            accessibilityLabel="Mark all as read"
            hitSlop={space[3]}
          >
            <Label tone={3}>Mark all read</Label>
          </Pressable>
        ) : null}
      </Row>

      {push !== null && push.status !== 'registered' ? (
        <>
          <Spacer size={space[4]} />
          <Body tone={3} size={13}>
            {pushExplanation(push)}
          </Body>
        </>
      ) : null}

      <Spacer size={space[5]} />

      {items.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          body={
            push !== null && push.status === 'registered'
              ? 'You will hear from us when a match finishes processing.'
              : 'Notifications are not being delivered to this device yet, so this list will stay empty.'
          }
        />
      ) : (
        items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            onPress={() => {
              inbox.markRead(item.id);
              const route = routeFor(item.category, item.data);
              if (route !== null) {
                router.push(route as never);
              }
            }}
          />
        ))
      )}
      <Spacer size={space[7]} />
    </Screen>
  );
}

function pushExplanation(state: PushState): string {
  switch (state.status) {
    case 'denied':
      return 'Notifications are turned off for RiseUp. Turn them on in your phone settings to hear when a match is ready.';
    case 'unsupported':
      return state.reason;
    case 'pending':
      return state.reason;
    case 'registered':
      return '';
  }
}

function InboxRow({ item, onPress }: { item: InboxItem; onPress: () => void }) {
  const actionable = routeFor(item.category, item.data) !== null;

  return (
    <Pressable
      onPress={onPress}
      disabled={!actionable}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${item.body}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      {/* Unread is a 5px bar, not a bold row. Bolding the whole row changes
          its height and makes the list jump as things are read. */}
      <View style={[styles.unread, item.read ? null : styles.unreadActive]} />
      <View style={styles.rowMain}>
        <BodyStrong numberOfLines={1}>{item.title}</BodyStrong>
        {item.body.length === 0 ? null : (
          <>
            <Spacer size={space[1]} />
            <Body tone={3} size={13} numberOfLines={3}>
              {item.body}
            </Body>
          </>
        )}
        <Spacer size={space[2]} />
        <Label>{when(item.at)}</Label>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    gap: space[3],
    minHeight: minTouchTarget,
    paddingVertical: space[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: line.rule,
  },
  rowPressed: {
    backgroundColor: surface.bg1,
  },
  unread: {
    width: 3,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  unreadActive: {
    backgroundColor: signal.base,
  },
  rowMain: {
    flex: 1,
  },
});
