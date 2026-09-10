/**
 * Settings.
 *
 * Account, the role switch from §2, and the things both app stores check for:
 * a reachable privacy policy, a working support route, a way to report a
 * problem, and account deletion that completes inside the app.
 *
 * ACCOUNT DELETION IS THE ONE WITH TEETH. App Review 5.1.1(v) rejects an app
 * that sends people to a website to delete an account; Google Play requires
 * the same in-app path AND a publicly reachable URL for its Data Safety form,
 * which is `links.deleteAccount`. Both are covered.
 *
 * THERE IS NO BILLING HERE, and there must not be. Apple 3.1.1 and Google
 * Play's Payments policy both require digital purchases to go through platform
 * billing, and a link opening a Stripe page reads to a reviewer as routing
 * around it. Quota and subscription are administered on the web dashboard by a
 * club admin; this app's only involvement is saying when a club is near its
 * limit.
 */

import { useAuth, useUser } from '@clerk/expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { paths } from '../../../src/api/endpoints';
import { useApi } from '../../../src/api/provider';
import { useMe } from '../../../src/api/queries';
import { useOrganisation, type ClubOption } from '../../../src/auth/organisation';
import { useAppRole, type AppRole } from '../../../src/auth/role';
import { cameraStore } from '../../../src/capture/devices/store';
import { surveyDraft } from '../../../src/capture/survey/draft';
import { links, openLink } from '../../../src/lib/links';
import { useI18n } from '../../../src/i18n/store';
import { LANGUAGES, isRtlLocale, type Locale } from '../../../src/i18n/i18n';
import { inbox } from '../../../src/notifications/inbox';
import {
  ink,
  line,
  minTouchTarget,
  radius,
  role as roleColor,
  signal,
  space,
  surface,
} from '../../../src/theme/tokens';
import { Button } from '../../../src/ui/Button';
import { Panel, Row, Rule, Screen, Spacer } from '../../../src/ui/Layout';
import { Body, BodyStrong, Display, Label, Metric } from '../../../src/ui/Text';

