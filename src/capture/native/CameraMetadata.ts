/**
 * The native camera module contract.
 *
 * NOT IMPLEMENTED YET. This file is the specification: the TypeScript side of
 * a native module that does not exist, written first so the two platform
 * implementations are built against one agreed shape rather than converging
 * afterwards. Calling any of it today throws, loudly and by name.
 *
 * PRD §9 is explicit that the capture path cannot be cross-platform, and this
 * is the seam. Everything above it — the survey record, the derivations, the
 * validator, the UI — is shared TypeScript. Everything below is two
 * implementations, and the file exists so that "two implementations" does not
 * quietly become "two behaviours".
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ANDROID — Camera2
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  Intrinsics, preferred
 *    LENS_INTRINSIC_CALIBRATION      → [fx, fy, cx, cy, skew], active-array px
 *    LENS_DISTORTION                 → [k1, k2, k3, p1, p2]
 *
 *  Available only when LENS_INFO_AVAILABLE and the device says
 *  REQUEST_AVAILABLE_CAPABILITIES contains MANUAL_SENSOR. COVERAGE IS
 *  INCONSISTENT AND THE VALUES ARE NOT ALWAYS REAL — several shipping devices
 *  advertise the capability and return the datasheet figure for the model
 *  rather than anything measured on that unit. Treat a reported matrix as
 *  better than the fallback, never as ground truth, and sanity-check it
 *  against the geometric estimate before preferring it.
 *
 *  Intrinsics, fallback — always available, ~1% accurate
 *    LENS_FOCAL_LENGTH               → mm (the active one, if multiple)
 *    SENSOR_INFO_PHYSICAL_SIZE       → mm × mm
 *    SENSOR_INFO_ACTIVE_ARRAY_SIZE   → px
 *
 *  Timing
 *    SENSOR_ROLLING_SHUTTER_SKEW     → ns, first row to last
 *    SENSOR_INFO_TIMESTAMP_SOURCE    → UNKNOWN (monotonic) | REALTIME
 *    CaptureResult SENSOR_TIMESTAMP  → per frame, ns. The real fps.
 *
 *  Controls — SET, not read
 *    CONTROL_VIDEO_STABILIZATION_MODE  = OFF
 *    LENS_OPTICAL_STABILIZATION_MODE   = OFF
 *    CONTROL_AF_MODE / AF_TRIGGER      → lock after setup
 *    CONTROL_AE_LOCK                   = true
 *    CONTROL_AWB_LOCK                  = true
 *    SCALER_CROP_REGION                → read back; this is what zoom did
 *
 *  Every one of these must be VERIFIED FROM THE CaptureResult, not assumed
 *  from the CaptureRequest. Setting a key that a device ignores is silent —
 *  the request succeeds and the mode stays on. That is precisely the failure
 *  `ControlOutcome.refused` exists to name.
 *
 *  INFO_SUPPORTED_HARDWARE_LEVEL of LEGACY is refused at pairing per PRD §4.1:
 *  a LEGACY device cannot honour the locks, and a rig that cannot lock
 *  exposure produces a visible seam for the whole match.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  iOS — AVFoundation. Materially weaker, and the differences are real.
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  Intrinsics
 *    AVCameraCalibrationData.intrinsicMatrix gives a true 3×3 — but only when
 *    `isCameraCalibrationDataDeliverySupported`, which in practice means a
 *    multi-camera device delivering depth data. A plain 4K video capture does
 *    NOT get it.
 *
 *    There is also no public API for physical sensor size, so the Android
 *    fallback is unavailable. What is left is
 *    `AVCaptureDeviceFormat.videoFieldOfView` — horizontal FOV in degrees, a
 *    rounded nominal figure — and `intrinsicsFromFieldOfView` in `derive.ts`.
 *    Roughly 3% rather than 1%.
 *
 *    `AVCaptureConnection.cameraIntrinsicMatrixDeliveryEnabled` attaches an
 *    intrinsic matrix to sample buffers on some configurations and is worth
 *    trying first; fall back to FOV when it is unavailable.
 *
 *  Rolling shutter
 *    NO EQUIVALENT. Nothing public reports readout skew. `rollingShutterSkewNs`
 *    is null on iOS, and the validator must not treat null as zero — an
 *    unmeasured skew is not an absent one.
 *
 *  Controls
 *    EIS: AVCaptureConnection.preferredVideoStabilizationMode = .off — works,
 *         and is checkable via `activeVideoStabilizationMode`.
 *    OIS: NOT DISABLEABLE through any public API. This is the single largest
 *         platform gap, and it is why `OIS_NOT_DISABLED` is advisory rather
 *         than blocking when reported `unsupported`: refusing to record would
 *         make the app unusable on every iPhone.
 *    AF:  lockForConfiguration + focusMode = .locked
 *    AE:  exposureMode = .locked
 *    AWB: whiteBalanceMode = .locked
 *    Zoom: videoZoomFactor, read back after setting.
 *
 *  Timing
 *    CMSampleBuffer presentation timestamps on the host clock, which is
 *    `mach_absolute_time` — monotonic, not comparable across devices. Report
 *    `timestampSource: 'monotonic'`, which is what makes the audio sync marker
 *    of PRD §4.4 load-bearing rather than a belt-and-braces extra.
 */

