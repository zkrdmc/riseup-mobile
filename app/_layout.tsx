/**
 * Root layout: providers, and the one routing decision that gates everything.
 *
 * Order matters here. Clerk must wrap the API provider, because the API
 * provider reads `getToken` from Clerk's context. Both must wrap the router,
 * because a screen mounting before its session is restored renders a signed-out
 * state for a frame and then swaps — which on a cold start looks like the app
 * logging you out and back in.
 */

import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
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

// Held until Clerk has restored the session, so the first frame the user sees
// is the screen they belong on rather than the sign-in screen flashing past.
void SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

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
        <ClerkProvider publishableKey={config.clerkPublishableKey} tokenCache={tokenCache}>
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
