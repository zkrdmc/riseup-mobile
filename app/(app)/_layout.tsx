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
 * `GET /me` is the gate: the cheapest call in the API, needed by several
 * screens anyway, and cached by React Query — so after the first render the
 * check costs nothing.
 *
 * WHY HERE AND NOT IN THE SIGN-IN HANDLER. Membership can be revoked while
 * somebody is using the app, and a session restored from the keychain days
 * later never passes through sign-in at all. Gating the layout catches both.
 *
 * Tabs at the root, everything else pushed over them. `headerShown` is off
 * throughout: each screen draws its own header, because the summary screen's
 * carries a data-quality banner and a status pill that no native title bar can
 * hold.
 */

import { useAuth } from '@clerk/clerk-expo';
import { Stack } from 'expo-router';
import { useCallback } from 'react';

import { isNoClubError } from '../../src/api/errors';
import { useApi } from '../../src/api/provider';
import { useMe } from '../../src/api/queries';
import { useOrganisation } from '../../src/auth/organisation';
import { inbox } from '../../src/notifications/inbox';
import { ink, surface } from '../../src/theme/tokens';
import { Screen } from '../../src/ui/Layout';
import { ChooseClub, NoClub } from '../../src/ui/NoClub';
import { LoadingState } from '../../src/ui/State';

export default function AppLayout() {
  const me = useMe();
  const api = useApi();
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