import { Platform } from 'react-native';

import type {
  ControlledSettings,
  Distortion,
  Intrinsics,
  TimingProfile,
} from '../survey/schema';

/** What the module returns for one camera, before any derivation. */
export interface RawCameraMetadata {
  deviceId: string;
  deviceModel: string;
  lensId: string | null;
  lensFacing: 'back' | 'front' | 'external' | 'unknown';

  /** Present only when the platform genuinely reports a calibrated matrix. */
  reportedIntrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    skew: number;
  } | null;

  distortion: Distortion;

  /** Android: LENS_FOCAL_LENGTH. iOS: null. */
  focalLengthMm: number | null;
  /** Android: SENSOR_INFO_PHYSICAL_SIZE. iOS: null — no public API. */
  sensorPhysicalWidthMm: number | null;
  sensorPhysicalHeightMm: number | null;
  /** iOS: AVCaptureDeviceFormat.videoFieldOfView. Android: null. */
  horizontalFovDeg: number | null;

  activeArrayWidthPx: number;
  activeArrayHeightPx: number;

  rollingShutterSkewNs: number | null;
  timestampSource: TimingProfile['timestampSource'];

  /**
   * Android INFO_SUPPORTED_HARDWARE_LEVEL. `legacy` is refused at pairing
   * (PRD §4.1). Null on iOS, which has no equivalent tiering.
   */
  hardwareLevel: 'legacy' | 'limited' | 'full' | 'level_3' | 'external' | null;
}

export interface ApplySettingsRequest {
  deviceId: string;
  targetFps: number;
  /** Always 1 unless the operator has a reason. Read back, never assumed. */
  zoomRatio: number;
}

export interface CameraMetadataModule {
  /** Everything static about the lens and sensor. Cheap, no session needed. */
  readMetadata(deviceId: string): Promise<RawCameraMetadata>;

  /**
   * Apply the three controlled settings and report what actually happened.
   *
   * Each outcome is read back from the platform's own state — CaptureResult on
   * Android, the `active*` properties on iOS — never inferred from the request
   * having succeeded. A device that ignores a key returns success and changes
   * nothing, which is the whole reason this returns outcomes rather than void.
   */
  applySettings(request: ApplySettingsRequest): Promise<ControlledSettings>;

  /**
   * Run the camera briefly and time the frames.
   *
   * The only way to learn the delivered frame rate, which is not the requested
   * one under thermal load. Returns raw timestamps so `timingFromTimestamps`
   * can do the statistics in testable TypeScript rather than twice in two
   * native languages.
   */
  probeTiming(deviceId: string, durationMs: number): Promise<{
    timestampsNs: number[];
    nominalFps: number;
  }>;
}

/* ── Availability ─────────────────────────────────────────────────────────── */

let nativeModule: CameraMetadataModule | null = null;

/** Wired up by the native module once it exists. */
export function registerCameraMetadataModule(mod: CameraMetadataModule): void {
  nativeModule = mod;
}

export function isCameraMetadataAvailable(): boolean {
  return nativeModule !== null;
}

