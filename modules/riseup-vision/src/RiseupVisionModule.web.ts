import { registerWebModule, NativeModule } from 'expo';

/**
 * Not available on web, and deliberately not stubbed.
 *
 * A stub returning an identity homography or a zero distortion vector would be
 * indistinguishable downstream from a real solve. The capture path is native
 * only (PRD §9); anything reaching for this on web is a bug worth surfacing.
 */
class RiseupVisionModule extends NativeModule<Record<string, never>> {}

export default registerWebModule(RiseupVisionModule, 'RiseupVisionModule');
