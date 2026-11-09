import AVFoundation
import ExpoModulesCore

/**
 * The JS face of `SegmentRecorder`: one recording at a time, events out.
 *
 * ONE AVCaptureSession FOR THE APP (`RecorderHub.session`), so the preview
 * view can show it without owning the recording.
 */
enum RecorderHub {
  static let session = AVCaptureSession()
}

public class RiseupRecorderModule: Module {
  private var recorder: SegmentRecorder?
  private var state = "idle"
  private var startPromise: Promise?
  private var stopPromise: Promise?

  private func setState(_ next: String) {
    state = next
    sendEvent("onState", ["state": next])
  }

  public func definition() -> ModuleDefinition {
    Name("RiseupRecorder")

    Events("onSegment", "onError", "onState", "onPaused", "onResumed")

    View(RecorderPreviewView.self) {}

    Function("getState") { () -> String in
      self.state
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      AVCaptureDevice.requestAccess(for: .video) { granted in
        promise.resolve(["granted": granted,
                         "canAskAgain": AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined])
      }
    }

    AsyncFunction("start") { (options: [String: Any], promise: Promise) in
      if self.recorder != nil {
        promise.reject("ERR_BUSY", "A recording is already running.")
        return
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        promise.reject("ERR_PERMISSION", "Camera permission has not been granted.")
        return
      }
      guard var dir = options["directory"] as? String else {
        promise.reject("ERR_BAD_REQUEST", "directory is required.")
        return
      }
      if dir.hasPrefix("file://") { dir = String(dir.dropFirst(7)) }
      let opts = SegmentRecorder.Options(
        directory: URL(fileURLWithPath: dir, isDirectory: true),
        segmentSeconds: (options["segmentSeconds"] as? NSNumber)?.doubleValue ?? 60,
        width: (options["width"] as? NSNumber)?.intValue ?? 1920,
        height: (options["height"] as? NSNumber)?.intValue ?? 1080,
        fps: (options["fps"] as? NSNumber)?.intValue ?? 25,
        bitRate: (options["bitRate"] as? NSNumber)?.intValue ?? 16_000_000,
        widest: (options["widest"] as? Bool) ?? true,
        codec: (options["codec"] as? String) ?? "hevc",
        sequenceStart: (options["sequenceStart"] as? NSNumber)?.intValue ?? 0,
        ptsOffsetNs: (options["ptsOffsetNs"] as? NSNumber)?.int64Value ?? 0)
      let r = SegmentRecorder(session: RecorderHub.session, options: opts)
      r.onStarted = { [weak self] startedAt, w, h, fps, lens, codec in
        guard let self else { return }
        self.setState("recording")
        self.startPromise?.resolve(["startedAtMs": startedAt, "width": w, "height": h, "fps": fps,
                                    "lens": lens, "codec": codec])
        self.startPromise = nil
      }
      r.onSegment = { [weak self] s in
        self?.sendEvent("onSegment", [
          "path": s.path, "sequence": s.sequence,
          "startPtsNs": Double(s.startPtsNs), "endPtsNs": Double(s.endPtsNs),
          "frameCount": s.frameCount, "byteLength": Double(s.byteLength),
          "sha256": s.sha256, "final": s.final, "droppedFrames": s.droppedFrames,
          "codec": s.codec, "bitRate": s.bitRate,
        ])
      }
      r.onError = { [weak self] code, message in
        guard let self else { return }
        self.sendEvent("onError", ["code": code, "message": message])
        self.startPromise?.reject(code, message)
        self.startPromise = nil
      }
      r.onPaused = { [weak self] atNs, reason in
        self?.setState("paused")
        self?.sendEvent("onPaused", ["atNs": Double(atNs), "reason": reason])
      }
      r.onResumed = { [weak self] in
        self?.setState("recording")
        self?.sendEvent("onResumed", [:])
      }
      r.onStopped = { [weak self] in
        guard let self else { return }
        self.recorder = nil
        self.setState("idle")
        self.startPromise?.reject("ERR_STOPPED", "The recording stopped before it started.")
        self.startPromise = nil
        self.stopPromise?.resolve(nil)
        self.stopPromise = nil
      }
      self.recorder = r
      self.startPromise = promise
      self.setState("starting")
      r.start()
    }

    /** Hand one file to iOS for upload (BackgroundUploader): it continues
     * while the app is suspended or terminated. Outcome: `uploadStatus(id)`. */
    Function("enqueueUpload") { (request: [String: Any]) in
      guard let id = request["id"] as? String,
            var file = request["file"] as? String,
            let urlString = request["url"] as? String,
            let url = URL(string: urlString) else {
        throw Exception(name: "ERR_BAD_REQUEST", description: "id, file and url are required.")
      }
      if file.hasPrefix("file://") { file = String(file.dropFirst(7)) }
      let headers = (request["headers"] as? [String: Any])?.mapValues { "\($0)" } ?? [:]
      BackgroundUploader.shared.enqueue(
        id: id, file: URL(fileURLWithPath: file), url: url,
        method: request["method"] as? String ?? "PUT", headers: headers)
    }

    Function("uploadStatus") { (id: String) -> String? in
      BackgroundUploader.shared.status(id)
    }

    Function("forgetUpload") { (id: String) in
      BackgroundUploader.shared.forget(id)
    }

    /** Pulled from the casing: close the segment non-final, stop the camera. */
    Function("pause") { (reason: String) in
      self.recorder?.pause(reason)
    }

    /** Back in the casing: the next segment continues the session clock. */
    Function("resume") {
      self.recorder?.resume()
    }

    /** The next segment's bitrate (the upload ladder); a no-op when idle. */
    Function("setBitRate") { (bps: Int) in
      self.recorder?.setBitRate(bps)
    }

    AsyncFunction("stop") { (promise: Promise) in
      guard let r = self.recorder else {
        promise.resolve(nil)
        return
      }
      self.stopPromise = promise
      self.setState("stopping")
      r.stop()
    }
  }
}

/** The camera preview: the shared session's layer, nothing more. */
class RecorderPreviewView: ExpoView {
  private let preview = AVCaptureVideoPreviewLayer(session: RecorderHub.session)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    preview.videoGravity = .resizeAspect
    layer.addSublayer(preview)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    preview.frame = bounds
    if let connection = preview.connection {
      // The same rule as the recording: upright for the way the phone is held.
      let left = SegmentRecorder.interfaceIsLandscapeLeft()
      if #available(iOS 17.0, *) {
        let angle: CGFloat = left ? 180 : 0
        if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
      } else if connection.isVideoOrientationSupported {
        connection.videoOrientation = left ? .landscapeLeft : .landscapeRight
      }
    }
  }
}
