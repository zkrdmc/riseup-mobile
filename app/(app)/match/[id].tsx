/**
 * Match summary (§7).
 *
 * Sized for a phone and for two minutes of attention. Everything deeper —
 * xT flow maps, pass networks, tactical shape — is explicitly out of scope,
 * and their absence is what keeps this screen readable at arm's length in a
 * car park.
 *
 * WHAT §7 ASKS FOR THAT IS NOT HERE, AND WHY
 * ------------------------------------------
 *   Result / scoreline — the `matches` table has no score columns. The screen
 *     omits it rather than rendering a 0–0 that looks real.
 *   Opponent — no column. The match `label` is the closest thing, and it is
 *     whatever somebody typed.
 *   Pitch — `venue_id` is a bare foreign key with no join in the read path.
 *   xG — not computed by the pipeline.
 *   Auto-directed video — `GET /matches/{id}/video` is v0.4.
 *
 * Each of those is one backend field away and is listed in
 * `docs/BACKEND-GAPS.md`. Leaving a labelled blank on the screen would have
 * been the worse choice: an empty "Opponent —" row teaches a coach that the
 * app does not know things, which is not the impression a first summary should
 * leave.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ApiError } from '../../../src/api/errors';
import { useMatch, useMatchPlayers } from '../../../src/api/queries';
import { count, duration, km, minutes, when } from '../../../src/lib/format';
import { buildSummary, playerName, type TeamTotals } from '../../../src/lib/summary';
import type { PlayerMetrics } from '../../../src/api/types';
import { ink, line, minTouchTarget, space, surface, team as teamColor } from '../../../src/theme/tokens';
import { Panel, Row, Rule, Screen, Spacer } from '../../../src/ui/Layout';
import { ConfidenceBand } from '../../../src/ui/Status';
import { ErrorState, LoadingState } from '../../../src/ui/State';
import { Body, BodyStrong, Display, Label, Metric } from '../../../src/ui/Text';

export default function MatchSummaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const matchId = id ?? '';
  const match = useMatch(matchId);
  const players = useMatchPlayers(matchId);

  const summary = useMemo(() => {
    if (match.data === undefined || players.data === undefined) {
      return null;
    }
    return buildSummary(match.data, players.data);
  }, [match.data, players.data]);

  const error = match.error ?? players.error;

  if (error !== null && summary === null) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load this match.'}
          code={error instanceof ApiError ? error.code : undefined}
          onRetry={() => {
            void match.refetch();
            void players.refetch();
          }}
        />
      </Screen>
    );
  }

  if (summary === null) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <LoadingState label="Loading match summary" />
      </Screen>
    );
  }

  return (
    <Screen scroll bleed>
      <View style={styles.gutter}>
        <Header onBack={() => router.back()} />

        <Spacer size={space[4]} />
        <Display numberOfLines={2}>{summary.title}</Display>
        <Spacer size={space[2]} />
        <Row gap={space[3]}>
          {/* "Uploaded", not the date. The schema has no kick-off time and
              presenting the upload timestamp as the fixture date would be
              wrong for any match filmed on Saturday and uploaded on Sunday. */}
          <Label>Uploaded {when(summary.uploadedAt)}</Label>
          {summary.durationSec === null ? null : <Label>{duration(summary.durationSec)}</Label>}
        </Row>

        <Spacer size={space[5]} />

        {/* Data quality first. A coach who reads the numbers before learning
            they came from a half-covered pitch has already formed a view. */}
        {summary.quality.map((note) => (
          <View key={note.text} style={styles.bandSpacing}>
            <ConfidenceBand level={note.level} label={note.text} />
          </View>
        ))}

        <Spacer size={space[5]} />
        <Label>Team totals</Label>
        <Spacer size={space[3]} />
        {summary.teams.length === 0 ? (
          <Body tone={3}>No team data for this match.</Body>
        ) : (
          summary.teams.map((t) => <TeamCard key={t.label} team={t} />)
        )}

        <Spacer size={space[6]} />
        <Label>Top five by distance</Label>
        <Spacer size={space[3]} />
        <PlayerTable
          players={summary.topByDistance}
          unit="km"
          value={(p) => km(p.distance_m)}
          matchId={matchId}
        />

        <Spacer size={space[6]} />
        <Label>Top five by sprints</Label>
        <Spacer size={space[3]} />
        <PlayerTable
          players={summary.topBySprints}
          unit="sprints"
          value={(p) => count(p.sprint_count)}
          matchId={matchId}
        />

        <Spacer size={space[6]} />
        <Panel>
          <Body tone={3}>
            Pass networks, tactical shape and player comparison live on the web dashboard. This
            screen is the two-minute version.
          </Body>
        </Panel>
        <Spacer size={space[7]} />
      </View>
    </Screen>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <Pressable
      onPress={onBack}
      accessibilityRole="button"
      accessibilityLabel="Back to matches"
      hitSlop={space[3]}
      style={styles.back}
    >
      <Ionicons name="chevron-back" size={20} color={ink.mute} />
      <Label>Matches</Label>
    </Pressable>
  );
}

