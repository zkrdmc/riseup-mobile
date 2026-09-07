/**
 * OpenCV calib3d, wrapped.
 *
 * Public surface for the module. Callers get OpenCV-ordered coefficients from
 * here and should keep them that way — see `src/capture/survey/opencv.ts` for
 * why the ordering is normalised rather than carried per platform.
 */

export { getRiseupVision, isRiseupVisionAvailable } from './src/RiseupVisionModule';
export { runVisionSelfTest, type SelfTestResult } from './src/selfTest';
export * from './src/RiseupVision.types';
