/**
 * The survey in progress.
 *
 * Persisted on every keystroke, because of where it is filled in: outdoors,
 * one-handed, in the dark, with a match about to start, on a phone that may be
 * killed by the OS the moment the operator switches to the torch. A survey
 * that has to be started again because the app was backgrounded is a survey
 * that gets rushed the second time.
 *
 * Kept as loose values plus a stated method rather than as `Quantity` objects,
 * so a half-filled field is representable. `toRigSurvey` is the one place that
 * turns a complete draft into the real record, and it is where the sigmas get
 * attached.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { sigmaFor, type MeasurementMethod } from '../../ui/MeasurementInput';
import type { DistortionFit } from './distortion';
import type { ExifCameraFacts } from './exif';
import {
  SURVEY_SCHEMA_VERSION,
  measured,
  type CameraSourceKind,
  type CameraSurvey,
  type ControlledSettings,
  type ExternalCameraFacts,
  type Distortion,
  type Intrinsics,
  type OrientationSample,
  type PitchSurvey,
  type RigRole,
  type RigSurvey,
  type TimingProfile,
  type VenueFix,
} from './schema';

/** A number the operator has partly entered, and how they got it. */
export interface DraftMeasure {
  value: number | null;
  method: MeasurementMethod;
}

export const emptyMeasure = (method: MeasurementMethod = 'tape'): DraftMeasure => ({
  value: null,
  method,
});

/** The external-camera answers, all of which are claims rather than readbacks. */
export interface DraftExternal {
  make: string | null;
  model: string | null;
  lensModel: string | null;
  stabilisationConfirmedOff: boolean;
  focusConfirmedLocked: boolean;
  exposureConfirmedLocked: boolean;
  exifSameModeConfirmed: boolean;
  videoWidthPx: number | null;
  videoHeightPx: number | null;
  /** Raw EXIF facts from the sample still, kept so the derivation can be redone. */
  exif: ExifCameraFacts | null;
  /**
   * "Film it anyway and treat the lens as rectilinear."
   *
   * PRD §4.3 blocks recording without a lens model, and then provides this
   * door — because a club that turns up with an uncalibrated camera and no
   * chessboard should still get a match filmed. What it must not do is get one
   * filmed while believing it is calibrated, so the acknowledgement is
   * explicit, it travels in the record, and the job is marked with it.
   */
  acknowledgedRectilinear: boolean;
}

export const emptyExternal = (): DraftExternal => ({
  make: null,
  model: null,
  lensModel: null,
  // All false by default, and the operator has to actively say otherwise.
  // Defaulting these to true would turn the most dangerous setting in the
  // whole survey into something you get by tapping Next.
  stabilisationConfirmedOff: false,
  focusConfirmedLocked: false,
  exposureConfirmedLocked: false,
  exifSameModeConfirmed: false,
  videoWidthPx: null,
  videoHeightPx: null,
  exif: null,
  acknowledgedRectilinear: false,
});

export interface DraftCamera {
  role: RigRole;
  /**
   * Which saved camera this is (`src/capture/devices/store.ts`).
   *
   * Replaces typing a make and model every match. The saved camera carries its
   * own lens calibration, which is what makes PRD 4.3's "once per camera, not
   * once per match" actually true rather than aspirational.
   */
  savedCameraId: string | null;
  sourceKind: CameraSourceKind;
  external: DraftExternal;
  /** A plumb-line distortion fit, for a camera that reports nothing. */
  distortionFit: DistortionFit | null;
  /** The frame the lines were tapped on, kept so the fit can be redone. */
  frameUri: string | null;
  deviceId: string | null;
  deviceModel: string | null;

  heightM: DraftMeasure;
  perpendicularDistanceM: DraftMeasure;
  alongTouchlineM: DraftMeasure;
  coversHalf: 'west' | 'east';
  touchlineSide: 'north' | 'south';

  /** Filled by the accelerometer burst. Null until measured. */
  orientation: OrientationSample | null;
  /** Filled by the native module. Null until it exists and has been read. */
  intrinsics: Intrinsics | null;
  distortion: Distortion | null;
  settings: ControlledSettings | null;
  timing: TimingProfile | null;
}

