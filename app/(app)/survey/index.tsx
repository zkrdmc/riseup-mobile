/**
 * The rig survey — the guided sequence before recording.
 *
 * One screen with internal steps rather than five routes: the operator moves
 * back and forth between them constantly while walking around a pitch, and a
 * nav stack five deep with a survey half-entered in it is the wrong shape for
 * that. It also keeps the whole flow trivially offline (PRD §3).
 *
 * ORDER FOLLOWS THE WALK, not the data model. Pace the pitch once, place phone
 * A, place phone B, measure between them, read the verdict. Anything else
 * makes the operator cross the pitch more times than they need to, in the dark,
 * with a match about to start.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { checkBaseline } from '../../../src/capture/survey/derive';
import {
  missingFields,
  stepsFor,
  surveyDraft,
  toRigSurvey,
  type DraftCamera,
  type DraftMeasure,
  type SurveyStep,
} from '../../../src/capture/survey/draft';
import { validateSurvey, type SurveyIssue } from '../../../src/capture/survey/validate';
import { captureOrientation, captureVenueFix } from '../../../src/capture/sensors/device';
import {
  LOCATION_DISCLOSURE,
  hasAcceptedLocationDisclosure,
  recordLocationDisclosureAccepted,
} from '../../../src/capture/sensors/locationDisclosure';
import { cameraStore } from '../../../src/capture/devices/store';
import { CameraPicker } from '../../../src/ui/CameraPicker';
import type { RigRole } from '../../../src/capture/survey/schema';
import { ink, line, minTouchTarget, radius, role as roleColor, signal, space, surface, type } from '../../../src/theme/tokens';
import { Button } from '../../../src/ui/Button';
import { Panel, Row, Screen, Spacer } from '../../../src/ui/Layout';
import { MeasurementInput } from '../../../src/ui/MeasurementInput';
import { Pill } from '../../../src/ui/Status';
import { Body, BodyStrong, Display, Label, Metric } from '../../../src/ui/Text';

const APP_VERSION = '0.1.0';

const STEP_TITLES: Record<SurveyStep, string> = {
  rig: 'What are you filming with?',
  venue: 'The pitch',
  cameraA: 'Phone A',
  cameraB: 'Phone B',
  baseline: 'Between the phones',
  review: 'Check',
};

export default function SurveyScreen() {
  const router = useRouter();
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);

  useEffect(() => {
    void surveyDraft.hydrate();
    void cameraStore.hydrate();
  }, []);

  // The steps this survey has, not all of them: a single-camera setup has no
  // phone B and no baseline, and showing them would imply an incomplete survey.
  const steps = stepsFor(draft);
  const stepIndex = steps.indexOf(draft.step);

  const goTo = useCallback((step: SurveyStep) => {
    surveyDraft.update({ step });
  }, []);

  const next = useCallback(() => {
    const n = steps[stepIndex + 1];
    if (n !== undefined) {
      goTo(n);
    }
  }, [steps, stepIndex, goTo]);

  const back = useCallback(() => {
    const p = steps[stepIndex - 1];
    if (p === undefined) {
      router.back();
      return;
    }
    goTo(p);
  }, [steps, stepIndex, goTo, router]);

  return (
    <Screen scroll>
      <Spacer size={space[3]} />
      <Row gap={space[2]}>
        <Label>{`Step ${stepIndex + 1} of ${steps.length}`}</Label>
      </Row>
      <Spacer size={space[2]} />
      <StepBar index={stepIndex} total={steps.length} />
      <Spacer size={space[4]} />
      <Display>{STEP_TITLES[draft.step]}</Display>
      <Spacer size={space[5]} />

      {draft.step === 'rig' ? <RigStep /> : null}
      {draft.step === 'venue' ? <VenueStep /> : null}
      {draft.step === 'cameraA' ? <CameraStep role="A" /> : null}
      {draft.step === 'cameraB' ? <CameraStep role="B" /> : null}
      {draft.step === 'baseline' ? <BaselineStep /> : null}
      {draft.step === 'review' ? <ReviewStep /> : null}

      <Spacer size={space[6]} />
      <Row gap={space[3]}>
        <Button label="Back" onPress={back} variant="secondary" />
        {draft.step === 'review' ? null : (
          <Button label="Next" onPress={next} style={styles.grow} />
        )}
      </Row>
      <Spacer size={space[8]} />
    </Screen>
  );
}

/* ── Steps ────────────────────────────────────────────────────────────────── */

