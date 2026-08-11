package dev.hadamard.companion.security

import android.content.Context

class DeviceTrustStore(context: Context) {
  private val preferences = context.getSharedPreferences("hadamard_device_trust", Context.MODE_PRIVATE)

  fun pin(deviceId: String, certificateSha256: String) {
    require(DEVICE_ID.matches(deviceId)) { "Invalid device ID" }
    require(SHA256.matches(certificateSha256)) { "Invalid certificate fingerprint" }
    preferences.edit().putString(deviceId, certificateSha256.lowercase()).apply()
  }

  fun verify(deviceId: String, certificateSha256: String): Boolean =
    preferences.getString(deviceId, null)?.equals(certificateSha256, ignoreCase = true) == true

  fun revoke(deviceId: String) {
    preferences.edit().remove(deviceId).apply()
  }

  fun pinnedFingerprint(deviceId: String): String? = preferences.getString(deviceId, null)

  companion object {
    private val DEVICE_ID = Regex("[A-Za-z0-9._:-]{8,128}")
    private val SHA256 = Regex("[A-Fa-f0-9]{64}")
  }
}
