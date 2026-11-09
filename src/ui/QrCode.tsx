/**
 * A QR code drawn with plain Views: no SVG dependency for one square of
 * squares. `qrcode` computes the module matrix; each dark module is a View.
 */

import QRCode from 'qrcode';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const modules = useMemo(() => QRCode.create(value, { errorCorrectionLevel: 'M' }).modules, [value]);
  const count = modules.size;
  const quiet = 4;                              // the spec's quiet zone, in modules
  const cell = size / (count + quiet * 2);
  const rows = [];
  for (let y = 0; y < count; y += 1) {
    const cells = [];
    for (let x = 0; x < count; x += 1) {
      cells.push(
        <View key={x} style={{ width: cell, height: cell,
                               backgroundColor: modules.get(x, y) ? '#000' : '#fff' }} />,
      );
    }
    rows.push(<View key={y} style={styles.row}>{cells}</View>);
  }
  return (
    <View style={[styles.frame, { width: size, height: size, padding: cell * quiet }]}
          accessibilityRole="image" accessibilityLabel="Code to pair the second phone">
      {rows}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#fff' },
  row: { flexDirection: 'row' },
});
