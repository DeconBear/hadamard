package dev.hadamard.companion.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree
import androidx.activity.result.contract.ActivityResultContracts.OpenDocument
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.hadamard.companion.R
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.SessionRecord
import dev.hadamard.companion.devicelink.InboxStatus
import dev.hadamard.companion.ui.theme.HadamardTheme
import dev.hadamard.companion.ui.theme.LocalExtendedColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HadamardMobileApp(viewModel: HadamardViewModel) {
  val state by viewModel.state.collectAsState()
  val context = LocalContext.current
  val appliedLanguageTag = remember { AppLocale.currentTag(context) }
  val micPermissionDenied = stringResource(R.string.mic_permission_denied)
  LaunchedEffect(state.languageTag) {
    if (state.languageTag != appliedLanguageTag) (context as? Activity)?.recreate()
  }
  val microphonePermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) viewModel.startVoiceNote() else viewModel.setStatus(micPermissionDenied)
  }
  val systemAudioPermission = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    viewModel.startSystemAudio(result.resultCode, result.data)
  }
  BackHandler(enabled = state.screen != MobileScreen.HOME) {
    viewModel.navigate(MobileScreen.HOME)
  }
  HadamardTheme {
    Scaffold(
      containerColor = MaterialTheme.colorScheme.background,
      topBar = {
        TopAppBar(
          colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
          title = {
            Column {
              Text("HADAMARD", fontWeight = FontWeight.Black, letterSpacing = 2.sp, color = MaterialTheme.colorScheme.primary)
              Text(screenTitle(state.screen), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
          },
          navigationIcon = {
            if (state.screen != MobileScreen.HOME) {
              TextButton(
                onClick = { viewModel.navigate(MobileScreen.HOME) },
                modifier = Modifier.testTag("back-button"),
              ) { Text(stringResource(R.string.back)) }
            }
          },
        )
      },
    ) { padding ->
      Column(Modifier.fillMaxSize().padding(padding)) {
        state.status?.let { StatusStrip(it) }
        when (state.screen) {
          MobileScreen.HOME -> HomeScreen(state, viewModel)
          MobileScreen.PHONE -> PhoneScreen(state, viewModel) {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
              viewModel.startVoiceNote()
            } else microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
          }
          MobileScreen.COMPUTERS -> ComputersScreen(state, viewModel)
          MobileScreen.TRANSFERS -> TransfersScreen(state, viewModel) {
            val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            systemAudioPermission.launch(manager.createScreenCaptureIntent())
          }
          MobileScreen.SETTINGS -> SettingsScreen(state, viewModel)
        }
      }
    }
    state.permissionRequest?.let { request ->
      AlertDialog(
        onDismissRequest = { viewModel.resolvePermission(false) },
        title = { Text(stringResource(R.string.permission_dialog_title, request.tool.name)) },
        text = {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.permission_dialog_workspace, request.tool.permission), fontWeight = FontWeight.SemiBold)
            Text(request.argumentsSummary, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 6, overflow = TextOverflow.Ellipsis)
            Text(stringResource(R.string.permission_dialog_note), style = MaterialTheme.typography.labelMedium)
          }
        },
        confirmButton = { Button(onClick = { viewModel.resolvePermission(true) }) { Text(stringResource(R.string.permission_allow_once)) } },
        dismissButton = { TextButton(onClick = { viewModel.resolvePermission(false) }) { Text(stringResource(R.string.permission_deny)) } },
      )
    }
  }
}

