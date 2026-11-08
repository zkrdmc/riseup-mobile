package co.riseupai.mobile.recorder

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.view.Surface
import android.view.WindowManager
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * One match, recorded as gapless segments.
 *
 * ONE ENCODER FOR THE WHOLE MATCH. The camera feeds a single H.264 MediaCodec
 * through its input surface; only the MUXER changes. At the first keyframe
 * whose PTS is at or past the segment boundary, the current file is closed
 * and a new one starts with that keyframe. Every encoded frame goes into
 * exactly one file, and segment N ends at the PTS where segment N+1 begins:
 * the chunk contract's 2 ms join holds by construction, not by luck.
 *
 * A keyframe is requested as soon as a boundary passes (and the GOP is 1 s
 * regardless), so a segment overruns its target by at most a frame or two.
 *
 * THE CLOCK. PTS come from the camera's sensor timestamps through the input
 * surface. The session clock's zero is the first encoded frame, and every
 * segment's times are on it, so a gap anywhere is visible as numbers that do
 * not abut.
 *
 * THREADS. Camera and codec callbacks run on one HandlerThread, so the roll
 * logic never races itself. Closing a file, hashing it and reporting it run
 * on a single-thread executor, in order, so a 150 MB SHA-256 never stalls the
 * encoder.
 */
