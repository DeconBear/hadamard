package dev.hadamard.companion

import android.net.Uri
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hadamard.companion.devicelink.DeviceIdentityManager
import dev.hadamard.companion.devicelink.FingerprintTrustManager
import dev.hadamard.companion.devicelink.PairedComputerStore
import dev.hadamard.companion.devicelink.PairingClient
import dev.hadamard.companion.security.AndroidCredentialVault
import dev.hadamard.companion.security.CredentialInvalidatedException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.time.Instant

@RunWith(AndroidJUnit4::class)
class DeviceSecurityInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

  @Test
  fun credentialsAreEncryptedAndCorruptionFailsClosed() {
    val vault = AndroidCredentialVault(context)
    val alias = "test.${System.nanoTime()}"
    val secret = "sk-mobile-secret-${System.nanoTime()}"
    vault.put(alias, secret)
    assertEquals(secret, vault.get(alias))
    val stored = context.getSharedPreferences("hadamard_credentials", 0).getString(alias, "")!!
    assertFalse(stored.contains(secret))
    context.getSharedPreferences("hadamard_credentials", 0).edit().putString(alias, "corrupt").commit()
    assertThrows(CredentialInvalidatedException::class.java) { vault.get(alias) }
    vault.remove(alias)
  }

  @Test
  fun signedPairingOfferRoundTripsAndExpiredOfferIsRejected() {
    val vault = AndroidCredentialVault(context)
    val identities = DeviceIdentityManager(context, vault)
    val identity = identities.loadOrCreate()
    fun offer(expiresAt: String): JSONObject {
      val unsigned = JSONObject()
        .put("schemaVersion", 1)
        .put("deviceId", identity.deviceId)
        .put("deviceName", "Test computer")
        .put("address", "127.0.0.1")
        .put("port", 9443)
        .put("protocolVersion", 2)
        .put("challengeId", "challenge")
        .put("challengeSecret", Base64.encodeToString(ByteArray(32) { 7 }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        .put("confirmationCode", "123456")
        .put("identityPublicKeyPem", identity.publicKeyPem)
        .put("certificateFingerprint", identity.certificateFingerprint)
        .put("offeredScopes", JSONArray().put("session:browse"))
        .put("expiresAt", expiresAt)
      return JSONObject(unsigned.toString()).put("signature", identities.sign(unsigned, identity))
    }
    fun uri(value: JSONObject): String = "hadamard://pair?data=" + Base64.encodeToString(
      value.toString().toByteArray(),
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )
    val pairing = PairingClient(identities, PairedComputerStore(context))
    assertEquals(identity.deviceId, pairing.parseAndVerify(uri(offer(Instant.now().plusSeconds(60).toString()))).getString("deviceId"))
    assertThrows(IllegalArgumentException::class.java) {
      pairing.parseAndVerify(uri(offer(Instant.now().minusSeconds(1).toString())))
    }
  }

  @Test
  fun certificatePinRejectsComputerCertificateSwap() {
    val identity = DeviceIdentityManager(context, AndroidCredentialVault(context)).loadOrCreate()
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val certificate = keyStore.getCertificate(identity.tlsAlias) as X509Certificate
    FingerprintTrustManager(identity.certificateFingerprint).checkServerTrusted(arrayOf(certificate), "RSA")
    assertThrows(CertificateException::class.java) {
      FingerprintTrustManager("00".repeat(32)).checkServerTrusted(arrayOf(certificate), "RSA")
    }
  }
}