export interface SurveyDraft {
  surveyId: string;
  startedAt: string;
  step: SurveyStep;
  rigMode: 'single' | 'pair';

  venueId: string | null;
  venueFix: VenueFix | null;

  northTouchlineM: DraftMeasure;
  southTouchlineM: DraftMeasure;
  westGoalLineM: DraftMeasure;
  eastGoalLineM: DraftMeasure;
  diagonalM: DraftMeasure;
  markingCondition: PitchSurvey['markingCondition'];
  surface: PitchSurvey['surface'];

  cameras: [DraftCamera, DraftCamera];
  baselineM: DraftMeasure;
  notes: string;
}

/**
 * The guided sequence.
 *
 * One thing at a time, in the order the operator physically does them: pace
 * out the pitch once, then place each phone, then measure between them, then
 * read the verdict. PRD §4.2 asks for exactly this shape for the framing
 * points, and the survey is the step before it.
 */
export const SURVEY_STEPS = ['rig', 'venue', 'cameraA', 'cameraB', 'baseline', 'review'] as const;
export type SurveyStep = (typeof SURVEY_STEPS)[number];

/**
 * The steps this particular survey actually has.
 *
 * A single-camera setup has no second camera and no baseline — and showing
 * those steps greyed out, or showing them and letting the operator skip, both
 * imply the survey is incomplete when it is not. A club filming on one
 * camcorder has done everything that can be done.
 */
export function stepsFor(draft: SurveyDraft): SurveyStep[] {
  if (draft.rigMode === 'single') {
    return SURVEY_STEPS.filter((s) => s !== 'cameraB' && s !== 'baseline');
  }
  return [...SURVEY_STEPS];
}

const STORAGE_KEY = 'riseup.surveyDraft.v1';

function emptyCamera(role: RigRole): DraftCamera {
  return {
    role,
    // The phone is the default because it is the case the app can verify. An
    // operator using a camcorder has to say so, which is the right way round:
    // the weaker path should be chosen deliberately.
    savedCameraId: null,
    sourceKind: 'phone',
    external: emptyExternal(),
    distortionFit: null,
    frameUri: null,
    deviceId: null,
    deviceModel: null,
    heightM: emptyMeasure(),
    perpendicularDistanceM: emptyMeasure(),
    alongTouchlineM: emptyMeasure(),
    // A is west, B is east by default. Arbitrary but not random: it matches
    // the sign convention on alongTouchlineM, so the defaults are consistent
    // with each other and an operator who changes nothing is not already wrong.
    coversHalf: role === 'A' ? 'west' : 'east',
    touchlineSide: 'north',
    orientation: null,
    intrinsics: null,
    distortion: null,
    settings: null,
    timing: null,
  };
}

export function emptyDraft(): SurveyDraft {
  return {
    surveyId: Crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    step: 'rig',
    rigMode: 'pair',
    venueId: null,
    venueFix: null,
    northTouchlineM: emptyMeasure('paced'),
    southTouchlineM: emptyMeasure('paced'),
    westGoalLineM: emptyMeasure('paced'),
    eastGoalLineM: emptyMeasure('paced'),
    diagonalM: emptyMeasure('paced'),
    markingCondition: 'worn',
    surface: 'grass',
    cameras: [emptyCamera('A'), emptyCamera('B')],
    baselineM: emptyMeasure(),
    notes: '',
  };
}

/* ── Store ────────────────────────────────────────────────────────────────── */

type Listener = () => void;

class SurveyDraftStore {
  private draft: SurveyDraft = emptyDraft();
  private listeners = new Set<Listener>();
  private hydrated = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SurveyDraft => this.draft;

  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        this.draft = JSON.parse(raw) as SurveyDraft;
        this.emit();
      }
    } catch {
      // A corrupt draft is not worth blocking a setup for. Starting fresh
      // costs a few minutes; failing to open the screen costs the match.
    }
  }

  update(patch: Partial<SurveyDraft>): void {
    this.draft = { ...this.draft, ...patch };
    this.emit();
  }

  updateCamera(role: RigRole, patch: Partial<DraftCamera>): void {
    this.draft = {
      ...this.draft,
      cameras: this.draft.cameras.map((c) =>
        c.role === role ? { ...c, ...patch } : c,
      ) as [DraftCamera, DraftCamera],
    };
    this.emit();
  }

  reset(): void {
    this.draft = emptyDraft();
    this.emit();
  }

  private emit(): void {
    this.draft = { ...this.draft };
    for (const l of this.listeners) {
      l();
    }
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.draft)).catch(() => {
      // Still usable this session; it just will not survive a kill.
    });
  }
}

