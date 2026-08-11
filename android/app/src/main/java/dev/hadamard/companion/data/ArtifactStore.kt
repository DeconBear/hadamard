package dev.hadamard.companion.data

import android.content.Context
import dev.hadamard.companion.model.ArtifactRecord
import java.io.File
import java.security.MessageDigest
import java.util.UUID

class ArtifactStore(context: Context) {
  private val root = File(context.filesDir, "artifacts").apply { mkdirs() }

  fun put(
    displayName: String,
    mediaType: String,
    bytes: ByteArray,
    sessionId: String? = null,
  ): ArtifactRecord {
    require(bytes.size <= MAX_BYTES) { "Artifact exceeds the ${MAX_BYTES / 1_048_576} MiB mobile limit" }
    val id = UUID.randomUUID().toString()
    val target = File(root, id)
    target.outputStream().use { it.write(bytes) }
    return ArtifactRecord(
      id = id,
      sessionId = sessionId,
      displayName = displayName.take(160),
      mediaType = mediaType.take(120),
      size = bytes.size.toLong(),
      sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
      localPath = target.absolutePath,
      createdAt = System.currentTimeMillis(),
    )
  }

  fun read(record: ArtifactRecord): ByteArray {
    val target = File(record.localPath).canonicalFile
    require(target.parentFile == root.canonicalFile) { "Artifact path escaped app storage" }
    require(target.length() <= MAX_BYTES) { "Artifact exceeds the mobile read limit" }
    val bytes = target.readBytes()
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    check(digest == record.sha256) { "Artifact integrity check failed" }
    return bytes
  }

  companion object {
    const val MAX_BYTES = 32 * 1_048_576
  }
}
