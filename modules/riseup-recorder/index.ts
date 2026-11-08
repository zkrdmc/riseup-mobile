/**
 * Gapless segmented match recording: one encoder for the whole match, the
 * output rolled to a new file at a keyframe every `segmentSeconds`.
 */

export {
  getRecorderPreview,
  getRiseupRecorder,
  isRiseupRecorderAvailable,
} from './src/RiseupRecorderModule';
export * from './src/RiseupRecorder.types';
