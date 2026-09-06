/**
 * A measured length, with the uncertainty that belongs to it.
 *
 * WHY THE OPERATOR PICKS A METHOD RATHER THAN A SIGMA. Every quantity in the
 * survey carries an uncertainty, and something has to supply it. Asking a
 * volunteer for a standard deviation gets you a blank look or a made-up
 * number; asking how they measured gets you an honest answer in one tap,
 * because they know whether they used a tape or paced it out.
 *
 * The mapping from method to sigma is a product decision and lives here, in
 * one place, rather than being invented per screen. The numbers are
 * deliberately pessimistic: a survey that overstates its own precision makes
 * the baseline cross-check fire on honest disagreement and stop firing on real
 * mistakes, which is the exact opposite of what it is for.
 */

import { useCallback } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ink, line, minTouchTarget, radius, space, surface, type } from '../theme/tokens';
import { Row, Spacer } from './Layout';
import { Body, Label, Metric } from './Text';

export type MeasurementMethod = 'tape' | 'laser' | 'paced' | 'estimated';

/**
 * One-sigma uncertainty in metres, by method.
 *
 * `tape`     — a real tape measure, read properly. A few centimetres over a
 *              30 m run, mostly from sag and from where exactly "the camera"
 *              is.
 * `laser`    — a rangefinder. Better than the tape and limited by aiming, not
 *              by the instrument.
 * `paced`    — stepped out. About 3% of the distance for someone who has
 *              calibrated their pace, which nobody has, so 5%.
 * `estimated`— looked at it. Recorded, permitted, and the validator will
 *              usually have something to say.
 */
const SIGMA_BY_METHOD: Record<MeasurementMethod, (value: number) => number> = {
  tape: () => 0.03,
  laser: () => 0.01,
  paced: (v) => Math.max(0.3, Math.abs(v) * 0.05),
  estimated: (v) => Math.max(1.0, Math.abs(v) * 0.15),
};

export function sigmaFor(method: MeasurementMethod, value: number): number {
  return SIGMA_BY_METHOD[method](value);
}

const METHOD_LABELS: Array<{ method: MeasurementMethod; label: string }> = [
  { method: 'tape', label: 'Tape' },
  { method: 'laser', label: 'Laser' },
  { method: 'paced', label: 'Paced' },
  { method: 'estimated', label: 'Guessed' },
];

interface MeasurementInputProps {
  label: string;
  /** One sentence on what exactly to measure. This is where accuracy is won. */
  hint?: string;
  value: number | null;
  method: MeasurementMethod;
  onChange: (value: number | null, method: MeasurementMethod) => void;
  unit?: string;
  /** Allow negatives — used by the signed distance along the touchline. */
  allowNegative?: boolean;
}

export function MeasurementInput({
  label,
  hint,
  value,
  method,
  onChange,
  unit = 'm',
  allowNegative = false,
}: MeasurementInputProps) {
  const onChangeText = useCallback(
    (text: string) => {
      // Accept the comma decimal separator: the app is used in Morocco and a
      // French or Arabic keyboard offers a comma, so rejecting it means a
      // field that silently will not accept "30,5".
      const normalised = text.replace(',', '.').trim();
      if (normalised === '' || normalised === '-') {
        onChange(null, method);
        return;
      }
      const parsed = Number.parseFloat(normalised);
      if (Number.isNaN(parsed)) {
        return;
      }
      onChange(allowNegative ? parsed : Math.abs(parsed), method);
    },
    [onChange, method, allowNegative],
  );

  const sigma = value === null ? null : sigmaFor(method, value);

  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      {hint === undefined ? null : (
        <>
          <Spacer size={space[1]} />
          <Body tone={3} size={13}>
            {hint}
          </Body>
        </>
      )}
      <Spacer size={space[2]} />

      <Row gap={space[2]}>
        <TextInput
          value={value === null ? '' : String(value)}
          onChangeText={onChangeText}
          // `decimal-pad` has no minus key, so a signed field needs the full
          // numeric pad or the operator cannot enter the west-side camera.
          keyboardType={allowNegative ? 'numbers-and-punctuation' : 'decimal-pad'}
          placeholder="—"
          placeholderTextColor={ink.subtle}
          style={styles.input}
          accessibilityLabel={label}
          returnKeyType="done"
        />
        <Label tone={3} style={styles.unit}>
          {unit}
        </Label>
      </Row>

      <Spacer size={space[3]} />
      <Label tone="subtle">How was it measured?</Label>
      <Spacer size={space[2]} />
      <Row gap={space[2]} style={styles.methods}>
        {METHOD_LABELS.map((m) => (
          <Pressable
            key={m.method}
            onPress={() => onChange(value, m.method)}
            accessibilityRole="radio"
            accessibilityState={{ selected: method === m.method }}
            accessibilityLabel={m.label}
            style={[styles.method, method === m.method ? styles.methodSelected : null]}
          >
            <Label tone={method === m.method ? 1 : 'mute'}>{m.label}</Label>
          </Pressable>
        ))}
      </Row>

      {sigma === null ? null : (
        <>
          <Spacer size={space[2]} />
          {/* Shown because it is what the cross-checks actually use. An
              operator who sees ±1.5 m appear when they tap "Guessed" tends to
              go and find the tape. */}
          <Metric size={13} tone="subtle">
            {`± ${sigma < 0.1 ? sigma.toFixed(2) : sigma.toFixed(1)} ${unit}`}
          </Metric>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    marginBottom: space[5],
  },
  input: {
    flex: 1,
    height: 48,
    backgroundColor: surface.bg1,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    color: ink[1],
    fontSize: type.lg,
  },
  unit: {
    width: 24,
  },
  methods: {
    flexWrap: 'wrap',
  },
  method: {
    minHeight: minTouchTarget - space[2],
    justifyContent: 'center',
    paddingHorizontal: space[3],
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: line.rule,
    backgroundColor: surface.bg1,
  },
  methodSelected: {
    borderColor: line.borderHi,
    backgroundColor: surface.bg2,
  },
});
