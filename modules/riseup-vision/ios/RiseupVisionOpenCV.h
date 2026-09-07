//
//  RiseupVisionOpenCV.h
//
//  The Objective-C face of the OpenCV bridge.
//
//  WHY THIS FILE EXISTS. Swift cannot call OpenCV. OpenCV's iOS API is C++,
//  and Swift has no C++ interop that reaches it — so the calls have to happen
//  in Objective-C++ (`.mm`) and be exposed through a header containing no C++
//  whatsoever. That is what this is: plain Objective-C types only, so the
//  Swift side can import it without ever seeing `cv::Mat`.
//
//  Get that wrong and the failure is not subtle — the whole module stops
//  compiling with several hundred template errors out of the OpenCV headers.
//
//  Everything crosses the boundary as NSArray/NSDictionary of NSNumber, which
//  is also exactly what the Expo module bridge wants, so there is no second
//  conversion on the Swift side.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RiseupVisionOpenCV : NSObject

/// OpenCV's build version. Also the cheapest confirmation that it linked.
+ (NSString *)openCvVersion;

/// Detect an `cols` x `rows` INNER-corner chessboard, sub-pixel refined.
/// Returns the dictionary shape described in `RiseupVision.types.ts`.
/// `error` is set for an unreadable image; a board simply not being found is
/// a successful call with `found` = NO.
+ (nullable NSDictionary *)findChessboardCornersAtPath:(NSString *)path
                                                  cols:(NSInteger)cols
                                                  rows:(NSInteger)rows
                                                 error:(NSError **)error;

/// Solve intrinsics and distortion. `views` is an array of arrays of
/// `@{@"x": , @"y": }`. `distCoeffs` comes back in OpenCV order.
+ (nullable NSDictionary *)calibrateCameraWithViews:(NSArray<NSArray<NSDictionary *> *> *)views
                                               cols:(NSInteger)cols
                                               rows:(NSInteger)rows
                                       squareSizeMm:(double)squareSizeMm
                                         imageWidth:(NSInteger)imageWidth
                                        imageHeight:(NSInteger)imageHeight
                                              error:(NSError **)error;

/// Homography from `src` to `dst`, with RANSAC when there are more than four
/// correspondences to vote with.
+ (nullable NSDictionary *)findHomographyWithSrc:(NSArray<NSDictionary *> *)src
                                              dst:(NSArray<NSDictionary *> *)dst
                                 ransacThresholdPx:(double)threshold
                                             error:(NSError **)error;

/// Apply a solved model to points, returning PIXELS rather than normalised
/// camera coordinates.
+ (nullable NSArray<NSDictionary *> *)undistortPoints:(NSArray<NSDictionary *> *)points
                                         cameraMatrix:(NSArray<NSNumber *> *)cameraMatrix
                                           distCoeffs:(NSArray<NSNumber *> *)distCoeffs
                                                error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
