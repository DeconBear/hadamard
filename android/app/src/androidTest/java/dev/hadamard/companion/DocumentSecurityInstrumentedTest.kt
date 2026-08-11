package dev.hadamard.companion

import android.net.Uri
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.hadamard.companion.document.OcrService
import dev.hadamard.companion.document.PdfTools
import dev.hadamard.companion.web.PageTools
import dev.hadamard.companion.web.SecurePagePolicy
import dev.hadamard.companion.web.SecureWebFetcher
import dev.hadamard.companion.workspace.SafWorkspace
import dev.hadamard.companion.workspace.WorkspaceDocument
import dev.hadamard.companion.workspace.WorkspacePort
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DocumentSecurityInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

  @Test
  fun revokedOrMissingSafGrantCannotBecomeAFilePathWorkspace() {
    assertThrows(SecurityException::class.java) {
      SafWorkspace(context, Uri.parse("content://dev.hadamard.missing/tree/root"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      SafWorkspace(context, Uri.fromFile(context.filesDir))
    }
  }

  @Test
  fun malformedPdfAndOcrPixelBombFailWithinBounds() {
    runBlocking {
      val workspace = ByteWorkspace("not-a-pdf".toByteArray())
      val pdf = PdfTools(context, workspace, OcrService())
      val tool = pdf.all().first { it.definition.name == "PdfReadText" }
      assertThrows(Exception::class.java) {
        runBlocking { tool.execute("{\"documentId\":\"doc\"}", dev.hadamard.companion.capability.MobileToolContext("s", true)) }
      }
      assertThrows(IllegalArgumentException::class.java) { OcrService().enforceBitmapLimit(90_000, 90_000) }
    }
  }

  @Test
  fun previewWebViewHasNoScriptBridgeFileAccessOrCrossOriginHandler() {
    var javaScriptEnabled = true
    var fileAccessEnabled = true
    var contentAccessEnabled = true
    var crossOriginHandled = true
    var previewHandled = false
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val webView = WebView(context)
      val loader = PageTools(context, ByteWorkspace("<h1>Safe</h1>".toByteArray()), SecureWebFetcher())
        .configurePreview(webView, "<h1>Safe</h1>")
      javaScriptEnabled = webView.settings.javaScriptEnabled
      fileAccessEnabled = webView.settings.allowFileAccess
      contentAccessEnabled = webView.settings.allowContentAccess
      crossOriginHandled = loader.shouldInterceptRequest(Uri.parse("https://private.example/secret")) != null
      previewHandled = loader.shouldInterceptRequest(Uri.parse(SecurePagePolicy.PREVIEW_ORIGIN)) != null
      webView.destroy()
    }
    assertFalse(javaScriptEnabled)
    assertFalse(fileAccessEnabled)
    assertFalse(contentAccessEnabled)
    assertFalse(crossOriginHandled)
    assertTrue(previewHandled)
  }
}

private class ByteWorkspace(private var bytes: ByteArray) : WorkspacePort {
  override val workspaceId = "bytes"
  override fun list(parentDocumentId: String?) = emptyList<WorkspaceDocument>()
  override fun read(documentId: String, maxBytes: Int): ByteArray = bytes.also { require(it.size <= maxBytes) }
  override fun create(parentDocumentId: String?, displayName: String, mediaType: String, content: ByteArray) =
    WorkspaceDocument("doc", displayName, mediaType, content.size.toLong(), false).also { bytes = content }
  override fun write(documentId: String, content: ByteArray) { bytes = content }
  override fun move(documentId: String, targetParentDocumentId: String?) =
    WorkspaceDocument("doc", "doc", "application/octet-stream", bytes.size.toLong(), false)
}