export default function SettingsScreen() {
  const { signOut } = useAuth();
  const { user } = useUser();
  const api = useApi();
  const router = useRouter();
  const me = useMe();
  const { role, setRole } = useAppRole();

  /* THE CHOOSER ALREADY EXISTED AND WAS UNREACHABLE. `useOrganisation` offers
     a club list at sign-in and then never again, so somebody who coaches two
     clubs was stuck in whichever one the session landed on — and roles are per
     organisation, so that also silently decided what they were allowed to do.
     Nothing here is new machinery; it is the same `activate` the sign-in
     screen calls, given a way in. */
  const { state: org, activate } = useOrganisation();
  const clubs = org.status === 'active' ? org.options : [];
  const [switching, setSwitching] = useState(false);
  const { t, locale, setLocale, syncPending } = useI18n();
  const [deleting, setDeleting] = useState(false);

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

  /**
   * Delete the account, for real.
   *
   * Two calls, in this order, because they do different halves and only one of
   * them is irreversible:
   *
   *   1. `POST /me/delete` records the GDPR erasure request and anonymises the
   *      audit trail. First on purpose — if it fails, nothing has been
   *      destroyed and the user can try again.
   *   2. `user.delete()` deletes the Clerk account. This is what makes the
   *      deletion real, and it cannot be undone.
   *
   * The backend endpoint explicitly does NOT delete the Clerk user — its own
   * docstring says the account "must be deleted via the account settings UI" —
   * so step 2 is what actually satisfies the store requirement, and the app
   * performing it client-side is the reason this flow is compliant at all.
   *
   * Club-owned data (matches, footage) is not deleted. The club is the
   * controller for it, and the confirmation says so rather than implying an
   * erasure the app cannot perform.
   */
  const onDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete your account?',
      'Your account and your personal data are deleted. Matches and footage belong to your club ' +
        'and stay with them — ask a club admin if you need those removed too.\n\n' +
        'This cannot be undone.',
      [
        { text: 'Keep my account', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setDeleting(true);
              try {
                await api.post(paths.meDelete);
                await user?.delete();
                await api.clearCache();
                inbox.clear();
                cameraStore.reset();
                surveyDraft.reset();
                await signOut();
              } catch {
                setDeleting(false);
                Alert.alert(
                  'Could not delete the account',
                  'Something went wrong and nothing was deleted. Try again, or email ' +
                    `${links.supportEmail}.`,
                );
              }
            })();
          },
        },
      ],
    );
  }, [api, user, signOut]);

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
        {/* ONE CLUB STAYS A PLAIN ROW. A picker with a single option is a
            control that teaches a concept for no reason — the whole point of
            the auto-activation in useOrganisation is that a coach never has to
            learn what an organisation is. */}
        {clubs.length > 1 ? (
          <Pressable
            onPress={() => { setSwitching(true); }}
            accessibilityRole="button"
            accessibilityLabel="Change club"
            accessibilityHint={`You are in ${clubs.length} clubs. Opens a list to switch.`}
            style={({ pressed }) => [styles.field, pressed ? styles.rowPressed : null]}
          >
            <Row>
              <View style={styles.fieldMain}>
                <Label>Club</Label>
                <Spacer size={space[1]} />
                <Body numberOfLines={1}>{clubName(clubs, org, me.data?.club_id)}</Body>
              </View>
              <Label tone={3}>Change</Label>
            </Row>
          </Pressable>
        ) : (
          <Field label="Club" value={me.data?.club_id ?? '—'} mono />
        )}
        <Rule />
        <Field label="Dashboard role" value={roleLabel(me.data?.role)} />
      </Panel>

      {switching ? (
        <>
          <Spacer size={space[3]} />
          <Panel>
            <Label>Switch club</Label>
            <Spacer size={space[2]} />
            {/* SAID OUT LOUD, because it is not obvious and it is the reason
                the same person sees different things in two clubs: what you
                may do is granted per club, not per account. */}
            <Body tone={3} size={13}>
              Everything — matches, players, pitches, and what you are allowed to change — belongs
              to the club you are in.
            </Body>
            <Spacer size={space[3]} />
            {clubs.map((club) => {
              const current = club.id === (org.status === 'active' ? org.activeId : '');
              return (
                <Pressable
                  key={club.id}
                  onPress={() => {
                    setSwitching(false);
                    if (!current) {
                      activate(club.id);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: current }}
                  accessibilityLabel={club.name}
                  style={({ pressed }) => [styles.clubRow, pressed ? styles.rowPressed : null]}
                >
                  <Body style={styles.clubName} numberOfLines={1}>{club.name}</Body>
                  {current ? (
                    <Ionicons name="checkmark" size={18} color={signal.base} />
                  ) : null}
                </Pressable>
              );
            })}
            <Spacer size={space[3]} />
            <Button
              label="Cancel"
              onPress={() => { setSwitching(false); }}
              variant="ghost"
              block
            />
          </Panel>
        </>
      ) : null}

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
      <Label>{t('lang.label')}</Label>
      <Spacer size={space[3]} />
      <Body tone={3} size={13}>
        {t('lang.subtitle')}
      </Body>
      <Spacer size={space[3]} />
      <LanguagePicker
        value={locale}
        onChange={(next) => {
          // Switching direction restarts the app, so say so first. Anything
          // else looks like a crash at the moment somebody changes a setting.
          if (isRtlLocale(next) !== isRtlLocale(locale)) {
            Alert.alert(t('lang.restartTitle'), t('lang.restartBody'), [
              { text: t('lang.notNow'), style: 'cancel' },
              { text: t('lang.restartNow'), onPress: () => void setLocale(next) },
            ]);
            return;
          }
          void setLocale(next);
        }}
      />
      {syncPending ? (
        <>
          <Spacer size={space[2]} />
          <Body tone={3} size={13}>
            {t('lang.syncFailed')}
          </Body>
        </>
      ) : null}

      <Spacer size={space[6]} />
      <Label>{t('settings.help')}</Label>
      <Spacer size={space[3]} />
      <Panel style={styles.rows} flat>
        <LinkRow
          label="Report a problem"
          hint="Something broken or confusing"
          onPress={() => router.push('/report')}
        />
        <Rule inset={space[4]} />
        <LinkRow
          label="Support"
          hint={links.supportEmail}
          external
          onPress={() => void openLink(links.support)}
        />
        <Rule inset={space[4]} />
        <LinkRow label="Privacy policy" external onPress={() => void openLink(links.privacy)} />
        <Rule inset={space[4]} />
        <LinkRow label="Terms of service" external onPress={() => void openLink(links.terms)} />
      </Panel>

      <Spacer size={space[6]} />
      <Label>Notifications</Label>
      <Spacer size={space[3]} />
      <Panel>
        <Body tone={2} size={13}>
          This device registers for notifications on every launch. They start arriving as soon as
          the server accepts it, with no update needed.
        </Body>
      </Panel>

      <Spacer size={space[6]} />
      <Button label="Sign out" onPress={onSignOut} variant="secondary" block />

      <Spacer size={space[6]} />
      <Label>Delete account</Label>
      <Spacer size={space[3]} />
      <Panel>
        <Body tone={3} size={13}>
          Removes you and your personal data. Matches and footage belong to your club and stay
          with them.
        </Body>
        <Spacer size={space[4]} />
        <Pressable
          onPress={onDeleteAccount}
          disabled={deleting}
          accessibilityRole="button"
          accessibilityLabel="Delete my account"
          accessibilityState={{ disabled: deleting, busy: deleting }}
          style={({ pressed }) => [styles.destructive, pressed ? styles.destructivePressed : null]}
        >
          <BodyStrong color={roleColor.red.fg}>
            {deleting ? 'Deleting…' : 'Delete my account'}
          </BodyStrong>
        </Pressable>
      </Panel>

      <Spacer size={space[5]} />
      <Row gap={space[2]}>
        <Label tone="subtle">RiseUp</Label>
        <Label tone="subtle">v0.1.0</Label>
      </Row>
      <Spacer size={space[7]} />
    </Screen>
  );
}

