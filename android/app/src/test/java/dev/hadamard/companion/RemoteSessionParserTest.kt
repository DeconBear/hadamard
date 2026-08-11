package dev.hadamard.companion

import dev.hadamard.companion.devicelink.RemoteSessionParser
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class RemoteSessionParserTest {
  @Test
  fun parsesWrappedSessionsAndBoundsPreview() {
    val result = JSONObject().put(
      "value",
      JSONArray().put(
        JSONObject()
          .put("id", "session-1")
          .put("title", "Planning")
          .put("updatedAt", "2026-08-12T10:00:00Z")
          .put("preview", "x".repeat(400)),
      ),
    )

    val sessions = RemoteSessionParser.parse(result)

    assertEquals(1, sessions.size)
    assertEquals("Planning", sessions.single().title)
    assertEquals(180, sessions.single().preview.length)
  }

  @Test
  fun rejectsMissingSessionIdentity() {
    val result = JSONObject().put("sessions", JSONArray().put(JSONObject().put("title", "No identity")))

    try {
      RemoteSessionParser.parse(result)
      fail("Expected a missing session identity to be rejected")
    } catch (_: Exception) {
      // Expected.
    }
  }
}
