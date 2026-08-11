package dev.hadamard.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.SessionRecord

private val Forest = Color(0xFF173F35)
private val Gold = Color(0xFFF4C95D)
private val Canvas = Color(0xFFF7F5EF)
private val Ink = Color(0xFF17211E)
private val Muted = Color(0xFF60716B)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HadamardMobileApp(viewModel: HadamardViewModel) {
  val state by viewModel.state.collectAsState()
  BackHandler(enabled = state.screen != MobileScreen.HOME) {
    viewModel.navigate(MobileScreen.HOME)
  }
  MaterialTheme(
    colorScheme = MaterialTheme.colorScheme.copy(
      primary = Forest,
      secondary = Gold,
      background = Canvas,
      surface = Color.White,
      onPrimary = Color.White,
      onBackground = Ink,
    ),
  ) {
    Scaffold(
      containerColor = Canvas,
      topBar = {
        TopAppBar(
          colors = TopAppBarDefaults.topAppBarColors(containerColor = Canvas),
          title = {
            Column {
              Text("HADAMARD", fontWeight = FontWeight.Black, letterSpacing = 2.sp, color = Forest)
              Text(screenTitle(state.screen), style = MaterialTheme.typography.labelSmall, color = Muted)
            }
          },
          navigationIcon = {
            if (state.screen != MobileScreen.HOME) {
              TextButton(
                onClick = { viewModel.navigate(MobileScreen.HOME) },
                modifier = Modifier.testTag("back-button"),
              ) { Text("← Back") }
            }
          },
        )
      },
    ) { padding ->
      Column(Modifier.fillMaxSize().padding(padding)) {
        state.status?.let { StatusStrip(it) }
        when (state.screen) {
          MobileScreen.HOME -> HomeScreen(state, viewModel)
          MobileScreen.PHONE -> PhoneScreen(state, viewModel)
          MobileScreen.COMPUTERS -> ComputersScreen(state, viewModel)
          MobileScreen.SETTINGS -> SettingsScreen(state, viewModel)
        }
      }
    }
    state.permissionRequest?.let { request ->
      AlertDialog(
        onDismissRequest = { viewModel.resolvePermission(false) },
        title = { Text("Allow ${request.tool.name}?") },
        text = {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Phone workspace · ${request.tool.permission}", fontWeight = FontWeight.SemiBold)
            Text(request.argumentsSummary, color = Muted, maxLines = 6, overflow = TextOverflow.Ellipsis)
            Text("This approval applies to this call only.", style = MaterialTheme.typography.labelMedium)
          }
        },
        confirmButton = { Button(onClick = { viewModel.resolvePermission(true) }) { Text("Allow once") } },
        dismissButton = { TextButton(onClick = { viewModel.resolvePermission(false) }) { Text("Deny") } },
      )
    }
  }
}

@Composable
private fun HomeScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  LazyColumn(
    modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp).testTag("home-screen"),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    item {
      Surface(color = Forest, shape = RoundedCornerShape(24.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Text("A small agent that belongs to this phone.", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
          Text(
            "Local files and sessions stay independent. Pair a computer only when you want its live capabilities.",
            color = Color(0xFFD8E6E0),
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Badge("NO SHELL")
            Badge("TYPED TOOLS")
            Badge("LOCAL-FIRST")
          }
        }
      }
    }
    item {
      EntryCard(
        eyebrow = "THIS DEVICE",
        title = "This Phone",
        description = "${state.sessions.count { !it.readOnly }} local sessions · documents, Markdown, PDF/OCR and simple pages",
        action = "Open phone workspace",
        testTag = "open-phone",
      ) { viewModel.navigate(MobileScreen.PHONE) }
    }
    item {
      EntryCard(
        eyebrow = "DEVICE LINK",
        title = "Paired Computer",
        description = if (state.pairedComputers.isEmpty()) "No computer paired · discover on LAN or scan a signed QR"
        else "${state.pairedComputers.size} paired · cached sessions remain readable while offline",
        action = "Manage connections",
        testTag = "open-computers",
      ) { viewModel.navigate(MobileScreen.COMPUTERS) }
    }
    item {
      OutlinedButton(
        onClick = { viewModel.navigate(MobileScreen.SETTINGS) },
        modifier = Modifier.fillMaxWidth().testTag("open-settings"),
      ) {
        Text(if (state.provider == null) "Configure mobile LLM provider" else "Provider · ${state.provider.displayName}")
      }
    }
    item {
      Text("OFFLINE ON THIS PHONE", style = MaterialTheme.typography.labelSmall, color = Muted, fontWeight = FontWeight.Bold)
      Text("Files · Markdown · PDF rendering · bundled OCR · page preview", color = Forest)
      Spacer(Modifier.height(4.dp))
      Text("Agent reasoning needs the configured endpoint; no local model is bundled.", color = Muted, style = MaterialTheme.typography.bodySmall)
    }
  }
}

