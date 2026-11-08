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
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
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
 * PAUSE (Zak, 9 Nov 2026: a phone pulled from its casing pauses). The camera
 * stops and the encoder drains; the open segment closes NOT final. Resume
 * opens camera and encoder again and carries on with the next sequence on the
 * SAME session clock: sensor timestamps are monotonic across the pause, so
 * the next segment starts where the pause ended and the gap is a number the
 * server can declare, not a guess. Android also takes the camera away from a
 * backgrounded app; that arrives as a disconnect and is treated as a pause.
 *
 * THREADS. Camera and codec callbacks run on one HandlerThread, so the roll
 * logic never races itself. Closing a file, hashing it and reporting it run
 * on a single-thread executor, in order, so a 150 MB SHA-256 never stalls the
 * encoder.
 */
class SegmentRecorder(
  private val context: Context,
  private val options: Options,
  /** Read at every (re)start: the preview view's surface is recreated when the
   * app comes back from the background. */
  private val previewSurface: () -> Surface?,
  private val listener: Listener,
) {
  data class Options(
    val directory: String,
    val segmentSeconds: Double,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitRate: Int,
    /** The widest field of view the camera offers (the ultra-wide module on
     * a phone that has one): a match needs the whole pitch (Zak, 9 Nov 2026). */
    val widest: Boolean = true,
    /** "hevc" (default) or "h264". HEVC gives the same picture at about half
     * the bits; a phone without an HEVC encoder falls back to H.264 and says
     * so (Zak, 9 Nov 2026). */
    val codec: String = "hevc",
    /** Continuing a session after the app was killed: the first segment's
     * number, and where this recorder's clock zero sits on the session clock
     * (wall-clock based, so approximate; the app declares the gap). */
    val sequenceStart: Int = 0,
    val ptsOffsetNs: Long = 0,
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
    /** What THIS segment was encoded with. */
    val codec: String,
    val bitRate: Int,
  )

  interface Listener {
    fun onStarted(startedAtMs: Long, width: Int, height: Int, fps: Int, zoomRatio: Float,
                  codec: String)
    fun onSegment(segment: Segment)
    fun onError(code: String, message: String)
    /** The camera stopped; the last segment closed (not final). `atNs` is the
     * session-clock end of that segment. */
    fun onPaused(atNs: Long, reason: String)
    /** The camera is back; the next segment starts on the same clock. */
    fun onResumed()
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
  private var sequence = options.sequenceStart
  private var segmentStartUs = -1L
  private var segmentFrames = 0
  private var firstPtsUs = -1L
  private var lastPtsUs = -1L
  private var nextBoundaryUs = Long.MAX_VALUE
  private var syncRequested = false
  private var droppedBeforeKeyframe = 0
  private var finished = false
  /** Draining towards a pause (the EOS closes the segment non-final). */
  private var pausing = false
  private var paused = false
  private var pauseReason = ""
  private var cameraId = ""
  private var characteristics: CameraCharacteristics? = null
  /** 1.0 unless the widest lens was selected through the zoom ratio. */
  private var zoomRatio = 1f
  /** "hevc" or "h264": what the encoder actually is. */
  private var codecName = "h264"
  /** The rate the current segment is encoded at, and the one the next
   * segment will be (`setBitRate`); applied at the roll so every segment has
   * one rate. */
  private var bitRate = options.bitRate
  @Volatile private var pendingBitRate = options.bitRate

  private val segmentUs: Long get() = (options.segmentSeconds * 1_000_000).toLong()
  private val frameUs: Long get() = 1_000_000L / options.fps.coerceAtLeast(1)

  // ── start ────────────────────────────────────────────────────────────────

  fun start() {
    File(options.directory).mkdirs()
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    cameraId = manager.cameraIdList.firstOrNull { id ->
      manager.getCameraCharacteristics(id)
        .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
    } ?: return fail("ERR_NO_CAMERA", "This device has no back camera.")
    openEncoderAndCamera()
  }

  /** Encoder, then camera. The first start and every resume. */
  @SuppressLint("MissingPermission") // checked by the module before construction
  private fun openEncoderAndCamera() {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val characteristics = manager.getCameraCharacteristics(cameraId)
    this.characteristics = characteristics
    orientationHint = orientation(characteristics)

    try {
      val mime = if (options.codec == "hevc" && hasEncoder(MediaFormat.MIMETYPE_VIDEO_HEVC))
        MediaFormat.MIMETYPE_VIDEO_HEVC else MediaFormat.MIMETYPE_VIDEO_AVC
      codecName = if (mime == MediaFormat.MIMETYPE_VIDEO_HEVC) "hevc" else "h264"
      val c = MediaCodec.createEncoderByType(mime)
      val format = MediaFormat.createVideoFormat(mime, options.width, options.height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT,
                   MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, pendingBitRate)
        setInteger(MediaFormat.KEY_FRAME_RATE, options.fps)
        // 1 s GOP: a boundary is never more than a second from a keyframe even
        // if the explicit request below is ignored by an encoder.
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        // CBR where the encoder has it: the upload ladder plans on the rate
        // it set, and VBR can overshoot it by a lot on a busy pitch.
        val caps = c.codecInfo.getCapabilitiesForType(mime).encoderCapabilities
        if (caps.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)) {
          setInteger(MediaFormat.KEY_BITRATE_MODE,
                     MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
        }
      }
      c.setCallback(codecCallback, handler)
      c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      inputSurface = c.createInputSurface()
      c.start()
      codec = c
      bitRate = pendingBitRate
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
          // The app went to the background (Android takes the camera away)
          // or another app took it: a pause, not the end of the match.
          device.close()
          camera = null
          pauseInternal("camera_lost")
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
    val targets = listOfNotNull(inputSurface, previewSurface())
    device.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
      override fun onConfigured(s: CameraCaptureSession) {
        session = s
        val request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
          targets.forEach { addTarget(it) }
          fpsRange(characteristics)?.let { set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
          widestZoom(characteristics)?.let {
            set(CaptureRequest.CONTROL_ZOOM_RATIO, it)
            zoomRatio = it
          }
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

  /** A fixed range at the asked rate when the camera has one, else the
   * tightest range containing it. A variable rate would let the frame times
   * drift from the nominal fps. (Without this the Pixel 8a, which has no
   * fixed 25 fps range, silently ran at 30 while the encoder was told 25.) */
  private fun fpsRange(c: CameraCharacteristics): Range<Int>? {
    val ranges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return null
    return ranges.firstOrNull { it.lower == options.fps && it.upper == options.fps }
      ?: ranges.filter { it.lower <= options.fps && options.fps <= it.upper }
        .minByOrNull { it.upper - it.lower }
  }

  /** A hardware-or-software encoder for `mime` at this size and rate. */
  private fun hasEncoder(mime: String): Boolean {
    val format = MediaFormat.createVideoFormat(mime, options.width, options.height).apply {
      setInteger(MediaFormat.KEY_FRAME_RATE, options.fps)
    }
    return MediaCodecList(MediaCodecList.REGULAR_CODECS).findEncoderForFormat(format) != null
  }

  /** The rate for the NEXT segment (the upload ladder). Applied at the roll. */
  fun setBitRate(bps: Int) {
    pendingBitRate = bps
  }

  /** The lowest zoom ratio of a logical camera, which is its ultra-wide
   * module (API 30+). Null when not asked, not supported, or already 1x. */
  private fun widestZoom(c: CameraCharacteristics): Float? {
    if (!options.widest || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    val range = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) ?: return null
    return range.lower.takeIf { it < 1f }
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
        listener.onStarted(System.currentTimeMillis(), options.width, options.height, options.fps,
                           zoomRatio, codecName)
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
      if (pausing) {
        val endUs = lastPtsUs + frameUs
        if (muxer != null) {
          closeSegment(endPtsUs = endUs, final = false)
        }
        releaseEncoder()
        pausing = false
        paused = true
        val atNs = if (firstPtsUs >= 0) (endUs - firstPtsUs) * 1000 + options.ptsOffsetNs else 0L
        io.execute { listener.onPaused(atNs, pauseReason) }
        return
      }
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
    if (pendingBitRate != bitRate) {
      codec?.setParameters(Bundle().apply {
        putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, pendingBitRate)
      })
      bitRate = pendingBitRate
    }
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
    val startNs = (segmentStartUs - firstPtsUs) * 1000 + options.ptsOffsetNs
    val endNs = (endPtsUs - firstPtsUs) * 1000 + options.ptsOffsetNs
    val frames = segmentFrames
    val dropped = if (seg == 0) droppedBeforeKeyframe else 0
    val rate = bitRate
    val codecUsed = codecName
    sequence++
    io.execute {
      try {
        m.stop()
        m.release()
        val file = File(closedPath)
        listener.onSegment(Segment(closedPath, seg, startNs, endNs, frames, file.length(),
                                   sha256(file), final, dropped, codecUsed, rate))
      } catch (e: Exception) {
        listener.onError("ERR_SEGMENT", "Segment $seg could not be closed: ${e.message}")
      }
    }
  }

  // ── pause / resume ───────────────────────────────────────────────────────

  /** Stop the camera and close the open segment, NOT final. */
  fun pause(reason: String) {
    handler.post { pauseInternal(reason) }
  }

  private fun pauseInternal(reason: String) {
    if (finished || paused || pausing) return
    pauseReason = reason
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
      paused = true
      io.execute { listener.onPaused(0L, reason) }
      return
    }
    pausing = true
    try {
      c.signalEndOfInputStream()
    } catch (e: Exception) {
      // The encoder is gone: close what was written and call it paused.
      val endUs = lastPtsUs + frameUs
      if (muxer != null) {
        closeSegment(endPtsUs = endUs, final = false)
      }
      releaseEncoder()
      pausing = false
      paused = true
      io.execute { listener.onPaused((endUs - firstPtsUs).coerceAtLeast(0) * 1000, reason) }
    }
  }

  /** Camera and encoder again; the next segment continues the sequence. */
  fun resume() {
    handler.post {
      if (finished || !paused) return@post
      paused = false
      io.execute { listener.onResumed() }
      openEncoderAndCamera()
    }
  }

  private fun releaseEncoder() {
    try {
      codec?.stop()
    } catch (_: Exception) {
    }
    codec?.release()
    codec = null
    inputSurface?.release()
    inputSurface = null
    outputFormat = null
  }

  // ── stop ─────────────────────────────────────────────────────────────────

  /** Stop the camera and drain the encoder; the final segment follows. A
   * stop while paused ends here: the pause already closed the last segment. */
  fun stop() {
    handler.post {
      if (paused) {
        finish()
        return@post
      }
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
    releaseEncoder()
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
