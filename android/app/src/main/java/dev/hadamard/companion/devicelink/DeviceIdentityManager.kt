package dev.hadamard.companion.devicelink

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.hadamard.companion.security.CredentialVault
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import org.json.JSONObject
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Date
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.security.auth.x500.X500Principal

data class MobileDeviceIdentity(
  val deviceId: String,
  val name: String,
  val publicKeyPem: String,
  val privateKey: PrivateKey,
  val certificateFingerprint: String,
  val tlsAlias: String,
)

class DeviceIdentityManager(
  private val context: Context,
  private val vault: CredentialVault,
) {
  fun loadOrCreate(): MobileDeviceIdentity {
    val seed = vault.get(SEED_ALIAS)?.let { Base64.decode(it, Base64.NO_WRAP) }
      ?: ByteArray(32).also { SecureRandom().nextBytes(it) }.also {
        vault.put(SEED_ALIAS, Base64.encodeToString(it, Base64.NO_WRAP))
      }
    val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
    val privateSpec = EdDSAPrivateKeySpec(seed, spec)
    val privateKey = net.i2p.crypto.eddsa.EdDSAPrivateKey(privateSpec)
    val publicKey = EdDSAPublicKey(EdDSAPublicKeySpec(privateSpec.a, spec))
    val publicPem = pem("PUBLIC KEY", publicKey.encoded)
    val deviceId = "device-${CanonicalJson.sha256(publicPem).take(32)}"
    val certificate = tlsCertificate(deviceId)
    return MobileDeviceIdentity(
      deviceId = deviceId,
      name = android.os.Build.MODEL.take(80).ifBlank { "Android phone" },
      publicKeyPem = publicPem,
      privateKey = privateKey,
      certificateFingerprint = CanonicalJson.sha256(certificate.encoded),
      tlsAlias = TLS_ALIAS,
    )
  }

  fun sign(value: JSONObject, identity: MobileDeviceIdentity): String {
    val signer = EdDSAEngine(MessageDigest.getInstance("SHA-512"))
    signer.initSign(identity.privateKey)
    signer.update(CanonicalJson.encode(value).toByteArray(StandardCharsets.UTF_8))
    return base64Url(signer.sign())
  }

  fun verify(value: JSONObject, signature: String, publicKeyPem: String): Boolean = runCatching {
    val keyBytes = decodePem(publicKeyPem, "PUBLIC KEY")
    val key = EdDSAPublicKey(java.security.spec.X509EncodedKeySpec(keyBytes))
    val verifier = EdDSAEngine(MessageDigest.getInstance("SHA-512"))
    verifier.initVerify(key)
    verifier.update(CanonicalJson.encode(value).toByteArray(StandardCharsets.UTF_8))
    verifier.verify(Base64.decode(signature, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
  }.getOrDefault(false)

  fun hmacProof(secret: String, value: JSONObject): String {
    val key = Base64.decode(secret, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    return base64Url(Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(key, "HmacSHA256"))
      doFinal(CanonicalJson.encode(value).toByteArray(StandardCharsets.UTF_8))
    })
  }

  private fun tlsCertificate(deviceId: String): X509Certificate {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    (keyStore.getCertificate(TLS_ALIAS) as? X509Certificate)?.let { return it }
    val now = System.currentTimeMillis()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE).run {
      initialize(
        KeyGenParameterSpec.Builder(
          TLS_ALIAS,
          KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
          .setKeySize(2048)
          .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
          .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
          .setCertificateSubject(X500Principal("CN=$deviceId"))
          .setCertificateSerialNumber(BigInteger(128, SecureRandom()).abs())
          .setCertificateNotBefore(Date(now - 86_400_000))
          .setCertificateNotAfter(Date(now + 10L * 365 * 86_400_000))
          .build(),
      )
      generateKeyPair()
    }
    return keyStore.getCertificate(TLS_ALIAS) as X509Certificate
  }

  private fun pem(label: String, bytes: ByteArray): String {
    val body = Base64.encodeToString(bytes, Base64.NO_WRAP).chunked(64).joinToString("\n")
    return "-----BEGIN $label-----\n$body\n-----END $label-----\n"
  }

  private fun decodePem(value: String, label: String): ByteArray = Base64.decode(
    value.replace("-----BEGIN $label-----", "").replace("-----END $label-----", "").replace(Regex("\\s"), ""),
    Base64.DEFAULT,
  )

  private fun base64Url(bytes: ByteArray) = Base64.encodeToString(
    bytes,
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
  )

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TLS_ALIAS = "hadamard.device-link.tls.v1"
    private const val SEED_ALIAS = "hadamard.device-link.identity.seed.v1"
  }
}
