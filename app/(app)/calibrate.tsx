/**
 * Calibrate the pitch for one camera.
 *
 * Get one frame through the camera that will film the match, mark the pitch
 * markings visible in it, and find out whether it can be solved from — before
 * anybody films ninety minutes that cannot be analysed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THE OPERATOR TAPS INSTEAD OF THE APP DETECTING
 * ══════════════════════════════════════════════════════════════════════════
 * PRD §4.2: "a viewfinder overlay that silently mis-solves is worse than one
 * that asks". A landmark model on a worn municipal pitch will find a penalty
 * spot in a bare patch and a goal line in a shadow, and a homography built on
 * those is wrong by metres while looking entirely healthy. The taps are the
 * calibration. `framing/detector.ts` leaves room for a model to answer "could
 * this view be solved from" later, and never to answer "where are the points".
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TWO ANSWERS THIS SCREEN GIVES, AND WHY THEY ARE SEPARATE
 * ══════════════════════════════════════════════════════════════════════════
 * "Move the camera" and "re-tap that point" are different instructions and a
 * screen that blurs them wastes a Saturday. So the verdict names which one it
 * is: a view that cannot be solved from at all (too few markings, all bunched
 * at one end, strung along a line), or a view that is fine with one tap in the
 * wrong place. `calibration/solve.ts` computes both and never reports the
 * second while the first is still failing — a set of points along the halfway
 * line fits perfectly and is unsolvable.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { pitchLandmarks, type Landmark } from '../../src/capture/framing/landmarks';
import { cameraStore } from '../../src/capture/devices/store';
import type { SavedCamera } from '../../src/capture/devices/types';
import { calibrationStore } from '../../src/capture/calibration/store';
import {
  assessSolvability,
  framesDisagree,
  type Correspondence,
  type SolveVerdict,
} from '../../src/capture/calibration/solve';
import {
  fromDeviceCamera,
  fromFile,
  fromLibrary,
  type CalibrationFrame,
} from '../../src/capture/calibration/source';
import {
  confidence,
  ink,
  line,
  radius,
  role,
  signal,
  space,
  surface,
  type,
} from '../../src/theme/tokens';
import { Button } from '../../src/ui/Button';
import { Panel, Row, Rule, Screen, Spacer } from '../../src/ui/Layout';
import { Pill } from '../../src/ui/Status';
import { Body, BodyStrong, Display, Label } from '../../src/ui/Text';

const APP_VERSION = '0.1.0';

/** Pitch dimensions until the survey supplies measured ones. */
const DEFAULT_LENGTH_M = 105;
const DEFAULT_WIDTH_M = 68;

