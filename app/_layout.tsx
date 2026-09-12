/**
 * Root layout: providers, and the one routing decision that gates everything.
 *
 * Order matters here. Clerk must wrap the API provider, because the API
 * provider reads `getToken` from Clerk's context. Both must wrap the router,
 * because a screen mounting before its session is restored renders a signed-out
 * state for a frame and then swaps — which on a cold start looks like the app
 * logging you out and back in.
 */

import { ClerkProvider, useAuth } from '@clerk/expo';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/api/provider';
import { I18nProvider } from '../src/i18n/store';
import { tokenCache } from '../src/auth/tokenCache';
import { config } from '../src/lib/config';
import { surface } from '../src/theme/tokens';
import { Screen } from '../src/ui/Layout';
import { ErrorState, LoadingState } from '../src/ui/State';

// Held until Clerk has restored the session, so the first frame the user sees
// is the screen they belong on rather than the sign-in screen flashing past.
void SplashScreen.preventAutoHideAsync();

/**
 * How long the splash may hide the app while Clerk starts up.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE BUG THIS EXISTS TO FIX
 * ══════════════════════════════════════════════════════════════════════════
 * `hideAsync` used to be called ONLY from inside the effect guarded by Clerk's
 * `isLoaded`. So "Clerk never finishes loading" and "the app never starts"
 * were the same event: the logo stayed on screen, forever, with no message, no
 * retry and nothing in the logs. Observed on a real device — the process alive,
 * the JS bundle loaded, React resumed, and not one text node rendered.
 *
 * Any of these produces it: no signal at a ground, a captive portal on club
 * Wi-Fi, Clerk's frontend API unreachable, or a token cache holding a session
 * minted by a DIFFERENT Clerk instance — which is what a build switched from
 * the development key to the live one inherits, because the install is an
 * update and SecureStore survives it.
 *
 * Ten seconds: long enough that a slow-but-working start never flashes this,
 * short enough that nobody standing on a touchline concludes the app is dead.
 * Clerk normally settles in under two.
 */
const CLERK_STARTUP_BUDGET_MS = 10_000;

function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();
  /**
   * Has the startup budget run out with Clerk still not ready?
   *
   * Kept separate from `isLoaded` rather than folded into it, because they
   * mean different things and the screen has to say which: not-loaded-yet is a
   * spinner, and not-loaded-after-ten-seconds is a failure with a retry.
   */
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  /** Bumped by the retry, to re-arm the budget for another attempt. */
  const [attempt, setAttempt] = useState(0);
  const segments = useSegments();
  const router = useRouter();

  /**
   * THE SPLASH COMES DOWN NO MATTER WHAT, and this is the whole fix.
   *
   * It is deliberately in its own effect with no dependency on `isLoaded`.
   * Hiding the splash is not an auth decision — it is the promise that the app
   * will show the user something. Tying the two together is what turned a
   * recoverable network failure into a permanently blank product.
   */
  useEffect(() => {
    if (isLoaded) {
      return;
    }
    const timer = setTimeout(() => {
      setStartupTimedOut(true);
      void SplashScreen.hideAsync();
    }, CLERK_STARTUP_BUDGET_MS);
    return () => { clearTimeout(timer); };
  }, [isLoaded, attempt]);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    void SplashScreen.hideAsync();

    const inAuthGroup = segments[0] === '(auth)';

    if (!isSignedIn && !inAuthGroup) {
      router.replace('/(auth)/sign-in');
    } else if (isSignedIn && inAuthGroup) {
      router.replace('/');
    }
  }, [isLoaded, isSignedIn, segments, router]);

  /* ── EVERY STARTUP STATE RENDERS SOMETHING ────────────────────────────────
     Three of them, and the reason they are spelled out rather than collapsed
     is that the old code had only one path and the other two fell through to
     nothing at all.

     Still starting: a spinner. Invisible behind the splash on a cold start,
     and the visible state during a retry after the splash has come down.

     Gave up: the failure, in words, with a retry that re-arms the budget.

     Loaded: the app. */
  if (!isLoaded) {
    if (!startupTimedOut) {
      return (
        <Screen edges={['top', 'bottom']}>
          <LoadingState label="Starting RiseUp" />
        </Screen>
      );
    }
    return (
      <Screen edges={['top', 'bottom']}>
        <ErrorState
          message={
            'RiseUp could not reach the sign-in service. This is almost always the '
            + 'connection — check signal or Wi-Fi and try again. Nothing on this '
            + 'phone has been lost.'
          }
          code="auth_unreachable"
          onRetry={() => {
            setStartupTimedOut(false);
            setAttempt((n) => n + 1);
          }}
        />
      </Screen>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Not white. The default flash between screens on a dark app is the
        // single most visible sign that nobody looked at the transitions.
        contentStyle: { backgroundColor: surface.bg0 },
      }}
    >
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: surface.bg0 }}>
      <SafeAreaProvider>
        {/* ══════════════════════════════════════════════════════════════════
            WHY THIS APP DOES NOT SHIP CLERK'S NATIVE COMPONENTS
            ══════════════════════════════════════════════════════════════════
            `@clerk/expo` ships an autolinked native module — `ClerkExpo.podspec`
            — whose deployment target is `:ios => '17.0'`, because the Clerk iOS
            SDK behind its SwiftUI sign-in components requires iOS 17. Linked,
            it drags the whole app's floor from Expo SDK 57's own 16.4 up to
            17.0, and every iPhone on iOS 16 stops being able to install RiseUp.

            The clubs this is built for share handsets and keep them for years.
            Cutting off iOS 16 to gain a pre-built sign-in screen we do not use
            — `app/(auth)/sign-in.tsx` is our own, and has to be, because it
            reads `supportedFirstFactors` and offers an emailed code — is a bad
            trade in the wrong direction.

            So `package.json` excludes `@clerk/expo` from Expo autolinking, and
            this flag tells the provider not to mount the JS↔native client sync
            that the absent module would back. Everything we actually use —
            `useAuth`, `useUser`, `useSignIn`, `useSSO`, `useOrganizationList`,
            the token cache — is JavaScript against clerk-js and unaffected.

            The day we want Clerk's native components, the cost is explicit:
            drop the exclude, add `"@clerk/expo"` to `plugins` in app.json, and
            accept iOS 17 as the floor. */}
        <ClerkProvider
          publishableKey={config.clerkPublishableKey}
          tokenCache={tokenCache}
          __experimental_disableNativeClientSync
        >
          <ApiProvider baseUrl={config.apiUrl}>
            {/* Inside Clerk because it reads the signed-in user to sync the
                choice to the account, and above the router so every screen
                re-renders when the language changes. */}
            <I18nProvider>
              <StatusBar style="light" />
              <RootNavigator />
            </I18nProvider>
          </ApiProvider>
        </ClerkProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
