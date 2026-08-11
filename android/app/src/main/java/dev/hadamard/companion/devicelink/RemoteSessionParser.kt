package dev.hadamard.companion.devicelink

import org.json.JSONArray
import org.json.JSONObject

data class RemoteSessionSummary(
  val id: String,
  val title: String,
  val updatedAt: String,
  val preview: String,
)

object RemoteSessionParser {
  private const val MAX_SESSIONS = 500
  private const val MAX_PREVIEW_CHARS = 180

  fun parse(result: JSONObject): List<RemoteSessionSummary> {
    val array = result.optJSONArray("value") ?: result.optJSONArray("sessions") ?: JSONArray()
    val count = minOf(array.length(), MAX_SESSIONS)
    return buildList(count) {
      repeat(count) { index ->
        val value = array.getJSONObject(index)
        val id = value.getString("id").trim()
        require(id.isNotEmpty()) { "Remote session ID cannot be empty" }
        add(
          RemoteSessionSummary(
            id = id,
            title = value.optString("title").trim().ifBlank { "Untitled session" },
            updatedAt = value.optString("updatedAt"),
            preview = value.optString("preview").take(MAX_PREVIEW_CHARS),
          ),
        )
      }
    }
  }
}
