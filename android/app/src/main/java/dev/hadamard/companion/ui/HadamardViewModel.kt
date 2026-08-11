package dev.hadamard.companion.ui

import android.app.Application
import android.content.Intent
import android.app.Activity
import android.media.projection.MediaProjectionManager
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
import dev.hadamard.companion.devicelink.ArtifactManifest
import dev.hadamard.companion.devicelink.ArtifactTransferClient
import dev.hadamard.companion.devicelink.DiscoveredComputer
import dev.hadamard.companion.devicelink.NsdDeviceDiscovery
import dev.hadamard.companion.devicelink.PairedComputer
import dev.hadamard.companion.devicelink.PairedComputerStore
import dev.hadamard.companion.devicelink.PairingClient
import dev.hadamard.companion.devicelink.MobileInboxItem
import dev.hadamard.companion.devicelink.MobileInboxStore
import dev.hadamard.companion.devicelink.RemoteSessionCache
import dev.hadamard.companion.devicelink.RemoteSessionParser
import dev.hadamard.companion.devicelink.RemoteSessionSummary
import dev.hadamard.companion.document.MarkdownTools
import dev.hadamard.companion.document.OcrService
import dev.hadamard.companion.document.PdfTools
import dev.hadamard.companion.model.OfflineCapabilities
import dev.hadamard.companion.model.ArtifactRecord
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.ProviderConfiguration
import dev.hadamard.companion.model.SessionMessage
import dev.hadamard.companion.model.SessionRecord
import dev.hadamard.companion.web.PageTools
import dev.hadamard.companion.web.SecureWebFetcher
import dev.hadamard.companion.workspace.AppPrivateWorkspace
import dev.hadamard.companion.workspace.SafWorkspace
import dev.hadamard.companion.workspace.WorkspacePort
import dev.hadamard.companion.workspace.WorkspaceTools
import dev.hadamard.companion.data.readWithOverflowByte
import dev.hadamard.companion.media.AudioCaptureState
import dev.hadamard.companion.media.AudioCaptureKind
import dev.hadamard.companion.media.AudioCaptureStatus
import dev.hadamard.companion.media.OpenAiTranscriptionClient
import dev.hadamard.companion.media.PcmFileSink
import dev.hadamard.companion.media.SystemAudioFeatureFlag
import dev.hadamard.companion.media.SystemPlaybackCapture
import dev.hadamard.companion.media.VoiceNoteRecorder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import java.io.File

