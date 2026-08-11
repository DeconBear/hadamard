package dev.hadamard.companion

import dev.hadamard.companion.web.SecureWebFetcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.InetAddress

class SecureWebFetcherTest {
  @Test
  fun rejectsNonHttpsAndEveryPrivateAddressFamily() {
    val privateFetcher = SecureWebFetcher(resolver = {
      arrayOf(InetAddress.getByAddress(byteArrayOf(10, 0, 0, 1)))
    })
    assertThrows(IllegalArgumentException::class.java) { privateFetcher.validate("https://example.test/a") }
    assertThrows(IllegalArgumentException::class.java) { privateFetcher.validate("http://example.test/a") }
  }

  @Test
  fun acceptsPublicHttpsAndExtractsReaderTextWithoutActiveContent() {
    val fetcher = SecureWebFetcher(resolver = {
      arrayOf(InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8)))
    })
    assertEquals("https://example.test/a", fetcher.validate("https://example.test/a").toString())
    assertEquals("Title Body", fetcher.readerText("<h1>Title</h1><script>bad()</script><p>Body</p>"))
  }
}
