/**
 * The canonical lens model, and every conversion into it.
 *
 * ONE ORDERING, AND IT IS OpenCV'S. Every platform hands distortion over in
 * its own arrangement:
 *
 *   OpenCV   [k1, k2, p1, p2, k3]      tangential in the MIDDLE
 *   Android  [k1, k2, k3, p1, p2]      tangential at the END
 *   iOS      a lookup table, no coefficients at all
 *   ours     a division-model λ, when fitted from straight lines
 *
 * Three of those are radial-plus-tangential polynomials that differ only in
 * where two numbers sit, which is precisely what makes the bug so good at
 * hiding: pass Android's array to `cv2.undistort` and k3 lands in p1's slot.
 * Nothing throws. The centre of the frame — where anyone would check — is
 * almost unaffected, because k3 and p1 both contribute nearly nothing near the
 * principal point. The corners are wrecked, and the corners are where the far
 * side of the pitch is.
 *
 * So the ordering is fixed at the boundary rather than carried around. A
 * device's own arrangement is a property of that device; OpenCV's is a
 * convention that does not vary, which makes it the one worth normalising on.
 * Nothing downstream of these functions should ever see a platform ordering.
 */

import type { DistortionFit } from './distortion';

/**
 * OpenCV `distCoeffs`, in OpenCV order.
 *
 * Five terms is the common case: `[k1, k2, p1, p2, k3]`. OpenCV also accepts
 * 4, 8, 12 and 14; the length is preserved rather than padded, because a
 * 4-element vector means "no k3" and padding it with a zero says the same
 * thing in a way that a reader cannot distinguish from a measured zero.
 */
export interface OpenCvDistortion {
  /** Always in OpenCV's ordering. The only representation anything should consume. */
  coefficients: number[];
  /** Where the numbers came from, since it bounds how far to trust them. */
  origin: 'android' | 'ios_fitted' | 'plumb_line' | 'chessboard' | 'profile';
  /**
   * True when the coefficients are an approximation of a different model
   * rather than a fit in this one — a division-model λ mapped to k1, or a
   * lookup table fitted to a polynomial. Downstream should prefer refining
   * these over trusting them.
   */
  approximate: boolean;
}

/**
 * Android `LENS_DISTORTION` → OpenCV order.
 *
 * `[k1, k2, k3, p1, p2]` → `[k1, k2, p1, p2, k3]`.
 *
 * This function exists so the swap happens exactly once, in a place with a
 * name and a test, instead of at each call site where it is an easy line to
 * write correctly and an easier one to write from memory.
 */
export function fromAndroidLensDistortion(android: number[]): OpenCvDistortion {
  if (android.length !== 5) {
    throw new Error(
      `Android LENS_DISTORTION is five coefficients [k1,k2,k3,p1,p2]; got ${android.length}. ` +
        'Refusing to guess which convention this is.',
    );
  }
  const [k1, k2, k3, p1, p2] = android as [number, number, number, number, number];
  return {
    coefficients: [k1, k2, p1, p2, k3],
    origin: 'android',
    approximate: false,
  };
}

/** The inverse, for anything that has to talk back to Camera2. */
export function toAndroidLensDistortion(model: OpenCvDistortion): number[] {
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = model.coefficients;
  return [k1, k2, k3, p1, p2];
}

/**
 * A division-model λ → an OpenCV coefficient vector.
 *
 * From the first-order expansion of `1/(1 + λr²) ≈ 1 − λr²`, so `k1 ≈ −λ`,
 * with the rest zero. Marked `approximate`, because it is: the two models
 * agree to first order and diverge at the frame edge, which is the one place
 * anybody cares about distortion.
 *
 * THE RADIUS NORMALISATION IS THE PART THAT GOES WRONG. λ was fitted against a
 * radius divided by half the image diagonal; OpenCV's coefficients act on a
 * radius in NORMALISED CAMERA coordinates — that is, pixels divided by the
 * focal length. Those are different scales, so the coefficient has to be
 * rescaled by the square of their ratio, and doing that requires knowing the
 * focal length. Without it, the conversion cannot be done at all, which is why
 * this returns null rather than a number that would be silently wrong by
 * whatever that ratio happens to be.
 */
export function fromDivisionModel(
  fit: DistortionFit,
  focalLengthPx: number | null,
): OpenCvDistortion | null {
  if (focalLengthPx === null || focalLengthPx <= 0) {
    return null;
  }
  // λ acts on (r / normalisationPx)². OpenCV's k1 acts on (r / focalLengthPx)².
  // Matching the two at equal r gives the scale factor below.
  const scale = (focalLengthPx / fit.normalisationPx) ** 2;
  return {
    coefficients: [-fit.lambda * scale, 0, 0, 0, 0],
    origin: 'plumb_line',
    approximate: true,
  };
}

/**
 * Apply the model, for previewing a correction or checking a fit.
 *
 * The forward Brown-Conrady map — undistorted normalised point to distorted —
 * which is the direction the model is actually defined in. Going the other way
 * needs iteration, and `undistortNormalised` below does that explicitly rather
 * than pretending the polynomial is invertible.
 */
export function distortNormalised(
  model: OpenCvDistortion,
  x: number,
  y: number,
): { x: number; y: number } {
  const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0] = model.coefficients;
  const r2 = x * x + y * y;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  return {
    x: x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
    y: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y,
  };
}

/**
 * Invert the model numerically.
 *
 * Fixed-point iteration, which is what OpenCV's own `undistortPoints` does.
 * Converges in a handful of steps for the coefficient magnitudes a football
 * camera produces, and the iteration count is capped rather than looped to
 * tolerance — a pathological coefficient must not hang a viewfinder.
 */
export function undistortNormalised(
  model: OpenCvDistortion,
  x: number,
  y: number,
  iterations = 8,
): { x: number; y: number } {
  let ux = x;
  let uy = y;
  for (let i = 0; i < iterations; i += 1) {
    const d = distortNormalised(model, ux, uy);
    ux += x - d.x;
    uy += y - d.y;
  }
  return { x: ux, y: uy };
}

/** A lens with no measurable distortion. A finding, not an absence. */
export function rectilinear(origin: OpenCvDistortion['origin']): OpenCvDistortion {
  return { coefficients: [0, 0, 0, 0, 0], origin, approximate: false };
}

/**
 * Is this lens straight enough to ignore?
 *
 * Answered in pixels at the frame corner rather than in coefficients, because
 * that is the only form in which the question has a meaningful threshold. Half
 * a pixel of displacement at the corner is below what the tracker can resolve;
 * thirty is a player-width error on the far touchline.
 */
export function cornerDisplacementPx(
  model: OpenCvDistortion,
  imageWidthPx: number,
  imageHeightPx: number,
  focalLengthPx: number,
): number {
  const x = imageWidthPx / 2 / focalLengthPx;
  const y = imageHeightPx / 2 / focalLengthPx;
  const d = distortNormalised(model, x, y);
  return Math.hypot(d.x - x, d.y - y) * focalLengthPx;
}
