package dev.hadamard.companion.devicelink

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class PairedComputer(
  val deviceId: String,
  val name: String,
  val address: String,
  val port: Int,
  val publicKeyPem: String,
  val certificateFingerprint: String,
  val scopes: List<String>,
  val pairedAt: String,
  val lastSeenAt: String?,
)

class PairedComputerStore(context: Context) {
  private val preferences = context.getSharedPreferences("hadamard_paired_computers", Context.MODE_PRIVATE)

  @Synchronized
  fun save(computer: PairedComputer) {
    val values = list().associateBy { it.deviceId }.toMutableMap()
    values[computer.deviceId] = computer
    preferences.edit().putString(COMPUTERS, JSONArray(values.values.map(::toJson)).toString()).apply()
  }

  fun list(): List<PairedComputer> {
    val array = runCatching { JSONArray(preferences.getString(COMPUTERS, "[]")) }.getOrElse { JSONArray() }
    return buildList {
      repeat(array.length()) { index -> runCatching { fromJson(array.getJSONObject(index)) }.getOrNull()?.let(::add) }
    }
  }

  fun get(deviceId: String): PairedComputer? = list().firstOrNull { it.deviceId == deviceId }

  @Synchronized
  fun nextSequence(deviceId: String): Long {
    check(get(deviceId) != null) { "Computer is not paired" }
    val next = preferences.getLong("sequence:$deviceId", 0) + 1
    check(preferences.edit().putLong("sequence:$deviceId", next).commit()) { "Could not persist request sequence" }
    return next
  }

  @Synchronized
  fun revoke(deviceId: String) {
    val remaining = list().filterNot { it.deviceId == deviceId }
    preferences.edit().putString(COMPUTERS, JSONArray(remaining.map(::toJson)).toString())
      .remove("sequence:$deviceId").apply()
  }

  private fun toJson(value: PairedComputer) = JSONObject()
    .put("deviceId", value.deviceId)
    .put("name", value.name)
    .put("address", value.address)
    .put("port", value.port)
    .put("publicKeyPem", value.publicKeyPem)
    .put("certificateFingerprint", value.certificateFingerprint)
    .put("scopes", JSONArray(value.scopes))
    .put("pairedAt", value.pairedAt)
    .put("lastSeenAt", value.lastSeenAt)

  private fun fromJson(value: JSONObject) = PairedComputer(
    deviceId = value.getString("deviceId"),
    name = value.getString("name"),
    address = value.getString("address"),
    port = value.getInt("port"),
    publicKeyPem = value.getString("publicKeyPem"),
    certificateFingerprint = value.getString("certificateFingerprint"),
    scopes = value.getJSONArray("scopes").let { array -> (0 until array.length()).map(array::getString) },
    pairedAt = value.getString("pairedAt"),
    lastSeenAt = value.optString("lastSeenAt").ifBlank { null },
  )

  companion object {
    private const val COMPUTERS = "computers"
  }
}
