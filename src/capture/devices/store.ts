/**
 * The club's saved cameras.
 *
 * Local for now. It should be club-wide — one person registers the camcorder
 * and calibrates it, and everybody else just picks it — which needs a server
 * endpoint that does not exist yet (`docs/BACKEND-GAPS.md`). The shape here is
 * what that endpoint should store, so the change is a sync layer rather than a
 * rewrite.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { cameraClassById } from './catalogue';
import type { LensCalibration, SavedCamera } from './types';

const STORAGE_KEY = 'riseup.cameras.v1';

type Listener = () => void;

class CameraStore {
  private cameras: SavedCamera[] = [];
  private listeners = new Set<Listener>();
  private hydrated = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SavedCamera[] => this.cameras;

  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        this.cameras = JSON.parse(raw) as SavedCamera[];
        this.emit();
      }
    } catch {
      // A corrupt list costs a re-add, which is a minute. Failing to open the
      // screen costs the match.
      this.cameras = [];
    }
  }

  add(input: { classId: string; label: string; make?: string; model?: string }): SavedCamera {
    const cls = cameraClassById(input.classId);
    const camera: SavedCamera = {
      id: Crypto.randomUUID(),
      classId: input.classId,
      label: input.label.trim(),
      kind: cls?.kind ?? 'external',
      make: input.make?.trim() ?? null,
      model: input.model?.trim() ?? null,
      lensModel: null,
      calibrations: [],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
    };
    this.cameras = [...this.cameras, camera];
    this.emit();
    return camera;
  }

  rename(id: string, label: string): void {
    this.cameras = this.cameras.map((c) => (c.id === id ? { ...c, label: label.trim() } : c));
    this.emit();
  }

  remove(id: string): void {
    this.cameras = this.cameras.filter((c) => c.id !== id);
    this.emit();
  }

  /**
   * Record that a camera was used, which is what floats it to the top.
   *
   * The club that films every match on the same camcorder should find it first
   * in the list forever, without ever setting a default — the same reason
   * Strava surfaces the shoes you actually run in.
   */
  markUsed(id: string): void {
    const now = new Date().toISOString();
    this.cameras = this.cameras.map((c) =>
      c.id === id ? { ...c, lastUsedAt: now, useCount: c.useCount + 1 } : c,
    );
    this.emit();
  }

  /**
   * Store a solved lens against a camera.
   *
   * Replaces any existing calibration at the same resolution and zoom, because
   * a re-calibration is a correction of the one before it — keeping both and
   * picking by date would work, and would also mean a bad solve lingers in the
   * list looking like a valid alternative.
   */
  addCalibration(id: string, calibration: LensCalibration): void {
    this.cameras = this.cameras.map((c) => {
      if (c.id !== id) {
        return c;
      }
      const others = c.calibrations.filter(
        (existing) =>
          !(
            existing.widthPx === calibration.widthPx &&
            existing.heightPx === calibration.heightPx &&
            Math.abs(existing.zoomRatio - calibration.zoomRatio) < 0.01
          ),
      );
      return { ...c, calibrations: [...others, calibration] };
    });
    this.emit();
  }

  /** Wipe the list. Used on account deletion, where nothing may survive. */
  reset(): void {
    this.cameras = [];
    this.emit();
  }

  private emit(): void {
    this.cameras = [...this.cameras];
    for (const l of this.listeners) {
      l();
    }
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.cameras)).catch(() => {
      // Usable this session; it just will not survive a restart.
    });
  }
}

export const cameraStore = new CameraStore();

/**
 * Most-recently-used first, then most-used, then alphabetical.
 *
 * Three tiers because the first two both go quiet: a club with two cameras
 * used equally has a meaningless recency order, and a brand-new list has
 * neither signal. Alphabetical last means the order is at least stable rather
 * than whatever order they happened to be added in.
 */
export function orderForPicker(cameras: SavedCamera[]): SavedCamera[] {
  return [...cameras].sort((a, b) => {
    if (a.lastUsedAt !== b.lastUsedAt) {
      if (a.lastUsedAt === null) {
        return 1;
      }
      if (b.lastUsedAt === null) {
        return -1;
      }
      return b.lastUsedAt.localeCompare(a.lastUsedAt);
    }
    if (a.useCount !== b.useCount) {
      return b.useCount - a.useCount;
    }
    return a.label.localeCompare(b.label);
  });
}
