/**
 * What is wrong with this survey, in words the operator can act on.
 *
 * Deliberately the same shape as `FramingIssue` in `camera/rig.py` — a code, a
 * blocking flag, and a sentence — so the survey report and the framing report
 * render through one component and read as one voice. The operator does not
 * care which module found the problem.
 *
 * BLOCKING MEANS THE RECORD BUTTON DOES NOT WORK. The bar for that is: if this
 * is wrong, the footage cannot be fixed afterwards. Electronic stabilisation
 * clears it — nothing downstream can undo a per-frame warp. A worn pitch
 * marking does not: it degrades the ingest solve and processing still
 * succeeds.
 *
 * Every message names the thing to go and do. "AE lock unsupported" is a
 * status; "this phone cannot hold exposure, so the two halves will not match —
 * swap it for the other handset" is an instruction.
 */

import { checkBaseline } from './derive';
import type { CameraSurvey, ControlOutcome, RigSurvey } from './schema';

export interface SurveyIssue {
  code: string;
  blocking: boolean;
  message: string;
  /** Which camera it concerns, or null for the venue and the pair. */
  role: 'A' | 'B' | null;
}

/* ── Thresholds ───────────────────────────────────────────────────────────────
   Mirrors of the product decisions in PRD §3.0.1 and RigRequirements in
   riseup-ml. They live here as named constants rather than inline numbers so
   that a drift between the two codebases is a visible diff, not a subtle one.
   ─────────────────────────────────────────────────────────────────────────── */

/** Below this the overlap band collapses and identity handover fails (§4.2). */
const MIN_PERPENDICULAR_M = 20;
/** The measured target from §3.0.1. Advisory either side of it. */
const TARGET_PERPENDICULAR_M = 30;
const PERPENDICULAR_TOLERANCE_M = 8;

/** A rig lower than this sees players occluding each other constantly. */
const MIN_HEIGHT_M = 2;

/** Residual between measured and derived baseline, in combined sigmas. */
const BASELINE_MAX_Z = 3;
/** ...and an absolute floor, for a survey with optimistic uncertainties. */
const BASELINE_MAX_RESIDUAL_M = 1.5;

/** A pitch this far out of square is not a rectangle and should not be modelled as one. */
const PITCH_SQUARENESS_TOLERANCE_M = 1.0;

/** Rolling shutter beyond this biases sprint speeds measurably. */
const ROLLING_SHUTTER_WARN_MS = 20;

/** Delivered frame rate this far below nominal means the device is struggling. */
const FPS_SHORTFALL_TOLERANCE = 0.08;

