package dev.hadamard.companion.background

import android.content.Context
import android.net.Uri
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID

data class VisibleTaskState(
  val id: UUID,
  val status: WorkInfo.State,
  val stage: String,
  val progress: Int,
  val stoppable: Boolean,
)

class VisibleTaskCoordinator(context: Context) {
  private val workManager = WorkManager.getInstance(context)

  fun enqueueImageOcr(uri: Uri): UUID {
    require(uri.scheme == "content") { "Long OCR accepts only a SAF content URI" }
    val request = OneTimeWorkRequestBuilder<VisibleTaskWorker>()
      .setInputData(
        workDataOf(
          VisibleTaskWorker.KEY_TASK to VisibleTaskWorker.TASK_IMAGE_OCR,
          VisibleTaskWorker.KEY_INPUT_URI to uri.toString(),
        ),
      )
      .setConstraints(Constraints.Builder().setRequiresStorageNotLow(true).build())
      .addTag(TAG)
      .build()
    workManager.enqueueUniqueWork("hadamard-ocr-${request.id}", ExistingWorkPolicy.KEEP, request)
    return request.id
  }

  fun observe(id: UUID): Flow<VisibleTaskState> = workManager.getWorkInfoByIdFlow(id).map { info ->
    VisibleTaskState(
      id = id,
      status = info.state,
      stage = info.progress.getString(VisibleTaskWorker.KEY_STAGE)
        ?: info.outputData.getString(VisibleTaskWorker.KEY_STAGE)
        ?: "queued",
      progress = info.progress.getInt(VisibleTaskWorker.KEY_PROGRESS, 0),
      stoppable = !info.state.isFinished,
    )
  }

  fun stop(id: UUID) {
    workManager.cancelWorkById(id)
  }

  companion object {
    private const val TAG = "hadamard-visible-task"
  }
}
