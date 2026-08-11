package dev.hadamard.companion.workspace

data class WorkspaceDocument(
  val documentId: String,
  val displayName: String,
  val mediaType: String,
  val size: Long,
  val isDirectory: Boolean,
)

interface WorkspacePort {
  val workspaceId: String
  fun list(parentDocumentId: String? = null): List<WorkspaceDocument>
  fun read(documentId: String, maxBytes: Int): ByteArray
  fun create(parentDocumentId: String?, displayName: String, mediaType: String, content: ByteArray): WorkspaceDocument
  fun write(documentId: String, content: ByteArray)
  fun move(documentId: String, targetParentDocumentId: String?): WorkspaceDocument
}

class WorkspacePermissionRevokedException(message: String) : SecurityException(message)
class WorkspaceLimitException(message: String) : IllegalArgumentException(message)
