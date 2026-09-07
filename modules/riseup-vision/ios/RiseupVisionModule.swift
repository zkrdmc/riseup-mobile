import ExpoModulesCore

/**
 * The Expo module. Contains no OpenCV, on purpose.
 *
 * Every call goes through `RiseupVisionOpenCV`, the Objective-C++ bridge,
 * because Swift cannot see OpenCV's C++ headers. Keeping this file free of
 * them is what makes it compile at all.
 *
 * Each function runs on a background queue: chessboard detection on a 12 MP
 * still is tens of milliseconds at best, and a calibration over twenty views
 * is seconds. Neither belongs on the JS thread while a viewfinder is running.
 */
public class RiseupVisionModule: Module {
  private let queue = DispatchQueue(label: "co.riseupai.vision", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("RiseupVision")

    Function("getOpenCvVersion") { () -> String in
      RiseupVisionOpenCV.openCvVersion()
    }

    AsyncFunction("findChessboardCorners") { (request: [String: Any], promise: Promise) in
      guard let uri = request["imageUri"] as? String,
            let cols = (request["patternCols"] as? NSNumber)?.intValue,
            let rows = (request["patternRows"] as? NSNumber)?.intValue else {
        promise.reject("ERR_BAD_REQUEST", "imageUri, patternCols and patternRows are required.")
        return
      }

      queue.async {
        var error: NSError?
        let result = RiseupVisionOpenCV.findChessboardCorners(
          atPath: uri, cols: cols, rows: rows, error: &error)
        if let result {
          promise.resolve(result)
        } else {
          promise.reject("ERR_CHESSBOARD", error?.localizedDescription ?? "Detection failed.")
        }
      }
    }

    AsyncFunction("calibrateCamera") { (request: [String: Any], promise: Promise) in
      guard let views = request["views"] as? [[[String: Any]]],
            let cols = (request["patternCols"] as? NSNumber)?.intValue,
            let rows = (request["patternRows"] as? NSNumber)?.intValue,
            let square = (request["squareSizeMm"] as? NSNumber)?.doubleValue,
            let width = (request["imageWidth"] as? NSNumber)?.intValue,
            let height = (request["imageHeight"] as? NSNumber)?.intValue else {
        promise.reject("ERR_BAD_REQUEST", "A calibration request is missing required fields.")
        return
      }

      queue.async {
        var error: NSError?
        let result = RiseupVisionOpenCV.calibrateCamera(
          withViews: views as [[[String: Any]]] as! [[NSDictionary]],
          cols: cols, rows: rows, squareSizeMm: square,
          imageWidth: width, imageHeight: height, error: &error)
        if let result {
          promise.resolve(result)
        } else {
          promise.reject("ERR_CALIBRATION", error?.localizedDescription ?? "Calibration failed.")
        }
      }
    }

    AsyncFunction("findHomography") { (request: [String: Any], promise: Promise) in
      guard let src = request["src"] as? [NSDictionary],
            let dst = request["dst"] as? [NSDictionary] else {
        promise.reject("ERR_BAD_REQUEST", "src and dst point lists are required.")
        return
      }
      let threshold = (request["ransacThresholdPx"] as? NSNumber)?.doubleValue ?? 3.0

      queue.async {
        var error: NSError?
        let result = RiseupVisionOpenCV.findHomography(
          withSrc: src, dst: dst, ransacThresholdPx: threshold, error: &error)
        if let result {
          promise.resolve(result)
        } else {
          promise.reject("ERR_HOMOGRAPHY", error?.localizedDescription ?? "Solve failed.")
        }
      }
    }

    AsyncFunction("undistortPoints") { (request: [String: Any], promise: Promise) in
      guard let points = request["points"] as? [NSDictionary],
            let k = request["cameraMatrix"] as? [NSNumber],
            let d = request["distCoeffs"] as? [NSNumber] else {
        promise.reject("ERR_BAD_REQUEST", "points, cameraMatrix and distCoeffs are required.")
        return
      }

      queue.async {
        var error: NSError?
        let result = RiseupVisionOpenCV.undistortPoints(
          points, cameraMatrix: k, distCoeffs: d, error: &error)
        if let result {
          promise.resolve(result)
        } else {
          promise.reject("ERR_UNDISTORT", error?.localizedDescription ?? "Undistort failed.")
        }
      }
    }
  }
}
