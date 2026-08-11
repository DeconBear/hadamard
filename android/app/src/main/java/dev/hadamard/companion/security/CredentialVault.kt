package dev.hadamard.companion.security

interface CredentialVault {
  fun put(alias: String, value: String)
  fun get(alias: String): String?
  fun remove(alias: String)
}

class CredentialInvalidatedException(message: String, cause: Throwable? = null) :
  IllegalStateException(message, cause)
