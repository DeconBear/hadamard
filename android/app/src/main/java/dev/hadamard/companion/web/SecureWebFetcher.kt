package dev.hadamard.companion.web

import dev.hadamard.companion.data.readWithOverflowByte
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.util.concurrent.TimeUnit

data class WebFetchResult(
  val finalUrl: String,
  val mediaType: String,
  val content: String,
  val untrusted: Boolean = true,
)

class SecureWebFetcher(
  private val client: OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false)
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(20, TimeUnit.SECONDS)
    .build(),
  private val resolver: (String) -> Array<InetAddress> = InetAddress::getAllByName,
) {
  fun fetch(inputUrl: String): WebFetchResult {
    var uri = validate(inputUrl)
    repeat(MAX_REDIRECTS + 1) { redirectCount ->
      val response = client.newCall(Request.Builder().url(uri.toString()).header("User-Agent", "Hadamard-Mobile/1").build()).execute()
      response.use {
        if (it.isRedirect) {
          require(redirectCount < MAX_REDIRECTS) { "Too many redirects" }
          val location = it.header("Location") ?: error("Redirect has no location")
          uri = validate(uri.resolve(location).toString())
          return@repeat
        }
        check(it.isSuccessful) { "Web request failed with HTTP ${it.code}" }
        val body = it.body ?: error("Web response has no body")
        require(body.contentLength() <= MAX_RESPONSE_BYTES) { "Web response exceeds the mobile limit" }
        val bytes = body.byteStream().use { stream -> stream.readWithOverflowByte(MAX_RESPONSE_BYTES) }
        require(bytes.size <= MAX_RESPONSE_BYTES) { "Web response exceeds the mobile limit" }
        return WebFetchResult(
          finalUrl = uri.toString(),
          mediaType = body.contentType()?.toString() ?: "application/octet-stream",
          content = bytes.toString(Charsets.UTF_8),
        )
      }
    }
    error("Redirect handling failed")
  }

  fun readerText(html: String): String = html
    .replace(Regex("(?is)<(script|style|svg|noscript)[^>]*>.*?</\\1>"), " ")
    .replace(Regex("(?s)<[^>]+>"), " ")
    .replace(Regex("\\s+"), " ")
    .trim()
    .take(MAX_READER_CHARS)

  fun validate(inputUrl: String): URI {
    val uri = URI(inputUrl)
    require(uri.scheme.equals("https", ignoreCase = true)) { "Only HTTPS URLs are allowed" }
    require(uri.userInfo == null && uri.fragment == null) { "URL credentials and fragments are not allowed" }
    val host = uri.host ?: throw IllegalArgumentException("URL must have a host")
    require(host.lowercase() !in BLOCKED_HOSTS) { "Local network hosts are blocked" }
    val addresses = resolver(host)
    require(addresses.isNotEmpty() && addresses.none(::isPrivate)) { "Private and local network addresses are blocked" }
    return uri
  }

  private fun isPrivate(address: InetAddress): Boolean {
    if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
      address.isSiteLocalAddress || address.isMulticastAddress
    ) return true
    val bytes = address.address
    if (address is Inet4Address) {
      val first = bytes[0].toInt() and 0xff
      val second = bytes[1].toInt() and 0xff
      return first == 0 || first == 10 || first == 127 || first >= 224 ||
        (first == 100 && second in 64..127) || (first == 169 && second == 254) ||
        (first == 172 && second in 16..31) || (first == 192 && second == 168)
    }
    if (address is Inet6Address) {
      val first = bytes[0].toInt() and 0xff
      return (first and 0xfe) == 0xfc
    }
    return true
  }

  companion object {
    const val MAX_RESPONSE_BYTES = 2 * 1_048_576
    const val MAX_READER_CHARS = 500_000
    const val MAX_REDIRECTS = 4
    private val BLOCKED_HOSTS = setOf("localhost", "localhost.localdomain", "metadata.google.internal")
  }
}
