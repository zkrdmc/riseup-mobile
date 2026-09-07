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
  /** OpenCV build version, for support and for confirming calib3d is linked. */
  getOpenCvVersion(): string;
}

export default requireNativeModule<RiseupVisionModule>('RiseupVision');
