package dev.hadamard.companion

import android.app.Application
import dev.hadamard.companion.data.ArtifactStore
import dev.hadamard.companion.data.MobileDatabase
import dev.hadamard.companion.security.AndroidCredentialVault
import dev.hadamard.companion.security.DeviceTrustStore

class HadamardApplication : Application() {
  val database by lazy { MobileDatabase(this) }
  val artifactStore by lazy { ArtifactStore(this) }
  val credentialVault by lazy { AndroidCredentialVault(this) }
  val trustStore by lazy { DeviceTrustStore(this) }

}
