import Foundation

/**
 * Recorded chunks, PUT by iOS itself (a background URLSession), not by the app.
 *
 * A background session's transfers continue while RiseUp is suspended, and
 * even after it is terminated: the system finishes them and relaunches the
 * app in the background to deliver the result. Nothing here needs the API or
 * a Clerk token -- the server confirms a chunk itself (it HEADs the object; R2
 * enforces the signed SHA-256 at write time). The outcome per chunk is kept in
 * UserDefaults for the app to read on its next run.
 *
 * Mirrors ChunkUploadWorker.kt (Android). Status strings are the same.
 */
final class BackgroundUploader: NSObject, URLSessionTaskDelegate {
  static let shared = BackgroundUploader()
  static let identifier = "co.riseupai.mobile.recorder.uploads"
  private static let defaultsKey = "riseup.recorder.uploads"

  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    config.isDiscretionary = false          // a match is never "whenever convenient"
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = true      // venues are on 4G/5G as often as Wi-Fi
    config.httpMaximumConnectionsPerHost = 1  // oldest chunk first, as Android does
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()

  /** Set by the app delegate hook when iOS relaunches the app for this
   * session; called once every event has been delivered. */
  var backgroundCompletion: (() -> Void)?

  func enqueue(id: String, file: URL, url: URL, method: String, headers: [String: String]) {
    var request = URLRequest(url: url)
    request.httpMethod = method
    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
    let task = session.uploadTask(with: request, fromFile: file)
    task.taskDescription = id
    record(id, "queued")
    task.resume()
  }

  func status(_ id: String) -> String? {
    (UserDefaults.standard.dictionary(forKey: Self.defaultsKey) as? [String: String])?[id]
  }

  func forget(_ id: String) {
    var all = (UserDefaults.standard.dictionary(forKey: Self.defaultsKey) as? [String: String]) ?? [:]
    all.removeValue(forKey: id)
    UserDefaults.standard.set(all, forKey: Self.defaultsKey)
  }

  private func record(_ id: String, _ status: String) {
    var all = (UserDefaults.standard.dictionary(forKey: Self.defaultsKey) as? [String: String]) ?? [:]
    all[id] = status
    UserDefaults.standard.set(all, forKey: Self.defaultsKey)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription else { return }
    if let error {
      // The system retries transient failures of a background upload itself
      // before reporting; what reaches here is final for this task.
      record(id, "failed:network:\((error as NSError).code)")
      return
    }
    let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    record(id, (200...299).contains(code) ? "done" : "failed:\(code)")
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async { [self] in
      backgroundCompletion?()
      backgroundCompletion = nil
    }
  }
}
