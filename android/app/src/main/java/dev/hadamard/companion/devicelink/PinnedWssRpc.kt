package dev.hadamard.companion.devicelink

import kotlinx.coroutines.CompletableDeferred
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class PinnedWssRpc(
  private val identity: MobileDeviceIdentity,
  private val expectedServerFingerprint: String,
) {
  suspend fun request(
    url: String,
    request: JSONObject,
    onEvent: (JSONObject) -> Unit = {},
  ): JSONObject {
    val result = CompletableDeferred<JSONObject>()
    val socketOpen = CompletableDeferred<Unit>()
    val client = client()
    val socket = client.newWebSocket(
      Request.Builder().url(url).build(),
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          socketOpen.complete(Unit)
          webSocket.send(request.toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          val value = runCatching { JSONObject(text) }.getOrElse {
            result.completeExceptionally(it)
            webSocket.close(1002, "Invalid JSON")
            return
          }
          if (value.optString("type") == "event") {
            onEvent(value)
            return
          }
          if (value.optString("id") == request.optString("id")) {
            value.optJSONObject("error")?.let {
              result.completeExceptionally(DeviceLinkException(it.optString("code"), it.optString("message")))
            } ?: result.complete(value)
            webSocket.close(1000, "Complete")
          }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          if (!socketOpen.isCompleted) socketOpen.completeExceptionally(t)
          if (!result.isCompleted) result.completeExceptionally(t)
        }
      },
    )
    return try {
      socketOpen.await()
      result.await()
    } finally {
      socket.cancel()
      client.dispatcher.executorService.shutdown()
      client.connectionPool.evictAll()
    }
  }

  private fun client(): OkHttpClient {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    check(keyStore.containsAlias(identity.tlsAlias)) { "Device Link client certificate is unavailable" }
    val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
      init(keyStore, null)
    }.keyManagers
    val trustManager = FingerprintTrustManager(expectedServerFingerprint)
    val context = SSLContext.getInstance("TLS").apply {
      init(keyManagers, arrayOf(trustManager), SecureRandom())
    }
    return OkHttpClient.Builder()
      .sslSocketFactory(context.socketFactory, trustManager)
      .hostnameVerifier { _, _ -> true }
      .connectTimeout(12, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
  }
}

class FingerprintTrustManager(expectedFingerprint: String) : X509TrustManager {
  private val expected = expectedFingerprint.lowercase().replace(":", "")

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("Server sent no certificate")
    val actual = CanonicalJson.sha256(leaf.encoded)
    if (actual != expected) throw CertificateException("Pinned Device Link certificate changed")
    val now = System.currentTimeMillis()
    if (now < leaf.notBefore.time || now > leaf.notAfter.time) throw CertificateException("Server certificate expired")
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class DeviceLinkException(val code: String, message: String) : IllegalStateException(message)
