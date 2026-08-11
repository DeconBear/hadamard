package dev.hadamard.companion

import dev.hadamard.companion.web.SecurePagePolicy
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SecurePagePolicyTest {
  @Test
  fun injectsOwnedCspAndRemovesDocumentProvidedCsp() {
    val secured = SecurePagePolicy.enforce(
      "<html><head><meta http-equiv='Content-Security-Policy' content='default-src *'></head><body>Hello</body></html>",
    )
    assertTrue(secured.contains(SecurePagePolicy.CSP))
    assertFalse(secured.contains("default-src *"))
  }

  @Test
  fun rejectsScriptsHandlersAndJavascriptUrls() {
    listOf(
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<a href='javascript:alert(1)'>x</a>",
    ).forEach { input ->
      assertThrows(IllegalArgumentException::class.java) { SecurePagePolicy.enforce(input) }
    }
  }
}
