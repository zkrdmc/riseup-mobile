/**
 * Phone B of a casing rig: scan phone A's code and join its match as camera B.
 *
 * expo-camera only scans here, before recording starts; the recording itself
 * is `modules/riseup-recorder`, which needs the camera to itself.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useApi } from '../../src/api/provider';
import { matchRecording } from '../../src/capture/record/matchRecording';
import { parseJoinCode } from '../../src/capture/record/pairing';
import { space, surface } from '../../src/theme/tokens';
import { Button } from '../../src/ui/Button';
import { Panel, Screen, Spacer } from '../../src/ui/Layout';
import { Body, BodyStrong } from '../../src/ui/Text';

export default function RecordJoinScreen() {
  const router = useRouter();
  const api = useApi();
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | null>(null);
  const joining = useRef(false);

  const onScan = async ({ data }: { data: string }) => {
    if (joining.current) {
      return;
    }
    const code = parseJoinCode(data);
    if (code === null) {
      setMessage('That is not a RiseUp pairing code. Scan the code on the first phone.');
      return;
    }
    joining.current = true;
    setMessage('Joining the match…');
    try {
      await matchRecording.attach(api);
      await matchRecording.join(code);
      router.replace('/record');
    } catch (e) {
      joining.current = false;
      setMessage(e instanceof Error ? e.message : 'Joining the match failed.');
    }
  };

  if (permission === null) {
    return <Screen><Body>Checking the camera…</Body></Screen>;
  }
  if (!permission.granted) {
    return (
      <Screen>
        <Spacer size={space[5]} />
        <Body>RiseUp needs the camera to scan the code on the first phone.</Body>
        <Spacer size={space[3]} />
        <Button label="Allow the camera" onPress={() => void requestPermission()} />
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.camera}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(r) => void onScan(r)}
        />
      </View>
      <Spacer size={space[3]} />
      <Panel>
        <BodyStrong>Join as the second camera</BodyStrong>
        <Spacer size={space[2]} />
        <Body tone={2}>
          On the first phone, tap “Pair the second phone” and point this camera at the code.
        </Body>
        {message !== null ? (
          <>
            <Spacer size={space[2]} />
            <Body>{message}</Body>
          </>
        ) : null}
      </Panel>
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, minHeight: 240, backgroundColor: surface.bg2, overflow: 'hidden' },
});
