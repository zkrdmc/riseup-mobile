/**
 * Text primitives.
 *
 * Every string in this app goes through one of these. Raw <Text> with an
 * inline style is how a fourth font size and a sixth grey get into a codebase,
 * and the web product's tokens file documents in detail what that cost there
 * (fourteen greys, thirty-eight uses of 9px). The set is deliberately small:
 * if a screen needs something outside it, the screen is probably wrong.
 *
 * The division of labour is the one the design system defines:
 *   Display — Archivo. Screen titles, player names, scorelines.
 *   Body    — DM Sans. Prose, list rows, anything read as language.
 *   Label   — DM Mono, uppercase, tracked. The instrument voice: field names,
 *             units, section headers, states.
 *   Metric  — DM Mono, tabular. Anything that is a measured number.
 */

import { Text as RNText, StyleSheet, type TextProps as RNTextProps } from 'react-native';

import { ink, font, leading, tracking, type } from '../theme/tokens';

type Tone = keyof typeof ink;

interface BaseProps extends RNTextProps {
  /** Which step of the ink ramp. Defaults differ per primitive. */
  tone?: Tone;
  /** Override the scale step. Use a token, never a raw number. */
  size?: number;
  color?: string;
}

/**
 * `flexShrink: 1` on every piece of text in the app, and it is not cosmetic.
 *
 * React Native lays a `Text` out at its intrinsic width inside a
 * `flexDirection: 'row'` container and does NOT shrink it by default, so any
 * row holding a label and a sentence pushes the sentence off the right edge —
 * the text is not clipped, it is simply drawn outside the screen, and nothing
 * in the layout reports a problem. It showed up on the sign-in footer as a
 * sentence ending mid-word, and the same pattern is in every `Row` in the app.
 *
 * Shrinking lets the text wrap inside the space it actually has. Outside a row
 * this changes nothing: a Text in a column already fills the width, so there
 * is no overflow to shrink away.
 */
const SHRINK = { flexShrink: 1 } as const;

function useTextStyle(
  base: object,
  { tone, size, color, style }: BaseProps & { style?: RNTextProps['style'] },
) {
  return [
    SHRINK,
    base,
    tone === undefined ? null : { color: ink[tone] },
    size === undefined ? null : { fontSize: size },
    color === undefined ? null : { color },
    style,
  ];
}

/** Archivo 600. Screen titles, player names, the one big thing on a screen. */
export function Display({ tone, size, color, style, ...rest }: BaseProps) {
  return <RNText {...rest} style={useTextStyle(styles.display, { tone, size, color, style })} />;
}

/** DM Sans. The default for anything read as language. */
export function Body({ tone, size, color, style, ...rest }: BaseProps) {
  return <RNText {...rest} style={useTextStyle(styles.body, { tone, size, color, style })} />;
}

/** DM Sans 500. An emphasised row, a button, a selected item. */
export function BodyStrong({ tone, size, color, style, ...rest }: BaseProps) {
  return <RNText {...rest} style={useTextStyle(styles.bodyStrong, { tone, size, color, style })} />;
}

/**
 * DM Mono, uppercase, tracked. Field names, units, section headers.
 *
 * Callers pass normal-case strings; the uppercasing is a style decision and
 * lives here, so a screen reader is handed "Distance" rather than "DISTANCE"
 * (which VoiceOver spells out letter by letter).
 */
export function Label({ tone = 'mute', size, color, style, ...rest }: BaseProps) {
  return <RNText {...rest} style={useTextStyle(styles.label, { tone, size, color, style })} />;
}

/**
 * DM Mono, tabular figures. Every measured number.
 *
 * `fontVariant: ['tabular-nums']` is the point: a distance that ticks from
 * 9.8 to 10.1 km must not shift the columns around it, and a countdown of
 * minutes-of-recording-left that jitters reads as unreliable.
 */
export function Metric({ tone = 1, size, color, style, ...rest }: BaseProps) {
  return <RNText {...rest} style={useTextStyle(styles.metric, { tone, size, color, style })} />;
}

const styles = StyleSheet.create({
  display: {
    fontFamily: font.display,
    fontSize: type.display,
    lineHeight: type.display * leading.tight,
    letterSpacing: tracking.display,
    color: ink[1],
  },
  body: {
    fontFamily: font.sans,
    fontSize: type.ui,
    lineHeight: type.ui * leading.normal,
    color: ink[2],
  },
  bodyStrong: {
    fontFamily: font.sansMedium,
    fontSize: type.ui,
    lineHeight: type.ui * leading.snug,
    color: ink[1],
  },
  label: {
    fontFamily: font.mono,
    fontSize: type.micro,
    lineHeight: type.micro * leading.snug,
    letterSpacing: tracking.label,
    textTransform: 'uppercase',
    color: ink.mute,
  },
  metric: {
    fontFamily: font.monoMedium,
    fontSize: type.lg,
    lineHeight: type.lg * leading.tight,
    fontVariant: ['tabular-nums'],
    color: ink[1],
  },
});
