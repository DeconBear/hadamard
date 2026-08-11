package dev.hadamard.companion

import dev.hadamard.companion.devicelink.CanonicalJson
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class CanonicalJsonTest {
  @Test
  fun sortsObjectKeysRecursivelyWithoutChangingArrayOrder() {
    val value = JSONObject()
      .put("z", 1)
      .put("a", JSONArray().put(3).put(JSONObject().put("b", JSONObject.NULL).put("a", true)))

    assertEquals("{\"a\":[3,{\"a\":true,\"b\":null}],\"z\":1}", CanonicalJson.encode(value))
  }

  @Test
  fun sha256MatchesProtocolVector() {
    assertEquals(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      CanonicalJson.sha256("abc"),
    )
  }
}
