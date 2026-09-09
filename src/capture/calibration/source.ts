/**
 * Getting one frame of the pitch, through the camera that will film it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE FRAME HAS TO COME FROM THE CAMERA BEING CALIBRATED
 * ══════════════════════════════════════════════════════════════════════════
 * A homography maps THIS camera's image plane onto the ground. Solve it from a
 * frame taken by a different camera, or from the same camera in a different
 * mode, and every position it produces is wrong — silently, plausibly, by
 * metres.
 *
 * Two ways people get this wrong, and both are worth naming because both look
 * reasonable:
 *
 *   PHOTOGRAPHING THE CAMCORDER'S SCREEN with the phone. That calibrates the
 *   phone's lens and a flat panel. It is the first thing anybody tries.
 *
 *   USING A STILL FROM A STILLS CAMERA. A mirrorless body shoots photos off
 *   the full sensor and video off a crop or a line-skipped readout; a GoPro's
 *   photo and video modes have different fields of view. The still and the
 *   video are different cameras as far as this maths is concerned. For those
 *   bodies the frame has to be pulled from a VIDEO recorded in the mode the
 *   match will be filmed in.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  "LINKED BY CABLE OR BLUETOOTH" — WHAT THAT ACTUALLY IS
 * ══════════════════════════════════════════════════════════════════════════
 * There is no general way to open a live preview from an arbitrary camcorder
 * over USB or Bluetooth from a React Native app. iOS exposes no such API at
 * all. Android can open a UVC device through Camera2 as `LENS_FACING_EXTERNAL`,
 * but only for cameras that present as UVC — which most camcorders do not,
 * unless explicitly put into a webcam mode.
 *
 * What every one of those cameras CAN do is produce a file, and every one of
 * those transports ends in a file on the phone:
 *
 *   cable / card reader  Android surfaces USB storage through the system
 *                        document picker (SAF); iOS mounts readers in Files.
 *   Bluetooth            lands in Downloads or Files like any other transfer.
 *   vendor app           GoPro Quik, Sony Imaging Edge, Canon Camera Connect
 *                        copy to the camera roll over the camera's own Wi-Fi.
 *
 * So the import path is one path, and the UI names the transports rather than
 * pretending to drive them. That is not a shortcut — a live USB preview would
 * cover fewer cameras than the file import does.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';

export type SourceKind =
  /** This handset's own camera, shot in the app. */
  | 'device_camera'
  /** A photo or video already in the camera roll — usually via a vendor app. */
  | 'library'
  /** A file from anywhere else: cable, card reader, Bluetooth, Files. */
  | 'file';

export interface CalibrationFrame {
  uri: string;
  /**
   * The frame's own pixel dimensions, NOT the on-screen preview size.
   *
   * Load-bearing. A homography maps pixels to metres, so it is valid only at
   * the resolution it was solved at — the same reason a lens calibration is
   * keyed by resolution. Calibrating on a 12 MP still and filming at 4K is
   * wrong by the ratio between them.
   */
  width: number;
  height: number;
  kind: SourceKind;
  /** True when this came out of a video rather than being shot as a still. */
  fromVideo: boolean;
  /** Where in the clip, for a frame pulled from a video. */
  videoPositionMs?: number;
}

export interface SourceFailure {
  /** `cancelled` is not an error and must not be shown as one. */
  reason: 'cancelled' | 'permission' | 'unreadable' | 'unsupported';
  message: string;
}

export type SourceResult =
  | { ok: true; frame: CalibrationFrame }
  | { ok: false; failure: SourceFailure };

/**
 * Pull a still out of a video.
 *
 * WARNING WORTH READING BEFORE TRUSTING THE OUTPUT. `expo-video-thumbnails`
 * does not promise a full-resolution frame, and on some devices returns a
 * scaled one. A homography solved on a downscaled frame and then applied to
 * full-resolution footage is wrong by exactly that scale factor, and nothing
 * downstream would report it.
 *
 * So the returned dimensions are whatever came back, never what the video
 * claims, and `framesDisagree` below is what the screen uses to refuse a
 * mismatch rather than paper over it.
 */
