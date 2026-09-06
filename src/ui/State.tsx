/**
 * The three states every screen has and most codebases forget: empty, loading,
 * error.
 *
 * The PRD is explicit that a notification must never arrive without a
 * resolvable action (§6). The same rule applies to a screen: an empty match
 * list that says "No matches" tells a coach nothing about what to do next, and
 * an error that shows a job id tells them less than nothing. Every state here
 * takes an action, and `ErrorState` takes a machine code so support can be
 * given something to search for without putting it in the sentence the coach
 * reads.
 */

import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ink, space } from '../theme/tokens';
import { Button } from './Button';
import { Spacer } from './Layout';
import { Body, BodyStrong, Label } from './Text';

interface EmptyStateProps {
  /** What is not here. Five words or fewer. */
  title: string;
  /** Why, and what would change it. One sentence. */
  body: string;
  action?: { label: string; onPress: () => void };
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <View style={styles.centre}>
      <BodyStrong style={styles.centreText}>{title}</BodyStrong>
      <Spacer size={space[2]} />
      <Body tone={3} style={styles.centreText}>
        {body}
      </Body>
      {action === undefined ? null : (
        <>
          <Spacer size={space[5]} />
          <Button label={action.label} onPress={action.onPress} variant="secondary" />
        </>
      )}
    </View>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <View style={styles.centre} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={ink.mute} />
    </View>
  );
}

interface ErrorStateProps {
  /**
   * The human string. This is what the coach reads, so it names a cause they
   * can act on — "one camera stopped recording at 62'", not "job failed".
   */
  message: string;
  /**
   * The stable machine code from the API error envelope. Shown small and
   * monospaced underneath, for support. Never the headline.
   */
  code?: string;
  onRetry?: () => void;
}

export function ErrorState({ message, code, onRetry }: ErrorStateProps) {
  return (
    <View style={styles.centre}>
      <Body tone={2} style={styles.centreText}>
        {message}
      </Body>
      {code ? (
        <>
          <Spacer size={space[2]} />
          <Label tone="subtle">{code}</Label>
        </>
      ) : null}
      {onRetry === undefined ? null : (
        <>
          <Spacer size={space[5]} />
          <Button label="Try again" onPress={onRetry} variant="secondary" />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[6],
    paddingVertical: space[7],
  },
  centreText: {
    textAlign: 'center',
  },
});
