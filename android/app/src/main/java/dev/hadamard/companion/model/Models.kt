package dev.hadamard.companion.model

data class SessionOrigin(
  val deviceId: String,
  val sessionId: String,
  val revision: Long,
)

data class SessionRecord(
  val id: String,
  val title: String,
  val createdAt: Long,
  val updatedAt: Long,
  val revision: Long,
  val readOnly: Boolean = false,
  val origin: SessionOrigin? = null,
)

enum class MessageRole { USER, ASSISTANT, TOOL }

data class SessionMessage(
  val sessionId: String,
  val sequence: Long,
  val role: MessageRole,
  val content: String,
  val toolCallId: String? = null,
  val createdAt: Long,
)

data class ArtifactRecord(
  val id: String,
  val sessionId: String?,
  val displayName: String,
  val mediaType: String,
  val size: Long,
  val sha256: String,
  val localPath: String,
  val createdAt: Long,
)

data class ProviderConfiguration(
  val id: String,
  val displayName: String,
  val endpoint: String,
  val model: String,
  val apiKeyAlias: String,
  val enabled: Boolean,
)

data class AgentToolCall(
  val id: String,
  val name: String,
  val argumentsJson: String,
)

data class AgentToolResult(
  val toolCallId: String,
  val content: String,
  val isError: Boolean,
)

data class AgentTurn(
  val text: String,
  val toolCalls: List<AgentToolCall>,
)

data class AgentCheckpoint(
  val sessionId: String,
  val generation: Long,
  val nextIteration: Int,
  val stateJson: String,
  val updatedAt: Long,
)

data class OfflineCapabilities(
  val workspace: Boolean = true,
  val markdown: Boolean = true,
  val pdfRender: Boolean = true,
  val bundledOcr: Boolean = true,
  val pagePreview: Boolean = true,
  val agentReasoning: Boolean = false,
)
