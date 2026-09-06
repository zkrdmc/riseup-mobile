/**
 * Button.
 *
 * Three variants and no more:
 *   primary   — a bone fill on near-black. NOT a mint fill. That is the point
 *               of reserving the accent: the most prominent control on the
 *               screen does not need to spend the one colour that means
 *               "measured, live, connected".
 *   secondary — outlined, ink text.
 *   ghost     — text only, for the second action in a pair.
 *
 * Pressable, not TouchableOpacity: TouchableOpacity is a legacy wrapper that
 * animates opacity on the JS thread, and its hit target is whatever the child
 * happens to be. Every button here meets the 44pt minimum whether or not its
 * label is short.
 */

import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { ink, line, minTouchTarget, radius, space, surface } from '../theme/tokens';
import { BodyStrong } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  /** Shows a spinner and blocks presses. Distinct from `disabled` for a11y. */
  busy?: boolean;
  /** Stretch to the container width. Use for the primary action on a screen. */
  block?: boolean;
  icon?: ReactNode;
  /** Spoken instead of the label when the label alone is not self-describing. */
  accessibilityLabel?: string;
  /** What happens when this is pressed, if it is not obvious from the label. */
  accessibilityHint?: string;
  style?: ViewStyle;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  block = false,
  icon,
  accessibilityLabel,
  accessibilityHint,
  style,
}: ButtonProps) {
  const inert = disabled || busy;

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy }}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant],
        block ? styles.block : null,
        pressed ? pressedStyles[variant] : null,
        inert ? styles.inert : null,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={variant === 'primary' ? surface.bg0 : ink[1]} />
      ) : (
        <View style={styles.content}>
          {icon}
          <BodyStrong color={labelColor[variant]}>{label}</BodyStrong>
        </View>
      )}
    </Pressable>
  );
}

const labelColor: Record<Variant, string> = {
  primary: surface.bg0,
  secondary: ink[1],
  ghost: ink[2],
};

const styles = StyleSheet.create({
  base: {
    minHeight: minTouchTarget,
    paddingHorizontal: space[5],
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  block: {
    alignSelf: 'stretch',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  inert: {
    opacity: 0.4,
  },
});

const variantStyles = StyleSheet.create({
  primary: {
    backgroundColor: ink[1],
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: line.border,
  },
  ghost: {
    backgroundColor: 'transparent',
    paddingHorizontal: space[3],
  },
});

const pressedStyles = StyleSheet.create({
  primary: {
    backgroundColor: ink[2],
  },
  secondary: {
    backgroundColor: surface.bg2,
    borderColor: line.borderHi,
  },
  ghost: {
    backgroundColor: surface.bg1,
  },
});
