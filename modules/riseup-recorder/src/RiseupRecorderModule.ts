import { NativeModule, requireNativeModule, requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

import type {
  PauseReason,
  RecorderEvents,
  RecorderStartOptions,
  RecorderStarted,
  RecorderState,
} from './RiseupRecorder.types';

declare class RiseupRecorderModule extends NativeModule<RecorderEvents> {
  /** The OS camera prompt. Resolves with expo's permission response. */
  requestPermission(): Promise<{ granted: boolean; canAskAgain?: boolean }>;
  /** Rejects with ERR_PERMISSION unless the camera is granted. */
  start(options: RecorderStartOptions): Promise<RecorderStarted>;
  /**
   * Hand a file to the OS for upload (Android WorkManager, iOS background
   * URLSession): it continues in the background and after a kill. Returns at
   * once; the outcome is `uploadStatus(id)`.
   */
  enqueueUpload(request: {
    id: string;
    file: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    /** Shown in Android's notification. */
    label?: string;
  }): void;
  /** 'queued' | 'uploading' | 'done' | 'retrying:<why>' | 'failed:<why>' | null. */
  uploadStatus(id: string): string | null;
  forgetUpload(id: string): void;
  /** Stop the camera and close the segment NOT final (pulled from the casing). */
  pause(reason: PauseReason): void;
  /** Camera back; the next segment continues the session clock. */
  resume(): void;
  /** The NEXT segment's bitrate (the upload ladder). No-op when idle. */
  setBitRate(bps: number): void;
  /** Finalises the last segment (`final: true`), then resolves. */
  stop(): Promise<void>;
  getState(): RecorderState;
}

/**
 * Resolved lazily, like `riseup-vision`: `requireNativeModule` throws when the
 * native side is absent (Expo Go, a JS-only test run, a build from before the
 * module), and a throw at import time would take unrelated screens down.
 */
let cached: RiseupRecorderModule | null | undefined;

export function getRiseupRecorder(): RiseupRecorderModule | null {
  if (cached === undefined) {
    try {
      cached = requireNativeModule<RiseupRecorderModule>('RiseupRecorder');
    } catch {
      cached = null;
    }
  }
  return cached;
}

export function isRiseupRecorderAvailable(): boolean {
  return getRiseupRecorder() !== null;
}

let previewView: ComponentType<ViewProps> | null | undefined;

/** The camera preview; null when the native module is absent. */
export function getRecorderPreview(): ComponentType<ViewProps> | null {
  if (previewView === undefined) {
    try {
      previewView = requireNativeView<ViewProps>('RiseupRecorder');
    } catch {
      previewView = null;
    }
  }
  return previewView ?? null;
}

export type { RiseupRecorderModule };
