/**
 * Solved pitch calibrations, held on the phone.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THESE DO NOT GO STRAIGHT TO THE SERVER
 * ══════════════════════════════════════════════════════════════════════════
 * A homography belongs to a VIEWPOINT — this camera, standing here, looking at
 * this pitch. The server models that as `venue_cameras.h_matrix`, keyed by
 * venue and camera, and the endpoint that writes it needs a venue and a pitch
 * because a matrix without the rectangle it was fitted to cannot be checked
 * for staleness (`migrations/007`, `calibration_is_stale`).
 *
 * The calibration screen has a camera and a frame. It does not have a venue,
 * because choosing one belongs to the survey. Posting anyway would mean
 * inventing a venue to satisfy a foreign key, which is how a database ends up
 * full of rows nobody can interpret.
 *
 * So the solve is kept here, against the camera, until the survey says where
 * it was standing. That is a real state a calibration can sit in for days —
 * somebody calibrates in a car park on Thursday and the fixture is Saturday —
 * and it is better than either losing the work or filing it in the wrong place.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT IS STORED IS A SNAPSHOT, NOT A REFERENCE
 * ══════════════════════════════════════════════════════════════════════════
 * The frame size, the pitch dimensions, the reprojection error and which
 * solver produced it all travel with the matrix. A homography read later
 * without them cannot be applied to anything: it is nine numbers whose meaning
 * depends on the frame it was solved in and the rectangle it was fitted to.
 * `venue_cameras` already keeps `calibrated_length_m` for the same reason.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'riseup.pitchCalibrations.v1';

export interface PitchCalibration {
  /** The saved camera this was solved for — `SavedCamera.id`. */
  cameraId: string;

  /** Row-major 3×3, mapping PITCH METRES onto IMAGE PIXELS. */
  homography: number[];

  /**
   * The frame it was solved in. Without this the matrix is unusable: it maps
   * onto pixels of a specific size, and applying it to a different frame is
   * wrong by the ratio between them.
   */
  imageWidth: number;
  imageHeight: number;

  /** The rectangle it was fitted to. Remeasure the pitch and this goes stale. */
  pitchLengthM: number;
  pitchWidthM: number;

  /** How well the marked points agreed, in pixels. */
  rmsErrorPx: number;
  /** RANSAC is stronger than least squares and the difference is recorded. */
  solvedBy: 'opencv_ransac' | 'least_squares';
  /** How many markings were marked. Redundancy, in one number. */
  pointCount: number;

  solvedAt: string;
  appVersion: string;

  /**
   * Set once this has been filed against a venue camera on the server.
   *
   * Null is the normal state for a fresh solve, not an error — see the header.
   */
  uploadedToVenueCameraId: string | null;
}

type Listener = () => void;

class CalibrationStore {
  private items: PitchCalibration[] = [];
  private listeners = new Set<Listener>();
  private hydrated = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PitchCalibration[] => this.items;

  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        this.items = JSON.parse(raw) as PitchCalibration[];
        this.emit();
      }
    } catch {
      // A corrupt list costs a re-calibration, which is minutes. Failing to
      // open the screen costs the match.
      this.items = [];
    }
  }

  /**
   * Store a solve, replacing any previous one for the same camera at the same
   * frame size.
   *
   * Replacing rather than accumulating, for the reason a lens re-solve does:
   * a second calibration of the same camera in the same view is a correction
   * of the first, and keeping both leaves a bad one in the list looking like a
   * valid alternative. A DIFFERENT frame size is a different calibration and
   * is kept alongside.
   */
  save(calibration: PitchCalibration): void {
    this.items = [
      ...this.items.filter(
        (c) =>
          !(
            c.cameraId === calibration.cameraId &&
            c.imageWidth === calibration.imageWidth &&
            c.imageHeight === calibration.imageHeight
          ),
      ),
      calibration,
    ];
    this.emit();
  }

  forCamera(cameraId: string): PitchCalibration[] {
    return this.items.filter((c) => c.cameraId === cameraId);
  }

  remove(cameraId: string, imageWidth: number, imageHeight: number): void {
    this.items = this.items.filter(
      (c) =>
        !(c.cameraId === cameraId && c.imageWidth === imageWidth && c.imageHeight === imageHeight),
    );
    this.emit();
  }

  /** Wipe. Used on account deletion, where nothing may survive. */
  reset(): void {
    this.items = [];
    this.emit();
  }

  private emit(): void {
    this.items = [...this.items];
    for (const l of this.listeners) {
      l();
    }
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.items)).catch(() => {
      // Usable this session; it just will not survive a restart.
    });
  }
}

export const calibrationStore = new CalibrationStore();
