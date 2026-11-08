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

    Events("onSegment", "onError", "onState")

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
      )
      startPromise = promise
      setState("starting")
      recorder = SegmentRecorder(context, opts, previewSurface, object : SegmentRecorder.Listener {
        override fun onStarted(startedAtMs: Long, width: Int, height: Int, fps: Int,
                               zoomRatio: Float) {
          setState("recording")
          startPromise?.resolve(mapOf("startedAtMs" to startedAtMs, "width" to width,
                                      "height" to height, "fps" to fps,
                                      "lens" to if (zoomRatio < 1f) "ultrawide" else "wide",
                                      "zoomRatio" to zoomRatio.toDouble()))
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
          ))
        }

        override fun onError(code: String, message: String) {
          sendEvent("onError", mapOf("code" to code, "message" to message))
          startPromise?.reject(code, message, null)
          startPromise = null
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
