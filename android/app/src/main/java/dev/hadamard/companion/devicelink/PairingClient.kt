package dev.hadamard.companion.devicelink

import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress
import java.time.Instant
import java.util.UUID

class PairingClient(
  private val identityManager: DeviceIdentityManager,
  private val computerStore: PairedComputerStore,
) {
  suspend fun pair(pairingUri: String, requestedScopes: List<String>): PairedComputer {
    val offer = parseAndVerify(pairingUri)
    val identity = identityManager.loadOrCreate()
    val offered = offer.getJSONArray("offeredScopes").toStringList().toSet()
    val scopes = requestedScopes.distinct().sorted().filter(offered::contains)
    require(scopes.isNotEmpty()) { "Select at least one offered scope" }
    val completionPayload = JSONObject()
      .put("challengeId", offer.getString("challengeId"))
      .put("confirmationCode", offer.getString("confirmationCode"))
      .put("deviceId", identity.deviceId)
      .put("deviceName", identity.name)
      .put("publicKeyPem", identity.publicKeyPem)
      .put("certificateFingerprint", identity.certificateFingerprint)
      .put("requestedScopes", JSONArray(scopes))
    val proof = identityManager.hmacProof(offer.getString("challengeSecret"), completionPayload)
    val completion = JSONObject(completionPayload.toString())
      .put("challengeProof", proof)
      .put("signature", identityManager.sign(JSONObject(completionPayload.toString()).put("challengeProof", proof), identity))
    val request = JSONObject()
      .put("version", 2)
      .put("id", UUID.randomUUID().toString())
      .put("method", "pair/complete")
      .put("params", completion)
    val address = offer.getString("address")
    val port = offer.getInt("port")
    require(isPrivateOrLocal(address)) { "Pairing offer must use a local/private address" }
    val response = PinnedWssRpc(identity, offer.getString("certificateFingerprint"))
      .request(wssUrl(address, port), request)
    val result = response.getJSONObject("result")
    val device = result.getJSONObject("device")
    val pairedAt = device.getString("pairedAt")
    val signedResult = JSONObject()
      .put("challengeId", offer.getString("challengeId"))
      .put("serverDeviceId", offer.getString("deviceId"))
      .put("pairedDeviceId", identity.deviceId)
      .put("scopes", device.getJSONArray("scopes"))
      .put("pairedAt", pairedAt)
    check(identityManager.verify(signedResult, result.getString("serverSignature"), offer.getString("identityPublicKeyPem"))) {
      "Device Link server pairing signature is invalid"
    }
    return PairedComputer(
      deviceId = offer.getString("deviceId"),
      name = offer.getString("deviceName"),
      address = address,
      port = port,
      publicKeyPem = offer.getString("identityPublicKeyPem"),
      certificateFingerprint = offer.getString("certificateFingerprint").lowercase().replace(":", ""),
      scopes = device.getJSONArray("scopes").toStringList(),
      pairedAt = pairedAt,
      lastSeenAt = Instant.now().toString(),
    ).also(computerStore::save)
  }

  fun parseAndVerify(pairingUri: String): JSONObject {
    val uri = Uri.parse(pairingUri)
    require(uri.scheme == "hadamard" && uri.host == "pair") { "Invalid Hadamard pairing URI" }
    val data = uri.getQueryParameter("data") ?: error("Pairing URI has no data")
    val decoded = Base64.decode(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    require(decoded.size <= MAX_OFFER_BYTES) { "Pairing offer is too large" }
    val offer = JSONObject(String(decoded, Charsets.UTF_8))
    require(offer.getInt("schemaVersion") == 1 && offer.getInt("protocolVersion") == 2) {
      "Unsupported Device Link pairing version"
    }
    require(Instant.parse(offer.getString("expiresAt")).isAfter(Instant.now())) { "Pairing offer expired" }
    val signature = offer.getString("signature")
    val unsigned = JSONObject(offer.toString()).apply { remove("signature") }
    check(identityManager.verify(unsigned, signature, offer.getString("identityPublicKeyPem"))) {
      "Pairing offer signature is invalid"
    }
    return offer
  }

  private fun JSONArray.toStringList() = (0 until length()).map(::getString)

  private fun isPrivateOrLocal(host: String): Boolean = runCatching {
    InetAddress.getAllByName(host).all {
      it.isLoopbackAddress || it.isLinkLocalAddress || it.isSiteLocalAddress
    }
  }.getOrDefault(false)

  private fun wssUrl(host: String, port: Int): String {
    require(port in 1..65535)
    val formatted = if (host.contains(':') && !host.startsWith('[')) "[$host]" else host
    return "wss://$formatted:$port"
  }

  companion object {
    private const val MAX_OFFER_BYTES = 32_768
  }
}
