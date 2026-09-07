//
//  RiseupVisionOpenCV.mm
//
//  The Objective-C++ side. This is the only file in the module that may
//  include an OpenCV header.
//
//  IMPORT ORDER IS LOAD-BEARING. The OpenCV headers must come BEFORE any
//  Apple framework header, because OpenCV defines symbols — `NO` chief among
//  them — that collide with Objective-C keywords once Foundation has been
//  seen. Reversing these two blocks produces a wall of errors inside OpenCV
//  that look nothing like an import-order problem.
//

#ifdef __cplusplus
#include <algorithm>
#include <cmath>
#include <vector>
#import <opencv2/opencv.hpp>
#import <opencv2/calib3d.hpp>
#import <opencv2/imgproc.hpp>
#endif

#import "RiseupVisionOpenCV.h"
#import <UIKit/UIKit.h>

static NSString *const kErrorDomain = @"co.riseupai.vision";

static NSError *MakeError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:kErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

/// NSArray of {x, y} → cv::Point2f vector.
static std::vector<cv::Point2f> PointsFromArray(NSArray<NSDictionary *> *array) {
  std::vector<cv::Point2f> points;
  points.reserve(array.count);
  for (NSDictionary *entry in array) {
    points.emplace_back([entry[@"x"] floatValue], [entry[@"y"] floatValue]);
  }
  return points;
}

static NSArray<NSDictionary *> *ArrayFromPoints(const std::vector<cv::Point2f> &points) {
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:points.size()];
  for (const auto &p : points) {
    [out addObject:@{@"x" : @(p.x), @"y" : @(p.y)}];
  }
  return out;
}

@implementation RiseupVisionOpenCV

+ (NSString *)openCvVersion {
  return [NSString stringWithUTF8String:CV_VERSION];
}

/// Load a file as single-channel grayscale.
///
/// `cv::imread` is used rather than going through UIImage: it reads straight
/// to a Mat, applies EXIF orientation, and avoids a full RGBA copy of a 12 MP
/// still that would immediately be discarded.
static bool LoadGrayscale(NSString *path, cv::Mat &out, NSError **error) {
  NSString *cleaned = [path hasPrefix:@"file://"] ? [[NSURL URLWithString:path] path] : path;
  if (cleaned == nil) {
    if (error) *error = MakeError(404, @"Could not read the image at that location.");
    return false;
  }
  out = cv::imread(cleaned.UTF8String, cv::IMREAD_GRAYSCALE);
  if (out.empty()) {
    if (error) *error = MakeError(415, @"That file is not an image this device can read.");
    return false;
  }
  return true;
}

+ (nullable NSDictionary *)findChessboardCornersAtPath:(NSString *)path
                                                  cols:(NSInteger)cols
                                                  rows:(NSInteger)rows
                                                 error:(NSError **)error {
  cv::Mat gray;
  if (!LoadGrayscale(path, gray, error)) {
    return nil;
  }

  std::vector<cv::Point2f> corners;
  // ADAPTIVE_THRESH is what makes this work on a photograph taken outdoors:
  // the board will be lit unevenly and a global threshold finds nothing.
  // NORMALIZE_IMAGE copes with the exposure spread of a frame shot into low sun.
  const int flags = cv::CALIB_CB_ADAPTIVE_THRESH | cv::CALIB_CB_NORMALIZE_IMAGE |
                    cv::CALIB_CB_FAST_CHECK;

  const bool found = cv::findChessboardCorners(
      gray, cv::Size((int)cols, (int)rows), corners, flags);

  double minX = 0, minY = 0, maxX = 0, maxY = 0;
  if (found && !corners.empty()) {
    // Sub-pixel refinement. Without it corners land on integer pixels, and
    // half a pixel of noise per observation propagates straight into the
    // distortion coefficients, which is the one quantity being solved for.
    cv::cornerSubPix(
        gray, corners, cv::Size(11, 11), cv::Size(-1, -1),
        cv::TermCriteria(cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.001));

    minX = maxX = corners[0].x;
    minY = maxY = corners[0].y;
    for (const auto &c : corners) {
      minX = std::min(minX, (double)c.x);
      maxX = std::max(maxX, (double)c.x);
      minY = std::min(minY, (double)c.y);
      maxY = std::max(maxY, (double)c.y);
    }
  }

  const double width = gray.cols;
  const double height = gray.rows;
  const double coverage =
      (found && width > 0 && height > 0) ? ((maxX - minX) * (maxY - minY)) / (width * height) : 0.0;

  return @{
    @"found" : @(found),
    @"corners" : found ? ArrayFromPoints(corners) : @[],
    @"imageWidth" : @((NSInteger)width),
    @"imageHeight" : @((NSInteger)height),
    @"coverageFraction" : @(coverage),
    @"boundsMinX" : @(minX),
    @"boundsMinY" : @(minY),
    @"boundsMaxX" : @(maxX),
    @"boundsMaxY" : @(maxY)
  };
}

