/**
 * Focal length for an external camera, from a still it took.
 *
 * `distortion.ts` recovers how the lens bends lines. It cannot recover scale —
 * a straight line is equally straight at any focal length — so something else
 * has to supply that, and for a camera the app cannot interrogate, the most
 * reliable source is a photograph it took of anything at all.
 *
 * Almost every camera writes `FocalLengthIn35mmFilm` into EXIF: the focal
 * length it would have needed on a 35 mm frame to give the same field of view.
 * That is exactly the quantity wanted here, because it has already absorbed
 * the sensor size — which is the number no consumer camera publishes and the
 * reason the Android geometric route is unavailable for external cameras.
 *
 *     horizontal FOV = 2·atan(36 / (2·f₃₅))
 *
 * 36 mm being the width of a 35 mm frame.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TRAP, AND IT IS A BIG ONE
 * ══════════════════════════════════════════════════════════════════════════
 * MOST CAMERAS DO NOT SHOOT VIDEO AT THE SAME FIELD OF VIEW AS STILLS. A 4K
 * mode is frequently a crop of the sensor, and the still is not. On some
 * bodies the difference is 10%; on others the video mode is a different lens
 * entirely.
 *
 * So a focal length read from a photograph is a good estimate of the video's
 * focal length only if the operator confirms both were taken in the same mode
 * at the same zoom. The app asks, records the answer, and carries a larger
 * uncertainty than the on-phone path would — and the validator says so rather
 * than letting a confident wrong number through.
 *
 * The honest fallback when it cannot be confirmed is to leave the focal length
 * unknown and let the pitch solve at ingest recover it, which it can, because
 * the pitch has known dimensions.
 */

import type { Intrinsics } from './schema';

/** The width of a 35 mm film frame, which is what the EXIF tag is relative to. */
const FRAME_35MM_WIDTH_MM = 36;

export interface ExifCameraFacts {
  make: string | null;
  model: string | null;
  lensModel: string | null;
  /** 35 mm equivalent focal length, in millimetres. The useful one. */
  focalLength35mm: number | null;
  /** The true focal length. Useless alone — it needs a sensor size nobody publishes. */
  focalLengthMm: number | null;
  imageWidthPx: number | null;
  imageHeightPx: number | null;
  /** Digital zoom the camera applied, if it says. Multiplies the effective focal length. */
  digitalZoomRatio: number | null;
}

/**
 * Pull the camera facts out of an EXIF blob.
 *
 * EXIF tag names are not consistent across platforms — iOS nests them under
 * `{Exif}` and `{TIFF}` dictionaries while Android returns them flat — so
 * every lookup tries several spellings. A missing tag is null, never a
 * default: an absent focal length and a focal length of zero are very
 * different claims.
 */
export function readExifCameraFacts(exif: Record<string, unknown> | null): ExifCameraFacts {
  if (exif === null) {
    return emptyFacts();
  }

  // iOS returns nested dictionaries; flattening once catches both shapes
  // without having to know which platform produced the object.
  const flat: Record<string, unknown> = { ...exif };
  for (const value of Object.values(exif)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(flat, value as Record<string, unknown>);
    }
  }

  return {
    make: str(flat, ['Make', 'TIFF:Make']),
    model: str(flat, ['Model', 'TIFF:Model']),
    lensModel: str(flat, ['LensModel', 'LensMake', 'Exif:LensModel']),
    focalLength35mm: num(flat, [
      'FocalLenIn35mmFilm',
      'FocalLengthIn35mmFilm',
      'FocalLengthIn35mmFormat',
    ]),
    focalLengthMm: num(flat, ['FocalLength']),
    imageWidthPx: num(flat, ['PixelWidth', 'PixelXDimension', 'ImageWidth']),
    imageHeightPx: num(flat, ['PixelHeight', 'PixelYDimension', 'ImageLength', 'ImageHeight']),
    digitalZoomRatio: num(flat, ['DigitalZoomRatio']),
  };
}

