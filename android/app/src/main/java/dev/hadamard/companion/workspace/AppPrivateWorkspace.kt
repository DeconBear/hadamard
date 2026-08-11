package dev.hadamard.companion.workspace

import android.content.Context
import dev.hadamard.companion.data.readWithOverflowByte
import java.io.File
import java.util.UUID

class AppPrivateWorkspace(context: Context) : WorkspacePort {
  private val root = File(context.filesDir, "workspace").apply { mkdirs() }.canonicalFile
  override val workspaceId: String = "this-phone"

  override fun list(parentDocumentId: String?): List<WorkspaceDocument> {
    val parent = resolve(parentDocumentId ?: "")
    require(parent.isDirectory) { "Document is not a directory" }
    return parent.listFiles().orEmpty().sortedBy { it.name.lowercase() }.map(::describe)
  }

  override fun read(documentId: String, maxBytes: Int): ByteArray {
    val file = resolve(documentId)
    require(file.isFile) { "Document is not a file" }
    require(file.length() <= maxBytes) { "Document exceeds the requested read limit" }
    return file.inputStream().use { input -> input.readWithOverflowByte(maxBytes) }.also {
      require(it.size <= maxBytes) { "Document changed while reading and now exceeds the limit" }
    }
  }

  override fun create(
    parentDocumentId: String?,
    displayName: String,
    mediaType: String,
    content: ByteArray,
  ): WorkspaceDocument {
    require(content.size <= MAX_WRITE_BYTES) { "Document exceeds the mobile write limit" }
    val parent = resolve(parentDocumentId ?: "")
    val safeName = safeDisplayName(displayName)
    val file = File(parent, safeName).canonicalFile
    require(file.parentFile == parent.canonicalFile) { "Document name escaped its parent" }
    require(file.createNewFile()) { "A document with this name already exists" }
    file.outputStream().use { it.write(content) }
    return describe(file, mediaType)
  }

  override fun write(documentId: String, content: ByteArray) {
    require(content.size <= MAX_WRITE_BYTES) { "Document exceeds the mobile write limit" }
    val target = resolve(documentId)
    require(target.isFile) { "Document is not writable" }
    val temporary = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp")
    temporary.outputStream().use { it.write(content) }
    check(temporary.renameTo(target)) { "Atomic document replacement failed" }
  }

  override fun move(documentId: String, targetParentDocumentId: String?): WorkspaceDocument {
    val source = resolve(documentId)
    val targetParent = resolve(targetParentDocumentId ?: "")
    require(targetParent.isDirectory) { "Move target is not a directory" }
    val target = File(targetParent, source.name).canonicalFile
    require(target.parentFile == targetParent.canonicalFile && !target.exists()) { "Invalid move target" }
    check(source.renameTo(target)) { "Document move failed" }
    return describe(target)
  }

  private fun resolve(documentId: String): File {
    require(!File(documentId).isAbsolute) { "Absolute paths are not accepted" }
    require(!documentId.contains('\\')) { "Use document IDs, not platform paths" }
    require(documentId.split('/').none { it == ".." || it == "." }) { "Invalid document ID" }
    val target = if (documentId.isBlank()) root else File(root, documentId).canonicalFile
    require(target == root || target.toPath().startsWith(root.toPath())) { "Document escaped workspace" }
    return target
  }

  private fun describe(file: File, mediaType: String = guessMediaType(file.name)) = WorkspaceDocument(
    documentId = file.relativeTo(root).invariantSeparatorsPath,
    displayName = file.name,
    mediaType = if (file.isDirectory) "vnd.android.document/directory" else mediaType,
    size = if (file.isDirectory) 0 else file.length(),
    isDirectory = file.isDirectory,
  )

  private fun safeDisplayName(value: String): String {
    val trimmed = value.trim()
    require(trimmed.isNotEmpty() && trimmed.length <= 160) { "Invalid document name" }
    require(trimmed != "." && trimmed != ".." && '/' !in trimmed && '\\' !in trimmed) { "Invalid document name" }
    return trimmed
  }

  private fun guessMediaType(name: String) = when (name.substringAfterLast('.', "").lowercase()) {
    "md" -> "text/markdown"
    "txt" -> "text/plain"
    "html", "htm" -> "text/html"
    "css" -> "text/css"
    "pdf" -> "application/pdf"
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    else -> "application/octet-stream"
  }

  companion object {
    const val MAX_WRITE_BYTES = 8 * 1_048_576
  }
}
