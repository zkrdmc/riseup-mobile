/**
 * The camera picker.
 *
 * A row showing the current selection, which opens a sheet of the club's saved
 * cameras — the Strava gear picker, and for the same reason: the thing you are
 * choosing was registered once, and picking it should cost one tap rather than
 * a form.
 *
 * WHAT THE SECOND LINE IS FOR. Strava puts accumulated mileage under each pair
 * of shoes. The equivalent here is the lens state — "4K · 34 px of bend", or
 * "No lens model yet" — because that is the fact that decides whether this
 * camera can record, and it is the one an operator would otherwise discover at
 * the preflight gate two screens later.
 *
 * Unsupported classes are shown and disabled rather than hidden. Somebody with
 * a GoPro in Wide mode has to be able to find out why it is not offered, and
 * the reason names the setting that fixes it.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { cameraStore, orderForPicker } from '../capture/devices/store';
import { isSelectable, selectableClasses, type CameraClass } from '../capture/devices/catalogue';
import {
  calibrationSummary,
  classOf,
  readiness,
  type SavedCamera,
} from '../capture/devices/types';
import {
  ink,
  line,
  minTouchTarget,
  radius,
  role as roleColor,
  scrim,
  signal,
  space,
  surface,
  type,
} from '../theme/tokens';
import { Button } from './Button';
import { Row, Rule, Spacer } from './Layout';
import { Body, BodyStrong, Display, Label } from './Text';
import { Pill } from './Status';

interface CameraPickerProps {
  label: string;
  selectedId: string | null;
  onSelect: (camera: SavedCamera) => void;
  /** The capture setting this camera will be used at, if known. */
  capture?: { widthPx: number; heightPx: number; zoomRatio: number } | null;
}

export function CameraPicker({ label, selectedId, onSelect, capture = null }: CameraPickerProps) {
  const cameras = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot);
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => cameras.find((c) => c.id === selectedId) ?? null,
    [cameras, selectedId],
  );

  const state = selected === null ? null : readiness(selected, capture);

  return (
    <View>
      <Label>{label}</Label>
      <Spacer size={space[2]} />

      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={
          selected === null ? `${label}. Nothing selected` : `${label}. ${selected.label}`
        }
        accessibilityHint="Opens the list of your cameras"
        style={({ pressed }) => [styles.field, pressed ? styles.fieldPressed : null]}
      >
        <View style={styles.fieldMain}>
          {selected === null ? (
            <Body tone="subtle">Choose a camera</Body>
          ) : (
            <>
              <BodyStrong numberOfLines={1}>{selected.label}</BodyStrong>
              <Spacer size={space[1]} />
              <Label tone={state?.ready === false ? undefined : 3} color={state?.ready === false ? roleColor.amber.fg : undefined}>
                {state?.ready === false ? 'Not ready' : calibrationSummary(selected)}
              </Label>
            </>
          )}
        </View>
        <Ionicons name="chevron-down" size={18} color={ink.mute} />
      </Pressable>

      {/* The blocking reason belongs on the field, not only inside the sheet —
          the operator has closed the sheet by the time it matters. */}
      {state?.ready === false && state.reason !== null ? (
        <>
          <Spacer size={space[2]} />
          <Body size={13} color={roleColor.amber.fg}>
            {state.reason}
          </Body>
        </>
      ) : null}

      <CameraSheet
        visible={open}
        cameras={cameras}
        selectedId={selectedId}
        capture={capture}
        onClose={() => setOpen(false)}
        onSelect={(camera) => {
          cameraStore.markUsed(camera.id);
          onSelect(camera);
          setOpen(false);
        }}
      />
    </View>
  );
}

/* ── The sheet ────────────────────────────────────────────────────────────── */

