/**
 * Layout primitives: Screen, Panel, Rule, Row, Spacer.
 *
 * The grammar this system uses is hairlines, not floating cards. The surface
 * steps are close together on purpose (bg0 → bg1 is four points of lightness),
 * so what separates two regions is a 1px rule, not a shadow and a gap. Panel
 * exists for the cases where a genuine container is meant — a metric block, a
 * job row — and it is intentionally undramatic.
 */

import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { line, radius, screenPadding, space, surface } from '../theme/tokens';

interface ScreenProps {
  children: ReactNode;
  /**
   * Wrap the content in a ScrollView. Off by default: a screen that scrolls
   * when it does not need to hides the fact that its content overflowed.
   */
  scroll?: boolean;
  /** Drop the horizontal gutter — for full-bleed lists that pad their own rows. */
  bleed?: boolean;
  /**
   * Which edges the safe area applies to. A screen inside a tab navigator
   * must not claim the bottom edge; the tab bar already owns it.
   */
  edges?: ReadonlyArray<'top' | 'bottom' | 'left' | 'right'>;
  style?: ViewStyle;
}

export function Screen({
  children,
  scroll = false,
  bleed = false,
  edges = ['top'],
  style,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const padding = bleed ? undefined : { paddingHorizontal: screenPadding };

  if (scroll) {
    return (
      <SafeAreaView style={[styles.screen, style]} edges={edges}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[padding, { paddingBottom: insets.bottom + space[8] }]}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, padding, style]} edges={edges}>
      {children}
    </SafeAreaView>
  );
}

interface PanelProps extends ViewProps {
  children: ReactNode;
  /** Lift to bg2 — for a pressed or selected state. */
  raised?: boolean;
  /** Drop the outline and keep only the fill. */
  flat?: boolean;
}

export function Panel({ children, raised = false, flat = false, style, ...rest }: PanelProps) {
  return (
    <View
      {...rest}
      style={[styles.panel, raised ? styles.panelRaised : null, flat ? styles.panelFlat : null, style]}
    >
      {children}
    </View>
  );
}

/** The hairline that carries structure. Not a border — a divider. */
export function Rule({ inset = 0, style }: { inset?: number; style?: ViewStyle }) {
  return <View style={[styles.rule, inset === 0 ? null : { marginLeft: inset }, style]} />;
}

/** A horizontal row with vertical centring. The `gap` is a token, not a number. */
export function Row({
  children,
  gap = space[3],
  align = 'center',
  style,
  ...rest
}: ViewProps & {
  children: ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
}) {
  return (
    <View {...rest} style={[styles.row, { gap, alignItems: align }, style]}>
      {children}
    </View>
  );
}

/** Vertical space. Exists so screens never write a bare marginTop. */
export function Spacer({ size = space[4] }: { size?: number }) {
  return <View style={{ height: size }} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: {
    flex: 1,
    backgroundColor: surface.bg0,
  },
  panel: {
    backgroundColor: surface.bg1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: line.rule,
    padding: space[4],
  },
  panelRaised: {
    backgroundColor: surface.bg2,
    borderColor: line.border,
  },
  panelFlat: {
    borderWidth: 0,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: line.rule,
  },
  row: {
    flexDirection: 'row',
  },
});
