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
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/api/provider';
import { I18nProvider } from '../src/i18n/store';
import { tokenCache } from '../src/auth/tokenCache';
import { config } from '../src/lib/config';
import { surface } from '../src/theme/tokens';

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
 * WHAT WE GIVE UP. Holding it bought one thing: no flash of the sign-in screen
 * before a restored session resolves. That flash is the cost, and it is the
 * right trade -- a frame of the wrong screen is recoverable in a way that a
 * permanently undrawn app is not. The navigator's own `contentStyle` is
 * `surface.bg0`, so the gap is dark rather than white.
 *
 * Do NOT re-add a hold here to remove that flash. The screens below already
 * gate on their own state; see the note under this one for what happened when
 * this component tried to make that judgement instead.
 */

/*
 * WHY THERE IS NO STARTUP TIMEOUT OR OVERLAY HERE ANY MORE.
 *
 * There was one, and it broke the app worse than the bug it was written for.
 *
 * It gated a full-screen overlay on Clerk's `isLoaded` from THIS component and
 * gave it a ten-second budget. On the device the overlay latched permanently
 * over a completely working app: a uiautomator dump showed the Matches screen
 * and all five tabs rendered underneath the "could not reach the sign-in
 * service" panel. `(app)/_layout.tsx` only renders those tabs once the
 * organisation is active, which cannot happen unless Clerk HAS loaded -- so
 * Clerk was up, and the root's own `isLoaded` was still reporting false.
 *
 * `@clerk/expo` Core 3 is signal-based. This component read `isLoaded` on its
 * first render, got false, and never re-rendered when the signal settled. Any
 * UI this component gates on that value is therefore permanent.
 *
 * The lesson is narrow and worth keeping: the ROOT does not get to decide
 * whether the app is ready. The screens below already gate on their own state
 * and render their own loading and error copy -- `(app)/_layout.tsx` has
 * "Finding your club", the club gate, and the no-club screen. Duplicating that
 * judgement up here added a second opinion that could not be revised.
 */

function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();
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
