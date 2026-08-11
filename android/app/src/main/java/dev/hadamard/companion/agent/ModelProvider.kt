package dev.hadamard.companion.agent

import dev.hadamard.companion.capability.MobileToolDefinition
import dev.hadamard.companion.model.AgentTurn

data class ProviderMessage(
  val role: String,
  val content: String,
  val toolCallId: String? = null,
  val toolCallsJson: String? = null,
)

fun interface ModelProvider {
  suspend fun complete(messages: List<ProviderMessage>, tools: List<MobileToolDefinition>): AgentTurn
}