export const surveyDraft = new SurveyDraftStore();

/* ── Draft → record ───────────────────────────────────────────────────────── */

export interface Incomplete {
  step: SurveyStep;
  field: string;
  label: string;
}

/**
 * What is still missing, as a list the review screen can render.
 *
 * Separate from `validateSurvey`: this is "you have not filled it in", which
 * is a different problem from "what you filled in is wrong", and conflating
 * the two produces a screen that tells an operator their pitch is not
 * rectangular before they have entered a second side.
 */
export function missingFields(draft: SurveyDraft): Incomplete[] {
  const missing: Incomplete[] = [];

  const need = (m: DraftMeasure, step: SurveyStep, field: string, label: string) => {
    if (m.value === null) {
      missing.push({ step, field, label });
    }
  };

  need(draft.northTouchlineM, 'venue', 'northTouchlineM', 'North touchline');
  need(draft.southTouchlineM, 'venue', 'southTouchlineM', 'South touchline');
  need(draft.westGoalLineM, 'venue', 'westGoalLineM', 'West goal line');
  need(draft.eastGoalLineM, 'venue', 'eastGoalLineM', 'East goal line');

  for (const camera of draft.cameras) {
    const step: SurveyStep = camera.role === 'A' ? 'cameraA' : 'cameraB';
    need(camera.heightM, step, 'heightM', `Phone ${camera.role} height`);
    need(
      camera.perpendicularDistanceM,
      step,
      'perpendicularDistanceM',
      `Phone ${camera.role} distance from touchline`,
    );
    need(
      camera.alongTouchlineM,
      step,
      'alongTouchlineM',
      `Phone ${camera.role} distance along touchline`,
    );
    if (camera.orientation === null) {
      missing.push({
        step,
        field: 'orientation',
        label: `Phone ${camera.role} tilt not measured`,
      });
    }
  }

  return missing;
}

/**
 * Build the record.
 *
 * Anything the device has not supplied stays null rather than being defaulted.
 * A zeroed intrinsic matrix is indistinguishable from a measured one to every
 * consumer downstream, and the validator's `NO_INTRINSICS` exists precisely so
 * that absence is reported instead of filled in.
 */
