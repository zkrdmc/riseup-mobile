/**
 * Sign in with Apple, and Sign in with Google.
 *
 * WHY APPLE IS NOT OPTIONAL. App Review 4.8 requires Sign in with Apple
 * wherever an app offers a third-party or social login. Adding Google on
 * Android brings this app inside that rule, so the two arrive together — you
 * cannot ship one without the other and pass review.
 *
 * Google Play has no equivalent obligation. Google sign-in is offered on
 * Android because a shared club handset already has a Google account on it and
 * typing a password on a touchline in the rain is the worst part of the app.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  SCAFFOLDED, AND HONEST ABOUT IT
 * ══════════════════════════════════════════════════════════════════════════
 * Neither strategy works until credentials are configured in the Clerk
 * dashboard. Apple needs an Apple Developer account, a Services ID, a Team ID,
 * a Key ID and a .p8 private key; Google needs an OAuth client. None of that
 * exists yet.
 *
 * So availability is DISCOVERED rather than assumed, and a button that cannot
 * work is not drawn. The alternative — showing the button and letting it fail
 * — puts a broken control on the one screen a coach sees before they decide
 * whether to trust the app, and is also the kind of thing a reviewer taps
 * first.
 *
 * When the credentials land, nothing here changes: the buttons appear because
 * `probeSSOAvailability` starts reporting them as configured.
 */

import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';

export type SSOStrategy = 'oauth_apple' | 'oauth_google';

export interface SSOOption {
  strategy: SSOStrategy;
  label: string;
  /** False until the platform supports it AND Clerk has it configured. */
  available: boolean;
  /** Why it is unavailable, for the log. Never shown to a user. */
  reason: string | null;
}

/**
 * Which providers this build can actually use.
 *
 * `EXPO_PUBLIC_SSO_PROVIDERS` is a comma-separated allowlist — `apple,google`
 * — set once the corresponding credentials are live in Clerk. It defaults to
 * empty, so a build made before the credentials exist shows email and password
 * only, which is a complete and working sign-in rather than a degraded one.
 *
 * A build-time flag rather than a runtime probe because Clerk offers no way to
 * ask "is this strategy configured" without attempting a flow, and attempting
 * one to find out means opening a browser sheet that then fails.
 */
function configuredProviders(): Set<string> {
  const raw = process.env.EXPO_PUBLIC_SSO_PROVIDERS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => s.length > 0),
  );
}

export async function probeSSOAvailability(): Promise<SSOOption[]> {
  const configured = configuredProviders();
  const options: SSOOption[] = [];

  // Apple: iOS only, and only on a device whose OS provides it. The
  // availability check matters on iPad and on older iOS builds.
  if (Platform.OS === 'ios') {
    let deviceCapable = false;
    try {
      deviceCapable = await AppleAuthentication.isAvailableAsync();
    } catch {
      deviceCapable = false;
    }
    options.push({
      strategy: 'oauth_apple',
      label: 'Continue with Apple',
      available: deviceCapable && configured.has('apple'),
      reason: !deviceCapable
        ? 'This device does not offer Sign in with Apple.'
        : configured.has('apple')
          ? null
          : 'Apple credentials are not configured in Clerk yet.',
    });
  }

  if (Platform.OS === 'android') {
    options.push({
      strategy: 'oauth_google',
      label: 'Continue with Google',
      available: configured.has('google'),
      reason: configured.has('google') ? null : 'Google OAuth is not configured in Clerk yet.',
    });
  }

  return options;
}

/** The ones worth drawing a button for. */
export function usableOptions(options: SSOOption[]): SSOOption[] {
  return options.filter((o) => o.available);
}
