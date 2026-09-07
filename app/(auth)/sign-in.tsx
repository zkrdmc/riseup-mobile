/**
 * Sign in.
 *
 * Against the same Clerk instance the dashboard uses, so a coach's existing
 * account works with no migration and no second identity to administer.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE SCREEN ASKS WHAT THE ACCOUNT SUPPORTS. IT DOES NOT ASSUME.
 * ══════════════════════════════════════════════════════════════════════════
 * The first version of this screen sent an identifier and a password in one
 * call, which fails with "the verification strategy is not valid for this
 * account" on any user who has no password — and plenty do. A Clerk instance
 * can be configured for email codes instead of passwords, a user invited to an
 * organisation may have accepted without ever setting one, and an account
 * created through a social provider has none by definition. All three are
 * ordinary states, and all three produced an error message that sounds like
 * the account is broken.
 *
 * So the flow is two steps: hand Clerk the email, read `supportedFirstFactors`
 * off the response, and offer what is actually available. The account decides,
 * not the app.
 *
 * WHY EMAIL CODES ARE NOT A CONSOLATION PRIZE HERE. The Operator is standing
 * on a touchline in the rain with a shared club phone. Typing a password on a
 * phone keyboard in that situation is the worst interaction in the product,
 * and a six-digit code from an email is genuinely better — which is why this
 * offers the code path even when a password is also available.
 *
 * WHAT THIS SCREEN DOES NOT DO. Sign-up. A club is provisioned with an
 * organisation and members through the dashboard, and a self-serve sign-up on
 * the phone would create accounts with no club attached — which authenticate
 * fine and then 403 on every request, the worst possible failure to debug from
 * a touchline. `src/ui/NoClub.tsx` catches anyone who arrives in that state.
 */

import { useSSO, useSignIn } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { probeSSOAvailability, usableOptions, type SSOOption } from '../../src/auth/sso';
import { links, openLink } from '../../src/lib/links';
import { ink, line, radius, role, space, surface, type } from '../../src/theme/tokens';
import { Button } from '../../src/ui/Button';
import { Row, Screen, Spacer } from '../../src/ui/Layout';
import { Body, Display, Label } from '../../src/ui/Text';

/** Where we are in the two-step flow. */
type Step =
  /** Asking for the email. Nothing has been sent yet. */
  | { kind: 'identify' }
  /** The account takes a password. */
  | { kind: 'password' }
  /** A code has been emailed. `sentTo` is Clerk's redacted address. */
  | { kind: 'code'; sentTo: string };

