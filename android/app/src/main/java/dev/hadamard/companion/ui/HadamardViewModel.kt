package dev.hadamard.companion.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.hadamard.companion.HadamardApplication
import dev.hadamard.companion.agent.MobileAgentLoop
import dev.hadamard.companion.agent.OpenAiCompatibleProvider
import dev.hadamard.companion.agent.ProviderConfigStore
import dev.hadamard.companion.capability.MobileCapabilityRegistry
import dev.hadamard.companion.capability.MobilePermissionBroker
import dev.hadamard.companion.capability.MobileToolContext
import dev.hadamard.companion.capability.MobileToolDefinition
import dev.hadamard.companion.devicelink.DeviceIdentityManager
import dev.hadamard.companion.devicelink.DeviceLinkClient
import dev.hadamard.companion.devicelink.DiscoveredComputer
import dev.hadamard.companion.devicelink.NsdDeviceDiscovery
import dev.hadamard.companion.devicelink.PairedComputer
import dev.hadamard.companion.devicelink.PairedComputerStore
import dev.hadamard.companion.devicelink.PairingClient
import dev.hadamard.companion.devicelink.RemoteSessionCache
import dev.hadamard.companion.devicelink.RemoteSessionParser
import dev.hadamard.companion.devicelink.RemoteSessionSummary
import dev.hadamard.companion.document.MarkdownTools
import dev.hadamard.companion.document.OcrService
import dev.hadamard.companion.document.PdfTools
import dev.hadamard.companion.model.OfflineCapabilities
import dev.hadamard.companion.model.ProviderConfiguration
import dev.hadamard.companion.model.SessionMessage
import dev.hadamard.companion.model.SessionRecord
import dev.hadamard.companion.web.PageTools
import dev.hadamard.companion.web.SecureWebFetcher
import dev.hadamard.companion.workspace.AppPrivateWorkspace
import dev.hadamard.companion.workspace.SafWorkspace
import dev.hadamard.companion.workspace.WorkspacePort
import dev.hadamard.companion.workspace.WorkspaceTools
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

enum class MobileScreen { HOME, PHONE, COMPUTERS, SETTINGS }

data class PermissionRequest(
  val tool: MobileToolDefinition,
  val argumentsSummary: String,
  val context: MobileToolContext,
)

data class MobileUiState(
  val screen: MobileScreen = MobileScreen.HOME,
  val sessions: List<SessionRecord> = emptyList(),
  val selectedSessionId: String? = null,
  val transcript: List<SessionMessage> = emptyList(),
  val pairedComputers: List<PairedComputer> = emptyList(),
  val discoveredComputers: List<DiscoveredComputer> = emptyList(),
  val remoteSessions: Map<String, List<RemoteSessionSummary>> = emptyMap(),
  val provider: ProviderConfiguration? = null,
  val workspaceLabel: String = "App-private workspace",
  val offlineCapabilities: OfflineCapabilities = OfflineCapabilities(),
  val isRunning: Boolean = false,
  val status: String? = null,
  val permissionRequest: PermissionRequest? = null,
)

class HadamardViewModel(application: Application) : AndroidViewModel(application) {
  private val app = application as HadamardApplication
  private var workspace: WorkspacePort = loadWorkspace(application)
  private val providerStore = ProviderConfigStore(application)
  private val computerStore = PairedComputerStore(application)
  private val identityManager = DeviceIdentityManager(application, app.credentialVault)
  private val deviceClient = DeviceLinkClient(identityManager, computerStore)
  private val remoteCache = RemoteSessionCache(app.database, deviceClient)
  private val pairingClient = PairingClient(identityManager, computerStore)
  private val discovery = NsdDeviceDiscovery(application)
  private val permissionBroker = InteractivePermissionBroker()
  private var runningJob: Job? = null
  private var discoveryJob: Job? = null

  private val _state = MutableStateFlow(
    MobileUiState(
      sessions = app.database.listSessions(),
      pairedComputers = computerStore.list(),
      provider = providerStore.enabled(),
      workspaceLabel = if (workspace is SafWorkspace) "User-selected document tree" else "App-private workspace",
    ),
  )
  val state: StateFlow<MobileUiState> = _state.asStateFlow()