@Composable
private fun PhoneScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  var prompt by remember { mutableStateOf("") }
  Column(
    Modifier.fillMaxSize().padding(horizontal = 16.dp).testTag("phone-screen"),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
      Column {
        Text("Phone sessions", fontWeight = FontWeight.Bold, fontSize = 20.sp)
        Text("Independent workspace · no computer write-back", color = Muted, style = MaterialTheme.typography.bodySmall)
      }
      Button(onClick = viewModel::createSession, modifier = Modifier.testTag("new-session")) { Text("New") }
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
        item { Text("Start with a local question or open a cached session.", color = Muted, modifier = Modifier.padding(12.dp)) }
      }
      items(state.transcript) { message ->
        val background = when (message.role) {
          MessageRole.USER -> Color(0xFFE7F0EC)
          MessageRole.ASSISTANT -> Color.White
          MessageRole.TOOL -> Color(0xFFFFF4D0)
        }
        Surface(color = background, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
          Column(Modifier.padding(12.dp)) {
            Text(message.role.name, style = MaterialTheme.typography.labelSmall, color = Muted, fontWeight = FontWeight.Bold)
            Text(message.content, maxLines = 14, overflow = TextOverflow.Ellipsis)
          }
        }
      }
    }
    val selected = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    if (selected?.readOnly == true) {
      Surface(color = Color(0xFFFFF4D0), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
          Text("Offline cache · read only", modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
          Button(onClick = { viewModel.copyRemoteSession(selected.id) }) { Text("Copy to phone") }
        }
      }
    } else {
      OutlinedTextField(
        value = prompt,
        onValueChange = { prompt = it },
        modifier = Modifier.fillMaxWidth().testTag("agent-prompt"),
        label = { Text("Ask the phone Agent") },
        minLines = 2,
      )
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        if (state.isRunning) OutlinedButton(onClick = viewModel::cancelRun) { Text("Stop") }
        else Button(onClick = { val value = prompt; prompt = ""; viewModel.send(value) }, enabled = prompt.isNotBlank()) { Text("Run") }
      }
    }
  }
}

@Composable
private fun ComputersScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  var manualUri by remember { mutableStateOf("") }
  val scanner = rememberLauncherForActivityResult(
    contract = ScanContract(),
    onResult = { result -> result.contents?.let(viewModel::pair) },
  )
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 18.dp).testTag("computers-screen"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    item {
      Text("Pair without a third-party server", fontWeight = FontWeight.Bold, fontSize = 20.sp)
      Text("LAN direct uses signed QR offers, client certificates and pinned WSS.", color = Muted)
    }
    item {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = {
            scanner.launch(
              ScanOptions().setPrompt("Scan the Hadamard desktop pairing QR")
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setOrientationLocked(false),
            )
          },
          modifier = Modifier.testTag("scan-pairing-qr"),
        ) { Text("Scan QR") }
        OutlinedButton(onClick = viewModel::startDiscovery) { Text("Discover LAN") }
        TextButton(onClick = viewModel::stopDiscovery) { Text("Stop") }
      }
    }
    item {
      OutlinedTextField(
        value = manualUri,
        onValueChange = { manualUri = it },
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Manual hadamard:// pairing URI") },
        maxLines = 3,
      )
      Button(
        onClick = { viewModel.pair(manualUri) },
        enabled = manualUri.startsWith("hadamard://pair"),
        modifier = Modifier.padding(top = 8.dp),
      ) { Text("Verify and pair") }
    }
    if (state.discoveredComputers.isNotEmpty()) {
      item { SectionLabel("DISCOVERED ON THIS LAN") }
      items(state.discoveredComputers) { computer ->
        CompactCard("${computer.name} · ${computer.host}:${computer.port}", "Certificate ${computer.certificateFingerprint.take(14)}…")
      }
    }
    item { SectionLabel("PAIRED COMPUTERS") }
    if (state.pairedComputers.isEmpty()) item { Text("No paired computers yet.", color = Muted) }
    items(state.pairedComputers) { computer ->
      Card(colors = CardDefaults.cardColors(containerColor = Color.White), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
              Text(computer.name, fontWeight = FontWeight.Bold)
              Text("${computer.address}:${computer.port}", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = { viewModel.revokeComputer(computer.deviceId) }) { Text("Revoke") }
          }
          Text(computer.scopes.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = Forest)
          OutlinedButton(
            onClick = { viewModel.browseRemoteSessions(computer.deviceId) },
            modifier = Modifier.testTag("browse-remote-sessions-${computer.deviceId}"),
          ) { Text("Browse remote sessions") }
          state.remoteSessions[computer.deviceId].orEmpty().forEach { session ->
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Column(Modifier.weight(1f)) {
                Text(session.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(session.preview.ifBlank { session.updatedAt }, color = Muted, style = MaterialTheme.typography.bodySmall, maxLines = 2)
              }
              OutlinedButton(onClick = { viewModel.refreshRemoteSession(computer.deviceId, session.id) }) {
                Text("Cache")
              }
            }
          }
        }
      }
    }
    item {
      Surface(color = Color(0xFFFFF4D0), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Text(
          "Away from the same LAN? Configure a direct address, SSH tunnel or your own relay on desktop. Without a reachable route, Hadamard reports the connection as unavailable.",
          modifier = Modifier.padding(14.dp),
          color = Ink,
        )
      }
    }
  }
}