/**
 * The language list.
 *
 * Each language is written in ITSELF — English, Français, العربية — never
 * translated into the language currently showing. Somebody who has ended up in
 * a language they cannot read has to be able to find their way out, and a list
 * reading "Anglais / Français / Arabe" is no help to a reader of Arabic.
 */
function LanguagePicker({
  value,
  onChange,
}: {
  value: Locale;
  onChange: (locale: Locale) => void;
}) {
  return (
    <Panel style={styles.rows} flat>
      {LANGUAGES.map((language, index) => (
        <View key={language.code}>
          {index === 0 ? null : <Rule inset={space[4]} />}
          <Pressable
            onPress={() => onChange(language.code)}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === language.code }}
            accessibilityLabel={language.endonym}
            accessibilityLanguage={language.tag}
            style={({ pressed }) => [styles.linkRow, pressed ? styles.linkRowPressed : null]}
          >
            <View style={styles.linkMain}>
              {/* Tagged with its own language so a screen reader pronounces it
                  correctly rather than reading Arabic with English phonetics —
                  the most common a11y defect on a multilingual language list. */}
              <Body accessibilityLanguage={language.tag}>{language.endonym}</Body>
            </View>
            {value === language.code ? (
              <Ionicons name="checkmark" size={20} color={signal.base} />
            ) : null}
          </Pressable>
        </View>
      ))}
    </Panel>
  );
}

/**
 * A row that goes somewhere.
 *
 * The trailing icon differs on purpose: a box-arrow means "this leaves the app
 * and opens a browser", a chevron means "this is another screen here". Getting
 * that wrong is how somebody taps Privacy at a ground with no signal and gets
 * a blank page with no explanation.
 */
function LinkRow({
  label,
  hint,
  external = false,
  onPress,
}: {
  label: string;
  hint?: string;
  external?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={label}
      accessibilityHint={external ? 'Opens in your browser' : undefined}
      style={({ pressed }) => [styles.linkRow, pressed ? styles.linkRowPressed : null]}
    >
      <View style={styles.linkMain}>
        <Body>{label}</Body>
        {hint === undefined ? null : (
          <>
            <Spacer size={space[1]} />
            <Label tone="subtle">{hint}</Label>
          </>
        )}
      </View>
      <Ionicons name={external ? 'open-outline' : 'chevron-forward'} size={18} color={ink.subtle} />
    </Pressable>
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

/**
 * The club's NAME, from Clerk, falling back to the id from `/me`.
 *
 * `/me` returns the organisation id and nothing human — the name exists only
 * on the Clerk membership. Showing the id when there is no name is honest;
 * inventing one is not.
 */
function clubName(
  clubs: ClubOption[],
  org: { status: string; activeId?: string },
  fallbackId: string | undefined,
): string {
  const activeId = org.status === 'active' ? org.activeId : undefined;
  const match = clubs.find((c) => c.id === activeId);
  return match?.name ?? fallbackId ?? '—';
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
  rows: {
    padding: 0,
    overflow: 'hidden',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: minTouchTarget + space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  linkRowPressed: {
    backgroundColor: surface.bg2,
  },
  linkMain: {
    flex: 1,
  },
  destructive: {
    minHeight: minTouchTarget,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: roleColor.red.border,
    backgroundColor: roleColor.red.bg,
  },
  destructivePressed: {
    backgroundColor: roleColor.red.border,
  },
  fieldMain: {
    // Without this the name pushes "Change" off the right edge on a long club
    // name instead of ellipsising.
    flex: 1,
  },
  rowPressed: {
    opacity: 0.7,
  },
  clubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: minTouchTarget,
    paddingVertical: space[2],
  },
  clubName: {
    flex: 1,
  },
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
