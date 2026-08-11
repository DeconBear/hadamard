package dev.hadamard.companion.agent

import dev.hadamard.companion.capability.MobileToolDefinition
import dev.hadamard.companion.model.AgentToolCall
import dev.hadamard.companion.model.AgentTurn
import dev.hadamard.companion.model.ProviderConfiguration
import dev.hadamard.companion.security.CredentialVault
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class OpenAiCompatibleProvider(
  private val configuration: ProviderConfiguration,
  private val vault: CredentialVault,
  private val client: OkHttpClient = OkHttpClient(),
) : ModelProvider {
  override suspend fun complete(
    messages: List<ProviderMessage>,
    tools: List<MobileToolDefinition>,
  ): AgentTurn {
    val apiKey = vault.get(configuration.apiKeyAlias)
      ?: error("Provider credential is not configured on this phone")
    val payload = JSONObject()
      .put("model", configuration.model)
      .put("messages", JSONArray(messages.map(::messageJson)))
      .put("stream", false)
    if (tools.isNotEmpty()) payload.put("tools", JSONArray(tools.map(::toolJson)))
    val request = Request.Builder()
      .url(chatCompletionsUrl(configuration.endpoint))
      .header("Authorization", "Bearer $apiKey")
      .header("Accept", "application/json")
      .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
      .build()
    val responseBody = execute(request)
    val root = JSONObject(responseBody)
    root.optJSONObject("error")?.let { error(it.optString("message", "Provider request failed")) }
    val message = root.getJSONArray("choices").getJSONObject(0).getJSONObject("message")
    val calls = message.optJSONArray("tool_calls") ?: JSONArray()
    return AgentTurn(
      text = message.optString("content").take(MAX_TEXT_CHARS),
      toolCalls = buildList {
        repeat(calls.length()) { index ->
          val call = calls.getJSONObject(index)
          val function = call.getJSONObject("function")
          add(
            AgentToolCall(
              id = call.getString("id"),
              name = function.getString("name"),
              argumentsJson = function.optString("arguments", "{}").take(MAX_ARGUMENT_CHARS),
            ),
          )
        }
      },
    )
  }

  private fun messageJson(message: ProviderMessage) = JSONObject()
    .put("role", message.role)
    .put("content", message.content)
    .also { json -> message.toolCallId?.let { json.put("tool_call_id", it) } }
    .also { json -> message.toolCallsJson?.let { json.put("tool_calls", JSONArray(it)) } }

  private fun toolJson(tool: MobileToolDefinition) = JSONObject()
    .put("type", "function")
    .put(
      "function",
      JSONObject()
        .put("name", tool.name)
        .put("description", tool.description)
        .put("parameters", runCatching { JSONObject(tool.inputSchemaJson) }.getOrElse { JSONObject() }),
    )

  private suspend fun execute(request: Request): String = suspendCancellableCoroutine { continuation ->
    val call = client.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        if (continuation.isActive) continuation.resumeWithException(e)
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val body = it.body?.string() ?: ""
          if (!continuation.isActive) return
          if (!it.isSuccessful) continuation.resumeWithException(
            IOException("Provider returned HTTP ${it.code}: ${body.take(500)}"),
          ) else continuation.resume(body)
        }
      }
    })
  }

  private fun chatCompletionsUrl(endpoint: String): String {
    val trimmed = endpoint.trimEnd('/')
    return if (trimmed.endsWith("/chat/completions")) trimmed else "$trimmed/chat/completions"
  }

  companion object {
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    private const val MAX_TEXT_CHARS = 500_000
    private const val MAX_ARGUMENT_CHARS = 200_000
  }
}
