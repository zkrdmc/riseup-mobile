package co.riseupai.mobile.vision

import android.graphics.BitmapFactory
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.calib3d.Calib3d
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.core.MatOfPoint2f
import org.opencv.core.MatOfPoint3f
import org.opencv.core.Point
import org.opencv.core.Point3
import org.opencv.core.Size
import org.opencv.core.TermCriteria
import org.opencv.imgproc.Imgproc
import java.io.File
import kotlin.math.sqrt

/**
 * OpenCV calib3d for Android.
 *
 * INITIALISATION IS NOT AUTOMATIC. `OpenCVLoader.initLocal()` loads the native
 * library, and any OpenCV call made before it succeeds crashes in native code
 * with no Java stack to read. It is done once, lazily, and a failure is
 * reported as a coded error here rather than left to surface later as an
 * unrelated segfault in a function that looks unrelated.
 */
class RiseupVisionModule : Module() {

  private var openCvReady: Boolean? = null

  private fun ensureOpenCv() {
    if (openCvReady == null) {
      openCvReady = OpenCVLoader.initLocal()
    }
    if (openCvReady != true) {
      throw CodedException(
        "ERR_OPENCV_INIT",
        "OpenCV failed to load. Without it the app cannot calibrate a lens or solve a homography.",
        null,
      )
    }
  }

