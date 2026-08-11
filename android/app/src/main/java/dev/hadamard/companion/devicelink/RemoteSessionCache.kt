package dev.hadamard.companion.devicelink

import dev.hadamard.companion.data.MobileDatabase
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.SessionMessage
import dev.hadamard.companion.model.SessionOrigin
import dev.hadamard.companion.model.SessionRecord
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class RemoteSessionCache(
  private val database: MobileDatabase,
  private val client: DeviceLinkClient,
) {
  suspend fun refresh(deviceId: String, remoteSessionId: String): SessionRecord {
    var packet = client.request(
      deviceId,
      "session/snapshot",
      JSONObject().put("sessionId", remoteSessionId),
    )
    validatePacket(packet, deviceId, remoteSessionId)
    val items = mutableListOf<JSONObject>()
    packet.getJSONArray("items").let { array -> repeat(array.length()) { items += array.getJSONObject(it) } }
    var complete = packet.getBoolean("complete")
    var lastSequence = items.lastOrNull()?.getLong("sequence")
      ?: packet.optJSONObject("snapshot")?.optLong("throughSequence") ?: 0
    var batches = 0
    while (!complete) {
      require(++batches <= MAX_BATCHES) { "Remote session exceeds the mobile transcript limit" }
      packet = client.request(
        deviceId,
        "session/items",
        JSONObject().put("sessionId", remoteSessionId).put("afterSequence", lastSequence),
      )
      validatePacket(packet, deviceId, remoteSessionId)
      val batch = packet.getJSONArray("items")
      require(batch.length() > 0) { "Remote session returned an incomplete empty batch" }
      repeat(batch.length()) {
        val item = batch.getJSONObject(it)
        require(item.getLong("sequence") > lastSequence) { "Remote session sequence is not increasing" }
        items += item
        lastSequence = item.getLong("sequence")
      }
      complete = packet.getBoolean("complete")
    }
    val revision = packet.getLong("originRevision")
    val cacheId = "cache-${CanonicalJson.sha256("$deviceId\u0000$remoteSessionId").take(40)}"
    val now = System.currentTimeMillis()
    val session = SessionRecord(
      id = cacheId,
      title = packet.optJSONObject("session")?.optString("title").orEmpty().ifBlank { "Remote session" },
      createdAt = now,
      updatedAt = now,
      revision = revision,
      readOnly = true,
      origin = SessionOrigin(deviceId, remoteSessionId, revision),
    )
    database.importMessages(session, items.map(::toMessage).map { it.copy(sessionId = cacheId) })
    return session
  }

  fun copyToPhone(cacheSessionId: String, title: String? = null): SessionRecord {
    val source = database.session(cacheSessionId) ?: error("Remote cache does not exist")
    require(source.readOnly && source.origin != null) { "Session is not a remote cache" }
    val now = System.currentTimeMillis()
    val target = SessionRecord(
      id = UUID.randomUUID().toString(),
      title = title?.trim().orEmpty().ifBlank { "${source.title} (copy)" },
      createdAt = now,
      updatedAt = now,
      revision = source.revision,
      readOnly = false,
      origin = source.origin,
    )
    database.copySession(cacheSessionId, target)
    return target
  }

  private fun validatePacket(packet: JSONObject, deviceId: String, sessionId: String) {
    require(packet.getInt("schemaVersion") == 1) { "Unsupported session packet" }
    require(packet.getString("originDeviceId") == deviceId) { "Remote session origin device changed" }
    require(packet.getString("originSessionId") == sessionId) { "Remote session origin ID changed" }
    require(packet.getJSONArray("items").length() <= MAX_ITEMS_PER_BATCH) { "Remote session batch is too large" }
  }

  private fun toMessage(item: JSONObject): SessionMessage {
    val kind = item.optString("kind").lowercase()
    val payload = item.opt("payload")
    val content = when (payload) {
      is JSONObject -> payload.optString("text").ifBlank { payload.optString("content") }.ifBlank { payload.toString() }
      else -> payload?.toString().orEmpty()
    }.take(MAX_MESSAGE_CHARS)
    val role = when {
      "user" in kind -> MessageRole.USER
      "tool" in kind -> MessageRole.TOOL
      else -> MessageRole.ASSISTANT
    }
    return SessionMessage(
      sessionId = "",
      sequence = item.getLong("sequence"),
      role = role,
      content = content,
      toolCallId = if (role == MessageRole.TOOL) "remote-${item.getLong("sequence")}" else null,
      createdAt = runCatching { Instant.parse(item.getString("createdAt")).toEpochMilli() }.getOrElse { System.currentTimeMillis() },
    )
  }

  companion object {
    private const val MAX_ITEMS_PER_BATCH = 1_000
    private const val MAX_BATCHES = 100
    private const val MAX_MESSAGE_CHARS = 1_000_000
  }
}