/**
 * The module, or a clear failure.
 *
 * Throws rather than returning a stub that produces plausible zeros. A survey
 * containing a focal length of 0 that nobody noticed is worse than a survey
 * that could not be completed, because the first one gets recorded against a
 * real match and the second one gets fixed.
 */
export function getCameraMetadataModule(): CameraMetadataModule {
  if (nativeModule === null) {
    throw new Error(
      'The native camera module is not installed in this build, so lens and sensor ' +
        'metadata cannot be read. This is expected before v0.2: see ' +
        'src/capture/native/CameraMetadata.ts for the contract it must satisfy ' +
        `(platform: ${Platform.OS}).`,
    );
  }
  return nativeModule;
}

/* ── Assembling the survey pieces from raw metadata ───────────────────────── */

/**
 * Choose the best available intrinsics and say which they are.
 *
 * Order: a reported calibration, then the Android geometric route, then the
 * iOS field-of-view route, then nothing — and `nothing` is a blocking issue
 * rather than a default, because a camera whose lens is unknown cannot measure
 * a pitch.
 *
 * Deliberately importable without the native module, so it can be tested
 * against captured fixtures from real devices with no phone in the loop.
 */
export function chooseIntrinsics(
  raw: RawCameraMetadata,
  helpers: {
    fromGeometry: (i: {
      focalLengthMm: number;
      sensorPhysicalWidthMm: number;
      sensorPhysicalHeightMm: number;
      activeArrayWidthPx: number;
      activeArrayHeightPx: number;
    }) => Intrinsics;
    fromFov: (i: {
      horizontalFovDeg: number;
      activeArrayWidthPx: number;
      activeArrayHeightPx: number;
    }) => Intrinsics;
  },
): Intrinsics {
  const { activeArrayWidthPx, activeArrayHeightPx } = raw;

  if (raw.reportedIntrinsics !== null) {
    const r = raw.reportedIntrinsics;
    return {
      source: 'reported',
      // No sigma: the platform states a calibration and quantifies nothing
      // about it. Null is the honest answer, and it is what stops a consumer
      // weighting this as if its uncertainty were known to be small.
      fxPx: { value: r.fx, sigma: null, provenance: 'device' },
      fyPx: { value: r.fy, sigma: null, provenance: 'device' },
      cxPx: { value: r.cx, sigma: null, provenance: 'device' },
      cyPx: { value: r.cy, sigma: null, provenance: 'device' },
      skew: { value: r.skew, sigma: null, provenance: 'device' },
      focalLengthMm: raw.focalLengthMm,
      sensorPhysicalWidthMm: raw.sensorPhysicalWidthMm,
      sensorPhysicalHeightMm: raw.sensorPhysicalHeightMm,
      activeArrayWidthPx,
      activeArrayHeightPx,
    };
  }

  if (
    raw.focalLengthMm !== null &&
    raw.sensorPhysicalWidthMm !== null &&
    raw.sensorPhysicalHeightMm !== null
  ) {
    return helpers.fromGeometry({
      focalLengthMm: raw.focalLengthMm,
      sensorPhysicalWidthMm: raw.sensorPhysicalWidthMm,
      sensorPhysicalHeightMm: raw.sensorPhysicalHeightMm,
      activeArrayWidthPx,
      activeArrayHeightPx,
    });
  }

  if (raw.horizontalFovDeg !== null) {
    return helpers.fromFov({
      horizontalFovDeg: raw.horizontalFovDeg,
      activeArrayWidthPx,
      activeArrayHeightPx,
    });
  }

  return {
    source: 'unknown',
    fxPx: { value: 0, sigma: null, provenance: 'device' },
    fyPx: { value: 0, sigma: null, provenance: 'device' },
    cxPx: { value: activeArrayWidthPx / 2, sigma: null, provenance: 'device' },
    cyPx: { value: activeArrayHeightPx / 2, sigma: null, provenance: 'device' },
    skew: null,
    focalLengthMm: null,
    sensorPhysicalWidthMm: null,
    sensorPhysicalHeightMm: null,
    activeArrayWidthPx,
    activeArrayHeightPx,
  };
}
