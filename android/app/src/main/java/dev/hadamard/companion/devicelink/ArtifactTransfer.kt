package dev.hadamard.companion.devicelink

import android.content.Context
import android.util.Base64
import dev.hadamard.companion.workspace.WorkspaceDocument
import dev.hadamard.companion.workspace.WorkspacePort
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.nio.file.Files
import java.nio.file.StandardCopyOption

data class ArtifactManifest(
  val transferId: String,
  val name: String,
  val mediaType: String,
  val size: Long,
  val sha256: String,
  val chunkSize: Int,
  val totalChunks: Int,
  val createdAt: String,
)

enum class InboxStatus { RECEIVING, VERIFIED, QUARANTINED, COMMITTED }

data class MobileInboxItem(
  val deviceId: String,
  val manifest: ArtifactManifest,
  val status: InboxStatus,
  val receivedChunks: Set<Int>,
  val updatedAt: Long,
  val reason: String? = null,
  val workspaceDocumentId: String? = null,
)

/** App-private, resumable staging. No method writes to the user workspace except [commit]. */
class MobileInboxStore(
  private val root: File,
  private val maxItemBytes: Long = MAX_ITEM_BYTES,
  private val quotaBytes: Long = MAX_QUOTA_BYTES,
) {
  constructor(context: Context) : this(File(context.filesDir, "device-link-inbox"))

  init {
    root.mkdirs()
    check(root.isDirectory) { "Could not create mobile inbox" }
  }

  @Synchronized
  fun begin(deviceId: String, manifest: ArtifactManifest): MobileInboxItem {
    validate(deviceId, manifest)
    val existing = read(deviceId, manifest.transferId)
    if (existing != null) {
      require(existing.manifest == manifest) { "Transfer ID already has a different manifest" }
      return existing
    }
    val reserved = list().filter { it.status == InboxStatus.RECEIVING || it.status == InboxStatus.VERIFIED }
      .sumOf { it.manifest.size }
    require(reserved + manifest.size <= quotaBytes) { "Mobile inbox quota exceeded" }
    val directory = transferDirectory(deviceId, manifest.transferId)
    File(directory, "chunks").mkdirs()
    return MobileInboxItem(deviceId, manifest, InboxStatus.RECEIVING, emptySet(), System.currentTimeMillis())
      .also(::writeState)
  }

  @Synchronized
  fun acceptChunk(
    deviceId: String,
    transferId: String,
    index: Int,
    bytes: ByteArray,
    expectedSha256: String,
  ): MobileInboxItem {
    var item = requireItem(deviceId, transferId)
    require(item.status == InboxStatus.RECEIVING) { "Transfer is ${item.status}" }
    require(index in 0 until item.manifest.totalChunks) { "Chunk index is outside the manifest" }
    val expectedSize = if (index == item.manifest.totalChunks - 1) {
      (item.manifest.size - index.toLong() * item.manifest.chunkSize).toInt()
    } else item.manifest.chunkSize
    require(bytes.size == expectedSize && bytes.size <= MAX_CHUNK_BYTES) { "Chunk has an invalid size" }
    val digest = sha256(bytes)
    require(digest == normalizeHash(expectedSha256)) { "Chunk SHA-256 mismatch" }
    val target = File(File(transferDirectory(deviceId, transferId), "chunks"), "$index.bin")
    if (target.exists()) {
      require(sha256(target.readBytes()) == digest) { "Chunk conflicts with the stored chunk" }
    } else atomicWrite(target, bytes)
    item = item.copy(receivedChunks = item.receivedChunks + index, updatedAt = System.currentTimeMillis())
    writeState(item)
    return item
  }

  @Synchronized
  fun finalize(deviceId: String, transferId: String): MobileInboxItem {
    var item = requireItem(deviceId, transferId)
    if (item.status == InboxStatus.VERIFIED || item.status == InboxStatus.COMMITTED) return item
    require(item.status == InboxStatus.RECEIVING) { "Transfer is ${item.status}" }
    val missing = (0 until item.manifest.totalChunks).filterNot(item.receivedChunks::contains)
    require(missing.isEmpty()) { "Transfer is missing chunks: ${missing.joinToString()}" }
    val directory = transferDirectory(deviceId, transferId)
    val temporary = File(directory, "artifact.tmp")
    FileOutputStream(temporary).use { output ->
      repeat(item.manifest.totalChunks) { index ->
        File(File(directory, "chunks"), "$index.bin").inputStream().use { it.copyTo(output) }
      }
    }
    val actual = hashFile(temporary)
    if (actual != item.manifest.sha256) {
      temporary.delete()
      item = item.copy(
        status = InboxStatus.QUARANTINED,
        reason = "Assembled artifact SHA-256 mismatch",
        updatedAt = System.currentTimeMillis(),
      )
      writeState(item)
      throw IllegalStateException(item.reason)
    }
    Files.move(
      temporary.toPath(),
      File(directory, "artifact.bin").toPath(),
      StandardCopyOption.ATOMIC_MOVE,
      StandardCopyOption.REPLACE_EXISTING,
    )
    item = item.copy(status = InboxStatus.VERIFIED, updatedAt = System.currentTimeMillis())
    writeState(item)
    return item
  }

  @Synchronized
  fun commit(
    deviceId: String,
    transferId: String,
    workspace: WorkspacePort,
    confirm: Boolean,
  ): Pair<MobileInboxItem, WorkspaceDocument> {
    val (_, document) = stageCommit(deviceId, transferId, workspace, confirm)
    return markCommitted(deviceId, transferId) to document
  }

  /**
   * Writes the artifact into the workspace and records `workspaceDocumentId` while keeping
   * status [InboxStatus.VERIFIED]. Call [markCommitted] only after desktop acknowledgement succeeds.
   */
  @Synchronized
  fun stageCommit(
    deviceId: String,
    transferId: String,
    workspace: WorkspacePort,
    confirm: Boolean,
  ): Pair<MobileInboxItem, WorkspaceDocument> {
    require(confirm) { "Inbox commit requires explicit confirmation" }
    var item = requireItem(deviceId, transferId)
    require(item.status == InboxStatus.VERIFIED) { "Only a verified inbox item can be committed" }
    item.workspaceDocumentId?.let { stagedId ->
      val existing = workspace.list().find { it.documentId == stagedId }
        ?: error("Staged workspace document is missing")
      return item to existing
    }
    require(workspace.list().none { it.displayName == item.manifest.name }) { "Workspace already contains this name" }
    val artifact = File(transferDirectory(deviceId, transferId), "artifact.bin")
    check(hashFile(artifact) == item.manifest.sha256) { "Inbox artifact integrity changed before commit" }
    val document = workspace.create(null, item.manifest.name, item.manifest.mediaType, artifact.readBytes())
    item = item.copy(
      workspaceDocumentId = document.documentId,
      updatedAt = System.currentTimeMillis(),
    )
    writeState(item)
    return item to document
  }

  @Synchronized
  fun markCommitted(deviceId: String, transferId: String): MobileInboxItem {
    var item = requireItem(deviceId, transferId)
    require(item.status == InboxStatus.VERIFIED) { "Only a verified inbox item can be committed" }
    require(!item.workspaceDocumentId.isNullOrBlank()) { "Inbox item has no staged workspace document" }
    item = item.copy(
      status = InboxStatus.COMMITTED,
      updatedAt = System.currentTimeMillis(),
    )
    writeState(item)
    return item
  }

  fun list(): List<MobileInboxItem> = root.listFiles().orEmpty()
    .filter(File::isDirectory)
    .flatMap { device -> device.listFiles().orEmpty().filter(File::isDirectory).mapNotNull { readStateFile(File(it, "state.json")) } }
    .sortedByDescending(MobileInboxItem::updatedAt)

  fun read(deviceId: String, transferId: String): MobileInboxItem? =
    readStateFile(File(transferDirectory(deviceId, transferId), "state.json"))

  private fun requireItem(deviceId: String, transferId: String): MobileInboxItem =
    read(deviceId, transferId) ?: error("Inbox transfer was not found")

  private fun validate(deviceId: String, manifest: ArtifactManifest) {
    safeSegment(deviceId, "device ID")
    safeSegment(manifest.transferId, "transfer ID")
    safeFileName(manifest.name)
    require(manifest.mediaType.isNotBlank() && manifest.mediaType.length <= 160) { "Invalid media type" }
    require(manifest.size in 0..maxItemBytes) { "Artifact exceeds the mobile transfer limit" }
    require(manifest.chunkSize in 1..MAX_CHUNK_BYTES) { "Invalid chunk size" }
    val total = if (manifest.size == 0L) 0 else ((manifest.size + manifest.chunkSize - 1) / manifest.chunkSize).toInt()
    require(manifest.totalChunks == total) { "Chunk count does not match size" }
    normalizeHash(manifest.sha256)
    Instant.parse(manifest.createdAt)
  }

  private fun transferDirectory(deviceId: String, transferId: String): File {
    safeSegment(deviceId, "device ID")
    safeSegment(transferId, "transfer ID")
    val directory = File(File(root, deviceId), transferId).canonicalFile
    require(directory.toPath().startsWith(root.canonicalFile.toPath())) { "Inbox path escaped app storage" }
    return directory
  }

  private fun writeState(item: MobileInboxItem) {
    val directory = transferDirectory(item.deviceId, item.manifest.transferId).apply { mkdirs() }
    atomicWrite(File(directory, "state.json"), item.toJson().toString().toByteArray())
  }

  private fun readStateFile(file: File): MobileInboxItem? = runCatching {
    if (!file.isFile || file.length() > MAX_STATE_BYTES) return null
    JSONObject(file.readText()).toInboxItem()
  }.getOrNull()

  private fun atomicWrite(target: File, bytes: ByteArray) {
    target.parentFile?.mkdirs()
    val temporary = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp")
    temporary.outputStream().use { it.write(bytes) }
    Files.move(
      temporary.toPath(),
      target.toPath(),
      StandardCopyOption.ATOMIC_MOVE,
      StandardCopyOption.REPLACE_EXISTING,
    )
  }

  companion object {
    const val MAX_CHUNK_BYTES = 256 * 1024
    const val MAX_ITEM_BYTES = 32L * 1_048_576
    const val MAX_QUOTA_BYTES = 128L * 1_048_576
    private const val MAX_STATE_BYTES = 512L * 1024
  }
}

