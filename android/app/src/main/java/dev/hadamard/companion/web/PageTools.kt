package dev.hadamard.companion.web

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import dev.hadamard.companion.capability.MobilePermission
import dev.hadamard.companion.capability.MobileTool
import dev.hadamard.companion.capability.MobileToolContext
import dev.hadamard.companion.capability.MobileToolDefinition
import dev.hadamard.companion.workspace.WorkspacePort
import dev.hadamard.companion.workspace.WorkspaceTools
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets

class PageTools(
  private val context: Context,
  private val workspace: WorkspacePort,
  private val fetcher: SecureWebFetcher,
) {
  fun all(): List<MobileTool> = listOf(
    tool("WebFetch", MobilePermission.NETWORK) { args ->
      val result = fetcher.fetch(args.getString("url"))
      JSONObject().put("url", result.finalUrl).put("mediaType", result.mediaType)
        .put("content", result.content).put("untrusted", true).toString()
    },
    tool("ReaderExtract", MobilePermission.NETWORK) { args ->
      val result = fetcher.fetch(args.getString("url"))
      JSONObject().put("url", result.finalUrl).put("text", fetcher.readerText(result.content))
        .put("untrusted", true).toString()
    },
    tool("BrowserOpen", MobilePermission.OPEN_EXTERNAL) { args ->
      val uri = fetcher.validate(args.getString("url"))
      context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      "{\"opened\":true}"
    },
    tool("PageCreate", MobilePermission.WRITE_WORKSPACE) { args ->
      val html = secureDocument(args.optString("html"), args.optString("css"))
      val created = workspace.create(
        args.optString("parentDocumentId").ifBlank { null },
        args.optString("displayName", "page.html"),
        "text/html",
        html.toByteArray(StandardCharsets.UTF_8),
      )
      JSONObject().put("documentId", created.documentId).toString()
    },
    tool("PagePatch", MobilePermission.WRITE_WORKSPACE) { args ->
      val id = args.getString("documentId")
      val current = String(workspace.read(id, WorkspaceTools.MAX_TEXT_BYTES), StandardCharsets.UTF_8)
      val before = args.getString("before")
      require(before.isNotEmpty() && current.indexOf(before) == current.lastIndexOf(before)) {
        "Patch target must occur exactly once"
      }
      val updated = current.replace(before, args.optString("after"))
      require(!SecurePagePolicy.ACTIVE_CONTENT_PATTERN.containsMatchIn(updated)) { "Scripts are not allowed in mobile page previews" }
      workspace.write(id, updated.toByteArray(StandardCharsets.UTF_8))
      "{\"written\":true}"
    },
    tool("PagePreview", MobilePermission.READ_WORKSPACE) { args ->
      val html = String(
        workspace.read(args.getString("documentId"), WorkspaceTools.MAX_TEXT_BYTES),
        StandardCharsets.UTF_8,
      )
      JSONObject().put("origin", SecurePagePolicy.PREVIEW_ORIGIN).put("html", SecurePagePolicy.enforce(html)).toString()
    },
    tool("PageExport", MobilePermission.READ_WORKSPACE) { args ->
      val id = args.getString("documentId")
      val bytes = workspace.read(id, WorkspaceTools.MAX_TEXT_BYTES)
      JSONObject().put("documentId", id).put("bytes", bytes.size).put("mediaType", "text/html").toString()
    },
  )

  fun configurePreview(webView: WebView, html: String): WebViewAssetLoader {
    val safeHtml = SecurePagePolicy.enforce(html).toByteArray(StandardCharsets.UTF_8)
    with(webView.settings) {
      javaScriptEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      domStorageEnabled = false
      setSupportMultipleWindows(false)
    }
    webView.removeJavascriptInterface("searchBoxJavaBridge_")
    webView.removeJavascriptInterface("accessibility")
    webView.removeJavascriptInterface("accessibilityTraversal")
    return WebViewAssetLoader.Builder()
      .setDomain(SecurePagePolicy.PREVIEW_HOST)
      .addPathHandler("/preview/") {
        WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(safeHtml)).apply {
          responseHeaders = mapOf(
            "Content-Security-Policy" to SecurePagePolicy.CSP,
            "X-Content-Type-Options" to "nosniff",
          )
        }
      }
      .build()
  }

  private fun secureDocument(html: String, css: String): String {
    require(!SecurePagePolicy.ACTIVE_CONTENT_PATTERN.containsMatchIn(html)) { "Scripts are not allowed" }
    require(html.length + css.length <= SecurePagePolicy.MAX_HTML_CHARS) { "Page exceeds the mobile limit" }
    return SecurePagePolicy.enforce("<!doctype html><html><head><style>$css</style></head><body>$html</body></html>")
  }

  private fun tool(
    name: String,
    permission: MobilePermission,
    block: suspend (JSONObject) -> String,
  ) = object : MobileTool {
    override val definition = MobileToolDefinition(
      name,
      "$name through the bounded mobile web/page capability.",
      "{\"type\":\"object\"}",
      permission,
    )
    override suspend fun execute(argumentsJson: String, context: MobileToolContext) = block(JSONObject(argumentsJson))
  }

}