@Composable
private fun HomeScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  val extended = LocalExtendedColors.current
  LazyColumn(
    modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp).testTag("home-screen"),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    item {
      Surface(color = extended.hero, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text(stringResource(R.string.home_hero_title), color = extended.onHero, fontSize = 24.sp, fontWeight = FontWeight.Bold)
          Text(
            stringResource(R.string.home_hero_body),
            color = extended.onHero.copy(alpha = 0.85f),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Badge(stringResource(R.string.badge_no_shell))
            Badge(stringResource(R.string.badge_typed_tools))
            Badge(stringResource(R.string.badge_local_first))
          }
        }
      }
    }
    item {
      EntryCard(
        eyebrow = stringResource(R.string.entry_phone_eyebrow),
        title = stringResource(R.string.entry_phone_title),
        description = stringResource(R.string.entry_phone_description, state.sessions.count { !it.readOnly }),
        action = stringResource(R.string.entry_phone_action),
        testTag = "open-phone",
      ) { viewModel.navigate(MobileScreen.PHONE) }
    }
    item {
      EntryCard(
        eyebrow = stringResource(R.string.entry_computer_eyebrow),
        title = stringResource(R.string.entry_computer_title),
        description = if (state.pairedComputers.isEmpty()) stringResource(R.string.entry_computer_empty)
        else stringResource(R.string.entry_computer_paired, state.pairedComputers.size),
        action = stringResource(R.string.entry_computer_action),
        testTag = "open-computers",
      ) { viewModel.navigate(MobileScreen.COMPUTERS) }
    }
    item {
      EntryCard(
        eyebrow = stringResource(R.string.entry_transfers_eyebrow),
        title = stringResource(R.string.entry_transfers_title),
        description = stringResource(R.string.entry_transfers_description, state.inbox.count { it.status == InboxStatus.VERIFIED }, state.artifacts.size),
        action = stringResource(R.string.entry_transfers_action),
        testTag = "open-transfers",
      ) { viewModel.navigate(MobileScreen.TRANSFERS) }
    }
    item {
      OutlinedButton(
        onClick = { viewModel.navigate(MobileScreen.SETTINGS) },
        modifier = Modifier.fillMaxWidth().testTag("open-settings"),
      ) {
        Text(
          if (state.provider == null) stringResource(R.string.home_configure_provider)
          else stringResource(R.string.home_provider_configured, state.provider.displayName),
        )
      }
    }
    item {
      Text(stringResource(R.string.home_offline_label), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Bold)
      Text(stringResource(R.string.home_offline_items), color = MaterialTheme.colorScheme.primary)
      Spacer(Modifier.height(4.dp))
      Text(stringResource(R.string.home_offline_note), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    }
  }
}