export default function CalibrateScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ cameraId?: string }>();

  const cameras = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot);
  const camera = useMemo<SavedCamera | null>(
    () => cameras.find((c) => c.id === params.cameraId) ?? null,
    [cameras, params.cameraId],
  );

  const [frame, setFrame] = useState<CalibrationFrame | null>(null);
  const [taps, setTaps] = useState<Correspondence[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Width the frame is drawn at, so a tap can be put back into image pixels. */
  const [drawnWidth, setDrawnWidth] = useState(0);

  useEffect(() => {
    void cameraStore.hydrate();
    void calibrationStore.hydrate();
  }, []);

  const landmarks = useMemo(
    () => pitchLandmarks(DEFAULT_LENGTH_M, DEFAULT_WIDTH_M),
    [],
  );

  const verdict = useMemo<SolveVerdict | null>(() => {
    if (frame === null) {
      return null;
    }
    return assessSolvability({
      correspondences: taps,
      landmarks,
      imageWidth: frame.width,
      imageHeight: frame.height,
    });
  }, [frame, taps, landmarks]);

  /* ── Getting a frame ───────────────────────────────────────────────────── */

  const load = useCallback(async (get: () => Promise<Awaited<ReturnType<typeof fromFile>>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await get();
      if (!result.ok) {
        // A cancelled picker is not a failure and must not be shown as one.
        if (result.failure.reason !== 'cancelled') {
          setError(result.failure.message);
        }
        return;
      }
      setFrame(result.frame);
      // Taps belong to the frame they were made on. Keeping them across a new
      // frame would silently carry marks from one view onto another.
      setTaps([]);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  }, []);

  /* ── Placing a point ───────────────────────────────────────────────────── */

  const placeTap = useCallback(
    (viewX: number, viewY: number) => {
      if (frame === null || selected === null || drawnWidth <= 0) {
        return;
      }
      // The container is laid out at the frame's own aspect ratio, so there is
      // no letterboxing to unpick and one scale factor covers both axes.
      const scale = frame.width / drawnWidth;
      const next: Correspondence = {
        landmarkId: selected,
        imageX: viewX * scale,
        imageY: viewY * scale,
      };
      setTaps((current) => [
        ...current.filter((c) => c.landmarkId !== selected),
        next,
      ]);
      setSelected(null);
    },
    [frame, selected, drawnWidth],
  );

  const clearTap = useCallback((landmarkId: string) => {
    setTaps((current) => current.filter((c) => c.landmarkId !== landmarkId));
  }, []);

  /* ── Saving ────────────────────────────────────────────────────────────── */

  const save = useCallback(async () => {
    if (verdict === null || !verdict.solvable || camera === null || frame === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Held on the phone, against the camera. A homography belongs to a
      // viewpoint and the server files it as `venue_cameras.h_matrix`, keyed
      // by venue — which this screen does not have, because choosing a venue
      // belongs to the survey. Posting anyway would mean inventing a venue to
      // satisfy a foreign key. See `calibration/store.ts`.
      calibrationStore.save({
        cameraId: camera.id,
        homography: verdict.homography ?? [],
        imageWidth: frame.width,
        imageHeight: frame.height,
        pitchLengthM: DEFAULT_LENGTH_M,
        pitchWidthM: DEFAULT_WIDTH_M,
        rmsErrorPx: verdict.rmsErrorPx ?? 0,
        solvedBy: verdict.solvedBy ?? 'least_squares',
        pointCount: taps.length,
        solvedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        uploadedToVenueCameraId: null,
      });
      router.back();
    } finally {
      setBusy(false);
    }
  }, [verdict, camera, frame, taps.length, router]);

  const marked = new Set(taps.map((t) => t.landmarkId));
  const worstId = verdict?.worstPoint?.landmarkId ?? null;

  return (
    <Screen scroll edges={['top', 'bottom']}>
      <Spacer size={space[4]} />
      <Label>Calibration</Label>
      <Spacer size={space[3]} />
      <Display>Calibrate the pitch</Display>
      <Spacer size={space[3]} />
      <Body tone={2}>
        {camera === null
          ? 'One frame through the camera that will film the match, with the pitch markings marked on it.'
          : `One frame through ${camera.label}, with the pitch markings marked on it.`}
      </Body>

      <Spacer size={space[5]} />

      {frame === null ? (
        <SourceChoice busy={busy} onPick={load} />
      ) : (
        <>
          <FramePanel
            frame={frame}
            taps={taps}
            landmarks={landmarks}
            worstId={worstId}
            drawnWidth={drawnWidth}
            selected={selected}
            onLayout={(e: LayoutChangeEvent) => { setDrawnWidth(e.nativeEvent.layout.width); }}
            onTap={placeTap}
          />

          <Spacer size={space[4]} />
          <Verdict verdict={verdict} taps={taps.length} />

          {camera !== null ? <CaptureMismatch camera={camera} frame={frame} /> : null}

          <Spacer size={space[5]} />
          <Label>{selected === null ? 'Pick a marking, then tap it in the frame' : 'Now tap it in the frame'}</Label>
          <Spacer size={space[3]} />
          <LandmarkList
            landmarks={landmarks}
            marked={marked}
            selected={selected}
            worstId={worstId}
            onSelect={setSelected}
            onClear={clearTap}
          />

          <Spacer size={space[5]} />
          <Body tone={3} style={styles.fine}>
            Saved to this phone against {camera?.label ?? 'this camera'}. It is filed against the
            ground once the survey says where the camera was standing — a homography is only
            valid for the viewpoint it was solved from.
          </Body>
          <Spacer size={space[3]} />
          <Button
            label="Save this calibration"
            onPress={() => void save()}
            disabled={verdict === null || !verdict.solvable}
            busy={busy}
            block
          />
          <Spacer size={space[3]} />
          <Button
            label="Use a different frame"
            onPress={() => { setFrame(null); setTaps([]); setSelected(null); }}
            variant="secondary"
            block
          />
        </>
      )}

      {error === null ? null : (
        <>
          <Spacer size={space[4]} />
          <Body color={role.red.fg}>{error}</Body>
        </>
      )}
      <Spacer size={space[6]} />
    </Screen>
  );
}