function CameraSheet({
  visible,
  cameras,
  selectedId,
  capture,
  onClose,
  onSelect,
}: {
  visible: boolean;
  cameras: SavedCamera[];
  selectedId: string | null;
  capture: { widthPx: number; heightPx: number; zoomRatio: number } | null;
  onClose: () => void;
  onSelect: (camera: SavedCamera) => void;
}) {
  const [adding, setAdding] = useState(false);
  const ordered = useMemo(() => orderForPicker(cameras), [cameras]);

  const close = useCallback(() => {
    setAdding(false);
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={close}
      // Without this the Android back button dismisses the whole screen behind
      // the sheet, which mid-survey loses the step the operator was on.
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropFill} onPress={close} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Spacer size={space[4]} />

          {adding ? (
            <AddCamera onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          ) : (
            <>
              <Display size={24}>Your cameras</Display>
              <Spacer size={space[4]} />

              <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
                {ordered.length === 0 ? (
                  <Body tone={3}>
                    No cameras yet. Add the one you film with and it will be here every match.
                  </Body>
                ) : (
                  ordered.map((camera, index) => (
                    <View key={camera.id}>
                      {index === 0 ? null : <Rule />}
                      <CameraRow
                        camera={camera}
                        selected={camera.id === selectedId}
                        capture={capture}
                        onPress={() => onSelect(camera)}
                      />
                    </View>
                  ))
                )}
                <Spacer size={space[5]} />
              </ScrollView>

              <Rule />
              <Spacer size={space[4]} />
              <Button label="Add a camera" onPress={() => setAdding(true)} block />
              <Spacer size={space[3]} />
              <Button label="Cancel" onPress={close} variant="ghost" block />
            </>
          )}
          <Spacer size={space[6]} />
        </View>
      </View>
    </Modal>
  );
}