/**
 * What is doing the filming.
 *
 * First, because it changes everything after it. A phone can be interrogated
 * for its lens, its timing and its settings; a camcorder cannot, and every
 * later step has to ask a human instead. Getting this wrong halfway through
 * means redoing the camera steps.
 */
function RigStep() {
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);

  return (
    <View>
      <Body tone={2}>
        The app can read a phone&apos;s lens directly. Anything else has to be measured, so it asks
        you a few more questions.
      </Body>

      <Spacer size={space[5]} />
      <Label>How many cameras?</Label>
      <Spacer size={space[2]} />
      <Choice
        value={draft.rigMode}
        options={[
          { value: 'pair', label: 'Two' },
          { value: 'single', label: 'One' },
        ]}
        onChange={(rigMode) => surveyDraft.update({ rigMode })}
      />
      <Spacer size={space[2]} />
      <Body tone={3} size={13}>
        {draft.rigMode === 'single'
          ? 'One camera covers the whole pitch from further back. Fewer pixels on each player, and no seam to hand identities across.'
          : 'Two cameras, one per half, with an overlap in the middle where players are handed from one to the other.'}
      </Body>

      <Spacer size={space[5]} />
      {(draft.rigMode === 'single' ? [draft.cameras[0]] : draft.cameras).map((camera) => (
        <View key={camera.role} style={styles.sourceBlock}>
          <CameraPicker
            label={draft.rigMode === 'single' ? 'The camera' : `Camera ${camera.role}`}
            selectedId={camera.savedCameraId}
            onSelect={(saved) =>
              surveyDraft.updateCamera(camera.role, {
                savedCameraId: saved.id,
                sourceKind: saved.kind,
                deviceModel: saved.label,
                external: {
                  ...camera.external,
                  make: saved.make,
                  model: saved.model,
                },
              })
            }
          />
        </View>
      ))}
    </View>
  );
}

function VenueStep() {
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);
  const [locating, setLocating] = useState(false);

  const runFix = useCallback(async () => {
    setLocating(true);
    try {
      const fix = await captureVenueFix();
      surveyDraft.update({ venueFix: fix });
    } finally {
      setLocating(false);
    }
  }, []);

  /**
   * Google Play requires a prominent disclosure BEFORE the system permission
   * dialog — naming the data, its purpose, and taking an affirmative action.
   * The OS prompt alone does not satisfy it. Shown once, then remembered.
   */
  const findVenue = useCallback(async () => {
    if (await hasAcceptedLocationDisclosure()) {
      await runFix();
      return;
    }
    Alert.alert(LOCATION_DISCLOSURE.title, LOCATION_DISCLOSURE.body, [
      { text: LOCATION_DISCLOSURE.decline, style: 'cancel' },
      {
        text: LOCATION_DISCLOSURE.accept,
        onPress: () => {
          void (async () => {
            await recordLocationDisclosureAccepted();
            await runFix();
          })();
        },
      },
    ]);
  }, [runFix]);

  return (
    <View>
      <Body tone={2}>
        Measure all four sides. Municipal pitches are rarely square, and knowing the real shape is
        what keeps positions honest — this is once per ground, not once per match.
      </Body>
      <Spacer size={space[5]} />

      <Measure field="northTouchlineM" label="North touchline" hint="The long side you are standing behind." />
      <Measure field="southTouchlineM" label="South touchline" hint="The far long side." />
      <Measure field="westGoalLineM" label="West goal line" hint="Goal line to your left as you face the pitch." />
      <Measure field="eastGoalLineM" label="East goal line" hint="Goal line to your right." />
      <Measure
        field="diagonalM"
        label="A diagonal (optional)"
        hint="Corner to opposite corner. Four sides do not prove a rectangle — a leaning one has the same four. This settles it."
      />

      <Label>Markings</Label>
      <Spacer size={space[2]} />
      <Body tone={3} size={13}>
        The line-finder at processing reads these. If they are faint, the points you tap matter more.
      </Body>
      <Spacer size={space[3]} />
      <Choice
        value={draft.markingCondition}
        options={[
          { value: 'fresh', label: 'Fresh' },
          { value: 'worn', label: 'Worn' },
          { value: 'faint', label: 'Faint' },
          { value: 'absent', label: 'Missing' },
        ]}
        onChange={(markingCondition) => surveyDraft.update({ markingCondition })}
      />

      <Spacer size={space[5]} />
      <Label>Surface</Label>
      <Spacer size={space[2]} />
      <Choice
        value={draft.surface}
        options={[
          { value: 'grass', label: 'Grass' },
          { value: 'artificial', label: 'Artificial' },
          { value: 'hybrid', label: 'Hybrid' },
          { value: 'dirt', label: 'Dirt' },
        ]}
        onChange={(surface) => surveyDraft.update({ surface })}
      />

      <Spacer size={space[5]} />
      <Panel>
        <Label>Which ground is this?</Label>
        <Spacer size={space[2]} />
        <Body tone={3} size={13}>
          A GPS fix identifies the venue so these measurements can be reused next time. It is far
          too rough to place a camera — that is what the tape is for.
        </Body>
        <Spacer size={space[3]} />
        {draft.venueFix === null ? (
          <Button
            label={locating ? 'Finding…' : 'Tag this ground'}
            onPress={() => void findVenue()}
            variant="secondary"
            busy={locating}
          />
        ) : (
          <Row gap={space[2]}>
            <Pill label="Tagged" tone="live" />
            <Metric size={13} tone="mute">
              {`± ${draft.venueFix.accuracyM.toFixed(0)} m`}
            </Metric>
          </Row>
        )}
      </Panel>
    </View>
  );
}