+ (nullable NSDictionary *)calibrateCameraWithViews:(NSArray<NSArray<NSDictionary *> *> *)views
                                               cols:(NSInteger)cols
                                               rows:(NSInteger)rows
                                       squareSizeMm:(double)squareSizeMm
                                         imageWidth:(NSInteger)imageWidth
                                        imageHeight:(NSInteger)imageHeight
                                              error:(NSError **)error {
  if (views.count < 3) {
    if (error)
      *error = MakeError(400, @"A calibration needs at least three views. PRD 4.3 asks for 12 to 20.");
    return nil;
  }

  // The board in its own frame: planar, z = 0, millimetres. Identical for
  // every view — the board does not move, the camera does.
  std::vector<cv::Point3f> boardPoints;
  boardPoints.reserve(cols * rows);
  for (NSInteger r = 0; r < rows; r++) {
    for (NSInteger c = 0; c < cols; c++) {
      boardPoints.emplace_back(c * squareSizeMm, r * squareSizeMm, 0.0);
    }
  }

  std::vector<std::vector<cv::Point3f>> objectPoints;
  std::vector<std::vector<cv::Point2f>> imagePoints;
  for (NSArray<NSDictionary *> *view in views) {
    imagePoints.push_back(PointsFromArray(view));
    objectPoints.push_back(boardPoints);
  }

  cv::Mat cameraMatrix = cv::Mat::eye(3, 3, CV_64F);
  cv::Mat distCoeffs;
  std::vector<cv::Mat> rvecs, tvecs;

  double rms = 0;
  try {
    rms = cv::calibrateCamera(objectPoints, imagePoints,
                              cv::Size((int)imageWidth, (int)imageHeight), cameraMatrix,
                              distCoeffs, rvecs, tvecs);
  } catch (const cv::Exception &e) {
    if (error) *error = MakeError(500, [NSString stringWithUTF8String:e.what()]);
    return nil;
  }

  // Per-view reprojection error, so one bad photograph can be named and
  // retaken instead of quietly degrading the whole solve.
  NSMutableArray<NSNumber *> *perViewErrors = [NSMutableArray arrayWithCapacity:views.count];
  for (size_t i = 0; i < objectPoints.size(); i++) {
    std::vector<cv::Point2f> projected;
    cv::projectPoints(objectPoints[i], rvecs[i], tvecs[i], cameraMatrix, distCoeffs, projected);
    double sum = 0;
    for (size_t j = 0; j < projected.size() && j < imagePoints[i].size(); j++) {
      const double dx = imagePoints[i][j].x - projected[j].x;
      const double dy = imagePoints[i][j].y - projected[j].y;
      sum += dx * dx + dy * dy;
    }
    [perViewErrors addObject:@(projected.empty() ? 0.0 : std::sqrt(sum / projected.size()))];
  }

  NSMutableArray<NSNumber *> *k = [NSMutableArray arrayWithCapacity:9];
  for (int i = 0; i < 9; i++) {
    [k addObject:@(cameraMatrix.at<double>(i / 3, i % 3))];
  }

  // Straight out of calibrateCamera, so these are ALREADY in OpenCV order:
  // [k1, k2, p1, p2, k3]. Nothing here reorders them, which is the point of
  // solving with OpenCV rather than assembling a coefficient vector by hand.
  NSMutableArray<NSNumber *> *d = [NSMutableArray arrayWithCapacity:distCoeffs.total()];
  for (int i = 0; i < (int)distCoeffs.total(); i++) {
    [d addObject:@(distCoeffs.at<double>(i))];
  }

  return @{
    @"cameraMatrix" : k,
    @"distCoeffs" : d,
    @"rmsReprojectionError" : @(rms),
    @"perViewErrors" : perViewErrors
  };
}