class ArtifactTransferClient(
  private val rpc: DeviceLinkRpc,
  private val inbox: MobileInboxStore,
) {
  suspend fun remoteOutbox(deviceId: String): List<ArtifactManifest> {
    val value = rpc.request(deviceId, "artifact/outbox/list", JSONObject()).optJSONArray("value") ?: JSONArray()
    return buildList {
      repeat(value.length()) { index -> add(value.getJSONObject(index).getJSONObject("manifest").toManifest()) }
    }
  }

  suspend fun download(deviceId: String, manifest: ArtifactManifest): MobileInboxItem {
    var local = inbox.begin(deviceId, manifest)
    val missing = (0 until manifest.totalChunks).filterNot(local.receivedChunks::contains)
    for (index in missing) {
      val chunk = rpc.request(
        deviceId,
        "artifact/outbox/chunk",
        JSONObject().put("transferId", manifest.transferId).put("index", index),
      )
      val bytes = Base64.decode(chunk.getString("contentBase64"), Base64.DEFAULT)
      inbox.acceptChunk(deviceId, manifest.transferId, index, bytes, chunk.getString("sha256"))
    }
    return inbox.finalize(deviceId, manifest.transferId)
  }

  suspend fun upload(
    deviceId: String,
    name: String,
    mediaType: String,
    bytes: ByteArray,
  ): ArtifactManifest {
    require(bytes.size <= MobileInboxStore.MAX_ITEM_BYTES) { "Selected file exceeds the mobile transfer limit" }
    safeFileName(name)
    val chunkSize = MobileInboxStore.MAX_CHUNK_BYTES
    val manifest = ArtifactManifest(
      transferId = UUID.randomUUID().toString(),
      name = name,
      mediaType = mediaType.ifBlank { "application/octet-stream" },
      size = bytes.size.toLong(),
      sha256 = sha256(bytes),
      chunkSize = chunkSize,
      totalChunks = if (bytes.isEmpty()) 0 else (bytes.size + chunkSize - 1) / chunkSize,
      createdAt = Instant.now().toString(),
    )
    rpc.request(deviceId, "artifact/begin", JSONObject().put("manifest", manifest.toJson()))
    val status = rpc.request(deviceId, "artifact/status", JSONObject().put("transferId", manifest.transferId))
    val missing = status.optJSONArray("missingChunks") ?: JSONArray((0 until manifest.totalChunks).toList())
    repeat(missing.length()) { position ->
      val index = missing.getInt(position)
      val start = index * chunkSize
      val chunk = bytes.copyOfRange(start, minOf(start + chunkSize, bytes.size))
      rpc.request(
        deviceId,
        "artifact/chunk",
        JSONObject()
          .put("transferId", manifest.transferId)
          .put("index", index)
          .put("contentBase64", Base64.encodeToString(chunk, Base64.NO_WRAP))
          .put("sha256", sha256(chunk)),
      )
    }
    rpc.request(deviceId, "artifact/finalize", JSONObject().put("transferId", manifest.transferId))
    return manifest
  }

  suspend fun commitAndAcknowledge(
    item: MobileInboxItem,
    workspace: WorkspacePort,
    confirm: Boolean,
  ): WorkspaceDocument {
    require(confirm) { "Inbox commit requires explicit confirmation" }
    val current = inbox.read(item.deviceId, item.manifest.transferId)
      ?: error("Inbox transfer was not found")
    if (current.status == InboxStatus.COMMITTED) {
      acknowledgeOutgoing(current, allowMissing = true)
      return resolveWorkspaceDocument(current, workspace)
    }
    val alreadyStaged = !current.workspaceDocumentId.isNullOrBlank()
    val (_, document) = inbox.stageCommit(
      item.deviceId,
      item.manifest.transferId,
      workspace,
      confirm,
    )
    // Ack before marking COMMITTED so a network failure cannot leave the phone
    // committed while the desktop outbox is still live. Retries reuse the staged doc.
    acknowledgeOutgoing(item, allowMissing = alreadyStaged)
    inbox.markCommitted(item.deviceId, item.manifest.transferId)
    return document
  }

  private suspend fun acknowledgeOutgoing(item: MobileInboxItem, allowMissing: Boolean) {
    try {
      rpc.request(
        item.deviceId,
        "artifact/outbox/ack",
        JSONObject().put("transferId", item.manifest.transferId).put("confirm", true),
      )
    } catch (error: Exception) {
      val missing = error.message?.contains("Outgoing artifact transfer was not found") == true
      if (allowMissing && missing) return
      throw error
    }
  }

  private fun resolveWorkspaceDocument(item: MobileInboxItem, workspace: WorkspacePort): WorkspaceDocument {
    val documentId = item.workspaceDocumentId
      ?: error("Committed inbox item is missing workspaceDocumentId")
    return workspace.list().find { it.documentId == documentId }
      ?: error("Committed workspace document is missing")
  }
}