function CameraStep({ role }: { role: RigRole }) {
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);
  const camera = draft.cameras.find((c) => c.role === role) as DraftCamera;
  const [measuring, setMeasuring] = useState(false);

  const measureTilt = useCallback(async () => {
    setMeasuring(true);
    try {
      const orientation = await captureOrientation();
      surveyDraft.updateCamera(role, { orientation });
    } finally {
      setMeasuring(false);
    }
  }, [role]);

  const set = useCallback(
    (field: keyof DraftCamera) => (value: number | null, method: DraftMeasure['method']) => {
      surveyDraft.updateCamera(role, { [field]: { value, method } } as Partial<DraftCamera>);
    },
    [role],
  );

  return (
    <View>
      <Body tone={2}>
        Mount it first, then measure. Everything here is from the ground to the lens, not to the
        tripod or your eye.
      </Body>
      <Spacer size={space[5]} />

      <MeasurementInput
        label="Height to the lens"
        hint="Ground to the middle of the camera lens. Not the top of the tripod — that difference is about a quarter of a degree of tilt at 30 m."
        value={camera.heightM.value}
        method={camera.heightM.method}
        onChange={set('heightM')}
      />

      <MeasurementInput
        label="Distance back from the touchline"
        hint="Straight out from the line, at a right angle. Aim for about 30 m; below 20 m the two cameras stop overlapping enough to follow players across."
        value={camera.perpendicularDistanceM.value}
        method={camera.perpendicularDistanceM.method}
        onChange={set('perpendicularDistanceM')}
      />

      <MeasurementInput
        label="Distance along the touchline"
        hint="From the halfway line. Negative toward the west goal, positive toward the east — the two phones should have opposite signs."
        value={camera.alongTouchlineM.value}
        method={camera.alongTouchlineM.method}
        onChange={set('alongTouchlineM')}
        allowNegative
      />

      <Label>Which half does it cover?</Label>
      <Spacer size={space[2]} />
      <Choice
        value={camera.coversHalf}
        options={[
          { value: 'west', label: 'West half' },
          { value: 'east', label: 'East half' },
        ]}
        onChange={(coversHalf) => surveyDraft.updateCamera(role, { coversHalf })}
      />

      <Spacer size={space[5]} />
      <Label>Which touchline are you behind?</Label>
      <Spacer size={space[2]} />
      <Choice
        value={camera.touchlineSide}
        options={[
          { value: 'north', label: 'North' },
          { value: 'south', label: 'South' },
        ]}
        onChange={(touchlineSide) => surveyDraft.updateCamera(role, { touchlineSide })}
      />

      <Spacer size={space[5]} />
      <Panel>
        <Label>Tilt and roll</Label>
        <Spacer size={space[2]} />
        <Body tone={3} size={13}>
          The phone can feel which way is down to about a degree. It is a cross-check on the
          calibration later — leave it mounted and still while this runs.
        </Body>
        <Spacer size={space[3]} />
        {camera.orientation === null ? (
          <Button
            label={measuring ? 'Hold still…' : 'Measure tilt'}
            onPress={() => void measureTilt()}
            variant="secondary"
            busy={measuring}
          />
        ) : (
          <View>
            <Row gap={space[5]}>
              <View>
                <Label>Tilt down</Label>
                <Metric size={20}>{`${camera.orientation.tiltDeg.value.toFixed(1)}°`}</Metric>
              </View>
              <View>
                <Label>Roll</Label>
                <Metric size={20}>{`${camera.orientation.rollDeg.value.toFixed(1)}°`}</Metric>
              </View>
            </Row>
            <Spacer size={space[3]} />
            {camera.orientation.stable ? (
              <Pill label="Steady" tone="live" dot />
            ) : (
              <Body tone={2} size={13}>
                It was still moving. Let it settle and measure again.
              </Body>
            )}
            <Spacer size={space[3]} />
            <Button
              label="Measure again"
              onPress={() => void measureTilt()}
              variant="ghost"
              busy={measuring}
            />
          </View>
        )}
      </Panel>
    </View>
  );
}