@Composable
private fun PhoneScreen(state: MobileUiState, viewModel: HadamardViewModel, requestVoiceRecording: () -> Unit) {
  var prompt by remember { mutableStateOf("") }
  Column(
    Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("phone-screen"),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
      Column {
        Text(stringResource(R.string.phone_sessions_title), fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text(stringResource(R.string.phone_sessions_subtitle), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
      }
      Button(onClick = viewModel::createSession, modifier = Modifier.testTag("new-session")) { Text(stringResource(R.string.phone_new_session)) }
    }
    LazyColumn(modifier = Modifier.height(92.dp), horizontalAlignment = Alignment.Start) {
      items(state.sessions) { session ->
        SessionRow(session, session.id == state.selectedSessionId) { viewModel.selectSession(session.id) }
      }
    }
    HorizontalDivider()
    LazyColumn(
      modifier = Modifier.weight(1f).fillMaxWidth().testTag("transcript"),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      if (state.transcript.isEmpty()) {
        item { Text(stringResource(R.string.phone_transcript_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp)) }
      }
      items(state.transcript) { message ->
        val background = when (message.role) {
          MessageRole.USER -> MaterialTheme.colorScheme.primaryContainer
          MessageRole.ASSISTANT -> MaterialTheme.colorScheme.surface
          MessageRole.TOOL -> MaterialTheme.colorScheme.tertiaryContainer
        }
        val contentColor = when (message.role) {
          MessageRole.USER -> MaterialTheme.colorScheme.onPrimaryContainer
          MessageRole.ASSISTANT -> MaterialTheme.colorScheme.onSurface
          MessageRole.TOOL -> MaterialTheme.colorScheme.onTertiaryContainer
        }
        val roleLabel = when (message.role) {
          MessageRole.USER -> stringResource(R.string.role_user)
          MessageRole.ASSISTANT -> stringResource(R.string.role_assistant)
          MessageRole.TOOL -> stringResource(R.string.role_tool)
        }
        Surface(color = background, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
          Column(Modifier.padding(12.dp)) {
            Text(roleLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Bold)
            Text(message.content, color = contentColor, maxLines = 14, overflow = TextOverflow.Ellipsis)
          }
        }
      }
    }
    val selected = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    if (selected?.readOnly == true) {
      Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(stringResource(R.string.phone_readonly_cache), modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onTertiaryContainer, fontWeight = FontWeight.SemiBold)
          Button(onClick = { viewModel.copyRemoteSession(selected.id) }) { Text(stringResource(R.string.phone_copy_to_phone)) }
        }
      }
    } else {
      Surface(
        color = if (state.audioCapture.status == dev.hadamard.companion.media.AudioCaptureStatus.RECORDING) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().testTag("voice-note-controls"),
      ) {
        Row(Modifier.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(state.audioCapture.visibleLabel, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
          if (state.audioCapture.kind == dev.hadamard.companion.media.AudioCaptureKind.VOICE_NOTE) {
            OutlinedButton(onClick = viewModel::cancelVoiceNote) { Text(stringResource(R.string.voice_note_discard)) }
            Button(onClick = viewModel::stopVoiceNote, modifier = Modifier.testTag("stop-voice-note")) { Text(stringResource(R.string.action_stop)) }
          } else {
            OutlinedButton(onClick = requestVoiceRecording, modifier = Modifier.testTag("record-voice-note")) { Text(stringResource(R.string.voice_note_start)) }
          }
        }
      }
      OutlinedTextField(
        value = prompt,
        onValueChange = { prompt = it },
        modifier = Modifier.fillMaxWidth().testTag("agent-prompt"),
        label = { Text(stringResource(R.string.agent_prompt_label)) },
        minLines = 2,
      )
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        if (state.isRunning) OutlinedButton(onClick = viewModel::cancelRun) { Text(stringResource(R.string.action_stop)) }
        else Button(onClick = { val value = prompt; prompt = ""; viewModel.send(value) }, enabled = prompt.isNotBlank()) { Text(stringResource(R.string.action_run)) }
      }
    }
  }
}

