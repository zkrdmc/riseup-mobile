/**
 * OpenCV calib3d, wrapped.
 *
 * Public surface for the module. Callers get OpenCV-ordered coefficients from
 * here and should keep them that way — see `src/capture/survey/opencv.ts` for
 * why the ordering is normalised rather than carried per platform.
 */

export { default as RiseupVision } from './src/RiseupVisionModule';
export * from './src/RiseupVision.types';