function BaselineStep() {
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);

  // Live, so the operator sees the disagreement while both tapes are still out
  // and the phones are still where they were measured from.
  const check = useMemo(() => checkBaseline(toRigSurvey(draft, APP_VERSION)), [draft]);

  return (
    <View>
      <Body tone={2}>
        Measure straight between the two phones with the tape. This can be worked out from the two
        positions — measuring it anyway is what turns a mistake into something we can catch.
      </Body>
      <Spacer size={space[5]} />

      <MeasurementInput
        label="Distance between the phones"
        hint="Lens to lens, straight line."
        value={draft.baselineM.value}
        method={draft.baselineM.method}
        onChange={(value, method) => surveyDraft.update({ baselineM: { value, method } })}
      />

      {check === null ? null : (
        <Panel>
          <Label>Cross-check</Label>
          <Spacer size={space[3]} />
          <Row gap={space[5]}>
            <View>
              <Label>From positions</Label>
              <Metric size={20}>{`${check.derivedM.toFixed(1)} m`}</Metric>
            </View>
            <View>
              <Label>From the tape</Label>
              <Metric size={20}>
                {check.measuredM === null ? '—' : `${check.measuredM.toFixed(1)} m`}
              </Metric>
            </View>
          </Row>
          {check.residualM === null ? null : (
            <>
              <Spacer size={space[3]} />
              <Body
                size={13}
                color={Math.abs(check.zScore ?? 0) > 3 ? roleColor.red.fg : signal.base}
              >
                {Math.abs(check.zScore ?? 0) > 3
                  ? `They disagree by ${Math.abs(check.residualM).toFixed(1)} m. One of the three ` +
                    `measurements is wrong — usually a distance along the touchline.`
                  : `They agree to ${Math.abs(check.residualM).toFixed(2)} m. Both positions check out.`}
              </Body>
            </>
          )}
        </Panel>
      )}
    </View>
  );
}

