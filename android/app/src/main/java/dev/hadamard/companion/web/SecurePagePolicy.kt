package dev.hadamard.companion.web

object SecurePagePolicy {
  const val PREVIEW_HOST = "hadamard.local"
  const val PREVIEW_ORIGIN = "https://$PREVIEW_HOST/preview/index.html"
  const val CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https://hadamard.local data:; font-src https://hadamard.local; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const val MAX_HTML_CHARS = 1_000_000
  val ACTIVE_CONTENT_PATTERN = Regex("(?is)<\\s*script\\b|javascript\\s*:|(?:\\s|<)on[a-z]+\\s*=")
  private val META_CSP_PATTERN = Regex("(?is)<meta[^>]+http-equiv\\s*=\\s*['\"]?content-security-policy['\"]?[^>]*>")
  private val HEAD_PATTERN = Regex("(?is)<head[^>]*>")

  fun enforce(html: String): String {
    require(html.length <= MAX_HTML_CHARS) { "HTML exceeds the mobile preview limit" }
    require(!ACTIVE_CONTENT_PATTERN.containsMatchIn(html)) { "Scripts are not allowed in mobile page previews" }
    val withoutMetaCsp = html.replace(META_CSP_PATTERN, "")
    val meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">"
    return if (HEAD_PATTERN.containsMatchIn(withoutMetaCsp)) {
      withoutMetaCsp.replaceFirst(HEAD_PATTERN, "$0$meta")
    } else {
      "<!doctype html><html><head>$meta</head><body>$withoutMetaCsp</body></html>"
    }
  }
}
