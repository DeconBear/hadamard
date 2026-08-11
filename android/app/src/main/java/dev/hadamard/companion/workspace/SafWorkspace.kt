package dev.hadamard.companion.workspace

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import dev.hadamard.companion.data.readWithOverflowByte

class SafWorkspace(
  private val context: Context,
  private val treeUri: Uri,
) : WorkspacePort {
  private val resolver: ContentResolver = context.contentResolver
  override val workspaceId: String = "saf:${treeUri}"

  init {
    require(treeUri.scheme == ContentResolver.SCHEME_CONTENT) { "SAF workspace requires a content URI" }
    val grant = resolver.persistedUriPermissions.firstOrNull { it.uri == treeUri }
    if (grant == null || !grant.isReadPermission) {
      throw WorkspacePermissionRevokedException("The selected SAF workspace grant is missing or was revoked")
    }
  }

  override fun list(parentDocumentId: String?): List<WorkspaceDocument> =
    resolve(parentDocumentId).listFiles().sortedBy { it.name?.lowercase() }.map(::describe)

  override fun read(documentId: String, maxBytes: Int): ByteArray {
    val document = resolve(documentId)
    require(document.isFile) { "Document is not a file" }
    require(document.length() <= maxBytes) { "Document exceeds the requested read limit" }
    return withPermissionBoundary {
      resolver.openInputStream(document.uri)?.use { it.readWithOverflowByte(maxBytes) }
        ?: error("Document provider returned no input stream")
    }.also { require(it.size <= maxBytes) { "Document changed while reading" } }
  }

  override fun create(
    parentDocumentId: String?,
    displayName: String,
    mediaType: String,
    content: ByteArray,
  ): WorkspaceDocument {
    require(content.size <= AppPrivateWorkspace.MAX_WRITE_BYTES) { "Document exceeds the mobile write limit" }
    val parent = resolve(parentDocumentId)
    require(parent.isDirectory) { "Parent is not a directory" }
    val document = withPermissionBoundary {
      parent.createFile(mediaType, displayName) ?: error("Document provider rejected create")
    }
    write(document.uri.toString(), content)
    return describe(document)
  }

  override fun write(documentId: String, content: ByteArray) {
    require(content.size <= AppPrivateWorkspace.MAX_WRITE_BYTES) { "Document exceeds the mobile write limit" }
    val document = resolve(documentId)
    require(document.isFile) { "Document is not writable" }
    withPermissionBoundary {
      resolver.openOutputStream(document.uri, "rwt")?.use { it.write(content) }
        ?: error("Document provider returned no output stream")
    }
  }

  override fun move(documentId: String, targetParentDocumentId: String?): WorkspaceDocument {
    val source = resolve(documentId)
    val target = resolve(targetParentDocumentId)
    require(target.isDirectory) { "Move target is not a directory" }
    val movedUri = withPermissionBoundary {
      android.provider.DocumentsContract.moveDocument(
        resolver,
        source.uri,
        source.parentFile?.uri ?: treeUri,
        target.uri,
      ) ?: error("Document provider does not support move")
    }
    return describe(DocumentFile.fromSingleUri(context, movedUri) ?: error("Moved document is unavailable"))
  }

  private fun resolve(documentId: String?): DocumentFile {
    val root = DocumentFile.fromTreeUri(context, treeUri)
      ?: throw WorkspacePermissionRevokedException("Workspace permission is no longer available")
    if (documentId.isNullOrBlank()) return root
    val uri = runCatching { Uri.parse(documentId) }.getOrElse { throw IllegalArgumentException("Invalid document ID") }
    require(uri.scheme == ContentResolver.SCHEME_CONTENT) { "Absolute paths and file URIs are not accepted" }
    val document = DocumentFile.fromSingleUri(context, uri)
      ?: throw WorkspacePermissionRevokedException("Document is no longer available")
    check(isWithinTree(document.uri)) { "Document is outside the selected SAF tree" }
    return document
  }

  private fun isWithinTree(documentUri: Uri): Boolean {
    val treeId = runCatching { android.provider.DocumentsContract.getTreeDocumentId(treeUri) }.getOrNull()
      ?: return false
    val documentId = runCatching { android.provider.DocumentsContract.getDocumentId(documentUri) }.getOrNull()
      ?: return false
    return documentId == treeId || documentId.startsWith("$treeId/")
  }

  private fun describe(document: DocumentFile) = WorkspaceDocument(
    documentId = document.uri.toString(),
    displayName = document.name ?: "Untitled",
    mediaType = document.type ?: if (document.isDirectory) "vnd.android.document/directory" else "application/octet-stream",
    size = document.length(),
    isDirectory = document.isDirectory,
  )

  private inline fun <T> withPermissionBoundary(block: () -> T): T = try {
    block()
  } catch (error: SecurityException) {
    throw WorkspacePermissionRevokedException("SAF permission was revoked: ${error.message}")
  }
}