+ (nullable NSDictionary *)findHomographyWithSrc:(NSArray<NSDictionary *> *)src
                                              dst:(NSArray<NSDictionary *> *)dst
                                 ransacThresholdPx:(double)threshold
                                             error:(NSError **)error {
  if (src.count < 4 || src.count != dst.count) {
    if (error)
      *error = MakeError(
          400, @"A homography needs at least four matched points, and both lists must be the same length.");
    return nil;
  }

  std::vector<cv::Point2f> srcPoints = PointsFromArray(src);
  std::vector<cv::Point2f> dstPoints = PointsFromArray(dst);

  cv::Mat mask;
  cv::Mat h;
  try {
    // RANSAC once there are more than the minimum four points: it is what
    // survives one mis-tapped corner, and a volunteer tapping pitch corners in
    // the dark will mis-tap one. With exactly four there is nothing to vote
    // with, so an exact solve is the honest answer.
    h = (srcPoints.size() > 4)
            ? cv::findHomography(srcPoints, dstPoints, cv::RANSAC, threshold, mask)
            : cv::findHomography(srcPoints, dstPoints);
  } catch (const cv::Exception &e) {
    if (error) *error = MakeError(500, [NSString stringWithUTF8String:e.what()]);
    return nil;
  }

  if (h.empty()) {
    if (error)
      *error = MakeError(422,
                         @"Those points do not describe a view of the pitch. Three of them may be "
                         @"in a straight line, or two may be the same point.");
    return nil;
  }

  NSMutableArray<NSNumber *> *hv = [NSMutableArray arrayWithCapacity:9];
  for (int i = 0; i < 9; i++) {
    [hv addObject:@(h.at<double>(i / 3, i % 3))];
  }

  NSMutableArray<NSNumber *> *inliers = [NSMutableArray arrayWithCapacity:src.count];
  for (NSUInteger i = 0; i < src.count; i++) {
    const bool kept = mask.empty() ? true : mask.at<uchar>((int)i) != 0;
    [inliers addObject:@(kept)];
  }

  return @{@"h" : hv, @"inliers" : inliers};
}

+ (nullable NSArray<NSDictionary *> *)undistortPoints:(NSArray<NSDictionary *> *)points
                                         cameraMatrix:(NSArray<NSNumber *> *)cameraMatrix
                                           distCoeffs:(NSArray<NSNumber *> *)distCoeffs
                                                error:(NSError **)error {
  if (cameraMatrix.count != 9) {
    if (error) *error = MakeError(400, @"The camera matrix must be nine numbers, row-major.");
    return nil;
  }

  cv::Mat k(3, 3, CV_64F);
  for (int i = 0; i < 9; i++) {
    k.at<double>(i / 3, i % 3) = [cameraMatrix[i] doubleValue];
  }
  cv::Mat d(1, (int)distCoeffs.count, CV_64F);
  for (int i = 0; i < (int)distCoeffs.count; i++) {
    d.at<double>(i) = [distCoeffs[i] doubleValue];
  }

  std::vector<cv::Point2f> in = PointsFromArray(points);
  std::vector<cv::Point2f> out;

  // Passing K again as the new camera matrix returns PIXELS. Omitting it is
  // the classic mistake here: the call succeeds and returns values near zero,
  // which look like catastrophic failure and are in fact normalised camera
  // coordinates.
  cv::undistortPoints(in, out, k, d, cv::noArray(), k);

  return ArrayFromPoints(out);
}

@end
