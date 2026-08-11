package dev.hadamard.companion.workspace

import dev.hadamard.companion.capability.MobilePermission
import dev.hadamard.companion.capability.MobileTool
import dev.hadamard.companion.capability.MobileToolContext
import dev.hadamard.companion.capability.MobileToolDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

class WorkspaceTools(private val workspace: WorkspacePort) {
  fun all(): List<MobileTool> = listOf(
    tool("WorkspaceList", MobilePermission.READ_WORKSPACE) { args ->
      JSONArray(workspace.list(args.optString("parentDocumentId").ifBlank { null }).map {
        JSONObject()
          .put("documentId", it.documentId)
          .put("displayName", it.displayName)
          .put("mediaType", it.mediaType)
          .put("size", it.size)
          .put("isDirectory", it.isDirectory)
      }).toString()
    },
    tool("WorkspaceRead", MobilePermission.READ_WORKSPACE) { args ->
      String(workspace.read(args.required("documentId"), MAX_TEXT_BYTES), StandardCharsets.UTF_8)
    },
    tool("WorkspaceCreate", MobilePermission.WRITE_WORKSPACE) { args ->
      val created = workspace.create(
        args.optString("parentDocumentId").ifBlank { null },
        args.required("displayName"),
        args.optString("mediaType", "text/plain"),
        args.optString("content").toByteArray(StandardCharsets.UTF_8),
      )
      JSONObject().put("documentId", created.documentId).put("size", created.size).toString()
    },
    tool("WorkspaceWrite", MobilePermission.WRITE_WORKSPACE) { args ->
      workspace.write(args.required("documentId"), args.optString("content").toByteArray(StandardCharsets.UTF_8))
      "{\"written\":true}"
    },
    tool("WorkspacePatch", MobilePermission.WRITE_WORKSPACE) { args ->
      val documentId = args.required("documentId")
      val original = String(workspace.read(documentId, MAX_TEXT_BYTES), StandardCharsets.UTF_8)
      val before = args.required("before")
      require(before.isNotEmpty() && original.indexOf(before) == original.lastIndexOf(before)) {
        "Patch target must occur exactly once"
      }
      val updated = original.replace(before, args.optString("after"))
      workspace.write(documentId, updated.toByteArray(StandardCharsets.UTF_8))
      JSONObject().put("written", true).put("size", updated.length).toString()
    },
    tool("WorkspaceMove", MobilePermission.WRITE_WORKSPACE) { args ->
      val moved = workspace.move(
        args.required("documentId"),
        args.optString("targetParentDocumentId").ifBlank { null },
      )
      JSONObject().put("documentId", moved.documentId).toString()
    },
  )

  private fun tool(
    name: String,
    permission: MobilePermission,
    execute: suspend (JSONObject) -> String,
  ) = object : MobileTool {
    override val definition = MobileToolDefinition(
      name = name,
      description = "$name within the user-selected mobile workspace; accepts document IDs, never absolute paths.",
      inputSchemaJson = "{\"type\":\"object\"}",
      permission = permission,
    )

    override suspend fun execute(argumentsJson: String, context: MobileToolContext): String =
      execute(JSONObject(argumentsJson.ifBlank { "{}" }))
  }

  private fun JSONObject.required(name: String): String = getString(name).also { require(it.isNotBlank()) }

  companion object {
    const val MAX_TEXT_BYTES = 2 * 1_048_576
  }
}
