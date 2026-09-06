/**
 * Status primitives: StatusDot, Pill, ConfidenceBand.
 *
 * These carry the app's one legitimate use of colour-as-information, so they
 * are also the place where the reservation is most easily broken. The rule the
 * design system sets — at most one `signal` element per viewport — is enforced
 * by taste, not by code, but keeping every status affordance in one file makes
 * it obvious when a screen has started spending the accent on decoration.
 *
 * Colour is never the only channel. Every state here also carries a word, per
 * WCAG 1.4.1: a green dot beside "Ready" and an amber dot beside "Processing"
 * are distinguishable without colour vision because the label says which.
 */

import { StyleSheet, View, type ViewStyle } from 'react-native';

import { confidence, ink, line, radius, role, signal, space, surface } from '../theme/tokens';
import { Label } from './Text';

export type Tone = 'neutral' | 'live' | 'warn' | 'error' | 'info';

const toneColors: Record<Tone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: ink.mute, bg: surface.bg2, border: line.border },
  live: { fg: signal.base, bg: signal.bg, border: signal.dim },
  warn: { fg: role.amber.fg, bg: role.amber.bg, border: role.amber.border },
  error: { fg: role.red.fg, bg: role.red.bg, border: role.red.border },
  info: { fg: role.blue.fg, bg: role.blue.bg, border: role.blue.border },
};

/**
 * A 6px dot. Used beside a job state, a device link, a recording indicator.
 *
 * Decorative by itself — it is always adjacent to text that says the same
 * thing — so it is hidden from the accessibility tree rather than announced
 * as an unlabelled image.
 */
export function StatusDot({ tone = 'neutral', style }: { tone?: Tone; style?: ViewStyle }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.dot, { backgroundColor: toneColors[tone].fg }, style]}
    />
  );
}

/**
 * A tinted, outlined chip. States, counts, categories.
 *
 * `numberOfLines={1}` is deliberate: a pill that wraps to two lines stops
 * being a pill and starts being a paragraph in a box, and it drags the row
 * height with it.
 */
export function Pill({
  label,
  tone = 'neutral',
  dot = false,
  style,
}: {
  label: string;
  tone?: Tone;
  /** Prefix with a status dot. For live/changing states only. */
  dot?: boolean;
  style?: ViewStyle;
}) {
  const c = toneColors[tone];
  return (
    <View style={[styles.pill, { backgroundColor: c.bg, borderColor: c.border }, style]}>
      {dot ? <StatusDot tone={tone} /> : null}
      <Label color={c.fg} numberOfLines={1}>
        {label}
      </Label>
    </View>
  );
}

/**
 * How much to trust a number. The vocabulary is fixed by the design system:
 * green is a confident measurement, amber is degraded, red is not usable.
 *
 * On this app the honest use is the data-quality banner in the match summary —
 * intervals where only one camera contributed, or an abnormal sync residual.
 * A number the pipeline is unsure of should say so on the phone, because the
 * phone is where a coach forms their first impression of it.
 */
export function ConfidenceBand({
  level,
  label,
  style,
}: {
  level: 'green' | 'amber' | 'red';
  label: string;
  style?: ViewStyle;
}) {
  const c = confidence[level];
  return (
    <View
      accessibilityRole="text"
      style={[styles.band, { backgroundColor: c.bg, borderColor: c.border }, style]}
    >
      <View style={[styles.bandEdge, { backgroundColor: c.fg }]} />
      <Label color={c.fg} style={styles.bandLabel}>
        {label}
      </Label>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 6,
    height: 6,
    borderRadius: radius.full,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    paddingVertical: space.half + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  bandEdge: {
    width: 3,
    alignSelf: 'stretch',
  },
  bandLabel: {
    paddingVertical: space[2],
    paddingHorizontal: space[3],
    flex: 1,
  },
});
