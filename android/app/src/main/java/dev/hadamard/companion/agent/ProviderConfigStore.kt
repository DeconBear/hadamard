package dev.hadamard.companion.agent

import android.content.Context
import dev.hadamard.companion.model.ProviderConfiguration
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

class ProviderConfigStore(context: Context) {
  private val preferences = context.getSharedPreferences("hadamard_provider_configs", Context.MODE_PRIVATE)

  fun save(configuration: ProviderConfiguration) {
    validate(configuration)
    val configurations = list().associateBy { it.id }.toMutableMap()
    configurations[configuration.id] = configuration
    val payload = JSONArray(configurations.values.sortedBy { it.displayName }.map(::toJson)).toString()
    preferences.edit().putString(KEY, payload).apply()
  }

  fun list(): List<ProviderConfiguration> {
    val array = runCatching { JSONArray(preferences.getString(KEY, "[]")) }.getOrElse { JSONArray() }
    return buildList {
      repeat(array.length()) { index ->
        runCatching { fromJson(array.getJSONObject(index)) }.getOrNull()?.let(::add)
      }
    }
  }

  fun enabled(): ProviderConfiguration? = list().firstOrNull { it.enabled }

  fun remove(id: String) {
    val remaining = list().filterNot { it.id == id }
    preferences.edit().putString(KEY, JSONArray(remaining.map(::toJson)).toString()).apply()
  }

  private fun validate(value: ProviderConfiguration) {
    require(value.id.matches(Regex("[A-Za-z0-9._-]{1,80}"))) { "Invalid provider ID" }
    require(value.displayName.isNotBlank() && value.model.isNotBlank()) { "Provider name and model are required" }
    require(value.apiKeyAlias.matches(Regex("[A-Za-z0-9._-]{1,96}"))) { "Invalid credential alias" }
    val endpoint = URI(value.endpoint)
    require(endpoint.scheme.equals("https", true) && endpoint.host != null) { "Provider endpoint must use HTTPS" }
    require(endpoint.userInfo == null && endpoint.fragment == null) { "Provider endpoint is invalid" }
  }

  private fun toJson(value: ProviderConfiguration) = JSONObject()
    .put("id", value.id)
    .put("displayName", value.displayName)
    .put("endpoint", value.endpoint)
    .put("model", value.model)
    .put("apiKeyAlias", value.apiKeyAlias)
    .put("enabled", value.enabled)

  private fun fromJson(value: JSONObject) = ProviderConfiguration(
    id = value.getString("id"),
    displayName = value.getString("displayName"),
    endpoint = value.getString("endpoint"),
    model = value.getString("model"),
    apiKeyAlias = value.getString("apiKeyAlias"),
    enabled = value.optBoolean("enabled"),
  )

  companion object {
    private const val KEY = "configurations"
  }
}