@Composable
private fun TransfersScreen(state: MobileUiState, viewModel: HadamardViewModel, requestSystemAudio: () -> Unit) {
  var sendDeviceId by remember { mutableStateOf(state.pairedComputers.firstOrNull()?.deviceId.orEmpty()) }
  val documentPicker = rememberLauncherForActivityResult(OpenDocument()) { uri ->
    if (uri != null && sendDeviceId.isNotBlank()) viewModel.uploadToComputer(sendDeviceId, uri)
  }
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 18.dp).testTag("transfers-screen"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    item {
      Text(stringResource(R.string.transfers_inbox_title), fontWeight = FontWeight.Bold, fontSize = 20.sp)
      Text(stringResource(R.string.transfers_inbox_subtitle), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (state.inbox.isEmpty()) item { Text(stringResource(R.string.transfers_inbox_empty), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    items(state.inbox) { item ->
      Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(item.manifest.name, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(item.status.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
          }
          Text(stringResource(R.string.inbox_item_summary, item.manifest.size, item.manifest.sha256.take(14)), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
          if (item.status == InboxStatus.VERIFIED) {
            Button(
              onClick = { viewModel.commitInbox(item) },
              modifier = Modifier.testTag("commit-inbox-${item.manifest.transferId}"),
            ) { Text(stringResource(R.string.inbox_commit)) }
          }
        }
      }
    }
    item { HorizontalDivider(); SectionLabel(stringResource(R.string.transfers_outbox_section)) }
    items(state.pairedComputers) { computer ->
      Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(computer.name, fontWeight = FontWeight.Bold)
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { viewModel.refreshRemoteOutbox(computer.deviceId) }) { Text(stringResource(R.string.outbox_refresh)) }
            Button(onClick = { sendDeviceId = computer.deviceId; documentPicker.launch(arrayOf("*/*")) }) { Text(stringResource(R.string.outbox_send)) }
          }
          state.remoteOutbox[computer.deviceId].orEmpty().forEach { manifest ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
              Text(manifest.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
              OutlinedButton(onClick = { viewModel.downloadFromComputer(computer.deviceId, manifest) }) { Text(stringResource(R.string.outbox_to_inbox)) }
            }
          }
        }
      }
    }
    item { HorizontalDivider(); SectionLabel(stringResource(R.string.audio_capture_section)) }
    item {
      Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(state.audioCapture.visibleLabel, fontWeight = FontWeight.SemiBold)
          Text(stringResource(R.string.audio_capture_note), color = MaterialTheme.colorScheme.onSurfaceVariant)
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.system_audio_enable))
            Switch(checked = state.systemAudioEnabled, onCheckedChange = viewModel::setSystemAudioEnabled, modifier = Modifier.testTag("system-audio-flag"))
          }
          if (state.audioCapture.kind == dev.hadamard.companion.media.AudioCaptureKind.SYSTEM_PLAYBACK) {
            Button(onClick = viewModel::stopSystemAudio, modifier = Modifier.testTag("stop-system-audio")) { Text(stringResource(R.string.system_audio_stop)) }
          } else {
            OutlinedButton(
              onClick = requestSystemAudio,
              enabled = state.systemAudioEnabled,
              modifier = Modifier.testTag("start-system-audio"),
            ) { Text(stringResource(R.string.system_audio_request)) }
          }
        }
      }
    }
    item { SectionLabel(stringResource(R.string.artifacts_section)) }
    items(state.artifacts) { artifact ->
      CompactCard(artifact.displayName, stringResource(R.string.artifact_summary, artifact.mediaType, artifact.size, artifact.sha256.take(14)))
    }
  }
}

