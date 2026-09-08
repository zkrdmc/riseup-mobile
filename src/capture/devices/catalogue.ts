/**
 * What we can actually process, and what we cannot.
 *
 * The picker offers this list and nothing else. A free-text "make and model"
 * field accepts a 360 camera, a drone and a dashcam with equal enthusiasm and
 * discovers the problem at ingest, hours later, with the match already filmed.
 * Support is a decision, so it is written down.
 *
 * DEFINED BY CAPABILITY, NOT BY MODEL NUMBER. There is no table of specific
 * bodies here, deliberately. We hold no verified intrinsics or distortion
 * coefficients for named consumer cameras, and a seeded table of plausible
 * ones would be indistinguishable from a measured one to everything
 * downstream — the precise failure the whole survey is built to avoid. What
 * decides whether a camera works is a handful of capabilities, and those can
 * be stated honestly:
 *
 *   1. Its optical centre stays put. NOT "it does not move" — that was the
 *                                 wrong line. A camera panning on a tripod
 *                                 rotates about a fixed centre, and pure
 *                                 rotation keeps the pitch solvable frame by
 *                                 frame from the lines in view. What breaks it
 *                                 is the centre TRANSLATING: handheld, walking,
 *                                 airborne. Rotation is recoverable, parallax
 *                                 is not.
 *   2. Its lens can be modelled.  One radial parameter over the frame.
 *   3. It can stop adjusting.     Focus, exposure and stabilisation lockable.
 *   4. It records enough pixels.  A player at the far touchline must be
 *                                 findable — RigRequirements wants 40 px.
 *
 * A named model catalogue with real per-body calibrations is the right long-term
 * answer, and it belongs on the server where one club's calibration becomes
 * every club's. See `docs/BACKEND-GAPS.md`.
 */

export type SupportTier =
  /** Works, and the app can verify it works. */
  | 'supported'
  /** Works once the lens has been calibrated and the settings confirmed. */
  | 'supported_after_calibration'
  /** Cannot be processed. The app says why rather than letting it be filmed. */
  | 'unsupported';

export interface CameraClass {
  id: string;
  label: string;
  /** One line under the label in the picker. */
  summary: string;
  tier: SupportTier;
  kind: 'phone' | 'external';

  /**
   * Why it is unsupported, in words an operator can act on — usually by
   * changing a setting rather than buying a camera, which is why this is worth
   * the space.
   */
  unsupportedReason?: string;

  /** What the operator must do before this class can record. */
  requirements: string[];
}

