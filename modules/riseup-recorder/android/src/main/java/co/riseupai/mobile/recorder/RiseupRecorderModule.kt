package co.riseupai.mobile.recorder

import android.Manifest
import android.content.pm.PackageManager
import android.view.Surface
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JS face of `SegmentRecorder`: one recording at a time, events out.
 *
 * The preview is optional. A recording starts with whatever preview surface
 * the view has attached by then (`RecorderPreviewView`); without one the
 * camera feeds the encoder alone, which is enough to record a match.
 */
class RiseupRecorderModule : Module() {

  companion object {
    /** Set by the preview view when its surface exists; read at start. */
    @Volatile var previewSurface: Surface? = null
  }

  private var recorder: SegmentRecorder? = null
  private var state = "idle"
  private var startPromise: Promise? = null
  private var stopPromise: Promise? = null

  private fun setState(next: String) {
    state = next
    sendEvent("onState", mapOf("state" to next))
  }

  override fun definition() = ModuleDefinition {
    Name("RiseupRecorder")

    Events("onSegment", "onError", "onState", "onPaused", "onResumed")

    View(RecorderPreviewView::class) {}

    Function("getState") { state }

    AsyncFunction("requestPermission") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    AsyncFunction("start") { options: Map<String, Any?>, promise: Promise ->
      val context = appContext.reactContext
        ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready.", null)
      if (recorder != null) {
        throw CodedException("ERR_BUSY", "A recording is already running.", null)
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
          != PackageManager.PERMISSION_GRANTED) {
        throw CodedException("ERR_PERMISSION", "Camera permission has not been granted.", null)
      }
      val opts = SegmentRecorder.Options(
        directory = (options["directory"] as? String)?.removePrefix("file://")
          ?: throw CodedException("ERR_BAD_REQUEST", "directory is required.", null),
        segmentSeconds = (options["segmentSeconds"] as? Number)?.toDouble() ?: 60.0,
        width = (options["width"] as? Number)?.toInt() ?: 1920,
        height = (options["height"] as? Number)?.toInt() ?: 1080,
        fps = (options["fps"] as? Number)?.toInt() ?: 25,
        bitRate = (options["bitRate"] as? Number)?.toInt() ?: 16_000_000,
        widest = (options["widest"] as? Boolean) ?: true,
        codec = (options["codec"] as? String) ?: "hevc",
        sequenceStart = (options["sequenceStart"] as? Number)?.toInt() ?: 0,
        ptsOffsetNs = (options["ptsOffsetNs"] as? Number)?.toLong() ?: 0L,
      )
      startPromise = promise
      setState("starting")
      recorder = SegmentRecorder(context, opts, { previewSurface }, object : SegmentRecorder.Listener {
        override fun onStarted(startedAtMs: Long, width: Int, height: Int, fps: Int,
                               zoomRatio: Float, codec: String) {
          setState("recording")
          startPromise?.resolve(mapOf("startedAtMs" to startedAtMs, "width" to width,
                                      "height" to height, "fps" to fps,
                                      "lens" to if (zoomRatio < 1f) "ultrawide" else "wide",
                                      "zoomRatio" to zoomRatio.toDouble(),
                                      "codec" to codec))
          startPromise = null
        }

        override fun onSegment(segment: SegmentRecorder.Segment) {
          sendEvent("onSegment", mapOf(
            "path" to segment.path,
            "sequence" to segment.sequence,
            // Doubles on the bridge: exact to 2^53 ns, about 104 days.
            "startPtsNs" to segment.startPtsNs.toDouble(),
            "endPtsNs" to segment.endPtsNs.toDouble(),
            "frameCount" to segment.frameCount,
            "byteLength" to segment.byteLength.toDouble(),
            "sha256" to segment.sha256,
            "final" to segment.final,
            "droppedFrames" to segment.droppedFrames,
            "codec" to segment.codec,
            "bitRate" to segment.bitRate,
          ))
        }

        override fun onError(code: String, message: String) {
          sendEvent("onError", mapOf("code" to code, "message" to message))
          startPromise?.reject(code, message, null)
          startPromise = null
        }

        override fun onPaused(atNs: Long, reason: String) {
          setState("paused")
          sendEvent("onPaused", mapOf("atNs" to atNs.toDouble(), "reason" to reason))
        }

        override fun onResumed() {
          setState("recording")
          sendEvent("onResumed", mapOf<String, Any>())
        }

        override fun onStopped() {
          recorder = null
          setState("idle")
          startPromise?.reject("ERR_STOPPED", "The recording stopped before it started.", null)
          startPromise = null
          stopPromise?.resolve(null)
          stopPromise = null
        }
      })
      recorder?.start()
    }

    /** The phone left its casing (background, motion, operator): stop the
     * camera, close the segment non-final. No-op when not recording. */
    Function("pause") { reason: String ->
      recorder?.pause(reason)
    }

    /** Back in the casing: the next segment continues the session clock. */
    Function("resume") {
      recorder?.resume()
    }

    /**
     * Hand one file to the OS for upload (ChunkUploadWorker): it keeps going
     * with the app in the background and after a kill. Returns at once; the
     * outcome is `uploadStatus(id)`.
     */
    Function("enqueueUpload") { request: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready.", null)
      @Suppress("UNCHECKED_CAST")
      val headers = (request["headers"] as? Map<String, Any?>)
        ?.mapValues { it.value.toString() } ?: emptyMap()
      ChunkUploadWorker.enqueue(
        context,
        id = request["id"] as? String
          ?: throw CodedException("ERR_BAD_REQUEST", "id is required.", null),
        file = (request["file"] as? String)?.removePrefix("file://")
          ?: throw CodedException("ERR_BAD_REQUEST", "file is required.", null),
        url = request["url"] as? String
          ?: throw CodedException("ERR_BAD_REQUEST", "url is required.", null),
        method = request["method"] as? String ?: "PUT",
        headers = headers,
        label = request["label"] as? String ?: "Sending the match",
      )
    }

    /** "queued" | "uploading" | "done" | "retrying:<why>" | "failed:<why>" | null. */
    Function("uploadStatus") { id: String ->
      appContext.reactContext?.let { ChunkUploadWorker.status(it, id) }
    }

    Function("forgetUpload") { id: String ->
      appContext.reactContext?.let { ChunkUploadWorker.forget(it, id) }
    }

    /** The next segment's bitrate (the upload ladder); a no-op when idle. */
    Function("setBitRate") { bps: Int ->
      recorder?.setBitRate(bps)
    }

    AsyncFunction("stop") { promise: Promise ->
      val r = recorder
      if (r == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      stopPromise = promise
      setState("stopping")
      r.stop()
    }
  }
}
