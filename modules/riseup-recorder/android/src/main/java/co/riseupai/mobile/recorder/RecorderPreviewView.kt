package co.riseupai.mobile.recorder

import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.view.WindowManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * The camera preview. It only hands a surface to the module: the recording
 * never depends on it, and a recording started before it exists simply has
 * no preview.
 *
 * Camera2 does not rotate a TextureView's buffer, so the transform below is
 * the standard one (Camera2Basic's configureTransform) for a landscape screen.
 */
class RecorderPreviewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  private var surface: Surface? = null

  private val texture = TextureView(context).also { view ->
    view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
        st.setDefaultBufferSize(PREVIEW_W, PREVIEW_H)
        surface = Surface(st).also { RiseupRecorderModule.previewSurface = it }
        transform(width, height)
      }

      override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
        transform(width, height)
      }

      override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
        if (RiseupRecorderModule.previewSurface === surface) {
          RiseupRecorderModule.previewSurface = null
        }
        surface?.release()
        surface = null
        return true
      }

      override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    }
    addView(view)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    texture.layout(0, 0, r - l, b - t)
  }

  private fun transform(viewWidth: Int, viewHeight: Int) {
    @Suppress("DEPRECATION")
    val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
      .defaultDisplay.rotation
    val matrix = Matrix()
    val viewRect = RectF(0f, 0f, viewWidth.toFloat(), viewHeight.toFloat())
    val bufferRect = RectF(0f, 0f, PREVIEW_H.toFloat(), PREVIEW_W.toFloat())
    val cx = viewRect.centerX()
    val cy = viewRect.centerY()
    if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) {
      bufferRect.offset(cx - bufferRect.centerX(), cy - bufferRect.centerY())
      matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL)
      val scale = maxOf(viewHeight.toFloat() / PREVIEW_H, viewWidth.toFloat() / PREVIEW_W)
      matrix.postScale(scale, scale, cx, cy)
      matrix.postRotate(90f * (rotation - 2), cx, cy)
    } else if (rotation == Surface.ROTATION_180) {
      matrix.postRotate(180f, cx, cy)
    }
    texture.setTransform(matrix)
  }

  companion object {
    const val PREVIEW_W = 1920
    const val PREVIEW_H = 1080
  }
}
