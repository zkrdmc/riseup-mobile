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
import { joinCodeFor } from '../../src/capture/record/pairing';
import { QrCode } from '../../src/ui/QrCode';
import { ladderFor } from '../../src/capture/record/recordingQueue';
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
  const [showCode, setShowCode] = useState(false);
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
            <Button label="Start recording (camera A)" onPress={start} busy={busy} block />
            <Spacer size={space[2]} />
            <Button label="Join as the second camera" variant="secondary"
                    onPress={() => router.push('/record-join')} block />
          </>
        ) : null}
        {state.phase === 'recording' ? (
          <>
            {state.role === 'A' && state.sessionId !== null ? (
              showCode ? (
                <View style={styles.code}>
                  <QrCode value={joinCodeFor(state.sessionId)} size={220} />
                  <Spacer size={space[2]} />
                  <Body tone={2}>Scan this with the second phone (Join as the second camera).</Body>
                  <Spacer size={space[2]} />
                  <Button label="Hide the code" variant="secondary" onPress={() => setShowCode(false)} />
                </View>
              ) : (
                <Button label="Pair the second phone" variant="secondary"
                        onPress={() => setShowCode(true)} block />
              )
            ) : null}
            <Spacer size={space[2]} />
            <Button label="Stop at the final whistle" onPress={stop} busy={busy} block variant="secondary" />
          </>
        ) : null}
        {state.phase === 'paused' ? (
          <>
            <Body tone={2}>
              {state.pauseReason === 'motion'
                ? 'Paused: the phone is moving. Put it back in its casing and it carries on.'
                : 'Paused. Put the phone back in its casing to carry on; this match stays open.'}
            </Body>
            <Spacer size={space[3]} />
            <Button label="Resume recording" onPress={() => matchRecording.resume()} block />
            <Spacer size={space[2]} />
            <Button label="Stop at the final whistle" onPress={stop} busy={busy} block variant="secondary" />
          </>
        ) : null}
        {state.phase === 'confirm_end' ? (
          <>
            <BodyStrong>Is the match finished?</BodyStrong>
            <Spacer size={space[2]} />
            <Body tone={2}>
              Recording stopped when the phone left the app. If the match is still going (a break,
              halftime), carry on and it stays one match.
            </Body>
            <Spacer size={space[3]} />
            <Button label="Yes, the match is over" onPress={() => void matchRecording.confirmEnd('over')} block />
            <Spacer size={space[2]} />
            <Button label="No, keep recording" variant="secondary"
                    onPress={() => void matchRecording.confirmEnd('continue')} block />
          </>
        ) : null}
        <Spacer size={space[3]} />
        <Label tone={3}>
          {state.phase === 'recording' ? 'Recording' : state.phase === 'paused' ? 'Paused'
            : state.phase === 'finishing' ? 'Sending the last minutes'
            : state.phase === 'confirm_end' ? 'Waiting for your answer'
            : state.phase === 'completed' ? 'Sent: the match is being processed'
            : state.phase === 'failed' ? 'Stopped' : 'Ready'}
          {state.chunks.length > 0 ? ` · ${confirmed} sent, ${waiting} waiting` : ''}
          {state.phase === 'recording' || state.phase === 'paused'
            ? ` · ${state.codec.toUpperCase()} ${(ladderFor(state.codec)[state.rung]! / 1e6).toFixed(0)} Mbit/s`
            : ''}
        </Label>
        {error ?? lastError ? (
          <>
            <Spacer size={space[2]} />
            <BodyStrong size={13}>{error ?? lastError}</BodyStrong>
          </>
        ) : null}
        {state.phase === 'finishing' || state.phase === 'failed' ? (
          <>
            <Spacer size={space[3]} />
            <Button label="Discard this recording" variant="secondary" onPress={() => {
              void matchRecording.discard();
            }} />
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
  code: { alignItems: 'center' },
  preview: {
    flex: 1,
    minHeight: 160,
    backgroundColor: surface.bg2,
    overflow: 'hidden',
  },
});