function ReviewStep() {
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);
  const router = useRouter();

  const missing = useMemo(() => missingFields(draft), [draft]);
  const issues = useMemo<SurveyIssue[]>(
    () => (missing.length > 0 ? [] : validateSurvey(toRigSurvey(draft, APP_VERSION))),
    [draft, missing.length],
  );

  const blocking = issues.filter((i) => i.blocking);

  return (
    <View>
      {missing.length > 0 ? (
        <>
          <Body tone={2}>Still to fill in:</Body>
          <Spacer size={space[3]} />
          {missing.map((m) => (
            <Pressable
              key={`${m.step}.${m.field}`}
              onPress={() => surveyDraft.update({ step: m.step })}
              accessibilityRole="button"
              accessibilityLabel={`${m.label}. Go to ${STEP_TITLES[m.step]}`}
              style={styles.missingRow}
            >
              <Body>{m.label}</Body>
              <Label tone={3}>{STEP_TITLES[m.step]}</Label>
            </Pressable>
          ))}
        </>
      ) : (
        <>
          <Row gap={space[2]}>
            <Pill
              label={blocking.length === 0 ? 'Ready to record' : `${blocking.length} to fix`}
              tone={blocking.length === 0 ? 'live' : 'error'}
              dot
            />
          </Row>
          <Spacer size={space[4]} />
          {issues.length === 0 ? (
            <Body tone={2}>Nothing to flag. The rig is surveyed.</Body>
          ) : (
            issues.map((issue) => <IssueCard key={`${issue.code}-${issue.role}`} issue={issue} />)
          )}
        </>
      )}

      <Spacer size={space[5]} />
      <Label>Notes</Label>
      <Spacer size={space[2]} />
      <TextInput
        value={draft.notes}
        onChangeText={(notes) => surveyDraft.update({ notes })}
        placeholder="Wind, light, anything odd about the ground"
        placeholderTextColor={ink.subtle}
        style={styles.notes}
        multiline
        accessibilityLabel="Notes"
      />

      <Spacer size={space[5]} />
      <Button
        label="Start over"
        onPress={() => {
          surveyDraft.reset();
          router.back();
        }}
        variant="ghost"
      />
    </View>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

function IssueCard({ issue }: { issue: SurveyIssue }) {
  return (
    <View
      style={[
        styles.issue,
        { borderColor: issue.blocking ? roleColor.red.border : line.rule },
      ]}
    >
      <View
        style={[
          styles.issueEdge,
          { backgroundColor: issue.blocking ? roleColor.red.fg : roleColor.amber.fg },
        ]}
      />
      <View style={styles.issueBody}>
        <Row gap={space[2]}>
          <Label color={issue.blocking ? roleColor.red.fg : roleColor.amber.fg}>
            {issue.blocking ? 'Must fix' : 'Worth knowing'}
          </Label>
          {issue.role === null ? null : <Label tone="subtle">{`Phone ${issue.role}`}</Label>}
        </Row>
        <Spacer size={space[2]} />
        <Body size={13}>{issue.message}</Body>
      </View>
    </View>
  );
}

function StepBar({ index, total }: { index: number; total: number }) {
  return (
    <Row gap={space[1]}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={[styles.stepSegment, i <= index ? styles.stepSegmentDone : null]}
        />
      ))}
    </Row>
  );
}

function Measure({
  field,
  label,
  hint,
}: {
  field: 'northTouchlineM' | 'southTouchlineM' | 'westGoalLineM' | 'eastGoalLineM' | 'diagonalM';
  label: string;
  hint: string;
}) {
  const draft = useSyncExternalStore(surveyDraft.subscribe, surveyDraft.getSnapshot);
  const measure = draft[field];
  return (
    <MeasurementInput
      label={label}
      hint={hint}
      value={measure.value}
      method={measure.method}
      onChange={(value, method) => surveyDraft.update({ [field]: { value, method } })}
    />
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Row gap={space[2]} style={styles.choices}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === o.value }}
          accessibilityLabel={o.label}
          style={[styles.choice, value === o.value ? styles.choiceSelected : null]}
        >
          <BodyStrong color={value === o.value ? ink[1] : ink.mute}>{o.label}</BodyStrong>
        </Pressable>
      ))}
    </Row>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  stepSegment: {
    flex: 1,
    height: 2,
    borderRadius: radius.full,
    backgroundColor: surface.bg3,
  },
  stepSegmentDone: {
    backgroundColor: ink[2],
  },
  choices: {
    flexWrap: 'wrap',
  },
  choice: {
    minHeight: minTouchTarget,
    justifyContent: 'center',
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: line.rule,
    backgroundColor: surface.bg1,
  },
  choiceSelected: {
    borderColor: line.borderHi,
    backgroundColor: surface.bg2,
  },
  sourceBlock: {
    marginBottom: space[5],
  },
  missingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: minTouchTarget,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: line.rule,
  },
  issue: {
    flexDirection: 'row',
    backgroundColor: surface.bg1,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: space[3],
  },
  issueEdge: {
    width: 3,
    alignSelf: 'stretch',
  },
  issueBody: {
    flex: 1,
    padding: space[4],
  },
  notes: {
    minHeight: 88,
    backgroundColor: surface.bg1,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
    padding: space[3],
    color: ink[1],
    fontSize: type.ui,
    textAlignVertical: 'top',
  },
});
