/**
 * Report something broken.
 *
 * Both stores expect a working way to reach support from inside the app —
 * Apple checks it during review, Google requires a contact route for the
 * listing — and beyond compliance it is the only channel that exists between a
 * coach at a ground and anyone who can help.
 *
 * WHY IT COMPOSES AN EMAIL RATHER THAN POSTING TO THE API. The reports most
 * worth receiving are the ones where the API is unreachable: "I could not sign
 * in", "uploads never finish at this ground". An in-app form that submits over
 * the network cannot carry those — it fails in exactly the situation being
 * reported. A composed mail sits in the outbox and leaves when there is signal.
 *
 * A server endpoint is worth having as well, later, so a report can carry logs
 * without asking a volunteer to describe a stack trace. Recorded as a gap.
 */

import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useMe } from '../../src/api/queries';
import { uploadManager } from '../../src/upload/manager';
import {
  collectDiagnostics,
  formatDiagnostics,
  links,
  openLink,
  supportMailto,
} from '../../src/lib/links';
import { ink, line, minTouchTarget, radius, space, surface, type } from '../../src/theme/tokens';
import { Button } from '../../src/ui/Button';
import { Panel, Row, Screen, Spacer } from '../../src/ui/Layout';
import { Body, BodyStrong, Display, Label } from '../../src/ui/Text';

/**
 * The categories, chosen so the first word of a ticket is already useful.
 *
 * Free text alone produces "it doesn't work" as the subject line of most
 * reports, which costs a round trip before anyone can even route it.
 */
const TOPICS = [
  { id: 'upload', label: 'An upload' },
  { id: 'signin', label: 'Signing in' },
  { id: 'survey', label: 'The rig survey' },
  { id: 'results', label: 'Match results' },
  { id: 'other', label: 'Something else' },
] as const;

export default function ReportScreen() {
  const router = useRouter();
  const me = useMe();
  const { userId } = useAuth();

  const [topic, setTopic] = useState<string>('other');
  const [detail, setDetail] = useState('');
  const [failed, setFailed] = useState(false);

  const diagnostics = useMemo(
    () => collectDiagnostics(me.data?.club_id ?? null, userId ?? null),
    [me.data?.club_id, userId],
  );

  const send = useCallback(async () => {
    const label = TOPICS.find((t) => t.id === topic)?.label ?? 'Something else';

    // The upload queue is the single most useful thing to attach: most reports
    // are about uploads, and "three queued, one failed with a storage
    // rejection" answers the first question support would ask.
    const queue = uploadManager.getSnapshot();
    const queueLine =
      queue.length === 0
        ? 'Upload queue: empty'
        : `Upload queue: ${queue.map((e) => `${e.status}`).join(', ')}`;

    const body = `${detail.trim()}\n\n${queueLine}`;
    const opened = await openLink(supportMailto(`RiseUp app — ${label}`, body, diagnostics));
    if (opened) {
      router.back();
    } else {
      // No mail app, which is common on a shared club handset. Show the
      // address rather than swallowing it — the report still has somewhere
      // to go.
      setFailed(true);
    }
  }, [topic, detail, diagnostics, router]);

  return (
    <Screen scroll>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={space[3]}
        style={styles.back}
      >
        <Ionicons name="chevron-back" size={20} color={ink.mute} />
        <Label>Settings</Label>
      </Pressable>

      <Spacer size={space[4]} />
      <Display>Report a problem</Display>
      <Spacer size={space[3]} />
      <Body tone={2}>
        Tell us what happened and we will look. If you were at a ground when it went wrong, say
        which one — most problems turn out to be about a particular pitch.
      </Body>

      <Spacer size={space[5]} />
      <Label>What went wrong?</Label>
      <Spacer size={space[2]} />
      <Row gap={space[2]} style={styles.topics}>
        {TOPICS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTopic(t.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: topic === t.id }}
            accessibilityLabel={t.label}
            style={[styles.topic, topic === t.id ? styles.topicSelected : null]}
          >
            <Label tone={topic === t.id ? 1 : 'mute'}>{t.label}</Label>
          </Pressable>
        ))}
      </Row>

      <Spacer size={space[5]} />
      <Label>What happened</Label>
      <Spacer size={space[2]} />
      <TextInput
        value={detail}
        onChangeText={setDetail}
        placeholder="What you were doing, and what the app did instead"
        placeholderTextColor={ink.subtle}
        style={styles.detail}
        multiline
        accessibilityLabel="What happened"
      />

      <Spacer size={space[5]} />
      <Panel>
        <Label>What gets sent</Label>
        <Spacer size={space[2]} />
        {/* Shown in full, before sending. Nobody should have to guess what
            leaves their phone, and it is a short enough list to just print. */}
        <Body tone={3} size={13}>
          Your message, the state of your upload queue, and the lines below. No footage, no player
          names, no location.
        </Body>
        <Spacer size={space[3]} />
        <Body tone="subtle" size={13} style={styles.mono}>
          {formatDiagnostics(diagnostics).trim()}
        </Body>
      </Panel>

      {failed ? (
        <>
          <Spacer size={space[4]} />
          <Panel>
            <BodyStrong>No mail app on this phone</BodyStrong>
            <Spacer size={space[2]} />
            <Body tone={2} size={13}>
              Email us at {links.supportEmail} from any device, or open the support page.
            </Body>
            <Spacer size={space[3]} />
            <Button
              label="Open support page"
              onPress={() => void openLink(links.support)}
              variant="secondary"
            />
          </Panel>
        </>
      ) : null}

      <Spacer size={space[5]} />
      <Button
        label="Send report"
        onPress={() => void send()}
        disabled={detail.trim().length === 0}
        block
      />
      <Spacer size={space[7]} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    height: minTouchTarget,
    marginLeft: -space[2],
  },
  topics: {
    flexWrap: 'wrap',
  },
  topic: {
    minHeight: minTouchTarget - space[2],
    justifyContent: 'center',
    paddingHorizontal: space[3],
    marginBottom: space[2],
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: line.rule,
    backgroundColor: surface.bg1,
  },
  topicSelected: {
    borderColor: line.borderHi,
    backgroundColor: surface.bg2,
  },
  detail: {
    minHeight: 120,
    backgroundColor: surface.bg1,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
    padding: space[3],
    color: ink[1],
    fontSize: type.ui,
    textAlignVertical: 'top',
  },
  mono: {
    fontFamily: 'DMMono_400Regular',
  },
});
