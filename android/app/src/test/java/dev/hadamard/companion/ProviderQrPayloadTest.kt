package dev.hadamard.companion

import dev.hadamard.companion.agent.ProviderQrPayload
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProviderQrPayloadTest {
  @Test
  fun parsesDesktopProviderExport() {
    val contents = JSONObject()
      .put("type", "hadamard-provider")
      .put("version", 1)
      .put("displayName", "mobile-openai")
      .put("endpoint", "https://api.openai.com/v1")
      .put("model", "gpt-4o-mini")
      .put("apiKey", "sk-test-123")
      .toString()

    val parsed = ProviderQrPayload.parse(contents)

    assertEquals("mobile-openai", parsed.displayName)
    assertEquals("https://api.openai.com/v1", parsed.endpoint)
    assertEquals("gpt-4o-mini", parsed.model)
    assertEquals("sk-test-123", parsed.apiKey)
  }

  @Test
  fun rejectsPairingUrisAndForeignPayloads() {
    assertThrows(Exception::class.java) {
      ProviderQrPayload.parse("hadamard://pair?uri=wss%3A%2F%2F127.0.0.1")
    }
    assertThrows(Exception::class.java) {
      ProviderQrPayload.parse(JSONObject().put("type", "something-else").toString())
    }
    assertThrows(Exception::class.java) {
      ProviderQrPayload.parse("not json at all")
    }
  }

  @Test
  fun rejectsIncompletePayloads() {
    val missingKey = JSONObject()
      .put("type", "hadamard-provider")
      .put("endpoint", "https://api.openai.com/v1")
      .put("model", "gpt-4o-mini")
      .toString()

    assertThrows(IllegalArgumentException::class.java) {
      ProviderQrPayload.parse(missingKey)
    }
  }
}
