/**
 * The calib3d surface, and nothing else.
 *
 * Four functions. OpenCV is enormous and linking it is the expensive part, so
 * the temptation is to expose more of it "while we are here" — which turns a
 * bounded native module into a second API nobody owns. Everything the product
 * needs from calib3d is here:
 *
 *   findChessboardCorners  — detect the calibration target (PRD §4.3)
 *   calibrateCamera        — solve intrinsics and distortion from those views
 *   findHomography         — the pitch solve behind the framing assistant (§4.2)
 *   undistortPoints        — apply a solved model to tapped points
 *
 * WHY THIS EXISTS RATHER THAN AN OFF-THE-SHELF BINDING. `react-native-fast-opencv`
 * ships without calib3d — its own source says `cv::findHomography needs
 * calib3d, which is not in the iOS pod` — and substitutes
 * `getPerspectiveTransform` on exactly four points. That is a homography with
 * no least-squares fit over the other correspondences and no RANSAC, which is
 * precisely what a viewfinder solve on hand-tapped points needs most.
 */

export interface Point2 {
  x: number;
  y: number;
}

/* ── Chessboard detection ─────────────────────────────────────────────────── */

export interface ChessboardRequest {
  /** Local file URI of the photograph. */
  imageUri: string;
  /**
   * INNER corner counts, not squares. A board printed with 10×7 squares has
   * 9×6 inner corners, and passing the square count is the single most common
   * way a calibration silently finds nothing at all.
   */
  patternCols: number;
  patternRows: number;
}

export interface ChessboardResult {
  found: boolean;
  /** Row-major, `patternCols * patternRows` of them, already sub-pixel refined. */
  corners: Point2[];
  imageWidth: number;
  imageHeight: number;
  /**
   * Fraction of the frame this board covers, 0–1.
   *
   * The coverage overlay in PRD §4.3 is built on this: the centre of a lens is
   * nearly rectilinear and the corners are the whole problem, so the operator
   * has to be pushed to put the board where it is uncomfortable.
   */
  coverageFraction: number;
  /** Bounding box of the detected board, for drawing that overlay. */
  boundsMinX: number;
  boundsMinY: number;
  boundsMaxX: number;
  boundsMaxY: number;
}

/* ── Calibration ──────────────────────────────────────────────────────────── */

export interface CalibrationRequest {
  /** One entry per accepted photograph. 12–20 per §4.3. */
  views: Point2[][];
  patternCols: number;
  patternRows: number;
  /** Physical square size. Sets the scale of nothing we use, but OpenCV wants it. */
  squareSizeMm: number;
  imageWidth: number;
  imageHeight: number;
}

export interface CalibrationResult {
  /** Row-major 3×3. */
  cameraMatrix: number[];
  /**
   * `distCoeffs` in OPENCV ORDER — `[k1, k2, p1, p2, k3]`.
   *
   * Which is the whole reason this module returns them rather than the caller
   * assembling them: it comes straight out of `cv::calibrateCamera`, so there
   * is no ordering to get wrong.
   */
  distCoeffs: number[];
  /** Overall RMS reprojection error in pixels. Under ~0.5 is a good solve. */
  rmsReprojectionError: number;
  /** Per view, so a bad photograph can be identified and retaken. */
  perViewErrors: number[];
}

/* ── Homography ───────────────────────────────────────────────────────────── */

export interface HomographyRequest {
  /** Pitch coordinates in metres. */
  src: Point2[];
  /** The corresponding image pixels the operator tapped. */
  dst: Point2[];
  /**
   * RANSAC reprojection threshold in pixels. Above zero enables RANSAC, which
   * is what tolerates one badly-tapped point out of six — and a volunteer
   * tapping a corner in the dark will mis-tap one.
   */
  ransacThresholdPx: number;
}

export interface HomographyResult {
  /** Row-major 3×3, mapping src to dst. */
  h: number[];
  /** Which correspondences RANSAC kept. Same length as the inputs. */
  inliers: boolean[];
}

export interface UndistortRequest {
  points: Point2[];
  cameraMatrix: number[];
  /** OpenCV order. */
  distCoeffs: number[];
}