export function validateSurvey(survey: RigSurvey): SurveyIssue[] {
  const issues: SurveyIssue[] = [];

  for (const camera of survey.cameras) {
    issues.push(...validateCamera(camera));
  }

  issues.push(...validatePair(survey));
  issues.push(...validatePitch(survey));

  // Blocking first: an operator under time pressure reads the top of a list.
  return issues.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/* ── Per camera ───────────────────────────────────────────────────────────── */

function validateCamera(c: CameraSurvey): SurveyIssue[] {
  const issues: SurveyIssue[] = [];
  const external = c.sourceKind === 'external';
  const model = c.external?.model;
  const name = external
    ? `Camera ${c.role}${model !== null && model !== undefined ? ` (${model})` : ''}`
    : `Phone ${c.role}`;

  issues.push(...validateLensModel(c, name));
  issues.push(
    ...(external ? validateExternalCamera(c, name) : validatePhoneSettings(c, name)),
  );
  issues.push(...validateIntrinsicsAndGeometry(c, name));
  issues.push(...validateTiming(c, name));
  return issues;
}

/**
 * PRD §4.3: recording is blocked without a lens model for every camera, or an
 * explicit acknowledgement that the footage will be treated as rectilinear.
 *
 * `unknown` is the blocking state. `none` is NOT — a lens that was measured
 * and found to be straight is a lens model, and it is the common result on a
 * long-lens camcorder. Conflating "we looked and it is straight" with "we
 * never looked" is the exact distinction this gate exists to enforce.
 */
function validateLensModel(c: CameraSurvey, name: string): SurveyIssue[] {
  if (c.distortion.model !== 'unknown') {
    return [];
  }

  if (c.external?.acknowledgedRectilinear === true) {
    return [
      {
        role: c.role,
        blocking: false,
        code: 'LENS_MODEL_ACKNOWLEDGED_ABSENT',
        message:
          `${name} has no lens model, and you have accepted that its footage will be treated as ` +
          `having a perfectly straight lens. The match will process. If this camera does bend ` +
          `lines, players near the edges of the frame will be placed wrongly — and the result is ` +
          `marked, so nobody reads more into it than it can carry.`,
      },
    ];
  }

  return [
    {
      role: c.role,
      blocking: true,
      code: 'LENS_MODEL_MISSING',
      message:
        `${name} has no lens model. Everything downstream assumes a straight lens, and the bend ` +
        `cannot be recovered afterwards — once the pitch has been fitted to a curved picture, the ` +
        `curve is invisible. Measure the lens, or accept explicitly that this camera will be ` +
        `treated as straight.`,
    },
  ];
}

/**
 * An external camera, where nothing can be verified and everything is a claim.
 *
 * The phone checks do not apply — a camcorder has no CaptureResult to read
 * back — so running them would produce five blocking issues that no operator
 * could act on and that mean nothing.
 */
function validateExternalCamera(c: CameraSurvey, name: string): SurveyIssue[] {
  const issues: SurveyIssue[] = [];
  const facts = c.external;
  if (facts === null) {
    return issues;
  }

  // The default-on case, and the most damaging one in the whole survey. GoPro
  // HyperSmooth and DJI RockSteady ship enabled and warp every frame exactly as
  // EIS does on a phone — with no API to switch them off and no way for the app
  // to detect that they are on.
  if (!facts.stabilisationConfirmedOff) {
    issues.push({
      role: c.role,
      blocking: true,
      code: 'EXTERNAL_STABILISATION_UNCONFIRMED',
      message:
        `Confirm stabilisation is switched off on ${name}. If it is an action camera it is almost ` +
        `certainly on — HyperSmooth and RockSteady are the factory default, and both shift the ` +
        `picture between frames under a camera we are treating as bolted down. It has to be ` +
        `turned off on the camera itself: the app can neither do it nor tell whether it is on.`,
    });
  }

  if (!facts.focusConfirmedLocked) {
    issues.push({
      role: c.role,
      blocking: true,
      code: 'EXTERNAL_FOCUS_UNCONFIRMED',
      message:
        `Set ${name} to manual focus on the far side of the pitch, then confirm it. On autofocus ` +
        `it hunts every time a player crosses the frame, and each refocus moves the lens.`,
    });
  }

  if (!facts.exposureConfirmedLocked) {
    issues.push({
      role: c.role,
      blocking: false,
      code: 'EXTERNAL_EXPOSURE_UNCONFIRMED',
      message:
        `Lock the exposure on ${name} if it will let you. On auto, the picture brightens and dims ` +
        `as clouds pass and shirt colours drift with it — and shirt colour is how players are ` +
        `told apart.`,
    });
  }

  if (c.intrinsics.source === 'exif' && !facts.exifSameModeConfirmed) {
    issues.push({
      role: c.role,
      blocking: false,
      code: 'EXIF_MODE_UNCONFIRMED',
      message:
        `The lens size for ${name} came from a photo it took, and you have not confirmed that ` +
        `photo was taken in the same mode as the video. Most cameras crop the sensor for video ` +
        `and not for stills, so this may be 10% out. It is refined against the pitch at ` +
        `processing.`,
    });
  }

  return issues;
}

function validatePhoneSettings(c: CameraSurvey, name: string): SurveyIssue[] {
  const issues: SurveyIssue[] = [];
  const role = c.role;

  if (c.settings.videoStabilisation !== 'applied') {
    issues.push({
      role,
      blocking: true,
      code: 'EIS_NOT_DISABLED',
      message: stabilisationMessage(name, c.settings.videoStabilisation, 'electronic'),
    });
  }

  if (c.settings.opticalStabilisation !== 'applied') {
    // Advisory when the device simply does not expose the control, which is
    // most iPhones: refusing to record on a limitation the operator cannot do
    // anything about would make the app unusable on half the handsets in the
    // world. Blocking when the device HAS the control and did not apply it,
    // because that is a bug we can fix rather than a platform we cannot.
    const unfixable = c.settings.opticalStabilisation === 'unsupported';
    issues.push({
      role,
      blocking: !unfixable,
      code: 'OIS_NOT_DISABLED',
      message: unfixable
        ? `${name} cannot switch off optical stabilisation. The lens will float slightly during ` +
          `the match, which adds a small wobble to every measurement. Nothing to do at the ground — ` +
          `mount it as rigidly as you can and it will be corrected at processing.`
        : stabilisationMessage(name, c.settings.opticalStabilisation, 'optical'),
    });
  }

  if (c.settings.autofocusLock !== 'applied') {
    issues.push({
      role,
      blocking: true,
      code: 'FOCUS_NOT_LOCKED',
      message:
        `${name} has not locked focus. It will hunt during the match, and every refocus ` +
        `changes the lens slightly — so distances measured in the first half will not match ` +
        `the second. Tap to focus on the far touchline, then lock.`,
    });
  }

  if (c.settings.autoExposureLock !== 'applied') {
    issues.push({
      role,
      blocking: true,
      code: 'AE_NOT_LOCKED',
      message:
        `${name} has not locked exposure. When a cloud passes, one camera will brighten and ` +
        `the other will not, and the seam between them becomes visible to both you and the ` +
        `tracker. This cannot be fixed afterwards.`,
    });
  }

  if (c.settings.whiteBalanceLock !== 'applied') {
    issues.push({
      role,
      blocking: true,
      code: 'AWB_NOT_LOCKED',
      message:
        `${name} has not locked white balance. The two halves will drift to different colours ` +
        `during the match, and shirt colour is how players are told apart across the seam.`,
    });
  }

  if (c.settings.zoomRatio !== 1) {
    const hasCrop = c.settings.cropRegion !== null;
    issues.push({
      role,
      blocking: !hasCrop,
      code: 'ZOOM_NOT_NEUTRAL',
      message: hasCrop
        ? `${name} is zoomed to ${c.settings.zoomRatio.toFixed(2)}×. That is recorded and will be ` +
          `accounted for, but leave it at 1× unless you have a reason.`
        : `${name} is zoomed to ${c.settings.zoomRatio.toFixed(2)}× and did not report what the ` +
          `sensor actually read out, so the lens cannot be characterised. Set zoom back to 1×.`,
    });
  }

  return issues;
}

function validateIntrinsicsAndGeometry(c: CameraSurvey, name: string): SurveyIssue[] {
  const issues: SurveyIssue[] = [];
  const role = c.role;

  if (c.intrinsics.source === 'unknown') {
    issues.push({
      role,
      blocking: true,
      code: 'NO_INTRINSICS',
      message:
        `${name} reported nothing about its lens — no calibration, no focal length, no sensor ` +
        `size. Without one of those, distances on the pitch cannot be computed from this ` +
        `camera at all. Use a different handset.`,
    });
  } else if (c.intrinsics.source === 'geometric') {
    issues.push({
      role,
      blocking: false,
      code: 'INTRINSICS_ESTIMATED',
      message:
        `${name} does not publish a calibrated lens, so its focal length was worked out from ` +
        `the sensor size — good to about a percent, and refined at processing. Nothing to do.`,
    });
  }

  /* Geometry. */

  const perp = c.perpendicularDistanceM.value;
  if (perp < MIN_PERPENDICULAR_M) {
    issues.push({
      role,
      blocking: true,
      code: 'TOO_CLOSE_TO_PITCH',
      message:
        `${name} is ${perp.toFixed(1)} m back from the touchline. Below ${MIN_PERPENDICULAR_M} m ` +
        `the two cameras stop overlapping enough to follow a player from one to the other, and ` +
        `players swap identities at the halfway line. Move it back to about ` +
        `${TARGET_PERPENDICULAR_M} m.`,
    });
  } else if (Math.abs(perp - TARGET_PERPENDICULAR_M) > PERPENDICULAR_TOLERANCE_M) {
    issues.push({
      role,
      blocking: false,
      code: 'DISTANCE_OFF_TARGET',
      message:
        `${name} is ${perp.toFixed(1)} m back; the rig is designed around ` +
        `${TARGET_PERPENDICULAR_M} m. It will work, but closer to that is better.`,
    });
  }

  if (c.heightM.value < MIN_HEIGHT_M) {
    issues.push({
      role,
      blocking: false,
      code: 'MOUNTED_LOW',
      message:
        `${name} is ${c.heightM.value.toFixed(2)} m up. From that low, players near the camera ` +
        `hide the ones behind them for long stretches. Higher is better — as high as you can ` +
        `safely reach.`,
    });
  }

  /* IMU. */

  if (!c.orientation.stable) {
    issues.push({
      role,
      blocking: false,
      code: 'ORIENTATION_UNSTABLE',
      message:
        `${name} was still moving while its angle was measured, so the tilt reading is rough. ` +
        `It is only used as a cross-check. Let it settle and re-measure if you want it sharper.`,
    });
  }

  return issues;
}

function validateTiming(c: CameraSurvey, name: string): SurveyIssue[] {
  const issues: SurveyIssue[] = [];
  const role = c.role;

  const skewNs = c.timing.rollingShutterSkewNs;
  if (skewNs !== null && skewNs / 1e6 > ROLLING_SHUTTER_WARN_MS) {
    issues.push({
      role,
      blocking: false,
      code: 'ROLLING_SHUTTER_HIGH',
      message:
        `${name} reads its sensor slowly (${(skewNs / 1e6).toFixed(0)} ms top to bottom), which ` +
        `smears fast movement. Sprint speeds from this camera will read slightly low. Recorded, ` +
        `and corrected at processing.`,
    });
  }

  const measured = c.timing.measuredFps;
  if (measured !== null) {
    const shortfall = (c.timing.nominalFps - measured.value) / c.timing.nominalFps;
    if (shortfall > FPS_SHORTFALL_TOLERANCE) {
      issues.push({
        role,
        blocking: false,
        code: 'FPS_SHORTFALL',
        message:
          `${name} asked for ${c.timing.nominalFps} fps and is delivering ` +
          `${measured.value.toFixed(1)}. It is probably already warm. Get it out of the sun and ` +
          `off charge until kick-off.`,
      });
    }
  }

  if (c.timing.timestampSource === 'unknown') {
    issues.push({
      role,
      blocking: false,
      code: 'TIMESTAMP_SOURCE_UNKNOWN',
      message:
        `${name} will not say which clock its frames are stamped with, so the two cameras ` +
        `cannot be lined up by timestamp. The audio marker at the start is what will sync them.`,
    });
  }

  return issues;
}

function stabilisationMessage(name: string, outcome: ControlOutcome, kind: string): string {
  const why =
    `${kind === 'electronic' ? 'Electronic' : 'Optical'} stabilisation shifts and crops each ` +
    `frame slightly to smooth out shake. On a phone on a tripod there is no shake to smooth — ` +
    `all it does is move the picture around under a camera we have measured as fixed, and every ` +
    `distance drifts with it.`;

  switch (outcome) {
    case 'refused':
      return `${name} would not switch off ${kind} stabilisation. ${why} Try turning it off in the ` +
        `phone's own camera settings, then restart RiseUp.`;
    case 'unsupported':
      return `${name} does not allow ${kind} stabilisation to be switched off. ${why} Use a ` +
        `different handset for this camera.`;
    default:
      return `${name} has not had ${kind} stabilisation switched off. ${why}`;
  }
}

/* ── The pair ─────────────────────────────────────────────────────────────── */

function validatePair(survey: RigSurvey): SurveyIssue[] {
  const issues: SurveyIssue[] = [];

  // A single camera is a legitimate survey, not an incomplete one. None of the
  // checks below mean anything for it: there is no baseline to cross-check, no
  // seam to hand identities across, and no second device to match against.
  if (survey.rigMode === 'single') {
    return issues;
  }

  const [a, b] = survey.cameras;

  if (a === undefined || b === undefined) {
    issues.push({
      role: null,
      blocking: true,
      code: 'INCOMPLETE_RIG',
      message: 'The rig is two cameras, and this survey has fewer. Pair the second phone.',
    });
    return issues;
  }

  /* The baseline cross-check — the reason it is measured a third time. */

  const check = checkBaseline(survey);
  if (check === null || check.measuredM === null) {
    issues.push({
      role: null,
      blocking: false,
      code: 'BASELINE_NOT_MEASURED',
      message:
        'The distance between the two phones has not been measured directly. It can be worked ' +
        'out from the two positions, but measuring it gives a check on both — and it is what ' +
        'decides whether players keep their identity across the halfway line. Worth the tape.',
    });
  } else if (
    Math.abs(check.zScore ?? 0) > BASELINE_MAX_Z &&
    Math.abs(check.residualM ?? 0) > BASELINE_MAX_RESIDUAL_M
  ) {
    issues.push({
      role: null,
      blocking: true,
      code: 'BASELINE_DISAGREES',
      message:
        `The tape says the phones are ${check.measuredM.toFixed(1)} m apart, but their two ` +
        `positions put them ${check.derivedM.toFixed(1)} m apart. One of the three measurements ` +
        `is wrong by about ${Math.abs(check.residualM ?? 0).toFixed(1)} m. Re-measure both ` +
        `distances along the touchline — that is usually the one.`,
    });
  }

  /* Both cameras on the same side of halfway is almost always a sign error. */

  const sameSide =
    Math.sign(a.alongTouchlineM.value) === Math.sign(b.alongTouchlineM.value) &&
    a.alongTouchlineM.value !== 0;
  if (sameSide) {
    issues.push({
      role: null,
      blocking: false,
      code: 'BOTH_CAMERAS_SAME_SIDE',
      message:
        'Both phones are recorded as being on the same side of the halfway line. That is ' +
        'possible, but usually it means one distance was entered without its minus sign. ' +
        'Check which side each one is actually standing on.',
    });
  }

  if (a.coversHalf === b.coversHalf) {
    issues.push({
      role: null,
      blocking: true,
      code: 'SAME_HALF_ASSIGNED',
      message:
        `Both phones are set to cover the ${a.coversHalf} half, so nothing is filming the other ` +
        `one. Set one to each.`,
    });
  }

  if (a.touchlineSide !== b.touchlineSide) {
    issues.push({
      role: null,
      blocking: true,
      code: 'OPPOSITE_TOUCHLINES',
      message:
        'The two phones are recorded as being on opposite touchlines. The rig films from one ' +
        'side; facing each other across the pitch mirrors one view against the other and ' +
        'players cannot be handed across.',
    });
  }

  /* Device mismatch — PRD §4.1 prefers a matched pair and tolerates one. */

  if (a.deviceModel !== b.deviceModel) {
    issues.push({
      role: null,
      blocking: false,
      code: 'MISMATCHED_DEVICES',
      message:
        `The two phones are different models (${a.deviceModel} and ${b.deviceModel}). They will ` +
        `render colour slightly differently, which is corrected at processing now that it is ` +
        `recorded. A matched pair is better if you have one.`,
    });
  }

  if (a.timing.nominalFps !== b.timing.nominalFps) {
    issues.push({
      role: null,
      blocking: true,
      code: 'FRAME_RATE_MISMATCH',
      message:
        `The two phones are set to different frame rates (${a.timing.nominalFps} and ` +
        `${b.timing.nominalFps} fps). They have to match, or the two views cannot be lined up ` +
        `in time.`,
    });
  }

  return issues;
}

/* ── The venue ────────────────────────────────────────────────────────────── */

function validatePitch(survey: RigSurvey): SurveyIssue[] {
  const issues: SurveyIssue[] = [];
  const p = survey.pitch;

  const touchlineDelta = Math.abs(p.northTouchlineM.value - p.southTouchlineM.value);
  const goalLineDelta = Math.abs(p.westGoalLineM.value - p.eastGoalLineM.value);

  if (
    touchlineDelta > PITCH_SQUARENESS_TOLERANCE_M ||
    goalLineDelta > PITCH_SQUARENESS_TOLERANCE_M
  ) {
    issues.push({
      role: null,
      blocking: false,
      code: 'PITCH_NOT_RECTANGULAR',
      message:
        `The two touchlines differ by ${touchlineDelta.toFixed(1)} m and the goal lines by ` +
        `${goalLineDelta.toFixed(1)} m, so this pitch is not quite a rectangle. That is normal ` +
        `on a municipal ground and it is why all four sides are measured — positions will be ` +
        `fitted to the real shape.`,
    });
  }

  if (p.diagonalM === null) {
    issues.push({
      role: null,
      blocking: false,
      code: 'DIAGONAL_NOT_MEASURED',
      message:
        'No diagonal was measured. Four sides do not prove a rectangle — a leaning ' +
        'parallelogram has the same four. One diagonal settles it, and it is measured once per ' +
        'venue, not once per match.',
    });
  }

  if (p.markingCondition === 'absent' || p.markingCondition === 'faint') {
    issues.push({
      role: null,
      blocking: false,
      code: 'MARKINGS_POOR',
      message:
        p.markingCondition === 'absent'
          ? 'Parts of this pitch are unmarked, so the automatic line-finder at processing will ' +
            'have nothing to lock onto. Your tapped points are the calibration. Take care with them.'
          : 'The markings are faint. The automatic line-finder may not manage, so the points you ' +
            'tap matter more than usual here.',
    });
  }

  return issues;
}

/** Convenience for the preflight gate: may recording start? */
export function hasBlockingIssues(issues: SurveyIssue[]): boolean {
  return issues.some((i) => i.blocking);
}
