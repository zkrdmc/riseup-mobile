import { NativeModule, requireNativeModule } from 'expo';

import type {
  CalibrationRequest,
  CalibrationResult,
  ChessboardRequest,
  ChessboardResult,
  HomographyRequest,
  HomographyResult,
  Point2,
  UndistortRequest,
} from './RiseupVision.types';

/**
 * Every method is async because every one of them is slow enough to drop a
 * frame. Chessboard detection on a 12 MP still is tens of milliseconds at best
 * and a full calibration over twenty views is seconds — neither belongs on the
 * JS thread while a viewfinder is running.
 */
declare class RiseupVisionModule extends NativeModule<Record<string, never>> {
  findChessboardCorners(request: ChessboardRequest): Promise<ChessboardResult>;
  calibrateCamera(request: CalibrationRequest): Promise<CalibrationResult>;
  findHomography(request: HomographyRequest): Promise<HomographyResult>;
  undistortPoints(request: UndistortRequest): Promise<Point2[]>;
  /** OpenCV build version. Also the cheapest proof that it linked. */
  getOpenCvVersion(): string;
}

/**
 * Resolved once, and never at import time.
 *
 * `requireNativeModule` THROWS when the native side is absent, and doing that
 * at module scope means any file importing this crashes on import rather than
 * degrading — in Expo Go, in a JS-only test run, and in any build made before
 * the module existed. The survey and framing code is deliberately usable
 * without OpenCV, so a hard import failure would take working screens down
 * with an unrelated one.
 */
let cached: RiseupVisionModule | null | undefined;

export function getRiseupVision(): RiseupVisionModule | null {
  if (cached === undefined) {
    try {
      cached = requireNativeModule<RiseupVisionModule>('RiseupVision');
    } catch {
      cached = null;
    }
  }
  return cached;
}

export function isRiseupVisionAvailable(): boolean {
  return getRiseupVision() !== null;
}

export type { RiseupVisionModule };
