package dev.hadamard.companion.devicelink

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

object CanonicalJson {
  fun encode(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { key ->
      "${JSONObject.quote(key)}:${encode(value.get(key))}"
    }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { encode(value.get(it)) }
    is String -> JSONObject.quote(value)
    is Boolean -> value.toString()
    is Number -> {
      require(value.toDouble().isFinite()) { "Canonical JSON does not support non-finite numbers" }
      value.toString()
    }
    else -> encode(JSONObject.wrap(value))
  }

  fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(value)
    .joinToString("") { "%02x".format(it) }

  fun sha256(value: String): String = sha256(value.toByteArray(StandardCharsets.UTF_8))
}
