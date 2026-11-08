/**
 * Record a match on this phone.
 *
 * Gapless 1-minute segments, each uploaded while play goes on
 * (`src/capture/record/matchRecording.ts`). The screen is locked to the
 * landscape the phone is held in when recording starts, so the picture is
 * upright for the whole match, and kept awake.
 */

import { useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { getRecorderPreview, isRiseupRecorderAvailable } from '../../modules/riseup-recorder';
import { useApi } from '../../src/api/provider';
import { matchRecording } from '../../src/capture/record/matchRecording';
import { space, surface } from '../../src/theme/tokens';
import { Button } from '../../src/ui/Button';
import { Panel, Row, Screen, Spacer } from '../../src/ui/Layout';
import { Body, BodyStrong, Display, Label } from '../../src/ui/Text';

export default function RecordScreen() {
  useKeepAwake();
  const router = useRouter();
  const api = useApi();
  const state = useSyncExternalStore(matchRecording.subscribe, matchRecording.getSnapshot);
  const [coversOpening, setCoversOpening] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Preview = getRecorderPreview();

  useEffect(() => {
    void matchRecording.attach(api);
  }, [api]);

  // Locked for the match, released when the recording is done with.
  useEffect(() => {
    if (state.phase === 'recording') {
      void ScreenOrientation.getOrientationAsync().then((o) =>
        ScreenOrientation.lockAsync(
          o === ScreenOrientation.Orientation.LANDSCAPE_LEFT
            ? ScreenOrientation.OrientationLock.LANDSCAPE_LEFT
            : ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT));
    } else {
      void ScreenOrientation.unlockAsync();
    }
  }, [state.phase]);

  const confirmed = state.chunks.filter((c) => c.status === 'confirmed').length;
  const waiting = state.chunks.length - confirmed;
  const lastError = state.error ?? state.chunks.find((c) => c.error)?.error ?? null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await ScreenOrientation.getOrientationAsync();
      if (o !== ScreenOrientation.Orientation.LANDSCAPE_LEFT
          && o !== ScreenOrientation.Orientation.LANDSCAPE_RIGHT) {
        throw new Error('Turn the phone sideways before you start: a match is filmed in landscape.');
      }
      await matchRecording.start({ coversOpening });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording did not start.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await matchRecording.stop();
    } finally {
      setBusy(false);
    }
  };

  if (!isRiseupRecorderAvailable()) {
    return (
      <Screen>
        <Spacer size={space[5]} />
        <Display>Recording</Display>
        <Spacer size={space[3]} />
        <Body tone={2}>This build of the app cannot record. Install the latest RiseUp build.</Body>
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.preview}>
        {Preview ? <Preview style={StyleSheet.absoluteFill} /> : null}
      </View>
      <Spacer size={space[3]} />
      <Panel>
        {state.phase === 'idle' || state.phase === 'completed' || state.phase === 'failed' ? (
          <>
            <Row>
              <Body style={styles.flex}>Rolling from before kick-off</Body>
              <Switch value={coversOpening} onValueChange={setCoversOpening} />
            </Row>
            <Spacer size={space[3]} />
            <Button label="Start recording" onPress={start} busy={busy} block />
          </>
        ) : null}
        {state.phase === 'recording' ? (
          <Button label="Stop at the final whistle" onPress={stop} busy={busy} block variant="secondary" />
        ) : null}
        <Spacer size={space[3]} />
        <Label tone={3}>
          {state.phase === 'recording' ? 'Recording' : state.phase === 'finishing' ? 'Sending the last minutes'
            : state.phase === 'completed' ? 'Sent: the match is being processed'
            : state.phase === 'failed' ? 'Stopped' : 'Ready'}
          {state.chunks.length > 0 ? ` · ${confirmed} sent, ${waiting} waiting` : ''}
        </Label>
        {error ?? lastError ? (
          <>
            <Spacer size={space[2]} />
            <BodyStrong size={13}>{error ?? lastError}</BodyStrong>
          </>
        ) : null}
        {state.phase === 'completed' ? (
          <>
            <Spacer size={space[3]} />
            <Button label="Done" variant="secondary" onPress={() => {
              matchRecording.reset();
              router.back();
            }} />
          </>
        ) : null}
      </Panel>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  preview: {
    flex: 1,
    minHeight: 160,
    backgroundColor: surface.bg2,
    overflow: 'hidden',
  },
});
