/**
 * Settings.
 *
 * Account, the role switch from §2, and an honest statement of what
 * notifications currently do.
 *
 * The notification preferences of §6 — per-category toggles and quiet hours —
 * are not here. They would be a screen of switches that change nothing, since
 * `GET/PATCH /me/notification-preferences` does not exist and no notification
 * is delivered anyway. A preferences screen that silently does not work is a
 * worse artefact than its absence, because the user believes they have
 * configured something.
 */

import { useAuth } from '@clerk/clerk-expo';
import { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { useApi } from '../../../src/api/provider';
import { useMe } from '../../../src/api/queries';
import { useAppRole, type AppRole } from '../../../src/auth/role';
import { inbox } from '../../../src/notifications/inbox';
import { ink, line, minTouchTarget, radius, space, surface } from '../../../src/theme/tokens';
import { Button } from '../../../src/ui/Button';
import { Panel, Row, Rule, Screen, Spacer } from '../../../src/ui/Layout';
import { Body, BodyStrong, Display, Label, Metric } from '../../../src/ui/Text';

export default function SettingsScreen() {
  const { signOut } = useAuth();
  const api = useApi();
  const me = useMe();
  const { role, setRole } = useAppRole();

  const onSignOut = useCallback(() => {
    Alert.alert('Sign out?', 'Anything still uploading will stop.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            // The ETag cache and the inbox both hold this club's data. Leaving
            // them behind would show the next person to sign in on this device
            // the previous club's match names.
            await api.clearCache();
            inbox.clear();
            await signOut();
          })();
        },
      },
    ]);
  }, [api, signOut]);

  return (
    <Screen scroll>
      <Spacer size={space[4]} />
      <Display>Settings</Display>

      <Spacer size={space[5]} />
      <Label>Account</Label>
      <Spacer size={space[3]} />
      <Panel>
        <Field label="Signed in as" value={me.data?.email ?? '—'} />
        <Rule />
        {/* The club NAME is not in `GET /me` — it returns the Clerk org id and
            nothing human. Showing the id is honest; inventing a name is not. */}
        <Field label="Club" value={me.data?.club_id ?? '—'} mono />
        <Rule />
        <Field label="Dashboard role" value={roleLabel(me.data?.role)} />
      </Panel>

      <Spacer size={space[6]} />
      <Label>This device</Label>
      <Spacer size={space[3]} />
      <Body tone={3} size={13}>
        Where the app opens. A phone that films every match should open on capture; a phone used
        to read results should open on the match list.
      </Body>
      <Spacer size={space[3]} />
      <RolePicker value={role} onChange={setRole} />

      <Spacer size={space[6]} />
      <Label>Notifications</Label>
      <Spacer size={space[3]} />
      <Panel>
        <Body tone={2} size={13}>
          Not delivering yet. The app registers this device on every launch, and notifications
          will start arriving as soon as the server accepts it — no update needed.
        </Body>
        <Spacer size={space[3]} />
        <Body tone={3} size={13}>
          Per-category preferences and quiet hours arrive with them.
        </Body>
      </Panel>

      <Spacer size={space[6]} />
      <Button label="Sign out" onPress={onSignOut} variant="secondary" block />

      <Spacer size={space[5]} />
      <Row gap={space[2]}>
        <Label tone="subtle">RiseUp</Label>
        <Label tone="subtle">v0.1.0</Label>
      </Row>
      <Spacer size={space[7]} />
    </Screen>
  );
}

function roleLabel(role: string | undefined): string {
  switch (role) {
    case 'org:admin':
      return 'Admin';
    case 'org:analyst':
      return 'Analyst';
    case 'org:viewer':
      return 'Viewer';
    default:
      return '—';
  }
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <Spacer size={space[1]} />
      {mono ? (
        <Metric size={13} tone={2} numberOfLines={1}>
          {value}
        </Metric>
      ) : (
        <Body numberOfLines={1}>{value}</Body>
      )}
    </View>
  );
}

/**
 * A two-option segmented control.
 *
 * Not a switch. A switch labelled "Operator mode" makes one of the two roles
 * the default and the other a deviation from it, which is exactly the framing
 * §2 rejects — the two users are not an average user and a special case.
 */
function RolePicker({ value, onChange }: { value: AppRole; onChange: (role: AppRole) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      <Segment
        label="Analyst"
        hint="Opens on the match list"
        selected={value === 'analyst'}
        onPress={() => onChange('analyst')}
      />
      <Segment
        label="Operator"
        hint="Opens on capture"
        selected={value === 'operator'}
        onPress={() => onChange('operator')}
      />
    </View>
  );
}

function Segment({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}. ${hint}`}
      style={[styles.segment, selected ? styles.segmentSelected : null]}
    >
      <BodyStrong color={selected ? ink[1] : ink.mute}>{label}</BodyStrong>
      <Spacer size={space[1]} />
      <Label tone={selected ? 3 : 'subtle'}>{hint}</Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    paddingVertical: space[3],
  },
  segmented: {
    flexDirection: 'row',
    gap: space[2],
  },
  segment: {
    flex: 1,
    minHeight: minTouchTarget + space[3],
    justifyContent: 'center',
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: line.rule,
    backgroundColor: surface.bg1,
  },
  segmentSelected: {
    borderColor: line.borderHi,
    backgroundColor: surface.bg2,
  },
});
