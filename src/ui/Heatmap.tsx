/**
 * Heatmap thumbnail (§7).
 *
 * Plain Views, no SVG and no chart library. The grid is at most a few hundred
 * cells and the pitch is eight rectangles; pulling in a renderer for that
 * would add a native dependency and a frame of layout cost to a screen whose
 * whole promise is that it opens instantly.
 *
 * The pitch sits BELOW the page canvas (`pitch.bg` is darker than `bg0`) so
 * the markings read as inset rather than printed on a card — the same
 * treatment the dashboard uses, and the reason a heatmap does not look like a
 * sticker dropped onto the screen.
 *
 * COLOUR CHOICE. Occupancy is rendered as opacity of a single ink, not as a
 * rainbow ramp. A red-to-blue heat scale is unreadable to a red-green
 * colour-blind viewer, and it implies categories where there is one continuous
 * quantity. One hue at varying opacity says "more time here" without saying
 * anything it cannot support.
 */

import { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { ink, pitch, radius, space } from '../theme/tokens';
import { Body } from './Text';

/** A real pitch is 105 × 68 m. Everything here is proportional to that. */
const ASPECT = 105 / 68;

interface HeatmapProps {
  /**
   * Row-major occupancy grid from the API, already parsed from JSON.
   * Null when the pipeline produced none — a short clip, or a track seen for
   * too few frames.
   */
  grid: number[][] | null;
  style?: ViewStyle;
}

export function Heatmap({ grid, style }: HeatmapProps) {
  // Normalising against the grid's own maximum, not a global one: a
  // substitute who played 20 minutes should still show a readable shape, and
  // an absolute scale would render them as an almost-blank pitch.
  const max = useMemo(() => {
    if (grid === null) {
      return 0;
    }
    let m = 0;
    for (const row of grid) {
      for (const cell of row) {
        if (cell > m) {
          m = cell;
        }
      }
    }
    return m;
  }, [grid]);

  return (
    <View style={[styles.pitch, style]}>
      <PitchMarkings />

      {grid === null || max === 0 ? (
        <View style={styles.empty}>
          <Body tone="subtle" size={13}>
            No position data for this player.
          </Body>
        </View>
      ) : (
        <View
          style={styles.grid}
          accessibilityRole="image"
          accessibilityLabel="Heatmap of where this player spent their time on the pitch"
        >
          {grid.map((row, y) => (
            <View key={y} style={styles.gridRow}>
              {row.map((cell, x) => (
                <View
                  key={x}
                  style={[
                    styles.cell,
                    // Capped below 1: a fully opaque cell hides the pitch
                    // markings under it, and the markings are what make the
                    // shape mean anything.
                    { opacity: (cell / max) * 0.78 },
                  ]}
                />
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Halfway line, centre circle, two penalty boxes, two six-yard boxes.
 *
 * Proportions are the real ones — the penalty area is 16.5 m deep on a 105 m
 * pitch, so 15.7% — because a heatmap read against a wrongly-proportioned box
 * is a heatmap that lies about where somebody was standing.
 */
function PitchMarkings() {
  return (
    <View style={FILL} pointerEvents="none">
      <View style={styles.halfway} />
      <View style={styles.centreCircle} />

      <View style={[styles.penaltyArea, styles.penaltyAreaLeft]} />
      <View style={[styles.penaltyArea, styles.penaltyAreaRight]} />
      <View style={[styles.goalArea, styles.goalAreaLeft]} />
      <View style={[styles.goalArea, styles.goalAreaRight]} />
    </View>
  );
}

/** RN's `StyleSheet.absoluteFill` is a registered style id, not a spreadable
 *  object, so a literal is the only way to compose it into another style. */
const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  pitch: {
    width: '100%',
    aspectRatio: ASPECT,
    backgroundColor: pitch.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: pitch.lineDim,
    overflow: 'hidden',
  },
  empty: {
    ...FILL,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
  },
  grid: {
    ...FILL,
  },
  gridRow: {
    flex: 1,
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
    backgroundColor: ink[1],
  },

  halfway: {
    position: 'absolute',
    left: '50%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: pitch.line,
  },
  centreCircle: {
    position: 'absolute',
    // 9.15 m radius on a 68 m width → 26.9% of the height, so 13.4% each way.
    left: '43.6%',
    top: '36.6%',
    width: '12.8%',
    height: '26.9%',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: pitch.line,
  },
  penaltyArea: {
    position: 'absolute',
    // 16.5 m of 105 m deep, 40.3 m of 68 m wide.
    width: '15.7%',
    height: '59.3%',
    top: '20.4%',
    borderWidth: 1,
    borderColor: pitch.line,
  },
  penaltyAreaLeft: { left: 0 },
  penaltyAreaRight: { right: 0 },
  goalArea: {
    position: 'absolute',
    // 5.5 m of 105 m deep, 18.3 m of 68 m wide.
    width: '5.2%',
    height: '26.9%',
    top: '36.6%',
    borderWidth: 1,
    borderColor: pitch.lineDim,
  },
  goalAreaLeft: { left: 0 },
  goalAreaRight: { right: 0 },
});
