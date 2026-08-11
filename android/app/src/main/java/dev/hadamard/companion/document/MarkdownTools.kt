package dev.hadamard.companion.document

import dev.hadamard.companion.capability.MobilePermission
import dev.hadamard.companion.capability.MobileTool
import dev.hadamard.companion.capability.MobileToolContext
import dev.hadamard.companion.capability.MobileToolDefinition
import dev.hadamard.companion.workspace.WorkspacePort
import dev.hadamard.companion.workspace.WorkspaceTools
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

class MarkdownTools(private val workspace: WorkspacePort) {
  fun all(): List<MobileTool> = listOf(
    markdownTool("MarkdownRead", MobilePermission.READ_WORKSPACE) { args -> read(args.getString("documentId")) },
    markdownTool("MarkdownWrite", MobilePermission.WRITE_WORKSPACE) { args ->
      workspace.write(args.getString("documentId"), args.getString("content").toByteArray(StandardCharsets.UTF_8))
      "{\"written\":true}"
    },
    markdownTool("MarkdownRender", MobilePermission.READ_WORKSPACE) { args ->
      JSONObject().put("html", renderSafe(read(args.getString("documentId")))).toString()
    },
    markdownTool("MarkdownOutline", MobilePermission.READ_WORKSPACE) { args ->
      JSONArray(outline(read(args.getString("documentId"))).map { (level, title) ->
        JSONObject().put("level", level).put("title", title)
      }).toString()
    },
  )

  fun outline(markdown: String): List<Pair<Int, String>> = markdown.lineSequence().mapNotNull { line ->
    val prefix = line.takeWhile { it == '#' }
    if (prefix.isEmpty() || prefix.length > 6 || line.getOrNull(prefix.length) != ' ') null
    else prefix.length to line.drop(prefix.length + 1).trim()
  }.toList()

  fun renderSafe(markdown: String): String = buildString {
    var inCode = false
    markdown.lineSequence().forEach { rawLine ->
      if (rawLine.trimStart().startsWith("```")) {
        append(if (inCode) "</code></pre>" else "<pre><code>")
        inCode = !inCode
        return@forEach
      }
      val line = escapeHtml(rawLine)
      if (inCode) {
        append(line).append('\n')
        return@forEach
      }
      val heading = rawLine.takeWhile { it == '#' }.length
      when {
        heading in 1..6 && rawLine.getOrNull(heading) == ' ' ->
          append("<h$heading>").append(escapeHtml(rawLine.drop(heading + 1))).append("</h$heading>")
        rawLine.startsWith("- ") -> append("<p>• ").append(escapeHtml(rawLine.drop(2))).append("</p>")
        rawLine.isBlank() -> append("<br>")
        else -> append("<p>").append(line).append("</p>")
      }
    }
    if (inCode) append("</code></pre>")
  }

  private fun read(documentId: String) = String(
    workspace.read(documentId, WorkspaceTools.MAX_TEXT_BYTES),
    StandardCharsets.UTF_8,
  )

  private fun markdownTool(
    name: String,
    permission: MobilePermission,
    block: suspend (JSONObject) -> String,
  ) = object : MobileTool {
    override val definition = MobileToolDefinition(
      name,
      "$name using a bounded UTF-8 document in the mobile workspace.",
      "{\"type\":\"object\",\"required\":[\"documentId\"]}",
      permission,
    )
    override suspend fun execute(argumentsJson: String, context: MobileToolContext) = block(JSONObject(argumentsJson))
  }

  private fun escapeHtml(value: String) = value
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&#39;")
}
