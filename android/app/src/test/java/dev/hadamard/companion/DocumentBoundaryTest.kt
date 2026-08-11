package dev.hadamard.companion

import dev.hadamard.companion.document.MarkdownTools
import dev.hadamard.companion.document.OcrService
import dev.hadamard.companion.workspace.WorkspaceDocument
import dev.hadamard.companion.workspace.WorkspacePort
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DocumentBoundaryTest {
  @Test
  fun markdownRenderingEscapesRawHtmlAndBuildsOutline() {
    val tools = MarkdownTools(InMemoryWorkspace("# Title\n<script>bad()</script>".toByteArray()))
    assertEquals(listOf(1 to "Title"), tools.outline("# Title\ntext"))
    assertTrue(tools.renderSafe("<script>bad()</script>").contains("&lt;script&gt;"))
  }

  @Test
  fun ocrMemoryLimitRejectsPixelBombBeforeBitmapAllocation() {
    val service = OcrService()
    assertThrows(IllegalArgumentException::class.java) { service.enforceBitmapLimit(100_000, 100_000) }
  }
}

private class InMemoryWorkspace(private var bytes: ByteArray) : WorkspacePort {
  override val workspaceId = "test"
  override fun list(parentDocumentId: String?) = emptyList<WorkspaceDocument>()
  override fun read(documentId: String, maxBytes: Int) = bytes.also { require(it.size <= maxBytes) }
  override fun create(parentDocumentId: String?, displayName: String, mediaType: String, content: ByteArray) =
    WorkspaceDocument("doc", displayName, mediaType, content.size.toLong(), false).also { bytes = content }
  override fun write(documentId: String, content: ByteArray) { bytes = content }
  override fun move(documentId: String, targetParentDocumentId: String?) =
    WorkspaceDocument("doc", "doc", "text/plain", bytes.size.toLong(), false)
}
