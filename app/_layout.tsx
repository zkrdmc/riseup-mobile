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
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/api/provider';
import { I18nProvider } from '../src/i18n/store';
import { tokenCache } from '../src/auth/tokenCache';
import { config } from '../src/lib/config';
import { surface } from '../src/theme/tokens';
import { ErrorState, LoadingState } from '../src/ui/State';

/**
 * THE NATIVE SPLASH IS NOT HELD, AND THAT IS THE FIX.
 *
 * WHAT HOLDING IT COST, MEASURED ON A REAL DEVICE.
 * `preventAutoHideAsync()` used to run here, and the app shipped a build that
 * showed the logo forever. The process was alive, the bundle loaded, Clerk
 * resolved, the router mounted, and a `uiautomator` dump read back the Matches
 * screen and all five tabs -- none of which a single pixel showed, because the
 * splash window was still on top eating every touch. No crash, no error, no
 * log line. A client would have concluded the product was dead.
 *
 * THE MECHANISM, from expo-splash-screen's own Android source.
 * `SplashScreenManager.registerOnActivity` installs an `OnPreDrawListener`
 * that returns FALSE -- cancelling the draw -- while `keepSplashScreenOnScreen`
 * is true. `hide()` only flips that boolean; the listener removes itself and
 * lets the frame through on a SUBSEQUENT pre-draw pass. On a screen that has
 * finished rendering and is not animating, nothing requests another pass. The
 * flag is false, the app is ready, and the frame is never drawn.
 *
 * So this is not a hold to time out or retry around. Its release depends on a
 * draw that may never be scheduled, which is why the timeout added alongside
 * this would not have saved it either.
 *
 * WHAT WE GIVE UP, AND WHY IT IS NOTHING. Holding it bought one thing: no
 * flash of the sign-in screen before a restored session resolves. The root now
 * renders its own dark `LoadingState` while `isLoaded` is false, so the first
 * React frame is already the right screen -- the same result, in our own code,
 * where a failure is visible and recoverable.
 */

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
  // Released on mount, unconditionally, before anything can decide otherwise.
  // Nothing holds it any more, so this is belt and braces rather than the
  // mechanism -- but it costs one call and it is the line that guarantees no
  // future edit can make the splash outlive the first frame again.
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    if (isLoaded) {
      return;
    }
    const timer = setTimeout(() => {
      setStartupTimedOut(true);
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

  /* THE NAVIGATOR IS ALWAYS MOUNTED, AND THE STARTUP UI GOES OVER IT.
     The previous version returned the loading and error screens INSTEAD of
     <Stack>. That is the thing to avoid in an expo-router root layout: the
     root must mount a navigator on every render, and a root that sometimes
     renders a plain View leaves the router with no navigator at all -- which
     is a different failure from the one it was trying to report, and a harder
     one to see.

     So the states are an overlay. The navigator stays mounted underneath from
     the first frame, and the overlay covers it until Clerk has settled. */
  const stack = (
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

  return (
    <View style={styles.root}>
      {stack}
      {isLoaded ? null : (
        <View style={styles.startupOverlay}>
          {startupTimedOut ? (
            <ErrorState
              message={
                'RiseUp could not reach the sign-in service. This is almost always the '
                + 'connection \u2014 check signal or Wi-Fi and try again. Nothing on this '
                + 'phone has been lost.'
              }
              code="auth_unreachable"
              onRetry={() => {
                setStartupTimedOut(false);
                setAttempt((n) => n + 1);
              }}
            />
          ) : (
            <LoadingState label="Starting RiseUp" />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: surface.bg0,
  },
  startupOverlay: {
    // Covers the navigator rather than replacing it. Opaque, so a half-built
    // screen underneath is never visible through it.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: surface.bg0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

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
