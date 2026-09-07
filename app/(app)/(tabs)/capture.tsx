/**
 * Capture — the Operator's home (§2).
 *
 * WHAT THIS SCREEN IS NOW. The rig survey and the camera library, both of which
 * are finished and both of which are the work that has to happen before a
 * camera films anything useful. Recording itself lands in v0.2; the setup that
 * makes recording worth doing is here today.
 *
 * WHY IT IS NOT A "COMING SOON" SCREEN. Apple rejects placeholder content under
 * App Review 2.1 and treats a tab that only announces future features as
 * failing the minimum-functionality bar in 4.2; Google reads the same thing as
 * a broken or incomplete experience. Both are right. A tab that does nothing is
 * a tab that should not be in the bar.
 *
 * The honest framing is the one used here: this screen does a real job, and it
 * says plainly what it does not do yet — in one line, at the bottom, as
 * information rather than as an advertisement for a release that has not
 * happened.
 */

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { cameraStore, orderForPicker } from '../../../src/capture/devices/store';
import { calibrationSummary, classOf, readiness } from '../../../src/capture/devices/types';
import { surveyDraft } from '../../../src/capture/survey/draft';
import { ink, minTouchTarget, space, surface } from '../../../src/theme/tokens';
import { Button } from '../../../src/ui/Button';
import { Panel, Row, Rule, Screen, Spacer } from '../../../src/ui/Layout';
import { Pill } from '../../../src/ui/Status';
import { Body, BodyStrong, Display, Label } from '../../../src/ui/Text';

export default function CaptureScreen() {
  const router = useRouter();
  const cameras = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot);
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);

  useEffect(() => {
    void cameraStore.hydrate();
    void surveyDraft.hydrate();
  }, []);

  const ordered = useMemo(() => orderForPicker(cameras), [cameras]);

  // A survey is in progress if anything has been entered beyond the defaults.
  const surveyStarted =
    draft.northTouchlineM.value !== null ||
    draft.cameras.some((c) => c.savedCameraId !== null || c.heightM.value !== null);

  return (
    <Screen scroll>
      <Spacer size={space[4]} />
      <Label>Capture</Label>
      <Spacer size={space[3]} />
      <Display>Set up the rig</Display>
      <Spacer size={space[3]} />
      <Body tone={2}>
        Measure the pitch and place the cameras. It takes about twenty minutes the first time at a
        ground and a couple of minutes every time after that.
      </Body>

      <Spacer size={space[5]} />
      <Button
        label={surveyStarted ? 'Continue the survey' : 'Start a survey'}
        onPress={() => router.push('/survey')}
        block
      />

      <Spacer size={space[6]} />
      <Row>
        <Label>Your cameras</Label>
        <View style={styles.flex} />
        <Label tone={3}>{`${cameras.length}`}</Label>
      </Row>
      <Spacer size={space[3]} />

      {ordered.length === 0 ? (
        <Panel>
          <Body tone={2} size={13}>
            No cameras yet. Add the one your club films with — its lens is measured once and then
            never again.
          </Body>
          <Spacer size={space[3]} />
          <Button
            label="Add a camera"
            onPress={() => router.push('/survey')}
            variant="secondary"
          />
        </Panel>
      ) : (
        <Panel style={styles.list} flat>
          {ordered.map((camera, index) => {
            const state = readiness(camera, null);
            return (
              <View key={camera.id}>
                {index === 0 ? null : <Rule inset={space[4]} />}
                <Pressable
                  onPress={() => router.push('/survey')}
                  accessibilityRole="button"
                  accessibilityLabel={`${camera.label}. ${calibrationSummary(camera)}`}
                  style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                >
                  <View style={styles.flex}>
                    <Row gap={space[2]}>
                      <BodyStrong numberOfLines={1}>{camera.label}</BodyStrong>
                      {state.ready ? null : <Pill label="Needs a lens model" tone="warn" />}
                    </Row>
                    <Spacer size={space[1]} />
                    <Label tone={3} numberOfLines={1}>
                      {classOf(camera)?.label ?? 'Unknown type'} · {calibrationSummary(camera)}
                    </Label>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={ink.subtle} />
                </Pressable>
              </View>
            );
          })}
        </Panel>
      )}

      <Spacer size={space[6]} />
      <Panel>
        <Label>Filming</Label>
        <Spacer size={space[2]} />
        <Body tone={3} size={13}>
          RiseUp does not record video itself yet — film on your own camera and upload it. The
          survey you do here is what lets those files be measured properly, and it does not have to
          be repeated when recording arrives.
        </Body>
        <Spacer size={space[3]} />
        <Button
          label="Upload footage"
          onPress={() => router.push('/uploads')}
          variant="secondary"
        />
      </Panel>
      <Spacer size={space[7]} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: {
    padding: 0,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: minTouchTarget + space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
  },
  rowPressed: {
    backgroundColor: surface.bg2,
  },
});
