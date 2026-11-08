import AVFoundation
import CryptoKit
import Foundation
import UIKit

/**
 * One match, recorded as gapless segments (iOS).
 *
 * The camera delivers every frame to `captureOutput`, on one serial queue.
 * Each frame is appended to exactly one AVAssetWriter. At the first frame
 * whose PTS is at or past the boundary, the current writer's session ENDS at
 * that PTS and the next writer's session STARTS at it, so segment N ends where
 * segment N+1 begins (the chunk contract's 2 ms join holds by construction).
 * A new writer has its own compression session, so its first frame is a
 * keyframe: every file opens cleanly.
 *
 * THE NEXT WRITER IS PREPARED AHEAD. `startWriting()` on a fresh writer takes
 * milliseconds; done at the boundary it would stall the queue and drop the
 * frames behind it. It is done right after each roll instead.
 *
 * Closing (finishWriting), hashing and reporting run on `io`, in order.
 */
final class SegmentRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  struct Options {
    let directory: URL
    let segmentSeconds: Double
    let width: Int
    let height: Int
    let fps: Int
    let bitRate: Int
    /** The ultra-wide camera when the phone has one (Zak, 9 Nov 2026). */
    let widest: Bool
  }

  struct Segment {
    let path: String
    let sequence: Int
    let startPtsNs: Int64
    let endPtsNs: Int64
    let frameCount: Int
    let byteLength: Int64
    let sha256: String
    let final: Bool
    let droppedFrames: Int
  }

  var onStarted: ((Int64, Int, Int, Int, String) -> Void)?
  /** Which camera module recorded: "ultrawide" or "wide". */
  private(set) var lens = "wide"
  var onSegment: ((Segment) -> Void)?
  var onError: ((String, String) -> Void)?
  var onStopped: (() -> Void)?

  let session: AVCaptureSession
  private let options: Options
  private let queue = DispatchQueue(label: "co.riseupai.recorder.capture", qos: .userInitiated)
  private let io = DispatchQueue(label: "co.riseupai.recorder.io", qos: .utility)
  private let output = AVCaptureVideoDataOutput()

  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var next: (AVAssetWriter, AVAssetWriterInput, URL)?
  private var path: URL?
  private var sequence = 0
  private var firstPts: CMTime = .invalid
  private var lastPts: CMTime = .invalid
  private var segmentStart: CMTime = .invalid
  private var boundary: CMTime = .positiveInfinity
  private var frames = 0
  private var dropped = 0
  private var stopping = false
  private var finished = false

  init(session: AVCaptureSession, options: Options) {
    self.session = session
    self.options = options
    super.init()
  }

  // MARK: start

  func start() {
    queue.async { [self] in
      do {
        try FileManager.default.createDirectory(at: options.directory,
                                                withIntermediateDirectories: true)
        try configureSession()
        next = try makeWriter(sequence: 0)
        session.startRunning()
      } catch {
        fail("ERR_CAMERA", "The camera could not start: \(error.localizedDescription)")
      }
    }
  }

  private func configureSession() throws {
    let ultraWide = options.widest
      ? AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back) : nil
    lens = ultraWide == nil ? "wide" : "ultrawide"
    guard let device = ultraWide ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video,
                                                            position: .back) else {
      throw NSError(domain: "RiseupRecorder", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No back camera."])
    }
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .inputPriority
    for existing in session.inputs { session.removeInput(existing) }
    for existing in session.outputs { session.removeOutput(existing) }

    let cameraInput = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(cameraInput) else {
      throw NSError(domain: "RiseupRecorder", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "The camera input was refused."])
    }
    session.addInput(cameraInput)

    // The format at the asked size that can run at the asked rate.
    let fps = Double(options.fps)
    let format = device.formats.first { f in
      let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
      return Int(d.width) == options.width && Int(d.height) == options.height
        && f.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= fps && fps <= $0.maxFrameRate }
    }
    try device.lockForConfiguration()
    if let format {
      device.activeFormat = format
    }
    let frame = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    device.activeVideoMinFrameDuration = frame
    device.activeVideoMaxFrameDuration = frame
    device.unlockForConfiguration()

    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ]
    // NEVER discard: a dropped frame is a hole in the match. A frame the
    // writer cannot take is counted instead (`dropped`).
    output.alwaysDiscardsLateVideoFrames = false
    output.setSampleBufferDelegate(self, queue: queue)
    guard session.canAddOutput(output) else {
      throw NSError(domain: "RiseupRecorder", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "The video output was refused."])
    }
    session.addOutput(output)
    if let connection = output.connection(with: .video) {
      // Upright for the way the phone is held NOW (the record screen locks
      // that for the match): landscape with the camera on either side.
      let left = Self.interfaceIsLandscapeLeft()
      if #available(iOS 17.0, *) {
        let angle: CGFloat = left ? 180 : 0
        if connection.isVideoRotationAngleSupported(angle) {
          connection.videoRotationAngle = angle
        }
      } else if connection.isVideoOrientationSupported {
        connection.videoOrientation = left ? .landscapeLeft : .landscapeRight
      }
    }
  }

  private func makeWriter(sequence: Int) throws -> (AVAssetWriter, AVAssetWriterInput, URL) {
    let url = options.directory.appendingPathComponent(
      String(format: "segment-%05d.mp4", sequence))
    try? FileManager.default.removeItem(at: url)
    let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let settings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: options.width,
      AVVideoHeightKey: options.height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: options.bitRate,
        AVVideoMaxKeyFrameIntervalKey: options.fps,
        AVVideoExpectedSourceFrameRateKey: options.fps,
      ],
    ]
    let i = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    i.expectsMediaDataInRealTime = true
    guard w.canAdd(i) else {
      throw NSError(domain: "RiseupRecorder", code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "The writer refused the video input."])
    }
    w.add(i)
    guard w.startWriting() else {
      throw w.error ?? NSError(domain: "RiseupRecorder", code: 5,
                               userInfo: [NSLocalizedDescriptionKey: "The writer would not start."])
    }
    return (w, i, url)
  }

  // MARK: the roll

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    if stopping || finished { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if !firstPts.isValid {
      firstPts = pts
      onStarted?(Int64(Date().timeIntervalSince1970 * 1000), options.width, options.height,
                 options.fps, lens)
    }
    do {
      if writer == nil {
        try roll(at: pts)
      } else if CMTimeCompare(pts, boundary) >= 0 {
        close(endingAt: pts, final: false)
        try roll(at: pts)
      }
    } catch {
      fail("ERR_WRITER", "A segment could not be opened: \(error.localizedDescription)")
      return
    }
    guard let input else { return }
    if input.isReadyForMoreMediaData {
      if input.append(sampleBuffer) {
        frames += 1
        lastPts = pts
      } else {
        dropped += 1
      }
    } else {
      dropped += 1
    }
  }

  func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    dropped += 1
  }

  private func roll(at pts: CMTime) throws {
    let prepared = try next ?? makeWriter(sequence: sequence)
    next = nil
    prepared.0.startSession(atSourceTime: pts)
    writer = prepared.0
    input = prepared.1
    path = prepared.2
    segmentStart = pts
    boundary = CMTimeAdd(pts, CMTime(seconds: options.segmentSeconds, preferredTimescale: 600))
    frames = 0
    // The next one, ready before it is needed.
    next = try makeWriter(sequence: sequence + 1)
  }

  private func close(endingAt end: CMTime, final: Bool) {
    guard let w = writer, let i = input, let url = path else { return }
    writer = nil
    input = nil
    let seq = sequence
    sequence += 1
    let startNs = nanos(CMTimeSubtract(segmentStart, firstPts))
    let endNs = nanos(CMTimeSubtract(end, firstPts))
    let count = frames
    let lost = dropped
    dropped = 0
    w.endSession(atSourceTime: end)
    i.markAsFinished()
    io.async { [self] in
      let done = DispatchSemaphore(value: 0)
      w.finishWriting { done.signal() }
      done.wait()
      guard w.status == .completed else {
        onError?("ERR_SEGMENT", "Segment \(seq) did not close: \(w.error?.localizedDescription ?? "unknown")")
        return
      }
      let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
      let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
      onSegment?(Segment(path: url.path, sequence: seq, startPtsNs: startNs, endPtsNs: endNs,
                         frameCount: count, byteLength: size,
                         sha256: Self.sha256(url), final: final, droppedFrames: lost))
    }
  }

  private func nanos(_ t: CMTime) -> Int64 {
    Int64((CMTimeGetSeconds(t) * 1_000_000_000).rounded())
  }

  // MARK: stop

  func stop() {
    queue.async { [self] in
      guard !finished else { return }
      stopping = true
      session.stopRunning()
      if writer != nil {
        let frame = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        close(endingAt: CMTimeAdd(lastPts, frame), final: true)
      }
      if let (w, _, url) = next {
        w.cancelWriting()
        try? FileManager.default.removeItem(at: url)
        next = nil
      }
      finish()
    }
  }

  private func fail(_ code: String, _ message: String) {
    onError?(code, message)
    stop()
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    output.setSampleBufferDelegate(nil, queue: nil)
    // After every queued close/hash/report, in order.
    io.async { [self] in onStopped?() }
  }

  /** The interface orientation, read on the main thread. */
  static func interfaceIsLandscapeLeft() -> Bool {
    let read = {
      (UIApplication.shared.connectedScenes.first as? UIWindowScene)?
        .interfaceOrientation == .landscapeLeft
    }
    return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
  }

  static func sha256(_ url: URL) -> String {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let data = handle.readData(ofLength: 1 << 20)
      if data.isEmpty { break }
      hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