@Composable
private fun ComputersScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  var manualUri by remember { mutableStateOf("") }
  val scannerPrompt = stringResource(R.string.scanner_prompt)
  val scanner = rememberLauncherForActivityResult(
    contract = ScanContract(),
    onResult = { result -> result.contents?.let(viewModel::pair) },
  )
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 18.dp).testTag("computers-screen"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    item {
      Text(stringResource(R.string.computers_title), fontWeight = FontWeight.Bold, fontSize = 20.sp)
      Text(stringResource(R.string.computers_subtitle), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = {
            scanner.launch(
              ScanOptions().setPrompt(scannerPrompt)
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setOrientationLocked(false),
            )
          },
          modifier = Modifier.testTag("scan-pairing-qr"),
        ) { Text(stringResource(R.string.scan_qr)) }
        OutlinedButton(onClick = viewModel::startDiscovery) { Text(stringResource(R.string.discover_lan)) }
        TextButton(onClick = viewModel::stopDiscovery) { Text(stringResource(R.string.action_stop)) }
      }
    }
    item {
      OutlinedTextField(
        value = manualUri,
        onValueChange = { manualUri = it },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(stringResource(R.string.manual_pairing_label)) },
        maxLines = 3,
      )
      Button(
        onClick = { viewModel.pair(manualUri) },
        enabled = manualUri.startsWith("hadamard://pair"),
        modifier = Modifier.padding(top = 8.dp),
      ) { Text(stringResource(R.string.verify_and_pair)) }
    }
    if (state.discoveredComputers.isNotEmpty()) {
      item { SectionLabel(stringResource(R.string.discovered_section)) }
      items(state.discoveredComputers) { computer ->
        CompactCard(
          stringResource(R.string.discovered_computer_summary, computer.name, computer.host, computer.port),
          stringResource(R.string.certificate_summary, computer.certificateFingerprint.take(14)),
        )
      }
    }
    item { SectionLabel(stringResource(R.string.paired_section)) }
    if (state.pairedComputers.isEmpty()) item { Text(stringResource(R.string.paired_empty), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    items(state.pairedComputers) { computer ->
      Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
              Text(computer.name, fontWeight = FontWeight.Bold)
              Text("${computer.address}:${computer.port}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = { viewModel.revokeComputer(computer.deviceId) }) { Text(stringResource(R.string.revoke)) }
          }
          Text(computer.scopes.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
          OutlinedButton(
            onClick = { viewModel.browseRemoteSessions(computer.deviceId) },
            modifier = Modifier.testTag("browse-remote-sessions-${computer.deviceId}"),
          ) { Text(stringResource(R.string.browse_remote_sessions)) }
          state.remoteSessions[computer.deviceId].orEmpty().forEach { session ->
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Column(Modifier.weight(1f)) {
                Text(session.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(session.preview.ifBlank { session.updatedAt }, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, maxLines = 2)
              }
              OutlinedButton(onClick = { viewModel.refreshRemoteSession(computer.deviceId, session.id) }) {
                Text(stringResource(R.string.cache_session))
              }
            }
          }
        }
      }
    }
    item {
      Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Text(
          stringResource(R.string.remote_access_info),
          modifier = Modifier.padding(14.dp),
          color = MaterialTheme.colorScheme.onTertiaryContainer,
        )
      }
    }
  }
}

