package dev.hadamard.companion.devicelink

import android.util.Base64
import org.json.JSONObject
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID

fun interface DeviceLinkRpc {
  suspend fun request(deviceId: String, method: String, params: JSONObject): JSONObject
}

class DeviceLinkClient(
  private val identityManager: DeviceIdentityManager,
  private val computerStore: PairedComputerStore,
) : DeviceLinkRpc {
  override suspend fun request(deviceId: String, method: String, params: JSONObject): JSONObject {
    return requestStreaming(deviceId, method, params) {}
  }

  suspend fun request(deviceId: String, method: String): JSONObject = request(deviceId, method, JSONObject())

  suspend fun requestStreaming(
    deviceId: String,
    method: String,
    params: JSONObject = JSONObject(),
    onEvent: (JSONObject) -> Unit,
  ): JSONObject {
    val computer = computerStore.get(deviceId) ?: error("Computer is not paired")
    require(scopeFor(method) in computer.scopes) { "Paired computer scope does not allow $method" }
    val identity = identityManager.loadOrCreate()
    val unsigned = JSONObject()
      .put("version", 2)
      .put("id", UUID.randomUUID().toString())
      .put("method", method)
      .put("params", params)
    val auth = JSONObject()
      .put("deviceId", identity.deviceId)
      .put("sequence", computerStore.nextSequence(deviceId))
      .put("nonce", nonce())
      .put("issuedAt", Instant.now().toString())
    val signaturePayload = JSONObject(unsigned.toString()).put("auth", auth)
    val request = JSONObject(unsigned.toString()).put(
      "auth",
      JSONObject(auth.toString()).put("signature", identityManager.sign(signaturePayload, identity)),
    )
    val response = PinnedWssRpc(identity, computer.certificateFingerprint)
      .request(wssUrl(computer.address, computer.port), request, onEvent)
    return response.optJSONObject("result") ?: JSONObject().put("value", response.opt("result"))
  }

  suspend fun initialize(deviceId: String): JSONObject {
    val computer = computerStore.get(deviceId) ?: error("Computer is not paired")
    val identity = identityManager.loadOrCreate()
    val request = JSONObject()
      .put("version", 2)
      .put("id", UUID.randomUUID().toString())
      .put("method", "initialize")
      .put("params", JSONObject())
    val response = PinnedWssRpc(identity, computer.certificateFingerprint)
      .request(wssUrl(computer.address, computer.port), request)
    return response.getJSONObject("result")
  }

  private fun nonce(): String = ByteArray(24).also(SecureRandom()::nextBytes).let {
    Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  }

  private fun scopeFor(method: String) = when {
    method.matches(Regex("^(capability/list|session/(list|tree|open|snapshot|items|close))$")) -> "session:browse"
    method.matches(Regex("^(session/(create|send|copy)|diff/.*|checkpoint/.*|goal/.*)$")) -> "session:send"
    method.startsWith("approval/") -> "approval:respond"
    method.startsWith("artifact/") || method.startsWith("workspace/inbox/") -> "file:transfer"
    method.startsWith("audio/note/") -> "microphone"
    method.startsWith("audio/live/") -> "audio:live"
    else -> ""
  }

  private fun wssUrl(host: String, port: Int): String {
    val formatted = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
    return "wss://$formatted:$port"
  }
}
