/**
 * Match list — the Analyst's home (§2, §7).
 *
 * Newest first, processing state inline. Two sources merged (see
 * `src/lib/matchFeed.ts`), because a coach who uploaded ten seconds ago must
 * see that upload here and not an empty screen.
 *
 * Polling is conditional on something actually being in flight. A phone
 * polling a finished list every ten seconds on cellular is spending a coach's
 * data to learn nothing.
 */

import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { useJobs, useMatches } from '../../../src/api/queries';
import { ApiError } from '../../../src/api/errors';
import { buildFeed, type FeedItem } from '../../../src/lib/matchFeed';
import { count, duration, when } from '../../../src/lib/format';
import { ink, line, minTouchTarget, space, surface } from '../../../src/theme/tokens';
import { Row, Screen, Spacer } from '../../../src/ui/Layout';
import { Pill } from '../../../src/ui/Status';
import { EmptyState, ErrorState, LoadingState } from '../../../src/ui/State';
import { Body, BodyStrong, Display, Label, Metric } from '../../../src/ui/Text';

export default function MatchListScreen() {
  const router = useRouter();

  const matches = useMatches();
  // Polls itself while anything is still processing, and stops once nothing
  // is. See `useJobs`.
  const jobs = useJobs();

  const feed = useMemo(
    () => buildFeed(matches.data ?? [], jobs.data ?? []),
    [matches.data, jobs.data],
  );

  const onRefresh = useCallback(() => {
    void matches.refetch();
    void jobs.refetch();
  }, [matches, jobs]);

  const openItem = useCallback(
    (item: FeedItem) => {
      if (item.matchId === null) {
        return;
      }
      router.push({ pathname: '/match/[id]', params: { id: item.matchId } });
    },
    [router],
  );

  const loading = matches.isLoading || jobs.isLoading;
  const error = matches.error ?? jobs.error;

  return (
    <Screen bleed>
      <View style={styles.header}>
        <Label>RiseUp</Label>
        <Spacer size={space[2]} />
        <Display>Matches</Display>
      </View>

      {loading ? (
        <LoadingState label="Loading matches" />
      ) : error !== null && feed.length === 0 ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load your matches.'}
          code={error instanceof ApiError ? error.code : undefined}
          onRetry={onRefresh}
        />
      ) : (
        <FlashList
          data={feed}
          keyExtractor={keyExtractor}
          renderItem={({ item }) => <FeedRow item={item} onPress={openItem} />}
          ItemSeparatorComponent={Separator}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={matches.isRefetching}
              onRefresh={onRefresh}
              tintColor={ink.mute}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="No matches yet"
              body="Upload a clip or a full match and it will appear here while it processes."
              action={{ label: 'Go to uploads', onPress: () => router.push('/uploads') }}
            />
          }
        />
      )}
    </Screen>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────
   Hoisted out of the screen, and given primitive-only props, so FlashList can
   recycle it without re-rendering every row when the parent's state changes.
   ───────────────────────────────────────────────────────────────────────── */

const keyExtractor = (item: FeedItem) => item.key;

function Separator() {
  return <View style={styles.separator} />;
}

const stateTone = {
  ready: 'neutral',
  processing: 'live',
  failed: 'error',
} as const;

function FeedRow({ item, onPress }: { item: FeedItem; onPress: (item: FeedItem) => void }) {
  const openable = item.matchId !== null;

  return (
    <Pressable
      onPress={() => onPress(item)}
      disabled={!openable}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${stateLabel(item)}`}
      accessibilityHint={openable ? 'Opens the match summary' : undefined}
      style={({ pressed }) => [styles.row, pressed && openable ? styles.rowPressed : null]}
    >
      <View style={styles.rowMain}>
        <BodyStrong numberOfLines={1}>{item.title}</BodyStrong>
        <Spacer size={space[2]} />
        <Row gap={space[3]}>
          <Label>{when(item.at)}</Label>
          {item.playerCount === null ? null : <Label>{count(item.playerCount)} tracked</Label>}
          {item.durationSec === null ? null : <Label>{duration(item.durationSec)}</Label>}
        </Row>
        {item.error === null ? null : (
          <>
            <Spacer size={space[2]} />
            <Body tone={3} numberOfLines={2}>
              {item.error}
            </Body>
          </>
        )}
      </View>

      <View style={styles.rowTrailing}>
        {item.state === 'processing' && item.progress !== null ? (
          <Metric tone="mute">{`${Math.round(item.progress)}%`}</Metric>
        ) : (
          <Pill
            label={stateLabel(item)}
            tone={stateTone[item.state]}
            dot={item.state === 'processing'}
          />
        )}
      </View>
    </Pressable>
  );
}

function stateLabel(item: FeedItem): string {
  if (item.state === 'failed') {
    return 'Failed';
  }
  if (item.state === 'processing') {
    return 'Processing';
  }
  return 'Ready';
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: space[5],
    paddingTop: space[4],
    paddingBottom: space[5],
  },
  list: {
    paddingBottom: space[8],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[4],
    minHeight: minTouchTarget + space[4],
    paddingHorizontal: space[5],
    paddingVertical: space[4],
    backgroundColor: surface.bg0,
  },
  rowPressed: {
    backgroundColor: surface.bg1,
  },
  rowMain: {
    flex: 1,
  },
  rowTrailing: {
    alignItems: 'flex-end',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: line.rule,
    marginLeft: space[5],
  },
});
