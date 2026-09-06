/**
 * Player quick view (§7).
 *
 * A modal over the summary, because a player is a detail of the match already
 * on screen rather than a new place to be.
 *
 * Four numbers, a comparison, and a heatmap. Nothing else fits in the two
 * minutes this screen is sized for, and §7 is explicit that squad comparison
 * is the wrong frame on a phone — so the only comparison here is the player
 * against their own season, gated on identity being real (`src/lib/season.ts`).
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMatchPlayers, usePlayerHistory } from '../../../src/api/queries';
import type { PlayerMetrics } from '../../../src/api/types';
import { count, km, kmh, minutes } from '../../../src/lib/format';
import { blockerText, compareToSeason } from '../../../src/lib/season';
import { playerName } from '../../../src/lib/summary';
import { role, signal, space } from '../../../src/theme/tokens';
import { Heatmap } from '../../../src/ui/Heatmap';
import { Button } from '../../../src/ui/Button';
import { Panel, Row, Screen, Spacer } from '../../../src/ui/Layout';
import { ErrorState, LoadingState } from '../../../src/ui/State';
import { Body, Display, Label, Metric } from '../../../src/ui/Text';

export default function PlayerQuickView() {
  const { matchId, trackId } = useLocalSearchParams<{ matchId: string; trackId: string }>();
  const router = useRouter();

  const id = matchId ?? '';
  const track = Number.parseInt(trackId ?? '', 10);

  const players = useMatchPlayers(id);
  const player = useMemo(
    () => players.data?.find((p) => p.track_id === track) ?? null,
    [players.data, track],
  );

  // Only fetched once we know who this is. A history request for an unnamed
  // track cannot produce a usable comparison, so it is a round trip spent on
  // a result the gate will reject anyway.
  const named = player !== null && player.name !== null && player.name.length > 0;
  const history = usePlayerHistory(track, { enabled: named });

  if (players.isLoading) {
    return (
      <Screen edges={['top', 'bottom']}>
        <LoadingState label="Loading player" />
      </Screen>
    );
  }

  if (player === null) {
    return (
      <Screen edges={['top', 'bottom']}>
        <ErrorState
          message="That player is not in this match any more."
          onRetry={() => router.back()}
        />
      </Screen>
    );
  }

  const rows = history.data?.history ?? [];

  return (
    <Screen scroll edges={['top']}>
      <Spacer size={space[3]} />
      <Label>{player.team === null ? 'Unassigned' : `Team ${player.team}`}</Label>
      <Spacer size={space[2]} />
      <Display numberOfLines={2}>{playerName(player)}</Display>
      <Spacer size={space[2]} />
      <Row gap={space[3]}>
        {player.position === null ? null : <Label>{player.position}</Label>}
        <Label>{minutes(player.minutes_played)} played</Label>
      </Row>

      <Spacer size={space[6]} />

      <View style={styles.grid}>
        <MetricCell
          label="Distance"
          value={km(player.distance_m)}
          unit="km"
          player={player}
          history={rows}
          metric={(p) => p.distance_m}
          format={(v) => `${(v / 1000).toFixed(1)} km`}
        />
        <MetricCell
          label="Top speed"
          value={kmh(player.top_speed_ms)}
          unit="km/h"
          player={player}
          history={rows}
          metric={(p) => p.top_speed_ms}
          format={(v) => `${(v * 3.6).toFixed(1)} km/h`}
        />
        <MetricCell
          label="Sprints"
          value={count(player.sprint_count)}
          player={player}
          history={rows}
          metric={(p) => p.sprint_count}
          format={(v) => `${Math.round(v)}`}
        />
        <MetricCell
          label="Minutes"
          value={minutes(player.minutes_played)}
          player={player}
          history={rows}
          metric={(p) => p.minutes_played}
          format={(v) => `${Math.round(v)}'`}
        />
      </View>

      <Spacer size={space[6]} />
      <Label>Where they played</Label>
      <Spacer size={space[3]} />
      <Heatmap grid={player.heatmap} />
      <Spacer size={space[2]} />
      <Body tone={3}>
        Team-relative: this player&apos;s side attacks to the right, whichever half they started
        in.
      </Body>

      <Spacer size={space[6]} />
      <Button label="Close" onPress={() => router.back()} variant="secondary" block />
      <Spacer size={space[7]} />
    </Screen>
  );
}

/**
 * One measured number, with its own-season comparison underneath.
 *
 * The delta is the only place on this screen colour carries meaning, and it is
 * deliberately not red-for-bad: a player covering 12% less ground than their
 * median is information, not a failure, and colouring it as one on a phone is
 * how a number becomes an accusation before anybody has asked why.
 *
 * Above median is `signal` (a measured, confident, notable state). Below is
 * amber — visible, not alarming. Neither is red.
 */
function MetricCell({
  label,
  value,
  unit,
  player,
  history,
  metric,
  format,
}: {
  label: string;
  value: string;
  unit?: string;
  player: PlayerMetrics;
  history: PlayerMetrics[];
  metric: (p: PlayerMetrics) => number | null;
  format: (value: number) => string;
}) {
  const result = compareToSeason(player, history, metric);

  return (
    <Panel style={styles.cell}>
      <Label>{label}</Label>
      <Spacer size={space[2]} />
      <Row gap={space[1]} align="baseline">
        <Metric size={28}>{value}</Metric>
        {unit === undefined ? null : <Label tone="subtle">{unit}</Label>}
      </Row>
      <Spacer size={space[3]} />
      {result.available ? (
        <>
          <Body
            size={13}
            color={result.comparison.deltaPct >= 0 ? signal.base : role.amber.fg}
          >
            {formatDelta(result.comparison.deltaPct)} vs their median
          </Body>
          <Label tone="subtle">
            {`${format(result.comparison.median)} over ${result.comparison.sampleSize} matches`}
          </Label>
        </>
      ) : (
        <Body size={13} tone="subtle">
          {blockerText(result.reason)}
        </Body>
      )}
    </Panel>
  );
}

function formatDelta(pct: number): string {
  const rounded = Math.round(pct);
  if (rounded === 0) {
    return 'Level with';
  }
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3],
  },
  cell: {
    // Two per row at any phone width. `flexBasis` rather than a computed
    // percentage so the gap is subtracted correctly on both sides.
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 132,
  },
});
