/**
 * Capture — the Operator's home (§2), and v0.1's deliberate placeholder.
 *
 * WHY THIS SCREEN EXISTS AT ALL IN v0.1. The phasing in §10 puts capture in
 * v0.2 and v0.3 for good reasons, but the tab has to be here now: the role
 * switch in settings routes an Operator device straight to it, and a tab that
 * appears in a later release changes the shape of the app under someone who
 * has learned where things are.
 *
 * WHY IT DOES NOT FAKE ANYTHING. There is no mock viewfinder and no disabled
 * record button. The capture path carries the whole product's data quality and
 * a screen that looks like it films is the one screen a volunteer might trust
 * at a ground and then discover, hours later, that nothing was recorded — the
 * exact unrecoverable failure §4.2 exists to make impossible. So this states
 * what is coming and points at the thing that works today.
 *
 * WHAT LANDS HERE, IN ORDER (§10):
 *   v0.2 — single-phone capture into the app's own container, upload,
 *          verified deletion.
 *   v0.3 — the two-phone rig: pairing over Bluetooth/local network, the
 *          framing assistant (the highest-value screen in the app), preflight,
 *          the audible sync marker, in-match health.
 *
 * The framing assistant's geometry is a PORT of `camera/rig.py` in riseup-ml,
 * not a reimplementation (§4.2). Those thresholds are product decisions and
 * must not drift between two codebases.
 */

import { useRouter } from 'expo-router';

import { space } from '../../../src/theme/tokens';
import { Button } from '../../../src/ui/Button';
import { Panel, Screen, Spacer } from '../../../src/ui/Layout';
import { Body, Display, Label } from '../../../src/ui/Text';

export default function CaptureScreen() {
  const router = useRouter();

  return (
    <Screen scroll>
      <Spacer size={space[4]} />
      <Label>Capture</Label>
      <Spacer size={space[3]} />
      <Display>Not in this build</Display>
      <Spacer size={space[3]} />
      <Body tone={2}>
        Filming with one phone arrives in the next release, and the two-phone rig after it. Until
        then the app will not pretend to record — a rig that looks like it is filming and is not
        costs you the match.
      </Body>

      <Spacer size={space[5]} />
      <Button label="Survey the rig" onPress={() => router.push('/survey')} block />
      <Spacer size={space[3]} />
      <Body tone={3} size={13}>
        The measurements can be taken now, before the cameras work. They are the same either way,
        they take twenty minutes the first time at a ground, and doing them once means the pitch
        never has to be measured again.
      </Body>

      <Spacer size={space[4]} />
      <Button
        label="Upload footage instead"
        onPress={() => router.push('/uploads')}
        variant="secondary"
        block
      />

      <Spacer size={space[6]} />
      <Panel>
        <Label>What is coming</Label>
        <Spacer size={space[3]} />
        <Body tone={3} size={13}>
          Pairing two phones over Bluetooth with no server involved. A framing check that tells you
          where to stand and refuses to record until the two cameras cover the pitch between them.
          Free space, power, thermal and lock checks before kick-off. All of it offline — the
          ground does not need signal.
        </Body>
      </Panel>
      <Spacer size={space[7]} />
    </Screen>
  );
}