enum class MobileScreen { HOME, PHONE, COMPUTERS, TRANSFERS, SETTINGS }

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
  val remoteOutbox: Map<String, List<ArtifactManifest>> = emptyMap(),
  val inbox: List<MobileInboxItem> = emptyList(),
  val artifacts: List<ArtifactRecord> = emptyList(),
  val provider: ProviderConfiguration? = null,
  val workspaceLabel: String = "App-private workspace",
  val offlineCapabilities: OfflineCapabilities = OfflineCapabilities(),
  val isRunning: Boolean = false,
  val audioCapture: AudioCaptureState = AudioCaptureState(),
  val systemAudioEnabled: Boolean = false,
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
  private val inboxStore = MobileInboxStore(application)
  private val transferClient = ArtifactTransferClient(deviceClient, inboxStore)
  private val remoteCache = RemoteSessionCache(app.database, deviceClient)
  private val pairingClient = PairingClient(identityManager, computerStore)
  private val discovery = NsdDeviceDiscovery(application)
  private val permissionBroker = InteractivePermissionBroker()
  private val voiceRecorder = VoiceNoteRecorder(application)
  private val systemAudioFlag = SystemAudioFeatureFlag(application)
  private val systemAudioCapture = SystemPlaybackCapture(systemAudioFlag)
  private var systemAudioSink: PcmFileSink? = null
  private var systemAudioProjection: android.media.projection.MediaProjection? = null
  private var runningJob: Job? = null
  private var discoveryJob: Job? = null

  private val _state = MutableStateFlow(
    MobileUiState(
      sessions = app.database.listSessions(),
      pairedComputers = computerStore.list(),
      provider = providerStore.enabled(),
      workspaceLabel = if (workspace is SafWorkspace) "User-selected document tree" else "App-private workspace",
      inbox = inboxStore.list(),
      artifacts = app.database.listArtifacts(),
      systemAudioEnabled = systemAudioFlag.enabled(),
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

  fun refreshRemoteOutbox(deviceId: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = "Checking computer outbox") }
      runCatching { transferClient.remoteOutbox(deviceId) }
        .onSuccess { items -> _state.update { it.copy(remoteOutbox = it.remoteOutbox + (deviceId to items), status = "${items.size} files available") } }
        .onFailure { setStatus(it.message ?: "Could not load computer outbox") }
    }
  }

  fun downloadFromComputer(deviceId: String, manifest: ArtifactManifest) {
    viewModelScope.launch {
      _state.update { it.copy(status = "Downloading into verified phone inbox") }
      runCatching { transferClient.download(deviceId, manifest) }
        .onSuccess { _state.update { it.copy(inbox = inboxStore.list(), status = "Verified in inbox; workspace is unchanged") } }
        .onFailure { setStatus(it.message ?: "File download failed") }
    }
  }

  fun commitInbox(item: MobileInboxItem) {
    viewModelScope.launch {
      runCatching { transferClient.commitAndAcknowledge(item, workspace, confirm = true) }
        .onSuccess { document -> _state.update { it.copy(inbox = inboxStore.list(), status = "Committed ${document.displayName} to the selected workspace") } }
        .onFailure { setStatus(it.message ?: "Inbox commit failed") }
    }
  }

  fun uploadToComputer(deviceId: String, uri: Uri) {
    viewModelScope.launch {
      _state.update { it.copy(status = "Uploading with resumable chunks") }
      runCatching {
        require(uri.scheme == "content") { "Only a user-selected document can be sent" }
        val resolver = getApplication<Application>().contentResolver
        val bytes = resolver.openInputStream(uri)?.use { it.readWithOverflowByte((32 * 1_048_576)) }
          ?: error("Selected document is unavailable")
        require(bytes.size <= 32 * 1_048_576) { "Selected document exceeds 32 MiB" }
        val name = queryDisplayName(uri) ?: "mobile-${System.currentTimeMillis()}.bin"
        transferClient.upload(deviceId, name, resolver.getType(uri) ?: "application/octet-stream", bytes)
      }.onSuccess { setStatus("Uploaded ${it.name}; desktop must confirm before workspace commit") }
        .onFailure { setStatus(it.message ?: "File upload failed") }
    }
  }

  fun startVoiceNote() {
    runCatching { voiceRecorder.start() }
      .onSuccess { capture -> _state.update { it.copy(audioCapture = capture, status = capture.visibleLabel) } }
      .onFailure { setStatus(it.message ?: "Could not start microphone") }
  }

  fun stopVoiceNote() {
    viewModelScope.launch {
      runCatching {
        val file = voiceRecorder.stop()
        val sessionId = _state.value.selectedSessionId?.takeIf { app.database.session(it)?.readOnly == false }
        val audio = app.artifactStore.put(file.name, "audio/mp4", file.readBytes(), sessionId)
        app.database.upsertArtifact(audio)
        sessionId?.let { appendArtifactReference(it, "Voice note", audio) }
        val provider = providerStore.enabled()
        val transcriptionError = provider?.let {
          runCatching {
            val text = OpenAiTranscriptionClient(it, app.credentialVault).transcribe(file)
            val transcript = app.artifactStore.put(
              "${file.nameWithoutExtension}.transcript.md",
              "text/markdown",
              text.toByteArray(),
              sessionId,
            )
            app.database.upsertArtifact(transcript)
            sessionId?.let { id -> appendArtifactReference(id, "Voice transcript: ${text.take(240)}", transcript) }
          }.exceptionOrNull()
        }
        file.delete()
        audio to transcriptionError
      }.onSuccess { (_, transcriptionError) ->
        _state.update {
          it.copy(
            audioCapture = AudioCaptureState(),
            artifacts = app.database.listArtifacts(),
            transcript = it.selectedSessionId?.let(app.database::messages).orEmpty(),
            status = when {
              transcriptionError != null -> "Voice note saved; transcription failed: ${transcriptionError.message}"
              providerStore.enabled() == null -> "Voice note saved; configure a provider to transcribe"
              else -> "Voice note and transcript saved"
            },
          )
        }
      }.onFailure { error ->
        _state.update { it.copy(audioCapture = AudioCaptureState(), status = error.message ?: "Voice note failed") }
      }
    }
  }

  fun cancelVoiceNote() {
    voiceRecorder.cancel()
    _state.update { it.copy(audioCapture = AudioCaptureState(), status = "Voice note discarded; microphone stopped") }
  }

  fun enforceAudioPermission(granted: Boolean) {
    if (granted || _state.value.audioCapture.status == AudioCaptureStatus.IDLE) return
    when (_state.value.audioCapture.kind) {
      AudioCaptureKind.VOICE_NOTE -> voiceRecorder.cancel()
      AudioCaptureKind.SYSTEM_PLAYBACK -> {
        systemAudioCapture.stop()
        systemAudioProjection?.stop()
        systemAudioProjection = null
        systemAudioSink?.close()?.delete()
        systemAudioSink = null
      }
      else -> Unit
    }
    _state.update { it.copy(audioCapture = AudioCaptureState(), status = "Audio permission was revoked; capture stopped immediately") }
  }

  fun setSystemAudioEnabled(enabled: Boolean) {
    if (!enabled) stopSystemAudio()
    systemAudioFlag.setEnabled(enabled)
    _state.update { it.copy(systemAudioEnabled = enabled, status = if (enabled) "System audio capture enabled; MediaProjection approval is still required" else "System audio capture disabled") }
  }

  fun startSystemAudio(resultCode: Int, data: Intent?) {
    if (resultCode != Activity.RESULT_OK || data == null) return setStatus("System audio permission was not granted")
    runCatching {
      require(systemAudioFlag.enabled()) { "Enable system audio capture first" }
      val manager = getApplication<Application>().getSystemService(MediaProjectionManager::class.java)
      val projection = manager.getMediaProjection(resultCode, data)
      val target = File(getApplication<Application>().filesDir, "system-audio-${UUID.randomUUID()}.pcm")
      val sink = PcmFileSink(target)
      try {
        systemAudioCapture.start(projection, sink::accept)
      } catch (error: Throwable) {
        sink.close().delete()
        projection.stop()
        throw error
      }
      systemAudioProjection = projection
      systemAudioSink = sink
      _state.update {
        it.copy(
          audioCapture = AudioCaptureState(AudioCaptureKind.SYSTEM_PLAYBACK, AudioCaptureStatus.RECORDING, System.currentTimeMillis(), "Capturing system playback · tap Stop"),
          status = "System playback capture is visible and active",
        )
      }
    }.onFailure { setStatus(it.message ?: "System playback capture failed") }
  }

  fun stopSystemAudio() {
    systemAudioCapture.stop()
    systemAudioProjection?.stop()
    systemAudioProjection = null
    val file = systemAudioSink?.close()
    systemAudioSink = null
    if (file != null && file.length() > 0) {
      val sessionId = _state.value.selectedSessionId?.takeIf { app.database.session(it)?.readOnly == false }
      val artifact = app.artifactStore.put(file.name, "audio/L16", file.readBytes(), sessionId)
      app.database.upsertArtifact(artifact)
      file.delete()
    } else file?.delete()
    _state.update { it.copy(audioCapture = AudioCaptureState(), artifacts = app.database.listArtifacts(), status = "System audio capture stopped") }
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

  private fun queryDisplayName(uri: Uri): String? {
    return getApplication<Application>().contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
  }

  private fun appendArtifactReference(sessionId: String, label: String, artifact: ArtifactRecord) {
    app.database.appendMessage(
      SessionMessage(
        sessionId,
        app.database.nextSequence(sessionId),
        MessageRole.USER,
        "$label\nartifact:${artifact.id}\nsha256:${artifact.sha256}",
        null,
        System.currentTimeMillis(),
      ),
    )
  }

  override fun onCleared() {
    voiceRecorder.cancel()
    systemAudioCapture.stop()
    systemAudioProjection?.stop()
    systemAudioSink?.close()?.delete()
    systemAudioProjection = null
    systemAudioSink = null
    super.onCleared()
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