/* ── Where the frame comes from ───────────────────────────────────────────── */

function SourceChoice({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (get: () => Promise<Awaited<ReturnType<typeof fromFile>>>) => void;
}) {
  return (
    <Panel>
      <BodyStrong>Film it with this phone</BodyStrong>
      <Spacer size={space[2]} />
      <Body tone={3}>
        Only if this phone is the camera that will film the match. A frame from one camera
        cannot calibrate another.
      </Body>
      <Spacer size={space[3]} />
      <Button label="Open the camera" onPress={() => { onPick(fromDeviceCamera); }} busy={busy} block />

      <Spacer size={space[5]} />
      <Rule />
      <Spacer size={space[5]} />

      <BodyStrong>From another camera</BodyStrong>
      <Spacer size={space[2]} />
      <Body tone={3}>
        Point the camera at the pitch from where it will stand, then bring one photo or one
        video across — over a cable or card reader, by Bluetooth, or with the camera maker&apos;s
        own app. Do not photograph the camera&apos;s screen; that calibrates this phone.
      </Body>
      <Spacer size={space[3]} />
      <Button
        label="From photos on this phone"
        onPress={() => { onPick(fromLibrary); }}
        variant="secondary"
        busy={busy}
        block
      />
      <Spacer size={space[2]} />
      <Button
        label="From a file, cable or card reader"
        onPress={() => { onPick(fromFile); }}
        variant="secondary"
        busy={busy}
        block
      />

      <Spacer size={space[4]} />
      <Body tone={3} style={styles.fine}>
        A still from a stills camera will not do for a body whose photo and video modes
        differ — a mirrorless or a GoPro. Bring a video recorded in the mode you will film
        in, and the frame is taken from that.
      </Body>
    </Panel>
  );
}

/* ── The frame, with the marks on it ──────────────────────────────────────── */

function FramePanel({
  frame, taps, landmarks, worstId, drawnWidth, selected, onLayout, onTap,
}: {
  frame: CalibrationFrame;
  taps: Correspondence[];
  landmarks: Landmark[];
  worstId: string | null;
  drawnWidth: number;
  selected: string | null;
  onLayout: (e: LayoutChangeEvent) => void;
  onTap: (x: number, y: number) => void;
}) {
  const scale = drawnWidth > 0 ? drawnWidth / frame.width : 0;
  const byId = new Map(landmarks.map((l) => [l.id, l]));

  return (
    <View>
      <Pressable
        onLayout={onLayout}
        onPress={(e) => { onTap(e.nativeEvent.locationX, e.nativeEvent.locationY); }}
        // Laid out at the frame's own aspect ratio so view coordinates and
        // image coordinates differ by one scale factor and nothing else.
        style={[styles.frame, { aspectRatio: frame.width / frame.height }]}
        accessibilityRole="imagebutton"
        accessibilityLabel={
          selected === null
            ? 'The calibration frame. Choose a marking below before tapping.'
            : `Tap where ${byId.get(selected)?.label ?? 'the marking'} is in the frame.`
        }
      >
        <Image source={{ uri: frame.uri }} style={StyleSheet.absoluteFill} contentFit="fill" />
        {taps.map((t) => {
          const isWorst = t.landmarkId === worstId;
          return (
            <View
              key={t.landmarkId}
              pointerEvents="none"
              style={[
                styles.mark,
                isWorst ? styles.markWorst : null,
                { left: t.imageX * scale - MARK / 2, top: t.imageY * scale - MARK / 2 },
              ]}
            />
          );
        })}
      </Pressable>
      <Spacer size={space[2]} />
      <Row gap={space[2]}>
        <Body tone={3} style={styles.fine}>
          {frame.width} × {frame.height}
          {frame.fromVideo ? ' · frame from a video' : ''}
        </Body>
      </Row>
    </View>
  );
}

/* ── Is it solvable? ──────────────────────────────────────────────────────── */

