/**
 * Upload manager (§5).
 *
 * The clip path is the low-commitment entry point: §5 predicts it will be the
 * most-used feature in the first month, because it is the one a club can try
 * without owning a rig or committing to filming a whole match. So it is the
 * primary action on this screen, not a secondary one.
 *
 * Per-segment progress and an honest time estimate, both from §5. The estimate
 * is withheld until the transfer has produced enough of a sample to support
 * one — see `estimateRemainingMs`.
 */

import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { useApi } from '../../../src/api/provider';
import { useMe, useUploadMode } from '../../../src/api/queries';
import { bytes, duration, when } from '../../../src/lib/format';
import {
  estimateRemainingMs,
  progressFraction,
  uploadManager,
  type UploadEntry,
} from '../../../src/upload/manager';
import { line, radius, signal, space, surface } from '../../../src/theme/tokens';
import { Button } from '../../../src/ui/Button';
import { Panel, Row, Rule, Screen, Spacer } from '../../../src/ui/Layout';
import { Pill, type Tone } from '../../../src/ui/Status';
import { EmptyState } from '../../../src/ui/State';
import { Body, BodyStrong, Display, Label, Metric } from '../../../src/ui/Text';

export default function UploadsScreen() {
  const api = useApi();
  const uploadMode = useUploadMode();
  const me = useMe();

  const entries = useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);

  const [pending, setPending] = useState<{
    uri: string; filename: string; mimeType: string; totalBytes: number;
  } | null>(null);
  const [coversOpening, setCoversOpening] = useState(false);

  /**
   * May RiseUp learn from this footage?
   *
   * A SEPARATE PERMISSION FROM THE UPLOAD, and it stays separate. Uploading is
   * the club buying analysis of their own match. This grants us a licence to
   * train on it — a different transaction with a different beneficiary. A
   * consent that is the price of a service which does not need it is not
   * freely given (GDPR Art. 7(4)), so declining changes nothing: the upload
   * runs identically and the button never disables.
   *
   * Starts UNTICKED and is never remembered between files. A default of yes
   * would be consent nobody gave, and a sticky answer would be one answer
   * silently applied to a video it was never asked about.
   */
  const [mayTrain, setMayTrain] = useState(false);

  useEffect(() => {
    void uploadManager.attach(api);
  }, [api]);

  const pick = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Photo access is off',
        'RiseUp needs access to your videos to upload them. Turn it on in Settings.',
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      // No transcode. Re-encoding on the phone costs minutes, drains battery,
      // and throws away the frames the pipeline needs to measure from.
      allowsEditing: false,
      quality: 1,
    });

    if (result.canceled) {
      return;
    }

    const asset = result.assets[0];
    if (asset === undefined) {
      return;
    }

    // ASKED, NOT INFERRED. A file's creation time is the only automatic clue
    // that footage begins after kick-off, and it is worthless on a camcorder
    // whose clock was never set — which is most of them. The operator was
    // standing there and knows. `checkRecordingCoverage` still runs where
    // timestamps are trustworthy; this is the answer for everything else.
    setMayTrain(false);
    setPending({
      uri: asset.uri,
      filename: asset.fileName ?? `clip-${Date.now()}.mp4`,
      mimeType: asset.mimeType ?? 'video/mp4',
      totalBytes: asset.fileSize ?? 0,
    });
    setCoversOpening(false);
  }, []);


  /* GRANTING A LICENCE OVER THE CLUB'S FOOTAGE BINDS THE CLUB, so only an
     admin is asked. The operator on the touchline is very often an analyst,
     and the honest thing is to not put the question in front of somebody
     whose answer cannot count — the dashboard asks an admin later, on the
     finished match. */
  const canConsent = me.data?.role === 'org:admin';

  const confirmUpload = useCallback(() => {
    if (pending === null) {
      return;
    }
    uploadManager.enqueue({
      ...pending,
      // Travels with the upload. Analysis needs to know before it reports
      // anything time-based: a match missing its first twenty minutes has no
      // first-fifteen possession, and reporting zero there is a lie.
      coversOpening,
      // Only sent when this person can actually give it. The server drops an
      // answer from a non-admin anyway — see `_consent_from` — but sending one
      // we know will be discarded would make the tick look like it did
      // something, which is worse than not offering it.
      trainingConsent: canConsent ? mayTrain : undefined,
    });
    setPending(null);
  }, [pending, coversOpening, mayTrain, canConsent]);

  // Told, not guessed. A deployment without object storage cannot take a
  // presigned PUT, and finding that out mid-transfer is a 501 halfway through
  // somebody's file.
  const presignedAvailable = uploadMode.data?.presigned ?? true;


  const active = entries.filter((e) => e.status !== 'uploaded' && e.status !== 'cancelled');
  const finished = entries.filter((e) => e.status === 'uploaded' || e.status === 'cancelled');

  return (
    <Screen scroll>

      <Spacer size={space[4]} />
      <Display>Uploads</Display>
      <Spacer size={space[2]} />
      <Body tone={3}>
        A clip is the quickest way to see what RiseUp does. Wi-Fi only for now — a full match is
        an overnight job.
      </Body>

      <Spacer size={space[5]} />
      <Button
        label="Choose a video"
        onPress={() => void pick()}
        disabled={!presignedAvailable}
        block
      />

      {pending === null ? null : (
        <>
          <Spacer size={space[4]} />
          <Panel>
            <BodyStrong numberOfLines={1}>{pending.filename}</BodyStrong>
            <Spacer size={space[2]} />
            <Body tone={3} size={13}>
              Before this is processed: does the recording start before kick-off?
            </Body>
            <Spacer size={space[3]} />
            <Pressable
              onPress={() => { setCoversOpening((v) => !v); }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: coversOpening }}
              accessibilityLabel="This recording starts before kick-off"
              style={({ pressed }) => [styles.check, pressed ? styles.checkPressed : null]}
            >
              <View style={[styles.box, coversOpening ? styles.boxOn : null]}>
                {coversOpening ? <Ionicons name="checkmark" size={16} color={surface.bg0} /> : null}
              </View>
              <Body style={styles.checkLabel}>
                The recording starts at or before kick-off
              </Body>
            </Pressable>
            <Spacer size={space[3]} />
            <Body tone={3} size={13}>
              {coversOpening
                ? 'The whole match will be measured.'
                : 'Leave this unticked if filming began after play started. The footage is still '
                  + 'analysed — it is marked so nothing reports figures for the part that was '
                  + 'not filmed.'}
            </Body>
            {canConsent ? (
              <>
                <Spacer size={space[4]} />
                <Rule />
                <Spacer size={space[4]} />
                <Body tone={3} size={13}>
                  Separately, and only if you want to:
                </Body>
                <Spacer size={space[3]} />
                <Pressable
                  onPress={() => { setMayTrain((v) => !v); }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: mayTrain }}
                  accessibilityLabel="RiseUp may keep this match to improve its systems"
                  style={({ pressed }) => [styles.check, pressed ? styles.checkPressed : null]}
                >
                  <View style={[styles.box, mayTrain ? styles.boxOn : null]}>
                    {mayTrain ? <Ionicons name="checkmark" size={16} color={surface.bg0} /> : null}
                  </View>
                  <Body style={styles.checkLabel}>
                    RiseUp may keep this match and learn from it
                  </Body>
                </Pressable>
                <Spacer size={space[2]} />
                {/* SAYS WHAT IT IS AND WHAT IT IS NOT. The binding text is the
                    terms; this is the plain-language version and it must not
                    promise anything those terms do not. */}
                <Body tone={3} size={13}>
                  This is not needed to analyse your match, and leaving it unticked changes
                  nothing about the upload. It lets us keep this video to improve how RiseUp
                  tracks players. You can change your mind on the match afterwards.
                </Body>
              </>
            ) : null}

            {/* SHOWN TO EVERYONE, NOT ONLY ADMINS. This is not part of the
                training question — it is about the upload itself, and it
                applies just as much to a club that ticks nothing. Whoever
                presses Upload is the person making the representation, and an
                operator uploading a match is making it as surely as an admin. */}
            <Spacer size={space[4]} />
            <Rule />
            <Spacer size={space[3]} />
            <Body tone={3} size={12}>
              By uploading you confirm your club holds the rights to this footage and may
              share it with us — including any permissions needed for the people who appear
              in it. If the recording came from a broadcaster, a league feed, or another
              club&apos;s camera, check before uploading it.
            </Body>

            <Spacer size={space[4]} />
            <Button label="Upload" onPress={confirmUpload} block />
            <Spacer size={space[2]} />
            <Button
              label="Cancel"
              onPress={() => { setPending(null); }}
              variant="secondary"
              block
            />
          </Panel>
        </>
      )}
      {presignedAvailable ? null : (
        <>
          <Spacer size={space[3]} />
          <Body tone={3} size={13}>
            This deployment has no object storage configured, so uploads from the phone are
            unavailable. A club admin can check the server configuration.
          </Body>
        </>
      )}

      <Spacer size={space[6]} />

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing uploading"
          body="Pick a video and it will upload in the background. You can close the app."
        />
      ) : (
        <>
          {active.length === 0 ? null : (
            <>
              <Label>In progress</Label>
              <Spacer size={space[3]} />
              {active.map((entry) => (
                <UploadRow key={entry.id} entry={entry} />
              ))}
            </>
          )}

          {finished.length === 0 ? null : (
            <>
              <Spacer size={space[5]} />
              <Row>
                <Label>Finished</Label>
                <View style={styles.spacerFlex} />
                <Pressable
                  onPress={() => uploadManager.clearFinished()}
                  accessibilityRole="button"
                  accessibilityLabel="Clear finished uploads"
                  hitSlop={space[3]}
                >
                  <Label tone={3}>Clear</Label>
                </Pressable>
              </Row>
              <Spacer size={space[3]} />
              {finished.map((entry) => (
                <UploadRow key={entry.id} entry={entry} />
              ))}
            </>
          )}
        </>
      )}

      <Spacer size={space[6]} />
      <Panel>
        <Label>Keeping your footage</Label>
        <Spacer size={space[2]} />
        <Body tone={3} size={13}>
          RiseUp never deletes anything from your phone. When a file is confirmed on the server we
          will offer to remove the local copy — and only then.
        </Body>
      </Panel>
      <Spacer size={space[7]} />
    </Screen>
  );
}

