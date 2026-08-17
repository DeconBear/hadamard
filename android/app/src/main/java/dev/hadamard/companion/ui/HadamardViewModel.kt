package dev.hadamard.companion.ui

import android.app.Application
import android.content.Intent
import android.app.Activity
import android.media.projection.MediaProjectionManager
import android.net.Uri
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.hadamard.companion.HadamardApplication
import dev.hadamard.companion.R
import dev.hadamard.companion.agent.MobileAgentLoop
import dev.hadamard.companion.agent.OpenAiCompatibleProvider
import dev.hadamard.companion.agent.ProviderConfigStore
import dev.hadamard.companion.agent.ProviderQrPayload
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
import dev.hadamard.companion.media.MediaStrings
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
  val languageTag: String = "",
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
      workspaceLabel = res(if (workspace is SafWorkspace) R.string.workspace_saf else R.string.workspace_app_private),
      inbox = inboxStore.list(),
      artifacts = app.database.listArtifacts(),
      systemAudioEnabled = systemAudioFlag.enabled(),
      languageTag = AppLocale.currentTag(application),
    ),
  )
  val state: StateFlow<MobileUiState> = _state.asStateFlow()

  init {
    viewModelScope.launch {
      permissionBroker.requests.collect { request -> _state.update { it.copy(permissionRequest = request) } }
    }
  }

  private fun res(@StringRes id: Int, vararg args: Any): String =
    AppLocale.strings(getApplication()).getString(id, *args)

  private fun mediaStrings() = MediaStrings(
    microphoneOff = res(R.string.media_microphone_off),
    recordingMicrophone = res(R.string.media_recording_microphone),
    stoppingMicrophone = res(R.string.media_stopping_microphone),
    capturingSystemPlayback = res(R.string.media_capturing_system),
  )

  private fun idleAudioCapture() = AudioCaptureState(visibleLabel = res(R.string.media_microphone_off))

  fun navigate(screen: MobileScreen) {
    _state.update { it.copy(screen = screen, status = null) }
  }

  fun setLanguage(tag: String) {
    AppLocale.setTag(getApplication(), tag)
    _state.update {
      it.copy(
        languageTag = tag,
        workspaceLabel = res(if (workspace is SafWorkspace) R.string.workspace_saf else R.string.workspace_app_private),
        audioCapture = if (it.audioCapture.status == AudioCaptureStatus.IDLE) idleAudioCapture() else it.audioCapture,
      )
    }
  }

  fun createSession() {
    val now = System.currentTimeMillis()
    val session = SessionRecord(
      id = UUID.randomUUID().toString(),
      title = res(R.string.new_mobile_session),
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
    val sessionId = _state.value.selectedSessionId ?: return setStatus(res(R.string.status_select_session_first))
    val configuration = providerStore.enabled() ?: return setStatus(res(R.string.status_configure_provider_first))
    runningJob = viewModelScope.launch {
      _state.update { it.copy(isRunning = true, status = res(R.string.status_agent_working)) }
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
      }.onSuccess { result -> setStatus(res(R.string.status_run_completed, result.iterations, result.toolCalls)) }
        .onFailure { error -> setStatus(error.message ?: res(R.string.status_agent_run_failed)) }
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
    _state.update { it.copy(isRunning = false, status = res(R.string.status_run_cancelled)) }
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
        displayName = displayName.trim().ifBlank { res(R.string.provider_default_name) },
        endpoint = endpoint.trim(),
        model = model.trim(),
        apiKeyAlias = alias,
        enabled = true,
      )
      providerStore.save(configuration)
      _state.update { it.copy(provider = configuration, status = res(R.string.status_provider_saved)) }
    }.onFailure { setStatus(it.message ?: res(R.string.status_provider_invalid)) }
  }

  /** Imports a provider scanned from the desktop GUI's static provider QR code. */
  fun importProviderFromQr(contents: String) {
    val parsed = runCatching { ProviderQrPayload.parse(contents) }
      .getOrElse { return setStatus(res(R.string.status_provider_qr_invalid)) }
    saveProvider(parsed.displayName, parsed.endpoint, parsed.model, parsed.apiKey)
  }

  fun selectSafWorkspace(uri: Uri) {
    runCatching {
      require(uri.scheme == "content") { res(R.string.error_document_tree_content_uri) }
      getApplication<Application>().contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      val selected = SafWorkspace(getApplication(), uri)
      getApplication<Application>().getSharedPreferences(WORKSPACE_PREFERENCES, 0)
        .edit().putString(WORKSPACE_URI, uri.toString()).apply()
      workspace = selected
      _state.update { it.copy(workspaceLabel = res(R.string.workspace_saf), status = res(R.string.status_workspace_saved)) }
    }.onFailure { setStatus(it.message ?: res(R.string.status_workspace_select_failed)) }
  }

  fun useAppPrivateWorkspace() {
    workspace = AppPrivateWorkspace(getApplication())
    getApplication<Application>().getSharedPreferences(WORKSPACE_PREFERENCES, 0).edit().remove(WORKSPACE_URI).apply()
    _state.update { it.copy(workspaceLabel = res(R.string.workspace_app_private), status = res(R.string.status_workspace_app_private)) }
  }

  fun startDiscovery() {
    if (discoveryJob != null) return
    _state.update { it.copy(discoveredComputers = emptyList(), status = res(R.string.status_lan_searching)) }
    discoveryJob = viewModelScope.launch {
      discovery.discover()
        .catch { setStatus(it.message ?: res(R.string.status_lan_discovery_failed)) }
        .collect { computer ->
          _state.update { state ->
            state.copy(
              discoveredComputers = (state.discoveredComputers.filterNot { it.deviceId == computer.deviceId } + computer),
              status = res(R.string.status_lan_discovery_active),
            )
          }
        }
    }
  }

  fun stopDiscovery() {
    discoveryJob?.cancel()
    discoveryJob = null
    setStatus(res(R.string.status_lan_discovery_stopped))
  }

  fun pair(uri: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = res(R.string.status_pairing_verifying)) }
      runCatching {
        pairingClient.pair(uri, listOf("session:browse", "session:send", "file:transfer"))
      }.onSuccess {
        _state.update { state ->
          state.copy(pairedComputers = computerStore.list(), status = res(R.string.status_paired_with, it.name))
        }
      }.onFailure { setStatus(it.message ?: res(R.string.status_pairing_failed)) }
    }
  }

  fun revokeComputer(deviceId: String) {
    computerStore.revoke(deviceId)
    app.trustStore.revoke(deviceId)
    _state.update { it.copy(pairedComputers = computerStore.list(), status = res(R.string.status_computer_revoked)) }
  }

  fun refreshRemoteSession(deviceId: String, sessionId: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = res(R.string.status_session_downloading)) }
      runCatching { remoteCache.refresh(deviceId, sessionId) }
        .onSuccess { session ->
          _state.update { it.copy(sessions = app.database.listSessions(), status = res(R.string.status_session_cached)) }
          selectSession(session.id)
        }
        .onFailure { setStatus(it.message ?: res(R.string.status_session_refresh_failed)) }
    }
  }

  fun browseRemoteSessions(deviceId: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = res(R.string.status_sessions_loading)) }
      runCatching {
        val result = deviceClient.request(deviceId, "session/list")
        RemoteSessionParser.parse(result)
      }.onSuccess { sessions ->
        _state.update { it.copy(remoteSessions = it.remoteSessions + (deviceId to sessions), status = res(R.string.status_remote_sessions_available, sessions.size)) }
      }.onFailure { setStatus(it.message ?: res(R.string.status_browse_sessions_failed)) }
    }
  }

  fun copyRemoteSession(cacheSessionId: String) {
    runCatching { remoteCache.copyToPhone(cacheSessionId) }
      .onSuccess { selectSession(it.id); setStatus(res(R.string.status_session_copied)) }
      .onFailure { setStatus(it.message ?: res(R.string.status_session_copy_failed)) }
  }

  fun refreshRemoteOutbox(deviceId: String) {
    viewModelScope.launch {
      _state.update { it.copy(status = res(R.string.status_outbox_checking)) }
      runCatching { transferClient.remoteOutbox(deviceId) }
        .onSuccess { items -> _state.update { it.copy(remoteOutbox = it.remoteOutbox + (deviceId to items), status = res(R.string.status_files_available, items.size)) } }
        .onFailure { setStatus(it.message ?: res(R.string.status_outbox_failed)) }
    }
  }

  fun downloadFromComputer(deviceId: String, manifest: ArtifactManifest) {
    viewModelScope.launch {
      _state.update { it.copy(status = res(R.string.status_inbox_downloading)) }
      runCatching { transferClient.download(deviceId, manifest) }
        .onSuccess { _state.update { it.copy(inbox = inboxStore.list(), status = res(R.string.status_inbox_verified)) } }
        .onFailure { setStatus(it.message ?: res(R.string.status_download_failed)) }
    }
  }

  fun commitInbox(item: MobileInboxItem) {
    viewModelScope.launch {
      runCatching { transferClient.commitAndAcknowledge(item, workspace, confirm = true) }
        .onSuccess { document -> _state.update { it.copy(inbox = inboxStore.list(), status = res(R.string.status_committed, document.displayName)) } }
        .onFailure { setStatus(it.message ?: res(R.string.status_commit_failed)) }
    }
  }

  fun uploadToComputer(deviceId: String, uri: Uri) {
    viewModelScope.launch {
      _state.update { it.copy(status = res(R.string.status_uploading)) }
      runCatching {
        require(uri.scheme == "content") { res(R.string.error_only_selected_document) }
        val resolver = getApplication<Application>().contentResolver
        val bytes = resolver.openInputStream(uri)?.use { it.readWithOverflowByte((32 * 1_048_576)) }
          ?: error(res(R.string.error_document_unavailable))
        require(bytes.size <= 32 * 1_048_576) { res(R.string.error_document_too_large) }
        val name = queryDisplayName(uri) ?: "mobile-${System.currentTimeMillis()}.bin"
        transferClient.upload(deviceId, name, resolver.getType(uri) ?: "application/octet-stream", bytes)
      }.onSuccess { setStatus(res(R.string.status_uploaded, it.name)) }
        .onFailure { setStatus(it.message ?: res(R.string.status_upload_failed)) }
    }
  }

  fun startVoiceNote() {
    runCatching { voiceRecorder.start(mediaStrings()) }
      .onSuccess { capture -> _state.update { it.copy(audioCapture = capture, status = capture.visibleLabel) } }
      .onFailure { setStatus(it.message ?: res(R.string.status_mic_start_failed)) }
  }

  fun stopVoiceNote() {
    viewModelScope.launch {
      runCatching {
        val file = voiceRecorder.stop()
        val sessionId = _state.value.selectedSessionId?.takeIf { app.database.session(it)?.readOnly == false }
        val audio = app.artifactStore.put(file.name, "audio/mp4", file.readBytes(), sessionId)
        app.database.upsertArtifact(audio)
        sessionId?.let { appendArtifactReference(it, res(R.string.artifact_voice_note), audio) }
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
            sessionId?.let { id -> appendArtifactReference(id, res(R.string.artifact_voice_transcript, text.take(240)), transcript) }
          }.exceptionOrNull()
        }
        file.delete()
        audio to transcriptionError
      }.onSuccess { (_, transcriptionError) ->
        _state.update {
          it.copy(
            audioCapture = idleAudioCapture(),
            artifacts = app.database.listArtifacts(),
            transcript = it.selectedSessionId?.let(app.database::messages).orEmpty(),
            status = when {
              transcriptionError != null -> res(R.string.status_voice_transcription_failed, transcriptionError.message ?: "")
              providerStore.enabled() == null -> res(R.string.status_voice_no_provider)
              else -> res(R.string.status_voice_saved)
            },
          )
        }
      }.onFailure { error ->
        _state.update { it.copy(audioCapture = idleAudioCapture(), status = error.message ?: res(R.string.status_voice_failed)) }
      }
    }
  }

  fun cancelVoiceNote() {
    voiceRecorder.cancel()
    _state.update { it.copy(audioCapture = idleAudioCapture(), status = res(R.string.status_voice_discarded)) }
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
    _state.update { it.copy(audioCapture = idleAudioCapture(), status = res(R.string.status_audio_permission_revoked)) }
  }

  fun setSystemAudioEnabled(enabled: Boolean) {
    if (!enabled) stopSystemAudio()
    systemAudioFlag.setEnabled(enabled)
    _state.update { it.copy(systemAudioEnabled = enabled, status = res(if (enabled) R.string.status_system_audio_enabled else R.string.status_system_audio_disabled)) }
  }

  fun startSystemAudio(resultCode: Int, data: Intent?) {
    if (resultCode != Activity.RESULT_OK || data == null) return setStatus(res(R.string.status_system_audio_denied))
    runCatching {
      require(systemAudioFlag.enabled()) { res(R.string.error_enable_system_audio_first) }
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
          audioCapture = AudioCaptureState(AudioCaptureKind.SYSTEM_PLAYBACK, AudioCaptureStatus.RECORDING, System.currentTimeMillis(), res(R.string.media_capturing_system)),
          status = res(R.string.status_system_capture_active),
        )
      }
    }.onFailure { setStatus(it.message ?: res(R.string.status_system_capture_failed)) }
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
    _state.update { it.copy(audioCapture = idleAudioCapture(), artifacts = app.database.listArtifacts(), status = res(R.string.status_system_capture_stopped)) }
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
