/**
 * DEV ONLY: the recorder on its own, no session and no upload.
 *
 * Records 10-second segments into the app's documents (recorder-test/) and
 * lists what the native side reported, with the join between consecutive
 * segments. The files are then pulled over adb and checked with ffprobe:
 * that is the proof the recorder is gapless on a real phone.
 */

import { useKeepAwake } from 'expo-keep-awake';
import { Directory, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  getRecorderPreview,
  getRiseupRecorder,
  type RecorderSegment,
} from '../../modules/riseup-recorder';
import { space, surface } from '../../src/theme/tokens';
import { Button } from '../../src/ui/Button';
import { Screen, Spacer } from '../../src/ui/Layout';
import { Body, Label } from '../../src/ui/Text';

export default function RecordTestScreen() {
  useKeepAwake();
  const recorder = getRiseupRecorder();
  const Preview = getRecorderPreview();
  const [segments, setSegments] = useState<RecorderSegment[]>([]);
  const [status, setStatus] = useState('idle');
  // Only this screen's own run: the recorder's events also carry a match
  // recorded from the Record screen, and listing those here duplicated keys.
  const ownRun = useRef(false);

  useEffect(() => {
    if (recorder === null) {
      return;
    }
    const subs = [
      recorder.addListener('onSegment', (s) => {
        if (ownRun.current) {
          setSegments((prev) => [...prev.filter((p) => p.sequence !== s.sequence), s]);
          if (s.final) {
            ownRun.current = false;
          }
        }
      }),
      recorder.addListener('onError', (e) => setStatus(`error ${e.code}: ${e.message}`)),
      recorder.addListener('onState', (e) => setStatus(e.state)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [recorder]);

  if (!__DEV__ || recorder === null) {
    return (
      <Screen>
        <Body>Not available in this build.</Body>
      </Screen>
    );
  }

  const start = async () => {
    // A second tap would clear the folder under a running recording.
    if (recorder.getState() !== 'idle') {
      return;
    }
    try {
      const permission = await recorder.requestPermission();
      if (!permission.granted) {
        setStatus('no camera permission');
        return;
      }
      const dir = new Directory(Paths.document, 'recorder-test');
      if (dir.exists) {
        dir.delete();
      }
      dir.create({ intermediates: true });
      setSegments([]);
      ownRun.current = true;
      const started = await recorder.start({
        directory: dir.uri, segmentSeconds: 10, width: 1920, height: 1080, fps: 30,
        bitRate: 16_000_000, widest: true,
      });
      setStatus(`recording ${started.width}x${started.height}@${started.fps} ${started.lens}`
                + (started.zoomRatio !== undefined ? ` zoom ${started.zoomRatio}` : ''));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'start failed');
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.preview}>
        {Preview ? <Preview style={StyleSheet.absoluteFill} /> : null}
      </View>
      <Spacer size={space[2]} />
      <Label>{status}</Label>
      <Spacer size={space[2]} />
      <Button label="Start (10 s segments)" onPress={start} />
      <Spacer size={space[2]} />
      <Button label="Stop" variant="secondary" onPress={() => void recorder.stop()} />
      <ScrollView style={styles.list}>
        {segments.map((s, i) => {
          const prev = segments[i - 1];
          const joinMs = prev ? (s.startPtsNs - prev.endPtsNs) / 1e6 : 0;
          return (
            <Body key={s.sequence} size={12}>
              {`#${s.sequence} ${(s.startPtsNs / 1e9).toFixed(3)}–${(s.endPtsNs / 1e9).toFixed(3)} s `
                + `${s.frameCount} fr ${(s.byteLength / 1e6).toFixed(1)} MB `
                + `join ${joinMs.toFixed(3)} ms drop ${s.droppedFrames}${s.final ? ' FINAL' : ''} `
                + `${s.sha256.slice(0, 8)}`}
            </Body>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: { height: 180, backgroundColor: surface.bg2, overflow: 'hidden' },
  list: { flex: 1, marginTop: space[2] },
});