function CameraRow({
  camera,
  selected,
  capture,
  onPress,
}: {
  camera: SavedCamera;
  selected: boolean;
  capture: { widthPx: number; heightPx: number; zoomRatio: number } | null;
  onPress: () => void;
}) {
  const cls = classOf(camera);
  const state = readiness(camera, capture);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !state.ready }}
      accessibilityLabel={`${camera.label}. ${calibrationSummary(camera)}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <View style={styles.rowMain}>
        <Row gap={space[2]}>
          <BodyStrong numberOfLines={1}>{camera.label}</BodyStrong>
          {state.ready ? null : <Pill label="Not ready" tone="warn" />}
        </Row>
        <Spacer size={space[1]} />
        <Label tone={3} numberOfLines={1}>
          {cls?.label ?? 'Unknown type'}
        </Label>
        <Spacer size={space.half} />
        <Label tone="subtle" numberOfLines={2}>
          {state.ready ? calibrationSummary(camera) : (state.reason ?? '')}
        </Label>
      </View>
      {selected ? <Ionicons name="checkmark" size={20} color={signal.base} /> : null}
    </Pressable>
  );
}

/* ── Adding one ───────────────────────────────────────────────────────────── */

function AddCamera({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [classId, setClassId] = useState<string | null>(null);
  const [label, setLabel] = useState('');

  const classes = useMemo(selectableClasses, []);
  const chosen = classes.find((c) => c.id === classId) ?? null;
  const canSave = chosen !== null && isSelectable(chosen) && label.trim().length > 0;

  return (
    <View style={styles.addWrap}>
      <Display size={24}>Add a camera</Display>
      <Spacer size={space[2]} />
      <Body tone={3} size={13}>
        Only cameras the analysis can actually handle are listed. The rest say why.
      </Body>
      <Spacer size={space[4]} />

      <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
        {classes.map((cls) => (
          <ClassRow
            key={cls.id}
            cls={cls}
            selected={cls.id === classId}
            onPress={() => setClassId(cls.id)}
          />
        ))}

        {chosen !== null && isSelectable(chosen) ? (
          <>
            <Spacer size={space[5]} />
            <Label>Name it</Label>
            <Spacer size={space[1]} />
            <Body tone={3} size={13}>
              What your club calls it, so whoever picks it up next knows which one this is.
            </Body>
            <Spacer size={space[2]} />
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Club camcorder"
              placeholderTextColor={ink.subtle}
              style={styles.input}
              accessibilityLabel="Camera name"
              autoCapitalize="sentences"
              returnKeyType="done"
            />

            {chosen.requirements.length === 0 ? null : (
              <>
                <Spacer size={space[5]} />
                <Label>Before it can film</Label>
                <Spacer size={space[2]} />
                {chosen.requirements.map((r) => (
                  <View key={r} style={styles.requirement}>
                    <Label tone="subtle">•</Label>
                    <Body tone={2} size={13} style={styles.requirementText}>
                      {r}
                    </Body>
                  </View>
                ))}
              </>
            )}
          </>
        ) : null}
        <Spacer size={space[5]} />
      </ScrollView>

      <Rule />
      <Spacer size={space[4]} />
      <Button
        label="Save"
        onPress={() => {
          if (chosen === null) {
            return;
          }
          cameraStore.add({ classId: chosen.id, label });
          onDone();
        }}
        disabled={!canSave}
        block
      />
      <Spacer size={space[3]} />
      <Button label="Back" onPress={onCancel} variant="ghost" block />
    </View>
  );
}

function ClassRow({
  cls,
  selected,
  onPress,
}: {
  cls: CameraClass;
  selected: boolean;
  onPress: () => void;
}) {
  const usable = isSelectable(cls);

  return (
    <Pressable
      onPress={usable ? onPress : undefined}
      disabled={!usable}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !usable }}
      accessibilityLabel={`${cls.label}. ${usable ? cls.summary : cls.unsupportedReason ?? ''}`}
      style={({ pressed }) => [
        styles.classRow,
        selected ? styles.classRowSelected : null,
        pressed && usable ? styles.rowPressed : null,
        usable ? null : styles.classRowDisabled,
      ]}
    >
      <Row gap={space[2]} align="flex-start">
        <View style={styles.rowMain}>
          <BodyStrong color={usable ? ink[1] : ink.mute}>{cls.label}</BodyStrong>
          <Spacer size={space[1]} />
          <Body tone={3} size={13}>
            {cls.summary}
          </Body>
          {usable ? null : (
            <>
              <Spacer size={space[2]} />
              <Body size={13} color={roleColor.amber.fg}>
                {cls.unsupportedReason}
              </Body>
            </>
          )}
        </View>
        {selected ? <Ionicons name="checkmark" size={20} color={signal.base} /> : null}
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: minTouchTarget + space[2],
    paddingHorizontal: space[3],
    paddingVertical: space[3],
    backgroundColor: surface.bg1,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
  },
  fieldPressed: {
    backgroundColor: surface.bg2,
    borderColor: line.borderHi,
  },
  fieldMain: {
    flex: 1,
  },

  backdrop: {
    flex: 1,
    backgroundColor: scrim,
    justifyContent: 'flex-end',
  },
  backdropFill: {
    flex: 1,
  },
  sheet: {
    maxHeight: '85%',
    backgroundColor: surface.bg1,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: line.border,
    paddingHorizontal: space[5],
    paddingTop: space[2],
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: line.borderHi,
  },
  list: {
    flexGrow: 0,
  },
  addWrap: {
    flexShrink: 1,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: minTouchTarget + space[3],
    paddingVertical: space[3],
  },
  rowPressed: {
    backgroundColor: surface.bg2,
  },
  rowMain: {
    flex: 1,
  },

  classRow: {
    paddingVertical: space[3],
    paddingHorizontal: space[3],
    marginBottom: space[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: line.rule,
    backgroundColor: surface.bg0,
  },
  classRowSelected: {
    borderColor: line.borderHi,
    backgroundColor: surface.bg2,
  },
  classRowDisabled: {
    opacity: 0.55,
  },

  input: {
    height: 48,
    backgroundColor: surface.bg0,
    borderWidth: 1,
    borderColor: line.border,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    color: ink[1],
    fontSize: type.ui,
  },
  requirement: {
    flexDirection: 'row',
    gap: space[2],
    marginBottom: space[2],
  },
  requirementText: {
    flex: 1,
  },
});