  override fun definition() = ModuleDefinition {
    Name("RiseupVision")

    Function("getOpenCvVersion") {
      ensureOpenCv()
      Core.VERSION
    }

    AsyncFunction("findChessboardCorners") { request: Map<String, Any?> ->
      ensureOpenCv()

      val uri = request["imageUri"] as String
      val cols = (request["patternCols"] as Number).toInt()
      val rows = (request["patternRows"] as Number).toInt()

      val gray = loadGrayscale(uri)
      val corners = MatOfPoint2f()

      // ADAPTIVE_THRESH is what makes this work on a photograph taken beside a
      // pitch rather than in a lab: the board will be lit unevenly and a global
      // threshold finds nothing at all. NORMALIZE_IMAGE copes with the exposure
      // spread across a frame shot into low winter sun.
      val flags = Calib3d.CALIB_CB_ADAPTIVE_THRESH or
        Calib3d.CALIB_CB_NORMALIZE_IMAGE or
        Calib3d.CALIB_CB_FAST_CHECK

      val found = Calib3d.findChessboardCorners(
        gray,
        Size(cols.toDouble(), rows.toDouble()),
        corners,
        flags,
      )

      var minX = 0.0
      var minY = 0.0
      var maxX = 0.0
      var maxY = 0.0
      val points = mutableListOf<Map<String, Double>>()

      if (found) {
        // Sub-pixel refinement. Without it corners land on integer pixels, and
        // half a pixel of noise per observation propagates directly into the
        // distortion coefficients — the one quantity this whole exercise is for.
        Imgproc.cornerSubPix(
          gray,
          corners,
          Size(11.0, 11.0),
          Size(-1.0, -1.0),
          TermCriteria(TermCriteria.EPS + TermCriteria.MAX_ITER, 30, 0.001),
        )

        val list = corners.toList()
        minX = list.minOf { it.x }
        maxX = list.maxOf { it.x }
        minY = list.minOf { it.y }
        maxY = list.maxOf { it.y }
        list.forEach { points.add(mapOf("x" to it.x, "y" to it.y)) }
      }

      val width = gray.cols()
      val height = gray.rows()
      val coverage = if (found && width > 0 && height > 0) {
        ((maxX - minX) * (maxY - minY)) / (width.toDouble() * height.toDouble())
      } else {
        0.0
      }

      gray.release()
      corners.release()

      mapOf(
        "found" to found,
        "corners" to points,
        "imageWidth" to width,
        "imageHeight" to height,
        "coverageFraction" to coverage,
        "boundsMinX" to minX,
        "boundsMinY" to minY,
        "boundsMaxX" to maxX,
        "boundsMaxY" to maxY,
      )
    }

    AsyncFunction("calibrateCamera") { request: Map<String, Any?> ->
      ensureOpenCv()

      val cols = (request["patternCols"] as Number).toInt()
      val rows = (request["patternRows"] as Number).toInt()
      val squareSizeMm = (request["squareSizeMm"] as Number).toDouble()
      val imageWidth = (request["imageWidth"] as Number).toInt()
      val imageHeight = (request["imageHeight"] as Number).toInt()

      @Suppress("UNCHECKED_CAST")
      val views = request["views"] as List<List<Map<String, Any?>>>
      if (views.size < 3) {
        throw CodedException(
          "ERR_TOO_FEW_VIEWS",
          "A calibration needs at least three views. PRD 4.3 asks for 12 to 20.",
          null,
        )
      }

      // The board in its own frame: planar, z = 0, in millimetres. Identical
      // for every view, because the board does not change — only the camera's
      // pose relative to it does.
      val objectPoint = MatOfPoint3f()
      val boardPoints = mutableListOf<Point3>()
      for (r in 0 until rows) {
        for (c in 0 until cols) {
          boardPoints.add(Point3(c * squareSizeMm, r * squareSizeMm, 0.0))
        }
      }
      objectPoint.fromList(boardPoints)

      val objectPoints = mutableListOf<Mat>()
      val imagePoints = mutableListOf<Mat>()
      views.forEach { view ->
        val mat = MatOfPoint2f()
        mat.fromList(
          view.map { Point((it["x"] as Number).toDouble(), (it["y"] as Number).toDouble()) },
        )
        imagePoints.add(mat)
        objectPoints.add(objectPoint)
      }

      val cameraMatrix = Mat.eye(3, 3, CvType.CV_64F)
      val distCoeffs = MatOfDouble()
      val rvecs = mutableListOf<Mat>()
      val tvecs = mutableListOf<Mat>()

      val rms = Calib3d.calibrateCamera(
        objectPoints,
        imagePoints,
        Size(imageWidth.toDouble(), imageHeight.toDouble()),
        cameraMatrix,
        distCoeffs,
        rvecs,
        tvecs,
      )

      // Per-view reprojection error, so one bad photograph can be named and
      // retaken instead of quietly degrading the whole solve.
      val perViewErrors = mutableListOf<Double>()
      for (i in views.indices) {
        val projected = MatOfPoint2f()
        Calib3d.projectPoints(
          MatOfPoint3f(objectPoints[i]),
          rvecs[i],
          tvecs[i],
          cameraMatrix,
          distCoeffs,
          projected,
        )
        val observed = (imagePoints[i] as MatOfPoint2f).toList()
        val reprojected = projected.toList()
        var sum = 0.0
        for (j in observed.indices) {
          val dx = observed[j].x - reprojected[j].x
          val dy = observed[j].y - reprojected[j].y
          sum += dx * dx + dy * dy
        }
        perViewErrors.add(if (observed.isNotEmpty()) sqrt(sum / observed.size) else 0.0)
        projected.release()
      }

      val k = DoubleArray(9)
      cameraMatrix.get(0, 0, k)
      // Straight out of calibrateCamera, so these are ALREADY in OpenCV order:
      // [k1, k2, p1, p2, k3]. Nothing here reorders them, which is exactly the
      // point of solving with OpenCV rather than assembling a vector by hand.
      val d = distCoeffs.toArray().toList()

      cameraMatrix.release()
      distCoeffs.release()
      objectPoint.release()
      imagePoints.forEach { it.release() }
      rvecs.forEach { it.release() }
      tvecs.forEach { it.release() }

      mapOf(
        "cameraMatrix" to k.toList(),
        "distCoeffs" to d,
        "rmsReprojectionError" to rms,
        "perViewErrors" to perViewErrors,
      )
    }

    AsyncFunction("findHomography") { request: Map<String, Any?> ->
      ensureOpenCv()

      @Suppress("UNCHECKED_CAST")
      val src = request["src"] as List<Map<String, Any?>>
      @Suppress("UNCHECKED_CAST")
      val dst = request["dst"] as List<Map<String, Any?>>
      val threshold = (request["ransacThresholdPx"] as Number).toDouble()

      if (src.size < 4 || src.size != dst.size) {
        throw CodedException(
          "ERR_BAD_CORRESPONDENCES",
          "A homography needs at least four matched points, and both lists must be the same length.",
          null,
        )
      }

      val srcMat = MatOfPoint2f()
      srcMat.fromList(src.map { Point((it["x"] as Number).toDouble(), (it["y"] as Number).toDouble()) })
      val dstMat = MatOfPoint2f()
      dstMat.fromList(dst.map { Point((it["x"] as Number).toDouble(), (it["y"] as Number).toDouble()) })

      val mask = Mat()
      // RANSAC once there are more than the minimum four points: it is what
      // survives one mis-tapped corner, and a volunteer tapping pitch corners
      // in the dark will mis-tap one. With exactly four there is nothing to
      // vote with, so an exact solve is the honest answer.
      val h = if (src.size > 4) {
        Calib3d.findHomography(srcMat, dstMat, Calib3d.RANSAC, threshold, mask)
      } else {
        Calib3d.findHomography(srcMat, dstMat)
      }

      if (h.empty()) {
        throw CodedException(
          "ERR_HOMOGRAPHY_FAILED",
          "Those points do not describe a view of the pitch. Three of them may be in a straight " +
            "line, or two may be the same point.",
          null,
        )
      }

      val hv = DoubleArray(9)
      h.get(0, 0, hv)

      val inliers = if (mask.empty()) {
        List(src.size) { true }
      } else {
        val m = ByteArray(mask.rows())
        mask.get(0, 0, m)
        m.map { it.toInt() != 0 }
      }

      srcMat.release()
      dstMat.release()
      h.release()
      mask.release()

      mapOf("h" to hv.toList(), "inliers" to inliers)
    }

    AsyncFunction("undistortPoints") { request: Map<String, Any?> ->
      ensureOpenCv()

      @Suppress("UNCHECKED_CAST")
      val points = request["points"] as List<Map<String, Any?>>
      @Suppress("UNCHECKED_CAST")
      val kList = request["cameraMatrix"] as List<Number>
      @Suppress("UNCHECKED_CAST")
      val dList = request["distCoeffs"] as List<Number>

      val src = MatOfPoint2f()
      src.fromList(points.map { Point((it["x"] as Number).toDouble(), (it["y"] as Number).toDouble()) })

      val k = Mat(3, 3, CvType.CV_64F)
      k.put(0, 0, kList.map { it.toDouble() }.toDoubleArray())
      val d = MatOfDouble()
      d.fromList(dList.map { it.toDouble() })
      val out = MatOfPoint2f()

      // Passing K again as the new camera matrix returns PIXELS. Omitting it is
      // the classic mistake: the call succeeds and returns values near zero,
      // which look like a catastrophic failure and are in fact normalised
      // camera coordinates.
      Calib3d.undistortPoints(src, out, k, d, Mat(), k)

      val result = out.toList().map { mapOf("x" to it.x, "y" to it.y) }
      src.release()
      k.release()
      d.release()
      out.release()
      result
    }
  }

  private fun loadGrayscale(uri: String): Mat {
    val path = if (uri.startsWith("file://")) Uri.parse(uri).path else uri
    if (path == null || !File(path).exists()) {
      throw CodedException("ERR_IMAGE_NOT_FOUND", "Could not read the image at $uri.", null)
    }
    val bitmap = BitmapFactory.decodeFile(path)
      ?: throw CodedException(
        "ERR_IMAGE_DECODE",
        "That file is not an image this device can read.",
        null,
      )

    val rgba = Mat()
    Utils.bitmapToMat(bitmap, rgba)
    val gray = Mat()
    Imgproc.cvtColor(rgba, gray, Imgproc.COLOR_RGBA2GRAY)
    rgba.release()
    bitmap.recycle()
    return gray
  }
}
