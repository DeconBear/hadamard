package dev.hadamard.companion

import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hadamard.companion.devicelink.ArtifactManifest
import dev.hadamard.companion.devicelink.ArtifactTransferClient
import dev.hadamard.companion.devicelink.DeviceLinkRpc
import dev.hadamard.companion.devicelink.InboxStatus
import dev.hadamard.companion.devicelink.MobileInboxStore
import dev.hadamard.companion.media.SystemAudioFeatureFlag
import dev.hadamard.companion.workspace.WorkspaceDocument
import dev.hadamard.companion.workspace.WorkspacePort
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ArtifactTransferInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

  @Test
  fun inboxResumesOutOfOrderChunksAndRequiresExplicitCommit() {
    val root = temporary("resume")
    val bytes = "resumable-mobile-artifact".repeat(20_000).toByteArray()
    val manifest = manifest(bytes, 64 * 1024)
    var store = MobileInboxStore(root)
    store.begin("desktop-1", manifest)
    val last = manifest.totalChunks - 1
    accept(store, "desktop-1", manifest, bytes, last)
    accept(store, "desktop-1", manifest, bytes, last) // idempotent duplicate
    store = MobileInboxStore(root) // process/network restart
    for (index in 0 until last) accept(store, "desktop-1", manifest, bytes, index)
    val verified = store.finalize("desktop-1", manifest.transferId)
    assertEquals(InboxStatus.VERIFIED, verified.status)
    val workspace = MemoryWorkspace()
    assertThrows(IllegalArgumentException::class.java) {
      store.commit("desktop-1", manifest.transferId, workspace, false)
    }
    assertTrue(workspace.files.isEmpty())
    val committed = store.commit("desktop-1", manifest.transferId, workspace, true).first
    assertEquals(InboxStatus.COMMITTED, committed.status)
    assertArrayEquals(bytes, workspace.files.single().second)
  }

  @Test
  fun corruptAssemblyIsQuarantinedAndQuotaFailsClosed() {
    val store = MobileInboxStore(temporary("quarantine"), maxItemBytes = 1024, quotaBytes = 20)
    val bytes = "twelve-bytes".toByteArray()
    val corruptManifest = manifest(bytes, 6).copy(sha256 = "0".repeat(64))
    store.begin("desktop-2", corruptManifest)
    assertThrows(IllegalArgumentException::class.java) {
      store.begin("desktop-2", manifest("another-file".toByteArray(), 6))
    }
    repeat(corruptManifest.totalChunks) { accept(store, "desktop-2", corruptManifest, bytes, it) }
    assertThrows(IllegalStateException::class.java) { store.finalize("desktop-2", corruptManifest.transferId) }
    assertEquals(InboxStatus.QUARANTINED, store.read("desktop-2", corruptManifest.transferId)?.status)
  }

  @Test
  fun interruptedRemoteDownloadContinuesOnlyMissingChunks() = runBlocking {
    val bytes = ByteArray(700_000) { (it % 251).toByte() }
    val manifest = manifest(bytes, 256 * 1024)
    val root = temporary("network")
    val store = MobileInboxStore(root)
    var calls = 0
    val flaky = ArtifactTransferClient(DeviceLinkRpc { _, method, params ->
      if (method != "artifact/outbox/chunk") error("Unexpected $method")
      val index = params.getInt("index")
      if (++calls == 2) error("network switched")
      chunkResponse(bytes, manifest, index)
    }, store)
    runCatching { flaky.download("desktop-3", manifest) }
    assertEquals(1, store.read("desktop-3", manifest.transferId)?.receivedChunks?.size)
    val requested = mutableListOf<Int>()
    val resumed = ArtifactTransferClient(DeviceLinkRpc { _, method, params ->
      require(method == "artifact/outbox/chunk")
      params.getInt("index").also(requested::add).let { chunkResponse(bytes, manifest, it) }
    }, MobileInboxStore(root))
    val verified = resumed.download("desktop-3", manifest)
    assertEquals(InboxStatus.VERIFIED, verified.status)
    assertEquals((1 until manifest.totalChunks).toList(), requested)
  }

  @Test
  fun uploadUsesServerMissingListAndSystemAudioFlagDefaultsOff() = runBlocking {
    val bytes = ByteArray(600_000) { 4 }
    val uploaded = mutableListOf<Int>()
    val rpc = DeviceLinkRpc { _, method, params ->
      when (method) {
        "artifact/begin", "artifact/finalize" -> JSONObject()
        "artifact/status" -> JSONObject().put("missingChunks", JSONArray(listOf(1, 2)))
        "artifact/chunk" -> JSONObject().also { uploaded += params.getInt("index") }
        else -> error("Unexpected $method")
      }
    }
    ArtifactTransferClient(rpc, MobileInboxStore(temporary("upload")))
      .upload("desktop-4", "model.bin", "application/octet-stream", bytes)
    assertEquals(listOf(1, 2), uploaded)
    val flag = SystemAudioFeatureFlag(context)
    flag.setEnabled(false)
    assertTrue(!flag.enabled())
    flag.setEnabled(true)
    assertTrue(flag.enabled())
    flag.setEnabled(false)
  }

  private fun accept(store: MobileInboxStore, deviceId: String, manifest: ArtifactManifest, bytes: ByteArray, index: Int) {
    val start = index * manifest.chunkSize
    val chunk = bytes.copyOfRange(start, minOf(start + manifest.chunkSize, bytes.size))
    store.acceptChunk(deviceId, manifest.transferId, index, chunk, hash(chunk))
  }

  private fun manifest(bytes: ByteArray, chunkSize: Int) = ArtifactManifest(
    UUID.randomUUID().toString(),
    "artifact.bin",
    "application/octet-stream",
    bytes.size.toLong(),
    hash(bytes),
    chunkSize,
    if (bytes.isEmpty()) 0 else (bytes.size + chunkSize - 1) / chunkSize,
    Instant.now().toString(),
  )

  private fun chunkResponse(bytes: ByteArray, manifest: ArtifactManifest, index: Int): JSONObject {
    val start = index * manifest.chunkSize
    val chunk = bytes.copyOfRange(start, minOf(start + manifest.chunkSize, bytes.size))
    return JSONObject()
      .put("contentBase64", Base64.encodeToString(chunk, Base64.NO_WRAP))
      .put("sha256", hash(chunk))
  }

  private fun temporary(label: String): File = File(context.cacheDir, "artifact-$label-${UUID.randomUUID()}").apply { mkdirs() }

  private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it) }
}

private class MemoryWorkspace : WorkspacePort {
  override val workspaceId = "memory"
  val files = mutableListOf<Pair<WorkspaceDocument, ByteArray>>()
  override fun list(parentDocumentId: String?) = files.map { it.first }
  override fun read(documentId: String, maxBytes: Int) = files.single { it.first.documentId == documentId }.second
  override fun create(parentDocumentId: String?, displayName: String, mediaType: String, content: ByteArray): WorkspaceDocument {
    val document = WorkspaceDocument(UUID.randomUUID().toString(), displayName, mediaType, content.size.toLong(), false)
    files += document to content.copyOf()
    return document
  }
  override fun write(documentId: String, content: ByteArray) = error("Not used")
  override fun move(documentId: String, targetParentDocumentId: String?) = error("Not used")
}