export async function frameFromVideo(uri: string, atMs = 0): Promise<SourceResult> {
  try {
    const shot = await VideoThumbnails.getThumbnailAsync(uri, {
      time: atMs,
      quality: 1,
    });
    return {
      ok: true,
      frame: {
        uri: shot.uri,
        width: shot.width,
        height: shot.height,
        kind: 'file',
        fromVideo: true,
        videoPositionMs: atMs,
      },
    };
  } catch {
    return {
      ok: false,
      failure: {
        reason: 'unreadable',
        message:
          'Could not read a frame from that video. If it came off a camera, try copying it ' +
          'to the phone first rather than reading it over the cable.',
      },
    };
  }
}

/** Shoot the frame with this handset's camera, through the system UI. */
export async function fromDeviceCamera(): Promise<SourceResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return {
      ok: false,
      failure: {
        reason: 'permission',
        message:
          'RiseUp needs the camera to photograph the pitch. You can turn it on in Settings.',
      },
    };
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    // No cropping and no editing. A cropped frame has different intrinsics and
    // a different principal point than the one the match will be filmed in,
    // and the homography solved on it would be wrong for the footage.
    allowsEditing: false,
    quality: 1,
  });
  return fromPickerResult(result, 'device_camera');
}

/** A photo or video already on the phone — where a vendor app leaves things. */
export async function fromLibrary(): Promise<SourceResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      ok: false,
      failure: {
        reason: 'permission',
        message: 'RiseUp needs access to your photos to read the calibration frame.',
      },
    };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsEditing: false,
    quality: 1,
  });
  if (result.canceled) {
    return cancelled();
  }
  const asset = result.assets[0];
  if (asset === undefined) {
    return cancelled();
  }
  if (asset.type === 'video') {
    return frameFromVideo(asset.uri, 0);
  }
  return fromPickerResult(result, 'library');
}

/**
 * A file from anywhere else.
 *
 * On Android this is the Storage Access Framework, so a USB card reader or an
 * OTG cable shows up as a provider alongside Drive and Downloads. On iOS it is
 * the Files app, which mounts readers the same way. Bluetooth transfers land
 * in both.
 */
export async function fromFile(): Promise<SourceResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/*', 'video/*'],
    // Copied into the app's own cache. A SAF content:// URI is revoked when
    // the picker closes, so reading it later — which is exactly what solving
    // and then saving does — fails with a permission error that names nothing.
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) {
    return cancelled();
  }
  const asset = result.assets[0];
  if (asset === undefined) {
    return cancelled();
  }

  const isVideo = (asset.mimeType ?? '').startsWith('video/');
  if (isVideo) {
    return frameFromVideo(asset.uri, 0);
  }

  // DocumentPicker does not report image dimensions, unlike ImagePicker. They
  // are not optional here — a homography without the frame size it was solved
  // at cannot be applied to anything — so they are read from the file itself.
  const size = await measureImage(asset.uri);
  if (size === null) {
    return {
      ok: false,
      failure: {
        reason: 'unreadable',
        message: 'Could not read that file as an image. Try a JPEG or PNG.',
      },
    };
  }
  return {
    ok: true,
    frame: { uri: asset.uri, width: size.width, height: size.height, kind: 'file', fromVideo: false },
  };
}

function cancelled(): SourceResult {
  return { ok: false, failure: { reason: 'cancelled', message: '' } };
}

function fromPickerResult(
  result: ImagePicker.ImagePickerResult,
  kind: SourceKind,
): SourceResult {
  if (result.canceled) {
    return cancelled();
  }
  const asset = result.assets[0];
  if (asset === undefined) {
    return cancelled();
  }
  return {
    ok: true,
    frame: {
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      kind,
      fromVideo: false,
    },
  };
}

/** React Native's own image loader, promisified. No extra dependency. */
async function measureImage(uri: string): Promise<{ width: number; height: number } | null> {
  const { Image } = await import('react-native');
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => { resolve({ width, height }); },
      () => { resolve(null); },
    );
  });
}

/**
 * `framesDisagree` used to live here and now lives in `solve.ts`.
 *
 * It is pure, and everything else in this file imports Expo modules that
 * cannot load under plain Node — so keeping it here put the one check worth
 * testing out of reach of `npm run smoke`. Re-exported so callers importing
 * "the source module" still find it.
 */
export { framesDisagree } from './solve';