@Composable
private fun SettingsScreen(state: MobileUiState, viewModel: HadamardViewModel) {
  var name by remember { mutableStateOf(state.provider?.displayName ?: "Mobile provider") }
  var endpoint by remember { mutableStateOf(state.provider?.endpoint ?: "https://api.openai.com/v1") }
  var model by remember { mutableStateOf(state.provider?.model ?: "") }
  var apiKey by remember { mutableStateOf("") }
  val workspacePicker = rememberLauncherForActivityResult(OpenDocumentTree()) { uri ->
    uri?.let(viewModel::selectSafWorkspace)
  }
  Column(
    Modifier.fillMaxSize().padding(horizontal = 20.dp).verticalScroll(rememberScrollState()).testTag("settings-screen"),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("Mobile Agent provider", fontWeight = FontWeight.Bold, fontSize = 20.sp)
    Text("This configuration belongs to the phone. It is never copied from or back to a computer.", color = Muted)
    OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(endpoint, { endpoint = it }, label = { Text("HTTPS endpoint") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(model, { model = it }, label = { Text("Model") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(apiKey, { apiKey = it }, label = { Text("API key · stored in Android Keystore") }, modifier = Modifier.fillMaxWidth())
    Button(
      onClick = { viewModel.saveProvider(name, endpoint, model, apiKey); apiKey = "" },
      enabled = endpoint.startsWith("https://") && model.isNotBlank(),
      modifier = Modifier.testTag("save-provider"),
    ) { Text("Save on this phone") }
    HorizontalDivider()
    SectionLabel("MOBILE WORKSPACE")
    Text(state.workspaceLabel, fontWeight = FontWeight.SemiBold, color = Forest)
    Text(
      "The Agent can access only the selected document tree. Absolute paths and ungranted folders remain unavailable.",
      color = Muted,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      OutlinedButton(
        onClick = { workspacePicker.launch(null) },
        modifier = Modifier.testTag("select-saf-workspace"),
      ) { Text("Choose folder") }
      TextButton(onClick = viewModel::useAppPrivateWorkspace) { Text("Use app-private") }
    }
    HorizontalDivider()
    SectionLabel("CAPABILITY BOUNDARY")
    Text("✓ Typed document tools\n✓ SAF or app-private storage\n✓ Per-call permission prompt\n✓ Bounded PDF/OCR and web reads", color = Forest)
    Text("Not included: shell, arbitrary paths, package installs, CodeAct, native compilation or browser DevTools.", color = Muted)
  }
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
  Card(colors = CardDefaults.cardColors(containerColor = Color.White), modifier = Modifier.fillMaxWidth().testTag(testTag)) {
    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      SectionLabel(eyebrow)
      Text(title, fontWeight = FontWeight.Bold, fontSize = 22.sp, color = Ink)
      Text(description, color = Muted)
      Button(onClick = onClick, modifier = Modifier.testTag("$testTag-action")) { Text(action) }
    }
  }
}

@Composable
private fun SessionRow(session: SessionRecord, selected: Boolean, onClick: () -> Unit) {
  TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(if (selected) "● ${session.title}" else session.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(if (session.readOnly) "REMOTE CACHE" else "THIS PHONE", style = MaterialTheme.typography.labelSmall, color = Muted)
    }
  }
}

@Composable
private fun StatusStrip(message: String) {
  Surface(color = Gold, modifier = Modifier.fillMaxWidth()) {
    Text(message, Modifier.padding(horizontal = 18.dp, vertical = 8.dp), color = Ink, style = MaterialTheme.typography.bodySmall)
  }
}

@Composable
private fun Badge(value: String) {
  Box(Modifier.background(Color(0xFF285A4C), RoundedCornerShape(100.dp)).padding(horizontal = 9.dp, vertical = 4.dp)) {
    Text(value, color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
  }
}

@Composable
private fun CompactCard(title: String, subtitle: String) {
  Surface(color = Color.White, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
    Column(Modifier.padding(12.dp)) {
      Text(title, fontWeight = FontWeight.SemiBold)
      Text(subtitle, color = Muted, style = MaterialTheme.typography.bodySmall)
    }
  }
}

@Composable
private fun SectionLabel(value: String) = Text(
  value,
  style = MaterialTheme.typography.labelSmall,
  color = Forest,
  fontWeight = FontWeight.Black,
  letterSpacing = 1.sp,
)

private fun screenTitle(screen: MobileScreen) = when (screen) {
  MobileScreen.HOME -> "Mobile companion"
  MobileScreen.PHONE -> "This Phone"
  MobileScreen.COMPUTERS -> "Paired Computer"
  MobileScreen.SETTINGS -> "Local settings"
}