class SegmentRecorder(
  private val context: Context,
  private val options: Options,
  private val previewSurface: Surface?,
  private val listener: Listener,
) {
  data class Options(
    val directory: String,
    val segmentSeconds: Double,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitRate: Int,
  )

  data class Segment(
    val path: String,
    val sequence: Int,
    val startPtsNs: Long,
    val endPtsNs: Long,
    val frameCount: Int,
    val byteLength: Long,
    val sha256: String,
    val final: Boolean,
    val droppedFrames: Int,
  )

  interface Listener {
    fun onStarted(startedAtMs: Long, width: Int, height: Int, fps: Int)
    fun onSegment(segment: Segment)
    fun onError(code: String, message: String)
    /** After the final segment was reported, or after a failure. */
    fun onStopped()
  }

  private val thread = HandlerThread("riseup-recorder").also { it.start() }
  private val handler = Handler(thread.looper)
  private val io = Executors.newSingleThreadExecutor()

  private var camera: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var codec: MediaCodec? = null
  private var inputSurface: Surface? = null
  private var outputFormat: MediaFormat? = null
  private var orientationHint = 0

  private var muxer: MediaMuxer? = null
  private var track = -1
  private var path: String = ""
  private var sequence = 0
  private var segmentStartUs = -1L
  private var segmentFrames = 0
  private var firstPtsUs = -1L
  private var lastPtsUs = -1L
  private var nextBoundaryUs = Long.MAX_VALUE
  private var syncRequested = false
  private var droppedBeforeKeyframe = 0
  private var finished = false

  private val segmentUs: Long get() = (options.segmentSeconds * 1_000_000).toLong()
  private val frameUs: Long get() = 1_000_000L / options.fps.coerceAtLeast(1)

  // ── start ────────────────────────────────────────────────────────────────

  @SuppressLint("MissingPermission") // checked by the module before construction
  fun start() {
    File(options.directory).mkdirs()
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val cameraId = manager.cameraIdList.firstOrNull { id ->
      manager.getCameraCharacteristics(id)
        .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
    } ?: return fail("ERR_NO_CAMERA", "This device has no back camera.")
    val characteristics = manager.getCameraCharacteristics(cameraId)
    orientationHint = orientation(characteristics)

    try {
      val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC,
                                                 options.width, options.height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT,
                   MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, options.bitRate)
        setInteger(MediaFormat.KEY_FRAME_RATE, options.fps)
        // 1 s GOP: a boundary is never more than a second from a keyframe even
        // if the explicit request below is ignored by an encoder.
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      }
      val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      c.setCallback(codecCallback, handler)
      c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      inputSurface = c.createInputSurface()
      c.start()
      codec = c
    } catch (e: Exception) {
      return fail("ERR_ENCODER", "The video encoder would not start: ${e.message}")
    }

    try {
      manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
        override fun onOpened(device: CameraDevice) {
          camera = device
          openSession(device, characteristics)
        }
        override fun onDisconnected(device: CameraDevice) {
          device.close()
          stopInternal("ERR_CAMERA_DISCONNECTED", "The camera was taken by another app.")
        }
        override fun onError(device: CameraDevice, error: Int) {
          device.close()
          stopInternal("ERR_CAMERA", "The camera failed (code $error).")
        }
      }, handler)
    } catch (e: Exception) {
      fail("ERR_CAMERA", "The camera would not open: ${e.message}")
    }
  }

  @Suppress("DEPRECATION") // createCaptureSession(List) is fine down to API 24
  private fun openSession(device: CameraDevice, characteristics: CameraCharacteristics) {
    val targets = listOfNotNull(inputSurface, previewSurface)
    device.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
      override fun onConfigured(s: CameraCaptureSession) {
        session = s
        val request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
          targets.forEach { addTarget(it) }
          fpsRange(characteristics)?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
        }
        try {
          s.setRepeatingRequest(request.build(), null, handler)
        } catch (e: Exception) {
          stopInternal("ERR_CAMERA", "The camera would not stream: ${e.message}")
        }
      }
      override fun onConfigureFailed(s: CameraCaptureSession) {
        stopInternal("ERR_CAMERA", "The camera refused the recording configuration " +
                                   "(${options.width}x${options.height} @ ${options.fps} fps).")
      }
    }, handler)
  }

  /** A fixed range at the asked rate when the camera has one: a variable
   * rate would let the encoder's frame times drift from the nominal fps. */
  private fun fpsRange(c: CameraCharacteristics): Range<Int>? {
    val ranges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return null
    return ranges.firstOrNull { it.lower == options.fps && it.upper == options.fps }
      ?: ranges.filter { it.upper == options.fps }.maxByOrNull { it.lower }
  }

  /** How the stored frames must be rotated for display, for the phone held
   * the way it is now (the record screen is landscape). */
  private fun orientation(c: CameraCharacteristics): Int {
    val sensor = c.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
    @Suppress("DEPRECATION")
    val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
      .defaultDisplay.rotation
    val device = when (rotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
    return (sensor - device + 360) % 360
  }

  // ── the roll ─────────────────────────────────────────────────────────────

  private val codecCallback = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
      // Surface input: the camera fills the encoder, never this.
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
      outputFormat = format
    }

    override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      try {
        handleOutput(codec, index, info)
      } catch (e: Exception) {
        stopInternal("ERR_MUXER", "Writing a segment failed: ${e.message}")
      }
    }

    override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
      stopInternal("ERR_ENCODER", "The video encoder failed: ${e.diagnosticInfo}")
    }
  }

  private fun handleOutput(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
    val buffer = codec.getOutputBuffer(index)
    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
    if (buffer != null && info.size > 0 && !config) {
      val pts = info.presentationTimeUs
      val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
      if (firstPtsUs < 0) {
        firstPtsUs = pts
        nextBoundaryUs = pts + segmentUs
        listener.onStarted(System.currentTimeMillis(), options.width, options.height, options.fps)
      }
      when {
        muxer == null && !key -> droppedBeforeKeyframe++    // a file must open on a keyframe
        muxer == null -> openSegment(pts)
        key && pts >= nextBoundaryUs -> {
          closeSegment(endPtsUs = pts, final = false)
          openSegment(pts)
        }
        pts >= nextBoundaryUs && !syncRequested -> {
          codec.setParameters(Bundle().apply {
            putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
          })
          syncRequested = true
        }
      }
      muxer?.let {
        buffer.position(info.offset)
        buffer.limit(info.offset + info.size)
        it.writeSampleData(track, buffer, info)
        segmentFrames++
        lastPtsUs = pts
      }
    }
    codec.releaseOutputBuffer(index, false)
    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
      if (muxer != null) {
        closeSegment(endPtsUs = lastPtsUs + frameUs, final = true)
      }
      finish()
    }
  }

  private fun openSegment(ptsUs: Long) {
    val format = outputFormat ?: throw IllegalStateException("no encoder format yet")
    path = File(options.directory, "segment-%05d.mp4".format(sequence)).absolutePath
    val m = MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    m.setOrientationHint(orientationHint)
    track = m.addTrack(format)
    m.start()
    muxer = m
    segmentStartUs = ptsUs
    segmentFrames = 0
    nextBoundaryUs = ptsUs + segmentUs
    syncRequested = false
  }

  private fun closeSegment(endPtsUs: Long, final: Boolean) {
    val m = muxer ?: return
    muxer = null
    val closedPath = path
    val seg = sequence
    val startNs = (segmentStartUs - firstPtsUs) * 1000
    val endNs = (endPtsUs - firstPtsUs) * 1000
    val frames = segmentFrames
    val dropped = if (seg == 0) droppedBeforeKeyframe else 0
    sequence++
    io.execute {
      try {
        m.stop()
        m.release()
        val file = File(closedPath)
        listener.onSegment(Segment(closedPath, seg, startNs, endNs, frames, file.length(),
                                   sha256(file), final, dropped))
      } catch (e: Exception) {
        listener.onError("ERR_SEGMENT", "Segment $seg could not be closed: ${e.message}")
      }
    }
  }

  // ── stop ─────────────────────────────────────────────────────────────────

  /** Stop the camera and drain the encoder; the final segment follows. */
  fun stop() {
    handler.post {
      try {
        session?.stopRepeating()
      } catch (_: Exception) {
      }
      session?.close()
      session = null
      camera?.close()
      camera = null
      val c = codec
      if (c == null) {
        finish()
        return@post
      }
      try {
        c.signalEndOfInputStream()
      } catch (e: Exception) {
        // The encoder is gone: close what was written so far and report it.
        if (muxer != null) {
          closeSegment(endPtsUs = lastPtsUs + frameUs, final = true)
        }
        finish()
      }
    }
  }

  private fun stopInternal(code: String, message: String) {
    if (finished) return
    listener.onError(code, message)
    stop()
  }

  private fun fail(code: String, message: String) {
    listener.onError(code, message)
    finish()
  }

  private fun finish() {
    if (finished) return
    finished = true
    try {
      codec?.stop()
    } catch (_: Exception) {
    }
    codec?.release()
    codec = null
    inputSurface?.release()
    inputSurface = null
    // After every queued close/hash/report, in order.
    io.execute { listener.onStopped() }
    io.shutdown()
    thread.quitSafely()
  }

  companion object {
    fun sha256(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(file).use { input ->
        val buf = ByteArray(1 shl 20)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          digest.update(buf, 0, n)
        }
      }
      return digest.digest().joinToString("") { "%02x".format(it) }
    }
  }
}