export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'identify' });
  /** Set when the account supports both, so the code path stays offerable. */
  const [emailFactorId, setEmailFactorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoOptions, setSsoOptions] = useState<SSOOption[]>([]);

  const { startSSOFlow } = useSSO();

  useEffect(() => {
    // Discovered, not assumed: a provider with no credentials in Clerk yet must
    // not be drawn, because a broken button on the first screen is worse than
    // one fewer way in.
    void probeSSOAvailability().then(setSsoOptions);
  }, []);

  const finish = useCallback(
    async (createdSessionId: string | null | undefined) => {
      // `setActive` is undefined until Clerk has loaded. Guarding on it rather
      // than on `isLoaded` alone keeps the narrowing local to the one call that
      // needs it.
      if (createdSessionId === null || createdSessionId === undefined || setActive === undefined) {
        return false;
      }
      await setActive({ session: createdSessionId });
      router.replace('/');
      return true;
    },
    [setActive, router],
  );

  /* ── Step 1: who are you? ─────────────────────────────────────────────── */

  const identify = useCallback(async () => {
    if (!isLoaded || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const attempt = await signIn.create({ identifier: email.trim() });

      if (attempt.status === 'complete') {
        // Possible when the instance is configured for a passwordless link and
        // the session was already established.
        await finish(attempt.createdSessionId);
        return;
      }

      const factors = attempt.supportedFirstFactors ?? [];
      const hasPassword = factors.some((f) => f.strategy === 'password');
      const emailFactor = factors.find(
        (f): f is Extract<typeof f, { strategy: 'email_code'; emailAddressId: string }> =>
          f.strategy === 'email_code',
      );

      setEmailFactorId(emailFactor?.emailAddressId ?? null);

      if (hasPassword) {
        setStep({ kind: 'password' });
        return;
      }

      if (emailFactor !== undefined) {
        await signIn.prepareFirstFactor({
          strategy: 'email_code',
          emailAddressId: emailFactor.emailAddressId,
        });
        setStep({ kind: 'code', sentTo: emailFactor.safeIdentifier });
        return;
      }

      // Neither password nor an email code. Naming the strategies the account
      // does have is the only thing that helps here, because the fix is on the
      // dashboard and support will ask exactly this.
      setError(
        factors.length === 0
          ? 'This account has no way to sign in configured. A club admin can fix that on the dashboard.'
          : `This account signs in with ${factors.map((f) => f.strategy).join(' or ')}, which the ` +
            `app does not handle yet. Sign in on the dashboard, or ask a club admin.`,
      );
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }, [isLoaded, busy, signIn, email, finish]);

  /* ── Step 2a: password ────────────────────────────────────────────────── */

  const submitPassword = useCallback(async () => {
    if (!isLoaded || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const attempt = await signIn.attemptFirstFactor({ strategy: 'password', password });
      if (attempt.status === 'complete') {
        await finish(attempt.createdSessionId);
        return;
      }
      setError(
        `This account needs another step to sign in (${attempt.status}). Finish it on the ` +
          `dashboard, then come back.`,
      );
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }, [isLoaded, busy, signIn, password, finish]);

  /* ── Step 2b: emailed code ────────────────────────────────────────────── */

  const sendCode = useCallback(async () => {
    if (!isLoaded || busy || emailFactorId === null) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await signIn.prepareFirstFactor({
        strategy: 'email_code',
        emailAddressId: emailFactorId,
      });
      setStep({ kind: 'code', sentTo: email.trim() });
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }, [isLoaded, busy, signIn, emailFactorId, email]);

  const submitCode = useCallback(async () => {
    if (!isLoaded || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const attempt = await signIn.attemptFirstFactor({ strategy: 'email_code', code });
      if (attempt.status === 'complete') {
        await finish(attempt.createdSessionId);
        return;
      }
      setError(`That code was accepted but the account needs another step (${attempt.status}).`);
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }, [isLoaded, busy, signIn, code, finish]);

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
        if (createdSessionId !== null && createdSessionId !== undefined && activate !== undefined) {
          await activate({ session: createdSessionId });
          router.replace('/');
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

  const restart = useCallback(() => {
    setStep({ kind: 'identify' });
    setPassword('');
    setCode('');
    setError(null);
  }, []);

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
            <Body tone={3}>
              {step.kind === 'code'
                ? `We sent a code to ${step.sentTo}.`
                : 'The same account you use on the dashboard.'}
            </Body>
          </View>

          <View>
            {step.kind === 'identify' ? (
              <>
                <Field
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="coach@club.ma"
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="username"
                  onSubmitEditing={() => void identify()}
                  returnKeyType="next"
                />
                <Spacer size={space[5]} />
                <Button
                  label="Continue"
                  onPress={() => void identify()}
                  disabled={email.trim().length === 0}
                  busy={busy}
                  block
                />
              </>
            ) : null}

            {step.kind === 'password' ? (
              <>
                <Field
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  textContentType="password"
                  autoFocus
                  onSubmitEditing={() => void submitPassword()}
                  returnKeyType="go"
                />
                <Spacer size={space[5]} />
                <Button
                  label="Sign in"
                  onPress={() => void submitPassword()}
                  disabled={password.length === 0}
                  busy={busy}
                  block
                />
                {emailFactorId === null ? null : (
                  <>
                    <Spacer size={space[3]} />
                    {/* Offered even though a password works. On a shared club
                        phone in the rain, a six-digit code beats typing a
                        password every time. */}
                    <Button
                      label="Email me a code instead"
                      onPress={() => void sendCode()}
                      variant="secondary"
                      busy={busy}
                      block
                    />
                  </>
                )}
              </>
            ) : null}

            {step.kind === 'code' ? (
              <>
                <Field
                  label="Code"
                  value={code}
                  onChangeText={setCode}
                  placeholder="123456"
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  onSubmitEditing={() => void submitCode()}
                  returnKeyType="go"
                />
                <Spacer size={space[5]} />
                <Button
                  label="Sign in"
                  onPress={() => void submitCode()}
                  disabled={code.trim().length === 0}
                  busy={busy}
                  block
                />
                <Spacer size={space[3]} />
                <Button label="Send it again" onPress={() => void sendCode()} variant="secondary" block />
              </>
            ) : null}

            {error === null ? null : (
              <>
                <Spacer size={space[4]} />
                <Body color={role.red.fg}>{error}</Body>
              </>
            )}

            {step.kind === 'identify'
              ? usableOptions(ssoOptions).map((option) => (
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
                ))
              : null}

            {step.kind === 'identify' ? null : (
              <>
                <Spacer size={space[3]} />
                <Button label="Use a different email" onPress={restart} variant="ghost" block />
              </>
            )}
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
function Field({ label, ...props }: React.ComponentProps<typeof TextInput> & { label: string }) {
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
 * `longMessage` is the one written for a person; `message` is the short form.
 * Prefer the long one, and never fall through to `String(e)` — a stringified
 * network error on a sign-in screen reads as the app being broken rather than
 * the connection being absent.
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
