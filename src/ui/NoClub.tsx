/**
 * Signed in, but not attached to a club.
 *
 * THE STATE THIS PREVENTS. `clerk_auth.py` derives `club_id` from the token's
 * `org_id` and returns 403 from every endpoint when it is missing. Without this
 * screen, such an account signs in successfully and lands in the tab bar where
 * the match list, uploads, inbox and settings are all broken at once — which
 * reads as a broken app rather than as an account that needs one action from
 * somebody else.
 *
 * WHO ENDS UP HERE. More people than the phrasing suggests: an invitation sent
 * but never accepted, a member removed from the organisation, an account made
 * on the dashboard and never added to a club, or a social sign-in whose email
 * did not match an outstanding invitation and therefore minted a fresh user
 * with nothing attached.
 *
 * WHAT IT DOES NOT DO. Offer to create a club. Provisioning is a billing and
 * agreement decision that happens on the dashboard, and an app that appeared to
 * make clubs would produce empty ones with no subscription behind them.
 */

import { StyleSheet, View } from 'react-native';

import { links, openLink } from '../lib/links';
import { space } from '../theme/tokens';
import { Button } from './Button';
import { Panel, Screen, Spacer } from './Layout';
import { Body, Display, Label } from './Text';

export function NoClub({ email, onSignOut }: { email: string | null; onSignOut: () => void }) {
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.centre}>
        <Label>RiseUp</Label>
        <Spacer size={space[3]} />
        <Display>You are not in a club yet</Display>
        <Spacer size={space[3]} />
        <Body tone={2}>
          {email === null
            ? 'This account is signed in, but it has not been added to a club.'
            : `${email} is signed in, but has not been added to a club.`}
        </Body>
        <Spacer size={space[3]} />
        <Body tone={2}>
          A club admin adds people from the RiseUp dashboard. Once they add you, sign out and back
          in here and everything will be waiting.
        </Body>

        <Spacer size={space[5]} />
        <Panel>
          <Label>If you were expecting access</Label>
          <Spacer size={space[2]} />
          <Body tone={3} size={13}>
            Check whether the invitation went to a different email address than the one you signed
            in with. That is the usual reason — signing in with Apple or Google can create a new
            account if the address does not match the invitation.
          </Body>
        </Panel>

        <Spacer size={space[5]} />
        {/* Sign out is the primary action, because it is the one that leads
            anywhere: signing in as the invited address is the fix in most
            cases, and staying here does nothing. */}
        <Button label="Sign out" onPress={onSignOut} block />
        <Spacer size={space[3]} />
        <Button
          label="Contact support"
          onPress={() => void openLink(links.support)}
          variant="secondary"
          block
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: space[7],
  },
  option: {
    marginBottom: space[3],
  },
});

/**
 * More than one club, and nobody has said which.
 *
 * Rare, and worth asking about rather than guessing: picking the first would
 * work invisibly and be wrong about half the time, and the failure is silent —
 * an analyst reading last Saturday's match for a club they do not coach.
 */
export function ChooseClub({
  options,
  onChoose,
  onSignOut,
}: {
  options: Array<{ id: string; name: string }>;
  onChoose: (id: string) => void;
  onSignOut: () => void;
}) {
  return (
    <Screen scroll edges={['top', 'bottom']}>
      <Spacer size={space[7]} />
      <Label>RiseUp</Label>
      <Spacer size={space[3]} />
      <Display>Which club?</Display>
      <Spacer size={space[3]} />
      <Body tone={2}>You are a member of more than one. You can switch later in settings.</Body>

      <Spacer size={space[5]} />
      {options.map((option) => (
        <View key={option.id} style={styles.option}>
          <Button label={option.name} onPress={() => onChoose(option.id)} variant="secondary" block />
        </View>
      ))}

      <Spacer size={space[5]} />
      <Button label="Sign out" onPress={onSignOut} variant="ghost" block />
      <Spacer size={space[7]} />
    </Screen>
  );
}