export function toRigSurvey(draft: SurveyDraft, appVersion: string): RigSurvey {
  const q = (m: DraftMeasure) =>
    m.value === null ? measured(0, 0) : measured(m.value, sigmaFor(m.method, m.value));

  const cameras: CameraSurvey[] = activeCameras(draft).map((c) => ({
    role: c.role,
    sourceKind: c.sourceKind,
    external: c.sourceKind === 'external' ? toExternalFacts(c) : null,
    deviceId: c.deviceId ?? 'unknown',
    deviceModel: c.deviceModel ?? c.external.model ?? 'unknown',
    heightM: q(c.heightM),
    perpendicularDistanceM: q(c.perpendicularDistanceM),
    alongTouchlineM: q(c.alongTouchlineM),
    coversHalf: c.coversHalf,
    touchlineSide: c.touchlineSide,
    orientation: c.orientation ?? {
      tiltDeg: { value: 0, sigma: null, provenance: 'device' },
      rollDeg: { value: 0, sigma: null, provenance: 'device' },
      headingDeg: null,
      stable: false,
      sampleCount: 0,
      durationMs: 0,
      capturedAt: new Date().toISOString(),
    },
    intrinsics: c.intrinsics ?? {
      source: 'unknown',
      fxPx: { value: 0, sigma: null, provenance: 'device' },
      fyPx: { value: 0, sigma: null, provenance: 'device' },
      cxPx: { value: 0, sigma: null, provenance: 'device' },
      cyPx: { value: 0, sigma: null, provenance: 'device' },
      skew: null,
      focalLengthMm: null,
      sensorPhysicalWidthMm: null,
      sensorPhysicalHeightMm: null,
      activeArrayWidthPx: 0,
      activeArrayHeightPx: 0,
    },
    distortion: distortionFor(c),
    settings: c.settings ?? {
      videoStabilisation: 'not_attempted',
      opticalStabilisation: 'not_attempted',
      autofocusLock: 'not_attempted',
      autoExposureLock: 'not_attempted',
      whiteBalanceLock: 'not_attempted',
      zoomRatio: 1,
      cropRegion: null,
      lensId: null,
      lensFacing: 'unknown',
    },
    timing: c.timing ?? {
      nominalFps: 30,
      measuredFps: null,
      frameIntervalJitterMs: null,
      rollingShutterSkewNs: null,
      timestampSource: 'unknown',
      sampleTimestampsNs: null,
    },
  }));

  return {
    schemaVersion: SURVEY_SCHEMA_VERSION,
    surveyId: draft.surveyId,
    sessionId: null,
    venueId: draft.venueId,
    startedAt: draft.startedAt,
    completedAt: new Date().toISOString(),
    rigMode: draft.rigMode,
    pitch: {
      northTouchlineM: q(draft.northTouchlineM),
      southTouchlineM: q(draft.southTouchlineM),
      westGoalLineM: q(draft.westGoalLineM),
      eastGoalLineM: q(draft.eastGoalLineM),
      diagonalM: draft.diagonalM.value === null ? null : q(draft.diagonalM),
      markingCondition: draft.markingCondition,
      surface: draft.surface,
      notes: null,
    },
    venueFix: draft.venueFix,
    cameras,
    baselineM: draft.baselineM.value === null ? null : q(draft.baselineM),
    notes: draft.notes.length > 0 ? draft.notes : null,
    appVersion,
  };
}

/** The cameras this survey actually has. A single rig has one. */
export function activeCameras(draft: SurveyDraft): DraftCamera[] {
  return draft.rigMode === 'single' ? [draft.cameras[0]] : [...draft.cameras];
}

function toExternalFacts(c: DraftCamera): ExternalCameraFacts {
  return {
    make: c.external.make,
    model: c.external.model,
    lensModel: c.external.lensModel,
    stabilisationConfirmedOff: c.external.stabilisationConfirmedOff,
    focusConfirmedLocked: c.external.focusConfirmedLocked,
    exposureConfirmedLocked: c.external.exposureConfirmedLocked,
    exifSameModeConfirmed: c.external.exifSameModeConfirmed,
    videoWidthPx: c.external.videoWidthPx,
    videoHeightPx: c.external.videoHeightPx,
    acknowledgedRectilinear: c.external.acknowledgedRectilinear,
  };
}

/**
 * The lens model for this camera.
 *
 * A plumb-line fit wins over a device report only because a device that
 * reported anything would not have been given a fit in the first place. Absent
 * both, the model is `unknown` — NOT `none`. `none` is a finding ("this lens
 * is rectilinear"); `unknown` is an absence, and PRD §4.3 blocks recording on
 * the second and not the first.
 */
function distortionFor(c: DraftCamera): Distortion {
  if (c.distortionFit !== null) {
    const f = c.distortionFit;
    return {
      model: 'division',
      radial: null,
      tangential: null,
      lookupTable: null,
      division: {
        lambda: f.lambda,
        normalisationPx: f.normalisationPx,
        principalPointX: f.principalPointPx.x,
        principalPointY: f.principalPointPx.y,
        imageWidthPx: f.imageWidthPx,
        imageHeightPx: f.imageHeightPx,
        rmsResidualPx: f.rmsResidualPx,
        rmsResidualBeforePx: f.rmsResidualBeforePx,
        lineCount: f.lineCount,
        pointCount: f.pointCount,
      },
    };
  }
  if (c.distortion !== null) {
    return c.distortion;
  }
  return {
    model: 'unknown',
    radial: null,
    tangential: null,
    lookupTable: null,
    division: null,
  };
}
