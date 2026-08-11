package dev.hadamard.companion.capability

data class MobileToolDefinition(
  val name: String,
  val description: String,
  val inputSchemaJson: String,
  val permission: MobilePermission,
)

enum class MobilePermission { READ_WORKSPACE, WRITE_WORKSPACE, NETWORK, OPEN_EXTERNAL, OCR }

data class MobileToolContext(
  val sessionId: String,
  val foreground: Boolean,
)

interface MobileTool {
  val definition: MobileToolDefinition
  suspend fun execute(argumentsJson: String, context: MobileToolContext): String
}

fun interface MobilePermissionBroker {
  suspend fun approve(tool: MobileToolDefinition, argumentsSummary: String, context: MobileToolContext): Boolean
}

class MobileCapabilityRegistry(
  tools: List<MobileTool>,
  private val permissionBroker: MobilePermissionBroker,
) {
  private val toolsByName = tools.associateBy { it.definition.name }.also {
    require(it.size == tools.size) { "Mobile tool names must be unique" }
  }

  fun definitions(): List<MobileToolDefinition> = toolsByName.values.map { it.definition }

  suspend fun call(name: String, argumentsJson: String, context: MobileToolContext): String {
    val tool = toolsByName[name] ?: error("Unknown mobile capability: $name")
    val summary = argumentsJson.take(320)
    check(permissionBroker.approve(tool.definition, summary, context)) { "Permission denied for $name" }
    return tool.execute(argumentsJson, context)
  }
}
