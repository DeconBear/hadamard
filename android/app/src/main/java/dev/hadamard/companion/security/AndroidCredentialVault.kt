package dev.hadamard.companion.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidCredentialVault(context: Context) : CredentialVault {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  override fun put(alias: String, value: String) {
    require(alias.matches(ALIAS_PATTERN)) { "Credential alias is invalid" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
    val payload = Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    preferences.edit().putString(alias, payload).apply()
  }

  override fun get(alias: String): String? {
    val payload = preferences.getString(alias, null) ?: return null
    return try {
      val bytes = Base64.decode(payload, Base64.NO_WRAP)
      require(bytes.size > IV_BYTES) { "Credential payload is truncated" }
      val iv = bytes.copyOfRange(0, IV_BYTES)
      val encrypted = bytes.copyOfRange(IV_BYTES, bytes.size)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_BITS, iv))
      String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
    } catch (error: KeyPermanentlyInvalidatedException) {
      throw CredentialInvalidatedException("Android Keystore invalidated this credential", error)
    } catch (error: Exception) {
      throw CredentialInvalidatedException("Credential cannot be decrypted on this device", error)
    }
  }

  override fun remove(alias: String) {
    preferences.edit().remove(alias).apply()
  }

  private fun secretKey(): SecretKey {
    (keyStore.getKey(MASTER_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
      init(
        KeyGenParameterSpec.Builder(
          MASTER_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .setUserAuthenticationRequired(false)
          .build(),
      )
      generateKey()
    }
  }

  companion object {
    private const val PREFERENCES = "hadamard_credentials"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val MASTER_ALIAS = "hadamard.mobile.credentials.v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val GCM_BITS = 128
    private val ALIAS_PATTERN = Regex("[A-Za-z0-9._-]{1,96}")
  }
}
