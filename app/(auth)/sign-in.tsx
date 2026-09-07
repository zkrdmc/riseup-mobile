/**
 * Sign in.
 *
 * Email and password against the same Clerk instance the dashboard uses, so a
 * coach's existing account works with no migration and no second identity to
 * administer.
 *
 * WHY NOT A HOSTED WEB FLOW. Clerk's browser-based sign-in is fewer lines, but
 * it hands the user to a Safari sheet and back. That is fine on a desktop and
 * poor on a phone that may be on a marginal connection — and it makes the one
 * screen a coach sees before they trust the app look like somebody else's.
 *
 * WHAT THIS SCREEN DOES NOT DO. Sign-up. A club is provisioned with an
 * organisation and members through the dashboard, and a self-serve sign-up on
 * the phone would create accounts with no club attached — which authenticate
 * fine and then 403 on every request, the worst possible failure to debug from
 * a touchline. The link out is to the dashboard, deliberately.
 */

import { useSSO, useSignIn } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { probeSSOAvailability, usableOptions, type SSOOption } from '../../src/auth/sso';
import { links, openLink } from '../../src/lib/links';
import { Button } from '../../src/ui/Button';
import { Row, Screen, Spacer } from '../../src/ui/Layout';
import { Body, Display, Label } from '../../src/ui/Text';
import { ink, line, radius, role, space, surface, type } from '../../src/theme/tokens';

export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoOptions, setSsoOptions] = useState<SSOOption[]>([]);

  const { startSSOFlow } = useSSO();

  useEffect(() => {
    // Discovered, not assumed: a provider with no credentials in Clerk yet
    // must not be drawn, because a broken button on the first screen is worse
    // than one fewer way in.
    void probeSSOAvailability().then(setSsoOptions);
  }, []);

  const onSSO = useCallback(
    async (option: SSOOption) => {
      if (busy) {
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const { createdSessionId, setActive: activate } = await startSSOFlow({
          strategy: option.strategy,
        });

        if (createdSessionId !== undefined && createdSessionId !== null && activate !== undefined) {
          await activate({ session: createdSessionId });
          router.replace('/');
          return;
        }
        // No session and no error means the sheet was dismissed. Silent is
        // correct — the user cancelled, they do not need telling.
      } catch (e) {
        setError(clerkMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, startSSOFlow, router],
  );

  const onSubmit = useCallback(async () => {
    if (!isLoaded || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const attempt = await signIn.create({ identifier: email.trim(), password });

      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
        router.replace('/');
        return;
      }

      // MFA, a required password reset, an unverified email. Each needs its own
      // screen, and guessing which one from here would be wrong. Naming the
      // state at least gives support something to work with.
      setError(
        `This account needs another step to sign in (${attempt.status}). ` +
          'Finish it on the dashboard, then come back.',
      );
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }, [isLoaded, busy, signIn, email, password, setActive, router]);

  const canSubmit = email.trim().length > 0 && password.length > 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.fill}>
          <View style={styles.header}>
            <Label>RiseUp</Label>
            <Spacer size={space[3]} />
            <Display>Sign in</Display>
            <Spacer size={space[2]} />
            <Body tone={3}>The same account you use on the dashboard.</Body>
          </View>

          <View>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="coach@club.ma"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="username"
            />
            <Spacer size={space[4]} />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              onSubmitEditing={() => void onSubmit()}
              returnKeyType="go"
            />

            {error === null ? null : (
              <>
                <Spacer size={space[4]} />
                <Body color={role.red.fg}>{error}</Body>
              </>
            )}

            <Spacer size={space[5]} />
            <Button
              label="Sign in"
              onPress={() => void onSubmit()}
              disabled={!canSubmit}
              busy={busy}
              block
            />

            {usableOptions(ssoOptions).map((option) => (
              <View key={option.strategy}>
                <Spacer size={space[3]} />
                <Button
                  label={option.label}
                  onPress={() => void onSSO(option)}
                  variant="secondary"
                  busy={busy}
                  block
                />
              </View>
            ))}
          </View>

          <View style={styles.footer}>
            <Row gap={space[1]}>
              <Body tone={3}>No account?</Body>
              <Body tone={2}>A club admin invites you from the dashboard.</Body>
            </Row>
            <Spacer size={space[4]} />
            {/* Reachable before signing in, which is where both stores expect
                to find them — a reviewer with no account still has to be able
                to read what the app does with their data. */}
            <Row gap={space[4]}>
              <Pressable
                onPress={() => void openLink(links.privacy)}
                accessibilityRole="link"
                accessibilityLabel="Privacy policy"
                hitSlop={space[2]}
              >
                <Label tone={3}>Privacy</Label>
              </Pressable>
              <Pressable
                onPress={() => void openLink(links.terms)}
                accessibilityRole="link"
                accessibilityLabel="Terms of service"
                hitSlop={space[2]}
              >
                <Label tone={3}>Terms</Label>
              </Pressable>
              <Pressable
                onPress={() => void openLink(links.support)}
                accessibilityRole="link"
                accessibilityLabel="Support"
                hitSlop={space[2]}
              >
                <Label tone={3}>Support</Label>
              </Pressable>
            </Row>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * A labelled input.
 *
 * The label sits above the field and stays there. A placeholder-only label
 * disappears the moment somebody types, which means the one time they need it
 * — checking what they entered before submitting — is exactly when it is gone.
 */
function Field({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View>
      <Label>{label}</Label>
      <Spacer size={space[2]} />
      <TextInput
        {...props}
        style={styles.input}
        placeholderTextColor={ink.subtle}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
      />
    </View>
  );
}

/**
 * Clerk errors arrive as `{ errors: [{ message, longMessage }] }`.
 *
 * `longMessage` is the one written for a person ("Password is incorrect. Try
 * again, or use another method."); `message` is the short form ("Incorrect
 * password"). Prefer the long one, and never fall through to `String(e)` — a
 * stringified network error on a sign-in screen reads as the app being broken
 * rather than the connection being absent.
 */
function clerkMessage(e: unknown): string {
  const errors = (e as { errors?: Array<{ message?: string; longMessage?: string }> })?.errors;
  const first = errors?.[0];
  if (first !== undefined) {
    return first.longMessage ?? first.message ?? 'That did not work. Check your details.';
  }
  return 'Could not reach RiseUp. Check your connection and try again.';
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: space[7],
  },
  footer: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: space[4],
  },
  input: {
    height: 48,
    backgroundColor: surface.bg1,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    color: ink[1],
    fontSize: type.ui,
  },
});