  init {
    viewModelScope.launch {
      permissionBroker.requests.collect { request -> _state.update { it.copy(permissionRequest = request) } }
    }
  }

  fun navigate(screen: MobileScreen) {
    _state.update { it.copy(screen = screen, status = null) }
  }

  fun createSession() {
    val now = System.currentTimeMillis()
    val session = SessionRecord(
      id = UUID.randomUUID().toString(),
      title = "New mobile session",
      createdAt = now,
      updatedAt = now,
      revision = 0,
    )
    app.database.upsertSession(session)
    selectSession(session.id)
  }

  fun selectSession(id: String) {
    _state.update {
      it.copy(
        selectedSessionId = id,
        transcript = app.database.messages(id),
        sessions = app.database.listSessions(),
      )
    }
  }

  fun send(prompt: String) {
    if (runningJob != null || prompt.isBlank()) return
    val sessionId = _state.value.selectedSessionId ?: return setStatus("Create or select a phone session first")
    val configuration = providerStore.enabled() ?: return setStatus("Configure a mobile LLM provider first")
    runningJob = viewModelScope.launch {
      _state.update { it.copy(isRunning = true, status = "Agent is working on this phone") }
      runCatching {
        val tools = WorkspaceTools(workspace).all() +
          MarkdownTools(workspace).all() +
          PdfTools(getApplication(), workspace, OcrService()).all() +
          PageTools(getApplication(), workspace, SecureWebFetcher()).all()
        val registry = MobileCapabilityRegistry(tools, permissionBroker)
        MobileAgentLoop(
          app.database,
          OpenAiCompatibleProvider(configuration, app.credentialVault),
          registry,
        ).run(sessionId, prompt)
      }.onSuccess { result -> setStatus("Completed in ${result.iterations} turns · ${result.toolCalls} tool calls") }
        .onFailure { error -> setStatus(error.message ?: "Agent run failed") }
      _state.update {
        it.copy(
          isRunning = false,
          transcript = app.database.messages(sessionId),
          sessions = app.database.listSessions(),
        )
      }
      runningJob = null
    }
  }

  fun cancelRun() {
    runningJob?.cancel()
    runningJob = null
    _state.update { it.copy(isRunning = false, status = "Agent run cancelled; checkpoint retained") }
  }

  fun resolvePermission(approved: Boolean) {
    permissionBroker.resolve(approved)
    _state.update { it.copy(permissionRequest = null) }
  }

  fun saveProvider(displayName: String, endpoint: String, model: String, apiKey: String) {
    runCatching {
      val alias = "provider.mobile.default"
      if (apiKey.isNotBlank()) app.credentialVault.put(alias, apiKey)
      val configuration = ProviderConfiguration(
        id = "mobile-default",
        displayName = displayName.trim().ifBlank { "Mobile provider" },
        endpoint = endpoint.trim(),
        model = model.trim(),
        apiKeyAlias = alias,
        enabled = true,
      )
      providerStore.save(configuration)
      _state.update { it.copy(provider = configuration, status = "Provider saved in this phone's Keystore") }
    }.onFailure { setStatus(it.message ?: "Provider configuration is invalid") }
  }

  fun selectSafWorkspace(uri: Uri) {
    runCatching {
      require(uri.scheme == "content") { "Document tree must use a content URI" }
      getApplication<Application>().contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      val selected = SafWorkspace(getApplication(), uri)
      getApplication<Application>().getSharedPreferences(WORKSPACE_PREFERENCES, 0)
        .edit().putString(WORKSPACE_URI, uri.toString()).apply()
      workspace = selected
      _state.update { it.copy(workspaceLabel = "User-selected document tree", status = "Mobile workspace permission saved") }
    }.onFailure { setStatus(it.message ?: "Could not select this document tree") }
  }

  fun useAppPrivateWorkspace() {
    workspace = AppPrivateWorkspace(getApplication())
    getApplication<Application>().getSharedPreferences(WORKSPACE_PREFERENCES, 0).edit().remove(WORKSPACE_URI).apply()
    _state.update { it.copy(workspaceLabel = "App-private workspace", status = "Using app-private mobile workspace") }
  }

