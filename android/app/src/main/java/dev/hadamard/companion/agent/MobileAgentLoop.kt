package dev.hadamard.companion.agent

import dev.hadamard.companion.capability.MobileCapabilityRegistry
import dev.hadamard.companion.capability.MobileToolContext
import dev.hadamard.companion.data.MobileDatabase
import dev.hadamard.companion.model.AgentCheckpoint
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.SessionMessage
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject

data class MobileAgentRunResult(
  val finalText: String,
  val iterations: Int,
  val toolCalls: Int,
)

class MobileAgentLoop(
  private val database: MobileDatabase,
  private val provider: ModelProvider,
  private val capabilities: MobileCapabilityRegistry,
  private val maxIterations: Int = 12,
) {
  init {
    require(maxIterations in 1..32) { "Mobile Agent iteration limit must be 1..32" }
  }

  suspend fun run(sessionId: String, userPrompt: String): MobileAgentRunResult {
    require(userPrompt.isNotBlank()) { "Prompt is required" }
    val session = database.session(sessionId) ?: error("Session does not exist")
    check(!session.readOnly) { "Remote cached sessions must be copied before running the local Agent" }
    append(sessionId, MessageRole.USER, userPrompt)
    var calls = 0
    repeat(maxIterations) { iteration ->
      currentCoroutineContext().ensureActive()
      database.saveCheckpoint(
        AgentCheckpoint(
          sessionId,
          generation = session.revision + 1,
          nextIteration = iteration,
          stateJson = JSONObject().put("status", "awaiting_model").put("toolCalls", calls).toString(),
          updatedAt = System.currentTimeMillis(),
        ),
      )
      val turn = provider.complete(conversationWindow(sessionId), capabilities.definitions())
      currentCoroutineContext().ensureActive()
      if (turn.toolCalls.isEmpty()) {
        val finalText = turn.text.ifBlank { "The model returned no answer." }
        append(sessionId, MessageRole.ASSISTANT, finalText)
        database.clearCheckpoint(sessionId)
        return MobileAgentRunResult(finalText, iteration + 1, calls)
      }
      val toolCallsJson = JSONArray(turn.toolCalls.map { call ->
        JSONObject()
          .put("id", call.id)
          .put("type", "function")
          .put("function", JSONObject().put("name", call.name).put("arguments", call.argumentsJson))
      }).toString()
      append(
        sessionId,
        MessageRole.ASSISTANT,
        JSONObject().put("text", turn.text).put("toolCalls", JSONArray(toolCallsJson)).toString(),
      )
      turn.toolCalls.forEach { call ->
        currentCoroutineContext().ensureActive()
        val result = runCatching {
          capabilities.call(
            call.name,
            call.argumentsJson,
            MobileToolContext(sessionId = sessionId, foreground = true),
          )
        }
        append(
          sessionId,
          MessageRole.TOOL,
          result.fold(onSuccess = { it }, onFailure = { "Tool error: ${it.message}" }),
          toolCallId = call.id,
        )
        calls += 1
      }
      database.saveCheckpoint(
        AgentCheckpoint(
          sessionId,
          generation = session.revision + 1,
          nextIteration = iteration + 1,
          stateJson = JSONObject().put("status", "tools_completed").put("toolCalls", calls).toString(),
          updatedAt = System.currentTimeMillis(),
        ),
      )
    }
    database.clearCheckpoint(sessionId)
    error("Mobile Agent reached its $maxIterations iteration safety limit")
  }

  fun checkpoint(sessionId: String): AgentCheckpoint? = database.checkpoint(sessionId)

  private fun append(sessionId: String, role: MessageRole, content: String, toolCallId: String? = null) {
    database.appendMessage(
      SessionMessage(
        sessionId = sessionId,
        sequence = database.nextSequence(sessionId),
        role = role,
        content = content.take(MAX_STORED_CHARS),
        toolCallId = toolCallId,
        createdAt = System.currentTimeMillis(),
      ),
    )
  }

  private fun conversationWindow(sessionId: String): List<ProviderMessage> {
    val all = database.messages(sessionId)
    val retained = all.takeLast(MAX_PROVIDER_MESSAGES)
    val prefix = if (retained.size < all.size) {
      listOf(
        ProviderMessage(
          role = "system",
          content = "Earlier transcript compacted locally: ${all.size - retained.size} messages omitted. " +
            "No tool result in the retained window is detached from its call.",
        ),
      )
    } else emptyList()
    val safeStart = retained.indexOfFirst { it.role != MessageRole.TOOL }.coerceAtLeast(0)
    return prefix + retained.drop(safeStart).mapNotNull(::toProviderMessage)
  }

  private fun toProviderMessage(message: SessionMessage): ProviderMessage? = when (message.role) {
    MessageRole.USER -> ProviderMessage("user", message.content)
    MessageRole.TOOL -> message.toolCallId?.let { ProviderMessage("tool", message.content, toolCallId = it) }
    MessageRole.ASSISTANT -> {
      val structured = runCatching { JSONObject(message.content) }.getOrNull()
      val calls = structured?.optJSONArray("toolCalls")
      if (calls != null) ProviderMessage(
        role = "assistant",
        content = structured.optString("text"),
        toolCallsJson = calls.toString(),
      ) else ProviderMessage("assistant", message.content)
    }
  }

  companion object {
    private const val MAX_PROVIDER_MESSAGES = 64
    private const val MAX_STORED_CHARS = 1_000_000
  }
}
