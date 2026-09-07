/**
 * Proof that calib3d actually linked.
 *
 * WHY THIS IS NOT OPTIONAL. A build can succeed, install, and run with OpenCV
 * present and `calib3d` absent — which is exactly what `react-native-fast-opencv`
 * ships, and the reason this module exists. Nothing about a green build says
 * the one module we care about came with it. The failure would otherwise
 * surface as a homography that throws the first time an operator taps four
 * pitch corners at a ground, which is the worst possible place to discover it.
 *
 * So: a synthetic solve with a known answer, runnable in a second, with no
 * camera and no pitch.
 *
 * IT ALSO CATCHES A MISSING ABI. `OpenCVLoader.initLocal()` needs the native
 * `.so` for the device's architecture. An emulator is usually x86_64 while a
 * phone is arm64, and an AAR missing one of them fails at RUN time, not build
 * time — with an UnsatisfiedLinkError that mentions nothing about OpenCV.
 */

import { getRiseupVision } from './RiseupVisionModule';

export interface SelfTestResult {
  available: boolean;
  openCvVersion: string | null;
  /** True when a synthetic homography solved to the expected answer. */
  calib3dWorks: boolean;
  /** Largest deviation from the expected matrix, for judging "close enough". */
  worstError: number | null;
  /** What went wrong, in a form worth putting in a support ticket. */
  detail: string;
}

/**
 * Solve a homography whose answer is known, and check it.
 *
 * The correspondence is a pure 2× scale with a translation, so the exact
 * matrix is known in advance:
 *
 *     [2 0 100]
 *     [0 2  50]
 *     [0 0   1]
 *
 * Five points rather than four, so the RANSAC path is exercised — which is the
 * branch that actually runs at a ground, and the one `getPerspectiveTransform`
 * substitutes cannot do.
 */
export async function runVisionSelfTest(): Promise<SelfTestResult> {
  const vision = getRiseupVision();

  if (vision === null) {
    return {
      available: false,
      openCvVersion: null,
      calib3dWorks: false,
      detail:
        'The native vision module is not in this build. Rebuild with `eas build`, or run a ' +
        'development build rather than Expo Go.',
      worstError: null,
    };
  }

  let openCvVersion: string | null = null;
  try {
    openCvVersion = vision.getOpenCvVersion();
  } catch (e) {
    return {
      available: true,
      openCvVersion: null,
      calib3dWorks: false,
      detail:
        'OpenCV did not load. On Android this usually means the native library for this ' +
        `device's architecture is missing from the build. (${String(e)})`,
      worstError: null,
    };
  }

  const src = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 5, y: 5 },
  ];
  const expected = [2, 0, 100, 0, 2, 50, 0, 0, 1];
  const dst = src.map((p) => ({ x: 2 * p.x + 100, y: 2 * p.y + 50 }));

  try {
    const result = await vision.findHomography({ src, dst, ransacThresholdPx: 3 });

    if (!Array.isArray(result.h) || result.h.length !== 9) {
      return {
        available: true,
        openCvVersion,
        calib3dWorks: false,
        detail: `findHomography returned ${result.h?.length ?? 0} values instead of nine.`,
        worstError: null,
      };
    }

    // A homography is defined only up to scale, so normalise by h22 before
    // comparing. Skipping this is how a perfectly correct solve looks wrong.
    const scale = result.h[8] ?? 0;
    if (Math.abs(scale) < 1e-12) {
      return {
        available: true,
        openCvVersion,
        calib3dWorks: false,
        detail: 'findHomography returned a degenerate matrix (h22 is zero).',
        worstError: null,
      };
    }

    let worstError = 0;
    for (let i = 0; i < 9; i += 1) {
      const got = (result.h[i] as number) / scale;
      const want = expected[i] as number;
      worstError = Math.max(worstError, Math.abs(got - want));
    }

    const passed = worstError < 1e-6;
    return {
      available: true,
      openCvVersion,
      calib3dWorks: passed,
      worstError,
      detail: passed
        ? `calib3d works. OpenCV ${openCvVersion}, worst error ${worstError.toExponential(1)}.`
        : `findHomography solved, but not to the expected matrix — worst error ${worstError.toExponential(1)}.`,
    };
  } catch (e) {
    return {
      available: true,
      openCvVersion,
      calib3dWorks: false,
      worstError: null,
      // The likely cause, named. An OpenCV built without calib3d fails here and
      // nowhere earlier, so this string is the one that identifies it.
      detail:
        'findHomography failed, which usually means OpenCV was built without calib3d. ' +
        `(${String(e)})`,
    };
  }
}
