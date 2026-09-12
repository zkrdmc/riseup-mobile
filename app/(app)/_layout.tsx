/**
 * The signed-in stack, and the membership gate in front of it.
 *
 * THE GATE. Being signed in is not the same as having access. `club_id` comes
 * from the Clerk token's `org_id`, and `clerk_auth.py` returns 403 from every
 * endpoint when that is absent — so an account with no organisation reaches the
 * tab bar and finds the match list, uploads, inbox and settings all broken at
 * once. That reads as a broken app, rather than as one action somebody else
 * needs to take.
 *
 * WHY THE WORK IS SPLIT ACROSS TWO COMPONENTS. Clerk's organisation hooks warn
 * — and return nothing useful — when there is no session:
 *
 *   "useOrganizationList requires an active user session."
 *
 * This layout mounts before the root redirect to sign-in has run, so calling
 * those hooks unconditionally fires that warning on every cold start of a
 * signed-out app. Hooks cannot be called conditionally, so the guard has to be
 * a component boundary: `AppLayout` knows only whether there is a session, and
 * `SignedInLayout` — which is the only thing that touches organisations — is
 * not mounted until there is one.
 */

import { useAuth } from '@clerk/expo';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';

import { isAuthError, isNoClubError } from '../../src/api/errors';
import { useApi } from '../../src/api/provider';
import { useMe } from '../../src/api/queries';
import { syncFixtureReminders } from '../../src/notifications/fixtureReminders';
import { registerForPush } from '../../src/notifications/push';
import { useOrganisation } from '../../src/auth/organisation';
import { inbox } from '../../src/notifications/inbox';
import { ink, surface } from '../../src/theme/tokens';
import { Screen } from '../../src/ui/Layout';
import { ChooseClub, NoClub } from '../../src/ui/NoClub';
import { LoadingState } from '../../src/ui/State';

export default function AppLayout() {
  const { isLoaded, isSignedIn } = useAuth();

  // Nothing below here may run without a session. The root layout is
  // redirecting to sign-in; rendering the bare stack in the meantime avoids
  // both the Clerk warning and a flash of the loading state.
  if (!isLoaded || !isSignedIn) {
    return <AppStack />;
  }

  return <SignedInLayout />;
}

function SignedInLayout() {
  const me = useMe();
  const api = useApi();
  const router = useRouter();

  /* ── THE SERVER'S 401 IS THE GROUND TRUTH ABOUT BEING SIGNED IN ───────────
     Two bugs shared one cause, and this is it.

     Signing out appeared to do nothing: the handler cleared the session and
     then waited for the reactive redirect in `app/_layout.tsx`, which is gated
     on Clerk's `isLoaded` as read by THAT component -- the same signal that
     froze the startup overlay, because `@clerk/expo` Core 3 is signal-based
     and the root reads it once and does not re-render. With no redirect, the
     user stayed in the app shell. And every query then 401'd, which is why the
     match list sat on a spinner: the session was gone, nothing said so, and
     the app kept asking.

     So the decision is taken from the API's answer instead of the client's
     opinion. A 401 means the server does not accept this session, whatever
     Clerk's signals currently claim, and that is the one fact both bugs
     needed.

     `isNoClubError` is checked BEFORE this below, and must stay that way: a
     legitimate member with no active organisation also gets a 403, and
     bouncing them to sign-in would be a loop they cannot escape by signing in
     again. */
  const signedOutByServer = isAuthError(me.error) && !isNoClubError(me.error);
  useEffect(() => {
    if (signedOutByServer) {
      router.replace('/(auth)/sign-in');
    }
  }, [signedOutByServer, router]);

  /* Fixture reminders are scheduled HERE rather than on the Inbox screen,
     because this layout mounts whenever somebody is in the app and the Inbox
     tab may never be opened. A reminder that only gets scheduled if you
     happen to visit a particular tab is not a reminder anybody can rely on.

     Once per entry, and that is enough: the plan's horizon is a fortnight, so
     the window rolls forward on any launch inside two weeks. Best-effort by
     construction — `syncFixtureReminders` resolves a result and throws
     nothing, so a club with no fixtures, no permission or no network simply
     gets no reminders rather than a broken launch. */
  useEffect(() => {
    /* PUSH REGISTRATION BELONGS HERE, NOT ON THE INBOX SCREEN. Settings tells
       the user "this device registers for notifications on every launch", and
       while this lived on the Inbox tab that was untrue: a coach who never
       opened Inbox never registered, so the server never learned their address
       and nothing could be delivered to them. The outcome is published to
       `pushState` for the Inbox to display. */
    void registerForPush(api);
    void syncFixtureReminders(api);
  }, [api]);
  const { signOut } = useAuth();
  const { state: org, activate } = useOrganisation();

  const onSignOut = useCallback(() => {
    void (async () => {
      await api.clearCache();
      inbox.clear();
      await signOut();
    })();
  }, [api, signOut]);

  // Resolve the organisation BEFORE trusting a 403 from /me. Clerk does not
  // activate an organisation on sign-in, so a legitimate member can hold a
  // session carrying no org_id — and the backend answers that with the same
  // 403 it uses for a genuine orphan. Activating first is what keeps the gate
  // from firing on somebody who is correctly invited and has done nothing
  // wrong.
  if (org.status === 'loading' || org.status === 'activating') {
    return (
      <Screen edges={['top', 'bottom']}>
        <LoadingState label="Finding your club" />
      </Screen>
    );
  }

  if (org.status === 'choose') {
    return <ChooseClub options={org.options} onChoose={activate} onSignOut={onSignOut} />;
  }

  if (org.status === 'none' || isNoClubError(me.error)) {
    return <NoClub email={me.data?.email ?? null} onSignOut={onSignOut} />;
  }

  // Block on the FIRST load only. A refetch briefly in flight must not replace
  // a working app with a spinner, and a failure that is not the no-club case —
  // offline at a ground, say — must not block either: the tabs handle their own
  // errors and several of them work with no network at all.
  if (me.isLoading) {
    return (
      <Screen edges={['top', 'bottom']}>
        <LoadingState label="Checking your club" />
      </Screen>
    );
  }

  return <AppStack />;
}

function AppStack() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: surface.bg0 },
        headerTintColor: ink[1],
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="match/[id]" />
      <Stack.Screen
        name="survey/index"
        options={{
          // A full screen, not a modal. The operator moves between its steps
          // while walking around a pitch, and a sheet that can be swiped away
          // mid-survey is the wrong affordance outdoors.
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="calibrate"
        options={{
          // Full screen for the same reason as the survey: it is used
          // standing at a pitch, marking points on a photograph, and a
          // sheet that swipes away takes a dozen careful taps with it.
          headerShown: false,
        }}
      />
      <Stack.Screen name="report" />
      <Stack.Screen
        name="match/player"
        options={{
          // A player is a detail of the match already on screen, not a new
          // place. The sheet keeps the summary visible behind it, which is
          // what "quick view" in §7 is asking for.
          presentation: 'modal',
        }}
      />
    </Stack>
  );
}