/**
 * One team's totals.
 *
 * The home/away colours are an encoding — which side a player is on — and one
 * of the few legitimate spends of colour in this system. They appear as a 3px
 * edge, not a filled card, because a saturated block behind a number makes the
 * number harder to read and the colour is not the information.
 */
function TeamCard({ team }: { team: TeamTotals }) {
  const accent = team.label === 'A' ? teamColor.home : team.label === 'B' ? teamColor.away : ink.subtle;

  return (
    <View style={styles.teamCard}>
      <View style={[styles.teamEdge, { backgroundColor: accent }]} />
      <View style={styles.teamBody}>
        <Row gap={space[2]}>
          <BodyStrong>{team.label === 'Unassigned' ? 'Unassigned tracks' : `Team ${team.label}`}</BodyStrong>
          <Label>{count(team.playerCount)} players</Label>
        </Row>
        <Spacer size={space[3]} />
        <Row gap={space[5]} align="flex-start">
          <Stat label="Distance" value={km(team.distanceM)} unit="km" />
          <Stat label="Sprints" value={count(team.sprints)} />
          <Stat
            label="Possession"
            value={team.possessionPct === null ? '—' : String(Math.round(team.possessionPct))}
            unit={team.possessionPct === null ? undefined : '%'}
          />
        </Row>
      </View>
    </View>
  );
}

/**
 * A labelled figure.
 *
 * The value is large and the label is small. The design system's own
 * anti-pattern list calls out the inverse — "emphasising labels over values" —
 * and it is the single most common way a metric block reads as a form.
 */
function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View>
      <Label>{label}</Label>
      <Spacer size={space[1]} />
      <Row gap={space[1]} align="baseline">
        <Metric size={24}>{value}</Metric>
        {unit === undefined ? null : <Label tone="subtle">{unit}</Label>}
      </Row>
    </View>
  );
}

function PlayerTable({
  players,
  unit,
  value,
  matchId,
}: {
  players: PlayerMetrics[];
  unit: string;
  value: (p: PlayerMetrics) => string;
  matchId: string;
}) {
  const router = useRouter();

  if (players.length === 0) {
    return <Body tone={3}>No player data for this match.</Body>;
  }

  return (
    <Panel style={styles.tablePanel} flat>
      {players.map((p, index) => (
        <View key={p.track_id}>
          {index === 0 ? null : <Rule inset={space[4]} />}
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/match/player',
                params: { matchId, trackId: String(p.track_id) },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`${playerName(p)}, ${value(p)} ${unit}`}
            accessibilityHint="Opens this player's quick view"
            style={({ pressed }) => [styles.playerRow, pressed ? styles.playerRowPressed : null]}
          >
            <Label tone="subtle" style={styles.rank}>
              {String(index + 1)}
            </Label>
            <View style={styles.playerMain}>
              <BodyStrong numberOfLines={1}>{playerName(p)}</BodyStrong>
              <Row gap={space[2]}>
                {p.team === null ? null : <Label>Team {p.team}</Label>}
                <Label>{minutes(p.minutes_played)}</Label>
              </Row>
            </View>
            <Row gap={space[1]} align="baseline">
              <Metric>{value(p)}</Metric>
              <Label tone="subtle">{unit}</Label>
            </Row>
          </Pressable>
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  gutter: {
    paddingHorizontal: space[5],
    paddingTop: space[3],
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    height: minTouchTarget,
    marginLeft: -space[2],
  },
  bandSpacing: {
    marginBottom: space[2],
  },
  teamCard: {
    flexDirection: 'row',
    backgroundColor: surface.bg1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: line.rule,
    overflow: 'hidden',
    marginBottom: space[3],
  },
  teamEdge: {
    width: 3,
    alignSelf: 'stretch',
  },
  teamBody: {
    flex: 1,
    padding: space[4],
  },
  tablePanel: {
    padding: 0,
    overflow: 'hidden',
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: minTouchTarget + space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  playerRowPressed: {
    backgroundColor: surface.bg2,
  },
  rank: {
    width: 16,
  },
  playerMain: {
    flex: 1,
    gap: space[1],
  },
});