function Verdict({ verdict, taps }: { verdict: SolveVerdict | null; taps: number }) {
  if (verdict === null) {
    return null;
  }
  const band = verdict.solvable
    ? (verdict.worstPoint !== null && verdict.message.includes('Worth re-tapping')
        ? confidence.amber
        : confidence.green)
    : confidence.red;

  return (
    <Panel style={{ backgroundColor: band.bg, borderColor: band.border }}>
      <Row gap={space[2]}>
        <Pill
          label={verdict.solvable ? 'Solvable' : 'Not yet'}
          tone={verdict.solvable ? 'live' : 'error'}
          dot
        />
        <Body tone={3}>{taps} marked</Body>
      </Row>
      <Spacer size={space[3]} />
      <Body color={band.fg}>{verdict.message}</Body>

      {verdict.rmsErrorPx === null ? null : (
        <>
          <Spacer size={space[3]} />
          <Body tone={3} style={styles.fine}>
            Average disagreement {Math.round(verdict.rmsErrorPx)} px
            {verdict.solvedBy === 'least_squares'
              // Worth saying. Without RANSAC a single bad point pulls the whole
              // fit rather than being rejected, so the number is less
              // trustworthy than the same number from the native solver.
              ? ' · solved without outlier rejection'
              : ' · solved with RANSAC'}
          </Body>
        </>
      )}
    </Panel>
  );
}

/**
 * Does this frame match what the camera will actually film at?
 *
 * A homography maps pixels to metres, so it is valid at the frame size it was
 * solved at. A different SHAPE is a different crop of the sensor and cannot be
 * rescaled; a different SIZE of the same shape can.
 */
function CaptureMismatch({ camera, frame }: { camera: SavedCamera; frame: CalibrationFrame }) {
  const lens = camera.calibrations[0];
  if (lens === undefined) {
    return null;
  }
  const check = framesDisagree(frame, { widthPx: lens.widthPx, heightPx: lens.heightPx });
  if (!check.disagree) {
    return null;
  }
  const bad = !check.sameShape;
  return (
    <>
      <Spacer size={space[3]} />
      <Panel style={{ backgroundColor: bad ? role.red.bg : role.amber.bg,
                      borderColor: bad ? role.red.border : role.amber.border }}>
        <Body color={bad ? role.red.fg : role.amber.fg}>
          {bad
            ? `This frame is ${frame.width}×${frame.height}, a different shape to the ` +
              `${lens.widthPx}×${lens.heightPx} this camera is calibrated at. A different shape ` +
              `is a different crop of the sensor — calibrate from a frame in the mode you will film in.`
            : `This frame is ${frame.width}×${frame.height} and the camera films at ` +
              `${lens.widthPx}×${lens.heightPx}. Same shape, so it rescales cleanly, but a frame ` +
              `at the filming resolution is better.`}
        </Body>
      </Panel>
    </>
  );
}

/* ── Which markings to mark ───────────────────────────────────────────────── */

function LandmarkList({
  landmarks, marked, selected, worstId, onSelect, onClear,
}: {
  landmarks: Landmark[];
  marked: Set<string>;
  selected: string | null;
  worstId: string | null;
  onSelect: (id: string) => void;
  onClear: (id: string) => void;
}) {
  return (
    <ScrollView
      horizontal={false}
      style={styles.list}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {landmarks.map((l) => {
        const isMarked = marked.has(l.id);
        const isSelected = selected === l.id;
        const isWorst = worstId === l.id;
        return (
          <Pressable
            key={l.id}
            onPress={() => { isMarked ? onClear(l.id) : onSelect(l.id); }}
            style={[
              styles.landmark,
              isSelected ? styles.landmarkSelected : null,
              isWorst ? styles.landmarkWorst : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel={l.label}
            accessibilityHint={isMarked ? 'Marked. Tap to remove.' : 'Tap to place this marking.'}
          >
            <Body color={isMarked ? signal.base : ink[2]}>{l.label}</Body>
            <Body tone={3} style={styles.fine}>
              {isMarked ? 'Tap to remove' : isSelected ? 'Tap it in the frame' : ''}
            </Body>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const MARK = 18;

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    backgroundColor: surface.bg1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: line.border,
    overflow: 'hidden',
  },
  mark: {
    position: 'absolute',
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    borderWidth: 2,
    borderColor: signal.base,
    backgroundColor: signal.bg,
  },
  markWorst: {
    borderColor: role.red.fg,
    backgroundColor: role.red.bg,
  },
  list: {
    maxHeight: 260,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
    backgroundColor: surface.bg1,
  },
  landmark: {
    minHeight: 44,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderBottomWidth: 1,
    borderBottomColor: line.rule,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  landmarkSelected: { backgroundColor: signal.bg },
  landmarkWorst: { backgroundColor: role.red.bg },
  fine: { fontSize: type.micro },
});
