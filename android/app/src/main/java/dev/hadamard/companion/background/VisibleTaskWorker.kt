package dev.hadamard.companion.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import dev.hadamard.companion.R
import dev.hadamard.companion.data.readWithOverflowByte
import dev.hadamard.companion.document.OcrService
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.util.UUID

class VisibleTaskWorker(
  private val context: Context,
  parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {
  override suspend fun doWork(): Result {
    val task = inputData.getString(KEY_TASK) ?: return Result.failure(errorData("Missing task type"))
    setForeground(foregroundInfo("Starting $task", 0))
    return runCatching {
      when (task) {
        TASK_IMAGE_OCR -> imageOcr()
        else -> error("Unsupported visible task: $task")
      }
    }.fold(
      onSuccess = { Result.success(it) },
      onFailure = { error ->
        if (isStopped) Result.failure(errorData("Task was stopped"))
        else Result.failure(errorData(error.message ?: "Task failed"))
      },
    )
  }

  private suspend fun imageOcr(): Data {
    currentCoroutineContext().ensureActive()
    val uri = Uri.parse(inputData.getString(KEY_INPUT_URI) ?: error("Missing input document"))
    require(uri.scheme == "content") { "OCR worker accepts only SAF content URIs" }
    setProgress(workDataOf(KEY_STAGE to "reading", KEY_PROGRESS to 10))
    val bytes = context.contentResolver.openInputStream(uri)?.use {
      it.readWithOverflowByte(OcrService.MAX_IMAGE_BYTES)
    } ?: error("Input document is unavailable")
    require(bytes.size <= OcrService.MAX_IMAGE_BYTES) { "OCR input exceeds the file limit" }
    currentCoroutineContext().ensureActive()
    setProgress(workDataOf(KEY_STAGE to "recognizing", KEY_PROGRESS to 45))
    setForeground(foregroundInfo("Recognizing text", 45))
    val text = OcrService().recognize(bytes)
    currentCoroutineContext().ensureActive()
    val output = File(context.filesDir, "worker-results").apply { mkdirs() }
      .resolve("${id}-${UUID.randomUUID()}.txt")
    output.writeText(text)
    setProgress(workDataOf(KEY_STAGE to "complete", KEY_PROGRESS to 100))
    return workDataOf(KEY_OUTPUT_PATH to output.absolutePath, KEY_STAGE to "complete")
  }

  private fun foregroundInfo(message: String, progressValue: Int): ForegroundInfo {
    val notifications = context.getSystemService(NotificationManager::class.java)
    notifications.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Hadamard tasks", NotificationManager.IMPORTANCE_LOW),
    )
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_hadamard)
      .setContentTitle("Hadamard mobile task")
      .setContentText(message)
      .setOngoing(true)
      .setProgress(100, progressValue, false)
      .build()
    return ForegroundInfo(NOTIFICATION_ID, notification)
  }

  private fun errorData(message: String) = workDataOf(KEY_ERROR to message.take(500))

  companion object {
    const val KEY_TASK = "task"
    const val KEY_INPUT_URI = "input_uri"
    const val KEY_OUTPUT_PATH = "output_path"
    const val KEY_STAGE = "stage"
    const val KEY_PROGRESS = "progress"
    const val KEY_ERROR = "error"
    const val TASK_IMAGE_OCR = "image-ocr"
    private const val CHANNEL_ID = "hadamard-visible-tasks"
    private const val NOTIFICATION_ID = 7201
  }
}
