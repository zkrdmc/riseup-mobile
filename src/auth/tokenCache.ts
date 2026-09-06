/**
 * Where Clerk's session token lives on the device.
 *
 * SecureStore, which is the iOS Keychain and Android's EncryptedSharedPrefer-
 * ences. Not AsyncStorage: that is a plaintext file in the app container, and
 * §11 says no long-lived credentials sit unprotected on a device.
 *
 * WHY THIS MATTERS MORE HERE THAN ON THE WEB. The PRD is blunt about it: "an
 * app that logs the Operator out before a match is a failed app". A persisted
 * session is what makes the app survive being force-quit in a coat pocket and
 * reopened at a ground with no signal — Clerk restores the session from this
 * cache and only reaches the network when the token actually needs refreshing.
 * A cache that silently fails to write turns every cold start into a sign-in
 * screen, at the exact moment there is no connection to sign in over.
 *
 * So a write failure is logged rather than swallowed. It is not fatal — the
 * session still works for this launch — but it is the difference between the
 * app working on Saturday and not, and it must not be invisible.
 */

import * as SecureStore from 'expo-secure-store';

export const tokenCache = {
  async getToken(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      // A corrupt or unreadable entry — a restored backup from another device,
      // a keychain the OS has invalidated after a passcode change. Deleting it
      // turns "the app is permanently broken" into "sign in once more".
      console.warn('[auth] secure store read failed; clearing entry', error);
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Nothing further to try. Report signed-out and let the user sign in.
      }
      return null;
    }
  },

  async saveToken(key: string, value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (error) {
      console.warn(
        '[auth] secure store write failed; this session will not survive a restart',
        error,
      );
    }
  },
};