export const CAMERA_CLASSES: readonly CameraClass[] = [
  {
    id: 'phone',
    label: 'A phone',
    summary: 'This handset, or another running RiseUp. Lens read automatically.',
    tier: 'supported',
    kind: 'phone',
    requirements: [
      'Must be able to lock focus, exposure and white balance',
      'Stabilisation switched off by the app',
    ],
  },
  {
    id: 'action_linear',
    label: 'Action camera — linear mode',
    summary: 'GoPro, DJI and similar, set to Linear or Narrow. Not Wide.',
    tier: 'supported_after_calibration',
    kind: 'external',
    requirements: [
      'Lens set to Linear or Narrow, never Wide or SuperView',
      'HyperSmooth / RockSteady switched OFF on the camera',
      'Focus and exposure locked',
      'Lens calibrated at the resolution you will film at',
    ],
  },
  {
    id: 'camcorder',
    label: 'Camcorder',
    summary: 'A handycam or club video camera on a tripod.',
    tier: 'supported_after_calibration',
    kind: 'external',
    requirements: [
      'Manual focus, set on the far side of the pitch',
      'Exposure locked, or manual',
      'Optical stabilisation off',
      'Zoom left at one position and not touched — calibrate at that position',
    ],
  },
  {
    id: 'mirrorless',
    label: 'Mirrorless or DSLR',
    summary: 'A stills camera recording video, on a tripod.',
    tier: 'supported_after_calibration',
    kind: 'external',
    requirements: [
      'A prime lens, or a zoom taped at one focal length',
      'Manual focus and manual exposure',
      'In-body and in-lens stabilisation off',
      'Check it does not stop recording at 30 minutes',
    ],
  },
  {
    id: 'panned_tripod',
    label: 'Phone or camera on a tripod, panned',
    summary: 'One camera, an operator turning it to follow play.',
    tier: 'supported_after_calibration',
    kind: 'external',
    requirements: [
      'On a tripod or a rig head — the camera turns, it does not travel',
      'Zoom fixed for the whole match, and calibrated at that setting',
      'Manual focus and locked exposure, as with any other camera',
      'Keep a touchline or a penalty box in shot while you pan — the picture has to stay ' +
        'anchored to something known',
    ],
  },
  {
    id: 'fixed_installed',
    label: 'Fixed camera at the ground',
    summary: 'A camera already installed on a stand or a mast.',
    tier: 'supported_after_calibration',
    kind: 'external',
    requirements: [
      'It must not be moved or re-zoomed during the match — panning is fine, walking it is not',
      'Lens calibrated from the pitch lines, since a board cannot be held up to it',
    ],
  },

  /* ── Not supported, and each for a specific reason ─────────────────────── */

  {
    id: 'action_wide',
    label: 'Action camera — wide or fisheye',
    summary: 'GoPro Wide, SuperView, or any 170° lens.',
    tier: 'unsupported',
    kind: 'external',
    unsupportedReason:
      'A fisheye bends the picture far more than the lens model can describe, and the far ' +
      'corners of the pitch are exactly where it is worst. The same camera works well in ' +
      'Linear or Narrow mode — change the lens setting and pick "Action camera — linear mode".',
    requirements: [],
  },
  {
    id: 'camera_360',
    label: '360 camera',
    summary: 'Insta360, GoPro Max and similar.',
    tier: 'unsupported',
    kind: 'external',
    unsupportedReason:
      'A 360 camera stitches two fisheye lenses together, and the seam between them moves. ' +
      'There is no single lens to model, so positions on the pitch cannot be worked out from ' +
      'the picture.',
    requirements: [],
  },
  {
    id: 'drone',
    label: 'Drone',
    summary: 'Any airborne camera.',
    tier: 'unsupported',
    kind: 'external',
    unsupportedReason:
      'A drone holding position still drifts by metres, and because the camera itself travels, ' +
      'every player position travels with it — that is different from panning, where the camera ' +
      'turns on the spot and the maths still works. A drone on the ground, filming from a fixed ' +
      'point, is fine: pick "Phone or camera on a tripod, panned".',
    requirements: [],
  },
  {
    id: 'phone_handheld',
    label: 'A phone, handheld',
    summary: 'Filmed from the touchline without a tripod.',
    tier: 'unsupported',
    kind: 'external',
    unsupportedReason:
      'Handheld means the camera drifts as well as turns, and a few centimetres of sway between ' +
      'frames moves every player on the far side by metres. A tripod fixes that even if you pan ' +
      'constantly — it is the drifting, not the turning, that cannot be undone. Put it on ' +
      'something and pick "Phone or camera on a tripod, panned".',
    requirements: [],
  },
  {
    id: 'webcam',
    label: 'Webcam or laptop camera',
    summary: 'A USB or built-in camera.',
    tier: 'unsupported',
    kind: 'external',
    unsupportedReason:
      'Too few pixels across a pitch. A player on the far touchline lands about ten pixels ' +
      'tall, and the tracker needs roughly forty to find them at all.',
    requirements: [],
  },
];

export function cameraClassById(id: string): CameraClass | null {
  return CAMERA_CLASSES.find((c) => c.id === id) ?? null;
}

/** The classes offered when adding a camera — supported ones first. */
export function selectableClasses(): CameraClass[] {
  const rank: Record<SupportTier, number> = {
    supported: 0,
    supported_after_calibration: 1,
    unsupported: 2,
  };
  return [...CAMERA_CLASSES].sort((a, b) => rank[a.tier] - rank[b.tier]);
}

/**
 * Unsupported classes are LISTED, not hidden.
 *
 * Somebody filming on a GoPro in Wide mode needs to find that out here, in
 * twenty seconds, with the fix in the same sentence — not by having their
 * camera silently absent from a list and concluding the app is broken. Four of
 * the five unsupported entries name a setting change that makes the same
 * hardware work.
 */
export function isSelectable(c: CameraClass): boolean {
  return c.tier !== 'unsupported';
}
