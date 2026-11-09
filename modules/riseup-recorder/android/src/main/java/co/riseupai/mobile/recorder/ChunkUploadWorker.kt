package co.riseupai.mobile.recorder

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * One recorded chunk, PUT to its presigned URL by the OS, not by the app.
 *
 * WHY NATIVE (measured on a Pixel 8a, 9 Nov 2026): the JS upload loop stopped
 * the moment RiseUp left the foreground -- 0.018 Mbit/s in the background
 * against 18.4 in front -- and a coach puts the phone in a pocket after the
 * final whistle. A WorkManager job survives the app going to the background
 * and the process being killed; it runs as a foreground service with a
 * notification (Android 14: type dataSync), waits for a network, and retries
 * with backoff on its own.
 *
 * ONE CHAIN, IN ORDER (`enqueueUniqueWork` APPEND): the pipeline reads the
 * match from its start, so the oldest chunk goes first.
 *
 * The server confirms a chunk itself (it HEADs the object; R2 enforces the
 * signed SHA-256 at write time), so nothing here needs the API or a Clerk
 * token. The outcome is kept in SharedPreferences for the app to read on its
 * next run.
 */
class ChunkUploadWorker(context: Context, params: WorkerParameters) :
  CoroutineWorker(context, params) {

  override suspend fun doWork(): Result {
    val id = inputData.getString(KEY_ID) ?: return Result.failure()
    val file = File(inputData.getString(KEY_FILE) ?: return Result.failure())
    val url = inputData.getString(KEY_URL) ?: return Result.failure()
    val method = inputData.getString(KEY_METHOD) ?: "PUT"
    val headers = JSONObject(inputData.getString(KEY_HEADERS) ?: "{}")
    if (!file.exists()) {
      record(applicationContext, id, "failed:missing_file")
      return Result.success()                      // see 403: keep the chain going
    }
    try {
      setForeground(foregroundInfo(inputData.getString(KEY_LABEL) ?: "Sending the match"))
    } catch (_: Exception) {
      // Not allowed to start a foreground service right now (Android 12+
      // background start rules); the work still runs, only less protected.
    }
    record(applicationContext, id, "uploading")
    return withContext(Dispatchers.IO) {
      try {
        val code = put(file, url, method, headers)
        when {
          code in 200..299 -> {
            record(applicationContext, id, "done")
            Result.success()
          }
          // 403: the URL expired or its signature no longer matches. Retrying
          // the same URL cannot help; the app re-registers for a fresh one.
          code == 403 -> {
            record(applicationContext, id, "failed:403")
            // SUCCESS for the chain: in a WorkManager chain a failure fails
            // every job queued after it, and one expired URL must not sink
            // the rest of the match. The outcome is in `record`.
            Result.success()
          }
          // 400 BadDigest: the bytes do not match the hash the server signed.
          code == 400 -> {
            record(applicationContext, id, "failed:400")
            Result.success()                       // see 403
          }
          else -> {
            record(applicationContext, id, "retrying:$code")
            Result.retry()
          }
        }
      } catch (e: IOException) {
        record(applicationContext, id, "retrying:network")
        Result.retry()
      }
    }
  }

  private fun put(file: File, url: String, method: String, headers: JSONObject): Int {
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
      conn.requestMethod = method
      conn.doOutput = true
      conn.connectTimeout = 30_000
      conn.readTimeout = 120_000
      conn.setFixedLengthStreamingMode(file.length())
      headers.keys().forEach { name -> conn.setRequestProperty(name, headers.getString(name)) }
      conn.outputStream.use { out ->
        file.inputStream().use { input -> input.copyTo(out, 1 shl 20) }
      }
      return conn.responseCode
    } finally {
      conn.disconnect()
    }
  }

  override suspend fun getForegroundInfo(): ForegroundInfo =
    foregroundInfo(inputData.getString(KEY_LABEL) ?: "Sending the match")

  private fun foregroundInfo(label: String): ForegroundInfo {
    val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE)
      as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Match uploads", NotificationManager.IMPORTANCE_LOW))
    }
    val notification = NotificationCompat.Builder(applicationContext, CHANNEL)
      .setContentTitle("RiseUp")
      .setContentText(label)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(true)
      .setSilent(true)
      .build()
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    private const val KEY_ID = "id"
    private const val KEY_FILE = "file"
    private const val KEY_URL = "url"
    private const val KEY_METHOD = "method"
    private const val KEY_HEADERS = "headers"
    private const val KEY_LABEL = "label"
    private const val CHANNEL = "riseup-uploads"
    private const val NOTIFICATION_ID = 4711
    private const val PREFS = "riseup.recorder.uploads"
    private const val CHAIN = "riseup-chunk-uploads"

    fun enqueue(context: Context, id: String, file: String, url: String, method: String,
                headers: Map<String, String>, label: String) {
      val request = OneTimeWorkRequestBuilder<ChunkUploadWorker>()
        .setInputData(Data.Builder()
          .putString(KEY_ID, id)
          .putString(KEY_FILE, file)
          .putString(KEY_URL, url)
          .putString(KEY_METHOD, method)
          .putString(KEY_HEADERS, JSONObject(headers).toString())
          .putString(KEY_LABEL, label)
          .build())
        .setConstraints(Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
        .addTag(id)
        .build()
      record(context, id, "queued")
      WorkManager.getInstance(context)
        .enqueueUniqueWork(CHAIN, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    fun record(context: Context, id: String, status: String) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString(id, status).apply()
    }

    fun status(context: Context, id: String): String? =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(id, null)

    fun forget(context: Context, id: String) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(id).apply()
    }
  }
}