  fun startDiscovery() {
    if (discoveryJob != null) return
    _state.update { it.copy(discoveredComputers = emptyList(), status = "Searching this LAN") }
    discoveryJob = viewModelScope.launch {
      discovery.discover()
        .catch { setStatus(it.message ?: "LAN discovery failed") }
        .collect { computer ->
          _state.update { state ->
            state.copy(
              discoveredComputers = (state.discoveredComputers.filterNot { it.deviceId == computer.deviceId } + computer),
              status = "LAN discovery active",
            )
          }
        }
    }
  }

  fun stopDiscovery() {
    discoveryJob?.cancel()
    discoveryJob = null
    setStatus("LAN discovery stopped")
  }

  fun pair(uri: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = "Verifying signed pairing offer") }
      runCatching {
        pairingClient.pair(uri, listOf("session:browse", "session:send", "file:transfer"))
      }.onSuccess {
        _state.update { state ->
          state.copy(pairedComputers = computerStore.list(), status = "Paired with ${it.name}")
        }
      }.onFailure { setStatus(it.message ?: "Pairing failed") }
    }
  }

  fun revokeComputer(deviceId: String) {
    computerStore.revoke(deviceId)
    app.trustStore.revoke(deviceId)
    _state.update { it.copy(pairedComputers = computerStore.list(), status = "Computer revoked on this phone") }
  }

  fun refreshRemoteSession(deviceId: String, sessionId: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = "Downloading a read-only session snapshot") }
      runCatching { remoteCache.refresh(deviceId, sessionId) }
        .onSuccess { session ->
          _state.update { it.copy(sessions = app.database.listSessions(), status = "Remote session cached for offline reading") }
          selectSession(session.id)
        }
        .onFailure { setStatus(it.message ?: "Remote session refresh failed") }
    }
  }

  fun browseRemoteSessions(deviceId: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = "Loading sessions from paired computer") }
      runCatching {
        val result = deviceClient.request(deviceId, "session/list")
        RemoteSessionParser.parse(result)
      }.onSuccess { sessions ->
        _state.update { it.copy(remoteSessions = it.remoteSessions + (deviceId to sessions), status = "${sessions.size} remote sessions available") }
      }.onFailure { setStatus(it.message ?: "Could not browse remote sessions") }
    }
  }

  fun copyRemoteSession(cacheSessionId: String) {
    runCatching { remoteCache.copyToPhone(cacheSessionId) }
      .onSuccess { selectSession(it.id); setStatus("Created an independent phone copy; source will not be written back") }
      .onFailure { setStatus(it.message ?: "Session copy failed") }
  }

  fun setStatus(message: String) {
    _state.update { it.copy(status = message) }
  }

  private fun loadWorkspace(application: Application): WorkspacePort {
    val uri = application.getSharedPreferences(WORKSPACE_PREFERENCES, 0).getString(WORKSPACE_URI, null)
      ?.let(Uri::parse)
    return if (uri != null) runCatching { SafWorkspace(application, uri) }.getOrElse {
      application.getSharedPreferences(WORKSPACE_PREFERENCES, 0).edit().remove(WORKSPACE_URI).apply()
      AppPrivateWorkspace(application)
    } else AppPrivateWorkspace(application)
  }

  companion object {
    private const val WORKSPACE_PREFERENCES = "hadamard_workspace_selection"
    private const val WORKSPACE_URI = "tree_uri"
  }
}

private class InteractivePermissionBroker : MobilePermissionBroker {
  private val _requests = MutableStateFlow<PermissionRequest?>(null)
  val requests: StateFlow<PermissionRequest?> = _requests.asStateFlow()
  private var pending: CompletableDeferred<Boolean>? = null

  override suspend fun approve(
    tool: MobileToolDefinition,
    argumentsSummary: String,
    context: MobileToolContext,
  ): Boolean {
    check(pending == null) { "Another mobile permission decision is pending" }
    val decision = CompletableDeferred<Boolean>()
    pending = decision
    _requests.value = PermissionRequest(tool, argumentsSummary, context)
    return try {
      decision.await()
    } finally {
      pending = null
      _requests.value = null
    }
  }

  fun resolve(approved: Boolean) {
    pending?.complete(approved)
  }
}