@Composable
private fun SettingsScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  val defaultProviderName = stringResource(R.string.provider_default_name)
  var name by remember(state.provider) { mutableStateOf(state.provider?.displayName ?: defaultProviderName) }
  var endpoint by remember(state.provider) { mutableStateOf(state.provider?.endpoint ?: "https://api.openai.com/v1") }
  var model by remember(state.provider) { mutableStateOf(state.provider?.model ?: "") }
  var apiKey by remember { mutableStateOf("") }
  val providerScanPrompt = stringResource(R.string.provider_scan_prompt)
  val providerScanner = rememberLauncherForActivityResult(
    contract = ScanContract(),
    onResult = { result -> result.contents?.let(viewModel::importProviderFromQr) },
  )
  val workspacePicker = rememberLauncherForActivityResult(OpenDocumentTree()) { uri ->
    uri?.let(viewModel::selectSafWorkspace)
  }
  Column(
    Modifier.fillMaxSize().padding(horizontal = 20.dp).verticalScroll(rememberScrollState()).testTag("settings-screen"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text(stringResource(R.string.settings_provider_title), fontWeight = FontWeight.Bold, fontSize = 20.sp)
    Text(stringResource(R.string.settings_provider_subtitle), color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedButton(
      onClick = {
        providerScanner.launch(
          ScanOptions().setPrompt(providerScanPrompt)
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setOrientationLocked(false),
        )
      },
      modifier = Modifier.testTag("scan-provider-qr"),
    ) { Text(stringResource(R.string.provider_scan_import)) }
    OutlinedTextField(name, { name = it }, label = { Text(stringResource(R.string.provider_name_label)) }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(endpoint, { endpoint = it }, label = { Text(stringResource(R.string.provider_endpoint_label)) }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(model, { model = it }, label = { Text(stringResource(R.string.provider_model_label)) }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(apiKey, { apiKey = it }, label = { Text(stringResource(R.string.provider_apikey_label)) }, modifier = Modifier.fillMaxWidth())
    Button(
      onClick = { viewModel.saveProvider(name, endpoint, model, apiKey); apiKey = "" },
      enabled = endpoint.startsWith("https://") && model.isNotBlank(),
      modifier = Modifier.testTag("save-provider"),
    ) { Text(stringResource(R.string.provider_save)) }
    HorizontalDivider()
    SectionLabel(stringResource(R.string.language_section))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      LanguageChoice(stringResource(R.string.language_follow_system), state.languageTag.isEmpty()) { viewModel.setLanguage("") }
      LanguageChoice(stringResource(R.string.language_english), state.languageTag == "en") { viewModel.setLanguage("en") }
      LanguageChoice(stringResource(R.string.language_chinese), state.languageTag == "zh-CN") { viewModel.setLanguage("zh-CN") }
    }
    HorizontalDivider()
    SectionLabel(stringResource(R.string.workspace_section))
    Text(state.workspaceLabel, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
    Text(
      stringResource(R.string.workspace_note),
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(
        onClick = { workspacePicker.launch(null) },
        modifier = Modifier.testTag("select-saf-workspace"),
      ) { Text(stringResource(R.string.workspace_choose_folder)) }
      TextButton(onClick = viewModel::useAppPrivateWorkspace) { Text(stringResource(R.string.workspace_use_app_private)) }
    }
    HorizontalDivider()
    SectionLabel(stringResource(R.string.capability_section))
    Text(stringResource(R.string.capability_included), color = MaterialTheme.colorScheme.primary)
    Text(stringResource(R.string.capability_excluded), color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

@Composable
private fun LanguageChoice(label: String, selected: Boolean, onClick: () -> Unit) {
  if (selected) Button(onClick = onClick) { Text(label) }
  else OutlinedButton(onClick = onClick) { Text(label) }
}

@Composable
private fun EntryCard(
  eyebrow: String,
  title: String,
  description: String,
  action: String,
  testTag: String,
  onClick: () -> Unit,
) {
  Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), modifier = Modifier.fillMaxWidth().testTag(testTag)) {
    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      SectionLabel(eyebrow)
      Text(title, fontWeight = FontWeight.Bold, fontSize = 22.sp, color = MaterialTheme.colorScheme.onBackground)
      Text(description, color = MaterialTheme.colorScheme.onSurfaceVariant)
      Button(onClick = onClick, modifier = Modifier.testTag("$testTag-action")) { Text(action) }
    }
  }
}

@Composable
private fun SessionRow(session: SessionRecord, selected: Boolean, onClick: () -> Unit) {
  TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(if (selected) "● ${session.title}" else session.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(
        stringResource(if (session.readOnly) R.string.session_remote_cache else R.string.session_this_phone),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun StatusStrip(message: String) {
  Surface(color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.fillMaxWidth()) {
    Text(message, Modifier.padding(horizontal = 18.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.onTertiaryContainer, style = MaterialTheme.typography.bodySmall)
  }
}

@Composable
private fun Badge(value: String) {
  val extended = LocalExtendedColors.current
  Box(Modifier.background(extended.heroBadge, RoundedCornerShape(100.dp)).padding(horizontal = 9.dp, vertical = 4.dp)) {
    Text(value, color = extended.onHeroBadge, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
  }
}

@Composable
private fun CompactCard(title: String, subtitle: String) {
  Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp)) {
      Text(title, fontWeight = FontWeight.SemiBold)
      Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
    }
  }
}

@Composable
private fun SectionLabel(value: String) = Text(
  value,
  style = MaterialTheme.typography.labelSmall,
  color = MaterialTheme.colorScheme.primary,
  fontWeight = FontWeight.Black,
  letterSpacing = 1.sp,
)

@Composable
private fun screenTitle(screen: MobileScreen) = stringResource(
  when (screen) {
    MobileScreen.HOME -> R.string.title_home
    MobileScreen.PHONE -> R.string.title_phone
    MobileScreen.COMPUTERS -> R.string.title_computers
    MobileScreen.TRANSFERS -> R.string.title_transfers
    MobileScreen.SETTINGS -> R.string.title_settings
  },
)