const statusTone: Record<UploadEntry['status'], Tone> = {
  queued: 'neutral',
  uploading: 'live',
  confirming: 'live',
  uploaded: 'neutral',
  failed: 'error',
  cancelled: 'neutral',
};

const statusLabel: Record<UploadEntry['status'], string> = {
  queued: 'Waiting',
  uploading: 'Uploading',
  confirming: 'Finishing',
  uploaded: 'Uploaded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function UploadRow({ entry }: { entry: UploadEntry }) {
  const fraction = progressFraction(entry);
  const remaining = estimateRemainingMs(entry);

  return (
    <Panel style={styles.uploadRow}>
      <Row align="flex-start">
        <View style={styles.uploadMain}>
          <BodyStrong numberOfLines={1}>{entry.filename}</BodyStrong>
          <Spacer size={space[1]} />
          <Row gap={space[3]}>
            <Label>{bytes(entry.totalBytes)}</Label>
            <Label>{when(entry.createdAt)}</Label>
          </Row>
        </View>
        <Pill
          label={statusLabel[entry.status]}
          tone={statusTone[entry.status]}
          dot={entry.status === 'uploading' || entry.status === 'confirming'}
        />
      </Row>

      {entry.status === 'uploading' || entry.status === 'confirming' ? (
        <>
          <Spacer size={space[3]} />
          <ProgressBar fraction={fraction} />
          <Spacer size={space[2]} />
          <Row>
            <Metric size={13} tone="mute">
              {`${Math.round(fraction * 100)}%`}
            </Metric>
            <View style={styles.spacerFlex} />
            {/* No estimate until the sample supports one. A number that swings
                from seconds to an hour is worse than an absent one. */}
            <Label>
              {remaining === null ? 'Estimating' : `${duration(remaining / 1000)} left`}
            </Label>
          </Row>
        </>
      ) : null}

      {entry.error === null ? null : (
        <>
          <Spacer size={space[3]} />
          <Body tone={2} size={13}>
            {entry.error}
          </Body>
        </>
      )}

      <Spacer size={space[3]} />
      <Row gap={space[2]}>
        {entry.status === 'failed' ? (
          <Button label="Retry" onPress={() => uploadManager.retry(entry.id)} variant="secondary" />
        ) : null}
        {entry.status === 'uploading' ||
        entry.status === 'queued' ||
        entry.status === 'confirming' ? (
          <Button label="Cancel" onPress={() => uploadManager.cancel(entry.id)} variant="ghost" />
        ) : (
          <Button label="Remove" onPress={() => uploadManager.remove(entry.id)} variant="ghost" />
        )}
      </Row>
    </Panel>
  );
}

/**
 * A progress bar.
 *
 * `signal` is spent here, and it is one of the legitimate spends: this is a
 * live, running, measured state. It is the only accent on the screen while an
 * upload is in flight.
 */
function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
    >
      <View style={[styles.fill, { width: `${Math.max(2, fraction * 100)}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  uploadRow: {
    marginBottom: space[3],
  },
  uploadMain: {
    flex: 1,
  },
  spacerFlex: {
    flex: 1,
  },
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  checkPressed: {
    opacity: 0.7,
  },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: line.borderHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: {
    backgroundColor: signal.base,
    borderColor: signal.base,
  },
  checkLabel: {
    // Without this the label runs off the right edge instead of wrapping —
    // `Text` in a row does not shrink on its own.
    flex: 1,
  },
  track: {
    height: 3,
    backgroundColor: surface.bg3,
    borderRadius: radius.full,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: signal.base,
  },
});