/** Horizontal field of view in degrees, from a 35 mm equivalent focal length. */
export function fovFrom35mm(focalLength35mm: number, digitalZoomRatio: number | null): number {
  // Digital zoom is a crop, so it multiplies the effective focal length. A
  // camera that reports 1.0 (or nothing) has applied none.
  const effective = focalLength35mm * (digitalZoomRatio !== null && digitalZoomRatio > 0 ? digitalZoomRatio : 1);
  return 2 * Math.atan(FRAME_35MM_WIDTH_MM / (2 * effective)) * (180 / Math.PI);
}

export interface ExifIntrinsicsInput {
  facts: ExifCameraFacts;
  /** The VIDEO frame size, not the still's. This is what will be processed. */
  videoWidthPx: number;
  videoHeightPx: number;
  /**
   * Did the operator confirm the still and the video were shot in the same
   * mode at the same zoom? If not, the estimate is materially weaker and the
   * uncertainty says so.
   */
  sameModeConfirmed: boolean;
}

/**
 * Intrinsics from EXIF, or null when the tag that matters is absent.
 *
 * Returns null rather than falling back to a plausible wide-angle default.
 * There is no default focal length that is right, and a guessed one is
 * indistinguishable downstream from a measured one — which is the failure this
 * whole module exists to avoid.
 */
export function intrinsicsFromExif(input: ExifIntrinsicsInput): Intrinsics | null {
  const { facts, videoWidthPx, videoHeightPx, sameModeConfirmed } = input;
  if (facts.focalLength35mm === null || facts.focalLength35mm <= 0) {
    return null;
  }

  const fovDeg = fovFrom35mm(facts.focalLength35mm, facts.digitalZoomRatio);
  const fx = videoWidthPx / 2 / Math.tan((fovDeg * Math.PI) / 180 / 2);

  // 4% when the operator has confirmed the modes match — EXIF focal lengths
  // are quantised and the 35 mm equivalent is itself rounded. 15% when they
  // have not, which is roughly the spread of still-versus-video crop factors
  // across consumer bodies, and is deliberately large enough that the ingest
  // solve will override it rather than be anchored by it.
  const relativeSigma = sameModeConfirmed ? 0.04 : 0.15;

  return {
    source: 'exif',
    fxPx: {
      value: fx,
      sigma: fx * relativeSigma,
      provenance: 'derived',
      from: ['exif.FocalLengthIn35mmFilm'],
    },
    // Square pixels. True of every camera that writes a 35 mm equivalent.
    fyPx: { value: fx, sigma: fx * relativeSigma, provenance: 'derived', from: ['fxPx'] },
    cxPx: {
      value: videoWidthPx / 2,
      sigma: videoWidthPx * 0.02,
      provenance: 'derived',
      from: ['videoWidthPx'],
    },
    cyPx: {
      value: videoHeightPx / 2,
      sigma: videoHeightPx * 0.02,
      provenance: 'derived',
      from: ['videoHeightPx'],
    },
    skew: null,
    focalLengthMm: facts.focalLengthMm,
    sensorPhysicalWidthMm: null,
    sensorPhysicalHeightMm: null,
    activeArrayWidthPx: videoWidthPx,
    activeArrayHeightPx: videoHeightPx,
  };
}

/** A display name for the camera, for the survey summary and the profile key. */
export function describeCamera(facts: ExifCameraFacts): string | null {
  const parts = [facts.make, facts.model].filter((p): p is string => p !== null && p.length > 0);
  if (parts.length === 0) {
    return null;
  }
  // "GoPro GoPro HERO12 Black" is a real EXIF pairing. Drop the repeat.
  if (parts.length === 2 && (parts[1] as string).toLowerCase().startsWith((parts[0] as string).toLowerCase())) {
    return parts[1] as string;
  }
  return parts.join(' ');
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function emptyFacts(): ExifCameraFacts {
  return {
    make: null,
    model: null,
    lensModel: null,
    focalLength35mm: null,
    focalLengthMm: null,
    imageWidthPx: null,
    imageHeightPx: null,
    digitalZoomRatio: null,
  };
}

function str(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }
  return null;
}

function num(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    // EXIF rationals sometimes arrive as "35/1" or as a numeric string.
    if (typeof v === 'string') {
      const fraction = v.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      if (fraction !== null) {
        const a = Number.parseFloat(fraction[1] as string);
        const b = Number.parseFloat(fraction[2] as string);
        if (b !== 0) {
          return a / b;
        }
      }
      const parsed = Number.parseFloat(v);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}