private fun ArtifactManifest.toJson() = JSONObject()
  .put("schemaVersion", 1)
  .put("transferId", transferId)
  .put("name", name)
  .put("mediaType", mediaType)
  .put("size", size)
  .put("sha256", sha256)
  .put("chunkSize", chunkSize)
  .put("totalChunks", totalChunks)
  .put("createdAt", createdAt)

private fun JSONObject.toManifest() = ArtifactManifest(
  transferId = getString("transferId"),
  name = getString("name"),
  mediaType = getString("mediaType"),
  size = getLong("size"),
  sha256 = normalizeHash(getString("sha256")),
  chunkSize = getInt("chunkSize"),
  totalChunks = getInt("totalChunks"),
  createdAt = getString("createdAt"),
)

private fun MobileInboxItem.toJson() = JSONObject()
  .put("deviceId", deviceId)
  .put("manifest", manifest.toJson())
  .put("status", status.name)
  .put("receivedChunks", JSONArray(receivedChunks.sorted()))
  .put("updatedAt", updatedAt)
  .put("reason", reason)
  .put("workspaceDocumentId", workspaceDocumentId)

private fun JSONObject.toInboxItem(): MobileInboxItem {
  val chunks = getJSONArray("receivedChunks")
  return MobileInboxItem(
    deviceId = getString("deviceId"),
    manifest = getJSONObject("manifest").toManifest(),
    status = InboxStatus.valueOf(getString("status")),
    receivedChunks = (0 until chunks.length()).map(chunks::getInt).toSet(),
    updatedAt = getLong("updatedAt"),
    reason = optString("reason").ifBlank { null },
    workspaceDocumentId = optString("workspaceDocumentId").ifBlank { null },
  )
}

private fun safeSegment(value: String, label: String) {
  require(value.matches(Regex("[A-Za-z0-9._ -]{1,160}")) && value != "." && value != "..") { "Invalid $label" }
}

private fun safeFileName(value: String) {
  require(
    value.isNotBlank() && value.length <= 160 && value != "." && value != ".." &&
      !value.contains('/') && !value.contains('\\') && !value.contains('\u0000'),
  ) { "Invalid file name" }
}

private fun normalizeHash(value: String): String = value.lowercase().also {
  require(it.matches(Regex("[a-f0-9]{64}"))) { "Invalid SHA-256" }
}

private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
  .digest(bytes).joinToString("") { "%02x".format(it) }

private fun hashFile(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().use { input ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}
